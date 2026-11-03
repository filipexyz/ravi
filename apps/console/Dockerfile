# Build from the monorepo root: docker build -f apps/console/Dockerfile .
ARG NODE_IMAGE=node@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205
ARG BUN_IMAGE=oven/bun@sha256:93d5032fe06d163427822dc1598f420363759bb18155c9cc90eb1be05a64a19e
FROM ${BUN_IMAGE} AS bun
FROM ${NODE_IMAGE} AS dependencies
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /app
COPY package.json bun.lock ./
COPY apps/console/package.json apps/console/package.json
COPY packages/operation-contracts/package.json packages/operation-contracts/package.json
COPY packages/console-sdk/package.json packages/console-sdk/package.json
COPY packages/sdk-codegen/package.json packages/sdk-codegen/package.json
RUN bun install --frozen-lockfile

FROM dependencies AS build
COPY . .
RUN bun run console:sdk:check
WORKDIR /app/apps/console
ARG CONSOLE_ORIGIN
ENV NEXT_TELEMETRY_DISABLED=1 RAVI_SELFHOST_BUILD=1 RAVI_PAGES_AI_ENABLED=0 NODE_OPTIONS=--max-old-space-size=4096 NEXT_PUBLIC_CONSOLE_URL=${CONSOLE_ORIGIN}
RUN DATABASE_URL=postgresql://build:build@127.0.0.1:1/build bun run build && bun run fleet:build

FROM ${NODE_IMAGE} AS runtime
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /app
RUN groupadd --gid 10000 console && useradd --uid 10000 --gid console --create-home console
COPY --from=dependencies --chown=10000:10000 /app/node_modules ./node_modules
COPY --from=build --chown=10000:10000 /app/apps/console/.next/standalone ./
COPY --from=build --chown=10000:10000 /app/apps/console/.next/static ./apps/console/.next/static
COPY --from=build --chown=10000:10000 /app/apps/console/public ./apps/console/public
COPY --from=build --chown=10000:10000 /app/apps/console/.fleet-dist ./apps/console/.fleet-dist
COPY --from=build --chown=10000:10000 /app/apps/console/scripts ./apps/console/scripts
COPY --from=build --chown=10000:10000 /app/apps/console/src ./apps/console/src
COPY --from=build --chown=10000:10000 /app/apps/console/drizzle ./apps/console/drizzle
COPY --from=build --chown=10000:10000 /app/packages/operation-contracts ./packages/operation-contracts
COPY --from=build --chown=10000:10000 /app/apps/console/drizzle.config.ts /app/apps/console/tsconfig.json ./apps/console/
WORKDIR /app/apps/console
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0 PORT=3000 RAVI_PAGES_AI_ENABLED=0
USER 10000:10000
EXPOSE 3000 7443
CMD ["node", "server.js"]
