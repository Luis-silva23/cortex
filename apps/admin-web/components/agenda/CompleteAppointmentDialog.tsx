'use client';

import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { agendaApi, COMPLETION_REASON_MIN, validateCompletionAuthorization } from '@/lib/api/agenda';
import { getApiErrorMessage } from '@/lib/errors';

/**
 * Pedido de autorização para concluir agendamento SEM a confirmação do cliente. A confirmação definitiva é do cliente;
 * o funcionário não conclui sozinho: um responsável habilitado (política agenda.completionAuthorizerRoles, nunca quem
 * solicita) informa o próprio código e senha (e o código MFA, se tiver) e o motivo fica registrado. A API revalida tudo.
 */
export function CompleteAppointmentDialog({
  appointment,
  onClose,
  onCompleted,
}: {
  appointment: { id: string; customerName?: string; scheduledAt?: string } | null;
  onClose: () => void;
  onCompleted: () => void;
}) {
  const [numericId, setNumericId] = useState('');
  const [password, setPassword] = useState('');
  const [mfaCode, setMfaCode] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setNumericId('');
    setPassword('');
    setMfaCode('');
    setReason('');
    setError(null);
  }, [appointment?.id]);

  async function submit() {
    if (!appointment) return;
    const invalid = validateCompletionAuthorization({ numericId, password, reason });
    if (invalid) {
      setError(invalid);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await agendaApi.complete(appointment.id, {
        authorization: {
          authorizerNumericId: parseInt(numericId.trim(), 10),
          authorizerPassword: password,
          ...(mfaCode.trim() ? { authorizerMfaCode: mfaCode.trim() } : {}),
          reason: reason.trim(),
        },
      });
      onCompleted();
    } catch (err) {
      setPassword('');
      setError(getApiErrorMessage(err, 'Não foi possível concluir o agendamento.'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={!!appointment} onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Concluir sem confirmação do cliente</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 p-6" data-testid="complete-authorization">
          <p className="text-sm text-gray-500">
            {appointment?.customerName ? `${appointment.customerName} ` : 'O cliente '}ainda não confirmou este horário. Para concluir
            mesmo assim, um responsável precisa autorizar com as próprias credenciais — quem pede não pode autorizar.
          </p>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label htmlFor="authorizer-id">Código do responsável</Label>
              <Input id="authorizer-id" inputMode="numeric" value={numericId} onChange={(e) => setNumericId(e.target.value)} autoComplete="off" />
            </div>
            <div className="space-y-1">
              <Label htmlFor="authorizer-password">Senha do responsável</Label>
              <Input id="authorizer-password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
            </div>
          </div>
          <div className="space-y-1">
            <Label htmlFor="authorizer-mfa">Código MFA (se o responsável tiver)</Label>
            <Input id="authorizer-mfa" inputMode="numeric" value={mfaCode} onChange={(e) => setMfaCode(e.target.value)} autoComplete="one-time-code" />
          </div>
          <div className="space-y-1">
            <Label htmlFor="completion-reason">Motivo (mínimo {COMPLETION_REASON_MIN} caracteres)</Label>
            <Input
              id="completion-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Ex.: cliente trouxe a moto sem confirmar pelo WhatsApp"
            />
          </div>
          {error && (
            <p role="alert" className="text-sm text-red-600" data-testid="complete-error">
              {error}
            </p>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Voltar
          </Button>
          <Button onClick={submit} disabled={busy} data-testid="complete-authorize">
            {busy ? 'Autorizando...' : 'Autorizar e concluir'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
