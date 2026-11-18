// The versions of a score (docs/spec/collab.md, section 8): the whole score at one moment, as
// `docToJson` reads it, one row each. Here: making one, keeping at most 200 automatic ones, and
// what a member does with them (docs/spec/routes.md, 3.6): listing, reading one brought to the
// current schema, naming one, and making one now. When the server makes one on its own is the
// collab server's business (collab.ts); restoring one is the web app's (#68).
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { gunzip, gzip } from "node:zlib";

import { createdVersion, createVersionRequest, renameVersionRequest, type Role, versionList, versionSummary } from "@studio/contracts";
import { type Migration, migrateJson, MIGRATIONS, type ScoreJSON } from "@studio/score-model";
import type { FastifyInstance, FastifyReply } from "fastify";

import type { Collab } from "./collab";
import { Score, ScoreMember, Version, type VersionReason } from "./db/models";
import { invalidRequest, isUuid, notFound } from "./http";
import { WEBSOCKET_MESSAGE_LIMIT } from "./limits";
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
 * deleted softly still gets its versions: it can be restored. Throws `VersionTooLarge`, writing
 * nothing, when the content is more than `MAX_VERSION_BYTES`.
 */
export async function createVersion(
  scoreId: string,
  read: () => ScoreJSON | null,
  reason: VersionReason,
  createdBy: string | null = null,
  name: string | null = null,
): Promise<MadeVersion | null> {
  return Version.sequelize!.transaction(async (transaction) => {
    const row = await Score.findOne({ where: { id: scoreId }, attributes: ["id"], lock: transaction.LOCK.UPDATE, transaction });
    if (row === null) return null;
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
 * row holds. Null when the score has no such version; throws `VersionUnreadable` when it cannot
 * be read.
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

/** A request about a score's versions that is not answered: the refusal to send instead. */
type Refused = 403 | 404;

function refuse(reply: FastifyReply, refused: Refused) {
  return refused === 404 ? notFound(reply) : reply.code(403).send({ code: "forbidden" });
}

/** Null when the member may: read them, or with `write` change them; else the refusal, 404 to anyone who is no member, 403 to a Viewer. */
async function refusalOf(scoreId: string, accountId: string, write: boolean): Promise<Refused | null> {
  const member = await membership(scoreId, accountId);
  if (member === null) return 404;
  return write && !canWrite(member.role) ? 403 : null;
}

type ScoreParams = { Params: { id: string } };
type VersionParams = { Params: { id: string; versionId: string } };

export function registerVersions(app: FastifyInstance, { collab, migrations }: { collab: Collab; migrations?: readonly Migration[] | undefined }): void {
  // Every member, a Viewer too; a guest has no session, so none of this. The role is checked
  // before the body, as for the members (docs/spec/routes.md, 3.4).
  app.get<ScoreParams>("/api/scores/:id/versions", async (request, reply) => {
    const refused = await refusalOf(request.params.id, request.account!.id, false);
    if (refused !== null) return refuse(reply, refused);
    const versions = await Version.findAll({
      where: { scoreId: request.params.id },
      attributes: SUMMARY_ATTRIBUTES,
      order: [
        ["createdAt", "DESC"],
        ["id", "DESC"],
      ],
    });
    return versionList.parse({ versions: versions.map(summaryOf) });
  });

  app.get<VersionParams>("/api/scores/:id/versions/:versionId", async (request, reply) => {
    const { id: scoreId, versionId } = request.params;
    const refused = await refusalOf(scoreId, request.account!.id, false);
    if (refused !== null) return refuse(reply, refused);
    try {
      const score = await readVersion(scoreId, versionId, migrations);
      return score === null ? notFound(reply) : score;
    } catch (error) {
      if (!(error instanceof VersionUnreadable)) throw error;
      request.log.error({ scoreId, versionId, error }, "a version could not be read");
      return reply.code(409).send({ code: "version_unreadable" });
    }
  });

  // Of the content the server has now (`Collab.saveVersion`): with a name, a member's own;
  // without, the one a restore makes first (docs/spec/collab.md, 8.5).
  app.post<ScoreParams>("/api/scores/:id/versions", async (request, reply) => {
    const scoreId = request.params.id;
    const refused = await refusalOf(scoreId, request.account!.id, true);
    if (refused !== null) return refuse(reply, refused);
    const body = createVersionRequest.safeParse(request.body ?? {});
    if (!body.success) return invalidRequest(reply, body.error);
    const createdBy = request.account!.id;
    const { name } = body.data;
    const made = await collab.saveVersion(scoreId, name === undefined ? { reason: "before_restore", createdBy } : { reason: "manual", createdBy, name });
    if (made === "readOnly") return reply.code(409).send({ code: "score_read_only" });
    // Deleted for good meanwhile.
    if (made === null) return notFound(reply);
    return reply.code(made.created ? 201 : 200).send(createdVersion.parse({ versionId: made.id }));
  });

  // With the score's row locked, as making a version locks it: the retention never deletes a
  // version while it is being named, and the role is the one the member has as it is written.
  app.patch<VersionParams>("/api/scores/:id/versions/:versionId", async (request, reply) => {
    const { id: scoreId, versionId } = request.params;
    const accountId = request.account!.id;
    const refused = await refusalOf(scoreId, accountId, true);
    if (refused !== null) return refuse(reply, refused);
    const body = renameVersionRequest.safeParse(request.body);
    if (!body.success) return invalidRequest(reply, body.error);
    if (!isUuid(versionId)) return notFound(reply);
    const answer = await Version.sequelize!.transaction(async (transaction): Promise<Refused | ReturnType<typeof summaryOf>> => {
      const score = await Score.findOne({ where: { id: scoreId, deletedAt: null }, attributes: ["id"], lock: transaction.LOCK.UPDATE, transaction });
      const member = score && (await ScoreMember.findOne({ where: { scoreId, accountId }, attributes: ["role"], transaction }));
      if (!member) return 404;
      if (!canWrite(member.role)) return 403;
      const version = await Version.findOne({ where: { id: versionId, scoreId }, attributes: SUMMARY_ATTRIBUTES, transaction });
      if (version === null) return 404;
      // Without its name it is an automatic version again: the next version made keeps the 200
      // latest automatic ones, this one counted (docs/spec/collab.md, 8.4).
      await Version.update({ name: body.data.name }, { where: { id: versionId }, transaction });
      version.name = body.data.name;
      return summaryOf(version);
    });
    return typeof answer === "number" ? refuse(reply, answer) : answer;
  });
}
