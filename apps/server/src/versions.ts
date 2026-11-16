// The versions of a score (docs/spec/collab.md, section 8): the whole score at one moment, as
// `docToJson` reads it, one row each. Here: making one, and keeping at most 200 automatic ones.
// When one is made is the collab server's business (collab.ts); listing, naming and restoring
// them come with M5.
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { gzip } from "node:zlib";

import type { ScoreJSON } from "@studio/score-model";

import { Score, Version, type VersionReason } from "./db/models";

const compress = promisify(gzip);

/** How often a version is made of a score that stays open (docs/spec/collab.md, 8.3). */
export const VERSION_INTERVAL_MS = 10 * 60 * 1000;

/** How many automatic versions a score keeps; the named ones are never deleted (docs/spec/collab.md, 8.4). */
export const AUTO_VERSIONS_KEPT = 200;

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
 * Make a version of the score with this content, unless its latest version already holds the
 * same; then delete its oldest automatic versions beyond the 200 kept. With the score's row
 * locked: the versions of one score are made one at a time, each compared with the one before.
 * Null when the score is no longer there (deleted for good meanwhile). A score deleted softly
 * still gets its versions: it can be restored.
 */
export async function createVersion(scoreId: string, score: ScoreJSON, reason: VersionReason, createdBy: string | null = null): Promise<MadeVersion | null> {
  const json = sortedJson(score);
  const contentHash = createHash("sha256").update(json).digest("hex");
  const content = await compress(json);
  return Version.sequelize!.transaction(async (transaction) => {
    const row = await Score.findOne({ where: { id: scoreId }, attributes: ["id"], lock: transaction.LOCK.UPDATE, transaction });
    if (row === null) return null;
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
    const version = await Version.create({ scoreId, schemaVersion: score.schemaVersion, content, contentHash, byteSize: Buffer.byteLength(json), reason, createdBy }, { transaction });
    await Version.sequelize!.query(
      `DELETE FROM versions WHERE id IN (SELECT id FROM versions WHERE score_id = $1 AND name IS NULL ORDER BY created_at DESC, id DESC OFFSET ${AUTO_VERSIONS_KEPT})`,
      { bind: [scoreId], transaction },
    );
    return { id: version.id, created: true };
  });
}
