// Shapes of what the API sends and receives, shared by the server and the web app.
import {
  barSchema,
  barsFragmentSchema,
  MAX_BARS,
  MAX_NON_PERCUSSION_PARTS,
  MAX_PARTS,
  MAX_TITLE,
  NEW_SCORE,
  PART_PRESET_IDS,
  PART_PRESETS,
  partKindSchema,
  type PartPresetId,
  partSchemas,
  timeSigSchema,
  withinPartLimits,
} from "@studio/score-model";
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

// The recognizer's answers (docs/spec/recognizer.md, section 5).
export * from "./recognizer";

// The presence of the members on a score (docs/spec/views.md, section 8).
export * from "./presence";

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

/** A new display name of one's own (`PATCH /api/me`). */
export const updateMeRequest = z.object({ displayName });
export type UpdateMeRequest = z.infer<typeof updateMeRequest>;

/**
 * A new password of one's own (`POST /api/me/password`). The current one is only bounded, like
 * the one typed to log in; it is not asked of someone who must change a temporary password.
 */
export const changePasswordRequest = z.object({
  currentPassword: z.string().min(1).max(256).optional(),
  newPassword: password,
});
export type ChangePasswordRequest = z.infer<typeof changePasswordRequest>;

// The admin's page (docs/spec/routes.md, 3.2; docs/spec/accounts.md, section 2).
/** A way an account logs in (docs/spec/accounts.md, 1.1). */
export const identityProvider = z.enum(["password", "karyl-chan"]);
export type IdentityProvider = z.infer<typeof identityProvider>;

/** An account as an admin sees it on /admin. */
export const adminAccount = z.object({
  accountId: z.string(),
  username: z.string(),
  displayName: z.string(),
  isAdmin: z.boolean(),
  disabled: z.boolean(),
  identities: z.array(z.object({ id: z.string(), provider: identityProvider })),
});
export type AdminAccount = z.infer<typeof adminAccount>;

/** Every account, by username (`GET /api/admin/accounts`). */
export const adminAccountList = z.object({ accounts: z.array(adminAccount) });
export type AdminAccountList = z.infer<typeof adminAccountList>;

/** A new account with a temporary password, which its person must change first (`POST /api/admin/accounts`). */
export const createAccountRequest = z.object({ username, displayName, password });
export type CreateAccountRequest = z.infer<typeof createAccountRequest>;

/** A new temporary password (`POST /api/admin/accounts/:id/reset-password`). */
export const resetPasswordRequest = z.object({ password });
export type ResetPasswordRequest = z.infer<typeof resetPasswordRequest>;

// Scores (docs/spec/routes.md, 3.3; docs/spec/collab.md, section 3).
/** A member's role in a score (docs/spec/accounts.md, section 3). */
export const role = z.enum(["owner", "editor", "viewer"]);
export type Role = z.infer<typeof role>;

/** A part preset (docs/spec/commands.md, section 10), by its id in `PART_PRESETS`. */
export const partPresetId = z.enum(PART_PRESET_IDS);

/**
 * Parts of a new score, a line of its dialog: a preset, how many parts of it, and for fretted ones
 * a tuning of its number of strings (the preset's when left out).
 */
export const partChoice = z
  .object({ preset: partPresetId, count: z.int().min(1).max(MAX_PARTS).default(1), tuning: partSchemas.fretted.shape.tuning.optional() })
  .refine(({ preset, tuning }) => tuning === undefined || (PART_PRESETS[preset].kind === "fretted" && tuning.length === PART_PRESETS[preset].tuning.length), {
    message: "a tuning of the preset's number of strings, for fretted parts only",
    path: ["tuning"],
  });
export type PartChoice = z.input<typeof partChoice>;

/** Every part these choices make, in order: each choice as many times as its count (once when left out). */
export function eachPart(choices: readonly PartChoice[]): { preset: PartPresetId; tuning?: number[] }[] {
  return choices.flatMap(({ preset, count = 1, tuning }) => Array.from({ length: count }, () => ({ preset, tuning })));
}

/**
 * Whether a score may have the parts these choices make (docs/spec/commands.md, 7.1). The counts
 * are added up first, so that no count past the limit makes its parts: zod runs this even when a
 * count already failed its own range, and the dialog runs it on whatever is typed.
 */
export function choicesWithinPartLimits(choices: readonly PartChoice[]): boolean {
  const total = choices.reduce((sum, { count = 1 }) => sum + Math.max(0, count), 0);
  // Not `>`: a count that is no number (NaN) fails here too.
  if (!(total <= MAX_PARTS)) return false;
  return withinPartLimits(eachPart(choices).map(({ preset }) => PART_PRESETS[preset].kind));
}

/**
 * A new score (`POST /api/scores`), as the dialog chooses it (docs/spec/commands.md, section 10):
 * its title, its parts in order, the time signature of its bars, the tempo of the first, and how
 * many bars. What is left out is the default: one six-string guitar, eight bars of 4/4 at 120.
 */
