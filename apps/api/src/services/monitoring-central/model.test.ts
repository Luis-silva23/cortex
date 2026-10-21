import {
  actionRefusal,
  alertCategory,
  alertGuidance,
  alertStatus,
  availability,
  classifyChannel,
  classifyIntegrations,
  companyLifecycle,
  computeFunnel,
  integrationSummary,
  isStale,
  monthlyCounts,
  severityRank,
  type ChannelInput,
} from './model';

const day = 86_400_000;
const t0 = new Date('2026-10-01T12:00:00Z');
const at = (days: number) => new Date(t0.getTime() + days * day);

describe('disponibilidade', () => {
  it('= amostras sem OFFLINE ÷ amostras coletadas; lacuna reduz a cobertura, não a disponibilidade', () => {
    const r = availability([{ status: 'NORMAL' }, { status: 'NORMAL' }, { status: 'ATTENTION' }, { status: 'OFFLINE' }], 8);
    expect(r).toEqual({ samples: 4, down: 1, availabilityPct: 75, coveragePct: 50 });
  });
  it('sem amostra: sem dado (null), nunca 100%', () => {
    expect(availability([], 10)).toEqual({ samples: 0, down: 0, availabilityPct: null, coveragePct: 0 });
    expect(availability([{ status: 'NORMAL' }], 0).coveragePct).toBeNull();
  });
  it('a cobertura nunca passa de 100%', () => {
    expect(availability(Array.from({ length: 12 }, () => ({ status: 'NORMAL' })), 10).coveragePct).toBe(100);
  });
  it('dado desatualizado: última amostra mais velha que 3 intervalos; sem amostra também conta como sem dado recente', () => {
    const now = new Date('2026-10-01T12:20:00Z');
    expect(isStale(new Date('2026-10-01T12:10:00Z'), now, 5 * 60_000)).toBe(false);
    expect(isStale(new Date('2026-10-01T12:00:00Z'), now, 5 * 60_000)).toBe(true);
    expect(isStale(null, now, 5 * 60_000)).toBe(true);
  });
});

describe('ciclo de vida da empresa', () => {
  it('suspensa se inativa; ativa só com licença ativa E primeiro acesso; senão em implantação', () => {
    expect(companyLifecycle({ isActive: false, hasActiveLicense: true, hasEverLoggedIn: true })).toBe('SUSPENDED');
    expect(companyLifecycle({ isActive: true, hasActiveLicense: true, hasEverLoggedIn: true })).toBe('ACTIVE');
    expect(companyLifecycle({ isActive: true, hasActiveLicense: false, hasEverLoggedIn: true })).toBe('ONBOARDING');
    expect(companyLifecycle({ isActive: true, hasActiveLicense: true, hasEverLoggedIn: false })).toBe('ONBOARDING');
  });
});

describe('integrações por empresa', () => {
  const ch = (over: Partial<ChannelInput>): ChannelInput => ({ id: 'c1', name: 'Site', provider: 'sandbox', isActive: true, connectionStatus: 'CONNECTED', lastSyncAt: null, deadOutbox24h: 0, ...over });

  it('cada estado de canal é diferenciado: desativado, não configurado, não verificado, erro, degradado e saudável', () => {
    expect(classifyChannel(ch({ isActive: false })).state).toBe('DISABLED');
    expect(classifyChannel(ch({ connectionStatus: 'NOT_CONFIGURED' })).state).toBe('NOT_CONFIGURED');
    expect(classifyChannel(ch({ connectionStatus: 'UNVALIDATED' })).state).toBe('NOT_VERIFIED');
    expect(classifyChannel(ch({ connectionStatus: 'ERROR' })).state).toBe('ERROR');
    expect(classifyChannel(ch({ deadOutbox24h: 2 })).state).toBe('DEGRADED');
    expect(classifyChannel(ch({})).state).toBe('HEALTHY');
  });

  it('fiscal e pagamento são SEMPRE listados e nunca contam como saudáveis (não há integração automática verificável)', () => {
    const items = classifyIntegrations({ channels: [], fiscal: { branchesConfigured: 0, fiscalEnabled: 0, withCertificate: 0 }, automaticPaymentProvider: false });
    expect(items.map((i) => [i.kind, i.state])).toEqual([['FISCAL', 'NOT_CONFIGURED'], ['PAYMENT', 'NOT_CONFIGURED']]);
    const withCert = classifyIntegrations({ channels: [], fiscal: { branchesConfigured: 1, fiscalEnabled: 1, withCertificate: 1 }, automaticPaymentProvider: true });
    expect(withCert.map((i) => i.state)).toEqual(['NOT_VERIFIED', 'NOT_VERIFIED']);
    expect(classifyIntegrations({ channels: [], fiscal: { branchesConfigured: 1, fiscalEnabled: 1, withCertificate: 0 }, automaticPaymentProvider: false })[0].reason).toMatch(/sem certificado/);
  });

  it('saúde = (saudáveis + ½ degradadas) ÷ verificadas; sem nenhuma verificada o resultado é null — nunca 100%', () => {
    const none = integrationSummary(classifyIntegrations({ channels: [ch({ connectionStatus: 'UNVALIDATED' })], fiscal: { branchesConfigured: 0, fiscalEnabled: 0, withCertificate: 0 }, automaticPaymentProvider: false }));
    expect(none.healthPct).toBeNull();
    expect(none.verified).toBe(0);
    expect(none.notVerified).toBe(1);

    const mixed = integrationSummary([
      classifyChannel(ch({ id: 'a' })),
      classifyChannel(ch({ id: 'b' })),
      classifyChannel(ch({ id: 'c', deadOutbox24h: 1 })),
      classifyChannel(ch({ id: 'd', connectionStatus: 'ERROR' })),
      classifyChannel(ch({ id: 'e', isActive: false })),
      classifyChannel(ch({ id: 'f', connectionStatus: 'NOT_CONFIGURED' })),
    ]);
    expect(mixed).toMatchObject({ healthy: 2, degraded: 1, error: 1, disabled: 1, notConfigured: 1, verified: 4, healthPct: 62.5 });
  });
});

