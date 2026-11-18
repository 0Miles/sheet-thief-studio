// What the server stored as JSON (in Redis) and reads back: it may have been written by an older
// version, or changed by hand, so it is read by the fields of its shape (score-model's `parsePlain`,
// docs/spec/schema.md, section 11) and never cast.
import { parsePlain } from "@studio/score-model";
import type { z } from "zod";

/** What a stored string holds, read by the fields of its shape; null when it is not JSON or not of that shape. */
export function readJson<Schema extends z.ZodType>(stored: string, schema: Schema): z.output<Schema> | null {
  let value: unknown;
  try {
    value = JSON.parse(stored);
  } catch {
    return null;
  }
  const parsed = parsePlain(schema, value);
  return parsed.success ? parsed.data : null;
}
