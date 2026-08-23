# syntax=docker/dockerfile:1

FROM node:22-bookworm-slim AS build
WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim
WORKDIR /app

RUN groupadd --system --gid 10001 gateway \
  && useradd --system --uid 10001 --gid gateway --home /app --shell /usr/sbin/nologin gateway \
  && mkdir -p /data \
  && chown gateway:gateway /data

COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist

USER gateway
ENV NODE_ENV=production
EXPOSE 8080
CMD ["node", "dist/server.js"]
