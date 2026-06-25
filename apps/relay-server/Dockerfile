FROM node:22-slim

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
ENV NODE_ENV="production"
ENV PORT="8787"

WORKDIR /app

RUN corepack enable
RUN apt-get update \
  && apt-get install -y --no-install-recommends curl \
  && rm -rf /var/lib/apt/lists/*

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/protocol/package.json packages/protocol/package.json
COPY apps/relay-server/package.json apps/relay-server/package.json

RUN pnpm install --frozen-lockfile

COPY packages/protocol packages/protocol
COPY apps/relay-server apps/relay-server

RUN pnpm --filter @easycode/protocol build && pnpm --filter @easycode/relay-server build

EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD curl -fsS http://localhost:${PORT}/ready || exit 1

CMD ["node", "apps/relay-server/dist/index.js"]
