/**
 * Regra do endereço do servidor (HTTPS em produção, sem credencial na URL, sem "ignorar certificado"): vive em
 * `packages/shared/utils/server-url.ts` e é a MESMA do aplicativo Balcão. Re-exportada aqui para os imports do PDV.
 * (No build, o Vite resolve o `.ts` do pacote por alias — ver vite.config.ts.)
 */
export { checkServerUrl } from '@ln-system/shared/utils/server-url';
