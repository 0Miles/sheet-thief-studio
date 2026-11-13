// The end-to-end tests' own database and Redis database (of compose.dev.yaml, or of CI's service
// containers), and the accounts global-setup.ts creates there before the tests run.

export const SERVER_ENV = {
  DATABASE_URL: "postgres://studio:studio@localhost:5438/studio_e2e",
  REDIS_URL: "redis://localhost:6388/2",
};

export const ADMIN = {
  username: "e2e-admin",
  displayName: "測試管理者",
  password: "e2e admin password",
  isAdmin: true,
  mustChangePassword: false,
};

export const ACCOUNTS = [ADMIN];
