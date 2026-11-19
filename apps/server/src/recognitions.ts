// Recognizing images (docs/spec/recognizer.md, section 7; docs/spec/routes.md, 3.8): an account
// sends the images of a TAB, the server keeps them and calls the recognizer in the background,
// once at a time, and the browser polls until the result is there. The result is a fragment of
// bars the review page opens, then saves as a phrase or discards. Only the account that started a
// recognition reaches it, its images included; to anyone else it does not exist.
import {
  createdRecognition,
  RECOGNITION_RETENTION_DAYS,
  type RecognitionError,
  recognitionDetails,
  recognitionList,
  saveRecognitionRequest,
  savedRecognition,
} from "@studio/contracts";
import { barsFragmentSchema } from "@studio/score-model";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { Op, UniqueConstraintError } from "sequelize";

import { daysAgo, NOW } from "./db/clock";
import { Recognition, RecognitionImage } from "./db/models";
import { invalidFields, invalidRequest, isUuid, notFound } from "./http";
import { FRAGMENT_BODY_LIMIT, MAX_RECOGNITION_IMAGES, RECOGNITION_BODY_LIMIT, RECOGNITION_IMAGE_BYTES, RECOGNITION_IMAGES_BYTES } from "./limits";
import { createPhrase, otherKind, refusedAsTooLarge } from "./phrases";
import { fragmentOfRecognition } from "./recognitionFragment";
import { failure, type ImageMime, LOGGED_ISSUES, type PageImage, recognize } from "./recognizer";

/** What a recognition still running when the server stopped is left with. */
const INTERRUPTED: RecognitionError = failure("interrupted").error;

/** What a recognition is left with when its TAB does not make a fragment, or recording it failed. */
const FAILED: RecognitionError = failure("recognition_failed").error;

/**
 * Delete the recognitions started more than 7 days ago, their images with them; returns how many.
 * By the clock of the database, which also says when each was started. Part of the hourly job
 * (deletion.ts).
 */
export async function purgeExpiredRecognitions(): Promise<number> {
  return Recognition.destroy({ where: { createdAt: { [Op.lt]: daysAgo(RECOGNITION_RETENTION_DAYS) } } });
}

