// Scores and their members (docs/spec/routes.md, 3.3; docs/spec/collab.md, sections 2 and 3):
// creating one, listing mine, opening one, and the collab ticket to edit it.
import { collabTicket, createdScore, createScoreRequest, type Role, scoreDetails, scoreList } from "@studio/contracts";
import { addPart, COMMON_TIME, createScore, insertBars, SCHEMA_VERSION } from "@studio/score-model";
import type { FastifyInstance } from "fastify";
import * as Y from "yjs";

import type { Collab } from "./collab";
import type { CollabTickets } from "./collabTickets";
import { Account, Score, ScoreMember } from "./db/models";
import { invalidRequest, isUuid, notFound } from "./http";

/** The score with this id, unless it does not exist or is deleted. */
export async function liveScore(id: string): Promise<Score | null> {
  if (!isUuid(id)) return null;
  return Score.findOne({ where: { id, deletedAt: null } });
}

/** The account's role in the score, with the score; null when either is missing, the score is deleted or the account is no member. */
export async function membership(scoreId: string, accountId: string): Promise<{ score: Score; role: Role } | null> {
  if (!isUuid(scoreId)) return null;
  const member = await ScoreMember.findOne({
    where: { scoreId, accountId },
    // Not the Yjs state: no caller needs it, and it is the largest column of the table.
    include: [{ model: Score, as: "score", where: { deletedAt: null }, required: true, attributes: ["id", "title", "artist"] }],
  });
  return member === null ? null : { score: member.get("score") as Score, role: member.role };
}

/**
 * What a new score starts with, written by the server through the commands of score-model: one
 * six-string guitar and eight bars of 4/4. The tempo is left unwritten, which reads as 120
 * (docs/spec/schema.md, section 3). The dialog of #11 replaces these fixed values. The end-to-end
 * tests' fixtures ask for more bars.
 */
export function startContent(doc: Y.Doc, title: string, bars = 8): void {
  createScore(doc, title);
  // A fretted part's defaults are the preset 「吉他 6 弦」: standard tuning, tablature, program 25.
  addPart(doc, { name: "吉他 1", kind: "fretted" });
  insertBars(doc, { after: null, count: bars, timeSig: COMMON_TIME });
}

/** Make a score owned by the account, its content written as a participant; returns its id. */
async function makeScore(collab: Collab, ownerId: string, title: string): Promise<string> {
  const score = await Score.sequelize!.transaction(async (transaction) => {
    const created = await Score.create({ title, docState: Buffer.from(Y.encodeStateAsUpdate(new Y.Doc())), schemaVersion: SCHEMA_VERSION }, { transaction });
    await ScoreMember.create({ scoreId: created.id, accountId: ownerId, role: "owner" }, { transaction });
    return created;
  });
  // Between the commit and the end of `change`, the row holds an empty document. Nobody can open
  // it meanwhile: its id is only answered below, and only its Owner is a member.
  try {
    await collab.change(score.id, (doc) => startContent(doc, title));
  } catch (error) {
    // No empty score left behind for its Owner to find.
    await score.destroy();
    throw error;
  }
  return score.id;
}

export function registerScores(app: FastifyInstance, { collab, tickets }: { collab: Collab; tickets: CollabTickets }): void {
  app.post("/api/scores", async (request, reply) => {
    const body = createScoreRequest.safeParse(request.body);
    if (!body.success) return invalidRequest(reply, body.error);
    const id = await makeScore(collab, request.account!.id, body.data.title);
    return reply.code(201).send(createdScore.parse({ id }));
  });

  app.get("/api/scores", async (request) => {
    const members = await ScoreMember.findAll({
      where: { accountId: request.account!.id },
      include: [{ model: Score, as: "score", where: { deletedAt: null }, required: true, attributes: ["id", "title", "artist", "updatedAt"] }],
      order: [[{ model: Score, as: "score" }, "updatedAt", "DESC"]],
    });
    return scoreList.parse({
      scores: members.map((member) => {
        const score = member.get("score") as Score;
        return { id: score.id, title: score.title, artist: score.artist, role: member.role, updatedAt: score.updatedAt.toISOString() };
      }),
    });
  });

  app.get<{ Params: { id: string } }>("/api/scores/:id", async (request, reply) => {
    const member = await membership(request.params.id, request.account!.id);
    if (member === null) return notFound(reply);
    const owner = await ScoreMember.findOne({ where: { scoreId: member.score.id, role: "owner" }, include: [{ model: Account, as: "account", required: true }] });
    const account = owner?.get("account") as Account | undefined;
    if (account === undefined) throw new Error(`score ${member.score.id} has no owner`);
    return scoreDetails.parse({
      id: member.score.id,
      title: member.score.title,
      artist: member.score.artist,
      role: member.role,
      owner: { accountId: account.id, displayName: account.displayName },
    });
  });

  app.post<{ Params: { id: string } }>("/api/scores/:id/collab-ticket", async (request, reply) => {
    const member = await membership(request.params.id, request.account!.id);
    if (member === null) return notFound(reply);
    const ticket = await tickets.issue({ kind: "member", scoreId: member.score.id, accountId: request.account!.id, sessionId: request.session!.id, role: member.role });
    return collabTicket.parse({ ticket, role: member.role });
  });
}
