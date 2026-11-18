// Scores and their members (docs/spec/routes.md, 3.3; docs/spec/collab.md, sections 2 and 3):
// creating one, listing mine, opening one, and the collab ticket to edit it.
import { collabTicket, createdScore, createScoreRequest, eachPart, type NewScore, type Role, scoreDetails, scoreList } from "@studio/contracts";
import { addPart, barsOf, createScore, insertBars, PART_PRESETS, partNames, SCHEMA_VERSION } from "@studio/score-model";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import * as Y from "yjs";

import type { Collab } from "./collab";
import type { CollabTickets } from "./collabTickets";
import { Account, Score, ScoreMember } from "./db/models";
import { invalidRequest, isUuid, notFound, rateLimited } from "./http";
import { MEMBER_TICKET_BY_ACCOUNT, type RateLimiter } from "./rateLimit";

/** The score with this id, unless it does not exist or is deleted. */
export async function liveScore(id: string): Promise<Score | null> {
  if (!isUuid(id)) return null;
  return Score.findOne({ where: { id, deletedAt: null } });
}

/** The columns of a score that a membership check loads unless told others. */
const MEMBERSHIP_COLUMNS = ["id", "title", "artist"];

/**
 * The account's role in the score, with the score (these columns of it); null when either is
 * missing, the score is deleted or the account is no member. Role and columns are read in one
 * statement, as of the same moment.
 */
export async function membership(scoreId: string, accountId: string, columns = MEMBERSHIP_COLUMNS): Promise<{ score: Score; role: Role } | null> {
  if (!isUuid(scoreId)) return null;
  const member = await ScoreMember.findOne({
    where: { scoreId, accountId },
    // Not the Yjs state: no caller needs it, and it is the largest column of the table.
    include: [{ model: Score, as: "score", where: { deletedAt: null }, required: true, attributes: columns }],
  });
  return member === null ? null : { score: member.get("score") as Score, role: member.role };
}

/**
 * The score (these columns of it) when the session's account is its Owner; otherwise null, the
 * refusal sent: 404 to anyone who is no member (docs/spec/security.md, section 8), 403 to the
 * other members. Checked without any lock: whatever the route writes after it is checked again
 * with the score's row locked (`changeMembers` in members.ts), as an Owner may hand the score
 * over in between.
 */
export async function ownedScore(request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply, columns = MEMBERSHIP_COLUMNS): Promise<Score | null> {
  const member = await membership(request.params.id, request.account!.id, columns);
  if (member?.role === "owner") return member.score;
  if (member === null) notFound(reply);
  else reply.code(403).send({ code: "forbidden" });
  return null;
}

/**
 * What a new score starts with (docs/spec/commands.md, section 10): the parts chosen, each as its
 * preset with the tuning chosen and numbered by the name of its preset, then the bars, of the time
 * signature chosen, the first at the tempo chosen. Written by the server through the commands of
 * score-model, but for the tempo: the command that sets one comes with the bar properties (#22).
 */
export function startContent(doc: Y.Doc, { title, parts, timeSig, tempo, bars }: NewScore): void {
  createScore(doc, title);
  const each = eachPart(parts);
  const names = partNames(each.map(({ preset }) => preset));
  each.forEach(({ preset, tuning }, index) => {
    const { kind, tuning: standard, staves, program } = PART_PRESETS[preset];
    addPart(doc, { name: names[index] as string, kind, tuning: [...(tuning ?? standard)], staves: [...staves], program });
  });
  const [first] = insertBars(doc, { after: null, count: bars, timeSig });
  // Written even when it is 120, which an unwritten tempo reads as: the first bar says what was chosen.
  doc.transact(() => barsOf(doc).get(first as string)!.set("tempo", tempo));
}

/** Make a score owned by the account, its content written as a participant; returns its id. */
async function makeScore(collab: Collab, ownerId: string, request: NewScore): Promise<string> {
  const score = await Score.sequelize!.transaction(async (transaction) => {
    const created = await Score.create({ title: request.title, docState: Buffer.from(Y.encodeStateAsUpdate(new Y.Doc())), schemaVersion: SCHEMA_VERSION }, { transaction });
    await ScoreMember.create({ scoreId: created.id, accountId: ownerId, role: "owner" }, { transaction });
    return created;
  });
  // Between the commit and the end of `change`, the row holds an empty document. Nobody can open
  // it meanwhile: its id is only answered below, and only its Owner is a member.
  try {
    await collab.change(score.id, (doc) => startContent(doc, request));
  } catch (error) {
    // No empty score left behind for its Owner to find.
    await score.destroy();
    throw error;
  }
  return score.id;
}

export function registerScores(app: FastifyInstance, { collab, tickets, limiter }: { collab: Collab; tickets: CollabTickets; limiter: RateLimiter }): void {
  app.post("/api/scores", async (request, reply) => {
    const body = createScoreRequest.safeParse(request.body);
    if (!body.success) return invalidRequest(reply, body.error);
    const id = await makeScore(collab, request.account!.id, body.data);
    return reply.code(201).send(createdScore.parse({ id }));
  });

  app.get("/api/scores", async (request) => {
    const members = await ScoreMember.findAll({
      where: { accountId: request.account!.id },
      include: [{ model: Score, as: "score", where: { deletedAt: null }, required: true, attributes: ["id", "title", "artist", "updatedAt"] }],
      order: [[{ model: Score, as: "score" }, "updatedAt", "DESC"]],
    });
    return scoreList.parse({
      scores: members.map((member) => {
        const score = member.get("score") as Score;
        return { id: score.id, title: score.title, artist: score.artist, role: member.role, updatedAt: score.updatedAt.toISOString() };
      }),
    });
  });

  app.get<{ Params: { id: string } }>("/api/scores/:id", async (request, reply) => {
    const member = await membership(request.params.id, request.account!.id);
    if (member === null) return notFound(reply);
    const owner = await ScoreMember.findOne({ where: { scoreId: member.score.id, role: "owner" }, include: [{ model: Account, as: "account", required: true }] });
    const account = owner?.get("account") as Account | undefined;
    if (account === undefined) throw new Error(`score ${member.score.id} has no owner`);
    return scoreDetails.parse({
      id: member.score.id,
      title: member.score.title,
      artist: member.score.artist,
      role: member.role,
      owner: { accountId: account.id, displayName: account.displayName },
    });
  });

  app.post<{ Params: { id: string } }>("/api/scores/:id/collab-ticket", async (request, reply) => {
    // Every attempt counts, whatever the score: a provider asks again at each reconnection.
    const attempt = await limiter.take(MEMBER_TICKET_BY_ACCOUNT, request.account!.id);
    if (!attempt.ok) return rateLimited(reply, attempt.retryAfterSeconds);
    const member = await membership(request.params.id, request.account!.id);
    if (member === null) return notFound(reply);
    const ticket = await tickets.issue({ kind: "member", scoreId: member.score.id, accountId: request.account!.id, sessionId: request.session!.id, role: member.role });
    return collabTicket.parse({ ticket, role: member.role });
  });
}
