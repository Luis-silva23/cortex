// GUARDA DE DESIGN 4/5 — o seletor de tema existe SÓ em Configurações → Aparência.
// Regra oficial CÓRTEX: tema Escuro/Claro/Sistema, escolhido em Configurações → Aparência; NÃO há botão de
// tema no header nem espalhado pelas telas (foi removido em f01cafc: components/layout/ThemeToggle.tsx).
// Roda sem navegador: `cd apps/admin-web && npx jest lib/design-theme-selector`.

import * as fs from 'fs';
import * as path from 'path';
import { ADMIN_ROOT, extractTextPieces, listUiSources, parseSource, readText, toRel } from './design-guard';
import * as ts from 'typescript';

const p = (...parts: string[]) => path.join(ADMIN_ROOT, ...parts);

/** Importações (módulo e nomes) de um arquivo, via AST. */
function importsOf(file: string): Array<{ module: string; names: string[] }> {
  const sf = parseSource(readText(file), file);
  const out: Array<{ module: string; names: string[] }> = [];
  sf.forEachChild((n) => {
    if (!ts.isImportDeclaration(n) || !ts.isStringLiteral(n.moduleSpecifier)) return;
    const names: string[] = [];
    const clause = n.importClause;
    if (clause?.name) names.push(clause.name.text);
    if (clause?.namedBindings) {
      if (ts.isNamedImports(clause.namedBindings)) clause.namedBindings.elements.forEach((e) => names.push((e.propertyName ?? e.name).text));
      else names.push(clause.namedBindings.name.text);
    }
    out.push({ module: n.moduleSpecifier.text, names });
  });
  return out;
}

const THEME_ICONS = ['Sun', 'Moon', 'SunMoon', 'SunDim', 'Monitor', 'Palette', 'Contrast', 'MoonStar'];

describe('Header e moldura NÃO têm controle de tema', () => {
  const layoutFiles = fs
    .readdirSync(p('components', 'layout'))
    .filter((f) => f.endsWith('.tsx'))
    .map((f) => p('components', 'layout', f));

  it('o Header existe e a moldura tem Sidebar + Header + main', () => {
    expect(fs.existsSync(p('components', 'layout', 'Header.tsx'))).toBe(true);
    expect(fs.existsSync(p('components', 'layout', 'DashboardShell.tsx'))).toBe(true);
  });

  it('ThemeToggle não existe mais (foi removido; o tema mora em Configurações → Aparência)', () => {
    expect(fs.existsSync(p('components', 'layout', 'ThemeToggle.tsx'))).toBe(false);
    const stray = listUiSources().filter((f) => /ThemeToggle|ThemeSwitch|ThemeButton|ThemePicker/.test(path.basename(f)));
    expect(stray.map((f) => toRel(f))).toEqual([]);
  });

  it.each(['Header.tsx', 'Sidebar.tsx', 'DashboardShell.tsx'])('%s não importa nem renderiza seletor de tema', (name) => {
    const file = p('components', 'layout', name);
    const imports = importsOf(file);
    const modules = imports.map((i) => i.module).join(' ');
    const names = imports.flatMap((i) => i.names);

    expect(modules).not.toMatch(/ThemeToggle|ThemeSettings|ThemeProvider/);
    expect(names).not.toEqual(expect.arrayContaining(['ThemeToggle']));
    for (const forbidden of ['ThemeToggle', 'ThemeSettings', 'useTheme', 'ThemeProvider', ...THEME_ICONS]) {
      expect(names).not.toContain(forbidden);
    }
    const source = readText(file);
    expect(source).not.toMatch(/<ThemeToggle|<ThemeSettings|useTheme\(|setMode\(|ln-theme|classList\.toggle\(\s*['"]dark/);
  });

  it('nenhum arquivo de components/layout mexe no tema (useTheme/setMode/localStorage do tema)', () => {
    for (const file of layoutFiles) {
      expect(readText(file)).not.toMatch(/useTheme|setMode|THEME_STORAGE_KEY|ln-theme/);
    }
  });

  it('o Header não tem botão de tema por rótulo (aria-label/title "tema", "claro", "escuro")', () => {
    const header = readText(p('components', 'layout', 'Header.tsx'));
    const labels = extractTextPieces(header, 'Header.tsx')
      .filter((x) => x.kind === 'string')
      .map((x) => x.text.toLowerCase());
    expect(labels.filter((t) => /(alternar|trocar|mudar|escolher).*(tema|modo)|modo (claro|escuro)|tema (claro|escuro)/.test(t))).toEqual([]);
  });
});

describe('o seletor de tema mora só em Configurações → Aparência', () => {
  const files = listUiSources();
  const rel = (f: string) => toRel(f);

  it('só ThemeSettings e o ThemeProvider usam useTheme()/setMode()', () => {
    const users = files.filter((f) => /\buseTheme\s*\(|\bsetMode\s*\(/.test(readText(f))).map(rel).sort();
    expect(users).toEqual(['components/providers/ThemeProvider.tsx', 'components/settings/ThemeSettings.tsx']);
  });

  it('ThemeSettings só é renderizado pela página de Configurações', () => {
    const renderers = files.filter((f) => /<ThemeSettings\b/.test(readText(f))).map(rel);
    expect(renderers).toEqual(['app/dashboard/settings/page.tsx']);
    const settings = readText(p('app', 'dashboard', 'settings', 'page.tsx'));
    expect(settings).toContain("id: 'appearance'");
    expect(settings).toMatch(/activeTab === 'appearance' && <ThemeSettings \/>/);
  });

  it('a aba se chama Aparência', () => {
    expect(readText(p('app', 'dashboard', 'settings', 'page.tsx'))).toContain("label: 'Aparência'");
  });

  it('ThemeSettings oferece exatamente Escuro / Claro / Sistema (dark | light | system)', () => {
    const src = readText(p('components', 'settings', 'ThemeSettings.tsx'));
    for (const [value, label] of [['dark', 'Escuro'], ['light', 'Claro'], ['system', 'Sistema']]) {
      expect(src).toMatch(new RegExp(`value: '${value}',\\s*label: '${label}'`));
    }
    expect(src).toContain('<CardTitle>Aparência</CardTitle>');
    expect((src.match(/value: '(?:dark|light|system)'/g) ?? []).length).toBe(3);
  });

  it('o ThemeProvider aceita só light | dark | system e assume system', () => {
    const src = readText(p('components', 'providers', 'ThemeProvider.tsx'));
    expect(src).toMatch(/stored === 'light' \|\| stored === 'dark' \|\| stored === 'system' \? stored : 'system'/);
  });
});
