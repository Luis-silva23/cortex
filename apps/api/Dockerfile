# syntax=docker/dockerfile:1
#
# LN System API — multi-stage build.
#
# HONESTO SOBRE O QUE ISTO É: este Dockerfile foi escrito a partir da
# estrutura REAL do monorepo (verificada diretamente: npm workspaces,
# packages/database compila para dist/, packages/shared compila IN-PLACE —
# .js ao lado do .ts, sem pasta dist própria — e apps/api importa
# `@ln-system/shared/src/...` diretamente, então o pacote compilado precisa
# manter essa mesma estrutura de diretórios). Não existe daemon Docker
# disponível neste ambiente de desenvolvimento para efetivamente construir
# e rodar esta imagem — portanto isto NÃO foi validado com `docker build`
# real. BLOCKED BY ENVIRONMENT para validação local; precisa ser testado
# num ambiente com Docker real (CI ou máquina de desenvolvedor) antes do
# primeiro deploy.
#
# Todo o monorepo é necessário na imagem final por causa do layout de build
# acima (não dá para copiar só "dist" de packages/shared, porque não existe
# um dist isolado para esse pacote) — a imagem não é mínima, mas é correta.

FROM node:20-bookworm-slim AS base
# build-essential + python3: bcrypt (dependência nativa, usado tanto em
# apps/api quanto em packages/database) precisa compilar um binário nativo
# no install — sem isso o `npm ci` falha ao tentar compilar o addon.
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app

# ---------- deps: instala uma vez, workspaces resolvem os symlinks ----------
FROM base AS deps
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY packages/database/package.json packages/database/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN npm ci

# ---------- build: gera Prisma Client e compila os 3 pacotes ----------
FROM deps AS build
COPY apps/api apps/api
COPY packages/database packages/database
COPY packages/shared packages/shared
COPY tsconfig.json tsconfig.json
RUN npx prisma generate --schema=packages/database/prisma/schema.prisma
# Ordem importa: api depende de database e shared (tsconfig "references"),
# nenhum dos dois se compila sozinho a partir do build do api.
RUN npm run build --workspace=@ln-system/shared \
    && npm run build --workspace=@ln-system/database \
    && npm run build --workspace=@ln-system/api

# ---------- runtime: node_modules de produção + artefatos compilados ----------
FROM base AS runtime
ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY packages/database/package.json packages/database/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN npm ci --omit=dev && npm cache clean --force

# Prisma Client gerado (packages/database/node_modules/.prisma ou equivalente)
# depende do generate rodado no estágio de build — copiamos node_modules do
# estágio de build por cima do node_modules de produção recém-instalado,
# só para garantir que o client gerado está presente (mais seguro do que
# tentar re-gerar aqui sem o schema completo já copiado).
COPY --from=build /app/node_modules/.prisma /app/node_modules/.prisma
COPY --from=build /app/packages/database/prisma packages/database/prisma
COPY --from=build /app/packages/database/dist packages/database/dist
COPY --from=build /app/packages/shared packages/shared
COPY --from=build /app/apps/api/dist apps/api/dist

# Usuário não-root — processo Node não deve rodar como root em produção.
RUN groupadd -r lnsystem && useradd -r -g lnsystem lnsystem \
    && chown -R lnsystem:lnsystem /app
USER lnsystem

EXPOSE 3001

# GET /api/health já valida DB+Redis de verdade (não só "processo
# respondeu") — ver apps/api/src/routes/health.routes.ts, montada em
# routes/index.ts:52 sob o prefixo /api (index.ts:127), confirmado nesta
# sessão.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD node -e "require('http').get('http://localhost:3001/api/health', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

WORKDIR /app/apps/api
CMD ["node", "dist/index.js"]
