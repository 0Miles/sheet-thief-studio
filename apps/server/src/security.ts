// The headers every answer carries, and the web app's build served by this server in production
// (docs/spec/security.md, sections 6 and 7; docs/spec/routes.md, section 2).
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, realpath, stat } from "node:fs/promises";
import type { Socket } from "node:net";
import { extname, join, resolve, sep } from "node:path";

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { notFound } from "./http";

/**
 * Scripts from our own origin only: that is what stops XSS. Inline styles are allowed because the
 * UI components and alphaTab set styles as they run; alphaTab starts its workers from blob: URLs.
 */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "media-src 'self' blob:",
  "object-src 'none'",
  // The page's own `<base>`, which says where it is served (`registerPages`).
  "base-uri 'self'",
  "frame-ancestors 'none'",
  "form-action 'self'",
].join("; ");

const HEADERS: Record<string, string> = {
  "content-security-policy": CONTENT_SECURITY_POLICY,
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
  "x-robots-tag": "noindex",
};

const HSTS = "max-age=31536000; includeSubDomains";

export interface HeaderSettings {
  hsts: boolean;
}

/** The headers of every answer, whatever it is. */
function securityHeaders({ hsts }: HeaderSettings): Record<string, string> {
  return hsts ? { ...HEADERS, "strict-transport-security": HSTS } : HEADERS;
}

