import { Job } from 'bullmq';
import { createHash } from 'crypto';
import { Logger } from '../services/logger.service';
import { resendConfig, sendEmail } from '../services/monitoring-central/resend.service';

const logger = Logger; // Logger tem apenas métodos estáticos, não getInstance()

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
/** Escapa os valores de texto dos dados do modelo (nome, link...) antes de entrarem no HTML do e-mail. */
function escapeValues(data: Record<string, any> | undefined): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(data ?? {})) out[k] = typeof v === 'string' ? escapeHtml(v) : v;
  return out;
}

export interface EmailJobData {
  to: string;
  subject: string;
  template: 'welcome' | 'reset-password' | 'invoice' | 'payment-confirmation' | 'license-expiring';
  data: Record<string, any>;
  companyId?: string;
}

/**
 * Processa envio de emails
 */
export async function processEmailJob(job: Job<EmailJobData>) {
  const { to, template, companyId } = job.data;

  try {
    // Sem o endereço do destinatário no log (dado pessoal): job, modelo e empresa bastam para rastrear.
    logger.job(job.name, 'started', {
      jobId: job.id,
      template,
      companyId,
    });

    // Resend (opcional): só envia e-mail transacional com a configuração completa E o aceite explícito RESEND_TRANSACTIONAL=true (o aviso de alerta às pessoas
    // da operação não autoriza, sozinho, e-mail a clientes). Compartilha os limites e a deduplicação do provedor; HTML com dados escapados.
    if (resendConfig().configured && process.env.RESEND_TRANSACTIONAL === 'true') {
      const render = (emailTemplates as Record<string, (d: any) => { subject: string; html: string }>)[template];
      if (!render) throw new Error(`modelo de e-mail desconhecido: ${template}`);
      const message = render(escapeValues(job.data.data));
      const result = await sendEmail({
        subject: message.subject,
        text: message.html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(),
        html: message.html,
        dedupeKey: `tx:${template}:${createHash('sha256').update(to).digest('hex').slice(0, 16)}:${job.id}`,
        to: [to],
      });
      logger.job(job.name, 'completed', { jobId: job.id, template, companyId, delivery: result.status, reason: result.reason });
      return { success: result.status === 'SENT', simulated: false, template, status: result.status, reason: result.reason };
    }

    // Nenhum provedor de e-mail integrado: nunca fingir sucesso (mesmo padrão de fiscal/payment-adapters).
    logger.job(job.name, 'completed', {
      jobId: job.id,
      template,
      simulated: true,
      note: 'Nenhum provedor real de e-mail configurado — envio simulado',
    });

    return {
      success: false,
      simulated: true,
      to,
      template,
      reason: 'Nenhum provedor real de e-mail configurado (SendGrid/SES) — BLOCKED BY EXTERNAL DEPENDENCY',
    };
  } catch (error) {
    logger.error('Failed to send email', {
      jobId: job.id,
      template,
      error: (error as Error).message,
    });
    throw error;
  }
}

/**
 * Templates de email
 */
export const emailTemplates = {
  welcome: (data: { userName: string; companyName: string }) => ({
    subject: `Bem-vindo ao ${data.companyName}!`,
    html: `<h1>Olá ${data.userName}!</h1><p>Bem-vindo ao sistema LN System Cloud.</p>`,
  }),

  'reset-password': (data: { userName: string; resetLink: string }) => ({
    subject: 'Redefinição de senha',
    html: `<h1>Olá ${data.userName}!</h1><p>Clique no link para redefinir sua senha: <a href="${data.resetLink}">Redefinir</a></p>`,
  }),

  invoice: (data: { invoiceNumber: string; amount: number; dueDate: string }) => ({
    subject: `Fatura ${data.invoiceNumber}`,
    html: `<h1>Nova Fatura</h1><p>Valor: R$ ${data.amount.toFixed(2)}</p><p>Vencimento: ${data.dueDate}</p>`,
  }),

  'payment-confirmation': (data: { saleId: string; amount: number; method: string }) => ({
    subject: 'Confirmação de Pagamento',
    html: `<h1>Pagamento Confirmado</h1><p>Venda: ${data.saleId}</p><p>Valor: R$ ${data.amount.toFixed(2)}</p><p>Método: ${data.method}</p>`,
  }),

  'license-expiring': (data: { companyName: string; daysRemaining: number; planName: string }) => ({
    subject: 'Sua licença está expirando',
    html: `<h1>Atenção ${data.companyName}!</h1><p>Sua licença do plano ${data.planName} expira em ${data.daysRemaining} dias.</p>`,
  }),
};
