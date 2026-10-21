// Auditor ESTÁTICO do design CÓRTEX no Admin Web — usado só pelos testes `lib/design-*.test.ts`
// (jest, ambiente node, lendo arquivos). Nenhum código de runtime importa este arquivo.
//
// Por que existe: o design do Admin Web (tokens, temas, KPIs neutros, sem roxo/gradiente/glow, tema só em
// Configurações → Aparência) já foi refeito uma vez sem nenhuma trava — qualquer commit de outra frente
// (backend, PDV, telas novas) podia desfazê-lo em silêncio. Estas regras transformam a especificação
// escrita em teste que FALHA quando alguém a quebra.
//
// Os padrões abaixo ficam em regex (não em strings de classe prontas) e os testes montam os exemplos
// sintéticos por concatenação, para o Tailwind não gerar CSS proibido a partir deste arquivo
// (o `content` do tailwind.config.js também ignora *.test.ts e este auxiliar).

import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';

export const ADMIN_ROOT = path.resolve(__dirname, '..');
export const REPO_ROOT = path.resolve(ADMIN_ROOT, '..', '..');

export interface Violation {
  file: string;
  line: number;
  rule: string;
  detail: string;
}

export function toRel(file: string, base: string = ADMIN_ROOT): string {
  return path.relative(base, file).split(path.sep).join('/');
}

export function readText(file: string): string {
  return fs.readFileSync(file, 'utf8');
}

/** Lista recursiva de arquivos por extensão, ignorando node_modules/.next e os próprios testes. */
export function listFiles(dir: string, exts: string[]): string[] {
  const out: string[] = [];
  const walk = (current: string) => {
    if (!fs.existsSync(current)) return;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '.next') continue;
        walk(full);
      } else if (exts.some((e) => entry.name.endsWith(e)) && !/\.test\.tsx?$/.test(entry.name)) {
        out.push(full);
      }
    }
  };
  walk(dir);
  return out.sort();
}

/** Todos os .ts/.tsx de app/** e components/** (o que o usuário enxerga). */
export function listUiSources(): string[] {
  return [
    ...listFiles(path.join(ADMIN_ROOT, 'app'), ['.ts', '.tsx']),
    ...listFiles(path.join(ADMIN_ROOT, 'components'), ['.ts', '.tsx']),
  ];
}

// ---------------------------------------------------------------------------
// AST / texto
// ---------------------------------------------------------------------------

export function parseSource(source: string, fileName: string): ts.SourceFile {
  const kind = fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  return ts.createSourceFile(fileName, source, ts.ScriptTarget.ES2020, true, kind);
}

export interface TextPiece {
  text: string;
  line: number;
  kind: 'string' | 'jsxText';
}

/**
 * Literais de texto do código (strings, templates, texto JSX) — ignora comentários. Comentários que
 * documentam "antes era X" não podem disparar as regras de proibição.
 */
export function extractTextPieces(source: string, fileName: string): TextPiece[] {
  const sf = parseSource(source, fileName);
  const pieces: TextPiece[] = [];
  const lineOf = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  const visit = (n: ts.Node) => {
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) {
      pieces.push({ text: n.text, line: lineOf(n), kind: 'string' });
    } else if (ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n)) {
      pieces.push({ text: n.text, line: lineOf(n), kind: 'string' });
    } else if (ts.isJsxText(n)) {
      pieces.push({ text: n.text, line: lineOf(n), kind: 'jsxText' });
    }
    n.forEachChild(visit);
  };
  visit(sf);
  return pieces;
}

/** CSS sem comentários, uma entrada por linha (com número da linha original). */
export function cssLines(source: string): Array<{ text: string; line: number }> {
  const noComments = source.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
  return noComments.split('\n').map((text, i) => ({ text, line: i + 1 }));
}

// ---------------------------------------------------------------------------
// Cor
// ---------------------------------------------------------------------------

export interface Hsl {
  h: number;
  s: number;
  l: number;
}

