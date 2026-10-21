// Roda antes de CADA arquivo de teste de integração (setupFilesAfterEnv): toda escrita destrutiva do cliente
// Prisma (deleteMany/updateMany/delete/update) passa por `checkDestructiveArgs` — `undefined` no filtro ou
// `where` vazio LANÇA em vez de apagar a tabela inteira. Ver helpers/destructive-guard.ts.
import { prismaUnsafeBypassRLS } from '@ln-system/database';
import { installDestructiveGuard } from './helpers/destructive-guard';

installDestructiveGuard(prismaUnsafeBypassRLS as any);
