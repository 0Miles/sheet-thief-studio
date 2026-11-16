// The headers every answer carries, and the web app's build served by this server in production
// (docs/spec/security.md, sections 6 and 7; docs/spec/routes.md, section 2).
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
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
  "base-uri 'none'",
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
 * /assets/ gets its own as it is served (`registerPages`).
 */
export function registerSecurityHeaders(app: FastifyInstance, { hsts }: { hsts: boolean }): void {
  app.addHook("onRequest", async (request, reply) => {
    reply.headers(HEADERS);
    if (hsts) reply.header("strict-transport-security", HSTS);
    const path = routedPath(request.url);
    reply.header("cache-control", under(path, "/api") || path === "/healthz" ? "no-store" : "no-cache");
  });
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

/** The file of the build this path names, with its size; null when it names none, or tries to leave the build. */
async function fileAt(root: string, path: string): Promise<{ file: string; size: number } | null> {
  const segments = path.split("/").filter((segment) => segment !== "");
  // No segment that climbs, hides, or means something else to the file system than to the URL.
  if (segments.length === 0 || segments.some((segment) => segment.startsWith(".") || /[\\\0:]/.test(segment))) return null;
  const file = join(root, ...segments);
  if (!file.startsWith(root + sep)) return null;
  const stats = await stat(file).catch(() => null);
  return stats?.isFile() ? { file, size: stats.size } : null;
}

/**
 * Serve the build of the web app in `webRoot`: its files, and its page for every other path, which
 * the page's own router then reads (the SPA fallback). Not for the API nor /collab: a path there
 * that is no route stays a 404. In development Vite serves the page and this is not registered.
 */
export function registerPages(app: FastifyInstance, webRoot: string): void {
  const root = resolve(webRoot);
  app.get("/*", async (request: FastifyRequest<{ Params: { "*": string } }>, reply: FastifyReply) => {
    // As the router decoded it: `/%61pi/…` is the API too.
    const path = `/${request.params["*"]}`;
    if (under(path, "/api") || under(path, "/collab")) return notFound(reply);
    const found = await fileAt(root, path);
    if (found !== null) {
      // Only the files of /assets/ have the hash of their content in their name.
      if (path.startsWith("/assets/")) reply.header("cache-control", ASSET_CACHE);
      return reply
        .type(CONTENT_TYPES[extname(found.file).toLowerCase()] ?? "application/octet-stream")
        .header("content-length", found.size)
        .send(createReadStream(found.file));
    }
    // A file of the build that is not there is missing, not a page.
    if (path.startsWith("/assets/")) return notFound(reply);
    return reply.type(CONTENT_TYPES[".html"]!).send(await readFile(join(root, "index.html")));
  });
}
