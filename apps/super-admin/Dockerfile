# syntax=docker/dockerfile:1
#
# LN System Super Admin — Plataforma Web Super ADM TI. Descoberto e
# auditado nesta sessão (2026-09-15): não era um stub — app real, completo
# (19 rotas: empresas, licenças, dispositivos, backup, audit logs,
# observabilidade com health/integrations/jobs/logs/performance/security),
# de fato integrado à API real (lib/api.ts, refresh-token automático já
# implementado), build+typecheck limpos confirmados nesta sessão. Nenhum
# outro lugar do sistema apontava pra ele — nunca fez parte da infra
# Docker/CI até agora. Mesmo padrão `output: 'standalone'` de
# apps/admin-web/Dockerfile (testado de verdade via `npx next build`,
# confirmado gerando .next/standalone/apps/super-admin/server.js).
#
# NÃO TESTADO: `docker build`/`docker run` em si — sem daemon Docker neste
# ambiente de desenvolvimento. BLOCKED BY ENVIRONMENT para validação do
# container completo, mesma ressalva de apps/api e apps/admin-web.

FROM node:20-bookworm-slim AS base
WORKDIR /app

# ---------- deps ----------
FROM base AS deps
COPY package.json package-lock.json ./
COPY apps/super-admin/package.json apps/super-admin/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN npm ci

# ---------- build ----------
FROM deps AS build
COPY apps/super-admin apps/super-admin
COPY packages/shared packages/shared
COPY tsconfig.json tsconfig.json
RUN npm run build --workspace=@ln-system/shared
ENV NEXT_TELEMETRY_DISABLED=1
ARG NEXT_PUBLIC_API_URL
ENV NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL}
RUN npm run build --workspace=@ln-system/super-admin

# ---------- runtime ----------
FROM base AS runtime
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
WORKDIR /app

RUN groupadd -r lnsystem && useradd -r -g lnsystem lnsystem

COPY --from=build --chown=lnsystem:lnsystem /app/apps/super-admin/.next/standalone ./
COPY --from=build --chown=lnsystem:lnsystem /app/apps/super-admin/.next/static ./apps/super-admin/.next/static

USER lnsystem

EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD node -e "require('http').get('http://localhost:3000/login', r => process.exit(r.statusCode < 500 ? 0 : 1)).on('error', () => process.exit(1))"

WORKDIR /app/apps/super-admin
CMD ["node", "server.js"]
