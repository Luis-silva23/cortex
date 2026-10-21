// Segurança adversarial contra a API HML (porta 3101, banco isolado): injeção, payloads gigantes/malformados, XSS
// armazenado, isolamento da Central de Ajuda entre empresas, upload (assinatura/extensão/nome/tamanho), sessão
// (token adulterado/expirado, refresh, logout, sessões simultâneas), força bruta com bloqueio de conta e MFA, e
// limite de taxa. A prova NÃO é o HTTP: cada bloco confere também o banco quando faz sentido.
// Origem 127.0.0.N distinta para o que ESGOTA o limitador por IP (login/MFA), para não bloquear a suíte inteira.
// Dados criados levam [HML-STRESS]; usuários descartáveis ficam desativados no fim. Nada é apagado.
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { suite, sessions, idOf, api } = require('../lib/harness');
const { request, totp } = require('../lib/api');
const infra = require('../infra');
const db = require('../lib/db');

const S = suite('security');
const { check } = S;
const par = (n, fn) => Promise.all(Array.from({ length: n }, (_, i) => fn(i)));
const listOf = (r) => {
  const b = r.body;
  if (Array.isArray(b)) return b;
  for (const v of [b?.data, b?.data?.items, b?.items, b?.customers, b?.products, b?.tickets, b?.articles]) if (Array.isArray(v)) return v;
  return [];
};
const b64 = (o) => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64url');
const pw = () => `Aa1!${crypto.randomBytes(9).toString('hex')}`;

