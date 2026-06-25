FROM node:22-slim

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
ENV NODE_ENV="production"
ENV PORT="8787"

WORKDIR /app

RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/protocol/package.json packages/protocol/package.json
COPY apps/relay-server/package.json apps/relay-server/package.json

RUN pnpm install --frozen-lockfile

COPY packages/protocol packages/protocol
COPY apps/relay-server apps/relay-server

RUN pnpm --filter @easycode/protocol build && pnpm --filter @easycode/relay-server build

EXPOSE 8787

CMD ["node", "apps/relay-server/dist/index.js"]
