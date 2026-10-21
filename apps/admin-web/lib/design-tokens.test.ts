// GUARDA DE DESIGN 1/5 — tokens CÓRTEX (globals.css, tailwind.config.js, lib/theme.ts).
// Falha se alguém apagar/renomear um token, esquecer um tema (claro/escuro), introduzir roxo/neon nos
// tokens, derrubar o contraste de leitura ou desligar a exposição dos tokens no Tailwind.
// Roda sem navegador (jest, node, lê arquivos): `cd apps/admin-web && npx jest lib/design-tokens`.

import * as path from 'path';
import { THEME_INIT_SCRIPT, THEME_STORAGE_KEY } from '@/lib/theme';
import {
  ADMIN_ROOT,
  contrastRatio,
  isNeon,
  isPurplish,
  parseHslTriplet,
  parseTokenBlocks,
  readText,
} from './design-guard';

const css = readText(path.join(ADMIN_ROOT, 'app', 'globals.css'));
const tokens = parseTokenBlocks(css);

// Chaves essenciais: superfície, texto, borda, ação primária e os três estados semânticos + gráficos.
const CORE_TOKENS = [
  'background',
  'foreground',
  'card',
  'card-foreground',
  'muted',
  'muted-foreground',
  'accent',
  'accent-foreground',
  'border',
  'input',
  'ring',
  'primary',
  'primary-foreground',
];
const SEMANTIC_TOKENS = ['success', 'success-soft', 'warning', 'warning-soft', 'danger', 'danger-soft', 'danger-foreground'];
const CHART_TOKENS = ['chart-1', 'chart-2', 'chart-3', 'chart-4', 'chart-5', 'chart-6'];
const ALL_TOKENS = [...CORE_TOKENS, ...SEMANTIC_TOKENS, ...CHART_TOKENS];

describe('tokens de tema (globals.css)', () => {
  it.each(ALL_TOKENS)('token --%s existe no tema CLARO (:root) e no ESCURO (.dark)', (name) => {
    expect(tokens.light[name]).toBeDefined();
    expect(tokens.dark[name]).toBeDefined();
  });

  it.each(ALL_TOKENS)('token --%s tem valor HSL válido ("H S% L%") nos dois temas', (name) => {
    expect(parseHslTriplet(tokens.light[name] ?? '')).not.toBeNull();
    expect(parseHslTriplet(tokens.dark[name] ?? '')).not.toBeNull();
  });

  it('declara color-scheme claro em :root e escuro em .dark (barras de rolagem/inputs nativos)', () => {
    expect(tokens.light['color-scheme']).toBe('light');
    expect(tokens.dark['color-scheme']).toBe('dark');
  });

  it('o tema escuro é de fato escuro e o claro é de fato claro (fundo)', () => {
    expect(parseHslTriplet(tokens.dark.background)!.l).toBeLessThan(15);
    expect(parseHslTriplet(tokens.light.background)!.l).toBeGreaterThan(90);
  });

  it('claro e escuro não são idênticos (o tema escuro não pode virar cópia do claro)', () => {
    for (const name of ['background', 'foreground', 'card', 'border', 'primary']) {
      expect(tokens.dark[name]).not.toBe(tokens.light[name]);
    }
  });

  it('nenhum token é roxo/violeta/magenta nem neon (paleta: preto/branco/cinza/grafite/azul-naval)', () => {
    const offenders: string[] = [];
    for (const [theme, block] of [['claro', tokens.light], ['escuro', tokens.dark]] as const) {
      for (const name of ALL_TOKENS) {
        const c = parseHslTriplet(block[name] ?? '');
        if (!c) continue;
        if (isPurplish(c)) offenders.push(`${theme} --${name}: ${block[name]} (roxo)`);
        if (isNeon(c)) offenders.push(`${theme} --${name}: ${block[name]} (neon)`);
      }
    }
    expect(offenders).toEqual([]);
  });

  // Teto de 55%: o naval profundo oficial do quadro de marca (#050A10) tem 52% de saturação em 4% de luz.
  it('superfícies e texto base são navy/cinza (saturação <= 55%) — cor forte só nos estados semânticos', () => {
    const surface = ['background', 'foreground', 'card', 'muted', 'muted-foreground', 'accent', 'border', 'input', 'primary'];
    for (const block of [tokens.light, tokens.dark]) {
      for (const name of surface) {
        expect(parseHslTriplet(block[name])!.s).toBeLessThanOrEqual(55);
      }
    }
  });

  describe('contraste de leitura (WCAG) — regressão de acessibilidade do tema', () => {
    const pairs: Array<[string, string, number]> = [
      ['foreground', 'background', 7],
      ['card-foreground', 'card', 7],
      ['muted-foreground', 'background', 4.5],
      ['muted-foreground', 'card', 4.5],
      ['primary-foreground', 'primary', 4.5],
      ['success', 'success-soft', 4.5],
      ['warning', 'warning-soft', 4.5],
      ['danger', 'danger-soft', 4.5],
      ['danger-foreground', 'danger', 4.5],
      // indicadores (ícone/ponto/seta) sobre a superfície: mínimo de 3:1 para elementos gráficos
      ['success', 'card', 3],
      ['warning', 'card', 3],
      ['danger', 'card', 3],
    ];
    for (const [themeName, block] of [['claro', tokens.light], ['escuro', tokens.dark]] as const) {
      it.each(pairs)(`${themeName}: --%s sobre --%s >= %s:1`, (fg, bg, min) => {
        const ratio = contrastRatio(parseHslTriplet(block[fg])!, parseHslTriplet(block[bg])!);
        expect(ratio).toBeGreaterThanOrEqual(min);
      });
    }
  });
});

