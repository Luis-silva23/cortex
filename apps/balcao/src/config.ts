import { checkServerUrl } from '@ln-system/shared/utils/server-url';

/**
 * Configuração por ambiente (fixada no BUILD: VITE_API_URL). Em produção o aplicativo só aceita https e se recusa a abrir com
 * endereço ausente/inválido (falha fechada); não existe tela para trocar o servidor nem opção de "ignorar certificado". Em
 * desenvolvimento cai para o servidor local. O Balcão NÃO fala com banco nem com Redis: só com a API.
 */
export const API_URL: string = import.meta.env.VITE_API_URL || (import.meta.env.PROD ? '' : 'http://localhost:3001');

/** Motivo pelo qual o aplicativo não pode falar com o servidor (http em produção, endereço ausente...). `null` = pode. */
export const SERVER_URL_PROBLEM: string | null = checkServerUrl(API_URL, import.meta.env.PROD);

export const APP_VERSION: string = typeof __BALCAO_VERSION__ === 'string' ? __BALCAO_VERSION__ : 'dev';
