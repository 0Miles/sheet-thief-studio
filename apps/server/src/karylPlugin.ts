// The studio as a karyl-chan plugin (docs/spec/karyl-login.md): it registers with the bot, sends
// its manifest, answers the `/studio` command with a link that logs its person in, and the bot
// serves its pages under `/plugin/<key>/`.
//
// The SDK starts a Fastify server of its own for what the bot dispatches. It listens on the
// loopback only: the bot reaches one address, `PLUGIN_URL`, which is this server, and this server
// hands the SDK's routes to it (`registerKarylDispatch`). The pages, the API and /collab keep
// this server's logger, Origin check and headers.
import { type CommandReply, definePlugin, definePluginCommand, type StartedPlugin } from "@karyl-chan/plugin-sdk";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import type { KarylSettings } from "./config";

declare module "fastify" {
  interface FastifyContextConfig {
    /** A route the bot calls, signed with the plugin's HMAC key instead of sent from our pages: no Origin check. */
    botDispatch?: boolean;
  }
}

export const PLUGIN_KEY = "sheet-thief-studio";
const PLUGIN_VERSION = "0.1.0";

/** The command that hands out a login link. */
export const LOGIN_COMMAND = "studio";

/** How long a link of the command logs in: at least the bot's minimum, a minute (docs/spec/karyl-login.md, section 1). */
export const LINK_TTL_MS = 2 * 60 * 1000;

/** Where the link leads, under the plugin's base: a server route, not a page of the web app. */
export const LOGIN_PATH = "/auth/karyl";

/**
 * What Discord shows of the plugin. The web app's texts live in apps/web/src/strings.ts; these are
 * the bot's, which the server sends (AGENTS.md).
 */
export const DISCORD_TEXT = {
  commandDescription: "取得登入 sheet-thief-studio 的連結",
  link: (url: string) => `[登入 sheet-thief-studio](${url})\n連結 2 分鐘內有效，只能用一次。`,
  unavailable: "現在無法產生登入連結，請稍後再試。",
} as const;

/** What the rest of the server needs of the plugin. */
export interface Karyl {
  /** The bot's public key for `plugin-session` tokens; null until the plugin has registered. */
  sessionVerifyKey(): string | null;
  /** The path the bot serves this plugin's pages under, ending in `/`. */
  basePath(): string;
  /** The SDK's own server, which answers what the bot dispatches; null until it has started. */
  dispatcher(): FastifyInstance | null;
}

export interface KarylPlugin extends Karyl {
  /** Start the SDK's server and register with the bot; registering goes on in the background until the bot answers. */
  start(): Promise<void>;
  stop(): Promise<void>;
}

/** The part of a command's context the login link needs. */
export interface LinkContext {
  userId: string;
  publicBaseUrl?: string;
  auth: { mintSession(args: { userId: string; kind: "session"; ttlMs: number }): Promise<{ allowed: true; token: string } | { allowed: false }> };
}

/**
 * The answer to `/studio`: a link with a `plugin-session` token of the person who asked, only they
 * see it. `fallbackBase` is the plugin's public URL when the bot does not say it (it has no
 * `WEB_BASE_URL`).
 */
export async function loginLink(ctx: LinkContext, fallbackBase: string): Promise<CommandReply> {
  let minted: Awaited<ReturnType<LinkContext["auth"]["mintSession"]>>;
  try {
    minted = await ctx.auth.mintSession({ userId: ctx.userId, kind: "session", ttlMs: LINK_TTL_MS });
  } catch {
    return { content: DISCORD_TEXT.unavailable, ephemeral: true };
  }
  if (!minted.allowed) return { content: DISCORD_TEXT.unavailable, ephemeral: true };
  const base = (ctx.publicBaseUrl ?? fallbackBase).replace(/\/+$/, "");
  return { content: DISCORD_TEXT.link(`${base}${LOGIN_PATH}?token=${encodeURIComponent(minted.token)}`), ephemeral: true };
}

