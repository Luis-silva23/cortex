import * as crypto from 'crypto';
import { logger } from '../utils/logger';

interface MFASecret {
  secret: string;
  qrCode: string;
  backupCodes: string[];
}

interface MFAVerification {
  valid: boolean;
  error?: string;
  /** Passo de 30 s (contador TOTP) que casou: quem consome o código grava e recusa passo igual ou anterior (anti-reuso). */
  step?: number;
}

export class MFAService {
  private readonly SECRET_LENGTH = 32;
  private readonly CODE_LENGTH = 6;
  private readonly CODE_VALIDITY_WINDOW = 30000; // 30 seconds
  private readonly BACKUP_CODES_COUNT = 10;

  /**
   * Generate a new MFA secret for a user
   */
  generateSecret(userId: string, email: string): MFASecret {
    try {
      // Generate random secret (base32 encoded)
      const secret = this.generateRandomSecret();

      // Generate backup codes
      const backupCodes = this.generateBackupCodes();

      // Generate QR code data URL
      const issuer = 'LN System Cloud';
      const qrCodeUrl = this.generateQRCodeUrl(email, secret, issuer);

      logger.info(`MFA secret generated for user: ${userId}`);

      return {
        secret,
        qrCode: qrCodeUrl,
        backupCodes,
      };
    } catch (error) {
      logger.error('Failed to generate MFA secret:', error);
      throw error;
    }
  }

  /**
   * Verify a TOTP code
   */
  verifyCode(secret: string, code: string): MFAVerification {
    try {
      if (!code || code.length !== this.CODE_LENGTH) {
        return { valid: false, error: 'Invalid code format' };
      }

      // Janela atual e a vizinha de cada lado (tolera 30 s de relógio). Compara em tempo constante e devolve o PASSO que casou,
      // para o chamador impedir que o mesmo código seja usado duas vezes.
      const baseStep = Math.floor(Date.now() / this.CODE_VALIDITY_WINDOW);
      let matchedStep: number | undefined;
      for (const offset of [0, -1, 1]) {
        const expected = Buffer.from(this.generateTOTP(secret, offset));
        const given = Buffer.from(code);
        if (expected.length === given.length && crypto.timingSafeEqual(expected, given) && matchedStep === undefined) {
          matchedStep = baseStep + offset;
        }
      }
      if (matchedStep !== undefined) return { valid: true, step: matchedStep };

      return { valid: false, error: 'Invalid code' };
    } catch (error) {
      logger.error('Failed to verify MFA code:', error);
      return { valid: false, error: 'Verification failed' };
    }
  }

  /**
   * Verify a backup code against the user's remaining (unused) stored codes.
   *
   * ANTES DESTA CORREÇÃO: este método só validava o FORMATO do código
   * (16 caracteres) e retornava `valid: true` para qualquer string desse
   * tamanho — ou seja, qualquer hex de 16 caracteres passava como MFA válido,
   * um bypass completo de autenticação. Agora ele compara o hash do código
   * fornecido contra a lista de códigos ainda não usados armazenada no banco
   * (User.mfaBackupCodes).
   */
  verifyBackupCode(
    storedHashedCodes: string[],
    providedCode: string
  ): { valid: boolean; error?: string; matchedHash?: string } {
    try {
      if (!providedCode || providedCode.length !== 16) {
        return { valid: false, error: 'Invalid backup code format' };
      }

      const hashedCode = this.hashBackupCode(providedCode);

      if (!storedHashedCodes.includes(hashedCode)) {
        return { valid: false, error: 'Invalid or already used backup code' };
      }

      return { valid: true, matchedHash: hashedCode };
    } catch (error) {
      logger.error('Failed to verify backup code:', error);
      return { valid: false, error: 'Verification failed' };
    }
  }

  /**
   * Generate a TOTP code
   */
  private generateTOTP(secret: string, timeStep: number = 0): string {
    const time = Math.floor(Date.now() / this.CODE_VALIDITY_WINDOW) + timeStep;
    const timeBuffer = Buffer.allocUnsafe(8);
    timeBuffer.writeBigInt64BE(BigInt(time));

    const secretBuffer = MFAService.base32Decode(secret);
    const hmac = crypto.createHmac('sha1', secretBuffer);
    hmac.update(timeBuffer);
    const digest = hmac.digest();

    const offset = digest[digest.length - 1] & 0x0f;
    const binary =
      ((digest[offset] & 0x7f) << 24) |
      ((digest[offset + 1] & 0xff) << 16) |
      ((digest[offset + 2] & 0xff) << 8) |
      (digest[offset + 3] & 0xff);

    const code = binary % Math.pow(10, this.CODE_LENGTH);
    return code.toString().padStart(this.CODE_LENGTH, '0');
  }