describe('alertas', () => {
  it('categoria pelo tipo', () => {
    expect(alertCategory('DATABASE_DEGRADED')).toBe('DATABASE');
    expect(alertCategory('QUEUE_WORKER_DOWN')).toBe('QUEUES');
    expect(alertCategory('JOB_OVERDUE')).toBe('QUEUES');
    expect(alertCategory('SERVER_DISK')).toBe('HOST');
    expect(alertCategory('BACKUP_VERIFY_FAILED')).toBe('BACKUP');
    expect(alertCategory('INTEGRATION_HEALTH')).toBe('INTEGRATION');
    expect(alertCategory('EMAIL_DELIVERY_FAILING')).toBe('NOTIFICATION');
    expect(alertCategory('ALGO_NOVO')).toBe('OTHER');
  });

  it('estado exposto: encerrado é RESOLVIDO; aberto usa o tratamento registrado', () => {
    expect(alertStatus({ endedAt: new Date(), handling: 'IN_PROGRESS' })).toBe('RESOLVED');
    expect(alertStatus({ endedAt: null, handling: 'ACKNOWLEDGED' })).toBe('ACKNOWLEDGED');
    expect(alertStatus({ endedAt: null, handling: 'IN_PROGRESS' })).toBe('IN_PROGRESS');
    expect(alertStatus({ endedAt: null, handling: 'qualquer' })).toBe('OPEN');
  });

  it('transições: não reconhece duas vezes, não trata resolvido, só reabre resolvido, nota vale sempre', () => {
    expect(actionRefusal('OPEN', 'ACKNOWLEDGE')).toBeNull();
    expect(actionRefusal('ACKNOWLEDGED', 'ACKNOWLEDGE')).toMatch(/já foi reconhecido/);
    expect(actionRefusal('IN_PROGRESS', 'START')).toMatch(/já está em tratamento/);
    expect(actionRefusal('ACKNOWLEDGED', 'START')).toBeNull();
    expect(actionRefusal('RESOLVED', 'ACKNOWLEDGE')).toMatch(/já resolvido/);
    expect(actionRefusal('RESOLVED', 'RESOLVE')).toMatch(/já resolvido/);
    expect(actionRefusal('RESOLVED', 'REOPEN')).toBeNull();
    expect(actionRefusal('OPEN', 'REOPEN')).toMatch(/só um alerta resolvido/);
    for (const s of ['OPEN', 'ACKNOWLEDGED', 'IN_PROGRESS', 'RESOLVED'] as const) expect(actionRefusal(s, 'NOTE')).toBeNull();
    expect(actionRefusal('IN_PROGRESS', 'RESOLVE')).toBeNull();
  });

  it('orientação existe para os tipos conhecidos e não inventa para o desconhecido', () => {
    expect(alertGuidance('DATABASE_DEGRADED')).toMatch(/PostgreSQL/);
    expect(alertGuidance('BACKUP_VERIFY_FAILED')).toMatch(/NÃO confie/);
    expect(alertGuidance('BACKUP_STALE')).toMatch(/Backup velho/);
    expect(alertGuidance('ALGO_NOVO')).toBeNull();
  });

  it('ordem de gravidade', () => {
    expect(['NORMAL', 'OFFLINE', 'ATTENTION', 'CRITICAL', 'NO_DATA'].sort((a, b) => severityRank(b) - severityRank(a))).toEqual(['OFFLINE', 'CRITICAL', 'ATTENTION', 'NORMAL', 'NO_DATA']);
  });
});

