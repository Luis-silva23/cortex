import { AppError } from '@ln-system/shared';

/**
 * VALIDAÇÃO E SANEAMENTO da imagem do produto (decisão 122). O tipo vale pelo CONTEÚDO (assinatura + estrutura), nunca pelo que o
 * navegador ou a extensão dizem. Aceita só PNG, JPEG e WebP estáticos; SVG, GIF, HTML, executável, PDF e qualquer outra coisa são
 * recusados. Em vez de "confiar e guardar", a imagem é REMONTADA a partir de partes conhecidas:
 *  - PNG: todos os blocos têm o CRC conferido; ficam só os de imagem (IHDR, PLTE, tRNS, IDAT, IEND) e de cor (gAMA, cHRM, sRGB, pHYs);
 *    texto, EXIF, data e quadros de animação saem; nenhum byte pode sobrar depois do IEND;
 *  - JPEG: segmentos conferidos um a um; saem EXIF/XMP/GPS (APP1…), comentários e perfis; ficam JFIF (APP0), Adobe (APP14), tabelas e
 *    dados da imagem; EOI no fim exato;
 *  - WebP: RIFF com tamanho exato; saem EXIF e XMP (e a marca no VP8X); animação é recusada.
 * Resultado: sem metadados (localização do GPS, nome do aparelho), sem "poliglota" (arquivo que também é script/HTML/ZIP depois do fim
 * da imagem), com dimensões e tamanho limitados. Não decodifica pixels (nenhuma biblioteca de imagem nativa é carregada).
 */
export const PRODUCT_IMAGE_LIMITS = { maxBytes: 1_048_576, maxSide: 4096, minSide: 1 } as const;
export type ProductImageMime = 'image/png' | 'image/jpeg' | 'image/webp';
export interface SanitizedImage {
  mimeType: ProductImageMime;
  data: Buffer;
  width: number;
  height: number;
}

const invalid = (message: string, code = 'IMAGE_INVALID') => new AppError(message, 400, code);
const unsupported = () => new AppError('Formato não aceito. Envie uma imagem PNG, JPEG ou WebP.', 415, 'IMAGE_TYPE_UNSUPPORTED');
const startsWith = (buf: Buffer, bytes: number[]) => buf.length >= bytes.length && bytes.every((b, i) => buf[i] === b);

