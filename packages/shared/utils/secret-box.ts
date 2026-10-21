import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

/**
 * Cifra de segredos em repouso (segredo TOTP do MFA, senha do certificado fiscal, token CSC). Antes eram gravados em
 * texto puro no banco: um dump/backup/leitura indevida entregava o segundo fator de todo Super Admin.
 *
 * AES-256-GCM (autenticada: adulteração do valor gravado é detectada), IV aleatório por valor, chave de 32 bytes em
 * DATA_ENCRYPTION_KEY (base64), nunca no repositório. Formato versionado: `enc:v1:<iv>:<tag>:<cifra>` (base64url), para
 * permitir troca de algoritmo/chave no futuro.
 *
 * Valor sem o prefixo é legado em texto puro (anterior a esta mudança): `openSecret` devolve como está para não
 * derrubar logins durante a migração, e `scripts/encrypt-secrets.ts` cifra as linhas existentes.
 */
const PREFIX = 'enc:v1:';

function key(): Buffer {
  const raw = process.env.DATA_ENCRYPTION_KEY;
  const buf = raw ? Buffer.from(raw, 'base64') : Buffer.alloc(0);
  if (buf.length !== 32) {
    throw new Error('DATA_ENCRYPTION_KEY ausente ou inválida (32 bytes em base64: `openssl rand -base64 32`)');
  }
  return buf;
}

/** Falha cedo (na subida do serviço) se a chave não estiver configurada. */
export function assertEncryptionKey(): void {
  key();
}

export function isSealed(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.startsWith(PREFIX);
}

export function sealSecret(plain: string): string {
  if (isSealed(plain)) return plain;
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString('base64url')}:${tag.toString('base64url')}:${data.toString('base64url')}`;
}

export function openSecret(stored: string): string;
export function openSecret(stored: string | null | undefined): string | null;
export function openSecret(stored: string | null | undefined): string | null {
  if (stored === null || stored === undefined) return null;
  if (!isSealed(stored)) return stored;
  const [iv, tag, data] = stored.slice(PREFIX.length).split(':');
  if (!iv || !tag || !data) throw new Error('Segredo cifrado malformado');
  const decipher = createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8');
}
