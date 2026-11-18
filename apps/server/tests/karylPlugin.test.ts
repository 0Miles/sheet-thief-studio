// The studio as a karyl-chan plugin (docs/spec/karyl-login.md, sections 1 and 3): it registers
// with a stand-in for the bot, the bot's signed `/studio` dispatch reaches the SDK through this
// server, and the link it answers with logs in.
import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";

import { generateNonce, sign } from "@karyl-chan/plugin-sdk";
import Fastify, { type FastifyInstance } from "fastify";
import type { Redis } from "ioredis";
import type { Sequelize } from "sequelize";
import { afterAll, beforeAll, expect, test, vi } from "vitest";

import { createAccount } from "../src/accounts";
import { buildApp } from "../src/app";
import { Identity } from "../src/db/models";
import { DISCORD_TEXT, karylPlugin, type KarylPlugin, LINK_TTL_MS, loginLink, PLUGIN_KEY } from "../src/karylPlugin";
import { pluginSession, signingAuthority } from "./karyl";
import { freshDatabase, freshRedis, testConfig } from "./support";

const SETUP_SECRET = "setup-secret-of-the-test";
const HMAC_KEY = randomBytes(32).toString("hex");
const PUBLIC_BASE_URL = `https://bot.test/plugin/${PLUGIN_KEY}`;
const DISCORD_ID = "345678901234567890";
const authority = signingAuthority();

interface Received {
  manifest?: { commands?: unknown; plugin_commands?: Array<{ name: string }>; rpc_methods_used?: string[]; rpcMethodsUsed?: string[] };
  minted: Array<Record<string, unknown>>;
  responded: Array<{ interaction_token: string; content?: string; ephemeral?: boolean }>;
}

let sequelize: Sequelize;
let redis: Redis;
let bot: FastifyInstance;
let plugin: KarylPlugin;
let app: FastifyInstance;
const received: Received = { minted: [], responded: [] };

/** The bot's side of registering and of the RPC the plugin calls; nothing else. */
function standInBot(): FastifyInstance {
  const server = Fastify({ logger: false });
  server.post("/api/plugins/register", async (request, reply) => {
    if (request.headers["x-plugin-setup-secret"] !== SETUP_SECRET) return reply.code(401).send({ error: "bad secret" });
    received.manifest = (request.body as { manifest: Received["manifest"] }).manifest;
    return {
      plugin: { id: 1, pluginKey: PLUGIN_KEY },
      token: "plugin-token",
      dispatchHmacKey: HMAC_KEY,
      sessionVerifyPublicKey: authority.publicPem,
      publicBaseUrl: PUBLIC_BASE_URL,
      heartbeat: { path: "/api/plugins/heartbeat", interval_seconds: 30 },
    };
  });
  server.post("/api/plugins/heartbeat", async () => ({ ok: true, sessionVerifyPublicKey: authority.publicPem, publicBaseUrl: PUBLIC_BASE_URL }));
  server.post("/api/plugins/deregister", async () => ({ ok: true }));
  server.post("/api/plugin/auth.session", async (request) => {
    const body = request.body as { user_id: string };
    received.minted.push(body as Record<string, unknown>);
    return { allowed: true, token: pluginSession(authority.privateKey, body.user_id), expiresAt: Date.now() + LINK_TTL_MS };
  });
  server.post("/api/plugin/interactions.respond", async (request) => {
    received.responded.push(request.body as Received["responded"][number]);
    return { ok: true };
  });
  // Metrics and logs the SDK pushes on its own.
  server.post("/api/plugin/*", async () => ({ ok: true }));
  return server;
}

beforeAll(async () => {
  sequelize = await freshDatabase();
  redis = await freshRedis();
  bot = standInBot();
  await bot.listen({ port: 0, host: "127.0.0.1" });
  const botUrl = `http://127.0.0.1:${(bot.server.address() as AddressInfo).port}`;
  plugin = karylPlugin({ setupSecret: SETUP_SECRET, botUrl, pluginUrl: "http://studio.internal:8031" }, "https://bot.test");
  app = buildApp({ config: testConfig(), redis, logger: false, karyl: plugin });
  await plugin.start();
  // Registering goes on in the background.
  await vi.waitFor(() => expect(plugin.sessionVerifyKey()).toBe(authority.publicPem), { timeout: 10_000 });
});

afterAll(async () => {
  await app?.close();
  await plugin?.stop();
  await bot?.close();
  await redis.quit();
  await sequelize.close();
});

