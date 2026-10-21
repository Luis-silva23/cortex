# syntax=docker/dockerfile:1
#
# CÓRTEX Balcão — aplicativo de atendimento (estático: Vite/React). O endereço da API é FIXADO NO BUILD (VITE_API_URL): em produção
# precisa ser https:// (o build sem endereço produz um app que se recusa a abrir — falha fechada). Servido por nginx, sem Node em
# runtime. Mesmo padrão dos Dockerfiles de apps/admin-web e apps/super-admin (contexto = raiz do monorepo).
#
# NÃO TESTADO: `docker build`/`docker run` — sem daemon Docker no ambiente de desenvolvimento (BLOQUEADO POR AMBIENTE). O build
# do app em si (`npm run build --workspace=@ln-system/balcao`) foi executado e validado fora do container.

FROM node:20-bookworm-slim AS base
WORKDIR /app

# ---------- deps ----------
FROM base AS deps
COPY package.json package-lock.json ./
COPY apps/balcao/package.json apps/balcao/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN npm ci

# ---------- build ----------
FROM deps AS build
COPY apps/balcao apps/balcao
COPY packages/shared packages/shared
COPY tsconfig.json tsconfig.json
ARG VITE_API_URL
ENV VITE_API_URL=${VITE_API_URL}
RUN npm run build --workspace=@ln-system/balcao

# ---------- runtime ----------
FROM nginx:1.27-alpine AS runtime
# `.template`: a imagem oficial substitui ${API_ORIGIN} na partida (a origem https da API entra no connect-src da CSP).
# Sem o valor, o app ainda abre (connect-src 'self'), mas não conseguiria falar com a API em outra origem.
ENV API_ORIGIN=""
COPY apps/balcao/nginx.conf /etc/nginx/templates/default.conf.template
COPY --from=build /app/apps/balcao/dist /usr/share/nginx/html
EXPOSE 80
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget -qO- http://127.0.0.1/ >/dev/null || exit 1
