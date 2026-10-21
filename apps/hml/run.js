#!/usr/bin/env node
// Executa um comando com o ambiente HML (banco 5433, Redis 6390, segredos próprios) por cima do ambiente atual.
// Uso: node apps/hml/run.js [--cwd <dir>] -- <comando> [args…]
// Recusa se a DATABASE_URL resultante não apontar para o banco HML isolado.
const fs = require('fs');
const path = require('path');
const { spawnTracked } = require('./lib/proc');

const envFile = path.join(__dirname, '.hml', 'api.env.json');
if (!fs.existsSync(envFile)) { console.error('HML não inicializado: node apps/hml/infra.js init'); process.exit(1); }
const hml = JSON.parse(fs.readFileSync(envFile, 'utf8'));
if (!/:5433\/lnsystem_hml\b/.test(hml.DATABASE_URL)) { console.error('DATABASE_URL HML inesperada — recusado'); process.exit(1); }

const args = process.argv.slice(2);
let cwd = process.cwd();
if (args[0] === '--cwd') { cwd = path.resolve(args[1]); args.splice(0, 2); }
if (args[0] === '--') args.shift();
if (!args.length) { console.error('uso: node apps/hml/run.js [--cwd dir] -- cmd args'); process.exit(2); }

// `shell: true` fica porque `npm`/`npx` no Windows são .cmd; a janela é oculta e o filho morre junto com este processo.
const child = spawnTracked(args[0], args.slice(1), { cwd, env: { ...process.env, ...hml }, stdio: 'inherit', shell: true });
child.on('exit', (code) => process.exit(code ?? 1));