describe('tailwind.config.js expõe os tokens', () => {
  const tailwind = require('../tailwind.config.js');
  const colors = tailwind.theme.extend.colors as Record<string, string | Record<string, string>>;

  it('usa a classe `dark` no <html> (tema escolhido em Configurações → Aparência)', () => {
    expect(tailwind.darkMode).toBe('class');
  });

  it('enxerga app/, components/ e lib/ (mapas de status -> classes ficam em lib/)', () => {
    const content: string[] = tailwind.content.filter((c: string) => !c.startsWith('!'));
    for (const dir of ['./app/', './components/', './lib/']) {
      expect(content.some((c) => c.startsWith(dir))).toBe(true);
    }
  });

  it('não gera CSS a partir de arquivos de teste nem do auditor de design (evita gerar classes proibidas dos exemplos)', () => {
    const negated: string[] = tailwind.content.filter((c: string) => c.startsWith('!'));
    expect(negated.some((c) => c.includes('*.test.'))).toBe(true);
    expect(negated.some((c) => c.includes('design-guard'))).toBe(true);
  });

  const flat = (v: string | Record<string, string>, key: string): Array<[string, string]> =>
    typeof v === 'string' ? [[key, v]] : Object.entries(v).map(([k, val]) => [k === 'DEFAULT' ? key : `${key}-${k}`, val]);
  const exposed = Object.entries(colors).flatMap(([key, v]) => flat(v, key));

  it.each(['border', 'input', 'ring', 'background', 'foreground', 'card', 'card-foreground', 'muted', 'muted-foreground', 'accent', 'accent-foreground', 'primary', 'primary-foreground', 'success', 'success-soft', 'warning', 'warning-soft', 'danger', 'danger-soft', 'danger-foreground'])(
    'cor "%s" existe no Tailwind',
    (name) => {
      expect(exposed.map(([k]) => k)).toContain(name);
    }
  );

  it('toda cor do Tailwind aponta para um token existente nos DOIS temas (hsl(var(--x)))', () => {
    const problems: string[] = [];
    for (const [utility, value] of exposed) {
      const m = value.match(/^hsl\(var\(--([a-z0-9-]+)\)\)$/);
      if (!m) {
        problems.push(`${utility}: "${value}" não é hsl(var(--token))`);
        continue;
      }
      if (tokens.light[m[1]] === undefined || tokens.dark[m[1]] === undefined) {
        problems.push(`${utility}: --${m[1]} não existe nos dois temas`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('cores de gráfico (chart-1..6) estão expostas', () => {
    const chart = colors.chart as Record<string, string>;
    expect(Object.keys(chart).sort()).toEqual(['1', '2', '3', '4', '5', '6']);
  });
});

describe('lib/theme.ts (Escuro/Claro/Sistema)', () => {
  it('a chave de armazenamento é ln-theme', () => {
    expect(THEME_STORAGE_KEY).toBe('ln-theme');
  });

  it('o script de pré-pintura lê a preferência, assume "system" e usa prefers-color-scheme + classe dark', () => {
    expect(THEME_INIT_SCRIPT).toContain(THEME_STORAGE_KEY);
    expect(THEME_INIT_SCRIPT).toContain("m='system'");
    expect(THEME_INIT_SCRIPT).toContain('(prefers-color-scheme: dark)');
    expect(THEME_INIT_SCRIPT).toContain("classList.toggle('dark'");
    expect(THEME_INIT_SCRIPT).toContain('colorScheme');
  });

  it('o layout raiz aplica o script antes da pintura e mantém pt-BR', () => {
    const layout = readText(path.join(ADMIN_ROOT, 'app', 'layout.tsx'));
    expect(layout).toContain('THEME_INIT_SCRIPT');
    expect(layout).toContain('suppressHydrationWarning');
    expect(layout).toContain('lang="pt-BR"');
  });
});
