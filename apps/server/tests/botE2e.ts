// The stand-in for the karyl-chan bot, for the end-to-end tests of the plugin (docs/spec/karyl-login.md):
// listens on `PORT`, lets the studio register with `SETUP_SECRET`, and serves it under
// `/plugin/sheet-thief-studio/` as the bot's proxy does: the prefix stripped, the `cookie` header
// dropped, WebSocket upgrades piped both ways. A test asks it for the answer to `/studio` of a
// Discord user with `POST /test/studio { userId }`: the bot signs the dispatch, the plugin mints
// the link's token through it, and the link comes back `{ link }`.
import { generateKeyPairSync, randomBytes, randomUUID, sign as signEd25519 } from "node:crypto";
import { createServer, type IncomingMessage, request as httpRequest, type ServerResponse } from "node:http";
import { connect } from "node:net";

import { generateNonce, sign } from "@karyl-chan/plugin-sdk";

const PLUGIN_KEY = "sheet-thief-studio";
const PREFIX = `/plugin/${PLUGIN_KEY}`;
const port = Number(process.env.PORT ?? 8036);
const setupSecret = process.env.SETUP_SECRET ?? "e2e-setup-secret";
const publicBaseUrl = `http://localhost:${port}${PREFIX}`;
const hmacKey = randomBytes(32).toString("hex");
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const publicPem = publicKey.export({ type: "spki", format: "pem" }).toString();

/** Where the plugin said it is, once it has registered. */
let pluginUrl: URL | null = null;
/** The answers to `/studio` not yet asked for, by interaction token. */
const answered = new Map<string, (content: string) => void>();

async function bodyOf(request: IncomingMessage): Promise<string> {
  let text = "";
  for await (const chunk of request) text += String(chunk);
  return text;
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
}

/** A `plugin-session` token as the bot signs one. */
function pluginSession(userId: string, ttlMs: number): string {
  const segment = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const head = segment({ alg: "EdDSA", typ: "JWT" });
  const body = segment({ purpose: "plugin-session", userId, guildId: null, capabilities: [], iat: now, exp: now + Math.round(ttlMs / 1000) });
  return `${head}.${body}.${signEd25519(null, Buffer.from(`${head}.${body}`), privateKey).toString("base64url")}`;
}

/** The bot's own routes: registering, the plugin's RPC, and the tests' hooks. */
async function botRoute(request: IncomingMessage, response: ServerResponse, path: string): Promise<void> {
  if (request.method === "GET" && path === "/healthz") return json(response, 200, { ok: true });
  if (request.method === "GET" && path === "/test/registered") return json(response, pluginUrl === null ? 503 : 200, { registered: pluginUrl !== null });
  if (request.method !== "POST") return json(response, 404, { error: "not found" });
  const body = await bodyOf(request);
  if (path === "/api/plugins/register") {
    if (request.headers["x-plugin-setup-secret"] !== setupSecret) return json(response, 401, { error: "bad setup secret" });
    pluginUrl = new URL((JSON.parse(body) as { manifest: { plugin: { url: string } } }).manifest.plugin.url);
    return json(response, 200, { plugin: { id: 1, pluginKey: PLUGIN_KEY }, token: "e2e-plugin-token", dispatchHmacKey: hmacKey, sessionVerifyPublicKey: publicPem, publicBaseUrl, heartbeat: { interval_seconds: 30 } });
  }
  if (path === "/api/plugins/heartbeat") return json(response, 200, { ok: true, sessionVerifyPublicKey: publicPem, publicBaseUrl });
  if (path === "/api/plugin/auth.session") {
    const { user_id: userId, ttl_ms: ttlMs = 6 * 3600_000 } = JSON.parse(body) as { user_id: string; ttl_ms?: number };
    return json(response, 200, { allowed: true, token: pluginSession(userId, ttlMs), expiresAt: Date.now() + ttlMs });
  }
  if (path === "/api/plugin/interactions.respond") {
    const { interaction_token: token, content } = JSON.parse(body) as { interaction_token: string; content: string };
    answered.get(token)?.(content);
    return json(response, 200, { ok: true });
  }
  if (path.startsWith("/api/plugin")) return json(response, 200, { ok: true });
  if (path === "/test/studio") {
    if (pluginUrl === null) return json(response, 503, { error: "the plugin has not registered" });
    const { userId } = JSON.parse(body) as { userId: string };
    const interactionToken = randomUUID();
    const answer = new Promise<string>((resolve) => answered.set(interactionToken, resolve));
    const dispatch = JSON.stringify({
      interaction_id: randomUUID(),
      interaction_token: interactionToken,
      application_id: "1",
      command_name: "studio",
      sub_command_name: null,
      sub_command_group: null,
      options: [],
      guild_id: "2",
      channel_id: "3",
      user: { id: userId, username: "e2e" },
    });
    const ts = String(Math.floor(Date.now() / 1000));
    const nonce = generateNonce();
    const sent = await fetch(new URL("/commands/studio", pluginUrl), {
      method: "POST",
      headers: { "content-type": "application/json", "x-karyl-timestamp": ts, "x-karyl-nonce": nonce, "x-karyl-signature": sign(hmacKey, "POST", "/commands/studio", ts, nonce, dispatch) },
      body: dispatch,
    });
    if (sent.status !== 204) return json(response, 502, { error: `the plugin answered the dispatch ${sent.status}` });
    const content = await answer;
    answered.delete(interactionToken);
    const link = /\((http[^)]+)\)/.exec(content)?.[1];
    return link === undefined ? json(response, 502, { error: content }) : json(response, 200, { link });
  }
  return json(response, 404, { error: "not found" });
}

