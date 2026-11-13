// Everything the server reads from its environment, read in one place.

export interface CookieSettings {
  name: string;
  secure: boolean;
}

export interface Config {
  production: boolean;
  host: string;
  port: number;
  databaseUrl: string;
  redisUrl: string;
  /** The origin the web app is served from; requests that change something must come from it. */
  publicOrigin: string;
  sessionCookie: CookieSettings;
}

/**
 * The session cookie (docs/spec/security.md, section 1): `__Host-` prefixed and `Secure`. Over
 * plain http in development and tests, `INSECURE_COOKIES=1` drops both, because WebKit refuses a
 * `__Host-` cookie there; it has no effect in production.
 */
export function sessionCookie(env: NodeJS.ProcessEnv): CookieSettings {
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
    production,
    host: env.HOST ?? "127.0.0.1",
    port: Number(env.PORT ?? 8031),
    databaseUrl: setting("DATABASE_URL", "postgres://studio:studio@localhost:5438/studio"),
    redisUrl: setting("REDIS_URL", "redis://localhost:6388/0"),
    publicOrigin: setting("PUBLIC_ORIGIN", "http://localhost:5183"),
    sessionCookie: sessionCookie(env),
  };
}
