// Gera os ativos de marca do CÓRTEX a partir do símbolo vetorizado (brand/svg/cortex-mark.svg) e do que as pranchas oficiais mostram.
//   node brand/build-assets.js            → escreve só em brand/ (svg, png, ico)
//   node brand/build-assets.js --apply    → também copia para os aplicativos (ver o bloco APPLY abaixo)
// Precisa do Chrome (CHROME_PATH ou o caminho padrão do Windows) e de playwright-core (já no monorepo).
// O símbolo foi vetorizado do recorte ampliado da prancha 3 (faces brancas por baixo, faces cinza por cima); não é um redesenho.
// Quando o proprietário enviar o arquivo vetorial ORIGINAL, substitua brand/svg/cortex-mark.svg e rode este script de novo.
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');

const ROOT = path.resolve(__dirname, '..');
const OUT = __dirname;
const APPLY = process.argv.includes('--apply');
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';

// cores lidas das pranchas (paleta oficial) e do ícone do app na prancha (azulado escuro do ladrilho)
const C = { naval: '#050A10', noturno: '#091018', grafite: '#10171F', borda: '#1C2733', offwhite: '#F6F7F9', tileA: '#0E1B25', tileB: '#050F18', escuroMarca: '#071016', escuroFace: '#0F1D2A' };

const markSrc = fs.readFileSync(path.join(OUT, 'svg/cortex-mark.svg'), 'utf8');
const vb = markSrc.match(/viewBox="0 0 ([\d.]+) ([\d.]+)"/);
const VBW = +vb[1], VBH = +vb[2];
const inner = markSrc.replace(/^<svg[^>]*>/, '').replace(/<\/svg>$/, '');

// variações do símbolo (mesmas formas): cor (fundo escuro), sobre fundo claro, monocromática branca
const noDefs = inner.replace(/<defs>.*?<\/defs>/, '');
const marks = {
  color: inner,
  onLight: noDefs.replace(/<path fill="url\(#w\d\)"/g, `<path fill="${C.escuroMarca}"`).replace(/<path fill="#[0-9a-f]{6}"/g, `<path fill="${C.escuroFace}"`),
  monoWhite: noDefs.replace(/<path fill="url\(#w\d\)"/g, `<path fill="${C.offwhite}"`).replace(/<path fill="#[0-9a-f]{6}"/g, `<path fill="${C.offwhite}" fill-opacity=".62"`),
};
const svgDoc = (w, h, body, extra = '') => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" ${extra}>${body}</svg>`;
const markDoc = (kind) => svgDoc(VBW, VBH, marks[kind], 'role="img" aria-label="CÓRTEX"');

// ladrilho do ícone do aplicativo: ladrilho azulado escuro com borda fina e o símbolo (~68% da altura)
function tile({ kind = 'color', fill = 'dark', height = 0.68, rounded = true }) {
  const s = (100 * height) / VBH, w = VBW * s;
  const bgDark = `<defs><linearGradient id="tg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${C.tileA}"/><stop offset="1" stop-color="${C.tileB}"/></linearGradient></defs>`;
  const bg = fill === 'dark'
    ? `${bgDark}<rect x="${rounded ? 0.6 : 0}" y="${rounded ? 0.6 : 0}" width="${rounded ? 98.8 : 100}" height="${rounded ? 98.8 : 100}" rx="${rounded ? 22 : 0}" fill="url(#tg)"${rounded ? ` stroke="${C.borda}" stroke-width="1.2"` : ''}/>`
    : '<rect x="0.6" y="0.6" width="98.8" height="98.8" rx="22" fill="#E1E6EC"/>';
  const g = `<g transform="translate(${((100 - w) / 2).toFixed(2)} ${((100 - 100 * height) / 2).toFixed(2)}) scale(${s.toFixed(5)})">${marks[kind]}</g>`;
  return svgDoc(100, 100, bg + g, 'role="img" aria-label="CÓRTEX"');
}
// camada para ícone adaptativo do Android: símbolo centrado em 1024 (zona segura = círculo central de 66%)
const adaptive = (kind) => {
  const h = 500, s = h / VBH, w = VBW * s;
  return svgDoc(1024, 1024, `<g transform="translate(${(1024 - w) / 2} ${(1024 - h) / 2}) scale(${s})">${marks[kind]}</g>`);
};
const solidBg = () => svgDoc(1024, 1024, `<defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${C.tileA}"/><stop offset="1" stop-color="${C.tileB}"/></linearGradient></defs><rect width="1024" height="1024" fill="url(#bg)"/>`);