export function hexToHsl(hex: string): Hsl {
  let h = hex.replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const r = parseInt(h.slice(0, 2), 16) / 255;
  const g = parseInt(h.slice(2, 4), 16) / 255;
  const b = parseInt(h.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return { h: 0, s: 0, l: l * 100 };
  const s = d / (1 - Math.abs(2 * l - 1));
  let hue: number;
  if (max === r) hue = ((g - b) / d) % 6;
  else if (max === g) hue = (b - r) / d + 2;
  else hue = (r - g) / d + 4;
  hue *= 60;
  if (hue < 0) hue += 360;
  return { h: hue, s: s * 100, l: l * 100 };
}

/** "222 47% 11%" (formato dos tokens shadcn/CÓRTEX) -> Hsl. Null se não for o formato. */
export function parseHslTriplet(value: string): Hsl | null {
  const m = value.trim().match(/^(\d{1,3}(?:\.\d+)?)\s+(\d{1,3}(?:\.\d+)?)%\s+(\d{1,3}(?:\.\d+)?)%$/);
  if (!m) return null;
  return { h: Number(m[1]), s: Number(m[2]), l: Number(m[3]) };
}

/** Roxo/violeta/magenta/fúcsia (matiz >= 238) com saturação perceptível. Azul-naval (~222) e cinza-ardósia (~215) ficam de fora. */
export function isPurplish(c: Hsl): boolean {
  return c.s >= 20 && c.h >= 238 && c.h <= 335;
}

/** Cor "neon": saturação altíssima em luminosidade média (brilha no fundo escuro). */
export function isNeon(c: Hsl): boolean {
  return c.s >= 95 && c.l >= 45 && c.l <= 65;
}

function hslToRgb({ h, s, l }: Hsl): [number, number, number] {
  const S = s / 100;
  const L = l / 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = S * Math.min(L, 1 - L);
  const f = (n: number) => L - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [f(0), f(8), f(4)];
}

function luminance(c: Hsl): number {
  const [r, g, b] = hslToRgb(c).map((v) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Razão de contraste WCAG entre duas cores HSL. */
export function contrastRatio(a: Hsl, b: Hsl): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

// ---------------------------------------------------------------------------
// Tokens (globals.css)
// ---------------------------------------------------------------------------

export interface TokenBlocks {
  light: Record<string, string>;
  dark: Record<string, string>;
}

/** Lê as declarações `--x: v;` dos blocos `:root` (claro) e `.dark` (escuro) — não das regras `.dark .classe`. */
export function parseTokenBlocks(css: string): TokenBlocks {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const grab = (selector: RegExp): Record<string, string> => {
    const out: Record<string, string> = {};
    const re = new RegExp(`(?:^|[\\s}])${selector.source}\\s*\\{([^}]*)\\}`, 'g');
    let m: RegExpExecArray | null;
    while ((m = re.exec(clean))) {
      for (const decl of m[1].split(';')) {
        const idx = decl.indexOf(':');
        if (idx === -1) continue;
        const name = decl.slice(0, idx).trim();
        if (name.startsWith('--') || name === 'color-scheme') out[name.replace(/^--/, '')] = decl.slice(idx + 1).trim();
      }
    }
    return out;
  };
  return { light: grab(/:root/), dark: grab(/\.dark/) };
}

// ---------------------------------------------------------------------------
// Regras de proibição (roxo, gradiente, glow, cor fixa)
// ---------------------------------------------------------------------------

const B = String.raw`(?<![\w-])`; // início de "palavra de classe" (o `:` de variantes hover: etc. é permitido antes)
const E = String.raw`(?![\w-])`;

const PURPLE_CLASS = new RegExp(`${B}(?:[a-z]+-)+(?:purple|violet|fuchsia|indigo)(?:-\\d{2,3})?(?:\\/\\d{1,3})?${E}`);
const GRADIENT_CLASS = new RegExp(`${B}bg-(?:gradient-to-[a-z]{1,2}|linear-to-[a-z]{1,2})${E}`);
const GRADIENT_STOP = new RegExp(
  `${B}(?:from|via|to)-(?:\\[[^\\]]+\\]|[a-z]+-\\d{2,3}|white|black|transparent|current|inherit|(?:background|foreground|card|muted|accent|primary|secondary|success|warning|danger|border)(?![\\w]))(?:\\/\\d{1,3})?`
);
const GRADIENT_FN = /(?:linear|radial|conic)-gradient\s*\(/;
const HEX = /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3})(?![0-9a-zA-Z_-])/g;
// `\b` falha quando o dígito/letra anterior é "_" (Tailwind usa "_" no lugar de espaço em valores
// arbitrários: "shadow-[0_0_20px_rgba(0,255,255,0.8)]") — "_" é \w, então não há fronteira de \b entre
// "_" e "r". `(?<![a-zA-Z])` aceita "_", dígito, "(", início de string etc. antes da função de cor, e só
// recusa quando faz parte de outro identificador (ex.: "minhaRgba(").
const COLOR_FN = /(?<![a-zA-Z])(?:rgba?|hsla?)\(\s*\d/;
const COLORED_SHADOW = new RegExp(
  `${B}(?:drop-)?shadow-(?:red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)(?:-\\d{2,3})?(?:\\/\\d{1,3})?${E}`
);
const DROP_SHADOW_ARBITRARY = new RegExp(`${B}drop-shadow-\\[[^\\]]+\\]`);
const TEXT_SHADOW = new RegExp(`${B}(?:text-shadow|\\[text-shadow:)`);
const ARBITRARY_SHADOW = new RegExp(`${B}shadow-\\[([^\\]]+)\\]`, 'g');
const NEUTRAL_SHADOW_TOKEN = /hsl\(var\(--(?:border|primary|ring|foreground|muted-foreground|accent|background|card)\)(?:\s*\/\s*[\d.]+%?)?\)/g;
const CSS_COLOR_WORD = /(?:^|_|\s|,)(?:red|orange|amber|yellow|lime|green|emerald|teal|cyan|aqua|sky|blue|indigo|violet|purple|fuchsia|magenta|pink|rose|lime|fuchsia)(?:_|\s|,|$)/i;

function push(out: Violation[], file: string, line: number, rule: string, detail: string) {
  out.push({ file, line, rule, detail });
}

/** Roxo/violeta/fúcsia/índigo: classes Tailwind e cores hex/hsl literais de matiz roxo. */
export function findPurple(source: string, fileName: string): Violation[] {
  const out: Violation[] = [];
  for (const p of extractTextPieces(source, fileName)) {
    const m = p.text.match(PURPLE_CLASS);
    if (m) push(out, fileName, p.line, 'roxo', `classe "${m[0]}"`);
    if (p.kind === 'string') {
      for (const hex of p.text.match(HEX) ?? []) {
        if (isPurplish(hexToHsl(hex))) push(out, fileName, p.line, 'roxo', `cor ${hex} (matiz roxo/magenta)`);
      }
      const hsl = p.text.match(/hsla?\(\s*(\d{1,3}(?:\.\d+)?)[\s,]+(\d{1,3}(?:\.\d+)?)%/);
      if (hsl && isPurplish({ h: Number(hsl[1]), s: Number(hsl[2]), l: 50 })) {
        push(out, fileName, p.line, 'roxo', `cor ${hsl[0]}...) (matiz roxo/magenta)`);
      }
    }
  }
  return out;
}

/** Gradiente decorativo: bg-gradient-*, from-/via-/to-, linear/radial-gradient(). */
export function findGradients(source: string, fileName: string): Violation[] {
  const out: Violation[] = [];
  for (const p of extractTextPieces(source, fileName)) {
    for (const re of [GRADIENT_CLASS, GRADIENT_STOP, GRADIENT_FN]) {
      const m = p.text.match(re);
      if (m) push(out, fileName, p.line, 'gradiente', `"${m[0]}"`);
    }
  }
  return out;
}

/** Neon/glow: sombra colorida, drop-shadow arbitrário, text-shadow, shadow-[...] com cor que não seja token neutro. */
export function findGlow(source: string, fileName: string): Violation[] {
  const out: Violation[] = [];
  for (const p of extractTextPieces(source, fileName)) {
    for (const [re, label] of [
      [COLORED_SHADOW, 'sombra colorida'],
      [DROP_SHADOW_ARBITRARY, 'drop-shadow arbitrário'],
      [TEXT_SHADOW, 'text-shadow'],
    ] as Array<[RegExp, string]>) {
      const m = p.text.match(re);
      if (m) push(out, fileName, p.line, 'glow', `${label}: "${m[0]}"`);
    }
    ARBITRARY_SHADOW.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = ARBITRARY_SHADOW.exec(p.text))) {
      const rest = m[1].replace(NEUTRAL_SHADOW_TOKEN, '');
      if (/#[0-9a-fA-F]{3,8}/.test(rest) || COLOR_FN.test(rest) || /hsla?\(/.test(rest) || CSS_COLOR_WORD.test(rest)) {
        push(out, fileName, p.line, 'glow', `shadow-[${m[1]}] com cor fora dos tokens neutros`);
      }
    }
  }
  return out;
}

/**
 * Cor FIXA em código de tela (hex, rgb(), hsl(números)): cores vêm dos tokens (`hsl(var(--x))`, classes
 * do Tailwind ligadas aos tokens ou lib/chart-theme.ts). É o que deixava os gráficos com grade branca no
 * tema escuro e barras azul-vivo fora da paleta.
 */
export function findFixedColors(source: string, fileName: string): Violation[] {
  const out: Violation[] = [];
  for (const p of extractTextPieces(source, fileName)) {
    if (p.kind !== 'string') continue;
    for (const hex of p.text.match(HEX) ?? []) push(out, fileName, p.line, 'cor-fixa', `hex ${hex}`);
    const fn = p.text.match(COLOR_FN);
    if (fn) push(out, fileName, p.line, 'cor-fixa', `função de cor literal "${fn[0]}"`);
  }
  return out;
}

const PALETTE_CLASS = new RegExp(
  `${B}(?:bg|text|border|ring|fill|stroke|divide|placeholder|outline|from|via|to)-(?:gray|slate|zinc|neutral|stone|red|green|blue|amber|yellow|orange|emerald|teal|cyan|sky|lime|white|black)(?:-\\d{2,3})?(?:\\/\\d{1,3})?${E}`
);

/**
 * Paleta fixa do Tailwind (`bg-white`, `text-gray-500`, `text-blue-600`...) — proibida nos arquivos JÁ
 * migrados para tokens (lista em design-forbidden.test.ts). Telas antigas ainda usam paleta fixa e são
 * cobertas pela camada `.dark` de globals.css (docs/CORTEX/historico/registro-de-auditoria-2026-09-14-a-25.md C2).
 */
export function findFixedPalette(source: string, fileName: string): Violation[] {
  const out: Violation[] = [];
  for (const p of extractTextPieces(source, fileName)) {
    if (p.kind !== 'string') continue;
    const re = new RegExp(PALETTE_CLASS.source, 'g');
    let m: RegExpExecArray | null;
    while ((m = re.exec(p.text))) push(out, fileName, p.line, 'paleta-fixa', `classe "${m[0]}" (use o token: bg-card, text-foreground, text-muted-foreground, bg-primary, text-danger...)`);
  }
  return out;
}

/** Roda a lista de regras sobre css cru (comentários removidos). */
export function findInCss(source: string, fileName: string, rules: Array<'gradiente' | 'glow-css'>): Violation[] {
  const out: Violation[] = [];
  for (const { text, line } of cssLines(source)) {
    if (rules.includes('gradiente') && GRADIENT_FN.test(text)) push(out, fileName, line, 'gradiente', text.trim());
    if (rules.includes('glow-css') && /(?:text-shadow|drop-shadow\()/i.test(text)) push(out, fileName, line, 'glow', text.trim());
  }
  return out;
}

// ---------------------------------------------------------------------------
// KPI: o valor numérico nunca é verde/vermelho (nem âmbar) — a variação vai em seta/indicador
// ---------------------------------------------------------------------------
//
// Como o "elemento de valor de KPI" é identificado (olhando dashboard/page.tsx, financial, sales, quotes...):
//   (a) elemento JSX com tipografia de número grande (`text-2xl` ou maior) cujos filhos diretos incluem uma
//       expressão numérica ({value}, {formatCurrency(..)}, {x.total}, {String(..)}, .toFixed(), .length...); ou
//   (b) elemento com `text-lg`/`text-xl` + `font-semibold|bold` e expressão numérica; ou
//   (c) qualquer elemento com expressão numérica dentro de um componente cujo nome contém Kpi/Stat/Metric/
//       Indicator (KpiCard, FinancialStat...).
// O texto de classe é resolvido também através de variáveis locais (`${toneClass}`, `tones[tone]`).
// NÃO é KPI (não é flagrado): seta/ícone/ponto de variação e status (o "indicador"), célula de tabela,
// mensagem de erro/alerta. Esses podem usar success/warning/danger.

const SEMANTIC_TEXT = new RegExp(
  `${B}text-(?:(?:green|red|emerald|lime|rose|amber|yellow|orange)(?:-\\d{2,3})?|success|danger|warning)(?:\\/\\d{1,3})?${E}`
);
const NON_NEUTRAL_ICON = new RegExp(
  `${B}text-(?:(?:green|red|emerald|lime|rose|amber|yellow|orange|blue|sky|cyan|teal|indigo|violet|purple|fuchsia|pink)(?:-\\d{2,3})?|success|danger|warning)(?:\\/\\d{1,3})?${E}`
);
const KPI_COMPONENT_NAME = /kpi|stat(?!us)|metric|indicator/i;
const BIG_TEXT = new RegExp(`${B}text-(?:2xl|3xl|4xl|5xl|6xl|7xl|8xl|9xl)${E}`);
const MID_TEXT = new RegExp(`${B}text-(?:lg|xl)${E}`);
const EMPHASIS = new RegExp(`${B}font-(?:semibold|bold|extrabold)${E}`);
const NUMERIC_EXPR =
  /format\w*\(|tofixed\(|tolocalestring\(|numberformat|\bstring\(|\bnumber\(|\.length\b|value|count|total|amount|qty|quantity|revenue|balance|ticket|percent|cents|price|\bsum\b|\bavg\b/;

function collectDeclarations(sf: ts.SourceFile): Map<string, ts.Node[]> {
  const map = new Map<string, ts.Node[]>();
  const visit = (n: ts.Node) => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) {
      const list = map.get(n.name.text) ?? [];
      list.push(n.initializer);
      map.set(n.name.text, list);
    }
    n.forEachChild(visit);
  };
  visit(sf);
  return map;
}

function stringsOf(node: ts.Node, decls: Map<string, ts.Node[]>, depth = 0, seen = new Set<ts.Node>()): string[] {
  if (seen.has(node)) return [];
  seen.add(node);
  const parts: string[] = [];
  if (ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
    parts.push(node.text);
  } else if (ts.isIdentifier(node) && depth < 3) {
    for (const init of decls.get(node.text) ?? []) parts.push(...stringsOf(init, decls, depth + 1, seen));
  }
  // Bloco com chaves: `forEachChild` PARA no primeiro retorno truthy, e `push` devolve o tamanho do array —
  // com a arrow de expressão, as classes dentro de `${...}` (condicional, toneClass) eram ignoradas.
  node.forEachChild((c) => {
    parts.push(...stringsOf(c, decls, depth, seen));
  });
  return parts;
}

function enclosingComponentName(node: ts.Node): string | null {
  for (let cur: ts.Node | undefined = node.parent; cur; cur = cur.parent) {
    if (ts.isFunctionDeclaration(cur) && cur.name) return cur.name.text;
    if ((ts.isArrowFunction(cur) || ts.isFunctionExpression(cur)) && ts.isVariableDeclaration(cur.parent) && ts.isIdentifier(cur.parent.name)) {
      return cur.parent.name.text;
    }
  }
  return null;
}

export function findKpiViolations(source: string, fileName: string): Violation[] {
  const out: Violation[] = [];
  const sf = parseSource(source, fileName);
  const decls = collectDeclarations(sf);
  const lineOf = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;

  const visit = (n: ts.Node) => {
    if (ts.isJsxElement(n)) {
      const classAttr = n.openingElement.attributes.properties.find(
        (a): a is ts.JsxAttribute => ts.isJsxAttribute(a) && ts.isIdentifier(a.name) && a.name.text === 'className'
      );
      if (classAttr && classAttr.initializer) {
        const classText = stringsOf(classAttr.initializer, decls).join(' ');
        const numericChild = n.children.some((c) => ts.isJsxExpression(c) && NUMERIC_EXPR.test(c.getText(sf).toLowerCase()));
        if (numericChild) {
          const comp = enclosingComponentName(n);
          const isKpiValue =
            BIG_TEXT.test(classText) ||
            (MID_TEXT.test(classText) && EMPHASIS.test(classText)) ||
            (comp !== null && KPI_COMPONENT_NAME.test(comp));
          const bad = classText.match(SEMANTIC_TEXT);
          if (isKpiValue && bad) {
            push(out, fileName, lineOf(n), 'kpi-valor-colorido', `valor de KPI com "${bad[0]}" — o número é neutro (text-foreground); use seta/ponto/ícone para a variação ou o estado`);
          }
        }
      }
    }
    // Ícone de KPI colorido por prop (iconColor="text-green-600"): decoração com cor semântica.
    if (ts.isJsxAttribute(n) && ts.isIdentifier(n.name) && /^icon(?:Color|Class(?:Name)?)$/.test(n.name.text) && n.initializer) {
      const text = stringsOf(n.initializer, decls).join(' ');
      const bad = text.match(NON_NEUTRAL_ICON);
      if (bad) push(out, fileName, lineOf(n), 'kpi-icone-colorido', `${n.name.text}="${bad[0]}" — ícone de KPI é neutro (cor semântica só em indicador de estado)`);
    }
    n.forEachChild(visit);
  };
  visit(sf);
  return out;
}

export function formatViolations(vs: Violation[], base: string = ADMIN_ROOT): string {
  return vs.map((v) => `  ${toRel(v.file, base)}:${v.line}  [${v.rule}] ${v.detail}`).join('\n');
}