(async () => {
  const s = await sessions(['ceo.a', 'ceo.b', 'caixa.a1', 'caixa.a2', 'gerente.a2']);
  const A = s.cred.companies.A;
  const B = s.cred.companies.B;
  const run = `${Date.now()}`;
  const tok = (k) => ({ token: s[k].token });
  const usersBefore = Number(db.scalar('SELECT count(*) FROM users'));
  const alive = async () => (await api.get('/api/health')).status === 200;

  // ---------------------------------------------------------------- 1. injeção
  const sqli = ["' OR '1'='1", "'; DROP TABLE users; --", '1; SELECT pg_sleep(6)--', '" OR ""="', "%' UNION SELECT NULL,NULL--", "\\' OR 1=1 --", "x') OR ('1'='1"];
  const endpoints = ['/api/customers?search=', '/api/products?search=', '/api/support/tickets?q=', '/api/support-kb/articles?q='];
  let bad5xx = []; let slow = []; let leaked = [];
  for (const ep of endpoints) {
    for (const p of sqli) {
      const r = await api.get(ep + encodeURIComponent(p), tok('ceo.a'));
      if (r.status >= 500 || r.status === 0) bad5xx.push(`${ep}${p} -> ${r.status}`);
      if (r.ms > 4000) slow.push(`${ep}${p} ${Math.round(r.ms)}ms`);
      if (p === "' OR '1'='1" && !/support-kb/.test(ep) && listOf(r).length > 0) leaked.push(`${ep} devolveu ${listOf(r).length} linhas`);
    }
  }
  check('1/SQLi em busca (clientes, produtos, chamados, artigos): nenhum 5xx', bad5xx.length === 0, bad5xx.join(' | '));
  check('1/SQLi: pg_sleep não executou (nenhuma resposta lenta)', slow.length === 0, slow.join(' | '));
  check("1/SQLi `' OR '1'='1` não vira tautologia (0 linhas)", leaked.length === 0, leaked.join(' | '));
  check('1/tabela users intacta depois do DROP injetado', Number(db.scalar('SELECT count(*) FROM users')) === usersBefore, 'contagem mudou');

  const odd = await par(6, (i) => api.get([
    '/api/customers?limit=99999999&page=-5',
    '/api/customers?page=abc&limit=xyz',
    '/api/customers?sortBy=password&order=desc;--',
    '/api/customers?companyId[]=x&companyId[]=y&__proto__[x]=1&constructor[prototype][x]=1',
    '/api/products?limit=-1&offset=99999999999999999999',
    `/api/customers?search=${'A'.repeat(20000)}`,
  ][i], tok('ceo.a')));
  check('1/parâmetros inesperados/gigantes: sem 5xx', odd.every((r) => r.status > 0 && r.status < 500), JSON.stringify(odd.map((r) => r.status)));

  const big = JSON.stringify({ name: 'x'.repeat(6 * 1024 * 1024) });
  const rBig = await request('POST', '/api/customers', { ...tok('ceo.a'), body: big, raw: true });
  check('1/payload de 6 MB recusado (413) e a API segue de pé', rBig.status === 413 && await alive(), `status ${rBig.status}`);
  const rBad = await request('POST', '/api/customers', { ...tok('ceo.a'), body: '{"name":', raw: true });
  check('1/JSON malformado: 400, não 5xx', rBad.status === 400, `status ${rBad.status} ${rBad.text?.slice(0, 120)}`);
  const rDeep = await request('POST', '/api/customers', { ...tok('ceo.a'), body: '['.repeat(20000) + ']'.repeat(20000), raw: true });
  check('1/JSON aninhado em 20 mil níveis: sem 5xx e API de pé', rDeep.status > 0 && rDeep.status < 500 && await alive(), `status ${rDeep.status}`);
  const rText = await request('POST', '/api/customers', { ...tok('ceo.a'), body: 'name=x', raw: true, headers: { 'Content-Type': 'text/plain' } });
  check('1/Content-Type inesperado: sem 5xx', rText.status > 0 && rText.status < 500, `status ${rText.status}`);
  const rProto = await request('POST', '/api/customers', { ...tok('ceo.a'), body: `{"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}},"name":"[HML-STRESS] proto ${run}"}`, raw: true });
  const rAfter = await api.get('/api/customers?search=zzz', tok('ceo.a'));
  check('1/poluição de protótipo no corpo: sem 5xx e sem efeito colateral', rProto.status < 500 && rAfter.status < 500 && ({}).polluted === undefined, `status ${rProto.status}/${rAfter.status}`);
  const rNul = await api.post('/api/customers', { name: `[HML-STRESS] nul\u0000byte ${run}` }, tok('ceo.a'));
  check('1/byte nulo no texto: erro de validação (4xx), nunca 500', rNul.status >= 200 && rNul.status < 500, `status ${rNul.status} ${rNul.text?.slice(0, 160)}`);
  const odds = ['日本語 テスト', '😀🏍️ emoji', 'مرحبا RTL \u202E', "O'Brien; -- /* */", '<>"\'&%00%0d%0a'];
  const rOdd = await par(odds.length, (i) => api.post('/api/customers', { name: `[HML-STRESS] ${odds[i]} ${run}` }, tok('ceo.a')));
  check('1/caracteres especiais/unicode/CRLF em texto: aceitos ou recusados, nunca 5xx', rOdd.every((r) => r.status < 500), JSON.stringify(rOdd.map((r) => r.status)));
  const rHdr = await api.get('/api/customers', { ...tok('ceo.a'), headers: { 'X-Company-Id': `${A.id}'; DROP TABLE users;--`, 'X-Forwarded-For': "1.1.1.1', '2.2.2.2" } });
  check('1/cabeçalhos hostis (X-Company-Id com SQL, XFF): sem 5xx', rHdr.status < 500, `status ${rHdr.status}`);

  // login hostil (origem 127.0.0.2: no máximo 4 falhas, abaixo do limite de 5)
  const hostile = [
    { numericId: '1 OR 1=1', password: 'x' }, { email: { $ne: null }, password: { $ne: null } },
    { email: "' OR 1=1--", password: 'x' }, { numericId: s['caixa.a1'].def.numericId, password: ['a'] },
  ];
  const lg = [];
  for (const body of hostile) lg.push(await request('POST', '/api/auth/login', { body, idem: false, localAddress: '127.0.0.2' }));
  check('1/login com SQL/NoSQL/tipos errados: 4xx, nunca 200 nem 5xx', lg.every((r) => r.status >= 400 && r.status < 500), JSON.stringify(lg.map((r) => r.status)));
  check('1/API de pé após a bateria de injeção', await alive(), 'health falhou');

  // ---------------------------------------------------------------- 2. XSS armazenado
  const xss = ['<script>alert(1)</script>', '<img src=x onerror=alert(1)>', '"><svg onload=alert(1)>', "javascript:alert(1)", '<iframe src="javascript:alert(1)"></iframe>'];
  const cx = await par(xss.length, (i) => api.post('/api/customers', { name: `[HML-STRESS] xss ${i} ${run} ${xss[i]}` }, tok('ceo.a')));
  check('2/XSS em nome de cliente: aceito como TEXTO (nenhum 5xx)', cx.every((r) => r.status < 500), JSON.stringify(cx.map((r) => r.status)));
  const gx = await api.get(`/api/customers?search=${encodeURIComponent(`xss 0 ${run}`)}`, tok('ceo.a'));
  check('2/resposta da API é JSON com nosniff (navegador não interpreta como HTML)',
    /application\/json/.test(gx.headers['content-type'] || '') && /nosniff/i.test(gx.headers['x-content-type-options'] || ''), `${gx.headers['content-type']} / ${gx.headers['x-content-type-options']}`);
  const px = await api.post('/api/products', { sku: `HMLX-${run}`, name: `[HML-STRESS] <img src=x onerror=alert(1)> ${run}`, costPrice: 1, salePrice: 2, unit: 'UN' }, tok('ceo.a'));
  check('2/XSS em nome de produto: sem 5xx', px.status < 500, `status ${px.status}`);
  const tk = await api.post('/api/support/tickets', { subject: '[HML-STRESS] <script>alert(1)</script> assunto', module: 'PDV', type: 'PROBLEMA', description: '<img src=x onerror=alert(1)> descrição do chamado de teste' }, tok('caixa.a1'));
  check('2/XSS em assunto/descrição de chamado: chamado criado como texto', tk.status === 201, `status ${tk.status} ${tk.text?.slice(0, 160)}`);
  const ticketId = idOf(tk);
  const msg = await api.post(`/api/support/tickets/${ticketId}/messages`, { body: '<svg/onload=alert(1)> resposta' }, tok('caixa.a1'));
  check('2/XSS em mensagem de chamado: sem 5xx', msg.status < 500, `status ${msg.status}`);

  // ---------------------------------------------------------------- 3. Central de Ajuda entre empresas
  const tkB = await api.post('/api/support/tickets', { subject: '[HML-STRESS] chamado da empresa B', module: 'ESTOQUE', type: 'DUVIDA', description: 'Dúvida da empresa B para o isolamento' }, tok('ceo.b'));
  const ticketB = idOf(tkB);
  check('3/empresa B abre o próprio chamado', tkB.status === 201 && !!ticketB, `status ${tkB.status}`);
  const aTries = await Promise.all([
    api.get(`/api/support/tickets/${ticketB}`, tok('ceo.a')),
    api.post(`/api/support/tickets/${ticketB}/messages`, { body: 'invasão de A em B' }, tok('ceo.a')),
    api.post(`/api/support/tickets/${ticketB}/close`, {}, tok('ceo.a')),
    api.post(`/api/support/tickets/${ticketB}/attachments`, { fileName: 'x.txt', contentBase64: Buffer.from('x').toString('base64') }, tok('ceo.a')),
  ]);
  check('3/empresa A (CEO) não lê, responde, encerra nem anexa em chamado da B', aTries.every((r) => r.status === 404 || r.status === 403), JSON.stringify(aTries.map((r) => r.status)));
  const listA = await api.get(`/api/support/tickets?q=${encodeURIComponent('empresa B')}`, tok('ceo.a'));
  check('3/listagem da A não traz chamado da B', !JSON.stringify(listA.body).includes(ticketB), 'chamado da B apareceu na lista da A');
  const other = await api.get(`/api/support/tickets/${ticketId}`, tok('caixa.a2'));
  check('3/operador sem support:view_company não lê chamado de outro colega (mesma empresa)', other.status === 404 || other.status === 403, `status ${other.status}`);
  const prodB = await api.post('/api/products', { sku: `HMLB-${run}`, name: `[HML-STRESS] produto B ${run}`, costPrice: 1, salePrice: 2, unit: 'UN' }, tok('ceo.b'));
  const ctx = await api.post('/api/support/tickets', { subject: '[HML-STRESS] contexto forjado', module: 'ESTOQUE', type: 'PROBLEMA', description: 'Contexto apontando para produto da empresa B', context: { entityType: 'PRODUCT', entityId: idOf(prodB) } }, tok('ceo.a'));
  check('3/contexto automático com id de produto da B é recusado na A (SUPPORT_CONTEXT_NOT_FOUND)', ctx.status === 400 && /SUPPORT_CONTEXT_NOT_FOUND/.test(ctx.text || ''), `status ${ctx.status} ${ctx.text?.slice(0, 160)}`);
  const forgedTk = await api.post('/api/support/tickets', { subject: '[HML-STRESS] companyId forjado', module: 'PDV', type: 'DUVIDA', description: 'Tentativa de abrir chamado em nome da B', companyId: B.id }, tok('ceo.a'));
  check('3/companyId no corpo do chamado é recusado (schema estrito)', forgedTk.status === 400, `status ${forgedTk.status}`);
  const adminA = await api.get('/api/support-admin/tickets', tok('ceo.a'));
  check('3/console de suporte (/support-admin) exige Super Admin', adminA.status === 403 || adminA.status === 401, `status ${adminA.status}`);
  const rowsB = db.run(`SELECT count(*) FROM support_tickets WHERE "companyId" = '${A.id}' AND id = '${ticketB}'`)[0][0];
  check('3/banco: chamado da B continua só na B', rowsB === '0', `linhas ${rowsB}`);

  // ---------------------------------------------------------------- 4. upload
  const att = (fileName, buf, mimeType) => api.post(`/api/support/tickets/${ticketId}/attachments`, { fileName, mimeType, contentBase64: Buffer.isBuffer(buf) ? buf.toString('base64') : buf }, tok('caixa.a1'));
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), crypto.randomBytes(64)]);
  const cases = [
    ['exe (MZ) com extensão .png', att('foto.png', Buffer.concat([Buffer.from('MZ'), crypto.randomBytes(80)]), 'image/png')],
    ['exe (MZ) com extensão .txt', att('log.txt', Buffer.concat([Buffer.from('MZ'), crypto.randomBytes(80)]), 'text/plain')],
    ['ELF com extensão .log', att('x.log', Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46]), crypto.randomBytes(40)]), 'text/plain')],
    ['ZIP/JAR com extensão .pdf', att('doc.pdf', Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), crypto.randomBytes(40)]), 'application/pdf')],
    ['script "#!" com extensão .txt', att('s.txt', Buffer.from('#!/bin/sh\nrm -rf /\n'), 'text/plain')],
    ['HTML com extensão .txt', att('p.txt', Buffer.from('<html><script>alert(1)</script></html>'), 'text/plain')],
    ['SVG com extensão .png', att('v.png', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>'), 'image/png')],
    ['SVG com extensão .svg', att('v.svg', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'image/svg+xml')],
    ['assinatura PNG com extensão .exe', att('virus.exe', png, 'image/png')],
    ['assinatura PNG com extensão .pdf', att('falso.pdf', png, 'application/pdf')],
    ['PNG com MIME declarado text/html', att('ok.png', png, 'text/html')],
    ['conteúdo binário aleatório .txt (byte nulo)', att('n.txt', Buffer.concat([Buffer.from('abc'), Buffer.from([0]), Buffer.from('def')]), 'text/plain')],
    ['base64 inválido', att('b.png', '@@@não-é-base64@@@', 'image/png')],
    ['vazio', att('v.txt', '', 'text/plain')],
    ['maior que 2 MB', att('grande.png', Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(2 * 1024 * 1024 + 16, 1)]), 'image/png')],
  ];
  const outs = await Promise.all(cases.map(([, p]) => p));
  cases.forEach(([name], i) => check(`4/upload recusado: ${name}`, outs[i].status >= 400 && outs[i].status < 500, `status ${outs[i].status} ${outs[i].text?.slice(0, 120)}`));
  const names = ['../../etc/passwd.txt', '..\\..\\windows\\system32\\x.txt', 'nome<script>.txt', 'a\u0000b.txt', `${'a'.repeat(300)}.txt`, 'C:\\Users\\x\\y.txt'];
  const nameOuts = await Promise.all(names.map((n) => att(n, Buffer.from(`log de teste ${run} ${n.length}`), 'text/plain')));
  const stored = nameOuts.filter((r) => r.status === 201).map((r) => String((r.body?.data ?? r.body)?.fileName ?? (r.body?.data ?? r.body)?.attachment?.fileName ?? ''));
  check('4/nomes maliciosos: aceitos só sanitizados (sem caminho, `<`, controle) ou recusados, nunca 5xx',
    nameOuts.every((r) => r.status < 500) && stored.every((n) => n && !/[\\/<>\u0000]/.test(n) && n.length <= 130), `${JSON.stringify(nameOuts.map((r) => r.status))} -> ${JSON.stringify(stored)}`);
  const okPng = await att('captura.png', png, 'image/png');
  check('4/arquivo legítimo (PNG de verdade) é aceito', okPng.status === 201, `status ${okPng.status} ${okPng.text?.slice(0, 160)}`);
  const attId = (okPng.body?.data ?? okPng.body)?.id ?? (okPng.body?.data ?? okPng.body)?.attachment?.id;
  const dl = attId ? await api.get(`/api/support/attachments/${attId}`, tok('caixa.a1')) : { status: 0, headers: {} };
  check('4/download: tipo detectado pelo conteúdo, nosniff e como anexo', dl.status === 200 && /image\/png/.test(dl.headers['content-type'] || '') && /nosniff/i.test(dl.headers['x-content-type-options'] || '') && /attachment/i.test(dl.headers['content-disposition'] || ''), `${dl.status} ${dl.headers['content-type']} ${dl.headers['content-disposition']}`);
  const dlB = attId ? await api.get(`/api/support/attachments/${attId}`, tok('ceo.b')) : { status: 0 };
  check('4/download do anexo por outra empresa é recusado (404/403)', dlB.status === 404 || dlB.status === 403, `status ${dlB.status}`);
  const dlOther = attId ? await api.get(`/api/support/attachments/${attId}`, tok('caixa.a2')) : { status: 0 };
  check('4/download por colega sem acesso ao chamado é recusado', dlOther.status === 404 || dlOther.status === 403, `status ${dlOther.status}`);

  // ---------------------------------------------------------------- 5. sessão
  const secret = infra.secrets().jwtSecret;
  const real = jwt.decode(s['caixa.a1'].token);
  const { exp, iat, nbf, ...claims } = real;
  const forgeSigned = (extra = {}, opts = { expiresIn: '5m' }) => jwt.sign({ ...claims, ...extra }, secret, { algorithm: 'HS256', ...opts });
  const ctrl = await api.get('/api/auth/me', { token: forgeSigned() });
  const wrongKey = jwt.sign(claims, 'segredo-errado-de-teste', { algorithm: 'HS256', expiresIn: '5m' });
  const tampered = `${s['caixa.a1'].token.split('.')[0]}.${b64({ ...claims, userType: 'SUPER_ADMIN', exp: exp + 600 })}.${s['caixa.a1'].token.split('.')[2]}`;
  const algNone = `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ ...claims, userType: 'SUPER_ADMIN', exp: exp + 600 })}.`;
  const expired = forgeSigned({}, { expiresIn: -60 });
  const tries = await Promise.all([wrongKey, tampered, algNone, expired, 'lixo.lixo.lixo', 'x'].map((t) => api.get('/api/auth/me', { token: t })));
  if (ctrl.status === 200) {
    check('5/controle: token assinado com o segredo HML é aceito (a forja de teste está correta)', true);
    check('5/token com assinatura errada, adulterado (SUPER_ADMIN), alg=none, expirado e lixo: todos 401', tries.every((r) => r.status === 401), JSON.stringify(tries.map((r) => r.status)));
  } else {
    check('5/controle: token assinado com o segredo HML é aceito', false, `status ${ctrl.status} ${ctrl.text?.slice(0, 160)}`);
  }
  const noTok = await api.get('/api/customers');
  check('5/sem token: 401', noTok.status === 401, `status ${noTok.status}`);

  const l1 = await request('POST', '/api/auth/login', { body: { numericId: s['caixa.a2'].def.numericId, password: s['caixa.a2'].def.password }, idem: false, localAddress: '127.0.0.4' });
  const l2 = await request('POST', '/api/auth/login', { body: { numericId: s['caixa.a2'].def.numericId, password: s['caixa.a2'].def.password }, idem: false, localAddress: '127.0.0.5' });
  const t1 = l1.body?.accessToken || l1.body?.tokens?.accessToken || l1.body?.data?.accessToken;
  const t2 = l2.body?.accessToken || l2.body?.tokens?.accessToken || l2.body?.data?.accessToken;
  const r1 = l1.body?.refreshToken || l1.body?.tokens?.refreshToken || l1.body?.data?.refreshToken;
  const r2 = l2.body?.refreshToken || l2.body?.tokens?.refreshToken || l2.body?.data?.refreshToken;
  check('5/duas sessões simultâneas do mesmo usuário, ambas válidas', !!t1 && !!t2 && (await api.get('/api/auth/me', { token: t1 })).status === 200 && (await api.get('/api/auth/me', { token: t2 })).status === 200, `${l1.status}/${l2.status}`);
  const rf = await request('POST', '/api/auth/refresh', { body: { refreshToken: r1 }, idem: false });
  check('5/refresh devolve novo access token', rf.status === 200 && !!(rf.body?.accessToken || rf.body?.tokens?.accessToken || rf.body?.data?.accessToken), `status ${rf.status} ${rf.text?.slice(0, 120)}`);
  const lo = await request('POST', '/api/auth/logout', { body: { refreshToken: r2 }, token: t2, idem: false });
  check('5/logout aceito', lo.status === 200, `status ${lo.status}`);
  check('5/após logout o access token da sessão encerrada é rejeitado (revogação)', (await api.get('/api/auth/me', { token: t2 })).status === 401, 'token ainda aceito após logout');
  check('5/logout de uma sessão não derruba a outra do mesmo usuário', (await api.get('/api/auth/me', { token: t1 })).status === 200, 'sessão 1 caiu');
  const reuse = await request('POST', '/api/auth/refresh', { body: { refreshToken: r2 }, idem: false });
  check('5/após logout o refresh token não renova mais', reuse.status === 401, `status ${reuse.status}`);
  check('5/reapresentar refresh token já revogado é tratado como roubo: derruba TODAS as sessões do usuário', (await api.get('/api/auth/me', { token: t1 })).status === 401, 'sessão 1 seguiu válida');
  const rfFake = await request('POST', '/api/auth/refresh', { body: { refreshToken: crypto.randomBytes(40).toString('hex') }, idem: false });
  check('5/refresh token inventado: 401', rfFake.status === 401, `status ${rfFake.status}`);

  // ---------------------------------------------------------------- 6. força bruta, bloqueio de conta e MFA
  const mk = async (name) => {
    const password = pw();
    const email = `${name}.${run}@hml.local`;
    const r = await api.post('/api/users', { name: `[HML-STRESS] ${name} ${run}`, email, password, userType: 'OPERATOR', branchId: A.branches[0].id }, tok('ceo.a'));
    if (r.status !== 201) throw new Error(`criar usuário descartável ${name}: ${r.status} ${r.text}`);
    return { id: idOf(r), numericId: (r.body?.data ?? r.body).numericId, email, password };
  };
  const offU = await mk('off');
  const lo2 = await request('POST', '/api/auth/login', { body: { numericId: offU.numericId, password: offU.password }, idem: false, localAddress: '127.0.0.15' });
  const offTok = lo2.body?.accessToken || lo2.body?.tokens?.accessToken || lo2.body?.data?.accessToken;
  const offBefore = await api.get('/api/auth/me', { token: offTok });
  const offDel = await api.del(`/api/users/${offU.id}`, tok('ceo.a'));
  const offAfter = await api.get('/api/auth/me', { token: offTok });
  const offLogin = await request('POST', '/api/auth/login', { body: { numericId: offU.numericId, password: offU.password }, idem: false, localAddress: '127.0.0.15' });
  check('5/usuário desativado: token já emitido deixa de valer na hora e o login é recusado', offBefore.status === 200 && offDel.status < 300 && offAfter.status === 401 && offLogin.status >= 400 && offLogin.status < 500, `antes ${offBefore.status} desativar ${offDel.status} depois ${offAfter.status} login ${offLogin.status}`);
  const lockU = await mk('lock');
  const wrong = [];
  for (let i = 0; i < 4; i++) wrong.push(await request('POST', '/api/auth/login', { body: { numericId: lockU.numericId, password: `errada-${i}` }, idem: false, localAddress: '127.0.0.6' }));
  check('6/senha errada 3x: 3 recusas 401 e a 3ª/4ª já avisa bloqueio', wrong.slice(0, 2).every((r) => r.status === 401) && wrong.slice(2).every((r) => r.status === 401 || r.status === 423 || r.status === 429), JSON.stringify(wrong.map((r) => r.status)));
  const afterLock = await request('POST', '/api/auth/login', { body: { numericId: lockU.numericId, password: lockU.password }, idem: false, localAddress: '127.0.0.7' });
  check('6/senha CORRETA depois do bloqueio é recusada (conta travada)', afterLock.status >= 400 && afterLock.status < 500 && !afterLock.body?.accessToken, `status ${afterLock.status} ${afterLock.text?.slice(0, 120)}`);
  const lockedRow = db.run(`SELECT "loginAttempts", "lockedUntil" IS NOT NULL FROM users WHERE id = '${lockU.id}'`)[0];
  check('6/banco: tentativas contadas e lockedUntil gravado', Number(lockedRow?.[0]) >= 3 && lockedRow?.[1] === 't', JSON.stringify(lockedRow));
  const nonex = await request('POST', '/api/auth/login', { body: { numericId: 99999999, password: 'x' }, idem: false, localAddress: '127.0.0.8' });
  const exist = await request('POST', '/api/auth/login', { body: { numericId: s['caixa.a2'].def.numericId, password: 'errada' }, idem: false, localAddress: '127.0.0.8' });
  check('6/usuário inexistente e senha errada respondem igual (sem enumeração de usuários)', nonex.status === exist.status && (nonex.body?.message || nonex.body?.error) === (exist.body?.message || exist.body?.error), `${nonex.status} "${nonex.body?.message}" vs ${exist.status} "${exist.body?.message}"`);
  const flood = [];
  for (let i = 0; i < 8; i++) flood.push(await request('POST', '/api/auth/login', { body: { numericId: 99999999 + i, password: 'x' }, idem: false, localAddress: '127.0.0.9' }));
  check('6/bombardeio de login do mesmo IP: passa a 429 (limite por IP)', flood.some((r) => r.status === 429) && flood.every((r) => r.status < 500), JSON.stringify(flood.map((r) => r.status)));
  const legit = await request('POST', '/api/auth/login', { body: { numericId: s['caixa.a2'].def.numericId, password: s['caixa.a2'].def.password }, idem: false });
  check('6/usuário legítimo em outro IP não é afetado pelo bombardeio', legit.status === 200, `status ${legit.status}`);
  const lockedIpLogin = await request('POST', '/api/auth/login', { body: { numericId: s['caixa.a2'].def.numericId, password: s['caixa.a2'].def.password }, idem: false, localAddress: '127.0.0.9' });
  check('6/IP bloqueado fica bloqueado mesmo com credencial correta', lockedIpLogin.status === 429, `status ${lockedIpLogin.status}`);

  // MFA: usuário descartável com MFA ativo; 4 códigos errados -> bloqueio; o código certo depois também é recusado
  const mfaU = await mk('mfa');
  const lm = await request('POST', '/api/auth/login', { body: { numericId: mfaU.numericId, password: mfaU.password }, idem: false, localAddress: '127.0.0.10' });
  const accessM = lm.body?.accessToken || lm.body?.tokens?.accessToken || lm.body?.data?.accessToken;
  const setup = accessM ? await api.post('/api/mfa/setup', {}, { token: accessM }) : { status: 0 };
  const mfaSecret = (setup.body?.data ?? setup.body)?.secret;
  const ver = mfaSecret ? await api.post('/api/mfa/verify', { code: totp(mfaSecret) }, { token: accessM }) : { status: 0 };
  check('6/MFA do usuário descartável ativado', ver.status === 200, `login ${lm.status} setup ${setup.status} verify ${ver.status} ${ver.text?.slice(0, 120)}`);
  const step1 = await request('POST', '/api/auth/login', { body: { numericId: mfaU.numericId, password: mfaU.password }, idem: false, localAddress: '127.0.0.11' });
  check('6/login com MFA ativo exige o segundo fator (não entrega token só com a senha)', step1.body?.mfaRequired === true && !step1.body?.accessToken, `status ${step1.status} ${step1.text?.slice(0, 120)}`);
  const badCodes = [];
  for (let i = 0; i < 5; i++) badCodes.push(await request('POST', '/api/auth/verify-mfa', { body: { mfaToken: step1.body?.mfaToken, code: String(100000 + i * 7919).slice(0, 6) }, idem: false, localAddress: '127.0.0.11' }));
  check('6/código MFA errado repetido: recusas 4xx e depois 429, nunca 200/5xx', badCodes.every((r) => r.status >= 400 && r.status < 500) && badCodes.some((r) => r.status === 429), JSON.stringify(badCodes.map((r) => r.status)));
  const goodAfter = await request('POST', '/api/auth/verify-mfa', { body: { mfaToken: step1.body?.mfaToken, code: totp(mfaSecret) }, idem: false, localAddress: '127.0.0.11' });
  check('6/código MFA CORRETO durante o bloqueio também é recusado', goodAfter.status === 429 || goodAfter.status === 401, `status ${goodAfter.status}`);
  const guess = await request('POST', '/api/auth/verify-mfa', { body: { mfaToken: 'inventado', code: '000000' }, idem: false, localAddress: '127.0.0.12' });
  check('6/mfaToken inventado: 4xx', guess.status >= 400 && guess.status < 500, `status ${guess.status}`);

  // ---------------------------------------------------------------- 7. limite de taxa
  // Usuário descartável: 140 requisições em rajada > 100/min -> 429; outro usuário (legítimo) no mesmo instante não sofre.
  const rateU = await mk('rate');
  const rl = await request('POST', '/api/auth/login', { body: { numericId: rateU.numericId, password: rateU.password }, idem: false, localAddress: '127.0.0.13' });
  const rtok = rl.body?.accessToken || rl.body?.tokens?.accessToken || rl.body?.data?.accessToken;
  const burst = await par(140, () => api.get('/api/auth/me', { token: rtok }));
  const mixed = await Promise.all([par(60, () => api.get('/api/auth/me', { token: rtok })), par(10, () => api.get('/api/auth/me', tok('gerente.a2')))]);
  check('7/rajada de 140 requisições do mesmo usuário: parte vira 429 (limite geral 100/min)', burst.filter((r) => r.status === 429).length >= 30 && burst.every((r) => r.status === 200 || r.status === 429), `200=${burst.filter((r) => r.status === 200).length} 429=${burst.filter((r) => r.status === 429).length}`);
  check('7/429 traz Retry-After; sem 5xx', burst.filter((r) => r.status === 429).every((r) => r.headers['retry-after'] !== undefined), `retry-after ${burst.find((r) => r.status === 429)?.headers['retry-after']}`);
  check('7/outro usuário legítimo, no mesmo instante, segue 200 (limite é por identidade)', mixed[1].every((r) => r.status === 200), JSON.stringify(mixed[1].map((r) => r.status)));
  check('7/o usuário bombardeado segue bloqueado (429) nos pedidos seguintes', mixed[0].every((r) => r.status === 429), JSON.stringify([...new Set(mixed[0].map((r) => r.status))]));
  const authzU = await mk('authz');
  const la = await request('POST', '/api/auth/login', { body: { numericId: authzU.numericId, password: authzU.password }, idem: false, localAddress: '127.0.0.14' });
  const atok = la.body?.accessToken || la.body?.tokens?.accessToken || la.body?.data?.accessToken;
  const fakeSale = crypto.randomUUID();
  const authz = [];
  for (let i = 0; i < 5; i++) authz.push(await api.post(`/api/sales/${fakeSale}/cancel`, { reason: 'teste de limite do autorizador', authorizerNumericId: s['ceo.a'].def.numericId, authorizerPassword: `errada-${i}`, authorizerMfaCode: '000000' }, { token: atok }));
  check('7/autorizador com credencial errada: limite 3 por 5 min -> 429 e nunca sucesso/5xx', authz.every((r) => r.status >= 400 && r.status < 500) && authz.some((r) => r.status === 429), JSON.stringify(authz.map((r) => r.status)));
  const tickets = await par(25, (i) => api.post('/api/support/tickets', { subject: `[HML-STRESS] rajada ${i} ${run}`, module: 'PDV', type: 'DUVIDA', description: 'Abertura em rajada para medir limite' }, { token: atok }));
  check('7/abertura de chamado em rajada (25): sem 5xx', tickets.every((r) => r.status < 500), JSON.stringify(tickets.map((r) => r.status)));
  check('7/API de pé após o bombardeio', await alive(), 'health falhou');

  // limpeza: usuários descartáveis desativados (companyId explícito)
  for (const u of [lockU, mfaU, rateU, authzU]) {
    const r = await api.del(`/api/users/${u.id}`, tok('ceo.a'));
    if (r.status >= 500) check(`limpeza: usuário descartável ${u.numericId} desativado`, false, `status ${r.status}`);
  }
  S.finish();
})().catch((e) => { console.error('ERRO NA SUÍTE:', e); process.exit(2); });
