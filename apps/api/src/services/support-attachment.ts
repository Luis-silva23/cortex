import { createHash } from 'crypto';
import { AppError } from '@ln-system/shared';
import { SUPPORT_ATTACHMENT_TYPES, SUPPORT_LIMITS, type SupportAttachmentMime } from './support-catalog';

/**
 * Validação de anexo da Central de Suporte (docs/CORTEX/SUPPORT.md): o tipo vale pelo CONTEÚDO (assinatura do arquivo),
 * não pelo que o navegador diz; extensão tem de combinar; executável e script nunca entram; nome sem caminho nem
 * caractere perigoso. O arquivo fica no banco (sob RLS) e só sai por rota autorizada, como download.
 */
const bad = (message: string, code: string) => new AppError(message, 400, code);

const startsWith = (buf: Buffer, bytes: number[]) => bytes.every((b, i) => buf[i] === b);

/** Assinaturas de executável/script/arquivo compactado — recusados mesmo com extensão "inocente". */
function looksExecutable(buf: Buffer) {
  return (
    startsWith(buf, [0x4d, 0x5a]) || // MZ (Windows .exe/.dll)
    startsWith(buf, [0x7f, 0x45, 0x4c, 0x46]) || // ELF
    startsWith(buf, [0xcf, 0xfa, 0xed, 0xfe]) || // Mach-O
    startsWith(buf, [0x50, 0x4b, 0x03, 0x04]) || // ZIP (inclui .jar/.docm/.apk)
    startsWith(buf, [0x23, 0x21]) // "#!" script
  );
}

export function detectMime(buf: Buffer): SupportAttachmentMime | null {
  if (startsWith(buf, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (startsWith(buf, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (startsWith(buf, [0x25, 0x50, 0x44, 0x46, 0x2d])) return 'application/pdf'; // %PDF-
  if (looksExecutable(buf)) return null;
  // Texto de log: UTF-8 válido, sem byte nulo e sem marcação HTML/script (não vira página no navegador de ninguém).
  if (buf.includes(0x00)) return null;
  const text = buf.toString('utf8');
  if (Buffer.from(text, 'utf8').length !== buf.length) return null;
  if (/<\s*(script|html|iframe|svg)\b/i.test(text)) return null;
  return 'text/plain';
}

/** Nome seguro: sem caminho, sem controle, só letras (com acento), dígitos, espaço, ponto, hífen e sublinhado. */
export function safeFileName(raw: string): string {
  const base = (raw ?? '').split(/[\\/]/).pop() ?? '';
  const cleaned = base
    .normalize('NFC')
    .replace(/[^\p{L}\p{N} ._-]/gu, '_')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+/, '')
    .trim();
  const limited = cleaned.length > 120 ? cleaned.slice(cleaned.length - 120) : cleaned;
  return limited || 'arquivo';
}

export interface ValidatedAttachment {
  fileName: string;
  mimeType: SupportAttachmentMime;
  data: Buffer;
  size: number;
  sha256: string;
}

export function validateAttachment(input: { fileName?: unknown; mimeType?: unknown; contentBase64?: unknown }): ValidatedAttachment {
  if (typeof input.contentBase64 !== 'string' || !input.contentBase64) {
    throw bad('Escolha um arquivo para anexar.', 'ATTACHMENT_REQUIRED');
  }
  const b64 = input.contentBase64.replace(/^data:[^;]+;base64,/, '').replace(/\s/g, '');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64)) throw bad('O arquivo não chegou inteiro. Tente anexar de novo.', 'ATTACHMENT_INVALID');
  const data = Buffer.from(b64, 'base64');
  if (data.length === 0) throw bad('O arquivo está vazio.', 'ATTACHMENT_EMPTY');
  if (data.length > SUPPORT_LIMITS.attachmentMaxBytes) {
    throw bad('Arquivo maior que 2 MB. Reduza a imagem ou envie só o trecho necessário.', 'ATTACHMENT_TOO_LARGE');
  }
  const fileName = safeFileName(typeof input.fileName === 'string' ? input.fileName : '');
  const ext = (fileName.match(/\.[^.]+$/)?.[0] ?? '').toLowerCase();
  const detected = detectMime(data);
  if (!detected) {
    throw bad('Tipo de arquivo não aceito. Envie imagem (PNG ou JPG), PDF ou arquivo de texto/log.', 'ATTACHMENT_TYPE_NOT_ALLOWED');
  }
  const allowedExt = SUPPORT_ATTACHMENT_TYPES[detected] as readonly string[];
  if (!allowedExt.includes(ext)) {
    throw bad(`O conteúdo não combina com a extensão do arquivo (${ext || 'sem extensão'}). Envie ${allowedExt.join(' ou ')}.`, 'ATTACHMENT_EXTENSION_MISMATCH');
  }
  if (typeof input.mimeType === 'string' && input.mimeType && input.mimeType !== detected && !(detected === 'text/plain' && /^text\//.test(input.mimeType))) {
    throw bad('O tipo informado não combina com o conteúdo do arquivo.', 'ATTACHMENT_MIME_MISMATCH');
  }
  return { fileName, mimeType: detected, data, size: data.length, sha256: createHash('sha256').update(data).digest('hex') };
}
