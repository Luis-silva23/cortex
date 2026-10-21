// GUARDA DE DESIGN 5/5 — identidade de cada app (nome exibido, <title>, logo, portas) conforme
// docs/CORTEX/VISUAL_REFERENCES.md. Congela o que EXISTE hoje: NÃO decide a marca (isso é do dono).
// Falha quando alguém troca o título/nome de um app (ex.: o Admin Web voltar a mostrar "LN System PDV",
// dois frontends com o mesmo <title>, ou uma porta mudar) sem atualizar o documento junto.
// Se o dono decidir a marca: altere o app, este teste e o documento NO MESMO commit.
// Roda sem navegador: `cd apps/admin-web && npx jest lib/design-identity`.

import * as fs from 'fs';
import * as path from 'path';
import { REPO_ROOT, readText } from './design-guard';

const repo = (...parts: string[]) => path.join(REPO_ROOT, ...parts);
const read = (...parts: string[]) => readText(repo(...parts));
const json = (...parts: string[]) => JSON.parse(read(...parts));

const DOC = read('docs', 'CORTEX', 'VISUAL_REFERENCES.md');

/** O que cada app exibe HOJE (fonte: os arquivos citados). */
const IDENTITY = {
  adminWeb: {
    title: 'CÓRTEX — Admin',
    description: 'Painel administrativo do CÓRTEX — Lógica de Negócios',
    wordmark: 'CÓRTEX',
    tagline: 'Lógica de Negócios',
    port: 3002,
  },
  superAdmin: {
    title: 'CÓRTEX — Super Admin',
    description: 'Painel de administração Super ADM TI',
    sidebarLogo: 'CÓRTEX',
    loginTitle: 'CÓRTEX',
    loginSubtitle: 'Painel Super ADM TI',
    port: 3000,
  },
  pdv: {
    title: 'CÓRTEX PDV',
    // productName fica técnico: o Electron deriva dele a pasta userData (sessão, nº do caixa, safeStorage).
    productName: 'LN System PDV',
    appId: 'com.lnsystem.pdv',
    sidebarLogo: 'CÓRTEX',
    sidebarSubtitle: 'PDV Desktop',
    port: 5173,
  },
  mobile: { name: 'CÓRTEX Equipe', slug: 'ln-system-mobile', bundle: 'com.lnsystem.mobile', loginTitle: 'CÓRTEX' },
  tv: { name: 'CÓRTEX Painel', slug: 'ln-system-tv', bundle: 'com.lnsystem.tv', loginTitle: 'CÓRTEX — Painel' },
};

describe('Admin Web (localhost:3002)', () => {
  const layout = read('apps', 'admin-web', 'app', 'layout.tsx');

  it('<title> e descrição do metadata; tipografia Montserrat (quadro de marca)', () => {
    expect(layout).toContain(`title: '${IDENTITY.adminWeb.title}'`);
    expect(layout).toContain(`description: '${IDENTITY.adminWeb.description}'`);
    expect(layout).toContain('lang="pt-BR"');
    expect(layout).toMatch(/import \{ Montserrat \} from 'next\/font\/google'/);
  });

  it('marca CÓRTEX na Sidebar (h1), no login e na 404', () => {
    const brand = read('apps', 'admin-web', 'components', 'ui', 'brand.tsx');
    expect(brand).toContain(`>${IDENTITY.adminWeb.wordmark}</Tag>`);
    expect(brand).toContain(IDENTITY.adminWeb.tagline);
    expect(read('apps', 'admin-web', 'components', 'layout', 'Sidebar.tsx')).toContain('<CortexWordmark as="h1"');
    const login = read('apps', 'admin-web', 'app', 'login', 'page.tsx');
    expect(login).toContain('<CortexWordmark');
    expect(login).toContain('Bem-vindo de volta');
  });

  it('rota inexistente usa a 404 do produto (não a página padrão do Next)', () => {
    const nf = read('apps', 'admin-web', 'app', 'not-found.tsx');
    expect(nf).toContain('<CortexWordmark');
    expect(nf).toContain('Ops. Nada por aqui');
    expect(nf).toContain('Voltar ao início');
    expect(nf).toContain('href="/dashboard"');
  });

  it('porta 3002 no dev e no start', () => {
    const pkg = json('apps', 'admin-web', 'package.json');
    expect(pkg.scripts.dev).toContain(`-p ${IDENTITY.adminWeb.port}`);
    expect(pkg.scripts.start).toContain(`-p ${IDENTITY.adminWeb.port}`);
  });
});

describe('Super Admin (localhost:3000)', () => {
  it('<title>, descrição, logo e login', () => {
    const layout = read('apps', 'super-admin', 'app', 'layout.tsx');
    expect(layout).toContain(`title: '${IDENTITY.superAdmin.title}'`);
    expect(layout).toContain(`description: '${IDENTITY.superAdmin.description}'`);
    expect(read('apps', 'super-admin', 'components', 'layout', 'sidebar.tsx')).toContain(`>${IDENTITY.superAdmin.sidebarLogo}</h1>`);
    expect(layout).toContain("import { Montserrat } from 'next/font/google'");
    const login = read('apps', 'super-admin', 'app', 'login', 'page.tsx');
    expect(login).toContain(`>${IDENTITY.superAdmin.loginTitle}</CardTitle>`);
    expect(login).toContain(`>${IDENTITY.superAdmin.loginSubtitle}</CardDescription>`);
  });

  it('porta 3000 no dev e no start', () => {
    const pkg = json('apps', 'super-admin', 'package.json');
    expect(pkg.scripts.dev).toContain(`-p ${IDENTITY.superAdmin.port}`);
    expect(pkg.scripts.start).toContain(`-p ${IDENTITY.superAdmin.port}`);
  });
});