  /**
   * Generate a random secret.
   *
   * CORREÇÃO: antes o segredo era gerado em base64 e embutido assim mesmo
   * na URI `otpauth://` do QR Code. Apps padrão do mercado (Google
   * Authenticator, Authy, etc.) esperam o parâmetro `secret` em Base32
   * (RFC 4648) — um segredo base64 nesse campo não é um Base32 válido e o
   * app ou rejeita o QR ou decodifica errado, gerando códigos que nunca
   * batem com os calculados aqui no servidor. Agora o segredo é gerado e
   * armazenado diretamente em Base32, e `generateTOTP` decodifica com
   * `base32Decode` — consistente do início ao fim.
   */
  private generateRandomSecret(): string {
    const buffer = crypto.randomBytes(this.SECRET_LENGTH);
    return MFAService.base32Encode(buffer);
  }

  /**
   * RFC 4648 Base32 encode/decode (sem padding) — implementados aqui em vez
   * de trazer uma dependência nova, seguindo o padrão já usado neste
   * arquivo de implementar a própria mecânica TOTP/HMAC.
   */
  private static readonly BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

  private static base32Encode(buffer: Buffer): string {
    let bits = 0;
    let value = 0;
    let output = '';

    for (const byte of buffer) {
      value = (value << 8) | byte;
      bits += 8;

      while (bits >= 5) {
        output += MFAService.BASE32_ALPHABET[(value >>> (bits - 5)) & 0x1f];
        bits -= 5;
      }
    }

    if (bits > 0) {
      output += MFAService.BASE32_ALPHABET[(value << (5 - bits)) & 0x1f];
    }

    return output;
  }

  private static base32Decode(base32: string): Buffer {
    const cleaned = base32.toUpperCase().replace(/[^A-Z2-7]/g, '');
    let bits = 0;
    let value = 0;
    const bytes: number[] = [];

    for (const char of cleaned) {
      const index = MFAService.BASE32_ALPHABET.indexOf(char);
      if (index === -1) continue;

      value = (value << 5) | index;
      bits += 5;

      if (bits >= 8) {
        bytes.push((value >>> (bits - 8)) & 0xff);
        bits -= 8;
      }
    }

    return Buffer.from(bytes);
  }

  /**
   * Generate backup codes
   */
  generateBackupCodes(): string[] {
    const codes: string[] = [];

    for (let i = 0; i < this.BACKUP_CODES_COUNT; i++) {
      const code = crypto.randomBytes(8).toString('hex');
      codes.push(code);
    }

    return codes;
  }

  /**
   * Hash a backup code for storage
   */
  hashBackupCode(code: string): string {
    return crypto.createHash('sha256').update(code).digest('hex');
  }

  /**
   * Generate QR code URL for authenticator apps
   */
  private generateQRCodeUrl(email: string, secret: string, issuer: string): string {
    const encodedIssuer = encodeURIComponent(issuer);
    const encodedEmail = encodeURIComponent(email);
    const encodedSecret = encodeURIComponent(secret);

    return `otpauth://totp/${encodedIssuer}:${encodedEmail}?secret=${encodedSecret}&issuer=${encodedIssuer}`;
  }

  /**
   * Send MFA code via SMS (simulation)
   */
  async sendSMSCode(_phone: string): Promise<{ success: boolean; code?: string }> {
    try {
      // Generate a 6-digit code
      const code = Math.floor(100000 + Math.random() * 900000).toString();

      // In production, integrate with SMS provider (Twilio, AWS SNS, etc.)
      // O código NUNCA vai para o log (nem o telefone): só o fato de que a simulação rodou.
      logger.info('MFA SMS code generated (no provider configured; nothing was sent)');

      // For development, return the code
      return { success: true, code: process.env.NODE_ENV === 'development' ? code : undefined };
    } catch (error) {
      logger.error('Failed to send SMS code:', error);
      return { success: false };
    }
  }

  /**
   * Send MFA code via Email (simulation)
   */
  async sendEmailCode(_email: string): Promise<{ success: boolean; code?: string }> {
    try {
      // Generate a 6-digit code
      const code = Math.floor(100000 + Math.random() * 900000).toString();

      // In production, use email service
      logger.info('MFA email code generated (no provider configured; nothing was sent)');

      // For development, return the code
      return { success: true, code: process.env.NODE_ENV === 'development' ? code : undefined };
    } catch (error) {
      logger.error('Failed to send email code:', error);
      return { success: false };
    }
  }
}

export const mfaService = new MFAService();
