'use client';

import { Pill } from '../../_central/ui';

// Situação REAL de um canal de aviso (e-mail, SMS, WhatsApp): o que ele faz agora, do que depende fora do sistema e o que falta. Canal pendente NUNCA é apresentado como
// funcionando. Nada aqui recebe segredo: só estado, nomes de variáveis pendentes e textos fixos.
export type ChannelKey = 'email' | 'sms' | 'whatsapp';

export interface ChannelDependency {
  kind: 'Contratação' | 'Aprovação externa' | 'Configuração no servidor';
  text: string;
}

export const CHANNEL_DEPENDENCIES: Record<ChannelKey, ChannelDependency[]> = {
  email: [
    { kind: 'Contratação', text: 'Conta no provedor de e-mail (Resend). Há plano gratuito com limite próprio — confira a página do provedor; o CÓRTEX só limita, não contrata.' },
    { kind: 'Aprovação externa', text: 'Domínio remetente verificado no provedor (registros DNS SPF/DKIM).' },
    { kind: 'Configuração no servidor', text: 'Chave de API, remetente, destinatários e a declaração de domínio verificado (variáveis de ambiente do servidor).' },
  ],
  sms: [
    { kind: 'Contratação', text: 'Conta no provedor de SMS (Twilio), paga ou pré-paga. Nenhuma conta foi criada.' },
    { kind: 'Aprovação externa', text: 'Remetente apto a enviar SMS no Brasil (cada operadora tem regras próprias de cadastro/aprovação).' },
    { kind: 'Configuração no servidor', text: 'Credenciais, remetente, números de destino e a declaração de remetente verificado (variáveis de ambiente do servidor).' },
  ],
  whatsapp: [
    { kind: 'Contratação', text: 'Conta em provedor OFICIAL (WhatsApp Cloud API da Meta e/ou Twilio WhatsApp). Nenhuma conta foi criada.' },
    { kind: 'Aprovação externa', text: 'Número habilitado e modelo de mensagem APROVADO no provedor (mensagem iniciada pela empresa só pode usar modelo aprovado).' },
    { kind: 'Configuração no servidor', text: 'Credenciais, número/modelo, destinatários e a declaração de modelo aprovado (variáveis de ambiente do servidor).' },
  ],
};

/** Texto fixo da situação, por estado. Pendente e desligado dizem com todas as letras que NADA é enviado. */
export function situationText(state: string, sentMonth: number): { tone: 'bad' | 'neutral' | 'ok'; text: string } {
  if (state === 'PENDING_CONFIGURATION') return { tone: 'bad', text: 'NÃO está funcionando: nenhuma mensagem é enviada por este canal enquanto as pendências abaixo não forem resolvidas.' };
  if (state === 'DISABLED') return { tone: 'neutral', text: 'Configurado, mas DESLIGADO nesta tela: nenhuma mensagem é enviada.' };
  if (state === 'INVALID') return { tone: 'bad', text: 'Configuração inválida: nenhuma mensagem é enviada até corrigir.' };
  return {
    tone: 'ok',
    text: sentMonth > 0 ? 'Configurado e ligado. "Enviado" significa aceito pelo provedor; a entrega no aparelho não é confirmada.' : 'Configurado e ligado, mas ainda sem nenhum envio registrado e sem teste de ponta a ponta: faça um teste real e confirme no aparelho antes de confiar neste canal.',
  };
}

export function ChannelSituation({ channel, state, missing, sentMonth, invalidRecipients }: { channel: ChannelKey; state: string; missing: string[]; sentMonth: number; invalidRecipients?: number }) {
  const s = situationText(state, sentMonth);
  const border = s.tone === 'bad' ? 'border-warning/40 bg-warning-soft' : 'border-border bg-muted';
  return (
    <div className="space-y-2" data-testid={`situation-${channel}`}>
      <p role="note" className={`rounded-md border px-3 py-2 text-sm ${border}`} data-testid={`situation-${channel}-text`}>
        {s.text}
      </p>
      {state !== 'ACTIVE' && (
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Depende de</p>
          <ul className="mt-1 space-y-1 text-xs text-muted-foreground" data-testid={`dependencies-${channel}`}>
            {CHANNEL_DEPENDENCIES[channel].map((d) => (
              <li key={d.kind} className="flex flex-wrap items-start gap-2">
                <Pill className="shrink-0 border-border bg-muted text-foreground">{d.kind}</Pill>
                <span className="min-w-0 flex-1 break-words">{d.text}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {missing.length > 0 && (
        <p className="break-words text-xs text-muted-foreground" data-testid={`missing-${channel}`}>
          <span className="font-medium text-foreground">Falta no servidor:</span> {missing.join(' · ')}
        </p>
      )}
      {invalidRecipients ? <p className="text-xs text-warning">{invalidRecipients} destinatário(s) com número inválido foram ignorados.</p> : null}
    </div>
  );
}