describe('PDV Desktop (localhost:5173 no navegador; Electron empacotado)', () => {
  it('<title> do index.html, título da janela Electron, productName e appId', () => {
    expect(read('apps', 'pdv-desktop', 'index.html')).toContain(`<title>${IDENTITY.pdv.title}</title>`);
    expect(read('apps', 'pdv-desktop', 'electron', 'main.ts')).toContain(`title: '${IDENTITY.pdv.title}'`);
    const pkg = json('apps', 'pdv-desktop', 'package.json');
    expect(pkg.build.productName).toBe(IDENTITY.pdv.productName);
    expect(pkg.build.appId).toBe(IDENTITY.pdv.appId);
  });

  it('logo da barra lateral e título do login', () => {
    const layout = read('apps', 'pdv-desktop', 'src', 'components', 'Layout.tsx');
    expect(layout).toContain(`>${IDENTITY.pdv.sidebarLogo}</h1>`);
    expect(layout).toContain(IDENTITY.pdv.sidebarSubtitle);
    expect(read('apps', 'pdv-desktop', 'src', 'pages', 'LoginPage.tsx')).toContain(`>${IDENTITY.pdv.title}</h1>`);
  });

  it('porta 5173 (vite.config.ts) e --strictPort (nunca cair em outra porta em silêncio)', () => {
    expect(read('apps', 'pdv-desktop', 'vite.config.ts')).toContain(`port: ${IDENTITY.pdv.port}`);
    expect(json('apps', 'pdv-desktop', 'package.json').scripts.dev).toContain('--strictPort');
  });
});

describe('Mobile e TV (Expo)', () => {
  it('nome, slug, bundle e título do login do Mobile', () => {
    const app = json('apps', 'mobile', 'app.json').expo;
    expect(app.name).toBe(IDENTITY.mobile.name);
    expect(app.slug).toBe(IDENTITY.mobile.slug);
    expect(app.android.package).toBe(IDENTITY.mobile.bundle);
    expect(app.ios.bundleIdentifier).toBe(IDENTITY.mobile.bundle);
    expect(app.userInterfaceStyle).toBe('dark');
    expect(read('apps', 'mobile', 'src', 'screens', 'LoginScreen.tsx')).toContain(`>${IDENTITY.mobile.loginTitle}</Text>`);
  });

  it('nome, slug, bundle e título do login da TV', () => {
    const app = json('apps', 'tv', 'app.json').expo;
    expect(app.name).toBe(IDENTITY.tv.name);
    expect(app.slug).toBe(IDENTITY.tv.slug);
    expect(app.android.package).toBe(IDENTITY.tv.bundle);
    expect(app.userInterfaceStyle).toBe('dark');
    expect(read('apps', 'tv', 'src', 'screens', 'LoginScreen.tsx')).toContain(`>${IDENTITY.tv.loginTitle}</Text>`);
  });
});

describe('apps não se confundem', () => {
  it('<title> dos três frontends web é único (foi o que o incidente de 21/09 escondeu: PDV no lugar do Admin)', () => {
    const titles = [IDENTITY.adminWeb.title, IDENTITY.superAdmin.title, IDENTITY.pdv.title];
    expect(new Set(titles).size).toBe(titles.length);
  });

  it('cada frontend tem porta própria (uma porta por frontend; nunca dois na mesma)', () => {
    const ports = [IDENTITY.superAdmin.port, 3001 /* API */, IDENTITY.adminWeb.port, IDENTITY.pdv.port, 8081 /* Expo */];
    expect(new Set(ports).size).toBe(ports.length);
  });

  it('a API continua na 3001 por padrão', () => {
    expect(read('apps', 'api', 'src', 'index.ts')).toMatch(/API_PORT \|\| 3001/);
  });
});

describe('docs/CORTEX/VISUAL_REFERENCES.md está em dia com o código', () => {
  it('o documento existe', () => {
    expect(fs.existsSync(repo('docs', 'CORTEX', 'VISUAL_REFERENCES.md'))).toBe(true);
  });

  it.each([
    IDENTITY.adminWeb.title,
    IDENTITY.adminWeb.description,
    IDENTITY.superAdmin.title,
    IDENTITY.superAdmin.description,
    IDENTITY.pdv.title,
    IDENTITY.pdv.appId,
    IDENTITY.mobile.name,
    IDENTITY.mobile.bundle,
    IDENTITY.tv.name,
    IDENTITY.tv.bundle,
    IDENTITY.tv.loginTitle,
    IDENTITY.superAdmin.loginSubtitle,
  ])('o documento registra "%s"', (text) => {
    expect(DOC).toContain(text);
  });

  it('o documento traz o mapa de portas, a regra "uma porta por frontend" e a decisão de marca pendente', () => {
    for (const port of ['3000', '3001', '3002', '5173', '8081']) expect(DOC).toContain(port);
    expect(DOC).toMatch(/uma porta por frontend/i);
    expect(DOC).toContain('DECISÃO DE MARCA');
    expect(DOC).toContain('Get-NetTCPConnection');
  });

  it('o documento lista os bancos e as travas de teste', () => {
    for (const text of ['lnsystem_db', 'lnsystem_test', 'REDIS_DB', 'destructive-guard.ts', 'Integration Test Co', 'CÓRTEX Demo']) {
      expect(DOC).toContain(text);
    }
  });
});
