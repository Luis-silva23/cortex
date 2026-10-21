import * as fs from 'fs';
import express from 'express';
import request from 'supertest';
import routes from '../../src/routes';
import { errorHandler } from '../../src/middleware/errorHandler';
import { resetAuthLimits } from './helpers/reset-auth-limits';

/**
 * COBERTURA DE AUTENTICAÇÃO (Fase 4): percorre TODAS as rotas registradas sob `/api` (a árvore real do Express, não uma lista escrita à
 * mão) e prova que, sem token, cada uma responde 401 — exceto uma lista PÚBLICA pequena, explícita e comentada. Uma rota nova que
 * esquecer o `authMiddleware` falha aqui. Sequencial e leve (a resposta 401 sai antes de qualquer banco).
 */

type Route = { method: string; path: string };

function mountPath(layer: any): string {
  if (layer.regexp?.fast_slash) return '';
  const src = String(layer.regexp.source).replace('\\/?(?=\\/|$)', '').replace(/^\^/, '').split('\\/').join('/');
  return src.split('(?:([^/]+?))').join(':p');
}

function walk(stack: any[], prefix: string, out: Route[]) {
  for (const layer of stack) {
    if (layer.route) {
      for (const m of Object.keys(layer.route.methods)) out.push({ method: m.toUpperCase(), path: prefix + layer.route.path });
    } else if (layer.name === 'router' && layer.handle?.stack) {
      walk(layer.handle.stack, prefix + mountPath(layer), out);
    }
  }
}

/**
 * Rotas que PODEM responder sem token, uma a uma e com o motivo. Qualquer outra tem de dar 401.
 * Cada entrada é `MÉTODO caminho` (com `:p` no lugar dos parâmetros).
 */
const PUBLIC: Record<string, string> = {
  'GET /api/health/': 'sonda de saúde (sem dado de negócio)',
  'GET /api/health/ready': 'sonda de prontidão',
  'GET /api/health/live': 'sonda de vida',
  'POST /api/device/enroll': 'enrolamento de equipamento novo: cria só um pendente SEM empresa/filial e não devolve dado de negócio (limite por IP; fila limitada)',
  'POST /api/device/status': 'estado do próprio equipamento: exige id + chave secreta (erro uniforme, limite de falhas por IP); sem dado de empresa antes da autorização',
  'POST /api/auth/login': 'login (credencial validada dentro; limite de tentativas por IP)',
  'POST /api/auth/refresh': 'renovação: o refresh token vai no corpo e é validado dentro (rotação, revogação e detecção de reuso)',
  'POST /api/auth/logout': 'encerra a sessão do refresh token apresentado no corpo (validado dentro)',
  'POST /api/auth/verify-mfa': 'segunda etapa do login: exige o token de MFA pendente e o código (validados dentro; limite próprio)',
  'POST /api/auth/send-mfa-code': 'reenvio do código de MFA: exige o token de MFA pendente (validado dentro; limite próprio)',
  'POST /api/auth/mfa-enrollment/begin': 'configuração obrigatória do MFA (decisão 123): exige a credencial de configuração emitida pelo login depois da senha correta (10 min; só COMPANY_ADMIN sem MFA; validada dentro; limite de MFA)',
  'POST /api/auth/password-change/complete': 'troca obrigatória da senha temporária (decisão 157): exige a credencial de troca emitida pelo login (10 min, claims próprias, sem userType) + senha atual + nova (validados dentro; limite de tentativas)',
  'POST /api/auth/mfa-enrollment/confirm': 'conclusão da configuração do MFA: credencial de configuração + código válido do segredo recém-gerado (validados dentro; limite de MFA)',
};

describe('autenticação cobre todas as rotas da API', () => {
  const app = express();
  app.use(express.json());
  app.use('/api', routes);
  app.use(errorHandler);

  afterAll(() => resetAuthLimits());

  const all: Route[] = [];
  walk((app as any)._router.stack, '', all);
  const unique = [...new Map(all.map((r) => [`${r.method} ${r.path}`, r])).values()];
  const url = (r: Route) => r.path.replace(/:[A-Za-z]+/g, 'x').replace(/\/+/g, '/');

  it('encontra a árvore de rotas (mais de 250)', () => {
    expect(unique.length).toBeGreaterThan(250);
  });

  it('toda rota fora da lista pública responde 401 sem token e com token inválido', async () => {
    const offenders: string[] = [];
    const observedPublic: string[] = [];
    for (const r of unique) {
      const key = `${r.method} ${r.path}`;
      const send = async (headers: Record<string, string>) => {
        let req: any = (request(app) as any)[r.method.toLowerCase()](url(r)).set(headers);
        if (r.method !== 'GET' && r.method !== 'HEAD') req = req.send({});
        return req;
      };
      if (PUBLIC[key]) {
        observedPublic.push(key); // não é chamada: os limites de tentativa de login/MFA são do IP e não devem ser gastos aqui
        continue;
      }
      const noToken = await send({});
      const badToken = await send({ Authorization: 'Bearer token.invalido.qualquer' });
      if (noToken.status !== 401 || badToken.status !== 401) offenders.push(`${key} → sem token ${noToken.status}, token inválido ${badToken.status}`);
    }
    if (process.env.AUTH_COVERAGE_REPORT) fs.writeFileSync(process.env.AUTH_COVERAGE_REPORT, unique.map((r) => `${r.method} ${r.path}`).join('\n'));
    expect(offenders).toEqual([]);
    // a lista pública não pode ter entrada morta (rota removida) nem esconder rota nova
    expect(observedPublic.sort()).toEqual(Object.keys(PUBLIC).sort());
  }, 180000);
});
