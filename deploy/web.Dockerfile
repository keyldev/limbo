# syntax=docker/dockerfile:1
# Образ фронта: лендинг на /, доска на /app/. Собирается из корня репозитория:
#   docker build -f deploy/web.Dockerfile .
# Адрес API не вшивается: клиент ходит на тот же origin (/api), а прокси перед образом
# отправляет /api в API (compose.behind-proxy.yaml).

FROM node:24-slim AS build
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /src
COPY spec/ spec/
COPY web/ web/
WORKDIR /src/web
RUN pnpm install --frozen-lockfile
RUN pnpm build:site

FROM caddy:2-alpine
COPY deploy/web.Caddyfile /etc/caddy/Caddyfile
COPY --from=build /src/web/dist/site /srv
EXPOSE 8080
