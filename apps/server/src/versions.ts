// The versions of a score (docs/spec/collab.md, section 8): the whole score at one moment, as
// `docToJson` reads it, one row each. Here: making one, and keeping at most 200 automatic ones.
// When one is made is the collab server's business (collab.ts); listing, naming and restoring
// them come with M5.
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { gzip } from "node:zlib";

import type { ScoreJSON } from "@studio/score-model";

import { Score, Version, type VersionReason } from "./db/models";
import { WEBSOCKET_MESSAGE_LIMIT } from "./limits";

const compress = promisify(gzip);

/** How often a version is made of a score that stays open (docs/spec/collab.md, 8.3). */
export const VERSION_INTERVAL_MS = 10 * 60 * 1000;

/** How many automatic versions a score keeps; the named ones are never deleted (docs/spec/collab.md, 8.4). */
export const AUTO_VERSIONS_KEPT = 200;

/**
 * The most a version holds, in bytes of JSON before it is gzipped: what one WebSocket message
 * carries (docs/spec/security.md, section 5), since restoring a version sends its whole content
 * as one. Whoever reads a version back (M5) gunzips it with `maxOutputLength` set to this, so
 * that no row, however it got there, inflates beyond it.
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
 * holds the same; then delete its oldest automatic versions beyond the 200 kept. With the score's
 * row locked, and the content read only then: the versions of one score are made one at a time,
 * each of the content as it is when its turn comes, and compared with the one made before it.
 * Read earlier, a content could wait (gzip, a connection of the pool) while a newer one is made
 * first, and then be made the latest version (#114). Null, with nothing written, when the score
 * is no longer there (deleted for good meanwhile; `read` is not called then), or when `read`
 * gives null: there is nothing to make a version of any more. A score deleted softly still gets
 * its versions: it can be restored. Throws `VersionTooLarge`, writing nothing, when the content
 * is more than `MAX_VERSION_BYTES`.
 */
export async function createVersion(scoreId: string, read: () => ScoreJSON | null, reason: VersionReason, createdBy: string | null = null): Promise<MadeVersion | null> {
  return Version.sequelize!.transaction(async (transaction) => {
    const row = await Score.findOne({ where: { id: scoreId }, attributes: ["id"], lock: transaction.LOCK.UPDATE, transaction });
    if (row === null) return null;
    const score = read();
    if (score === null) return null;
    const json = sortedJson(score);
    const byteSize = Buffer.byteLength(json);
    if (byteSize > MAX_VERSION_BYTES) throw new VersionTooLarge(scoreId, byteSize);
    const contentHash = createHash("sha256").update(json).digest("hex");
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
    const content = await compress(json);
    const version = await Version.create({ scoreId, schemaVersion: score.schemaVersion, content, contentHash, byteSize, reason, createdBy }, { transaction });
    await Version.sequelize!.query(
      "DELETE FROM versions WHERE id IN (SELECT id FROM versions WHERE score_id = $1 AND name IS NULL ORDER BY created_at DESC, id DESC OFFSET $2)",
      { bind: [scoreId, AUTO_VERSIONS_KEPT], transaction },
    );
    return { id: version.id, created: true };
  });
}