const files = {
  'svg/cortex-mark.svg': markSrc, 'svg/cortex-mark-sobre-fundo-claro.svg': markDoc('onLight'), 'svg/cortex-mark-monocromatico-branco.svg': markDoc('monoWhite'),
  'svg/cortex-app-icon.svg': tile({}), 'svg/cortex-app-icon-fundo-claro.svg': tile({ kind: 'onLight', fill: 'light' }), 'svg/cortex-app-icon-pequeno.svg': tile({ height: 0.76 }),
};

(async () => {
  for (const [f, c] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(OUT, f)), { recursive: true }); fs.writeFileSync(path.join(OUT, f), c); }
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const page = await browser.newPage();
  const png = async (svg, w, h, file) => {
    await page.setViewportSize({ width: w, height: h });
    await page.setContent(`<body style="margin:0;background:transparent"><img style="display:block;width:${w}px;height:${h}px" src="data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}"></body>`);
    await page.waitForFunction(() => document.images[0].complete);
    const buf = await page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: w, height: h } });
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, buf); return buf;
  };
  const P = (n) => path.join(OUT, 'png', n);
  // símbolo com fundo transparente (proporção do símbolo)
  for (const hgt of [256, 512, 1024]) await png(markDoc('color'), Math.round((hgt * VBW) / VBH), hgt, P(`cortex-mark-${hgt}.png`));
  await png(markDoc('onLight'), Math.round((1024 * VBW) / VBH), 1024, P('cortex-mark-sobre-fundo-claro-1024.png'));
  await png(markDoc('monoWhite'), Math.round((1024 * VBW) / VBH), 1024, P('cortex-mark-monocromatico-branco-1024.png'));
  // ícone do app (ladrilho arredondado)
  const sizes = [16, 32, 48, 64, 128, 180, 192, 256, 512, 1024];
  const tileBuf = {};
  for (const sz of sizes) tileBuf[sz] = await png(sz <= 32 ? files['svg/cortex-app-icon-pequeno.svg'] : files['svg/cortex-app-icon.svg'], sz, sz, P(`cortex-app-icon-${sz}.png`));
  await png(files['svg/cortex-app-icon-fundo-claro.svg'], 512, 512, P('cortex-app-icon-fundo-claro-512.png'));
  // ícone quadrado cheio (Expo/iOS/lojas recortam sozinhos)
  await png(tile({ rounded: false, height: 0.6 }), 1024, 1024, P('cortex-app-icon-cheio-1024.png'));
  // Android: ícone adaptativo (primeiro plano, fundo, monocromático) e abertura
  await png(adaptive('color'), 1024, 1024, P('android-icon-foreground.png'));
  await png(solidBg(), 1024, 1024, P('android-icon-background.png'));
  await png(adaptive('monoWhite'), 1024, 1024, P('android-icon-monochrome.png'));
  await png(adaptive('color'), 1024, 1024, P('splash-icon.png'));
  // ICO: favicon (16/32/48/64) e ícone do Windows (16..256) — entradas PNG
  const ico = (list) => {
    const n = list.length; const head = Buffer.alloc(6 + 16 * n); head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(n, 4);
    let off = head.length; const blobs = [];
    list.forEach((sz, i) => { const b = tileBuf[sz]; const e = 6 + 16 * i; head.writeUInt8(sz >= 256 ? 0 : sz, e); head.writeUInt8(sz >= 256 ? 0 : sz, e + 1); head.writeUInt8(0, e + 2); head.writeUInt8(0, e + 3); head.writeUInt16LE(1, e + 4); head.writeUInt16LE(32, e + 6); head.writeUInt32LE(b.length, e + 8); head.writeUInt32LE(off, e + 12); off += b.length; blobs.push(b); });
    return Buffer.concat([head, ...blobs]);
  };
  fs.mkdirSync(path.join(OUT, 'ico'), { recursive: true });
  fs.writeFileSync(path.join(OUT, 'ico/favicon.ico'), ico([16, 32, 48, 64]));
  fs.writeFileSync(path.join(OUT, 'ico/cortex.ico'), ico([16, 32, 48, 64, 128, 256]));
  // Banner da Android TV (640x360 = 320x180 dp em xhdpi): logotipo horizontal recortado da prancha 2 (pixels da própria prancha, ~1:1) sobre o fundo da prancha.
  // Limite: é raster de ~690 px de largura; o vetor do logotipo completo depende do arquivo original do proprietário.
  const prancha2 = 'data:image/png;base64,' + fs.readFileSync(path.join(OUT, 'referencias/prancha-2-logo-tipografia-dashboard.png')).toString('base64');
  await page.setViewportSize({ width: 640, height: 360 });
  await page.setContent('<body style="margin:0"></body>');
  const bannerUrl = await page.evaluate(async (src) => {
    const img = new Image(); img.src = src; await img.decode();
    const c = document.createElement('canvas'); c.width = 640; c.height = 360; const g = c.getContext('2d', { willReadFrequently: true });
    const px = (() => { const t = document.createElement('canvas'); t.width = 1; t.height = 1; const tg = t.getContext('2d'); tg.drawImage(img, 70, 105, 1, 1, 0, 0, 1, 1); const d = tg.getImageData(0, 0, 1, 1).data; return `rgb(${d[0]},${d[1]},${d[2]})`; })();
    g.fillStyle = px; g.fillRect(0, 0, 640, 360);
    g.imageSmoothingQuality = 'high';
    const sx = 60, sy = 105, sw = 650, sh = 190, dw = 540, dh = Math.round((sh * dw) / sw);
    g.drawImage(img, sx, sy, sw, sh, (640 - dw) / 2, (360 - dh) / 2, dw, dh);
    return c.toDataURL('image/png');
  }, prancha2);
  fs.writeFileSync(path.join(OUT, 'png/tv-banner-640x360.png'), Buffer.from(bannerUrl.split(',')[1], 'base64'));
  await browser.close();

  if (APPLY) { // APPLY: destino de cada ativo nos aplicativos
    const cp = (from, to) => { const d = path.join(ROOT, to); fs.mkdirSync(path.dirname(d), { recursive: true }); fs.copyFileSync(path.join(OUT, from), d); console.log('→', to); };
    // Componente React do símbolo: usa os SVG como ARQUIVOS (sem cor fixa no código de tela — a guarda design-forbidden do Admin Web proíbe hex em .tsx).
    // Decorativo por padrão: o texto "CÓRTEX" fica ao lado; passe decorative={false} para expô-lo a leitores de tela.
    const head = '// GERADO por brand/build-assets.js a partir de brand/svg/*.svg — não edite à mão (rode o script de novo).\n// Símbolo hexagonal "C" do CÓRTEX. Decorativo por padrão (o texto da marca vem ao lado); passe decorative={false} para expô-lo a leitores de tela.\n';
    const alt = 'alt={decorative ? \'\' : \'CÓRTEX\'} aria-hidden={decorative ? true : undefined}';
    // Admin Web e Super Admin (Next, classe "dark"): símbolo em cor no fundo escuro; símbolo escuro no fundo claro (variante "sobre fundo claro" da prancha)
    const tsxBoth = `${head}/* eslint-disable @next/next/no-img-element */\nimport onDark from './brand-assets/cortex-mark.svg';\nimport onLight from './brand-assets/cortex-mark-sobre-fundo-claro.svg';\n\nexport function CortexMark({ className = '', decorative = true }: { className?: string; decorative?: boolean }) {\n  return (\n    <>\n      <img src={onDark.src} className={\`\${className} hidden dark:block\`} ${alt} />\n      <img src={onLight.src} className={\`\${className} block dark:hidden\`} ${alt} />\n    </>\n  );\n}\n`;
    // Balcão e PDV (Vite, sem tema automático): o chamador escolhe o tom pelo fundo (padrão: fundo claro)
    const tsxVite = `${head}import onDark from '../assets/brand/cortex-mark.svg';\nimport onLight from '../assets/brand/cortex-mark-sobre-fundo-claro.svg';\n\nexport function CortexMark({ className, decorative = true, tone = 'onLight' }: { className?: string; decorative?: boolean; tone?: 'onLight' | 'onDark' }) {\n  return <img src={tone === 'onDark' ? onDark : onLight} className={className} ${alt} />;\n}\n`;
    for (const app of ['admin-web', 'super-admin']) {
      fs.writeFileSync(path.join(ROOT, `apps/${app}/components/ui/cortex-mark.tsx`), tsxBoth); console.log('→', `apps/${app}/components/ui/cortex-mark.tsx`);
      cp('svg/cortex-mark.svg', `apps/${app}/components/ui/brand-assets/cortex-mark.svg`); cp('svg/cortex-mark-sobre-fundo-claro.svg', `apps/${app}/components/ui/brand-assets/cortex-mark-sobre-fundo-claro.svg`);
    }
    for (const [app, comp] of [['balcao', 'CortexMark'], ['pdv-desktop', 'CortexMark']]) {
      fs.writeFileSync(path.join(ROOT, `apps/${app}/src/components/${comp}.tsx`), tsxVite); console.log('→', `apps/${app}/src/components/${comp}.tsx`);
      cp('svg/cortex-mark.svg', `apps/${app}/src/assets/brand/cortex-mark.svg`); cp('svg/cortex-mark-sobre-fundo-claro.svg', `apps/${app}/src/assets/brand/cortex-mark-sobre-fundo-claro.svg`);
    }
    for (const app of ['mobile', 'tv']) cp('png/cortex-mark-256.png', `apps/${app}/assets/cortex-mark.png`);
    cp('png/tv-banner-640x360.png', 'apps/tv/assets/tv-banner.png');
    for (const app of ['admin-web', 'super-admin']) { cp('ico/favicon.ico', `apps/${app}/app/favicon.ico`); cp('png/cortex-app-icon-512.png', `apps/${app}/app/icon.png`); cp('png/cortex-app-icon-180.png', `apps/${app}/app/apple-icon.png`); }
    cp('ico/favicon.ico', 'apps/balcao/public/favicon.ico'); cp('svg/cortex-app-icon.svg', 'apps/balcao/public/favicon.svg'); cp('png/cortex-app-icon-180.png', 'apps/balcao/public/apple-touch-icon.png');
    cp('ico/favicon.ico', 'apps/pdv-desktop/public/favicon.ico'); cp('svg/cortex-app-icon.svg', 'apps/pdv-desktop/public/favicon.svg');
    // "build/" é ignorado pelo Git no monorepo inteiro: os ícones do instalador ficam em resources/ (package.json: build.directories.buildResources)
    cp('ico/cortex.ico', 'apps/pdv-desktop/resources/icon.ico'); cp('png/cortex-app-icon-512.png', 'apps/pdv-desktop/resources/icon.png');
    for (const app of ['mobile', 'tv']) {
      cp('png/cortex-app-icon-cheio-1024.png', `apps/${app}/assets/icon.png`); cp('png/android-icon-foreground.png', `apps/${app}/assets/android-icon-foreground.png`);
      cp('png/android-icon-background.png', `apps/${app}/assets/android-icon-background.png`); cp('png/android-icon-monochrome.png', `apps/${app}/assets/android-icon-monochrome.png`);
      cp('png/splash-icon.png', `apps/${app}/assets/splash-icon.png`); cp('png/cortex-app-icon-48.png', `apps/${app}/assets/favicon.png`);
    }
  }
  console.log('ok: ativos gerados em', OUT);
})();