/** The type of an image as the bytes it starts with tell it: PNG, JPEG or WebP, null for anything else. */
function imageType(data: Uint8Array): ImageMime | null {
  const startsWith = (bytes: readonly number[], at = 0) => bytes.every((byte, index) => data[at + index] === byte);
  if (startsWith([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWith([0xff, 0xd8, 0xff])) return "image/jpeg";
  // "RIFF", the size, "WEBP".
  if (startsWith([0x52, 0x49, 0x46, 0x46]) && startsWith([0x57, 0x45, 0x42, 0x50], 8)) return "image/webp";
  return null;
}

function invalidImages(reply: FastifyReply, code: "too_small" | "too_big") {
  return invalidFields(reply, [{ path: ["images"], code }]);
}

function unsupportedImage(reply: FastifyReply, page: number) {
  return reply.code(415).send({ code: "unsupported_image", params: { page } });
}

function tooLarge(reply: FastifyReply) {
  return reply.code(413).send({ code: "payload_too_large" });
}

/**
 * The images of a `multipart/form-data` body, in the order of their pages; an answer already sent
 * when they are not 1 to 15 images of the three types within the limits.
 */
async function imagesOf(body: unknown, contentType: string | undefined, reply: FastifyReply): Promise<PageImage[] | FastifyReply> {
  if (!Buffer.isBuffer(body)) return reply.code(400).send({ code: "invalid_request" });
  let form: FormData;
  try {
    // The body as it is, not a copy of up to 40 MB: Fastify gathers it into a Buffer of its own ArrayBuffer.
    form = await new Response(body as Buffer<ArrayBuffer>, { headers: { "content-type": contentType ?? "" } }).formData();
  } catch {
    return reply.code(400).send({ code: "invalid_request" });
  }
  const files = form.getAll("images");
  if (files.length === 0) return invalidImages(reply, "too_small");
  if (files.length > MAX_RECOGNITION_IMAGES) return invalidImages(reply, "too_big");
  let total = 0;
  for (const [index, file] of files.entries()) {
    if (typeof file === "string") return unsupportedImage(reply, index + 1);
    if (file.size > RECOGNITION_IMAGE_BYTES) return tooLarge(reply);
    total += file.size;
  }
  if (total > RECOGNITION_IMAGES_BYTES) return tooLarge(reply);
  const images: PageImage[] = [];
  for (const [index, file] of (files as File[]).entries()) {
    const data = Buffer.from(await file.arrayBuffer());
    const mime = imageType(data);
    if (mime === null) return unsupportedImage(reply, index + 1);
    images.push({ mime, data });
  }
  return images;
}

/** The account's recognition with this id; null when it has none (someone else's is none too). */
async function ownRecognition(id: string, accountId: string): Promise<Recognition | null> {
  if (!isUuid(id)) return null;
  return Recognition.findOne({ where: { id, accountId } });
}

function summaryOf(recognition: Recognition) {
  return { id: recognition.id, status: recognition.status, pages: recognition.pageCount, createdAt: recognition.createdAt.toISOString() };
}

type IdParams = { Params: { id: string } };

export function registerRecognitions(app: FastifyInstance, { recognizerUrl }: { recognizerUrl: string }): void {
  // The recognizer reads one at a time, and this process is the only one calling it
  // (docs/adr/0001): what stops the call under way, null when there is none.
  let calling: AbortController | null = null;
  // The accounts whose recognition this process has taken on and the recognizer has not answered
  // yet, from the moment it is taken on, before its row is written.
  const accountsCalling = new Set<string>();

  /**
   * Why an account cannot start a recognition now (docs/spec/recognizer.md, section 7): one of
   * its own still running, in the database or still being taken on (409); the recognizer busy with
   * someone else's (503). The account comes first, so that two of its requests at once get 409.
   */
  function refusalOf(accountId: string, recordedRunning: boolean): "recognition_in_progress" | "recognizer_busy" | null {
    if (recordedRunning || accountsCalling.has(accountId)) return "recognition_in_progress";
    if (calling !== null) return "recognizer_busy";
    return null;
  }

  /** Answer the refusal: 503 while the recognizer is someone else's, 409 otherwise. */
  const refuse = (reply: FastifyReply, code: NonNullable<ReturnType<typeof refusalOf>>) => reply.code(code === "recognizer_busy" ? 503 : 409).send({ code });

  const isRunning = async (accountId: string) => (await Recognition.count({ where: { accountId, status: "running" } })) > 0;
  // The recognitions not yet recorded as finished, which the server waits for as it closes.
  const unfinished = new Set<Promise<void>>();

  /**
   * Recognize in the background, then write what came of it; a recognition discarded meanwhile is
   * left alone. `answered` frees the recognizer for the next one as soon as it has answered,
   * before the answer is written: whoever sees this one finished can start another.
   */
  async function run(id: string, images: PageImage[], stop: AbortSignal, answered: () => void): Promise<void> {
    const log = app.log.child({ recognition: id });
    try {
      const recognized = await recognize(recognizerUrl, images, stop, log);
      answered();
      let fields: Partial<Recognition>;
      if (recognized.status === "failed") {
        fields = { status: "failed", error: recognized.error };
      } else {
        const { fragment, report } = fragmentOfRecognition(recognized.result);
        const checked = barsFragmentSchema.safeParse(fragment);
        if (checked.success) {
          fields = { status: "succeeded", fragment: checked.data, report };
        } else {
          log.error({ issues: checked.error.issues.slice(0, LOGGED_ISSUES) }, "the recognized TAB does not make a fragment of bars");
          fields = { status: "failed", error: FAILED };
        }
      }
      await Recognition.update({ ...fields, finishedAt: NOW }, { where: { id, status: "running" } });
    } catch (error) {
      log.error({ error }, "recording what came of a recognition failed");
      await Recognition.update({ status: "failed", error: FAILED, finishedAt: NOW }, { where: { id, status: "running" } }).catch(() => undefined);
    }
  }

  // Encapsulated: only this route reads multipart/form-data, and only it takes bodies this large.
  app.register(async (scope) => {
    scope.addContentTypeParser("multipart/form-data", { parseAs: "buffer", bodyLimit: RECOGNITION_BODY_LIMIT }, (_request, body, done) => done(null, body));
    // Before the body is read: a request that would be refused does not have its 40 MB read first.
    const refuseEarly = async (request: FastifyRequest, reply: FastifyReply) => {
      const accountId = request.account!.id;
      const refused = refusalOf(accountId, await isRunning(accountId));
      if (refused !== null) return refuse(reply, refused);
    };
    scope.post("/api/recognitions", { bodyLimit: RECOGNITION_BODY_LIMIT, preParsing: refuseEarly }, async (request, reply) => {
      const images = await imagesOf(request.body, request.headers["content-type"], reply);
      if (!Array.isArray(images)) return images;
      const accountId = request.account!.id;
      // Asked again: another request may have come meanwhile. From the answer of the database to
      // taking the recognition on, nothing is awaited, so no other request comes in between.
      const refused = refusalOf(accountId, await isRunning(accountId));
      // No record either way.
      if (refused !== null) return refuse(reply, refused);
      const stop = new AbortController();
      calling = stop;
      accountsCalling.add(accountId);
      // Once: called again after the answer is written, it must not let go of a newer one of the account.
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        if (calling === stop) calling = null;
        accountsCalling.delete(accountId);
      };
      let id: string;
      try {
        id = await Recognition.sequelize!.transaction(async (transaction) => {
          const recognition = await Recognition.create({ accountId, status: "running", pageCount: images.length }, { transaction, returning: ["id"] });
          await RecognitionImage.bulkCreate(
            images.map(({ mime, data }, index) => ({ recognitionId: recognition.id, page: index + 1, mime, data })),
            { transaction },
          );
          return recognition.id;
        });
      } catch (error) {
        release();
        // Should two of an account's still pass, the database keeps one running per account.
        if (error instanceof UniqueConstraintError) return reply.code(409).send({ code: "recognition_in_progress" });
        throw error;
      }
      // Not awaited: the browser polls for what comes of it.
      const task = run(id, images, stop.signal, release).finally(() => {
        release();
        unfinished.delete(task);
      });
      unfinished.add(task);
      return reply.code(202).send(createdRecognition.parse({ id }));
    });
  });

  app.get("/api/recognitions", async (request) => {
    const recognitions = await Recognition.findAll({
      where: { accountId: request.account!.id },
      attributes: ["id", "status", "pageCount", "createdAt"],
      order: [
        ["createdAt", "DESC"],
        ["id", "ASC"],
      ],
    });
    return recognitionList.parse({ recognitions: recognitions.map(summaryOf) });
  });

  app.get<IdParams>("/api/recognitions/:id", async (request, reply) => {
    const recognition = await ownRecognition(request.params.id, request.account!.id);
    if (recognition === null) return notFound(reply);
    const { status, error, fragment, report } = recognition;
    const details = status === "succeeded" ? { fragment, report } : status === "failed" ? { error } : {};
    return recognitionDetails.parse({ ...summaryOf(recognition), ...details });
  });

  app.get<{ Params: { id: string; page: string } }>("/api/recognitions/:id/images/:page", async (request, reply) => {
    const { id, page } = request.params;
    if (!isUuid(id) || !/^[1-9]\d{0,2}$/.test(page)) return notFound(reply);
    const image = await RecognitionImage.findOne({
      where: { recognitionId: id, page: Number(page) },
      include: [{ model: Recognition, as: "recognition", where: { accountId: request.account!.id }, attributes: [], required: true }],
    });
    if (image === null) return notFound(reply);
    // Gone once the recognition is saved or discarded: never kept by the browser or anything between.
    return reply.header("content-type", image.mime).header("cache-control", "private, no-store").send(image.data);
  });

  // Saved as a phrase: the fragment the review page sends, edited or not, becomes one of the
  // account's phrases, and the recognition goes with its images, in one transaction.
  app.post<IdParams>("/api/recognitions/:id/save", { bodyLimit: FRAGMENT_BODY_LIMIT }, async (request, reply) => {
    if (refusedAsTooLarge(request.body, reply)) return reply;
    const body = saveRecognitionRequest.safeParse(request.body);
    if (!body.success) return invalidRequest(reply, body.error);
    const { name, fragment } = body.data;
    const accountId = request.account!.id;
    const { id } = request.params;
    if (!isUuid(id)) return notFound(reply);
    // The answer is sent once the transaction is committed, not from inside it: answered
    // before, a read that follows it at once may not find the phrase yet.
    const answer = await Recognition.sequelize!.transaction(async (transaction) => {
      // Locked: a second save of it at once waits, then finds it gone.
      const recognition = await Recognition.findOne({ where: { id, accountId }, attributes: ["id", "status", "fragment"], transaction, lock: transaction.LOCK.UPDATE });
      if (recognition === null) return () => notFound(reply);
      if (recognition.status !== "succeeded") return () => reply.code(409).send({ code: "recognition_not_succeeded" });
      if (recognition.fragment?.kind !== fragment.kind) return () => otherKind(reply);
      const phrase = await createPhrase(accountId, name, fragment, transaction);
      await recognition.destroy({ transaction });
      return () => reply.code(201).send(savedRecognition.parse({ phraseId: phrase.id }));
    });
    return answer();
  });

  app.delete<IdParams>("/api/recognitions/:id", async (request, reply) => {
    if (!isUuid(request.params.id)) return notFound(reply);
    // Its images go with it (ON DELETE CASCADE); one still running is left to finish unrecorded.
    const deleted = await Recognition.destroy({ where: { id: request.params.id, accountId: request.account!.id } });
    if (deleted === 0) return notFound(reply);
    return reply.code(204).send();
  });

  // Whatever was running when the server stopped will never finish (docs/spec/recognizer.md, section 7).
  app.addHook("onReady", async () => {
    // As the hourly job does (deletion.ts), a server that cannot reach the database yet still starts.
    try {
      const [count] = await Recognition.update({ status: "failed", error: INTERRUPTED, finishedAt: NOW }, { where: { status: "running" } });
      if (count > 0) app.log.warn({ count }, "marked as interrupted the recognitions left running");
    } catch (error) {
      app.log.error({ error }, "marking as interrupted the recognitions left running failed");
    }
  });
  // Before the database closes: the one under way is interrupted and recorded so.
  app.addHook("preClose", async () => {
    calling?.abort();
    await Promise.all(unfinished);
  });
}
