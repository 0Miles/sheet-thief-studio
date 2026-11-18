// Where the page is served and the session it shows behind the karyl-chan bot
// (docs/spec/karyl-login.md, sections 5 to 7): its `<base>`, the paths of the API, /collab and
// alphaTab's files under it, the Bearer token a link leaves in the address, and why a link
// logged nobody in.
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { ApiError, collabUrl, get } from "../src/api";
import { appPath, appUrl, basePath, bearerToken, behindBot, fontDirectory, forgetBearer, soundFontUrl, takeKarylFailure, takeLinkResult } from "../src/served";

const SESSION = "s".repeat(43);

/** Serve the page under `path`, as the server writes its `<base>`. */
function servedUnder(path: string): void {
  document.head.querySelector("base")?.remove();
  const base = document.createElement("base");
  base.href = path;
  document.head.prepend(base);
}

beforeEach(() => {
  localStorage.clear();
  history.replaceState(null, "", "/");
});

afterEach(() => {
  document.head.querySelector("base")?.remove();
  vi.unstubAllGlobals();
});

test("served from the root: the paths are the app's own, and nothing says the bot serves it", () => {
  servedUnder("/");

  expect([basePath(), behindBot(), appPath("/api/me"), appUrl("/font/")]).toEqual(["/", false, "/api/me", `${location.origin}/font/`]);
});

test("behind the bot: the API, /collab and alphaTab's files are under its base path", () => {
  servedUnder("/plugin/sheet-thief-studio/");

  expect(basePath()).toBe("/plugin/sheet-thief-studio/");
  expect(behindBot()).toBe(true);
  expect(appPath("/api/me")).toBe("/plugin/sheet-thief-studio/api/me");
  expect(collabUrl()).toBe(`ws://${location.host}/plugin/sheet-thief-studio/collab`);
  expect(fontDirectory()).toBe(`${location.origin}/plugin/sheet-thief-studio/font/`);
  expect(soundFontUrl()).toBe(`${location.origin}/plugin/sheet-thief-studio/soundfont/sonivox.sf3`);
});

test("the session a link leaves in the fragment is kept as the Bearer token, and taken out of the address", () => {
  servedUnder("/plugin/sheet-thief-studio/");
  history.replaceState({ kept: 1 }, "", `/plugin/sheet-thief-studio/?a=1#session=${SESSION}`);

  takeLinkResult();

  expect(bearerToken()).toBe(SESSION);
  expect(location.href).toBe(`${location.origin}/plugin/sheet-thief-studio/?a=1`);
  expect(history.state).toEqual({ kept: 1 });
  // Kept for the base path only: another plugin of the same bot has its own.
  servedUnder("/plugin/another/");
  expect(bearerToken()).toBeNull();
});

test("a fragment that is no session id keeps nothing; an address without one is left as it is", () => {
  servedUnder("/plugin/sheet-thief-studio/");
  history.replaceState(null, "", "/plugin/sheet-thief-studio/#session=not-a-session");
  takeLinkResult();
  expect(bearerToken()).toBeNull();

  history.replaceState(null, "", "/plugin/sheet-thief-studio/scores#somewhere");
  takeLinkResult();
  expect(location.hash).toBe("#somewhere");
});

test("why a link logged nobody in is told /login once, and taken out of the address", () => {
  const cases: Array<[string, unknown]> = [
    ["unbound:123456789012345678", { kind: "unbound", discordId: "123456789012345678" }],
    ["disabled", { kind: "disabled" }],
    ["rate_limited", { kind: "rate_limited" }],
    ["invalid", { kind: "invalid" }],
    ["unbound:not-an-id", { kind: "invalid" }],
    ["anything else", { kind: "invalid" }],
  ];
  for (const [reason, failure] of cases) {
    history.replaceState(null, "", `/login#karyl=${encodeURIComponent(reason)}`);
    takeLinkResult();
    expect([reason, location.hash, takeKarylFailure(), takeKarylFailure()]).toEqual([reason, "", failure, null]);
  }
});

test("API calls go under the base path with the Bearer token; one the server no longer knows is forgotten", async () => {
  servedUnder("/plugin/sheet-thief-studio/");
  history.replaceState(null, "", `/plugin/sheet-thief-studio/#session=${SESSION}`);
  takeLinkResult();
  const calls: Array<[string, Record<string, string>]> = [];
  let status = 200;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string, init: RequestInit) => {
      calls.push([path, init.headers as Record<string, string>]);
      return new Response(JSON.stringify(status === 200 ? { ok: true } : { code: "unauthenticated" }), { status });
    }),
  );

  await get("/api/me", { parse: (value) => value });
  status = 401;
  await expect(get("/api/me", { parse: (value) => value })).rejects.toEqual(new ApiError(401, "unauthenticated"));
  await get("/api/me", { parse: (value) => value }).catch(() => undefined);

  expect(calls).toEqual([
    ["/plugin/sheet-thief-studio/api/me", { authorization: `Bearer ${SESSION}` }],
    ["/plugin/sheet-thief-studio/api/me", { authorization: `Bearer ${SESSION}` }],
    // Forgotten: the next call goes without it.
    ["/plugin/sheet-thief-studio/api/me", {}],
  ]);
  expect(bearerToken()).toBeNull();
});

test("on its own the page sends no Bearer token: its session is the cookie", async () => {
  forgetBearer();
  const calls: Array<Record<string, string>> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_path: string, init: RequestInit) => {
      calls.push(init.headers as Record<string, string>);
      return new Response("{}", { status: 200 });
    }),
  );

  await get("/api/me", { parse: (value) => value });

  expect(calls).toEqual([{}]);
});
