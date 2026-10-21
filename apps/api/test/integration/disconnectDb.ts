// Roda depois de CADA arquivo de teste de integração (setupFilesAfterEnv).
//
// Cada arquivo tem o seu próprio PrismaClient (o Jest mantém um registro de módulos por arquivo) e ninguém
// o fechava: as conexões ficavam abertas até o fim do processo. Com ~30 arquivos a soma estourava o
// `max_connections` (100) do Postgres de dev — "Too many database connections opened" — e as suítes
// falhavam de forma aleatória, uma diferente a cada rodada (o Prisma reconecta sozinho na próxima query,
// então um teardown que rode depois deste hook continua funcionando).
import { prismaUnsafeBypassRLS } from '@ln-system/database';

afterAll(async () => {
  await prismaUnsafeBypassRLS.$disconnect();
});