/** A dispatch of `/studio` as the bot signs it, sent to this server. */
function dispatch(body: string, signature?: string) {
  const ts = String(Math.floor(Date.now() / 1000));
  const nonce = generateNonce();
  const path = "/commands/studio";
  return app.inject({
    method: "POST",
    url: path,
    headers: {
      "content-type": "application/json",
      "x-karyl-timestamp": ts,
      "x-karyl-nonce": nonce,
      "x-karyl-signature": signature ?? sign(HMAC_KEY, "POST", path, ts, nonce, body),
    },
    payload: body,
  });
}

const command = (interactionToken: string) =>
  JSON.stringify({
    interaction_id: "1",
    interaction_token: interactionToken,
    application_id: "2",
    command_name: "studio",
    sub_command_name: null,
    sub_command_group: null,
    options: [],
    guild_id: null,
    channel_id: null,
    user: { id: DISCORD_ID, username: "someone" },
  });

test("the plugin registers with its manifest: the /studio command, and the scope that mints the link's token", () => {
  const manifest = JSON.stringify(received.manifest);
  expect(manifest).toContain('"studio"');
  expect(manifest).toContain('"auth.session"');
  expect(plugin.basePath()).toBe(`/plugin/${PLUGIN_KEY}/`);
});

test("/studio, signed by the bot, answers its person alone with a link that logs in to the bound account", async () => {
  const { id } = await createAccount({ username: "from-discord", displayName: "從 Discord 來", password: "a password long enough", isAdmin: false, mustChangePassword: false });
  await Identity.create({ accountId: id, provider: "karyl-chan", subject: DISCORD_ID });

  // No Origin: the bot is no browser, and the signature stands for it.
  const answer = await dispatch(command("interaction-1"));

  expect(answer.statusCode).toBe(204);
  await vi.waitFor(() => expect(received.responded).toHaveLength(1));
  expect(received.minted).toEqual([{ user_id: DISCORD_ID, kind: "session", ttl_ms: LINK_TTL_MS }]);
  const [reply] = received.responded;
  expect(reply).toMatchObject({ interaction_token: "interaction-1", ephemeral: true });
  const link = new URL(/\((https:[^)]+)\)/.exec(reply!.content!)![1]!);
  expect(`${link.origin}${link.pathname}`).toBe(`${PUBLIC_BASE_URL}/auth/karyl`);
  // As the bot's proxy forwards it: without its prefix.
  const opened = await app.inject({ method: "GET", url: `/auth/karyl${link.search}` });
  const sessionId = /^\.\.\/#session=(.+)$/.exec(String(opened.headers.location))![1];
  const me = await app.inject({ method: "GET", url: "/api/me", headers: { authorization: `Bearer ${sessionId}` } });
  expect([me.statusCode, me.json().username]).toEqual([200, "from-discord"]);
});

test("a dispatch the bot did not sign is refused by the SDK", async () => {
  const answer = await dispatch(command("interaction-2"), "0".repeat(64));

  expect(answer.statusCode).toBe(401);
});

test("the bot's health probes reach the SDK through this server", async () => {
  const ready = await app.inject({ method: "GET", url: "/health/ready" });

  expect(ready.statusCode).toBe(200);
});

test("the link: the bot's public URL, else the plugin's under the bot's origin; no link when the bot will not mint one", async () => {
  const minted = { mintSession: async () => ({ allowed: true as const, token: "a.b.c" }) };

  expect(await loginLink({ userId: DISCORD_ID, publicBaseUrl: "https://bot.example/plugin/sheet-thief-studio/", auth: minted }, "https://unused")).toEqual({
    content: DISCORD_TEXT.link("https://bot.example/plugin/sheet-thief-studio/auth/karyl?token=a.b.c"),
    ephemeral: true,
  });
  expect(await loginLink({ userId: DISCORD_ID, auth: minted }, "https://bot.example/plugin/sheet-thief-studio")).toMatchObject({
    content: DISCORD_TEXT.link("https://bot.example/plugin/sheet-thief-studio/auth/karyl?token=a.b.c"),
  });
  const refused = { mintSession: async () => ({ allowed: false as const }) };
  const failing = {
    mintSession: async (): Promise<{ allowed: false }> => {
      throw new Error("bot unreachable");
    },
  };
  for (const auth of [refused, failing]) expect(await loginLink({ userId: DISCORD_ID, auth }, "https://unused")).toEqual({ content: DISCORD_TEXT.unavailable, ephemeral: true });
});
