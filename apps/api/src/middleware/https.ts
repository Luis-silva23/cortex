import { Request, Response, NextFunction } from 'express';

/**
 * HTTPS OBRIGATÓRIO EM PRODUÇÃO (docs/CORTEX/PRODUCAO.md §HTTPS). A API não termina TLS: o certificado fica no proxy/balanceador
 * (nginx, Caddy, ALB...) que repassa `X-Forwarded-Proto` e é declarado em `TRUST_PROXY` (só então `req.secure` vale). Em produção,
 * toda requisição que NÃO chegou por HTTPS é recusada com 426 — não há redirecionamento: o `Host` vem do cliente (redirecionar por ele
 * abriria redirecionamento para domínio de terceiro) e uma credencial que já trafegou em texto puro não deve ser "consertada" depois.
 * O aplicativo nunca "tolera" HTTP: ele precisa apontar para a URL https oficial.
 *
 * Exceção única: as sondas de saúde (`/api/health`, `/live`, `/ready`) por GET/HEAD, que o orquestrador faz por dentro da rede privada.
 * Saída explícita para ambiente interno sem TLS: `ENFORCE_HTTPS=false` (a validação de partida avisa).
 */
const PROBE = /^\/api\/health(\/(live|ready))?\/?$/;

export function httpsEnforced(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NODE_ENV === 'production' && env.ENFORCE_HTTPS !== 'false';
}

export function requireHttps(env: NodeJS.ProcessEnv = process.env) {
  const enforced = httpsEnforced(env);
  return (req: Request, res: Response, next: NextFunction) => {
    if (!enforced || req.secure) return next();
    if ((req.method === 'GET' || req.method === 'HEAD') && PROBE.test(req.path)) return next();
    return res.status(426).json({ success: false, error: 'Esta API só aceita conexões HTTPS.', code: 'HTTPS_REQUIRED' });
  };
}
