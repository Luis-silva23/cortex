'use client';

import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { centralApi, apiErrorMessage } from '@/lib/api';
import { LoadingState } from '../_components/states';
import { fmtDateTime, fmtInt } from '../_central/format';
import { Freshness, InlineError, Notice, Pill, StatusPill } from '../_central/ui';

// Serviços externos e controles de custo. A tela diz o que está CONFIGURADO (variáveis presentes) e o que foi de fato TESTADO — são coisas diferentes.
// Nenhum segredo trafega aqui: só "configurado ou não", host/domínio e contagens. Os ajustes só RESTRINGEM (o ambiente é o teto).
const STATE: Record<string, { label: string; status: string }> = {
  ACTIVE: { label: 'Ativo (configurado)', status: 'NORMAL' },
  DISABLED: { label: 'Configurado, desligado', status: 'NO_DATA' },
  PENDING_CONFIGURATION: { label: 'Pendente de configuração', status: 'NO_DATA' },
  INVALID: { label: 'Configuração inválida', status: 'CRITICAL' },
};
const TOGGLES: Array<{ key: string; label: string }> = [
  { key: 'emailNotifications', label: 'Notificações por e-mail' },
  { key: 'sentry', label: 'Envio de erros ao Sentry' },
  { key: 'sampling', label: 'Amostragem de saúde (histórico)' },
];
const LIMITS: Array<{ key: string; label: string; step?: number }> = [
  { key: 'emailMaxPerHour', label: 'E-mails por hora' },
  { key: 'emailMaxPerDay', label: 'E-mails por dia' },
  { key: 'emailMaxPerMonth', label: 'E-mails por mês' },
  { key: 'emailDedupeMinutes', label: 'Janela anti-repetição de e-mail (min)' },
  { key: 'sentryMaxPerHour', label: 'Eventos Sentry por hora' },
  { key: 'sentryMaxPerDay', label: 'Eventos Sentry por dia' },
  { key: 'sentrySampleRate', label: 'Amostragem de erros (0 a 1)', step: 0.05 },
  { key: 'sentryDedupeMinutes', label: 'Janela anti-repetição Sentry (min)' },
  { key: 'sampleMinutes', label: 'Intervalo entre amostras (min, só aumenta)' },
  { key: 'samplesMaxPerDay', label: 'Amostras por dia' },
];

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-2 border-b py-1.5 text-sm last:border-0">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right font-medium">{children}</span>
    </div>
  );
}

function Usage({ label, used, max }: { label: string; used: number; max: number }) {
  const pct = max > 0 ? Math.min(100, Math.round((used / max) * 100)) : 100;
  return (
    <div className="space-y-1" data-testid={`usage-${label}`}>
      <div className="flex justify-between text-xs">
        <span className="text-muted-foreground">{label}</span>
        <span className="tabular-nums">{fmtInt(used)} / {fmtInt(max)}{max === 0 ? ' (desligado)' : ''}</span>
      </div>
      <div className="h-1.5 rounded bg-muted" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
        <div className={`h-full rounded ${pct >= 90 ? 'bg-danger' : pct >= 70 ? 'bg-warning' : 'bg-foreground/60'}`} style={{ width: `${pct}%` }} />
      </div>
      {pct >= 70 && <p className="text-xs text-muted-foreground">Perto do limite: acima dele o envio é suprimido, sem contratar nada.</p>}
    </div>
  );
}

