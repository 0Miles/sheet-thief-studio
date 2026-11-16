// Bringing a score of an older schema up to date (docs/spec/schema.md sections 9 and 10), on
// both sides: the server migrates a document when it loads it, and a stored version (a
// `docToJson` of its day) before anyone reads it. Both sides of a step mean the same change.
import type * as Y from "yjs";

import { metaOf, metaSchema, parsePlain, SCHEMA_VERSION, type ScoreJSON, scoreSchema } from "./schema";

/** One step of the schema: what it changes in a document, and the same change in a version. */
export interface Migration {
  from: number;
  to: number;
  doc(doc: Y.Doc): void;
  json(json: unknown): unknown;
}

/** Every step from the first published schema, oldest first. Schema 1 is the first: none yet. */
export const MIGRATIONS: readonly Migration[] = [];

/** The steps from `version` to the current schema, in order; throws when one is missing. */
function stepsFrom(version: number, migrations: readonly Migration[]): Migration[] {
  const steps: Migration[] = [];
  for (let at = version; at < SCHEMA_VERSION; ) {
    const step = migrations.find((item) => item.from === at && item.to > at && item.to <= SCHEMA_VERSION);
    if (step === undefined) throw new Error(`No migration from schema version ${at}`);
    steps.push(step);
    at = step.to;
  }
  return steps;
}

/**
 * The schema version a score says it is of, read as readScore reads it: the current one when
 * it is missing or cannot be read, so that an odd value neither migrates nor locks a score.
 */
function versionOf(value: unknown): number {
  const parsed = parsePlain(metaSchema.shape.schemaVersion, value);
  return parsed.success ? parsed.data : SCHEMA_VERSION;
}

/**
 * Whether the document was written by a newer schema than this code knows. Such a document
 * opens read-only, and the server neither migrates nor fills it in.
 */
export function isNewerSchema(doc: Y.Doc): boolean {
  return versionOf(metaOf(doc).get("schemaVersion")) > SCHEMA_VERSION;
}

/**
 * Server only, when it loads a document: run every step from the document's schema to the
 * current one, in one transaction, then mark it current. Returns whether it changed anything;
 * a document of the current schema, of a newer one, or whose schema version cannot be read
 * (no score in it yet among them) is left as it is. Throws, changing nothing, when a step is
 * missing. Never call it while the server stores the document: storing it again would follow.
 */
export function migrateDoc(doc: Y.Doc, migrations: readonly Migration[] = MIGRATIONS): boolean {
  const version = versionOf(metaOf(doc).get("schemaVersion"));
  if (version >= SCHEMA_VERSION) return false;
  const steps = stepsFrom(version, migrations);
  doc.transact(() => {
    for (const step of steps) step.doc(doc);
    metaOf(doc).set("schemaVersion", SCHEMA_VERSION);
  });
  return true;
}

/**
 * A stored version brought to the current schema, checked against it: what the server hands out
 * for previews and restores; one whose schema version cannot be read is taken as current.
 * Throws when the version is newer than this code, misses a step, or does not pass the schema
 * once migrated.
 */
export function migrateJson(json: unknown, migrations: readonly Migration[] = MIGRATIONS): ScoreJSON {
  const version = versionOf((json as { schemaVersion?: unknown } | null)?.schemaVersion);
  if (version > SCHEMA_VERSION) throw new Error(`A version of schema ${version}, newer than this code (${SCHEMA_VERSION})`);
  let migrated = json;
  for (const step of stepsFrom(version, migrations)) migrated = step.json(migrated);
  return scoreSchema.parse({ ...(migrated as object), schemaVersion: SCHEMA_VERSION });
}
