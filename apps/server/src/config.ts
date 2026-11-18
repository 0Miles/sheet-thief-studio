// Everything the server reads from its environment, read in one place.

export interface CookieSettings {
  name: string;
  secure: boolean;
}

export interface Config {
  host: string;
  port: number;
  databaseUrl: string;
  redisUrl: string;
  /** The origin the web app is served from; requests that change something must come from it. */
  publicOrigin: string;
  /** The addresses of the proxy in front (nginx), whose `X-Forwarded-For` tells the client's IP. */
  trustedProxies: string;
  sessionCookie: CookieSettings;
  /** Whether answers tell the browser to use https only from now on; for a site that is served over https. */
  hsts: boolean;
  /** The directory of the web app's build, which the server then serves; null when something else does (Vite, in development). */
  webRoot: string | null;
  /** The recognizer service on the internal network (docs/spec/recognizer.md, section 3). */
  recognizerUrl: string;
  /** Running as a karyl-chan plugin (docs/spec/karyl-login.md, section 3); null when deployed on its own. */
  karyl: KarylSettings | null;
}

/** How the plugin finds the bot and tells the bot where it is (docs/spec/karyl-login.md, section 3). */
export interface KarylSettings {
  /** The per-plugin setup secret an admin of the bot issued. */
  setupSecret: string;
  /** The bot on the shared Docker network. */
  botUrl: string;
  /** This server as the bot reaches it: where it dispatches commands and proxies the pages to. */
  pluginUrl: string;
}

/**
 * The session cookie (docs/spec/security.md, section 1): `__Host-` prefixed and `Secure`. Over
 * plain http in development and tests, `INSECURE_COOKIES=1` drops both, because WebKit refuses a
 * `__Host-` cookie there; it has no effect in production.
 */
function sessionCookie(env: NodeJS.ProcessEnv): CookieSettings {
  const insecure = env.NODE_ENV !== "production" && env.INSECURE_COOKIES === "1";
  return insecure ? { name: "studio_session", secure: false } : { name: "__Host-studio_session", secure: true };
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const production = env.NODE_ENV === "production";
  // Development falls back to compose.dev.yaml and the Vite dev server; production must say.
  const setting = (name: string, development: string): string => {
    const value = env[name];
    if (value) return value;
    if (production) throw new Error(`${name} must be set in production`);
    return development;
  };
  return {
    host: env.HOST ?? "127.0.0.1",
    port: Number(env.PORT ?? 8031),
    databaseUrl: setting("DATABASE_URL", "postgres://studio:studio@localhost:5438/studio"),
    redisUrl: setting("REDIS_URL", "redis://localhost:6388/0"),
    publicOrigin: setting("PUBLIC_ORIGIN", "http://localhost:5183"),
    trustedProxies: env.TRUSTED_PROXIES ?? "loopback",
    sessionCookie: sessionCookie(env),
    hsts: env.HSTS === "1",
    webRoot: env.WEB_ROOT || null,
    recognizerUrl: setting("RECOGNIZER_URL", "http://127.0.0.1:8000"),
    karyl: karylSettings(env),
  };
}

/**
 * The plugin mode is on when the setup secret is set. The bot's and this server's addresses then
 * have no default in production: a wrong guess would register a plugin the bot cannot reach.
 */
function karylSettings(env: NodeJS.ProcessEnv): KarylSettings | null {
  const setupSecret = env.KARYL_PLUGIN_SETUP_SECRET?.trim();
  if (!setupSecret) return null;
  const production = env.NODE_ENV === "production";
  const address = (name: string, development: string): string => {
    const value = env[name];
    if (value) return value.replace(/\/+$/, "");
    if (production) throw new Error(`${name} must be set in production when KARYL_PLUGIN_SETUP_SECRET is`);
    return development;
  };
  return { setupSecret, botUrl: address("BOT_URL", "http://localhost:3000"), pluginUrl: address("PLUGIN_URL", `http://localhost:${env.PORT ?? 8031}`) };
}
