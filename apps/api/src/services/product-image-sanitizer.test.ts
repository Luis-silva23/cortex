import { deflateSync } from 'zlib';
import { detectImageType, PRODUCT_IMAGE_LIMITS, sanitizeProductImage } from './product-image-sanitizer';

/**
 * Decisão 122 — imagem opcional do produto: validação e saneamento do CONTEÚDO (sem banco). Arquivos sintéticos montados aqui, byte a byte.
 */
const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
const crc32 = (b: Buffer) => {
  let c = 0xffffffff;
  for (const x of b) c = CRC[(c ^ x) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type: string, data: Buffer = Buffer.alloc(0), badCrc = false) => {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE((crc32(Buffer.concat([Buffer.from(type, 'latin1'), data])) ^ (badCrc ? 1 : 0)) >>> 0, 0);
  return Buffer.concat([head, data, tail]);
};
const ihdr = (w: number, h: number, colorType = 6) => {
  const d = Buffer.alloc(13);
  d.writeUInt32BE(w, 0);
  d.writeUInt32BE(h, 4);
  d[8] = 8;
  d[9] = colorType;
  return chunk('IHDR', d);
};
const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const png = (opts: { w?: number; h?: number; extra?: Buffer[]; trailing?: Buffer; badCrc?: boolean } = {}) =>
  Buffer.concat([
    SIG,
    ihdr(opts.w ?? 1, opts.h ?? 1),
    ...(opts.extra ?? []),
    chunk('IDAT', deflateSync(Buffer.from([0, 255, 0, 0, 255])), opts.badCrc),
    chunk('IEND'),
    ...(opts.trailing ? [opts.trailing] : []),
  ]);

const seg = (marker: number, data: Buffer) => {
  const len = Buffer.alloc(2);
  len.writeUInt16BE(data.length + 2);
  return Buffer.concat([Buffer.from([0xff, marker]), len, data]);
};
const jpeg = (opts: { w?: number; h?: number; withExif?: boolean; trailing?: Buffer; noEoi?: boolean } = {}) => {
  const sof = Buffer.alloc(9);
  sof[0] = 8;
  sof.writeUInt16BE(opts.h ?? 1, 1);
  sof.writeUInt16BE(opts.w ?? 1, 3);
  sof[5] = 1;
  sof[6] = 1;
  sof[7] = 0x11;
  sof[8] = 0;
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    seg(0xe0, Buffer.from('JFIF\0\x01\x01\0\0\x01\0\x01\0\0', 'latin1')),
    ...(opts.withExif ? [seg(0xe1, Buffer.from('Exif\0\0GPS-LATITUDE-23.55S MAKE-APARELHO', 'latin1')), seg(0xfe, Buffer.from('comentario-com-nome-da-pessoa'))] : []),
    seg(0xdb, Buffer.alloc(65, 1)),
    seg(0xc0, sof),
    seg(0xc4, Buffer.concat([Buffer.from([0x00]), Buffer.alloc(16), Buffer.from([0])])),
    seg(0xda, Buffer.from([1, 1, 0, 0, 0x3f, 0])),
    Buffer.from([0x12, 0x34, 0xff, 0x00, 0x56]), // dados da imagem (com byte stuffing)
    ...(opts.noEoi ? [] : [Buffer.from([0xff, 0xd9])]),
    ...(opts.trailing ? [opts.trailing] : []),
  ]);
};

const riff = (chunks: Buffer[], lieAboutSize = 0) => {
  const payload = Buffer.concat([Buffer.from('WEBP', 'latin1'), ...chunks]);
  const head = Buffer.alloc(8);
  head.write('RIFF', 0, 'latin1');
  head.writeUInt32LE(payload.length + lieAboutSize, 4);
  return Buffer.concat([head, payload]);
};
const wchunk = (type: string, data: Buffer) => {
  const head = Buffer.alloc(8);
  head.write(type, 0, 'latin1');
  head.writeUInt32LE(data.length, 4);
  return Buffer.concat([head, data, ...(data.length & 1 ? [Buffer.from([0])] : [])]);
};
const vp8l = (w = 1, h = 1) => {
  const d = Buffer.alloc(5);
  d[0] = 0x2f;
  d.writeUInt32LE((w - 1) | ((h - 1) << 14), 1);
  return wchunk('VP8L', d);
};
const vp8x = (flags: number, w = 1, h = 1) => {
  const d = Buffer.alloc(10);
  d[0] = flags;
  d.writeUIntLE(w - 1, 4, 3);
  d.writeUIntLE(h - 1, 7, 3);
  return wchunk('VP8X', d);
};