/** The path of a URL as the router matches it: decoded. */
export function routedPath(url: string): string {
  const path = url.split("?", 1)[0]!;
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

/** Whether the path is `prefix` itself or below it. */
function under(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

/**
 * On every answer, the refusals and the errors too: set as the request comes in, before any other
 * hook can answer it. `Cache-Control` is the one of an API answer or of a page; a file of
 * /assets/ gets its own as it is served (`registerPages`). The answers Fastify gives without
 * running any hook get them from `answerFrameworkError` and `answerClientError`.
 */
export function registerSecurityHeaders(app: FastifyInstance, settings: HeaderSettings): void {
  app.addHook("onRequest", async (request, reply) => {
    reply.headers(securityHeaders(settings));
    const path = routedPath(request.url);
    reply.header("cache-control", under(path, "/api") || path === "/healthz" ? "no-store" : "no-cache");
  });
}

/**
 * For Fastify's `frameworkErrors`: a request the router refuses before any hook runs (a URL that
 * cannot be decoded), answered with the headers and in the shape of every other error.
 */
export function answerFrameworkError(settings: HeaderSettings) {
  return (error: { statusCode?: number }, request: FastifyRequest, reply: FastifyReply): void => {
    const status = error.statusCode ?? 500;
    if (status >= 500) request.log.error(error);
    reply
      .code(status)
      .headers(securityHeaders(settings))
      .header("cache-control", "no-store")
      .send({ code: status >= 500 ? "internal_error" : "invalid_request" });
  };
}

/**
 * For Fastify's `clientErrorHandler`: a request Node could not even parse (headers too large, not
 * HTTP, too slow to arrive). No request, no reply: the answer is written on the socket, with the
 * same headers, and the connection closed.
 */
export function answerClientError(settings: HeaderSettings) {
  return (error: Error & { code?: string }, socket: Socket): void => {
    if (error.code === "ECONNRESET" || socket.destroyed) return;
    const status =
      error.code === "ERR_HTTP_REQUEST_TIMEOUT" ? "408 Request Timeout" : error.code === "HPE_HEADER_OVERFLOW" ? "431 Request Header Fields Too Large" : "400 Bad Request";
    const body = JSON.stringify({ code: "invalid_request" });
    const headers = {
      ...securityHeaders(settings),
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
      "content-length": String(Buffer.byteLength(body)),
      connection: "close",
    };
    const lines = Object.entries(headers).map(([name, value]) => `${name}: ${value}\r\n`);
    // Sent whole before the socket goes: destroyed at once, the answer could be lost with it.
    if (!socket.writable) {
      socket.destroy(error);
      return;
    }
    socket.end(`HTTP/1.1 ${status}\r\n${lines.join("")}\r\n${body}`);
    // Not kept open by a client that never closes its side.
    socket.setTimeout(1000, () => socket.destroy());
  };
}

/** What the build of the web app holds; anything else is sent as bytes, which `nosniff` keeps from running. */
const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".eot": "application/vnd.ms-fontobject",
  ".wasm": "application/wasm",
};

const ASSET_CACHE = "public, max-age=31536000, immutable";

interface BuildFile {
  file: string;
  size: number;
  /** Changes whenever the file does: its size and the time it was last written. */
  etag: string;
}

/**
 * The file of the build this path names; null when it names none, or one outside the build:
 * by its spelling, or because a link inside the build leads out of it.
 */
async function fileAt(root: string, path: string): Promise<BuildFile | null> {
  const segments = path.split("/").filter((segment) => segment !== "");
  // No segment that climbs, hides, or means something else to the file system than to the URL.
  if (segments.length === 0 || segments.some((segment) => segment.startsWith(".") || /[\\\0:]/.test(segment))) return null;
  // Where the path really is, every link followed, against where the build really is.
  const realRoot = await realpath(root).catch(() => null);
  if (realRoot === null) return null;
  const file = await realpath(join(realRoot, ...segments)).catch(() => null);
  if (file === null || !file.startsWith(realRoot + sep)) return null;
  const stats = await stat(file).catch(() => null);
  if (!stats?.isFile()) return null;
  return { file, size: stats.size, etag: `W/"${stats.size.toString(16)}-${Math.round(stats.mtimeMs).toString(16)}"` };
}

/** Whether the browser says it already holds the file as it is now (`If-None-Match`). */
function holds(request: FastifyRequest, etag: string): boolean {
  const header = request.headers["if-none-match"];
  if (header === undefined) return false;
  const opaque = (tag: string) => tag.trim().replace(/^W\//, "");
  return header.split(",").some((tag) => tag.trim() === "*" || opaque(tag) === opaque(etag));
}

/** Send the file, or 304 when the browser already holds it: `no-cache` has it ask every time. */
function sendFile(request: FastifyRequest, reply: FastifyReply, found: BuildFile) {
  reply.header("etag", found.etag);
  if (holds(request, found.etag)) return reply.code(304).send();
  return reply
    .type(CONTENT_TYPES[extname(found.file).toLowerCase()] ?? "application/octet-stream")
    .header("content-length", found.size)
    .send(createReadStream(found.file));
}

/** The `<base>` of the build's page, which Vite writes as `/` (apps/web/index.html). */
const BASE_ELEMENT = /<base\s+href="[^"]*"\s*\/?>/i;

/**
 * The page with its `<base>` set to where it is served: `/` on its own, `/plugin/<key>/` behind the
 * karyl-chan bot (docs/spec/karyl-login.md, section 6). Its scripts, the API and /collab are found
 * from there. Without one in the build, it goes first in `<head>`.
 */
function pageUnder(html: string, basePath: string): string {
  const element = `<base href="${basePath.replace(/[&"<>]/g, "")}">`;
  return BASE_ELEMENT.test(html) ? html.replace(BASE_ELEMENT, element) : html.replace(/<head(\s[^>]*)?>/i, (head) => `${head}${element}`);
}

/** Send the page with its `<base>`, or 304 when the browser already holds it as it is now. */
async function sendPage(request: FastifyRequest, reply: FastifyReply, found: BuildFile, basePath: string) {
  const html = pageUnder(await readFile(found.file, "utf8"), basePath);
  const etag = `W/"${createHash("sha256").update(html).digest("base64url").slice(0, 22)}"`;
  reply.header("etag", etag);
  if (holds(request, etag)) return reply.code(304).send();
  return reply.type(CONTENT_TYPES[".html"]!).send(html);
}

/**
 * Serve the build of the web app in `webRoot`: its files, and its page for every other path, which
 * the page's own router then reads (the SPA fallback). Not for the API nor /collab, and not for
 * a path that names a file (its last segment has an extension) the build does not hold: those
 * stay a 404. In development Vite serves the page and this is not registered. `basePath` is
 * where the browser sees the page served, asked at each request: the bot may tell it later.
 */
export function registerPages(app: FastifyInstance, webRoot: string, basePath: () => string = () => "/"): void {
  const root = resolve(webRoot);
  app.get("/*", async (request: FastifyRequest<{ Params: { "*": string } }>, reply: FastifyReply) => {
    // As the router decoded it: `/%61pi/…` is the API too.
    const path = `/${request.params["*"]}`;
    if (under(path, "/api") || under(path, "/collab")) return notFound(reply);
    // The page itself is always served as the page, below.
    if (path !== "/index.html") {
      const found = await fileAt(root, path);
      if (found !== null) {
        // Only the files of /assets/ have the hash of their content in their name.
        if (path.startsWith("/assets/")) reply.header("cache-control", ASSET_CACHE);
        return sendFile(request, reply, found);
      }
      // A file that is not there is missing, not a page: no route of the page ends like a file name.
      if (path.startsWith("/assets/") || /\.[A-Za-z0-9]+$/.test(path)) return notFound(reply);
    }
    const page = await fileAt(root, "/index.html");
    if (page === null) throw new Error(`no index.html in the web build at ${root}`);
    // Served from the root, the page is the build's as it is.
    const base = basePath();
    return base === "/" ? sendFile(request, reply, page) : sendPage(request, reply, page, base);
  });
}
