// What the server's tests share: the real Postgres and Redis of compose.dev.yaml (CI starts
// service containers on the same ports), in databases that belong to the tests only.
import { spawn } from "node:child_process";
import type { AddressInfo } from "node:net";
import { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";

import { HocuspocusProvider, MessageType } from "@hocuspocus/provider";
import { type BarsFragment, jsonBytes, PART_PRESETS } from "@studio/score-model";
import type { FastifyInstance } from "fastify";
import { Redis } from "ioredis";
import * as decoding from "lib0/decoding";
import type { Sequelize } from "sequelize";
import * as Y from "yjs";

import { createAccount } from "../src/accounts";
import { runCli } from "../src/cli";
import { type Config, readConfig } from "../src/config";
import { connectDatabase } from "../src/db/database";
import { migrate, MIGRATIONS_TABLE } from "../src/db/migrate";

export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgres://studio:studio@localhost:5438/studio_test";
export const TEST_REDIS_URL = process.env.TEST_REDIS_URL ?? "redis://localhost:6388/1";

/** A fragment of `bytes` or more of JSON in UTF-8, made of beats whose text is three bytes a character. */
export function fragmentOfAtLeast(bytes: number): BarsFragment {
  const beat = { value: 64 as const, dots: 0 as const, notes: {}, text: "譜".repeat(64) };
  const count = Math.ceil(bytes / jsonBytes(beat));
  return { kind: "fretted", tuning: [...PART_PRESETS.guitar6.tuning], bars: [{ timeSig: { numerator: 4, denominator: 4 }, voices: { "0:0": Array(count).fill(beat) } }] };
}

/** The session cookie of the test config (not the development one). */
export const COOKIE = "__Host-studio_session";

/** The origin the test app is published under; requests that change something send it. */
export const ORIGIN = "http://studio.test";

/**
 * The database of the end-to-end tests, for the scripts that write into it (seedE2e.ts,
 * scoreE2e.ts): `DATABASE_URL`, refused unless it names a database ending in `_e2e` outside
 * production, so that no script can write into a real one.
 */
export function e2eDatabaseUrl(script: string): string {
  const { DATABASE_URL, NODE_ENV } = process.env;
  if (!DATABASE_URL || NODE_ENV === "production" || !new URL(DATABASE_URL).pathname.endsWith("_e2e")) {
    throw new Error(`${script}: DATABASE_URL must name a database ending in _e2e`);
  }
  return DATABASE_URL;
}

/**
 * A connection to this database rebuilt from nothing: every table dropped, migrations included,
 * then migrated. Once per run of the server's tests (tests/globalSetup.ts), and for the
 * end-to-end tests' database (seedE2e.ts).
 */
export async function rebuiltDatabase(url: string): Promise<Sequelize> {
  const sequelize = connectDatabase(url);
  await sequelize.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  await migrate(sequelize);
  return sequelize;
}

/**
 * A connection to the server's tests' database, migrated once for the run (tests/globalSetup.ts),
 * with every row of the previous test files gone: the tables are emptied, not rebuilt. The
 * files run one after another (vitest.config.ts), each emptying it as it starts.
 */
export async function freshDatabase(): Promise<Sequelize> {
  const sequelize = connectDatabase(TEST_DATABASE_URL);
  await sequelize.query(`
    DO $$
    DECLARE tables text;
    BEGIN
      SELECT string_agg(format('%I.%I', schemaname, tablename), ', ') INTO tables
        FROM pg_tables WHERE schemaname = 'public' AND tablename <> ${sequelize.escape(MIGRATIONS_TABLE)};
      IF tables IS NOT NULL THEN
        EXECUTE 'TRUNCATE ' || tables || ' RESTART IDENTITY CASCADE';
      END IF;
    END $$;
  `);
  return sequelize;
}

/**
 * Open the connections of the pool: it opens them as they are needed, and transactions that
 * start together on a pool with one connection open would run almost one after another, so that
 * a test of requests at once would pass without any lock.
 */
export async function warmPool(sequelize: Sequelize): Promise<void> {
  await Promise.all(Array.from({ length: 5 }, () => sequelize.query("SELECT pg_sleep(0.05)")));
}

/** A connection to the emptied test Redis database (the server's tests' own, unless told another). */
export async function freshRedis(url = TEST_REDIS_URL): Promise<Redis> {
  const redis = new Redis(url);
  await redis.flushdb();
  return redis;
}

/** Where no recognizer answers (the discard port): the tests that recognize start a stand-in of their own (fakeRecognizer.ts). */
export const NO_RECOGNIZER = "http://127.0.0.1:9";

export function testConfig(env: NodeJS.ProcessEnv = {}): Config {
  return readConfig({ NODE_ENV: "test", DATABASE_URL: TEST_DATABASE_URL, REDIS_URL: TEST_REDIS_URL, PUBLIC_ORIGIN: ORIGIN, RECOGNIZER_URL: NO_RECOGNIZER, ...env });
}

/** What a run of the CLI ended with: its exit code (null when a signal ended its process) and output. */
export interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/**
 * The environment the CLI gets in the test process: reading anything from it throws. Given a
 * connection, the CLI has no reason to read its environment; one that did would connect to the
 * database the environment names, by default the development one (#116).
 */
const UNREADABLE_ENV: NodeJS.ProcessEnv = new Proxy(
  {},
  {
    get(_target, name) {
      if (typeof name === "symbol") return undefined;
      throw new Error(`the CLI in the test process read ${name} from its environment`);
    },
  },
);

/**
 * Run the CLI in this process, on this connection (the one the models are bound to), with
 * `input` as its stdin; returns its exit code and output. The connection stays open.
 */
export async function cli(sequelize: Sequelize, args: string[], input = ""): Promise<CliResult> {
  const stdout = textCollector();
  const stderr = textCollector();
  const io = { stdin: Readable.from([input]), stdout: stdout.stream, stderr: stderr.stream, env: UNREADABLE_ENV };
  const code = await runCli(args, io, { sequelize });
  return { code, stdout: stdout.text(), stderr: stderr.text() };
}

/** A stream that keeps what is written to it, as text. */
function textCollector(): { stream: Writable; text: () => string } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, done) {
      chunks.push(String(chunk));
      done();
    },
  });
  return { stream, text: () => chunks.join("") };
}

