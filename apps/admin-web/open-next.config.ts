import { defineCloudflareConfig } from '@opennextjs/cloudflare';

// Só para o build do Worker (docs/CORTEX/CLOUDFLARE.md). O adaptador NÃO é dependência do projeto (instalado só no passo de build, versão fixada),
// por isso este arquivo fica fora do `tsconfig.json` e do build normal. Sem cache incremental em R2/KV: o Admin Web não usa ISR nem revalidação.
export default defineCloudflareConfig();
