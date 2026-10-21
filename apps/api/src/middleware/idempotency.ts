import { Request, Response, NextFunction } from 'express';
import { createHash } from 'crypto';
import { prisma, Prisma } from '@ln-system/database';
import { Logger } from '../services/logger.service';

const IDEMPOTENCY_WINDOW_MS = 24 * 60 * 60 * 1000; // 24h — janela de deduplicação

/**
 * Idempotência real via constraint única no Postgres
 * (`idempotency_keys(companyId, endpoint, key)`), não memória/Redis — é o
 * próprio banco que decide qual, entre duas requisições concorrentes com a
 * mesma chave, "ganha a corrida": só um INSERT consegue completar, o outro
 * recebe violação de unicidade (P2002) e é tratado abaixo como "já em
 * processamento", sem precisar de lock aplicativo nenhum.
 *
 * Contrato do header `Idempotency-Key` (opcional — sem ele a rota segue
 * exatamente como antes, sem proteção; nenhum cliente existente quebra):
 *   - mesma chave + mesmo corpo, requisição já concluída -> devolve a
 *     MESMA resposta armazenada, sem reexecutar a operação real;
 *   - mesma chave + mesmo corpo, ainda em processamento (corrida
 *     concorrente) -> 409, a operação real roda exatamente uma vez;
 *   - mesma chave + corpo DIFERENTE -> 422 (uso incorreto da chave,
 *     nunca executa);
 *   - chaves diferentes -> completamente independentes.
 */
export interface IdempotencyOptions {
  /** Quando informado, a chave deixa de ser opcional: sem ela a requisição recebe o erro devolvido por esta função (Commerce API). */
  required?: () => Error;
}

export function idempotency(options: IdempotencyOptions = {}) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const key = req.header('Idempotency-Key');
    if (!key) {
      return options.required ? next(options.required()) : next();
    }

    const user = (req as any).user;
    // Commerce API: não há usuário JWT; a empresa vem da credencial do canal (nunca do corpo) e a chave é por canal.
    const principal = (req as any).channelPrincipal as { companyId: string; channelId: string } | undefined;
    const companyId: string = user?.companyId ?? principal?.companyId ?? 'PLATFORM';
    const routePattern = req.route?.path
      ? `${req.baseUrl}${req.route.path}`.replace(/\/+/g, '/')
      : req.baseUrl || req.path;
    const endpoint = `${req.method} ${routePattern}${principal ? `|channel:${principal.channelId}` : ''}`;
    const requestHash = createHash('sha256').update(JSON.stringify(req.body ?? {})).digest('hex');

    let record: { id: string };
    try {
      record = await prisma.idempotencyKey.create({
        data: {
          key,
          companyId,
          userId: user?.userId,
          endpoint,
          requestHash,
          expiresAt: new Date(Date.now() + IDEMPOTENCY_WINDOW_MS),
        },
      });
    } catch (error) {
      const isDuplicate =
        error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
      if (!isDuplicate) {
        return next(error);
      }

      // Consultas deste ramo dentro de try: uma rejeição aqui ficava sem tratamento (Express 4) e a requisição travava.
      try {
        const existing = await prisma.idempotencyKey.findUnique({
          where: { companyId_endpoint_key: { companyId, endpoint, key } },
        });

        if (!existing) {
          // Corrida rara: a chave existia no INSERT mas sumiu antes deste
          // SELECT (ex.: expirou). Segue como se fosse uma chave nova.
          return next();
        }

        // Janela de 24 h encerrada (`expiresAt`): a chave está LIVRE — o expurgo periódico pode ainda não ter passado. Sem isto a mesma chave
        // devolvia a resposta antiga para sempre. Só remove se continuar vencida (a condição está no DELETE) e reassume a chave como nova;
        // se outra requisição reassumiu antes, cai no 409 "em processamento".
        let reclaimedExpired = false;
        if (existing.expiresAt && new Date(existing.expiresAt).getTime() <= Date.now()) {
          await prisma.idempotencyKey.deleteMany({ where: { id: existing.id, expiresAt: { lte: new Date() } } });
          try {
            record = await prisma.idempotencyKey.create({
              data: { key, companyId, userId: user?.userId, endpoint, requestHash, expiresAt: new Date(Date.now() + IDEMPOTENCY_WINDOW_MS) },
            });
            reclaimedExpired = true;
          } catch (reclaimError) {
            if (reclaimError instanceof Prisma.PrismaClientKnownRequestError && reclaimError.code === 'P2002') {
              return res.status(409).json({
                success: false,
                error: 'Uma requisição com esta Idempotency-Key já está sendo processada',
              });
            }
            return next(reclaimError);
          }
        }

        if (!reclaimedExpired) {
          if (existing.requestHash !== requestHash) {
            return res.status(422).json({
              success: false,
              error: 'Idempotency-Key já foi usada com um corpo de requisição diferente',
            });
          }

          if (existing.status === 'COMPLETED') {
            Logger.security('IDEMPOTENCY_REPLAY', 'Resposta idempotente devolvida sem reexecutar a operação', {
              companyId,
              userId: user?.userId,
              requestId: req.requestId,
            });
            return res.status(existing.responseStatus ?? 200).json(existing.responseBody as any);
          }

          // FAILED (5xx/exceção anterior): a chave está liberada para nova tentativa real. Antes caía no 409 abaixo e a
          // chave ficava presa até expirar. Retomada atômica: entre tentativas concorrentes, só uma reassume a chave.
          const reclaimed =
            existing.status === 'FAILED'
              ? await prisma.idempotencyKey.updateMany({
                  where: { id: existing.id, status: 'FAILED' },
                  data: {
                    status: 'PENDING',
                    responseStatus: null,
                    completedAt: null,
                    expiresAt: new Date(Date.now() + IDEMPOTENCY_WINDOW_MS),
                  },
                })
              : { count: 0 };

          if (reclaimed.count !== 1) {
            // PENDING: outra requisição com a mesma chave+corpo está em voo
            // agora mesmo — a operação real só pode acontecer uma vez.
            return res.status(409).json({
              success: false,
              error: 'Uma requisição com esta Idempotency-Key já está sendo processada',
            });
          }
          record = existing;
        }
      } catch (lookupError) {
        return next(lookupError);
      }
    }

    // Intercepta a resposta para persistir o resultado — tanto sucesso
    // quanto erro de negócio (4xx) contam como "concluído" (idempotente:
    // repetir a mesma chave deve devolver o mesmo erro, não tentar de
    // novo); só uma falha de infraestrutura (5xx/exceção) libera a chave
    // via FAILED, permitindo nova tentativa real com a mesma chave.
    const originalJson = res.json.bind(res);
    res.json = ((body: any) => {
      const status = res.statusCode >= 500 ? 'FAILED' : 'COMPLETED';
      prisma.idempotencyKey
        .update({
          where: { id: record.id },
          data: {
            status,
            responseStatus: res.statusCode,
            responseBody: status === 'COMPLETED' ? body : undefined,
            completedAt: new Date(),
          },
        })
        .catch((err) => Logger.error('Falha ao persistir resposta idempotente', err as Error));
      return originalJson(body);
    }) as typeof res.json;

    next();
  };
}
