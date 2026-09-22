# Сборка из корня монорепо: docker build -f apps/server/Dockerfile .
# Один образ для двух сервисов Railway: api (node dist/api/index.js) и worker (node dist/worker/index.js)

FROM node:22-bookworm-slim AS build
RUN corepack enable && corepack prepare pnpm@10.33.4 --activate
WORKDIR /app
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages/shared/package.json packages/shared/
COPY apps/server/package.json apps/server/
RUN pnpm install --frozen-lockfile --ignore-scripts
COPY packages/shared packages/shared
COPY apps/server apps/server
RUN pnpm --filter @lakonik/server build && CI=true pnpm install --prod --frozen-lockfile --ignore-scripts

FROM node:22-bookworm-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
  && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
ENV LOG_PRETTY=false
WORKDIR /app
COPY --from=build /app/package.json /app/pnpm-workspace.yaml ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/shared ./packages/shared
COPY --from=build /app/apps/server/package.json ./apps/server/package.json
COPY --from=build /app/apps/server/node_modules ./apps/server/node_modules
COPY --from=build /app/apps/server/dist ./apps/server/dist
COPY --from=build /app/apps/server/drizzle ./apps/server/drizzle
COPY --from=build /app/apps/server/assets ./apps/server/assets
WORKDIR /app/apps/server
EXPOSE 3000
# api: миграции + сид шаблонов при старте, затем сервер. worker переопределяет команду в настройках сервиса Railway.
CMD ["sh", "-c", "node dist/db/migrate.js && node dist/db/seed.js && node dist/api/index.js"]
