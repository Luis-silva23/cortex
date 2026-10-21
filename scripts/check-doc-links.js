// Confere os links relativos (arquivo e âncora) dos .md de docs/ (exceto as pastas de evidência datadas). Só leitura, um processo.
// Uso: `node scripts/check-doc-links.js` — sai com código 1 se houver link quebrado (usado no CI).
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', 'docs');
const walk = (d) =>
  fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => {
    if (e.isDirectory()) return /^\d{4}-/.test(e.name) ? [] : walk(path.join(d, e.name));
    return e.name.endsWith('.md') ? [path.join(d, e.name)] : [];
  });

const slug = (h) =>
  h
    .trim()
    .toLowerCase()
    .replace(/[`*~]/g, '')
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s/g, '-');

const anchors = new Map();
const anchorsOf = (f) => {
  if (!anchors.has(f)) {
    const set = new Set();
    for (const line of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
      const m = /^#{1,6}\s+(.*)$/.exec(line);
      if (m) set.add(slug(m[1]));
    }
    anchors.set(f, set);
  }
  return anchors.get(f);
};

let total = 0;
const bad = [];
for (const f of walk(ROOT)) {
  const text = fs.readFileSync(f, 'utf8').replace(/```[\s\S]*?```/g, '');
  for (const m of text.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
    const href = m[1];
    if (/^(https?:|mailto:|#$)/.test(href)) continue;
    total += 1;
    const [p, a] = href.split('#');
    const target = p ? path.resolve(path.dirname(f), decodeURIComponent(p)) : f;
    if (!fs.existsSync(target)) {
      bad.push(`${path.relative(ROOT, f)} → ${href} (arquivo não existe)`);
      continue;
    }
    if (a && target.endsWith('.md') && !anchorsOf(target).has(decodeURIComponent(a).toLowerCase())) bad.push(`${path.relative(ROOT, f)} → ${href} (âncora não existe)`);
  }
}
console.log(`links conferidos: ${total}; quebrados: ${bad.length}`);
bad.slice(0, 40).forEach((b) => console.log('  ' + b));
process.exit(bad.length > 0 ? 1 : 0);
