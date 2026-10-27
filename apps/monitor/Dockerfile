# Monitor independente do CÓRTEX. Pensado para rodar em OUTRO provedor/região que a plataforma monitorada.
# Contexto de build = RAIZ do repositório:   docker build -f apps/monitor/Dockerfile -t cortex-monitor .
# Sem dependências de execução (só Node 20+); o estado fica em /data (monte um volume para sobreviver a reinício).
FROM node:20-alpine AS build
WORKDIR /repo
COPY tsconfig.json ./
COPY packages/shared/utils/alert-channels.ts packages/shared/utils/apps-script-relay.ts packages/shared/utils/request-signature.ts packages/shared/utils/
COPY apps/monitor/package.json apps/monitor/tsconfig.json apps/monitor/
COPY apps/monitor/src apps/monitor/src
RUN npm install --no-save --no-audit --no-fund typescript@5 @types/node@20 \
 && cd apps/monitor && npx tsc -p tsconfig.json

FROM node:20-alpine
ENV NODE_ENV=production MONITOR_STATE_DIR=/data MONITOR_CONFIG_FILE=/config/monitor.json
WORKDIR /app
COPY --from=build /repo/apps/monitor/dist ./dist
RUN mkdir -p /data /config && chown -R node:node /data /config
USER node
VOLUME ["/data"]
# saudável = o último ciclo foi há menos de 3 intervalos
HEALTHCHECK --interval=60s --timeout=10s --start-period=60s --retries=3 CMD ["node", "dist/apps/monitor/src/main.js", "--health"]
CMD ["node", "dist/apps/monitor/src/main.js"]