export default function ExternalServicesPage() {
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [toggles, setToggles] = useState<Record<string, boolean>>({});
  const [limits, setLimits] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [check, setCheck] = useState<any>(null);
  const [checking, setChecking] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await centralApi.external();
      setData(res.data);
      setToggles({ ...res.data.costControls.toggles });
      setLimits(Object.fromEntries(Object.entries(res.data.costControls.limits).map(([k, v]) => [k, String(v)])));
      setError(null);
    } catch (err: any) {
      setError(apiErrorMessage(err?.response?.data, 'Não foi possível carregar o estado dos serviços externos.'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async () => {
    setSaving(true);
    setSaveMsg(null);
    try {
      const ceilings = data.costControls.envCeilings as Record<string, number>;
      const limitPatch: Record<string, number | null> = {};
      for (const l of LIMITS) {
        const n = Number(limits[l.key]);
        if (!Number.isFinite(n)) throw new Error(`Valor inválido em "${l.label}".`);
        const current = data.costControls.limits[l.key] as number;
        // só envia o que mudou; voltar ao teto do ambiente remove o ajuste.
        if (n !== current) limitPatch[l.key] = n === ceilings[l.key] ? null : n;
      }
      const togglePatch: Record<string, boolean | null> = {};
      for (const t of TOGGLES) if (toggles[t.key] !== data.costControls.toggles[t.key]) togglePatch[t.key] = toggles[t.key] ? null : false;
      if (Object.keys(limitPatch).length + Object.keys(togglePatch).length === 0) {
        setSaveMsg({ ok: true, text: 'Nada para salvar.' });
        return;
      }
      await centralApi.saveSettings({ toggles: togglePatch, limits: limitPatch });
      setSaveMsg({ ok: true, text: 'Ajustes salvos e registrados na auditoria.' });
      await load();
    } catch (err: any) {
      setSaveMsg({ ok: false, text: err?.response ? apiErrorMessage(err.response.data, 'Não foi possível salvar.') : err?.message ?? 'Não foi possível salvar.' });
    } finally {
      setSaving(false);
    }
  };

  const runCheck = async () => {
    setChecking(true);
    try {
      setCheck((await centralApi.checkResend()).data);
    } catch (err: any) {
      setCheck({ checked: false, message: apiErrorMessage(err?.response?.data, 'A verificação não pôde ser feita.') });
    } finally {
      setChecking(false);
    }
  };

  if (loading && !data) return <LoadingState label="Carregando serviços externos..." />;
  if (!data) return <InlineError message={error ?? 'Sem dados.'} onRetry={load} />;

  const { sentry, resend, database, domain, figma, costControls } = data;
  const ceilings = costControls.envCeilings as Record<string, number>;

  return (
    <div className="space-y-6" data-testid="external-page">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Serviços externos e controle de custos</h2>
          <p className="text-sm text-muted-foreground">O monitoramento nativo funciona sem nenhum serviço de terceiros. Aqui fica o que é opcional, o que está só configurado e o que ainda depende de conta, chave ou domínio.</p>
        </div>
        <Freshness generatedAt={data.generatedAt} onRefresh={load} />
      </div>
      {error && <InlineError message={error} onRetry={load} />}
      <Notice testId="external-notice">Estado “configurado” significa que as variáveis existem, não que a conexão foi testada. Nenhuma conexão externa é declarada ativa sem teste real, e falha de serviço externo nunca interrompe a operação.</Notice>

      <section className="grid gap-4 lg:grid-cols-2">
        <Card data-testid="card-sentry">
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between gap-2">
              <CardTitle className="text-base">Sentry (erros da aplicação)</CardTitle>
              <StatusPill testId="sentry-state" status={STATE[sentry.state]?.status ?? 'NO_DATA'} label={STATE[sentry.state]?.label ?? sentry.state} />
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            <div>
              <Row label="Ambiente">{sentry.environment}</Row>
              <Row label="Destino">{sentry.host ?? '—'}</Row>
              <Row label="Amostragem de erros">{Math.round(sentry.sampleRate * 100)}%</Row>
              <Row label="Último envio bem-sucedido">{fmtDateTime(sentry.consumption.lastSentAt)}</Row>
              <Row label="Falhas de entrega (24 h)">{fmtInt(sentry.consumption.failed24h)}</Row>
              <Row label="Suprimidos por limite/repetição (24 h)">{fmtInt(sentry.consumption.suppressed24h)}</Row>
              <Row label="Disjuntor">{sentry.runtime.breaker.openUntil > Date.now() ? 'aberto (pausado após falhas)' : 'fechado'}</Row>
            </div>
            {sentry.state === 'ACTIVE' && (
              <div className="space-y-2">
                <Usage label="Sentry por hora" used={sentry.consumption.sent.hour} max={sentry.limits.perHour} />
                <Usage label="Sentry por dia" used={sentry.consumption.sent.day} max={sentry.limits.perDay} />
              </div>
            )}
            {sentry.consumption.lastFailure && <p className="text-xs text-muted-foreground">Última falha ({fmtDateTime(sentry.consumption.lastFailure.createdAt)}): {sentry.consumption.lastFailure.error}</p>}
            <p className="text-xs text-muted-foreground">{sentry.note}</p>
          </CardContent>
        </Card>

        <Card data-testid="card-resend">
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between gap-2">
              <CardTitle className="text-base">Resend (e-mail de alertas)</CardTitle>
              <StatusPill testId="resend-state" status={STATE[resend.state]?.status ?? 'NO_DATA'} label={STATE[resend.state]?.label ?? resend.state} />
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            <div>
              <Row label="Domínio do remetente">{resend.senderDomain ?? '—'}</Row>
              <Row label="Destinatários configurados">{fmtInt(resend.recipients)}</Row>
              {resend.missing.length > 0 && <Row label="Falta configurar">{resend.missing.join(', ')}</Row>}
              <Row label="Último envio bem-sucedido">{fmtDateTime(resend.consumption.lastSentAt)}</Row>
              <Row label="Falhas de entrega (24 h)">{fmtInt(resend.consumption.failed24h)}</Row>
              <Row label="Suprimidos por limite/repetição (24 h)">{fmtInt(resend.consumption.suppressed24h)}</Row>
              <Row label="Disjuntor">{resend.breaker.openUntil > Date.now() ? 'aberto (pausado após falhas)' : 'fechado'}</Row>
            </div>
            {resend.state === 'ACTIVE' && (
              <div className="space-y-2">
                <Usage label="E-mails por hora" used={resend.consumption.sent.hour} max={resend.limits.perHour} />
                <Usage label="E-mails por dia" used={resend.consumption.sent.day} max={resend.limits.perDay} />
                <Usage label="E-mails por mês" used={resend.consumption.sent.month} max={resend.limits.perMonth} />
              </div>
            )}
            {resend.consumption.lastFailure && <p className="text-xs text-muted-foreground">Última falha ({fmtDateTime(resend.consumption.lastFailure.createdAt)}): {resend.consumption.lastFailure.error}</p>}
            <div className="flex flex-wrap items-center gap-2">
              <Button type="button" size="sm" variant="outline" onClick={runCheck} disabled={checking || !resend.configured} data-testid="resend-check">
                {checking ? 'Verificando…' : 'Verificar domínio no provedor'}
              </Button>
              <span className="text-xs text-muted-foreground">Somente leitura: não envia e-mail.</span>
            </div>
            {check && (
              <p className="text-sm" role="status" data-testid="resend-check-result">
                {check.message}
                {check.domainStatus ? ` (estado: ${check.domainStatus})` : ''}
              </p>
            )}
            <p className="text-xs text-muted-foreground">{resend.note}</p>
          </CardContent>
        </Card>

        <Card data-testid="card-database">
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Banco de dados</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <Row label="Destino">{!database.configured ? 'não configurado' : database.kind === 'supabase' ? 'Supabase (detectado pelo endereço)' : database.kind === 'local' ? 'PostgreSQL local' : database.kind === 'invalid' ? 'endereço inválido' : 'PostgreSQL externo'}</Row>
            <Row label="Host">{database.host ?? '—'}{database.port ? `:${database.port}` : ''}</Row>
            <Row label="Pooler de conexões">{database.usesPooler === null ? '—' : database.usesPooler ? 'sim' : 'não'}</Row>
            <Row label="sslmode">{database.sslmode ?? 'não definido'}</Row>
            {database.kind === 'local' && <Pill className="bg-muted text-foreground border-border" testId="db-local">Ambiente local — não validado para produção</Pill>}
            <p className="text-xs text-muted-foreground">{database.note}</p>
          </CardContent>
        </Card>

        <Card data-testid="card-domain">
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between gap-2">
              <CardTitle className="text-base">Domínio, HTTPS e hospedagem</CardTitle>
              <StatusPill testId="domain-state" status={domain.productionReady ? 'NORMAL' : 'NO_DATA'} label={domain.productionReady ? 'Endereços prontos' : 'Pendente'} />
            </div>
          </CardHeader>
          <CardContent className="space-y-2">
            {domain.entries.map((e: any) => (
              <Row key={e.key} label={e.key}>
                {!e.set ? 'não definido' : `${e.host ?? 'inválido'}${e.https ? ' · HTTPS' : ' · sem HTTPS'}${e.local ? ' · local' : ''}`}
              </Row>
            ))}
            <Row label="TRUST_PROXY">{domain.trustProxySet ? 'definido' : 'não definido'}</Row>
            <p className="text-xs text-muted-foreground">{domain.note}</p>
          </CardContent>
        </Card>

        <Card data-testid="card-figma">
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between gap-2">
              <CardTitle className="text-base">Figma (referência visual)</CardTitle>
              <StatusPill testId="figma-state" status="NO_DATA" label="Dependência externa pendente" />
            </div>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">{figma.note}</p>
          </CardContent>
        </Card>
      </section>

      <Card data-testid="cost-controls">
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Controle de custos e volume</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">{costControls.note}</p>
          <p className="text-xs text-muted-foreground">
            Retenção (ambiente): amostras {costControls.retentionDays.sampleDays} dias · entregas {costControls.retentionDays.deliveryDays} dias · alertas resolvidos {costControls.retentionDays.alertDays} dias.
          </p>
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">Telemetria não essencial</legend>
            {TOGGLES.map((t) => (
              <label key={t.key} className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={toggles[t.key] ?? true} onChange={(e) => setToggles({ ...toggles, [t.key]: e.target.checked })} data-testid={`toggle-${t.key}`} />
                {t.label}
              </label>
            ))}
            <p className="text-xs text-muted-foreground">Desligar nunca afeta a operação: o painel nativo e o centro de alertas continuam funcionando.</p>
          </fieldset>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {LIMITS.map((l) => (
              <label key={l.key} className="text-xs text-muted-foreground">
                {l.label}
                <Input
                  type="number"
                  inputMode="decimal"
                  step={l.step ?? 1}
                  min={0}
                  value={limits[l.key] ?? ''}
                  onChange={(e) => setLimits({ ...limits, [l.key]: e.target.value })}
                  className="mt-1"
                  data-testid={`limit-${l.key}`}
                />
                <span className="mt-0.5 block text-[11px]">teto do ambiente: {ceilings[l.key]}{costControls.overridden.includes(l.key) ? ' · ajustado nesta tela' : ''}</span>
              </label>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Button type="button" onClick={save} disabled={saving} data-testid="settings-save">
              {saving ? 'Salvando…' : 'Salvar ajustes'}
            </Button>
            {saveMsg && (
              <span role={saveMsg.ok ? 'status' : 'alert'} className={`text-sm ${saveMsg.ok ? 'text-muted-foreground' : 'text-danger'}`} data-testid="settings-msg">
                {saveMsg.text}
              </span>
            )}
          </div>
          <p className="text-xs text-muted-foreground">Valores acima do teto do ambiente não têm efeito (o servidor mantém o teto); para aumentar um teto é preciso alterar a configuração do ambiente. Nenhum plano é contratado e nenhum excedente é autorizado automaticamente.</p>
        </CardContent>
      </Card>
    </div>
  );
}
