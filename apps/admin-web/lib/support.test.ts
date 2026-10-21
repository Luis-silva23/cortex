import {
  buildReportHref,
  contextTrail,
  checkAttachment,
  eventPhrase,
  formatBytes,
  NEW_TICKET_PATH,
  parseReportParams,
  requesterActions,
  type SupportCatalog,
} from './support';

const catalog: Pick<SupportCatalog, 'modules' | 'entityTypes'> = {
  modules: [
    { value: 'OFICINA', label: 'Oficina' },
    { value: 'FINANCEIRO', label: 'Financeiro' },
  ],
  entityTypes: [
    { value: 'SERVICE_ORDER', label: 'Ordem de serviço' },
    { value: 'RECEIVABLE', label: 'Cobrança' },
  ],
};
const ID = '3f2b8c1e-4a5d-4e6f-8a9b-0c1d2e3f4a5b';
const limits: SupportCatalog['attachments'] = { maxBytes: 2 * 1024 * 1024, perTicket: 10, types: { image: ['.png', '.jpg', '.jpeg'], doc: ['.pdf'], text: ['.log', '.txt'] } };
const params = (href: string) => new URL(href, 'http://x').searchParams;

describe('Central de Ajuda — link "Relatar problema"', () => {
  it('ida e volta: o que a tela monta, o formulário lê', () => {
    const href = buildReportHref({ module: 'OFICINA', screen: 'Oficina → OS #12', entityType: 'SERVICE_ORDER', entityId: ID });
    expect(href.startsWith(`${NEW_TICKET_PATH}?`)).toBe(true);
    expect(parseReportParams(params(href), catalog)).toEqual({ module: 'OFICINA', screen: 'Oficina → OS #12', entityType: 'SERVICE_ORDER', entityId: ID });
  });

  it('entidade só entra com tipo E id', () => {
    expect(params(buildReportHref({ module: 'OFICINA', entityType: 'SERVICE_ORDER' })).has('entityType')).toBe(false);
  });

  it('módulo fora do catálogo ou ausente: sem contexto (o formulário abre vazio)', () => {
    expect(parseReportParams(params('/x?module=HACK'), catalog)).toBeNull();
    expect(parseReportParams(params('/x'), catalog)).toBeNull();
  });

  it('id malformado ou tipo desconhecido são descartados, o resto permanece', () => {
    expect(parseReportParams(params(`/x?module=OFICINA&entityType=SERVICE_ORDER&entityId=1%27%20OR%201=1`), catalog)).toEqual({ module: 'OFICINA' });
    expect(parseReportParams(params(`/x?module=OFICINA&entityType=SECRET&entityId=${ID}`), catalog)).toEqual({ module: 'OFICINA' });
  });

  it('rota só relativa (sem URL externa) e textos limitados', () => {
    expect(parseReportParams(params('/x?module=OFICINA&route=https://evil.test'), catalog)).toEqual({ module: 'OFICINA' });
    expect(parseReportParams(params(`/x?module=OFICINA&route=/dashboard/${'a'.repeat(400)}`), catalog)?.route).toHaveLength(200);
    expect(parseReportParams(params(`/x?module=OFICINA&screen=${'b'.repeat(300)}`), catalog)?.screen).toHaveLength(80);
  });
});

describe('Central de Ajuda — anexos (UX; o servidor revalida pelo conteúdo)', () => {
  it('aceita PNG, PDF e log dentro do limite', () => {
    expect(checkAttachment({ name: 'Erro.PNG', size: 1000 }, limits)).toBeNull();
    expect(checkAttachment({ name: 'nota.pdf', size: 1000 }, limits)).toBeNull();
    expect(checkAttachment({ name: 'app.log', size: 1000 }, limits)).toBeNull();
  });
  it('recusa executável/script, sem extensão, vazio e acima de 2 MB', () => {
    for (const name of ['virus.exe', 'run.bat', 'x.ps1', 'page.html', 'semextensao']) {
      expect(checkAttachment({ name, size: 10 }, limits)).toMatch(/tipo não aceito/);
    }
    expect(checkAttachment({ name: 'a.png', size: 0 }, limits)).toMatch(/vazio/);
    expect(checkAttachment({ name: 'a.png', size: limits.maxBytes + 1 }, limits)).toMatch(/limite é 2,0 MB/);
  });
  it('extensão dupla perigosa não passa (vale a última)', () => {
    expect(checkAttachment({ name: 'foto.png.exe', size: 10 }, limits)).toMatch(/tipo não aceito/);
  });
  it('formatBytes', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2 KB');
    expect(formatBytes(2 * 1024 * 1024)).toBe('2,0 MB');
  });
});

describe('Central de Ajuda — histórico e ações', () => {
  const labels = { ABERTO: 'Aberto', EM_ANALISE: 'Em análise' };
  const actor = { name: 'Ana', role: 'REQUESTER' };
  it('frases do histórico em português', () => {
    expect(eventPhrase({ type: 'OPENED', fromValue: null, toValue: null, actor }, labels)).toBe('Chamado aberto por Ana');
    expect(eventPhrase({ type: 'STATUS_CHANGED', fromValue: 'ABERTO', toValue: 'EM_ANALISE', actor: { name: 'Leo', role: 'SUPPORT' } }, labels)).toBe(
      'Situação alterada de Aberto para Em análise por Leo (Suporte CÓRTEX)'
    );
    expect(eventPhrase({ type: 'ATTACHMENT_ADDED', fromValue: null, toValue: 'log.txt', actor }, labels)).toBe('Anexo "log.txt" incluído por Ana');
    expect(eventPhrase({ type: 'NOVO_TIPO', fromValue: null, toValue: null, actor }, labels)).toBe('NOVO_TIPO — Ana');
  });
  it('ações por situação: encerrado não recebe mensagem; só resolvido reabre; só o solicitante encerra', () => {
    expect(requesterActions('ABERTO', true)).toEqual({ canReply: true, canAttach: true, canClose: true, canReopen: false });
    expect(requesterActions('ABERTO', false).canClose).toBe(false);
    expect(requesterActions('RESOLVIDO', true).canReopen).toBe(true);
    expect(requesterActions('ENCERRADO', true)).toEqual({ canReply: false, canAttach: false, canClose: false, canReopen: false });
  });
  it('caminho do contexto: não repete módulo nem entidade já presentes na tela', () => {
    expect(contextTrail('Oficina', 'Oficina → OS #110', 'OS #110')).toBe('Oficina → OS #110');
    expect(contextTrail('Financeiro', 'Financeiro → Cobrança', 'Conta a receber — Ordem de Serviço #112')).toBe('Financeiro → Cobrança → Conta a receber — Ordem de Serviço #112');
    expect(contextTrail('PDV', 'Vendas')).toBe('PDV → Vendas');
    expect(contextTrail(undefined, undefined, 'OS #1')).toBe('OS #1');
    expect(contextTrail()).toBe('');
  });
});