export const createScoreRequest = z.object({
  title: z.string().trim().min(1).max(MAX_TITLE),
  parts: z
    .array(partChoice)
    .min(1)
    .max(MAX_PARTS)
    .refine(choicesWithinPartLimits, `at most ${MAX_PARTS} parts, ${MAX_NON_PERCUSSION_PARTS} of them other than drums`)
    .default(() => [{ preset: NEW_SCORE.part, count: 1 }]),
  timeSig: timeSigSchema.default(() => ({ ...NEW_SCORE.timeSig })),
  tempo: barSchema.shape.tempo.unwrap().default(NEW_SCORE.tempo),
  bars: z.int().min(1).max(MAX_BARS).default(NEW_SCORE.bars),
});
export type CreateScoreRequest = z.input<typeof createScoreRequest>;
export type NewScore = z.output<typeof createScoreRequest>;

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

/** How many days a deleted score can still be restored, before it is deleted for good (docs/spec/accounts.md, section 8). */
export const DELETED_SCORE_DAYS = 30;

/** A score I own and deleted, as the "deleted" block of `/` lists them (`GET /api/scores/deleted`), most recently deleted first. */
export const deletedScore = z.object({
  id: z.string(),
  title: z.string(),
  artist: z.string().nullable(),
  deletedAt: z.string(),
});
export type DeletedScore = z.infer<typeof deletedScore>;

export const deletedScoreList = z.object({ scores: z.array(deletedScore) });
export type DeletedScoreList = z.infer<typeof deletedScoreList>;

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

// Members (docs/spec/routes.md, 3.4; docs/spec/accounts.md, sections 4 to 6).
/** The roles an Owner gives: there is one Owner, who changes by transfer only. */
export const memberRole = role.exclude(["owner"]);
export type MemberRole = z.infer<typeof memberRole>;

/** A member of a score, as every member sees them on its settings page. */
export const scoreMember = z.object({
  accountId: z.string(),
  username: z.string(),
  displayName: z.string(),
  role,
  disabled: z.boolean(),
});
export type ScoreMember = z.infer<typeof scoreMember>;

/** The members of a score (`GET /api/scores/:id/members`): its Owner first, then in the order they were added. */
export const scoreMemberList = z.object({ members: z.array(scoreMember) });
export type ScoreMemberList = z.infer<typeof scoreMemberList>;

/**
 * An account to add as a member (`POST /api/scores/:id/members`), by its whole username: only
 * bounded, since a name no account can have is just an account that is not found. An Editor
 * unless told otherwise.
 */
export const addMemberRequest = z.object({ username: z.string().trim().min(1).max(64), role: memberRole.default("editor") });
export type AddMemberRequest = z.input<typeof addMemberRequest>;

/** A member's new role (`PATCH /api/scores/:id/members/:accountId`). */
export const changeRoleRequest = z.object({ role: memberRole });
export type ChangeRoleRequest = z.infer<typeof changeRoleRequest>;

/** The member who becomes the Owner (`POST /api/scores/:id/transfer`, `POST /api/admin/scores/:id/transfer`). */
export const transferRequest = z.object({ accountId: z.string().min(1).max(64) });
export type TransferRequest = z.infer<typeof transferRequest>;

/**
 * A score whose Owner is disabled, as an admin sees it on /admin (docs/spec/accounts.md, section
 * 2): its title, its Owner, and its members who can log in, to one of whom it can be handed over;
 * none of its content. The members in the order they were added.
 */
export const orphanedScore = z.object({
  id: z.string(),
  title: z.string(),
  owner: z.object({ accountId: z.string(), username: z.string(), displayName: z.string() }),
  members: z.array(z.object({ accountId: z.string(), username: z.string(), displayName: z.string(), role: memberRole })),
});
export type OrphanedScore = z.infer<typeof orphanedScore>;

/** Every score whose Owner is disabled, by the Owner's username, then title (`GET /api/admin/orphaned-scores`). */
export const orphanedScoreList = z.object({ scores: z.array(orphanedScore) });
export type OrphanedScoreList = z.infer<typeof orphanedScoreList>;

/**
 * What the collab server tells a connection about its document, as the JSON payload of a
 * Hocuspocus stateless message (docs/spec/collab.md, section 2.1). `readOnly`: the server drops
 * every change to this score, whatever the role, because the score is of a newer schema than the
 * server, misses a migration step, or has one that failed on it; sent once, as the connection is made.
 */
export const readOnlyNotice = z.object({ type: z.literal("readOnly"), reason: z.enum(["newerSchema", "missingMigration", "migrationFailed"]) });
export type ReadOnlyNotice = z.infer<typeof readOnlyNotice>;