export function detectImageType(buf: Buffer): ProductImageMime | null {
  if (startsWith(buf, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (startsWith(buf, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (buf.length >= 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

function checkDimensions(width: number, height: number) {
  const { maxSide, minSide } = PRODUCT_IMAGE_LIMITS;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < minSide || height < minSide) throw invalid('A imagem tem dimensões inválidas.', 'IMAGE_DIMENSIONS_INVALID');
  if (width > maxSide || height > maxSide) throw invalid(`A imagem é grande demais (máximo ${maxSide}×${maxSide} pixels).`, 'IMAGE_DIMENSIONS_TOO_LARGE');
}

// ------------------------------------------------------------------------------------------------------------------- PNG
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();
function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const PNG_KEEP = new Set(['IHDR', 'PLTE', 'tRNS', 'IDAT', 'IEND', 'gAMA', 'cHRM', 'sRGB', 'pHYs']);
const PNG_CRITICAL = new Set(['IHDR', 'PLTE', 'IDAT', 'IEND']);

function sanitizePng(buf: Buffer): SanitizedImage {
  const out: Buffer[] = [buf.subarray(0, 8)];
  let pos = 8;
  let width = 0;
  let height = 0;
  let sawIhdr = false;
  let sawIend = false;
  let idat = 0;
  let colorType = -1;
  let sawPlte = false;
  while (pos < buf.length) {
    if (sawIend) throw invalid('O arquivo tem dados depois do fim da imagem.', 'IMAGE_TRAILING_DATA');
    if (pos + 12 > buf.length) throw invalid('Imagem PNG truncada.');
    const length = buf.readUInt32BE(pos);
    if (length > 0x7fffffff || pos + 12 + length > buf.length) throw invalid('Imagem PNG truncada ou corrompida.');
    const type = buf.toString('latin1', pos + 4, pos + 8);
    if (!/^[A-Za-z]{4}$/.test(type)) throw invalid('Imagem PNG corrompida.');
    const body = buf.subarray(pos + 4, pos + 8 + length); // tipo + dados (o que o CRC cobre)
    if (crc32(body) !== buf.readUInt32BE(pos + 8 + length)) throw invalid('Imagem PNG corrompida (CRC).');
    if (!sawIhdr) {
      if (type !== 'IHDR' || length !== 13) throw invalid('Imagem PNG inválida.');
      width = buf.readUInt32BE(pos + 8);
      height = buf.readUInt32BE(pos + 12);
      colorType = buf[pos + 17];
      const [depth, compression, filter, interlace] = [buf[pos + 16], buf[pos + 18], buf[pos + 19], buf[pos + 20]];
      if (compression !== 0 || filter !== 0 || interlace > 1 || ![1, 2, 4, 8, 16].includes(depth) || ![0, 2, 3, 4, 6].includes(colorType)) throw invalid('Imagem PNG inválida.');
      checkDimensions(width, height);
      sawIhdr = true;
    } else if (type === 'IHDR') {
      throw invalid('Imagem PNG inválida.');
    }
    if (type === 'IDAT') idat += 1;
    if (type === 'PLTE') sawPlte = true;
    if (type === 'IEND') sawIend = true;
    if (!PNG_KEEP.has(type) && !(type.charCodeAt(0) & 0x20)) {
      // bloco CRÍTICO desconhecido (inicial maiúscula): não dá para garantir o que é
      if (!PNG_CRITICAL.has(type)) throw invalid('Imagem PNG com bloco não suportado.', 'IMAGE_UNSUPPORTED_CHUNK');
    }
    if (PNG_KEEP.has(type)) out.push(buf.subarray(pos, pos + 12 + length));
    pos += 12 + length;
  }
  if (!sawIhdr || !sawIend || idat === 0) throw invalid('Imagem PNG incompleta.');
  if (colorType === 3 && !sawPlte) throw invalid('Imagem PNG inválida (sem paleta).');
  return { mimeType: 'image/png', data: Buffer.concat(out), width, height };
}

// ------------------------------------------------------------------------------------------------------------------ JPEG
const isSof = (m: number) => m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc;

function sanitizeJpeg(buf: Buffer): SanitizedImage {
  const out: Buffer[] = [Buffer.from([0xff, 0xd8])];
  let pos = 2;
  let width = 0;
  let height = 0;
  let sawSof = false;
  let sawSos = false;
  let sawEoi = false;
  while (pos < buf.length) {
    if (sawEoi) throw invalid('O arquivo tem dados depois do fim da imagem.', 'IMAGE_TRAILING_DATA');
    if (buf[pos] !== 0xff) throw invalid('Imagem JPEG corrompida.');
    while (pos + 1 < buf.length && buf[pos + 1] === 0xff) pos += 1; // bytes de preenchimento
    const marker = buf[pos + 1];
    const start = pos;
    pos += 2;
    if (marker === undefined) throw invalid('Imagem JPEG truncada.');
    if (marker === 0xd9) {
      out.push(Buffer.from([0xff, 0xd9]));
      sawEoi = true;
      continue;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x00) throw invalid('Imagem JPEG corrompida.');
    if (pos + 2 > buf.length) throw invalid('Imagem JPEG truncada.');
    const length = buf.readUInt16BE(pos);
    if (length < 2 || pos + length > buf.length) throw invalid('Imagem JPEG truncada ou corrompida.');
    const segmentEnd = pos + length;
    if (isSof(marker)) {
      if (length < 8) throw invalid('Imagem JPEG corrompida.');
      height = buf.readUInt16BE(pos + 3);
      width = buf.readUInt16BE(pos + 5);
      checkDimensions(width, height);
      sawSof = true;
    }
    const drop = (marker >= 0xe1 && marker <= 0xef && marker !== 0xee) || marker === 0xfe; // APP1…APP15 (menos Adobe) e comentário
    if (marker === 0xda) {
      if (!sawSof) throw invalid('Imagem JPEG inválida.');
      out.push(buf.subarray(start, segmentEnd));
      let i = segmentEnd;
      while (i < buf.length) {
        if (buf[i] !== 0xff) {
          i += 1;
          continue;
        }
        const next = buf[i + 1];
        if (next === 0x00 || (next >= 0xd0 && next <= 0xd7)) i += 2;
        else if (next === 0xff) i += 1;
        else break;
      }
      out.push(buf.subarray(segmentEnd, i)); // dados da imagem (entropia)
      sawSos = true;
      pos = i;
      continue;
    }
    if (!drop) out.push(buf.subarray(start, segmentEnd));
    pos = segmentEnd;
  }
  if (!sawSof || !sawSos || !sawEoi) throw invalid('Imagem JPEG incompleta.');
  return { mimeType: 'image/jpeg', data: Buffer.concat(out), width, height };
}

// ------------------------------------------------------------------------------------------------------------------ WebP
function sanitizeWebp(buf: Buffer): SanitizedImage {
  if (buf.length < 20) throw invalid('Imagem WebP truncada.');
  if (buf.readUInt32LE(4) + 8 !== buf.length) throw invalid('Imagem WebP com tamanho inconsistente ou dados sobrando.', 'IMAGE_TRAILING_DATA');
  const chunks: { type: string; data: Buffer }[] = [];
  let pos = 12;
  while (pos < buf.length) {
    if (pos + 8 > buf.length) throw invalid('Imagem WebP truncada.');
    const type = buf.toString('latin1', pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    const end = pos + 8 + size;
    if (end > buf.length) throw invalid('Imagem WebP truncada ou corrompida.');
    chunks.push({ type, data: buf.subarray(pos + 8, end) });
    pos = end + (size & 1);
    if (pos > buf.length) throw invalid('Imagem WebP truncada.');
  }
  if (chunks.some((c) => c.type === 'ANIM' || c.type === 'ANMF')) throw invalid('Imagens WebP animadas não são aceitas.', 'IMAGE_ANIMATED');
  const frame = chunks.filter((c) => c.type === 'VP8 ' || c.type === 'VP8L');
  if (frame.length !== 1) throw invalid('Imagem WebP inválida.');
  let width: number;
  let height: number;
  const data = frame[0].data;
  if (frame[0].type === 'VP8L') {
    if (data.length < 5 || data[0] !== 0x2f) throw invalid('Imagem WebP inválida.');
    const bits = data.readUInt32LE(1);
    width = (bits & 0x3fff) + 1;
    height = ((bits >>> 14) & 0x3fff) + 1;
  } else {
    if (data.length < 10 || data[3] !== 0x9d || data[4] !== 0x01 || data[5] !== 0x2a) throw invalid('Imagem WebP inválida.');
    width = data.readUInt16LE(6) & 0x3fff;
    height = data.readUInt16LE(8) & 0x3fff;
  }
  const extended = chunks.find((c) => c.type === 'VP8X');
  if (extended) {
    if (extended.data.length < 10) throw invalid('Imagem WebP inválida.');
    if (extended.data[0] & 0x02) throw invalid('Imagens WebP animadas não são aceitas.', 'IMAGE_ANIMATED');
    width = 1 + (extended.data[4] | (extended.data[5] << 8) | (extended.data[6] << 16));
    height = 1 + (extended.data[7] | (extended.data[8] << 8) | (extended.data[9] << 16));
  }
  checkDimensions(width, height);
  const keep = new Set(['VP8X', 'ALPH', 'VP8 ', 'VP8L', 'ICCP']);
  const body: Buffer[] = [Buffer.from('WEBP', 'latin1')];
  for (const c of chunks) {
    if (!keep.has(c.type)) continue; // EXIF, XMP e qualquer bloco desconhecido saem
    let data2 = c.data;
    if (c.type === 'VP8X') {
      data2 = Buffer.from(c.data);
      data2[0] &= ~(0x04 | 0x08); // sem XMP nem EXIF
    }
    const head = Buffer.alloc(8);
    head.write(c.type, 0, 'latin1');
    head.writeUInt32LE(data2.length, 4);
    body.push(head, data2);
    if (data2.length & 1) body.push(Buffer.from([0]));
  }
  const payload = Buffer.concat(body);
  const riff = Buffer.alloc(8);
  riff.write('RIFF', 0, 'latin1');
  riff.writeUInt32LE(payload.length, 4);
  return { mimeType: 'image/webp', data: Buffer.concat([riff, payload]), width, height };
}

/** Valida e remonta a imagem. Lança AppError (400/415) com código estável: IMAGE_INVALID, IMAGE_TYPE_UNSUPPORTED, IMAGE_TRAILING_DATA… */
export function sanitizeProductImage(input: Buffer): SanitizedImage {
  if (!Buffer.isBuffer(input) || input.length === 0) throw invalid('Arquivo vazio.', 'IMAGE_EMPTY');
  if (input.length > PRODUCT_IMAGE_LIMITS.maxBytes) {
    throw new AppError(`A imagem passa de ${Math.round(PRODUCT_IMAGE_LIMITS.maxBytes / 1024 / 1024)} MB.`, 413, 'IMAGE_TOO_LARGE');
  }
  const type = detectImageType(input);
  if (!type) throw unsupported();
  const result = type === 'image/png' ? sanitizePng(input) : type === 'image/jpeg' ? sanitizeJpeg(input) : sanitizeWebp(input);
  if (result.data.length > PRODUCT_IMAGE_LIMITS.maxBytes) throw new AppError('A imagem passa do tamanho máximo.', 413, 'IMAGE_TOO_LARGE');
  return result;
}
