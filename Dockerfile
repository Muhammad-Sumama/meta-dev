# OpenSAM Studio web app and job worker (one image, two commands).
#
#   docker build -t opensam .
#   docker run -p 3000:3000 -v opensam-data:/data opensam                 # web (jobs in-process by default)
#   docker run -e JOB_BACKEND=redis … opensam npm run worker              # worker
#
# See docker-compose.yml for the full stack (Redis, PostgreSQL, MinIO, SAM 2).

FROM node:22-bookworm-slim AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    DATA_DIR=/data \
    PORT=3000
# The worker runs from TypeScript sources (tsx), so they ship alongside the build.
COPY --from=build --chown=node:node /app /app
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/api/health').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
CMD ["npx", "next", "start"]
