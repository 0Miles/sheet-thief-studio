// Shapes of what the API sends and receives, shared by the server and the web app.
import { barsFragmentSchema, partKindSchema } from "@studio/score-model";
import { z } from "zod";

// The score is defined once, in score-model (docs/adr/0002, addendum): only re-exported here.
export {
  type BarJSON,
  type BarsFragment,
  barsFragmentSchema,
  barSchema,
  type BeatJSON,
  type BeatsFragment,
  beatsFragmentSchema,
  beatSchema,
  type Fragment,
  fragmentSchema,
  importedScoreSchema,
  type NoteJSON,
  noteSchema,
  type PartJSON,
  type PartKind,
  partKindSchema,
  partSchema,
  type ScoreJSON,
  scoreSchema,
} from "@studio/score-model";

export const health = z.object({ status: z.literal("ok") });
export type Health = z.infer<typeof health>;

// Accounts (docs/spec/accounts.md, section 1; docs/spec/security.md, section 3).
/** The lengths an account's fields may have, in characters. */
export const accountLimits = {
  username: { min: 3, max: 32 },
  displayName: { min: 1, max: 50 },
  password: { min: 10, max: 256 },
} as const;
/** Lowercase letters, digits, `-` and `_`; fixed once the account exists. */
export const username = z.string().regex(new RegExp(`^[a-z0-9_-]{${accountLimits.username.min},${accountLimits.username.max}}$`));
/** Trimmed. */
export const displayName = z.string().trim().min(accountLimits.displayName.min).max(accountLimits.displayName.max);
/** No composition rules. */
export const password = z.string().min(accountLimits.password.min).max(accountLimits.password.max);

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

// Scores (docs/spec/routes.md, 3.3; docs/spec/collab.md, section 3).
/** A member's role in a score (docs/spec/accounts.md, section 3). */
export const role = z.enum(["owner", "editor", "viewer"]);
export type Role = z.infer<typeof role>;

/** A new score (`POST /api/scores`). Only the title for now; the dialog of #11 adds the parts and the rest. */
export const createScoreRequest = z.object({
  title: z.string().trim().min(1).max(100),
});
export type CreateScoreRequest = z.infer<typeof createScoreRequest>;

export const createdScore = z.object({ id: z.string() });
export type CreatedScore = z.infer<typeof createdScore>;

/** One of my scores, as `/` lists them (`GET /api/scores`), most recently updated first. */
export const scoreSummary = z.object({
  id: z.string(),
  title: z.string(),
  artist: z.string().nullable(),
  role,
  updatedAt: z.string(),
});
export type ScoreSummary = z.infer<typeof scoreSummary>;

export const scoreList = z.object({ scores: z.array(scoreSummary) });
export type ScoreList = z.infer<typeof scoreList>;

/** A score I am a member of (`GET /api/scores/:id`). */
export const scoreDetails = z.object({
  id: z.string(),
  title: z.string(),
  artist: z.string().nullable(),
  role,
  owner: z.object({ accountId: z.string(), displayName: z.string() }),
});
export type ScoreDetails = z.infer<typeof scoreDetails>;

/** A one-time ticket to open the score on /collab, valid 60 seconds (`POST /api/scores/:id/collab-ticket`). */
export const collabTicket = z.object({ ticket: z.string(), role });
export type CollabTicket = z.infer<typeof collabTicket>;

// Read-only links (docs/spec/routes.md, 3.5; docs/spec/accounts.md, section 7).
/** The score's read-only link, for its Owner (`GET`, `POST /api/scores/:id/link`): null when it has none. */
export const scoreLink = z.object({ token: z.string().nullable() });
export type ScoreLink = z.infer<typeof scoreLink>;

/** What a guest gets for a read-only link (`POST /api/s/:token`): the score to open, its title, and a collab ticket for it. */
export const guestTicket = z.object({ scoreId: z.string(), title: z.string(), ticket: z.string() });
export type GuestTicket = z.infer<typeof guestTicket>;

