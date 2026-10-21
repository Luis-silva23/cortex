import { checkServerUrl } from './server-url';

/** Endereço oficial do servidor (fixado no build/instalação). Em desenvolvimento cai para o servidor local. */
export const API_URL: string = import.meta.env.VITE_API_URL || (import.meta.env.PROD ? '' : 'http://localhost:3001');

/** Motivo pelo qual este aplicativo NÃO pode falar com o servidor (HTTP em produção, endereço ausente...). `null` = pode. */
export const SERVER_URL_PROBLEM: string | null = checkServerUrl(API_URL, import.meta.env.PROD);
