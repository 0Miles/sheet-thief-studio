// Deleting a score (docs/spec/accounts.md, section 8; docs/spec/routes.md, 3.3): its Owner
// deletes it, softly; for 30 days the Owner finds it among the deleted ones and can restore it;
// after that a job of this process deletes it for good, its members and its versions with it.
import { Forbidden } from "@hocuspocus/common";
import { DELETED_SCORE_DAYS, deletedScoreList } from "@studio/contracts";
import type { FastifyInstance } from "fastify";
import { literal, Op } from "sequelize";

import type { Collab } from "./collab";
import { Score, ScoreMember } from "./db/models";
import { isUuid, notFound } from "./http";
import { changeMembers, unlessRefused } from "./members";

/** How often the job that deletes for good runs; it also runs once as the server starts. */
export const PURGE_INTERVAL_MS = 60 * 60 * 1000;

/** The clock of the database, as a value of `deleted_at`. */
const NOW = literal("now()") as unknown as Date;

/**
 * The moment 30 days ago, by the clock of the database, which also says when a score is deleted:
 * what is deleted for good cannot be brought back, so no clock of a process, which may jump,
 * decides it. A score deleted at this moment or later can still be restored; one deleted before
 * is to be deleted for good.
 */
const RESTORABLE_SINCE = literal(`now() - make_interval(days => ${DELETED_SCORE_DAYS})`);

/** `deleted_at` of a score its Owner can still restore. */
const RESTORABLE = { [Op.gte]: RESTORABLE_SINCE };

/**
 * Delete for good the scores deleted more than 30 days ago; returns how many. Their members go
 * with them, and their versions, by the foreign keys of those tables (`ON DELETE CASCADE`). Rows
 * of the `scores` table only, and only those marked deleted.
 */
export async function purgeDeletedScores(): Promise<number> {
  return Score.destroy({ where: { deletedAt: { [Op.ne]: null, [Op.lt]: RESTORABLE_SINCE } } });
}

type ScoreParams = { Params: { id: string } };

export function registerDeletion(app: FastifyInstance, { collab }: { collab: Collab }): void {
  // Only an Owner has any: the block of `/` that lists them shows for nobody else.
  app.get("/api/scores/deleted", async (request) => {
    const owned = await ScoreMember.findAll({
      where: { accountId: request.account!.id, role: "owner" },
      include: [{ model: Score, as: "score", where: { deletedAt: RESTORABLE }, required: true, attributes: ["id", "title", "artist", "deletedAt"] }],
      order: [[{ model: Score, as: "score" }, "deletedAt", "DESC"]],
    });
    return deletedScoreList.parse({
      scores: owned.map((member) => {
        const score = member.get("score") as Score;
        return { id: score.id, title: score.title, artist: score.artist, deletedAt: score.deletedAt!.toISOString() };
      }),
    });
  });

  app.delete<ScoreParams>("/api/scores/:id", async (request, reply) => {
    const { id } = request.params;
    return unlessRefused(reply, async () => {
      // With the score's row locked, as every change of its members: whoever deletes is still its
      // Owner as it is deleted, not the Owner of a moment before a transfer.
      await changeMembers(id, request.account!.id, "owner", async ({ transaction }) => {
        // The link goes for good: a score restored has none until its Owner makes one. `silent`:
        // `updated_at` stays what the last change of the content left.
        await Score.update({ deletedAt: NOW, linkToken: null }, { where: { id }, silent: true, transaction });
      });
      // After the commit: everyone's connections, the guests' and the ones still loading too.
      // Whatever comes back finds no score (docs/spec/accounts.md, section 9).
      collab.closeConnections({ scoreId: id }, Forbidden);
      return reply.code(204).send();
    });
  });

  app.post<ScoreParams>("/api/scores/:id/restore", async (request, reply) => {
    const { id } = request.params;
    if (!isUuid(id)) return notFound(reply);
    const restored = await Score.sequelize!.transaction(async (transaction) => {
      // Locked: the job that deletes for good waits, then finds the score no longer deleted.
      const score = await Score.findOne({
        where: { id, deletedAt: RESTORABLE },
        attributes: ["id"],
        lock: transaction.LOCK.UPDATE,
        transaction,
      });
      if (score === null) return false;
      const owner = await ScoreMember.findOne({ where: { scoreId: id, accountId: request.account!.id, role: "owner" }, transaction });
      if (owner === null) return false;
      // Whatever link the row holds is not one of the score restored: it has none until its
      // Owner makes one (docs/spec/accounts.md, section 7).
      await Score.update({ deletedAt: null, linkToken: null }, { where: { id }, silent: true, transaction });
      return true;
    });
    // To anyone but its Owner a deleted score is not there, and neither is one not deleted, or
    // deleted too long ago (docs/spec/security.md, section 8).
    if (!restored) return notFound(reply);
    return reply.code(204).send();
  });

  // The job, in this process: there is only one (docs/adr/0001).
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<void> = Promise.resolve();
  async function purge(): Promise<void> {
    try {
      const count = await purgeDeletedScores();
      if (count > 0) app.log.info({ count }, "deleted for good the scores deleted more than 30 days ago");
    } catch (error) {
      // Tried again in an hour; the scores stay deleted meanwhile.
      app.log.error({ error }, "deleting for good the scores deleted more than 30 days ago failed");
    }
  }
  app.addHook("onReady", async () => {
    running = purge();
    await running;
    timer = setInterval(() => {
      running = purge();
    }, PURGE_INTERVAL_MS);
  });
  // Before anything is closed, the database included (whoever built the app closes it in
  // `onClose`): no run is left under way.
  app.addHook("preClose", async () => {
    clearInterval(timer);
    await running;
  });
}
