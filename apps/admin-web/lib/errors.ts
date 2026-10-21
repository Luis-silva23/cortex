// A API responde erro em dois formatos: `{ error: "texto" }` (rotas que fazem
// res.status(4xx).json) e `{ message, code, statusCode }` (AppError via
// next(err) → errorHandler). As telas antigas liam só `.error` e mostravam
// sempre o texto genérico quando a resposta vinha no segundo formato. Alguns
// endpoints ainda devolvem a mensagem de um ZodError como JSON cru
// (`[{"path":["unitPrice"],"message":"Expected number..."}]`) — aqui vira texto.

interface ZodIssueLike {
  path?: Array<string | number>;
  message?: string;
}

function formatZodIssues(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith('[')) return null;
  try {
    const parsed = JSON.parse(trimmed);
    if (!Array.isArray(parsed) || parsed.length === 0) return null;
    const lines = (parsed as ZodIssueLike[])
      .filter((issue) => issue && typeof issue.message === 'string')
      .map((issue) => {
        const field = (issue.path ?? []).join('.');
        return field ? `${field}: ${issue.message}` : String(issue.message);
      });
    return lines.length > 0 ? lines.join('; ') : null;
  } catch {
    return null;
  }
}

/** Frase única para "autenticado, mas sem permissão" (403 genérico). Não revela o que o recurso é nem quem poderia acessá-lo. */
export const NO_PERMISSION_MESSAGE = 'Usuário sem autorização. Entre em contato com o administrador.';
const FORBIDDEN_CODES = new Set(['FORBIDDEN', 'INSUFFICIENT_PERMISSIONS', 'READ_ONLY_ROLE']);
const FORBIDDEN_GENERIC = /^(acesso negado|forbidden|voc[êe] n[ãa]o tem permiss[ãa]o para realizar esta a[çc][ãa]o|perfil somente leitura n[ãa]o executa esta a[çc][ãa]o)\.?$/i;

export function getApiErrorMessage(err: unknown, fallback: string): string {
  const response = (err as any)?.response;
  const data = response?.data;
  let candidate: unknown = data?.error ?? data?.message;

  // `{ error: { message } }` (envelopes aninhados)
  if (candidate && typeof candidate === 'object') {
    candidate = (candidate as any).message;
  }

  // 403 genérico (sem permissão) vira a frase padrão; 403 de NEGÓCIO com texto próprio (empresa desativada, equipamento…) fica.
  const status = response?.status ?? data?.statusCode;
  if (status === 403) {
    const text = typeof candidate === 'string' ? candidate.trim() : '';
    if (FORBIDDEN_CODES.has(data?.code) || FORBIDDEN_GENERIC.test(text)) return NO_PERMISSION_MESSAGE;
  }

  if (typeof candidate === 'string' && candidate.trim() !== '') {
    return formatZodIssues(candidate) ?? candidate;
  }
  return fallback;
}
