import { buildApp } from "./app";

const app = buildApp();
const port = Number(process.env.PORT ?? 8031);

app.listen({ port, host: process.env.HOST ?? "127.0.0.1" }).catch((error: unknown) => {
  app.log.error(error);
  process.exit(1);
});
