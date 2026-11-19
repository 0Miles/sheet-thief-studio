// Restoring a version in place (docs/spec/collab.md, 8.5), as the versions page does it: the
// server first makes a version of what the score is now (`before_restore`); only once it has is
// the version read and written over the score, in the document this tab has open with the score
// page (`RestoreTarget`). When either call fails nothing is restored.
import { createdVersion, scoreSchema } from "@studio/contracts";
import type { ScoreJSON } from "@studio/score-model";

import type { ReadOnlyReason } from "./access";
import { get, postFor } from "./api";

/** The score this tab has open, which a version is written over. */
export interface RestoreTarget {
  /** The score is open here, in step with the server, and this member may change it here. */
  canRestore(): boolean;
  /** Why nobody may change the score here (`lockReadOnly`, #109); null while they may. */
  lockedBecause(): ReadOnlyReason | null;
  /** Write the version over the score, one undo step where the member types; false when nothing was written. */
  replace(version: ScoreJSON): boolean;
}

/**
 * How a restore went, when the server answered every call: `restored`; `notOpen`, nothing asked of
 * the server, while the score is not open here yet or may not be changed here; `locked`, nothing
 * asked either, the score locked here, saying why; `notWritten`, the version made before kept,
 * when the tab could not write the version over the score.
 */
export type RestoreResult = "restored" | "notOpen" | "notWritten" | { locked: ReadOnlyReason };

/**
 * Restore the version of the score: the version before it made first, then the version read
 * (brought to the current schema by the server) and written over the score. Rejects with the
 * `ApiError` of the call that failed; the version is not written then.
 */
export async function restoreVersion(scoreId: string, versionId: string, target: RestoreTarget): Promise<RestoreResult> {
  const locked = target.lockedBecause();
  if (locked !== null) return { locked };
  if (!target.canRestore()) return "notOpen";
  const path = `/api/scores/${scoreId}/versions`;
  // Without a name: the version before a restore, none made when the latest holds the same.
  await postFor(path, {}, createdVersion);
  const version = await get(`${path}/${versionId}`, scoreSchema);
  return target.replace(version) ? "restored" : "notWritten";
}