const codeOf = (fn: () => unknown) => {
  try {
    fn();
  } catch (e: any) {
    return e.code as string;
  }
  return 'NO_ERROR';
};

describe('imagem do produto — validação e saneamento', () => {
  it('PNG válido: aceito, dimensões lidas, nenhum byte a mais', () => {
    const input = png({ w: 640, h: 480 });
    const out = sanitizeProductImage(input);
    expect(out).toMatchObject({ mimeType: 'image/png', width: 640, height: 480 });
    expect(out.data.equals(input)).toBe(true);
  });

  it('PNG: texto/EXIF/data saem; blocos de imagem ficam; o resultado continua sendo um PNG íntegro', () => {
    const input = png({ extra: [chunk('tEXt', Buffer.from('Author\0Fulano de Tal')), chunk('eXIf', Buffer.from('GPS')), chunk('tIME', Buffer.alloc(7)), chunk('pHYs', Buffer.alloc(9))] });
    const out = sanitizeProductImage(input);
    expect(out.data.includes(Buffer.from('Fulano de Tal'))).toBe(false);
    expect(out.data.includes(Buffer.from('eXIf'))).toBe(false);
    expect(out.data.includes(Buffer.from('pHYs'))).toBe(true);
    expect(out.data.length).toBeLessThan(input.length);
    expect(() => sanitizeProductImage(out.data)).not.toThrow(); // idempotente: já é limpo
  });

  it('PNG recusado: CRC errado, bytes depois do IEND (poliglota), truncado, sem IHDR, bloco crítico desconhecido, dimensões absurdas', () => {
    expect(codeOf(() => sanitizeProductImage(png({ badCrc: true })))).toBe('IMAGE_INVALID');
    expect(codeOf(() => sanitizeProductImage(png({ trailing: Buffer.from('<script>alert(1)</script>') })))).toBe('IMAGE_TRAILING_DATA');
    expect(codeOf(() => sanitizeProductImage(png({ trailing: Buffer.from('PK\x03\x04conteudo-zip') })))).toBe('IMAGE_TRAILING_DATA');
    expect(codeOf(() => sanitizeProductImage(png().subarray(0, 40)))).toBe('IMAGE_INVALID');
    expect(codeOf(() => sanitizeProductImage(Buffer.concat([SIG, chunk('IDAT', Buffer.from([1])), chunk('IEND')])))).toBe('IMAGE_INVALID');
    expect(codeOf(() => sanitizeProductImage(png({ extra: [chunk('ZZZZ', Buffer.from('x'))] })))).toBe('IMAGE_UNSUPPORTED_CHUNK');
    expect(codeOf(() => sanitizeProductImage(png({ w: 5000, h: 10 })))).toBe('IMAGE_DIMENSIONS_TOO_LARGE');
    expect(codeOf(() => sanitizeProductImage(png({ w: 0, h: 10 })))).toBe('IMAGE_DIMENSIONS_INVALID');
    expect(codeOf(() => sanitizeProductImage(png({ w: 4096, h: 4096 })))).toBe('NO_ERROR');
  });

  it('JPEG válido: aceito; EXIF (GPS, aparelho) e comentários saem; JFIF e dados da imagem ficam', () => {
    const input = jpeg({ w: 800, h: 600, withExif: true });
    expect(input.includes(Buffer.from('GPS-LATITUDE'))).toBe(true);
    const out = sanitizeProductImage(input);
    expect(out).toMatchObject({ mimeType: 'image/jpeg', width: 800, height: 600 });
    expect(out.data.includes(Buffer.from('GPS-LATITUDE'))).toBe(false);
    expect(out.data.includes(Buffer.from('MAKE-APARELHO'))).toBe(false);
    expect(out.data.includes(Buffer.from('comentario-com-nome'))).toBe(false);
    expect(out.data.includes(Buffer.from('JFIF'))).toBe(true);
    expect(out.data.subarray(-2).equals(Buffer.from([0xff, 0xd9]))).toBe(true);
    expect(sanitizeProductImage(out.data).data.equals(out.data)).toBe(true);
  });

  it('JPEG recusado: dados depois do EOI (HTML/PHP escondido), sem EOI, truncado, dimensões absurdas', () => {
    expect(codeOf(() => sanitizeProductImage(jpeg({ trailing: Buffer.from('<?php system($_GET[1]); ?>') })))).toBe('IMAGE_TRAILING_DATA');
    expect(codeOf(() => sanitizeProductImage(jpeg({ noEoi: true })))).toBe('IMAGE_INVALID');
    expect(codeOf(() => sanitizeProductImage(jpeg().subarray(0, 30)))).toBe('IMAGE_INVALID');
    expect(codeOf(() => sanitizeProductImage(jpeg({ w: 9000, h: 100 })))).toBe('IMAGE_DIMENSIONS_TOO_LARGE');
  });

  it('WebP: aceito (lossless e extendido); EXIF e XMP saem e a marca é limpa; animado, tamanho mentido e lixo são recusados', () => {
    expect(sanitizeProductImage(riff([vp8l(32, 16)]))).toMatchObject({ mimeType: 'image/webp', width: 32, height: 16 });
    const input = riff([vp8x(0x08 | 0x04 | 0x10, 32, 16), vp8l(32, 16), wchunk('EXIF', Buffer.from('GPS-LAT-1')), wchunk('XMP ', Buffer.from('<x:xmpmeta>pessoa</x:xmpmeta>'))]);
    const out = sanitizeProductImage(input);
    expect(out).toMatchObject({ mimeType: 'image/webp', width: 32, height: 16 });
    expect(out.data.includes(Buffer.from('GPS-LAT-1'))).toBe(false);
    expect(out.data.includes(Buffer.from('xmpmeta'))).toBe(false);
    const flags = out.data[out.data.indexOf(Buffer.from('VP8X')) + 8];
    expect(flags & (0x04 | 0x08)).toBe(0);
    expect(flags & 0x10).toBe(0x10); // alfa continua
    expect(out.data.readUInt32LE(4) + 8).toBe(out.data.length);
    expect(codeOf(() => sanitizeProductImage(riff([vp8x(0x02), vp8l()])))).toBe('IMAGE_ANIMATED');
    expect(codeOf(() => sanitizeProductImage(riff([vp8l(), wchunk('ANMF', Buffer.alloc(16))])))).toBe('IMAGE_ANIMATED');
    expect(codeOf(() => sanitizeProductImage(riff([vp8l()], 100)))).toBe('IMAGE_TRAILING_DATA');
    expect(codeOf(() => sanitizeProductImage(Buffer.concat([riff([vp8l()]), Buffer.from('<html>')])))).toBe('IMAGE_TRAILING_DATA');
    expect(codeOf(() => sanitizeProductImage(riff([wchunk('JUNK', Buffer.alloc(4))])))).toBe('IMAGE_INVALID');
    expect(codeOf(() => sanitizeProductImage(riff([vp8l(5000, 5)])))).toBe('IMAGE_DIMENSIONS_TOO_LARGE');
  });

  it('outros formatos e disfarces são recusados pelo CONTEÚDO, qualquer que seja a extensão ou o tipo declarado', () => {
    const samples: Record<string, Buffer> = {
      svg: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'),
      html: Buffer.from('<!doctype html><script>alert(1)</script>'),
      gif: Buffer.from('GIF89a\x01\x00\x01\x00\x80\x00\x00\xff\xff\xff\x00\x00\x00;', 'latin1'),
      pdf: Buffer.from('%PDF-1.4\n1 0 obj\n'),
      exe: Buffer.concat([Buffer.from('MZ'), Buffer.alloc(100)]),
      elf: Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46]), Buffer.alloc(100)]),
      zip: Buffer.concat([Buffer.from('PK\x03\x04'), Buffer.alloc(100)]),
      script: Buffer.from('#!/bin/sh\nrm -rf /\n'),
      text: Buffer.from('apenas texto'),
    };
    for (const [name, buf] of Object.entries(samples)) expect([name, codeOf(() => sanitizeProductImage(buf))]).toEqual([name, 'IMAGE_TYPE_UNSUPPORTED']);
    expect(detectImageType(Buffer.from('RIFF1234WAVEfmt '))).toBeNull();
  });

  it('vazio e acima do limite de tamanho', () => {
    expect(codeOf(() => sanitizeProductImage(Buffer.alloc(0)))).toBe('IMAGE_EMPTY');
    expect(codeOf(() => sanitizeProductImage(Buffer.alloc(PRODUCT_IMAGE_LIMITS.maxBytes + 1, 1)))).toBe('IMAGE_TOO_LARGE');
  });
});