/** The request's headers for the plugin: no cookie (the bot drops it), and the bot as who forwards. */
function forwardedHeaders(request: IncomingMessage): Record<string, string | string[]> {
  const headers: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(request.headers)) if (value !== undefined && name !== "cookie" && name !== "host") headers[name] = value;
  headers["x-forwarded-for"] = request.socket.remoteAddress ?? "127.0.0.1";
  return headers;
}

const server = createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://bot");
  if (url.pathname === PREFIX) {
    response.writeHead(301, { location: `${PREFIX}/` }).end();
    return;
  }
  if (!url.pathname.startsWith(`${PREFIX}/`)) {
    botRoute(request, response, url.pathname).catch((error: unknown) => json(response, 500, { error: String(error) }));
    return;
  }
  if (pluginUrl === null) return json(response, 404, { error: "unknown plugin" });
  const forwarded = httpRequest(
    { host: pluginUrl.hostname, port: pluginUrl.port, method: request.method, path: url.pathname.slice(PREFIX.length) + url.search, headers: forwardedHeaders(request) },
    (answer) => {
      response.writeHead(answer.statusCode ?? 502, answer.headers);
      answer.pipe(response);
    },
  );
  forwarded.on("error", () => {
    // Cut off after its answer began (the page went elsewhere): nothing more to say.
    if (response.headersSent) response.destroy();
    else json(response, 502, { error: "the plugin did not answer" });
  });
  request.pipe(forwarded);
});

server.on("upgrade", (request: IncomingMessage, socket, head: Buffer) => {
  const url = new URL(request.url ?? "/", "http://bot");
  if (pluginUrl === null || !url.pathname.startsWith(`${PREFIX}/`)) {
    socket.end("HTTP/1.1 404 Not Found\r\nconnection: close\r\n\r\n");
    return;
  }
  const upstream = connect(Number(pluginUrl.port), pluginUrl.hostname, () => {
    const headers = Object.entries(forwardedHeaders(request)).flatMap(([name, value]) => (Array.isArray(value) ? value : [value]).map((one) => `${name}: ${one}\r\n`));
    upstream.write(`GET ${url.pathname.slice(PREFIX.length)}${url.search} HTTP/1.1\r\nhost: ${pluginUrl!.host}\r\n${headers.join("")}\r\n`);
    if (head.length > 0) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  const close = () => {
    upstream.destroy();
    socket.destroy();
  };
  upstream.on("error", close);
  socket.on("error", close);
});

// Longer than a test's pause between two calls: Node closes an idle connection after 5 seconds,
// and a client that reuses it just then gets ECONNRESET.
server.keepAliveTimeout = 60_000;
server.headersTimeout = 65_000;
server.listen(port, () => console.log(`a stand-in karyl-chan bot at http://localhost:${port}, serving the plugin under ${PREFIX}/`));