/**
 * Run the CLI as the `cli` script does, in a process of its own, with `input` piped to its
 * stdin; returns its exit code and output. A process takes seconds to start on a busy machine:
 * one test runs it so, the others call `cli` (#116).
 */
export function cliProcess(args: string[], input = ""): Promise<CliResult> {
  const child = spawn(process.execPath, ["--import", "tsx", "src/cliMain.ts", ...args], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL },
  });
  const out: string[] = [];
  const err: string[] = [];
  child.stdout.on("data", (chunk) => out.push(String(chunk)));
  child.stderr.on("data", (chunk) => err.push(String(chunk)));
  child.stdin.end(input);
  return new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout: out.join(""), stderr: err.join("") }));
  });
}

/**
 * Log in as the web app does: a JSON body, from our own origin. `remoteAddress` is who connects
 * (127.0.0.1, the trusted proxy, by default); `forwardedFor` the X-Forwarded-For it sends.
 */
export function login(
  app: FastifyInstance,
  username: string,
  password: string,
  { forwardedFor, ...options }: { remoteAddress?: string; forwardedFor?: string; cookies?: Record<string, string> } = {},
) {
  const headers = forwardedFor === undefined ? { origin: ORIGIN } : { origin: ORIGIN, "x-forwarded-for": forwardedFor };
  return app.inject({ method: "POST", url: "/api/auth/login", headers, payload: { username, password }, ...options });
}

/** The id of a new session of this account, logged in through the API. */
export async function sessionOf(app: FastifyInstance, username: string, password: string): Promise<string> {
  const response = await login(app, username, password);
  if (response.statusCode !== 204) throw new Error(`logging in answered ${response.statusCode} ${response.body}`);
  return sessionCookie(response)!.value;
}

/** The session cookie a response sets, by its name in the test config. */
export function sessionCookie(response: { cookies: Array<{ name: string; value: string }> }, name = COOKIE) {
  return response.cookies.find((cookie) => cookie.name === name);
}

/** Who the session with this id belongs to, as `GET /api/me` answers. */
export function whoAmI(app: FastifyInstance, sessionId: string, name = COOKIE) {
  return app.inject({ method: "GET", url: "/api/me", cookies: { [name]: sessionId } });
}

/** Whether the session is still one: `GET /api/me` answers it. */
export async function isActiveSession(app: FastifyInstance, sessionId: string): Promise<boolean> {
  return (await whoAmI(app, sessionId)).statusCode === 200;
}

/** A call to the API from our own origin, with this session's cookie, or with none for null. */
export function apiCall(app: FastifyInstance, method: "GET" | "POST" | "PATCH" | "DELETE", url: string, session: string | null, payload?: object) {
  return app.inject({ method, url, headers: { origin: ORIGIN }, ...(session === null ? {} : { cookies: { [COOKIE]: session } }), ...(payload === undefined ? {} : { payload }) });
}

