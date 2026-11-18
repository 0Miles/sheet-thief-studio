// The versions of a score (docs/spec/collab.md, section 8): the whole score at one moment, as
// `docToJson` reads it, one row each. Here: making one, keeping at most 200 automatic ones, and
// what a member does with them (docs/spec/routes.md, 3.6): listing, reading one brought to the
// current schema, naming one, making a named one now, and the one a restore makes first. When
// the server makes one on its own is the collab server's business (collab.ts); the restore itself
// is the member's tab's (score-model's `replaceScore`).
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { gunzip, gzip } from "node:zlib";

import { createdVersion, createVersionRequest, renameVersionRequest, type Role, versionList, versionSummary } from "@studio/contracts";
import { type Migration, migrateJson, MIGRATIONS, type ScoreJSON } from "@studio/score-model";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { Transaction } from "sequelize";

import type { Collab } from "./collab";
import { Score, ScoreMember, Version, type VersionReason } from "./db/models";
import { invalidRequest, isUuid } from "./http";
import { WEBSOCKET_MESSAGE_LIMIT } from "./limits";
import { Refusal } from "./members";
import { membership } from "./scores";

const compress = promisify(gzip);
const decompress = promisify(gunzip);

/** How often a version is made of a score that stays open (docs/spec/collab.md, 8.3). */
export const VERSION_INTERVAL_MS = 10 * 60 * 1000;

/** How many automatic versions a score keeps; the named ones are never deleted (docs/spec/collab.md, 8.4). */
export const AUTO_VERSIONS_KEPT = 200;

/**
 * The most a version holds, in bytes of JSON before it is gzipped: what one WebSocket message
 * carries (docs/spec/security.md, section 5), since restoring a version sends its whole content
 * as one. Whoever reads a version back (`readVersion`) gunzips it with `maxOutputLength` set to
 * this, so that no row, however it got there, inflates beyond it.
 */
export const MAX_VERSION_BYTES = WEBSOCKET_MESSAGE_LIMIT;

/** The content is more than a version holds: none was made. */
export class VersionTooLarge extends Error {
  constructor(scoreId: string, byteSize: number) {
    super(`the content of score ${scoreId} is ${byteSize} bytes of JSON, more than the ${MAX_VERSION_BYTES} a version holds`);
    this.name = "VersionTooLarge";
  }
}

