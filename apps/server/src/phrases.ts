// Each account's phrase library (docs/spec/routes.md, 3.7; docs/spec/phrases.md, sections 4 and
// 5.1): listing, creating, reading, saving, renaming, copying and deleting my phrases. Only their
// owner reaches them; to anyone else they do not exist.
import {
  type BarsFragment,
  createdPhrase,
  createPhraseRequest,
  duplicatedPhrase,
  phraseDetails,
  phraseLimits,
  phraseList,
  phraseQuery,
  phraseRevision,
  renamePhraseRequest,
  savePhraseRequest,
} from "@studio/contracts";
import { jsonBytes } from "@studio/score-model";
import type { FastifyInstance, FastifyReply } from "fastify";
import { literal, Op, type Transaction, type WhereOptions } from "sequelize";

import { Phrase } from "./db/models";
import { invalidFields, invalidRequest, isUuid, notFound } from "./http";
import { FRAGMENT_BODY_LIMIT, MAX_FRAGMENT_BYTES } from "./limits";

/** What the name of a copy ends with. */
const COPY = "（副本）";

/** The counts kept beside a phrase's content, for the lists and the phrase sidebar. */
function countsOf(fragment: BarsFragment): Pick<Phrase, "kind" | "stringCount" | "staffCount" | "barCount"> {
  return {
    kind: fragment.kind,
    stringCount: fragment.kind === "fretted" ? fragment.tuning.length : null,
    staffCount: fragment.kind === "pitched" ? fragment.staves.length : null,
    barCount: fragment.bars.length,
  };
}

/**
 * A new phrase of the account, at its first revision; its id. Within `transaction` when given (a
 * recognition saved as a phrase is deleted in the same one).
 */
export async function createPhrase(ownerId: string, name: string, fragment: BarsFragment, transaction?: Transaction): Promise<{ id: string; revision: number }> {
  // Not the content back: it is what was just sent.
  const phrase = await Phrase.create({ ownerId, name, content: fragment, revision: 1, ...countsOf(fragment) }, { returning: ["id", "revision"], transaction });
  return { id: phrase.id, revision: phrase.revision };
}

/** Answer 413 `phrase_too_large` to a body whose fragment takes more than 1 MB; true when it did. */
export function refusedAsTooLarge(body: unknown, reply: FastifyReply): boolean {
  const fragment = typeof body === "object" && body !== null ? (body as { fragment?: unknown }).fragment : undefined;
  if (fragment === undefined || jsonBytes(fragment) <= MAX_FRAGMENT_BYTES) return false;
  void reply.code(413).send({ code: "phrase_too_large" });
  return true;
}

/** 400: a fragment of another kind than what it is to be written over or made from; a kind never changes (docs/spec/phrases.md, section 5). */
export function otherKind(reply: FastifyReply) {
  return invalidFields(reply, [{ path: ["fragment", "kind"], code: "custom" }]);
}

/** The name of a copy: the name and 「（副本）」, the name cut short when both would not fit. */
function copyName(name: string): string {
  let kept = name.slice(0, phraseLimits.name.max - COPY.length);
  // Not half of a character that takes two code units.
  if (/[\uD800-\uDBFF]$/.test(kept)) kept = kept.slice(0, -1);
  return kept + COPY;
}

/** Escape what LIKE reads as wildcards, so that a search finds the text as typed. */
function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, "\\$&");
}

/** The account's phrase with this id; null when it has none (someone else's is none too). */
async function ownPhrase(id: string, ownerId: string): Promise<Phrase | null> {
  if (!isUuid(id)) return null;
  return Phrase.findOne({ where: { id, ownerId } });
}

/** What a write names: the account's phrase, the revision it was made from, and the kind its content is of when it writes content. */
interface WriteTarget {
  id: string;
  ownerId: string;
  baseRevision: number;
  kind?: Phrase["kind"];
}

/**
 * Write over the account's phrase, made from `baseRevision`, counting one more revision. Answers
 * the new revision; 400 when the content is of another kind than the phrase (a phrase's kind
 * never changes, docs/spec/phrases.md section 5); 409 `revision_conflict` when the phrase is at
 * another revision; 404.
 */
