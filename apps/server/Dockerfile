# The server's image (docs/DEPLOYMENT.md): the API, /collab and the web app's build, which the
# server serves itself (WEB_ROOT). Built from the repository root:
#
#   docker build -f apps/server/Dockerfile -t sheet-thief-studio-server .
#
# The server runs its TypeScript through tsx, as `pnpm --filter @studio/server start` does; the
# workspace packages it imports export their sources (packages/*/package.json).

# The Node of the CI (.github/workflows/ci.yml). An argument only so that a machine holding another
# Node 22 image can try the build without pulling one.
ARG NODE_IMAGE=node:22-bookworm-slim

FROM ${NODE_IMAGE} AS base
ENV CI=true
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
# The pnpm of package.json's `packageManager`, whatever Node ships with.
RUN npm install --global --no-fund --no-audit "$(node -p "require('./package.json').packageManager")"
# The manifests alone first: the install below is cached until one of them changes.
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/contracts/package.json packages/contracts/
COPY packages/score-editor/package.json packages/score-editor/
COPY packages/score-model/package.json packages/score-model/
COPY packages/score-render/package.json packages/score-render/

# The web app's production build, without VITE_E2E or VITE_MEASURE (docs/spec/testing.md, section 2).
FROM base AS web
RUN pnpm install --frozen-lockfile
COPY packages packages
COPY apps/web apps/web
RUN pnpm --filter @studio/web build \
    && if grep -rq "__studio" apps/web/dist; then echo "apps/web/dist holds a test or measurement hook" >&2; exit 1; fi

# The server, with only the packages it needs. tsx is one of its devDependencies, so they stay.
FROM base AS server
RUN pnpm install --frozen-lockfile --filter "@studio/server..."
COPY packages/contracts packages/contracts
COPY packages/score-model packages/score-model
COPY apps/server apps/server

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8031 \
    WEB_ROOT=/app/apps/web/dist
COPY --from=server /app /app
COPY --from=web /app/apps/web/dist /app/apps/web/dist
# The server's command line (apps/server/src/cli.ts): `studio-cli migrate`,
# `studio-cli create-admin <username> <display name>`.
RUN printf '#!/bin/sh\ncd /app/apps/server && exec node --import tsx src/cliMain.ts "$@"\n' > /usr/local/bin/studio-cli \
    && chmod 755 /usr/local/bin/studio-cli
WORKDIR /app/apps/server
USER node
EXPOSE 8031
# Liveness only, as /healthz says: the process answers, not that Postgres or Redis do.
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=3 \
    CMD ["node", "-e", "fetch('http://127.0.0.1:' + process.env.PORT + '/healthz').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
# One process, not tsx's watcher-and-child: SIGTERM reaches the server itself, which the plugin
# mode's SDK needs to deregister from the bot (docs/spec/karyl-login.md, section 3).
CMD ["node", "--import", "tsx", "src/main.ts"]
