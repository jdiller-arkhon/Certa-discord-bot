# syntax=docker/dockerfile:1.7
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

# Litestream copies the SQLite database to S3-compatible storage (R2) where the disk isn't kept,
# e.g. Cloudflare Containers. It stays off unless LITESTREAM_BUCKET is set (see entrypoint.sh).
FROM base AS litestream
ADD --checksum=sha256:eb75a3de5cab03875cdae9f5f539e6aedadd66607003d9b1e7a9077948818ba0 \
  https://github.com/benbjohnson/litestream/releases/download/v0.3.13/litestream-v0.3.13-linux-amd64.tar.gz /tmp/litestream.tar.gz
RUN tar -xzf /tmp/litestream.tar.gz -C /usr/local/bin litestream

FROM base AS runtime
ENV NODE_ENV=production
RUN pnpm install --frozen-lockfile --prod --filter "@arkhon/certa-bot..." && pnpm store prune
COPY --from=build /app/packages/shared/dist packages/shared/dist
COPY --from=build /app/bots/certa/dist bots/certa/dist
COPY --from=litestream /usr/local/bin/litestream /usr/local/bin/litestream
COPY bots/certa/litestream.yml /etc/litestream.yml
COPY --chmod=755 bots/certa/entrypoint.sh /usr/local/bin/certa-bot
RUN mkdir -p /app/data && chown node:node /app/data
USER node
WORKDIR /app/bots/certa
ENV CERTA_DB_PATH=/app/data/certa.sqlite
VOLUME ["/app/data"]
CMD ["certa-bot"]
