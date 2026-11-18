// Recognizing images (docs/spec/recognizer.md, section 7; docs/spec/routes.md, 3.8): an account
// sends the images of a TAB, the server keeps them and calls the recognizer in the background,
// once at a time, and the browser polls until the result is there. The result is a fragment of
// bars the review page opens; saving it as a phrase is #64. Only the account that started a
// recognition reaches it, its images included; to anyone else it does not exist.
import {
  createdRecognition,
  RECOGNITION_RETENTION_DAYS,
  type RecognitionError,
  recognitionDetails,
  recognitionLimits,
  recognitionList,
} from "@studio/contracts";
import { barsFragmentSchema } from "@studio/score-model";
import type { FastifyInstance, FastifyReply } from "fastify";
import { literal, Op, UniqueConstraintError } from "sequelize";

import { Recognition, RecognitionImage } from "./db/models";
import { isUuid, notFound } from "./http";
import { RECOGNITION_BODY_LIMIT, RECOGNITION_IMAGE_BYTES, RECOGNITION_IMAGES_BYTES } from "./limits";
import { fragmentOfRecognition } from "./recognitionFragment";
import { failure, type PageImage, recognize } from "./recognizer";

/** The clock of the database, as a value of a date column. */
const NOW = literal("now()") as unknown as Date;

/** What a recognition still running when the server stopped is left with. */
const INTERRUPTED: RecognitionError = failure("interrupted").error;

/**
 * Delete the recognitions started more than 7 days ago, their images with them; returns how many.
 * By the clock of the database, which also says when each was started. Part of the hourly job
 * (deletion.ts).
 */
export async function purgeExpiredRecognitions(): Promise<number> {
  return Recognition.destroy({ where: { createdAt: { [Op.lt]: literal(`now() - make_interval(days => ${RECOGNITION_RETENTION_DAYS})`) } } });
}

/** The type of an image as the bytes it starts with tell it: PNG, JPEG or WebP, null for anything else. */
export function imageType(data: Uint8Array): string | null {
  const startsWith = (bytes: readonly number[], at = 0) => bytes.every((byte, index) => data[at + index] === byte);
  if (startsWith([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWith([0xff, 0xd8, 0xff])) return "image/jpeg";
  // "RIFF", the size, "WEBP".
  if (startsWith([0x52, 0x49, 0x46, 0x46]) && startsWith([0x57, 0x45, 0x42, 0x50], 8)) return "image/webp";
  return null;
}

function invalidImages(reply: FastifyReply, code: "too_small" | "too_big") {
  return reply.code(400).send({ code: "invalid_request", params: { issues: [{ path: ["images"], code }] } });
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
    form = await new Response(new Uint8Array(body), { headers: { "content-type": contentType ?? "" } }).formData();
  } catch {
    return reply.code(400).send({ code: "invalid_request" });
  }
  const files = form.getAll("images");
  if (files.length < recognitionLimits.images.min) return invalidImages(reply, "too_small");
  if (files.length > recognitionLimits.images.max) return invalidImages(reply, "too_big");
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
          log.error({ issues: checked.error.issues.slice(0, 20) }, "the recognized TAB does not make a fragment of bars");
          fields = { status: "failed", error: failure("recognition_failed").error };
        }
      }
      await Recognition.update({ ...fields, finishedAt: NOW }, { where: { id, status: "running" } });
    } catch (error) {
      log.error({ error }, "recording what came of a recognition failed");
      await Recognition.update({ status: "failed", error: failure("recognition_failed").error, finishedAt: NOW }, { where: { id, status: "running" } }).catch(() => undefined);
    }
  }

  // Encapsulated: only this route reads multipart/form-data, and only it takes bodies this large.
  app.register(async (scope) => {
    scope.addContentTypeParser("multipart/form-data", { parseAs: "buffer", bodyLimit: RECOGNITION_BODY_LIMIT }, (_request, body, done) => done(null, body));
    scope.post("/api/recognitions", { bodyLimit: RECOGNITION_BODY_LIMIT }, async (request, reply) => {
      const images = await imagesOf(request.body, request.headers["content-type"], reply);
      if (!Array.isArray(images)) return images;
      const accountId = request.account!.id;
      if ((await Recognition.count({ where: { accountId, status: "running" } })) > 0) return reply.code(409).send({ code: "recognition_in_progress" });
      // No record: another account's is under way.
      if (calling !== null) return reply.code(503).send({ code: "recognizer_busy" });
      // Taken before anything is awaited, so that no other request takes it meanwhile.
      const stop = new AbortController();
      calling = stop;
      const release = () => {
        if (calling === stop) calling = null;
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
        // The same account, at the same moment: the database keeps one running per account.
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
