import { detectMime, safeFileName, validateAttachment } from './support-attachment';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n');
const b64 = (b: Buffer) => b.toString('base64');
const codeOf = (fn: () => unknown) => {
  try {
    fn();
  } catch (e: any) {
    return e.code;
  }
  return 'OK';
};

describe('support-attachment', () => {
  describe('detectMime (pelo conteúdo)', () => {
    it('reconhece PNG, JPG, PDF e texto de log', () => {
      expect(detectMime(PNG)).toBe('image/png');
      expect(detectMime(JPG)).toBe('image/jpeg');
      expect(detectMime(PDF)).toBe('application/pdf');
      expect(detectMime(Buffer.from('2026-09-28 10:00 erro ao confirmar pagamento\n'))).toBe('text/plain');
    });

    it.each([
      ['exe (MZ)', Buffer.concat([Buffer.from('MZ'), Buffer.alloc(16, 1)])],
      ['ELF', Buffer.from([0x7f, 0x45, 0x4c, 0x46, 1, 1])],
      ['Mach-O', Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 7, 0])],
      ['ZIP/JAR/APK', Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0])],
      ['script #!', Buffer.from('#!/bin/sh\nrm -rf /\n')],
      ['HTML', Buffer.from('<html><body>oi</body></html>')],
      ['script', Buffer.from('texto <script>alert(1)</script>')],
      ['SVG', Buffer.from('<svg onload="alert(1)"></svg>')],
      ['binário com NUL', Buffer.from([0x41, 0x00, 0x42])],
      ['UTF-8 inválido', Buffer.from([0xc3, 0x28, 0x41])],
    ])('recusa %s', (_label, buf) => {
      expect(detectMime(buf)).toBeNull();
    });
  });

  describe('safeFileName', () => {
    it('remove caminho e caracteres perigosos, mantém acentos', () => {
      expect(safeFileName('../../etc/passwd')).toBe('passwd');
      expect(safeFileName('C:\\Users\\x\\tela do caixa.png')).toBe('tela do caixa.png');
      expect(safeFileName('relatório<>:"|?*.pdf')).toBe('relatório_______.pdf');
      expect(safeFileName('...oculto.log')).toBe('oculto.log');
      expect(safeFileName('')).toBe('arquivo');
    });

    it('limita a 120 caracteres preservando a extensão', () => {
      const n = safeFileName(`${'a'.repeat(300)}.png`);
      expect(n.length).toBe(120);
      expect(n.endsWith('.png')).toBe(true);
    });
  });

  describe('validateAttachment', () => {
    it('aceita arquivo válido e devolve nome seguro, tipo detectado e hash', () => {
      const r = validateAttachment({ fileName: '../erro.png', mimeType: 'image/png', contentBase64: `data:image/png;base64,${b64(PNG)}` });
      expect(r).toMatchObject({ fileName: 'erro.png', mimeType: 'image/png', size: PNG.length });
      expect(r.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(validateAttachment({ fileName: 'pdv.log', mimeType: 'text/x-log', contentBase64: b64(Buffer.from('linha\n')) }).mimeType).toBe('text/plain');
      expect(validateAttachment({ fileName: 'foto.JPEG', contentBase64: b64(JPG) }).mimeType).toBe('image/jpeg');
    });

    it('códigos de erro legíveis para cada recusa', () => {
      expect(codeOf(() => validateAttachment({ fileName: 'a.png' }))).toBe('ATTACHMENT_REQUIRED');
      expect(codeOf(() => validateAttachment({ fileName: 'a.png', contentBase64: 'não é base64!' }))).toBe('ATTACHMENT_INVALID');
      expect(codeOf(() => validateAttachment({ fileName: 'a.png', contentBase64: '=' }))).toBe('ATTACHMENT_EMPTY');
      expect(codeOf(() => validateAttachment({ fileName: 'a.png', contentBase64: b64(Buffer.concat([PNG, Buffer.alloc(2 * 1024 * 1024)])) }))).toBe('ATTACHMENT_TOO_LARGE');
      expect(codeOf(() => validateAttachment({ fileName: 'a.png', contentBase64: b64(Buffer.from('MZ\x90\x00')) }))).toBe('ATTACHMENT_TYPE_NOT_ALLOWED');
      expect(codeOf(() => validateAttachment({ fileName: 'a.exe', contentBase64: b64(PNG) }))).toBe('ATTACHMENT_EXTENSION_MISMATCH');
      expect(codeOf(() => validateAttachment({ fileName: 'a.pdf', contentBase64: b64(PNG) }))).toBe('ATTACHMENT_EXTENSION_MISMATCH');
      expect(codeOf(() => validateAttachment({ fileName: 'a', contentBase64: b64(PNG) }))).toBe('ATTACHMENT_EXTENSION_MISMATCH');
      expect(codeOf(() => validateAttachment({ fileName: 'a.png', mimeType: 'application/pdf', contentBase64: b64(PNG) }))).toBe('ATTACHMENT_MIME_MISMATCH');
    });

    it('exatamente 2 MB passa; 1 byte a mais não', () => {
      const exact = Buffer.concat([PNG, Buffer.alloc(2 * 1024 * 1024 - PNG.length)]);
      expect(validateAttachment({ fileName: 'a.png', contentBase64: b64(exact) }).size).toBe(2 * 1024 * 1024);
      expect(codeOf(() => validateAttachment({ fileName: 'a.png', contentBase64: b64(Buffer.concat([exact, Buffer.from([0])])) }))).toBe('ATTACHMENT_TOO_LARGE');
    });
  });
});
