/**
 * Endereço do servidor do CÓRTEX nos aplicativos de balcão (PDV Desktop, Balcão). Regras (docs/CORTEX/DISPOSITIVOS.md §4):
 *  - o endereço é FIXADO NA INSTALAÇÃO/BUILD (variável de ambiente do build); o operador não digita IP/porta/banco/Redis;
 *  - em PRODUÇÃO só vale HTTPS, sem usuário/senha embutidos na URL;
 *  - NÃO existe "ignorar erro de certificado": o aplicativo usa a validação padrão do sistema.
 * Função pura (sem `import.meta`/`window`): testável fora do Vite e compartilhada pelos aplicativos.
 */
export function checkServerUrl(rawUrl: string | undefined, production: boolean): string | null {
  if (!rawUrl || !rawUrl.trim()) return production ? 'O endereço do servidor não foi configurado nesta instalação.' : null;
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return 'O endereço do servidor configurado nesta instalação é inválido.';
  }
  if (url.username || url.password) return 'O endereço do servidor não pode conter usuário ou senha.';
  if (production && url.protocol !== 'https:') return 'Esta instalação aponta para um servidor sem HTTPS. Reinstale com o endereço oficial (https).';
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return 'O endereço do servidor configurado nesta instalação é inválido.';
  return null;
}
