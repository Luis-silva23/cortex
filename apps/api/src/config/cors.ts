/**
 * Resolve as origens CORS liberadas em produção a partir de env
 * (SUPER_ADMIN_URL/WEB_URL) — extraído de index.ts para ser testável sem
 * subir o processo inteiro (index.ts tem efeitos colaterais de import:
 * fila, Redis, scheduler). Ver PRE-PRODUCTION HARDENING (Infraestrutura):
 * antes desta correção, produção usava um domínio placeholder hardcoded
 * ('https://seu-dominio.com'), nunca lido de env — todo tráfego real dos
 * frontends seria bloqueado pelo CORS.
 */
export function resolveProductionCorsOrigins(env: NodeJS.ProcessEnv): string[] {
  // BALCAO_URL: origem do aplicativo Balcão (atendimento), que é um frontend próprio, separado do Admin Web e do PDV.
  return [env.SUPER_ADMIN_URL, env.WEB_URL, env.BALCAO_URL].filter((url): url is string => !!url);
}

/**
 * Origens liberadas em DESENVOLVIMENTO — uma porta por frontend (mapa oficial em docs/CORTEX/VISUAL_REFERENCES.md):
 *   3000 super-admin · 3002 admin-web · 5173 pdv-desktop (Vite/Electron dev) · 5174 balcao (Vite dev).
 * O PDV NÃO estava na lista: para testá-lo no navegador foi preciso servi-lo na porta do admin-web (3002), e dois
 * frontends na mesma porta apareceram como "LN System PDV" onde devia haver o Admin e um 404 em /pos.
 * `DEV_CORS_ORIGINS` (separadas por vírgula) acrescenta origens sem editar o código.
 */
export function resolveDevCorsOrigins(env: NodeJS.ProcessEnv): string[] {
  const base = [3000, 3002, 5173, 5174].flatMap((port) => [`http://localhost:${port}`, `http://127.0.0.1:${port}`]);
  const extra = (env.DEV_CORS_ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
  return Array.from(new Set([...base, ...extra]));
}
