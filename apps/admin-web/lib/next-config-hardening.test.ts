import * as fs from 'fs';
import * as path from 'path';

/**
 * Endurecimento do Next dos dois painéis. Nenhum código usa next/image, mas o otimizador (/_next/image) fica ATIVO por padrão (e o Admin Web chegou a
 * habilitar AVIF): o next@14 tem RCE crítico nele (AVIF, corrigido só em 15.5.24). `images.unoptimized: true` o desliga (o endpoint responde 404, provado
 * com `next start`). Enquanto o Next não for atualizado para uma linha corrigida, isto não pode voltar atrás.
 */
const apps = path.resolve(__dirname, '../..');

describe.each(['admin-web', 'super-admin'])('next.config.js de %s', (app) => {
  const config = fs.readFileSync(path.join(apps, app, 'next.config.js'), 'utf8');

  it('desliga o otimizador de imagens (/_next/image)', () => {
    expect(config).toMatch(/images:\s*\{\s*unoptimized:\s*true\s*\}/);
  });

  it('não habilita AVIF nem domínios remotos para o otimizador', () => {
    expect(config).not.toMatch(/image\/avif/);
    expect(config).not.toMatch(/remotePatterns|domains\s*:/);
  });

  it('nenhum arquivo do app usa next/image', () => {
    const walk = (dir: string): string[] =>
      fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        if (['node_modules', '.next'].includes(e.name)) return [];
        const p = path.join(dir, e.name);
        return e.isDirectory() ? walk(p) : /\.(tsx?|jsx?)$/.test(e.name) && !e.name.endsWith('.d.ts') && !e.name.endsWith('.test.ts') ? [p] : [];
      });
    const users = walk(path.join(apps, app)).filter((f) => /from ['"]next\/image['"]/.test(fs.readFileSync(f, 'utf8')));
    expect(users).toEqual([]);
  });
});