/**
 * The plugin, not started. `publicOrigin` is the bot's public origin (the pages are served from
 * it); with the plugin's key it makes the public URL until the bot tells it.
 */
export function karylPlugin(settings: KarylSettings, publicOrigin: string): KarylPlugin {
  const fallbackBase = `${publicOrigin.replace(/\/+$/, "")}/plugin/${PLUGIN_KEY}`;
  const plugin = definePlugin({
    key: PLUGIN_KEY,
    name: "sheet-thief-studio",
    version: PLUGIN_VERSION,
    description: "團譜的共同編輯",
    pluginCommands: [
      definePluginCommand({
        name: LOGIN_COMMAND,
        description: DISCORD_TEXT.commandDescription,
        // In any server the bot is in; the answer is seen by its person alone. A command of the
        // bot's DMs would have to be a user-installed one.
        scope: "global",
        integrationTypes: ["guild_install"],
        contexts: ["Guild"],
        defaultEphemeral: true,
        handler: (ctx) => loginLink(ctx, fallbackBase),
      }),
    ],
    // The link's token; the rest the SDK adds from the command itself.
    rpcMethodsUsed: ["auth.session"],
  });
  let started: StartedPlugin | null = null;
  return {
    sessionVerifyKey: () => started?.getSessionVerifyPublicKey() ?? null,
    basePath: () => `${new URL(started?.getPublicBaseUrl() ?? fallbackBase).pathname.replace(/\/+$/, "")}/`,
    dispatcher: () => started?.server ?? null,
    async start() {
      // Port 0 on the loopback: nothing but this server's `inject` reaches it. The SDK also
      // stops itself on SIGTERM and SIGINT, then ends the process.
      started = await plugin.start({ port: 0, host: "127.0.0.1", botUrl: settings.botUrl, setupSecret: settings.setupSecret, pluginUrl: settings.pluginUrl });
    },
    async stop() {
      await started?.stop();
      started = null;
    },
  };
}

/** What the bot dispatches to a plugin, and probes: the SDK's routes this plugin has. */
const DISPATCHED: ReadonlyArray<{ method: "GET" | "POST"; url: string }> = [
  { method: "POST", url: "/commands/*" },
  { method: "GET", url: "/health" },
  { method: "GET", url: "/health/*" },
];

/** A dispatch carries an interaction, larger than an API request may be, never close to this. */
const DISPATCH_BODY_LIMIT = 1024 * 1024;

/** The headers the SDK reads of a dispatch: its body's type, and the HMAC signature with its timestamp and nonce. */
function dispatchHeaders(request: FastifyRequest): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(request.headers)) {
    if (typeof value === "string" && (name === "content-type" || name.startsWith("x-karyl-"))) headers[name] = value;
  }
  return headers;
}

/**
 * Hand the bot's dispatches to the SDK's server, the body as it came: the signature is over its
 * bytes. The SDK checks the signature; no Origin check here (no browser sends these).
 */
export function registerKarylDispatch(app: FastifyInstance, karyl: Karyl): void {
  app.register(async (scope) => {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser("*", { parseAs: "string", bodyLimit: DISPATCH_BODY_LIMIT }, (_request, body, done) => done(null, body));
    const forward = async (request: FastifyRequest, reply: FastifyReply) => {
      const target = karyl.dispatcher();
      if (target === null) return reply.code(503).send({ code: "internal_error" });
      const answer = await target.inject({
        method: request.method as "GET" | "POST",
        url: request.url,
        headers: dispatchHeaders(request),
        ...(typeof request.body === "string" ? { payload: request.body } : {}),
      });
      const type = answer.headers["content-type"];
      if (typeof type === "string") reply.type(type);
      return reply.code(answer.statusCode).send(answer.rawPayload);
    };
    for (const { method, url } of DISPATCHED) scope.route({ method, url, config: { botDispatch: true }, handler: forward });
  });
}
