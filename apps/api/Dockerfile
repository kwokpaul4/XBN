# Multi-stage Dockerfile for the XBN API (Express 5 on Node 22 LTS).
#
# Build once, run in production. The image is deliberately unadorned — no
# process supervisor (Kubernetes / Docker will restart), no NGINX in front
# (put one at the ingress if you want TLS termination). Prisma's engines
# come bundled from the Node modules; we don't attempt to install the
# native pg client separately.

FROM node:22-slim AS base
WORKDIR /workspace
ENV CI=1

# pnpm install ------------------------------------------------------------
FROM base AS install
RUN corepack enable && corepack prepare pnpm@11.7.0 --activate
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/auth/package.json packages/auth/
COPY packages/db/package.json packages/db/
COPY packages/document-core/package.json packages/document-core/
COPY packages/network/package.json packages/network/
COPY packages/shared-types/package.json packages/shared-types/
RUN pnpm install --frozen-lockfile --prefer-offline

# Build -------------------------------------------------------------------
FROM install AS build
COPY . .
RUN pnpm --filter @xbn/db exec prisma generate

# Runtime image -----------------------------------------------------------
FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000

# tsx (used for `pnpm --filter @xbn/api start`) is a dev dep — for prod we
# rely on tsx which is included in the api's devDependencies at install
# time. Simplification: copy the entire workspace so tsx and Prisma engines
# both resolve. This inflates the image but keeps the build reproducible.
COPY --from=build /workspace /app
COPY --from=install /workspace/node_modules /app/node_modules

# Non-root user
RUN groupadd --system --gid 1001 xbn \
 && useradd  --system --uid 1001 --gid xbn xbn \
 && chown -R xbn:xbn /app
USER xbn

EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "--import", "tsx/esm", "apps/api/src/main.ts"]
