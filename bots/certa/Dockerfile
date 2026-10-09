# Build from the repository root:
#   docker build -f bots/certa/Dockerfile -t arkhon/certa-bot .
FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY bots/certa/package.json bots/certa/

FROM base AS build
RUN pnpm install --frozen-lockfile --filter "@arkhon/certa-bot..."
COPY packages/shared/src packages/shared/src
COPY packages/shared/tsconfig.json packages/shared/
COPY bots/certa/src bots/certa/src
COPY bots/certa/tsconfig.json bots/certa/
RUN pnpm exec tsc -b bots/certa

FROM base AS runtime
ENV NODE_ENV=production
RUN pnpm install --frozen-lockfile --prod --filter "@arkhon/certa-bot..." && pnpm store prune
COPY --from=build /app/packages/shared/dist packages/shared/dist
COPY --from=build /app/bots/certa/dist bots/certa/dist
RUN mkdir -p /app/data && chown node:node /app/data
USER node
WORKDIR /app/bots/certa
ENV CERTA_DB_PATH=/app/data/certa.sqlite
VOLUME ["/app/data"]
CMD ["node", "dist/index.js"]
