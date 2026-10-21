'use client';

import { useEffect, useState } from 'react';
import { CheckCircle2, Loader2, ShieldCheck } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { api } from '@/lib/api';
import { formatCurrency } from '@/lib/utils';
import { buildCancelPayload, emptyCancelForm, validateAuthorizer, validateReason, type CancelFormValues } from '@/lib/sales';

export interface CancelableSale {
  id: string;
  saleNumber: number;
  totalAmount: number | string;
}

interface CancelSaleDialogProps {
  open: boolean;
  sale: CancelableSale | null;
  // Um pagamento chegou a ser aprovado: sem `cashAdjusted` na resposta, o
  // estorno no caixa não pôde ser lançado (caixa já fechado) e precisa de
  // ajuste manual — o aviso de sucesso muda.
  hadApprovedPayment?: boolean;
  onOpenChange: (open: boolean) => void;
  onCancelled: (cancelledSale: any) => void;
}

type Step = 'reason' | 'auth' | 'success';

// Cancelar venda é operação sensível: além do motivo, um SEGUNDO usuário
// (gerência ou superior) confirma com as próprias credenciais — nunca o
// próprio solicitante (sale.service.ts / verifyDualAuthorization). Mesmo
// fluxo do CancelSaleModal do PDV; a mensagem de erro é a do backend.
export function CancelSaleDialog({ open, sale, hadApprovedPayment, onOpenChange, onCancelled }: CancelSaleDialogProps) {
  const [step, setStep] = useState<Step>('reason');
  const [form, setForm] = useState<CancelFormValues>(emptyCancelForm);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<any>(null);

  useEffect(() => {
    if (open) {
      setStep('reason');
      setForm(emptyCancelForm);
      setError(null);
      setResult(null);
    }
  }, [open, sale?.id]);

  if (!sale) return null;

  const set = (patch: Partial<CancelFormValues>) => setForm((current) => ({ ...current, ...patch }));

  const close = () => {
    if (!submitting) onOpenChange(false);
  };

  const goToAuth = (event: React.FormEvent) => {
    event.preventDefault();
    const problem = validateReason(form.reason);
    if (problem) return setError(problem);
    setError(null);
    setStep('auth');
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const problem = validateAuthorizer(form);
    if (problem) return setError(problem);

    setSubmitting(true);
    setError(null);
    try {
      const response = await api.cancelSale(sale.id, buildCancelPayload(form));
      const cancelled = response?.data ?? response;
      setResult(cancelled);
      setStep('success');
      onCancelled(cancelled);
    } catch (err: any) {
      // Mensagem exata do backend (auto-autorização bloqueada, perfil sem
      // permissão, senha/MFA inválidos, venda já cancelada/devolvida...).
      setError(err?.response?.data?.error || 'Não foi possível cancelar a venda.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : close())}>
      <DialogContent
        className="max-w-lg"
        role="dialog"
        aria-modal="true"
        aria-labelledby="cancel-sale-title"
        onClose={step === 'success' ? undefined : close}
      >
        <DialogHeader>
          <DialogTitle id="cancel-sale-title">Cancelar venda #{sale.saleNumber}</DialogTitle>
          <DialogDescription>
            {step === 'reason' && 'A venda continua no histórico com status Cancelada; estoque e caixa são estornados.'}
            {step === 'auth' && 'Um responsável (gerência ou superior) precisa autorizar com as próprias credenciais.'}
            {step === 'success' && 'Cancelamento concluído.'}
          </DialogDescription>
        </DialogHeader>

        {step === 'reason' && (
          <form onSubmit={goToAuth} className="space-y-4 p-6">
            <div className="flex items-center justify-between rounded-lg bg-muted/50 p-3 text-sm">
              <span className="text-muted-foreground">Total da venda</span>
              <span className="font-semibold tabular-nums text-foreground">{formatCurrency(Number(sale.totalAmount))}</span>
            </div>
            <div className="space-y-1">
              <Label htmlFor="cancel-reason">Motivo do cancelamento</Label>
              <Textarea
                id="cancel-reason"
                rows={3}
                autoFocus
                value={form.reason}
                onChange={(e) => set({ reason: e.target.value })}
                placeholder="Ex.: erro na venda, cliente desistiu..."
              />
            </div>
            {error && (
              <Alert variant="destructive" data-testid="cancel-error">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
            <DialogFooter className="p-0">
              <Button type="button" variant="outline" onClick={close}>
                Voltar
              </Button>
              <Button type="submit" data-testid="cancel-continue">
                Continuar
              </Button>
            </DialogFooter>
          </form>
        )}

        {step === 'auth' && (
          <form onSubmit={submit} className="space-y-4 p-6">
            <div className="flex items-center gap-2 text-sm font-medium text-foreground">
              <ShieldCheck className="h-5 w-5" aria-hidden />
              Autorização de um responsável
            </div>
            <div className="space-y-1">
              <Label htmlFor="authorizer-id">ID do autorizador</Label>
              <Input
                id="authorizer-id"
                type="number"
                inputMode="numeric"
                autoFocus
                disabled={submitting}
                value={form.numericId}
                onChange={(e) => set({ numericId: e.target.value })}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="authorizer-password">Senha do autorizador</Label>
              <Input
                id="authorizer-password"
                type="password"
                autoComplete="off"
                disabled={submitting}
                value={form.password}
                onChange={(e) => set({ password: e.target.value })}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="authorizer-mfa">Código MFA (se habilitado)</Label>
              <Input
                id="authorizer-mfa"
                inputMode="numeric"
                autoComplete="off"
                placeholder="000000"
                disabled={submitting}
                value={form.mfaCode}
                onChange={(e) => set({ mfaCode: e.target.value })}
              />
            </div>
            {error && (
              <Alert variant="destructive" data-testid="cancel-error">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
            <DialogFooter className="p-0">
              <Button
                type="button"
                variant="outline"
                disabled={submitting}
                onClick={() => {
                  setError(null);
                  setStep('reason');
                }}
              >
                Voltar
              </Button>
              <Button type="submit" disabled={submitting} data-testid="cancel-confirm">
                {submitting ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />
                    Autorizando...
                  </>
                ) : (
                  'Autorizar cancelamento'
                )}
              </Button>
            </DialogFooter>
          </form>
        )}

        {step === 'success' && result && (
          <div className="space-y-4 p-6" data-testid="cancel-success">
            <div className="flex items-center gap-3">
              <span className="flex h-10 w-10 items-center justify-center rounded-full bg-success-soft text-success">
                <CheckCircle2 className="h-5 w-5" aria-hidden />
              </span>
              <div>
                <p className="font-semibold text-foreground">Venda #{result.saleNumber ?? sale.saleNumber} cancelada</p>
                <p className="text-sm text-muted-foreground">Status: {result.status}</p>
              </div>
            </div>
            <dl className="space-y-2 rounded-lg bg-muted/50 p-4 text-sm">
              <div className="flex justify-between gap-4">
                <dt className="text-muted-foreground">Autorizado por</dt>
                <dd className="font-medium text-foreground">{result.authorizer?.name ?? '—'}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-muted-foreground">Motivo</dt>
                <dd className="text-right font-medium text-foreground">{result.cancelReason ?? form.reason.trim()}</dd>
              </div>
            </dl>
            {result.cashAdjusted ? (
              <Alert variant="success">
                <AlertDescription>O caixa foi ajustado: o valor pago nesta venda foi estornado do saldo esperado.</AlertDescription>
              </Alert>
            ) : hadApprovedPayment ? (
              <Alert variant="warning">
                <AlertDescription>
                  O caixa em que esta venda foi paga já está fechado, então o estorno não pôde ser lançado automaticamente —
                  é necessário um ajuste manual no caixa aberto atual.
                </AlertDescription>
              </Alert>
            ) : null}
            <DialogFooter className="p-0">
              <Button type="button" onClick={() => onOpenChange(false)} autoFocus>
                Fechar
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
