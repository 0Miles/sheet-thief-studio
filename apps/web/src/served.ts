// Where the page is served, and the session it shows when the karyl-chan bot serves it
// (docs/spec/karyl-login.md, sections 5 to 7). On its own, the page is served from `/` and its
// session is the cookie. Behind the bot it is served under `/plugin/<key>/`, which the server
// writes into the page's `<base>`; the bot's proxy drops cookies, so the session is a Bearer
// token the page keeps.

/** The path the page is served under, ending in `/`: what its `<base>` says. */
export function basePath(): string {
  return new URL(document.baseURI).pathname.replace(/[^/]*$/, "");
}

/** Whether the karyl-chan bot serves the page: it is not served from the root. */
export function behindBot(): boolean {
  return basePath() !== "/";
}

/** One of the app's own paths (`/api/me`, `/collab`, `/font/`) under where the page is served. */
export function appPath(path: string): string {
  return basePath() + path.replace(/^\/+/, "");
}

/** The full URL of one of the app's own paths, for what needs one (alphaTab's files, a link to copy). */
export function appUrl(path: string): string {
  return new URL(appPath(path), location.href).href;
}

/** One key per place the page is served: another plugin of the same bot keeps its own. */
const sessionKey = () => `studio:session:${basePath()}`;

/** The Bearer token this browser keeps; null when it keeps none, or storage is closed to the page. */
export function bearerToken(): string | null {
  try {
    return localStorage.getItem(sessionKey());
  } catch {
    return null;
  }
}

function keepBearer(sessionId: string): void {
  try {
    localStorage.setItem(sessionKey(), sessionId);
  } catch {
    // A browser that keeps nothing logs in again on the next page load.
  }
}

/** The session is over (logged out, or the server no longer knows it): its token goes. */
export function forgetBearer(): void {
  try {
    localStorage.removeItem(sessionKey());
  } catch {
    // Nothing kept.
  }
}

/** Why a link of the bot logged nobody in, as `/auth/karyl` says it. */
export type KarylFailure = { kind: "unbound"; discordId: string } | { kind: "disabled" | "invalid" | "rate_limited" };

let karylFailure: KarylFailure | null = null;

function failureOf(reason: string): KarylFailure {
  const unbound = /^unbound:([0-9]{17,20})$/.exec(reason);
  if (unbound !== null) return { kind: "unbound", discordId: unbound[1]! };
  return { kind: reason === "disabled" || reason === "rate_limited" ? reason : "invalid" };
}

/**
 * Read what a link of the bot left in the address's fragment: the session it started
 * (`#session=…`), kept as the Bearer token, or why it started none (`#karyl=…`), for /login.
 * Either is taken out of the address at once, before the router reads it, and out of the
 * browser's history.
 */
export function takeLinkResult(): void {
  const fragment = new URLSearchParams(location.hash.slice(1));
  const session = fragment.get("session");
  const failure = fragment.get("karyl");
  if (session === null && failure === null) return;
  if (session !== null && /^[A-Za-z0-9_-]{43}$/.test(session)) keepBearer(session);
  if (failure !== null) karylFailure = failureOf(failure);
  history.replaceState(history.state, "", location.pathname + location.search);
}

/** Why the last link logged nobody in, once: /login says it, then it is gone. */
export function takeKarylFailure(): KarylFailure | null {
  const failure = karylFailure;
  karylFailure = null;
  return failure;
}

/** alphaTab's music font, copied into the build by its Vite plugin. */
export const fontDirectory = (): string => appUrl("/font/");

/** The soundfont the players play with. */
export const soundFontUrl = (): string => appUrl("/soundfont/sonivox.sf3");
