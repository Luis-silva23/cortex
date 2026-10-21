# syntax=docker/dockerfile:1
#
# LN System Admin Web — multi-stage build usando `output: 'standalone'`
# do Next.js (ver next.config.js) — testado de verdade nesta sessão via
# `npx next build` (sem Docker: confirmado que gera
# .next/standalone/apps/admin-web/server.js). O QUE NÃO FOI TESTADO: o
# `docker build`/`docker run` em si — não há daemon Docker neste ambiente
# de desenvolvimento. BLOCKED BY ENVIRONMENT para validação do container
# completo; precisa rodar num ambiente com Docker real antes do primeiro
# deploy.
#
# Sem pasta `public/` neste app hoje — por isso não há um COPY para ela
# abaixo (copiar um diretório inexistente quebraria o build). Se um
# `public/` for adicionado no futuro, adicionar o COPY correspondente
# (ver comentário no estágio "runtime").

FROM node:20-bookworm-slim AS base
WORKDIR /app

# ---------- deps ----------
FROM base AS deps
COPY package.json package-lock.json ./
COPY apps/admin-web/package.json apps/admin-web/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN npm ci

# ---------- build ----------
FROM deps AS build
COPY apps/admin-web apps/admin-web
COPY packages/shared packages/shared
COPY tsconfig.json tsconfig.json
# packages/shared compila IN-PLACE (.js ao lado do .ts, sem dist/ próprio —
# ver comentário equivalente em apps/api/Dockerfile) — precisa estar
# compilado antes do build do Next.js, que importa @ln-system/shared real.
RUN npm run build --workspace=@ln-system/shared
ENV NEXT_TELEMETRY_DISABLED=1
# NEXT_PUBLIC_* precisa existir NO BUILD (next build embute o valor direto
# no bundle do cliente — não é lido em runtime como uma env var comum).
# Passar via `docker build --build-arg` ou `build.args` no compose; sem
# isso o fallback em lib/api.ts (localhost:3001) é usado, o que só funciona
# se o navegador do usuário conseguir alcançar esse host diretamente.
ARG NEXT_PUBLIC_API_URL
ENV NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL}
RUN npm run build --workspace=@ln-system/admin-web

# ---------- runtime ----------
FROM base AS runtime
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
WORKDIR /app

RUN groupadd -r lnsystem && useradd -r -g lnsystem lnsystem

# `standalone` já inclui só os módulos de node_modules realmente usados —
# não precisa de `npm ci` separado neste estágio.
COPY --from=build --chown=lnsystem:lnsystem /app/apps/admin-web/.next/standalone ./
COPY --from=build --chown=lnsystem:lnsystem /app/apps/admin-web/.next/static ./apps/admin-web/.next/static
# Se um public/ existir no futuro, adicionar:
# COPY --from=build --chown=lnsystem:lnsystem /app/apps/admin-web/public ./apps/admin-web/public

USER lnsystem

EXPOSE 3002
ENV PORT=3002
ENV HOSTNAME=0.0.0.0

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD node -e "require('http').get('http://localhost:3002/login', r => process.exit(r.statusCode < 500 ? 0 : 1)).on('error', () => process.exit(1))"

WORKDIR /app/apps/admin-web
CMD ["node", "server.js"]