/** Accounts that are no admins and need no new password, each named "<username> 的名字"; their ids by username. */
export async function createMembers(usernames: readonly string[], password: string): Promise<Record<string, string>> {
  const ids: Record<string, string> = {};
  for (const username of usernames) ids[username] = (await createAccount({ username, displayName: `${username} 的名字`, password, isAdmin: false, mustChangePassword: false })).id;
  return ids;
}

/** A new score made through the API by the account of this session; returns its id. */
export async function createScore(app: FastifyInstance, sessionId: string, title = "測試團譜"): Promise<string> {
  const response = await app.inject({ method: "POST", url: "/api/scores", headers: { origin: ORIGIN }, cookies: { [COOKIE]: sessionId }, payload: { title } });
  if (response.statusCode !== 201) throw new Error(`creating a score answered ${response.statusCode} ${response.body}`);
  return (response.json() as { id: string }).id;
}

/** Ask for a collab ticket as the web app does. */
export function askTicket(app: FastifyInstance, scoreId: string, sessionId: string) {
  return app.inject({ method: "POST", url: `/api/scores/${scoreId}/collab-ticket`, headers: { origin: ORIGIN }, cookies: { [COOKIE]: sessionId } });
}

/** A collab ticket for this session, or an error when the API refuses one. */
export async function ticketFor(app: FastifyInstance, scoreId: string, sessionId: string): Promise<string> {
  const response = await askTicket(app, scoreId, sessionId);
  if (response.statusCode !== 200) throw new Error(`the ticket was refused: ${response.statusCode} ${response.body}`);
  return (response.json() as { ticket: string }).ticket;
}

/** Listen on a free port of the loopback; returns the URL of /collab there. */
export async function listen(app: FastifyInstance): Promise<string> {
  await app.listen({ port: 0, host: "127.0.0.1" });
  const { port } = app.server.address() as AddressInfo;
  return `ws://127.0.0.1:${port}/collab`;
}

export interface OpenScore {
  provider: HocuspocusProvider;
  doc: Y.Doc;
}

/**
 * Open a score on /collab with a real provider, as the web app does: `token` is a function, asked
 * again at every connection. Resolves once in sync both ways (see `insync`); rejects with the
 * reason when it is refused. `onStateless` hears what the server tells the connection about the
 * document from the start: it does so as the connection is made, before it is in sync.
 */
export function openScore(url: string, scoreId: string, token: () => Promise<string>, onStateless?: (payload: string) => void): Promise<OpenScore> {
  const doc = new Y.Doc();
  return new Promise((resolve, reject) => {
    const provider = new HocuspocusProvider({
      url,
      name: scoreId,
      document: doc,
      token,
      onStateless: ({ payload }) => onStateless?.(payload),
      onAuthenticationFailed: ({ reason }) => {
        provider.destroy();
        reject(new Error(`refused: ${reason}`));
      },
    });
    insync(provider).then(() => resolve({ provider, doc }), reject);
  });
}

/** The answer of the server to the next change the provider sends: true when it applied it. */
export function nextSyncStatus(provider: HocuspocusProvider): Promise<boolean> {
  return new Promise((resolve) => {
    const listener = ({ message }: { message: { decoder: decoding.Decoder } }) => {
      decoding.readVarString(message.decoder); // the document
      if (decoding.readVarUint(message.decoder) !== MessageType.SyncStatus) return;
      provider.off("message", listener);
      resolve(decoding.readVarInt(message.decoder) === 1);
    };
    provider.on("message", listener);
  });
}

/**
 * Resolves when the provider has (re)connected and is in sync both ways: it has the server's
 * state, and the server has answered the state it sent. After that, each answer of the server
 * is about a change made here (`nextSyncStatus`).
 */
export function insync(provider: HocuspocusProvider): Promise<void> {
  const synced = new Promise<void>((resolve) => {
    const listener = () => {
      provider.off("synced", listener);
      resolve();
    };
    provider.on("synced", listener);
  });
  return Promise.all([synced, nextSyncStatus(provider)]).then(() => undefined);
}

/** Resolves with the code of the next close of the provider's socket. */
export function socketClosed(provider: HocuspocusProvider): Promise<number> {
  const socket = provider.configuration.websocketProvider;
  return new Promise((resolve) => {
    const listener = ({ event }: { event: { code: number } }) => {
      socket.off("close", listener);
      resolve(event.code);
    };
    socket.on("close", listener);
  });
}

/** Whether the server has closed this connection's socket since the call. */
export function closes(score: OpenScore): () => boolean {
  let closed = false;
  void socketClosed(score.provider).then(() => {
    closed = true;
  });
  return () => closed;
}