/**
 * `closed`: the server closes this connection for good, just after it sends this: its tab is not
 * to connect again with what it holds (docs/spec/collab.md, section 9). `tooDeep`: it sent a
 * value nested deeper than a value of the document may be (#102), which it would send again.
 */
export const closedNotice = z.object({ type: z.literal("closed"), reason: z.enum(["tooDeep"]) });
export type ClosedNotice = z.infer<typeof closedNotice>;

export const collabNotice = z.discriminatedUnion("type", [readOnlyNotice, closedNotice]);
export type CollabNotice = z.infer<typeof collabNotice>;

// Read-only links (docs/spec/routes.md, 3.5; docs/spec/accounts.md, section 7).
/** The score's read-only link, for its Owner (`GET`, `POST /api/scores/:id/link`): null when it has none. */
export const scoreLink = z.object({ token: z.string().nullable() });
export type ScoreLink = z.infer<typeof scoreLink>;

/** What a guest gets for a read-only link (`POST /api/s/:token`): the score to open, its title, and a collab ticket for it. */
export const guestTicket = z.object({ scoreId: z.string(), title: z.string(), ticket: z.string() });
export type GuestTicket = z.infer<typeof guestTicket>;

// Versions (docs/spec/routes.md, 3.6; docs/spec/collab.md, section 8).
/**
 * Why a version was made: as the last member left, every 10 minutes while the score is open,
 * before a restore, or by a member who named it as they made it.
 */
export const versionReason = z.enum(["last_disconnect", "interval", "before_restore", "manual"]);
export type VersionReason = z.infer<typeof versionReason>;

/** The lengths a version's name may have, in characters (docs/spec/collab.md, 8.4). */
export const versionLimits = { name: { min: 1, max: 100 } } as const;
/** Trimmed. */
export const versionName = z.string().trim().min(versionLimits.name.min).max(versionLimits.name.max);

/** A version as the versions page lists them (`GET /api/scores/:id/versions`): a named one is never deleted on its own. */
export const versionSummary = z.object({
  id: z.string(),
  createdAt: z.string(),
  reason: versionReason,
  /** Null for an automatic version. */
  name: z.string().nullable(),
  /** Of its JSON. */
  byteSize: z.int(),
});
export type VersionSummary = z.infer<typeof versionSummary>;

/** The versions of a score, the latest first. */
export const versionList = z.object({ versions: z.array(versionSummary) });
export type VersionList = z.infer<typeof versionList>;

/**
 * A member's own version, named as it is made, of the content the server has now
 * (`POST /api/scores/:id/versions`): always a new one, whatever the latest version holds.
 */
export const createVersionRequest = z.object({ name: versionName });
export type CreateVersionRequest = z.infer<typeof createVersionRequest>;

export const createdVersion = z.object({ versionId: z.string() });
export type CreatedVersion = z.infer<typeof createdVersion>;

/**
 * A version named, or its name taken away (`PATCH /api/scores/:id/versions/:versionId`): an
 * automatic version again; a member's own (`manual`) keeps one (409 `version_name_required`).
 */
export const renameVersionRequest = z.object({ name: versionName.nullable() });
export type RenameVersionRequest = z.infer<typeof renameVersionRequest>;

// Phrases (docs/spec/routes.md, 3.7; docs/spec/phrases.md, section 4).
/** The lengths a phrase's name may have, in characters. */
export const phraseLimits = { name: { min: 1, max: 100 } } as const;
/** Trimmed. */
export const phraseName = z.string().trim().min(phraseLimits.name.min).max(phraseLimits.name.max);
/** A revision of a phrase: the first is 1. */
const revision = z.int().min(1);

/** A new phrase (`POST /api/phrases`): a blank one, or bars saved from a score. */
export const createPhraseRequest = z.object({ name: phraseName, fragment: barsFragmentSchema });
export type CreatePhraseRequest = z.infer<typeof createPhraseRequest>;

/** Every write of a phrase counts one more revision; one made from an older revision is refused (409 `revision_conflict`). */
export const phraseRevision = z.object({ revision });
export type PhraseRevision = z.infer<typeof phraseRevision>;

export const createdPhrase = z.object({ id: z.string(), revision });
export type CreatedPhrase = z.infer<typeof createdPhrase>;

/** The whole content of a phrase, written over what it held (`PUT /api/phrases/:id`). */
export const savePhraseRequest = z.object({ fragment: barsFragmentSchema, baseRevision: revision });
export type SavePhraseRequest = z.infer<typeof savePhraseRequest>;

/** A new name (`PATCH /api/phrases/:id`). */
export const renamePhraseRequest = z.object({ name: phraseName, baseRevision: revision });
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
export const phraseQuery = z.object({ kind: partKindSchema.optional(), q: z.string().max(phraseLimits.name.max).optional() });
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
  "wrong_current_password",
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
  "score_read_only",
  "version_unreadable",
  "version_name_required",
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
