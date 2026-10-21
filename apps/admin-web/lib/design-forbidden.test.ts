// GUARDA DE DESIGN 2/5 — proibições em app/** e components/**: roxo/violeta/fúcsia/índigo, gradiente
// decorativo, neon/glow e COR FIXA (hex/rgb) no código de tela (gráficos incluídos). Mais: arquivos já
// migrados para tokens não podem voltar à paleta fixa do Tailwind (bg-white, text-gray-500, text-blue-600...).
// Roda sem navegador: `cd apps/admin-web && npx jest lib/design-forbidden`.
//
// Os "exemplos sintéticos" dos autotestes são montados por concatenação para não gerar CSS proibido
// no Tailwind nem se auto-denunciar.

import * as path from 'path';
import {
  ADMIN_ROOT,
  findFixedColors,
  findFixedPalette,
  findGlow,
  findGradients,
  findInCss,
  findPurple,
  formatViolations,
  listFiles,
  listUiSources,
  readText,
  Violation,
} from './design-guard';

const cls = (...parts: string[]) => parts.join('-');
const tsx = (className: string) => `export const X = () => <div className="${className}">x</div>;`;

// ---------------------------------------------------------------------------
// Autoteste do auditor: prova que cada regra DETECTA (não passa só porque não olha nada)
// ---------------------------------------------------------------------------
describe('auditor de design detecta o que promete (exemplos sintéticos)', () => {
  it('roxo/violeta/fúcsia/índigo em classe, com variante e opacidade', () => {
    for (const bad of [cls('bg', 'purple', '600'), cls('text', 'violet', '500'), 'hover:' + cls('border', 'fuchsia', '400'), cls('ring', 'indigo', '500') + '/40', cls('from', 'purple', '500')]) {
      expect(findPurple(tsx(bad), 'x.tsx')).not.toHaveLength(0);
    }
  });

  it('roxo em cor literal (hex e hsl) — mas não o azul-naval', () => {
    expect(findPurple(`const c = '#a855f7';`, 'x.ts')).not.toHaveLength(0);
    expect(findPurple(`const c = 'hsl(270 60% 50%)';`, 'x.ts')).not.toHaveLength(0);
    expect(findPurple(`const c = '#1d4ed8'; const d = '#0f172a'; const e = 'hsl(222 47% 11%)';`, 'x.ts')).toHaveLength(0);
  });

  it('comentário que menciona "antes era roxo" NÃO dispara (só código executável conta)', () => {
    expect(findPurple(`// antes: ${cls('bg', 'purple', '600')}\nexport const a = 1;`, 'x.ts')).toHaveLength(0);
  });

  it('gradiente: bg-gradient-*, from-/via-/to-, linear-gradient()', () => {
    for (const bad of [cls('bg', 'gradient', 'to', 'br') + ' ' + cls('from', 'blue', '50') + ' ' + cls('to', 'white'), cls('via', 'slate', '900'), cls('to', 'primary')]) {
      expect(findGradients(tsx(bad), 'x.tsx')).not.toHaveLength(0);
    }
    expect(findGradients(`const s = 'linear-gradient(90deg, #000, #fff)';`, 'x.ts')).not.toHaveLength(0);
    expect(findGradients(tsx('flex items-center gap-2 rounded-lg border bg-card text-foreground'), 'x.tsx')).toHaveLength(0);
  });

  it('glow/neon: sombra colorida, drop-shadow arbitrário, shadow-[...] com cor viva; token neutro é permitido', () => {
    expect(findGlow(tsx(cls('shadow', 'blue', '500') + '/50'), 'x.tsx')).not.toHaveLength(0);
    expect(findGlow(tsx('drop-shadow-[0_0_8px_#0ff]'), 'x.tsx')).not.toHaveLength(0);
    expect(findGlow(tsx('shadow-[0_0_20px_rgba(0,255,255,0.8)]'), 'x.tsx')).not.toHaveLength(0);
    expect(findGlow(tsx('shadow-[0_0_12px_cyan]'), 'x.tsx')).not.toHaveLength(0);
    expect(findGlow(tsx('shadow-[inset_2px_0_0_hsl(var(--primary))]'), 'x.tsx')).toHaveLength(0); // barra ativa da Sidebar
    expect(findGlow(tsx('shadow-sm shadow-md'), 'x.tsx')).toHaveLength(0);
  });

  it('cor fixa: hex, rgb(), hsl(números) em strings de código — token hsl(var(--x)) é permitido', () => {
    expect(findFixedColors(`const c = '#e5e7eb';`, 'x.ts')).not.toHaveLength(0);
    expect(findFixedColors(`const c = 'rgba(0,0,0,0.5)';`, 'x.ts')).not.toHaveLength(0);
    expect(findFixedColors(`const c = 'hsl(210 20% 98%)';`, 'x.ts')).not.toHaveLength(0);
    expect(findFixedColors(`const c = 'hsl(var(--border))'; const l = '#'; const id = '#root';`, 'x.ts')).toHaveLength(0);
  });

  it('paleta fixa do Tailwind: bg-white/text-gray-500/text-blue-600 — token não dispara', () => {
    expect(findFixedPalette(tsx(cls('text', 'gray', '500')), 'x.tsx')).not.toHaveLength(0);
    expect(findFixedPalette(tsx(cls('bg', 'blue', '600') + ' ' + cls('text', 'white')), 'x.tsx')).not.toHaveLength(0);
    expect(findFixedPalette(tsx('bg-card text-muted-foreground border-border bg-primary text-primary-foreground text-danger'), 'x.tsx')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Varredura real
// ---------------------------------------------------------------------------
const uiFiles = listUiSources();

function scan(fn: (source: string, file: string) => Violation[], files: string[] = uiFiles): Violation[] {
  return files.flatMap((file) => fn(readText(file), file));
}

describe('varredura de app/** e components/** (código de tela)', () => {
  it('encontra os arquivos de tela (a varredura não está vazia)', () => {
    expect(uiFiles.length).toBeGreaterThan(50);
    expect(uiFiles.some((f) => f.endsWith(path.join('app', 'dashboard', 'page.tsx')))).toBe(true);
    expect(uiFiles.some((f) => f.endsWith(path.join('components', 'layout', 'Header.tsx')))).toBe(true);
  });

  it('sem roxo/violeta/fúcsia/índigo (classes nem cores literais)', () => {
    const v = scan(findPurple);
    if (v.length) throw new Error(`Roxo proibido (linguagem CÓRTEX: preto/branco/cinza/grafite/azul-naval):\n${formatViolations(v)}`);
  });

  it('sem gradiente decorativo (bg-gradient-*, from-/via-/to-, linear-gradient)', () => {
    const v = scan(findGradients);
    if (v.length) throw new Error(`Gradiente proibido:\n${formatViolations(v)}`);
  });

  it('sem neon/glow (sombra colorida, drop-shadow arbitrário, text-shadow, shadow-[...] com cor viva)', () => {
    const v = scan(findGlow);
    if (v.length) throw new Error(`Glow/neon proibido:\n${formatViolations(v)}`);
  });

  it('sem COR FIXA hex/rgb/hsl-literal no código de tela — gráficos usam lib/chart-theme.ts (tokens)', () => {
    const v = scan(findFixedColors);
    if (v.length) {
      throw new Error(
        `Cor fixa em código de tela (use tokens: hsl(var(--x)), classes ligadas aos tokens ou lib/chart-theme.ts):\n${formatViolations(v)}`
      );
    }
  });

  it('globals.css não tem gradiente nem glow (a camada .dark de compatibilidade só remapeia para tokens)', () => {
    const file = path.join(ADMIN_ROOT, 'app', 'globals.css');
    const v = findInCss(readText(file), file, ['gradiente', 'glow-css']);
    if (v.length) throw new Error(`globals.css:\n${formatViolations(v)}`);
  });
});

// ---------------------------------------------------------------------------
// Arquivos já migrados para tokens: nada de paleta fixa (ratchet — a lista só cresce)
// ---------------------------------------------------------------------------
// Telas antigas (financeiro, vendas, estoque...) ainda usam paleta fixa e dependem da camada `.dark` de
// globals.css (docs/CORTEX/historico/registro-de-auditoria-2026-09-14-a-25.md C2). Quando uma tela for migrada, ACRESCENTE-a aqui.
const TOKEN_ONLY_FILES = [
  'app/layout.tsx',
  'app/login/page.tsx',
  'app/dashboard/layout.tsx',
  'app/dashboard/page.tsx',
  'app/dashboard/reports/page.tsx',
  'components/settings/ThemeSettings.tsx',
];
const TOKEN_ONLY_DIRS = ['components/ui', 'components/layout', 'components/providers'];

describe('arquivos migrados usam SÓ tokens (sem bg-white/text-gray-*/text-blue-*...)', () => {
  const files = [
    ...TOKEN_ONLY_FILES.map((f) => path.join(ADMIN_ROOT, f)),
    ...TOKEN_ONLY_DIRS.flatMap((d) => listFiles(path.join(ADMIN_ROOT, d), ['.ts', '.tsx'])),
  ];

  it('a lista de arquivos migrados existe', () => {
    expect(files.length).toBeGreaterThan(20);
  });

  it.each(files.map((f) => path.relative(ADMIN_ROOT, f).split(path.sep).join('/')))('%s', (rel) => {
    const file = path.join(ADMIN_ROOT, rel);
    const v = findFixedPalette(readText(file), file);
    if (v.length) throw new Error(`Paleta fixa em arquivo migrado:\n${formatViolations(v)}`);
  });
});
