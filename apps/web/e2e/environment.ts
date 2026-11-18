// The end-to-end tests' own database and Redis database (of compose.dev.yaml, or of CI's service
// containers), the stand-in recognizer the servers call, and the accounts global-setup.ts creates
// there before the tests run.

/**
 * The stand-in for the recognizer service (apps/server/tests/recognizerE2e.ts), on a port of its
 * own: never a real recognizer on 8000. A test picks its answer with `PUT /fixture/<name>`.
 */
export const RECOGNIZER_URL = "http://127.0.0.1:8034";

export const SERVER_ENV = {
  DATABASE_URL: "postgres://studio:studio@localhost:5438/studio_e2e",
  REDIS_URL: "redis://localhost:6388/2",
  RECOGNIZER_URL,
};

export const ADMIN = {
  username: "e2e-admin",
  displayName: "測試管理者",
  password: "e2e admin password",
  isAdmin: true,
  mustChangePassword: false,
};

/** An account that is no member of the scores the admin creates. */
export const OUTSIDER = {
  username: "e2e-ben",
  displayName: "其他帳號",
  password: "e2e member password",
  isAdmin: false,
  mustChangePassword: false,
};

/** Made an Editor of a score by the test that needs one (`seedScore` in pages.ts). */
export const EDITOR = {
  username: "e2e-cara",
  displayName: "編輯者帳號",
  password: "e2e editor password",
  isAdmin: false,
  mustChangePassword: false,
};

/** Made a Viewer of a score by the test that needs one. */
export const VIEWER = {
  username: "e2e-dan",
  displayName: "檢視者帳號",
  password: "e2e viewer password",
  isAdmin: false,
  mustChangePassword: false,
};

export const ACCOUNTS = [ADMIN, OUTSIDER, EDITOR, VIEWER];
