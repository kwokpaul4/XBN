# Two-stage Dockerfile for the XBN web portal.
#
# Stage 1: build the Vite bundle.
# Stage 2: serve it with a minimal nginx that also proxies /api → the API
#          service. In prod you'd typically front this with an ingress
#          controller; nginx-in-image is the simplest working default for
#          docker-compose deployments.

FROM node:22-slim AS build
WORKDIR /workspace
ENV CI=1
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

COPY . .
RUN pnpm --filter @xbn/web build

# --- runtime ---
FROM nginx:1.27-alpine AS runtime
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /workspace/apps/web/dist /usr/share/nginx/html

EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://localhost:8080/ >/dev/null 2>&1 || exit 1
