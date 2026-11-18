// A stand-in for the recognizer service (docs/spec/recognizer.md, section 3): the same HTTP
// interface, `POST /recognize` taking the images as `multipart/form-data`, answering what the test
// tells it to, the shared contract fixtures by default. The server's tests run it in their own
// process; recognizerE2e.ts runs it for the end-to-end tests.
import { readdirSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { buffer } from "node:stream/consumers";
import { fileURLToPath } from "node:url";

import { type RecognizerResult, recognizerResult } from "@studio/contracts";

const FIXTURES = new URL("../../../services/recognizer/contract/fixtures/", import.meta.url);

/** A contract fixture by its name, the file name without `.json`. */
export function fixture(name: string): unknown {
  return JSON.parse(readFileSync(fileURLToPath(new URL(`${name}.json`, FIXTURES)), "utf8"));
}

/** The names of every fixture. */
export function fixtureNames(): string[] {
  return readdirSync(fileURLToPath(FIXTURES))
    .filter((file) => file.endsWith(".json"))
    .map((file) => file.slice(0, -".json".length));
}

/** Every fixture that is a recognized TAB, by name. */
export function resultFixtures(): Map<string, RecognizerResult> {
  const results = new Map<string, RecognizerResult>();
  for (const name of fixtureNames()) {
    const read = recognizerResult.safeParse(fixture(name));
    if (read.success) results.set(name, read.data);
  }
  return results;
}

/** What the stand-in answers: an HTTP status and a body, as JSON or as it is written in `raw`. */
export interface FakeAnswer {
  status: number;
  body?: unknown;
  raw?: string;
}

/** The answers the real service gives (docs/spec/recognizer.md, section 3), from the fixtures. */
export const answers = {
  /** 200 with a recognized TAB. */
  recognized: (name = "six-strings"): FakeAnswer => ({ status: 200, body: fixture(name) }),
  /** 422 with a failure. */
  failed: (name = "error-pages"): FakeAnswer => ({ status: 422, body: fixture(name) }),
  /** 503: one is already running. */
  busy: (): FakeAnswer => ({ status: 503, body: fixture("error-busy") }),
};

/** An image as the stand-in received it. */
export interface ReceivedImage {
  type: string;
  data: Buffer;
}

export type Answering = FakeAnswer | ((images: ReceivedImage[]) => FakeAnswer | Promise<FakeAnswer>);

export interface FakeRecognizer {
  /** Where the server is to call it: its `RECOGNIZER_URL`. */
  url: string;
  /** The images of each `POST /recognize`, in the order they came. */
  received: ReceivedImage[][];
  /** What to answer from now on; a function may hold its answer back until the test lets it go. */
  answer(answering: Answering): void;
  close(): Promise<void>;
}

async function imagesOf(request: IncomingMessage): Promise<ReceivedImage[]> {
  const form = await new Response(await buffer(request), { headers: { "content-type": request.headers["content-type"] ?? "" } }).formData();
  return Promise.all(
    form.getAll("images").map(async (image) => {
      if (typeof image === "string") throw new Error("an image sent as text");
      return { type: image.type, data: Buffer.from(await image.arrayBuffer()) };
    }),
  );
}

/** Start the stand-in on the loopback, on a free port unless told one; it answers a six-string TAB until told otherwise. */
export async function startFakeRecognizer({ port = 0, answering = answers.recognized() }: { port?: number; answering?: Answering } = {}): Promise<FakeRecognizer> {
  let current = answering;
  const received: ReceivedImage[][] = [];
  const server = createServer((request, response) => {
    const send = ({ status, body, raw }: FakeAnswer) => response.writeHead(status, { "content-type": "application/json" }).end(raw ?? JSON.stringify(body));
    if (request.method === "GET" && request.url === "/healthz") return send({ status: 200, body: { status: "ok" } });
    if (request.method !== "POST" || request.url !== "/recognize") return send({ status: 404, body: {} });
    void imagesOf(request).then(
      async (images) => {
        received.push(images);
        send(typeof current === "function" ? await current(images) : current);
      },
      () => send({ status: 400, body: {} }),
    );
  });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  const { port: bound } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${bound}`,
    received,
    answer: (next) => {
      current = next;
    },
    close: () =>
      new Promise((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