/** The value as JSON with the keys of every object sorted: the same text for the same content, however it was built. */
function sortedJson(value: unknown): string {
  return JSON.stringify(value, (_key, inner: unknown) => {
    if (inner === null || typeof inner !== "object" || Array.isArray(inner)) return inner;
    return Object.fromEntries(Object.entries(inner).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  });
}

export interface MadeVersion {
  /** The version that holds this content: the new one, or the latest one when it already did. */
  id: string;
  /** False when the latest version of the score already held this content: none was made. */
  created: boolean;
}

/** A version to make (`createVersion`). */
export interface VersionToMake {
  /** The content, read once the score's row is locked; null makes none. */
  read: () => ScoreJSON | null;
  reason: VersionReason;
  /** Who asked for it; null for the ones the server makes on its own. */
  createdBy?: string | null;
  /** Given as it is made (`manual`); null for an automatic version. */
  name?: string | null;
  /**
   * Run once the score's row is locked, before the content is read: what must still hold for the
   * version to be made (the member's role, a score not deleted meanwhile). It throws to make none.
   */
  admit?: (row: Score, transaction: Transaction) => Promise<void>;
}

/**
 * Make a version of the score with the content `read` gives, unless its latest version already
 * holds the same; then delete its oldest automatic versions beyond the 200 kept. A named version
 * (a member's own, `manual`) is made whatever the latest one holds: the member asked for it.
 * With the score's row locked, and the content read only then: the versions of one score are
 * made one at a time, each of the content as it is when its turn comes, and compared with the one
 * made before it. Read earlier, a content could wait (gzip, a connection of the pool) while a
 * newer one is made first, and then be made the latest version (#114). Null, with nothing
 * written, when the score is no longer there (deleted for good meanwhile; `read` is not called
 * then), or when `read` gives null: there is nothing to make a version of any more. A score
 * deleted softly still gets its automatic versions: it can be restored (`admit` refuses what a
 * member asks for then). Throws `VersionTooLarge`, writing nothing, when the content is more
 * than `MAX_VERSION_BYTES`, and whatever `admit` throws.
 */
export async function createVersion(scoreId: string, { read, reason, createdBy = null, name = null, admit }: VersionToMake): Promise<MadeVersion | null> {
  return Version.sequelize!.transaction(async (transaction) => {
    const row = await Score.findOne({ where: { id: scoreId }, attributes: ["id", "deletedAt"], lock: transaction.LOCK.UPDATE, transaction });
    if (row === null) return null;
    await admit?.(row, transaction);
    const score = read();
    if (score === null) return null;
    const json = sortedJson(score);
    const byteSize = Buffer.byteLength(json);
    if (byteSize > MAX_VERSION_BYTES) throw new VersionTooLarge(scoreId, byteSize);
    const contentHash = createHash("sha256").update(json).digest("hex");
    if (name === null) {
      const latest = await Version.findOne({
        where: { scoreId },
        attributes: ["id", "contentHash"],
        order: [
          ["createdAt", "DESC"],
          ["id", "DESC"],
        ],
        transaction,
      });
      if (latest?.contentHash === contentHash) return { id: latest.id, created: false };
    }
    const content = await compress(json);
    const version = await Version.create({ scoreId, schemaVersion: score.schemaVersion, content, contentHash, byteSize, reason, createdBy, name }, { transaction });
    await Version.sequelize!.query(
      "DELETE FROM versions WHERE id IN (SELECT id FROM versions WHERE score_id = $1 AND name IS NULL ORDER BY created_at DESC, id DESC OFFSET $2)",
      { bind: [scoreId, AUTO_VERSIONS_KEPT], transaction },
    );
    return { id: version.id, created: true };
  });
}

/** The version cannot be read here: newer than this server, missing a migration step, failing one, or damaged. */
export class VersionUnreadable extends Error {
  constructor(versionId: string, cause: unknown) {
    super(`version ${versionId} cannot be read`, { cause });
    this.name = "VersionUnreadable";
  }
}

/**
 * The content of a version, brought to the current schema (docs/spec/schema.md, section 10): what
 * a preview draws and a restore writes. Gunzipped to `MAX_VERSION_BYTES` at most, whatever the
 * row holds. `JSON.parse` and not `parsePlain`: a version is a whole `ScoreJSON`, not a value of
 * a document (whose depth `parsePlain` limits, #102), and an older one reaches its migration steps
 * as it was stored. What they give is checked against
 * `scoreSchema` (`migrateJson`), whose records refuse a key named __proto__; `JSON.parse` never
 * gives an object a prototype from the content. Null when the score has no such version; throws
 * `VersionUnreadable` when it cannot be read.
 */
export async function readVersion(scoreId: string, versionId: string, migrations: readonly Migration[] = MIGRATIONS): Promise<ScoreJSON | null> {
  if (!isUuid(versionId)) return null;
  const version = await Version.findOne({ where: { id: versionId, scoreId }, attributes: ["content"] });
  if (version === null) return null;
  try {
    const json: unknown = JSON.parse((await decompress(version.content, { maxOutputLength: MAX_VERSION_BYTES })).toString());
    return migrateJson(json, migrations);
  } catch (error) {
    throw new VersionUnreadable(versionId, error);
  }
}

/** The columns a version is listed with: never its content, the largest. */
const SUMMARY_ATTRIBUTES = ["id", "createdAt", "reason", "name", "byteSize"];

/** A version as the list shows it. */
function summaryOf(version: Version) {
  return versionSummary.parse({ id: version.id, createdAt: version.createdAt.toISOString(), reason: version.reason, name: version.name, byteSize: version.byteSize });
}

/** Who may name a score's versions and make one: its Owner and its Editors (docs/spec/routes.md, 3.6). */
const canWrite = (role: Role) => role !== "viewer";

/**
 * Throws the `Refusal` unless the member may read the score's versions, or with `write` change
 * them: checked before the body, and before anything is loaded (docs/spec/routes.md, 3.4). A
 * write checks again with the score's row locked (`admitWriter`).
 */
async function checkMember(scoreId: string, accountId: string, write: boolean): Promise<void> {
  const member = await membership(scoreId, accountId);
  if (member === null) throw new Refusal(404, "not_found");
  if (write && !canWrite(member.role)) throw new Refusal(403, "forbidden");
}

/**
 * Throws the `Refusal` unless the member may still name the score's versions or make one, as of
 * the score's row locked: what is checked holds until the version is written. 404 to anyone who
 * is no member any more, or once the score is deleted; 403 to a Viewer, whoever was made one
 * since the request came.
 */
async function admitWriter(row: Score, accountId: string, transaction: Transaction): Promise<void> {
  if (row.deletedAt !== null) throw new Refusal(404, "not_found");
  const member = await ScoreMember.findOne({ where: { scoreId: row.id, accountId }, attributes: ["role"], transaction });
  if (member === null) throw new Refusal(404, "not_found");
  if (!canWrite(member.role)) throw new Refusal(403, "forbidden");
}

/** The answer `answer` gives, or the refusal it throws. */
async function answered<T>(reply: FastifyReply, answer: () => Promise<T>): Promise<T | FastifyReply> {
  try {
    return await answer();
  } catch (error) {
    if (!(error instanceof Refusal)) throw error;
    return reply.code(error.status).send({ code: error.code });
  }
}

type ScoreParams = { Params: { id: string } };
type VersionParams = { Params: { id: string; versionId: string } };

export function registerVersions(app: FastifyInstance, { collab, migrations }: { collab: Collab; migrations?: readonly Migration[] | undefined }): void {
  // Every member, a Viewer too; a guest has no session, so none of this.
  app.get<ScoreParams>("/api/scores/:id/versions", (request, reply) =>
    answered(reply, async () => {
      await checkMember(request.params.id, request.account!.id, false);
      const versions = await Version.findAll({
        where: { scoreId: request.params.id },
        attributes: SUMMARY_ATTRIBUTES,
        order: [
          ["createdAt", "DESC"],
          ["id", "DESC"],
        ],
      });
      return versionList.parse({ versions: versions.map(summaryOf) });
    }),
  );

  app.get<VersionParams>("/api/scores/:id/versions/:versionId", (request, reply) =>
    answered(reply, async () => {
      const { id: scoreId, versionId } = request.params;
      await checkMember(scoreId, request.account!.id, false);
      let score: ScoreJSON | null;
      try {
        score = await readVersion(scoreId, versionId, migrations);
      } catch (error) {
        if (!(error instanceof VersionUnreadable)) throw error;
        request.log.error({ scoreId, versionId, error }, "a version could not be read");
        throw new Refusal(409, "version_unreadable");
      }
      if (score === null) throw new Refusal(404, "not_found");
      return score;
    }),
  );

  // A version of the content the server has now (`Collab.saveVersion`): a member's own, named as
  // it is made; or, without a name, the one a restore makes first (docs/spec/collab.md, 8.5),
  // which is the latest one when that holds the same already (200 then, 201 when made). Either
  // way the role and the score are checked again once its row is locked (`admitWriter`).
  app.post<ScoreParams>("/api/scores/:id/versions", (request, reply) =>
    answered(reply, async () => {
      const scoreId = request.params.id;
      const accountId = request.account!.id;
      await checkMember(scoreId, accountId, true);
      const body = createVersionRequest.safeParse(request.body);
      if (!body.success) return invalidRequest(reply, body.error);
      const { name } = body.data;
      const asked = { createdBy: accountId, admit: (row: Score, transaction: Transaction) => admitWriter(row, accountId, transaction) };
      const made = await collab.saveVersion(scoreId, name === undefined ? { ...asked, reason: "before_restore" } : { ...asked, reason: "manual", name });
      if (made === "readOnly") throw new Refusal(409, "score_read_only");
      // Deleted meanwhile.
      if (made === null) throw new Refusal(404, "not_found");
      return reply.code(made.created ? 201 : 200).send(createdVersion.parse({ versionId: made.id }));
    }),
  );

  // With the score's row locked, as making a version locks it: the retention never deletes a
  // version while it is being named, and the role is the one the member has as it is written.
  app.patch<VersionParams>("/api/scores/:id/versions/:versionId", (request, reply) =>
    answered(reply, async () => {
      const { id: scoreId, versionId } = request.params;
      const accountId = request.account!.id;
      await checkMember(scoreId, accountId, true);
      const body = renameVersionRequest.safeParse(request.body);
      if (!body.success) return invalidRequest(reply, body.error);
      if (!isUuid(versionId)) throw new Refusal(404, "not_found");
      const { name } = body.data;
      return Version.sequelize!.transaction(async (transaction) => {
        const row = await Score.findOne({ where: { id: scoreId }, attributes: ["id", "deletedAt"], lock: transaction.LOCK.UPDATE, transaction });
        if (row === null) throw new Refusal(404, "not_found");
        await admitWriter(row, accountId, transaction);
        const version = await Version.findOne({ where: { id: versionId, scoreId }, attributes: SUMMARY_ATTRIBUTES, transaction });
        if (version === null) throw new Refusal(404, "not_found");
        // A member's own version was named as it was made, and stays named: renamed, never
        // unnamed, it never turns into an automatic one (docs/spec/collab.md, 8.4).
        if (name === null && version.reason === "manual") throw new Refusal(409, "version_name_required");
        // Without its name another version is an automatic one again: the next version made
        // keeps the 200 latest automatic ones, this one counted.
        await Version.update({ name }, { where: { id: versionId }, transaction });
        version.name = name;
        return summaryOf(version);
      });
    }),
  );
}
