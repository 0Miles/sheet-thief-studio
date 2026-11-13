// Scores and their members (docs/spec/routes.md, 3.3; docs/spec/collab.md, sections 2 and 3):
// creating one, listing mine, opening one, and the collab ticket to edit it.
import { collabTicket, createdScore, createScoreRequest, scoreDetails, scoreList } from "@studio/contracts";
import { addPart, COMMON_TIME, createScore as startScore, insertBars, SCHEMA_VERSION } from "@studio/score-model";
import type { FastifyInstance, FastifyReply } from "fastify";
import * as Y from "yjs";

import type { Collab } from "./collab";
import type { CollabTickets } from "./collabTickets";
import { Account, type Role, Score, ScoreMember } from "./db/models";
import { invalidRequest } from "./http";

/** Score ids are UUIDs; anything else is no score, without asking Postgres. */
const SCORE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The score with this id, unless it does not exist or is deleted. */
export async function liveScore(id: string): Promise<Score | null> {
  if (!SCORE_ID.test(id)) return null;
  return Score.findOne({ where: { id, deletedAt: null } });
}

/** The account's role in the score, with the score; null when either is missing, the score is deleted or the account is no member. */
export async function membership(scoreId: string, accountId: string): Promise<{ score: Score; role: Role } | null> {
  if (!SCORE_ID.test(scoreId)) return null;
  const member = await ScoreMember.findOne({
    where: { scoreId, accountId },
    include: [{ model: Score, as: "score", where: { deletedAt: null }, required: true }],
  });
  return member === null ? null : { score: member.get("score") as Score, role: member.role };
}

/**
 * What a new score starts with, written by the server through the commands of score-model: one
 * six-string guitar and eight bars of 4/4. The tempo is left unwritten, which reads as 120
 * (docs/spec/schema.md, section 3). The dialog of #11 replaces these fixed values.
 */
function startContent(doc: Y.Doc, title: string): void {
  startScore(doc, title);
  addPart(doc, { name: "吉他 1", kind: "fretted" });
  insertBars(doc, { after: null, count: 8, timeSig: COMMON_TIME });
}

/** Make a score owned by the account, its content written as a participant; returns its id. */
export async function createScore(collab: Collab, ownerId: string, title: string): Promise<string> {
  const score = await Score.sequelize!.transaction(async (transaction) => {
    const created = await Score.create({ title, docState: Buffer.from(Y.encodeStateAsUpdate(new Y.Doc())), schemaVersion: SCHEMA_VERSION }, { transaction });
    await ScoreMember.create({ scoreId: created.id, accountId: ownerId, role: "owner" }, { transaction });
    return created;
  });
  await collab.change(score.id, (doc) => startContent(doc, title));
  return score.id;
}

/** Not a member, no such score and a deleted score all look the same (docs/spec/security.md, 8). */
function notFound(reply: FastifyReply) {
  return reply.code(404).send({ code: "not_found" });
}

export function registerScores(app: FastifyInstance, { collab, tickets }: { collab: Collab; tickets: CollabTickets }): void {
  app.post("/api/scores", async (request, reply) => {
    const body = createScoreRequest.safeParse(request.body);
    if (!body.success) return invalidRequest(reply, body.error);
    const id = await createScore(collab, request.account!.id, body.data.title);
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
    const member = await membership(request.params.id, request.account!.id);
    if (member === null) return notFound(reply);
    const ticket = await tickets.issue({ scoreId: member.score.id, accountId: request.account!.id, sessionId: request.session!.id, role: member.role });
    return collabTicket.parse({ ticket, role: member.role });
  });
}