async function writePhrase(reply: FastifyReply, { id, ownerId, baseRevision, kind }: WriteTarget, fields: Partial<Phrase>) {
  if (!isUuid(id)) return notFound(reply);
  // One statement, so that two writes made from the same revision cannot both pass.
  const where = { id, ownerId, revision: baseRevision, ...(kind === undefined ? {} : { kind }) };
  const [written, rows] = await Phrase.update({ ...fields, revision: literal("revision + 1") as unknown as number }, { where, returning: ["revision"] });
  if (written === 1) return phraseRevision.parse({ revision: rows[0]!.revision });
  const phrase = await Phrase.findOne({ where: { id, ownerId }, attributes: ["kind"] });
  if (phrase === null) return notFound(reply);
  if (kind !== undefined && phrase.kind !== kind) return otherKind(reply);
  return reply.code(409).send({ code: "revision_conflict" });
}

export function registerPhrases(app: FastifyInstance): void {
  app.get("/api/phrases", async (request, reply) => {
    const query = phraseQuery.safeParse(request.query);
    if (!query.success) return invalidRequest(reply, query.error);
    const { kind, q = "" } = query.data;
    const where: WhereOptions<Phrase> = { ownerId: request.account!.id };
    if (kind !== undefined) where.kind = kind;
    if (q.trim() !== "") where.name = { [Op.iLike]: `%${escapeLike(q.trim())}%` };
    const phrases = await Phrase.findAll({
      where,
      // Not the content: the list never shows it, and it is the largest column.
      attributes: { exclude: ["content"] },
      order: [
        ["updatedAt", "DESC"],
        ["id", "ASC"],
      ],
    });
    return phraseList.parse({ phrases: phrases.map((phrase) => ({ ...phrase.get({ plain: true }), updatedAt: phrase.updatedAt.toISOString() })) });
  });

  app.post("/api/phrases", { bodyLimit: FRAGMENT_BODY_LIMIT }, async (request, reply) => {
    if (refusedAsTooLarge(request.body, reply)) return reply;
    const body = createPhraseRequest.safeParse(request.body);
    if (!body.success) return invalidRequest(reply, body.error);
    const { name, fragment } = body.data;
    return reply.code(201).send(createdPhrase.parse(await createPhrase(request.account!.id, name, fragment)));
  });

  app.get<{ Params: { id: string } }>("/api/phrases/:id", async (request, reply) => {
    const phrase = await ownPhrase(request.params.id, request.account!.id);
    if (phrase === null) return notFound(reply);
    return phraseDetails.parse({ id: phrase.id, name: phrase.name, fragment: phrase.content, revision: phrase.revision, updatedAt: phrase.updatedAt.toISOString() });
  });

  app.put<{ Params: { id: string } }>("/api/phrases/:id", { bodyLimit: FRAGMENT_BODY_LIMIT }, async (request, reply) => {
    if (refusedAsTooLarge(request.body, reply)) return reply;
    const body = savePhraseRequest.safeParse(request.body);
    if (!body.success) return invalidRequest(reply, body.error);
    const { fragment, baseRevision } = body.data;
    return writePhrase(reply, { id: request.params.id, ownerId: request.account!.id, baseRevision, kind: fragment.kind }, { content: fragment, ...countsOf(fragment) });
  });

  app.patch<{ Params: { id: string } }>("/api/phrases/:id", async (request, reply) => {
    const body = renamePhraseRequest.safeParse(request.body);
    if (!body.success) return invalidRequest(reply, body.error);
    const { name, baseRevision } = body.data;
    return writePhrase(reply, { id: request.params.id, ownerId: request.account!.id, baseRevision }, { name });
  });

  app.post<{ Params: { id: string } }>("/api/phrases/:id/duplicate", async (request, reply) => {
    const phrase = await ownPhrase(request.params.id, request.account!.id);
    if (phrase === null) return notFound(reply);
    const { ownerId, content } = phrase;
    const copy = await Phrase.create({ ownerId, name: copyName(phrase.name), content, revision: 1, ...countsOf(content) }, { returning: ["id"] });
    return reply.code(201).send(duplicatedPhrase.parse({ id: copy.id }));
  });

  app.delete<{ Params: { id: string } }>("/api/phrases/:id", async (request, reply) => {
    if (!isUuid(request.params.id)) return notFound(reply);
    const deleted = await Phrase.destroy({ where: { id: request.params.id, ownerId: request.account!.id } });
    if (deleted === 0) return notFound(reply);
    return reply.code(204).send();
  });
}