describe('funil comercial', () => {
  const lead = (id: string, stage: string, entered = 0) => ({ id, stage, stageEnteredAt: at(entered), createdAt: at(0) });
  const ev = (leadId: string, from: string | null, to: string, d: number) => ({ leadId, fromStage: from, toStage: to, createdAt: at(d) });

  it('sem nenhuma oportunidade o funil é vazio e os indicadores são null (nada inventado)', () => {
    const f = computeFunnel([], [], at(30));
    expect(f.total).toBe(0);
    expect(f.reached.INTERESTED).toBe(0);
    expect(f.conversions.every((c) => c.pct === null)).toBe(true);
    expect(Object.values(f.avgDaysInStage).every((v) => v === null)).toBe(true);
  });

  it('conversão = alcançaram a etapa seguinte ÷ alcançaram a anterior; tempo médio só de permanências concluídas', () => {
    const leads = [lead('A', 'PROPOSAL', 6), lead('B', 'DEMO', 2), lead('C', 'INTERESTED', 0)];
    const events = [
      ev('A', null, 'INTERESTED', 0), ev('A', 'INTERESTED', 'DEMO', 2), ev('A', 'DEMO', 'PROPOSAL', 6),
      ev('B', null, 'INTERESTED', 0), ev('B', 'INTERESTED', 'DEMO', 2),
      ev('C', null, 'INTERESTED', 0),
    ];
    const f = computeFunnel(leads, events, at(10));
    expect(f.current).toMatchObject({ INTERESTED: 1, DEMO: 1, PROPOSAL: 1 });
    expect(f.reached).toMatchObject({ INTERESTED: 3, DEMO: 2, PROPOSAL: 1, ONBOARDING: 0 });
    expect(f.conversions.find((c) => c.from === 'INTERESTED')?.pct).toBe(66.7);
    expect(f.conversions.find((c) => c.from === 'DEMO')?.pct).toBe(50);
    expect(f.conversions.find((c) => c.from === 'PROPOSAL')?.pct).toBe(0);
    expect(f.avgDaysInStage.INTERESTED).toBe(2); // A e B saíram em 2 dias; C ainda está lá e não entra na média
    expect(f.avgDaysInStage.DEMO).toBe(4); // só A concluiu a permanência em DEMO (2 → 6)
    expect(f.avgDaysInStage.PROPOSAL).toBeNull();
  });

  it('anotação na mesma etapa (vínculo com a empresa) não é mudança de etapa', () => {
    const f = computeFunnel(
      [lead('A', 'ONBOARDING', 3)],
      [ev('A', null, 'INTERESTED', 0), ev('A', 'INTERESTED', 'ONBOARDING', 3), ev('A', 'ONBOARDING', 'ONBOARDING', 5)],
      at(6)
    );
    expect(f.reached.ONBOARDING).toBe(1);
    expect(f.avgDaysInStage.ONBOARDING).toBeNull();
  });

  it('oportunidade sem histórico (anterior ao registro) conta a etapa atual como alcançada', () => {
    const f = computeFunnel([lead('X', 'DEMO')], [], at(1));
    expect(f.reached.DEMO).toBe(1);
  });

  it('empresas paradas em implantação: acima do limite de dias', () => {
    const f = computeFunnel([lead('A', 'ONBOARDING', 0), lead('B', 'ONBOARDING', 20)], [], at(25), 14);
    expect(f.stuckOnboarding).toEqual([{ id: 'A', days: 25 }]);
  });

  it('meses em UTC', () => {
    expect(monthlyCounts([new Date('2026-08-31T23:00:00Z'), new Date('2026-09-01T00:00:00Z'), new Date('2026-09-15T00:00:00Z')])).toEqual([
      { month: '2026-08', count: 1 },
      { month: '2026-09', count: 2 },
    ]);
  });
});