// Phrases (docs/spec/routes.md, 3.7; docs/spec/phrases.md, section 4).
/** Trimmed, 1 to 100 characters. */
export const phraseName = z.string().trim().min(1).max(100);

/** A new phrase (`POST /api/phrases`): a blank one, or bars saved from a score. */
export const createPhraseRequest = z.object({ name: phraseName, fragment: barsFragmentSchema });
export type CreatePhraseRequest = z.infer<typeof createPhraseRequest>;

/** Every write of a phrase counts one more revision; one made from an older revision is refused (409 `revision_conflict`). */
export const phraseRevision = z.object({ revision: z.int().min(1) });
export type PhraseRevision = z.infer<typeof phraseRevision>;

export const createdPhrase = z.object({ id: z.string(), revision: z.int().min(1) });
export type CreatedPhrase = z.infer<typeof createdPhrase>;

/** The whole content of a phrase, written over what it held (`PUT /api/phrases/:id`). */
export const savePhraseRequest = z.object({ fragment: barsFragmentSchema, baseRevision: z.int().min(1) });
export type SavePhraseRequest = z.infer<typeof savePhraseRequest>;

/** A new name (`PATCH /api/phrases/:id`). */
export const renamePhraseRequest = z.object({ name: phraseName, baseRevision: z.int().min(1) });
export type RenamePhraseRequest = z.infer<typeof renamePhraseRequest>;

/** One of my phrases, as `/phrases` lists them (`GET /api/phrases`), most recently updated first. */
export const phraseSummary = z.object({
  id: z.string(),
  name: z.string(),
  kind: partKindSchema,
  /** Fretted phrases only. */
  stringCount: z.int().nullable(),
  /** Pitched phrases only. */
  staffCount: z.int().nullable(),
  barCount: z.int(),
  updatedAt: z.string(),
  revision: z.int(),
});
export type PhraseSummary = z.infer<typeof phraseSummary>;

export const phraseList = z.object({ phrases: z.array(phraseSummary) });
export type PhraseList = z.infer<typeof phraseList>;

/** What `GET /api/phrases` filters by: a kind, and a part of the name (either case). */
export const phraseQuery = z.object({ kind: partKindSchema.optional(), q: z.string().max(100).optional() });
export type PhraseQuery = z.infer<typeof phraseQuery>;

/** One phrase, with its content (`GET /api/phrases/:id`). */
export const phraseDetails = z.object({ id: z.string(), name: z.string(), fragment: barsFragmentSchema, revision: z.int(), updatedAt: z.string() });
export type PhraseDetails = z.infer<typeof phraseDetails>;

/** A copy of a phrase (`POST /api/phrases/:id/duplicate`). */
export const duplicatedPhrase = z.object({ id: z.string() });
export type DuplicatedPhrase = z.infer<typeof duplicatedPhrase>;

/** The codes of error answers (docs/spec/routes.md, section 4): a new code goes in both places. */
export const errorCode = z.enum([
  "unauthenticated",
  "invalid_credentials",
  "password_change_required",
  "bad_origin",
  "forbidden",
  "not_found",
  "account_not_found",
  "already_member",
  "username_taken",
  "identity_taken",
  "cannot_disable_self",
  "owner_cannot_leave",
  "revision_conflict",
  "recognition_in_progress",
  "payload_too_large",
  "phrase_too_large",
  "score_too_large",
  "unsupported_image",
  "invalid_request",
  "limit_exceeded",
  "rate_limited",
  "recognizer_busy",
  "internal_error",
]);
export type ErrorCode = z.infer<typeof errorCode>;

/** Every error answer: a stable code the web app turns into text. */
export const apiError = z.object({
  code: errorCode,
  params: z.record(z.string(), z.unknown()).optional(),
});
export type ApiErrorBody = z.infer<typeof apiError>;
