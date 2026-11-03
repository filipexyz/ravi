# Coordinator may override with an approved immutable digest.
ARG BUN_IMAGE=oven/bun:1.3.3-debian
FROM ${BUN_IMAGE} AS dependencies
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

FROM ${BUN_IMAGE}
ENV NODE_ENV=production PLAYWRIGHT_BROWSERS_PATH=/opt/playwright
WORKDIR /app
COPY --from=dependencies /app/node_modules ./node_modules
COPY package.json bun.lock ./
RUN bun node_modules/playwright/cli.js install --with-deps chromium \
 && groupadd --gid 10001 pages \
 && useradd --uid 10001 --gid pages --create-home pages \
 && mkdir -p /var/lib/ravi-pages \
 && chown pages:pages /var/lib/ravi-pages
COPY workers/pages ./workers/pages
USER 10001:10001
EXPOSE 8787
CMD ["bun", "workers/pages/selfhost/server.ts"]
