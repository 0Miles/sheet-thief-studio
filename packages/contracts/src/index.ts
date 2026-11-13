// Shapes of what the API sends and receives, shared by the server and the web app.
import { z } from "zod";

// The score is defined once, in score-model (docs/adr/0002, addendum): only re-exported here.
export {
  type BarJSON,
  barSchema,
  type BeatJSON,
  beatSchema,
  importedScoreSchema,
  type NoteJSON,
  noteSchema,
  type PartJSON,
  partSchema,
  type ScoreJSON,
  scoreSchema,
} from "@studio/score-model";

export const health = z.object({ status: z.literal("ok") });
export type Health = z.infer<typeof health>;

// Accounts (docs/spec/accounts.md, section 1; docs/spec/security.md, section 3).
/** Lowercase letters, digits, `-` and `_`; fixed once the account exists. */
export const username = z.string().regex(/^[a-z0-9_-]{3,32}$/);
/** Trimmed, 1–50 characters. */
export const displayName = z.string().trim().min(1).max(50);
/** 10–256 characters, no composition rules. */
export const password = z.string().min(10).max(256);

/** What someone types on the login page: only bounded, since a wrong value is just wrong credentials. */
export const loginRequest = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(1).max(256),
});
export type LoginRequest = z.infer<typeof loginRequest>;

/** The account the session belongs to (`GET /api/me`). */
export const me = z.object({
  accountId: z.string(),
  username: z.string(),
  displayName: z.string(),
  isAdmin: z.boolean(),
  mustChangePassword: z.boolean(),
});
export type Me = z.infer<typeof me>;

/** Every error answer: a stable code the web app turns into text (docs/spec/routes.md, section 4). */
export const apiError = z.object({
  code: z.string(),
  params: z.record(z.string(), z.unknown()).optional(),
});
export type ApiErrorBody = z.infer<typeof apiError>;
