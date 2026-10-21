'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { api } from '@/lib/api';

/**
 * Troca da SENHA TEMPORÁRIA no primeiro acesso (decisão 157). O login devolveu 403 PASSWORD_CHANGE_REQUIRED com uma credencial de 10 minutos; aqui a pessoa informa a senha
 * temporária que recebeu e escolhe a nova. Não há sessão neste ponto: depois de trocar ela entra de novo com a senha nova (e o código do aplicativo, se tiver MFA).
 * As senhas ficam só em memória desta tela: nada vai para localStorage, URL ou log.
 */
export const PASSWORD_RULES = 'Pelo menos 10 caracteres, com letras e números (administradores: 12 caracteres e 3 tipos entre minúscula, maiúscula, número e símbolo). Não use o seu e-mail nem a senha temporária.';

export function PasswordChange({ passwordChangeToken, onDone, onCancel }: { passwordChangeToken: string; onDone: () => void; onCancel: () => void }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const mismatch = confirm.length > 0 && next !== confirm;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!current || !next || next !== confirm) return;
    setError('');
    setBusy(true);
    try {
      await api.completePasswordChange(passwordChangeToken, current, next);
      setCurrent('');
      setNext('');
      setConfirm('');
      onDone();
    } catch (err: any) {
      setError(err.response?.data?.message || 'Não foi possível trocar a senha. Entre novamente.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <Card className="w-full max-w-md" data-testid="password-change">
        <CardHeader className="space-y-1 text-center">
          <CardTitle className="text-2xl font-bold">Defina uma nova senha</CardTitle>
          <CardDescription>Sua senha atual é temporária. Escolha uma senha só sua para continuar.</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={submit} className="space-y-4">
            {error && (
              <div role="alert" className="bg-danger-soft border border-danger/30 text-danger px-4 py-3 rounded-md text-sm">
                {error}
              </div>
            )}
            <div className="space-y-1">
              <Label htmlFor="pc-current">Senha temporária</Label>
              <Input id="pc-current" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} autoFocus required />
            </div>
            <div className="space-y-1">
              <Label htmlFor="pc-new">Nova senha</Label>
              <Input id="pc-new" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} required />
              <p className="text-xs text-muted-foreground">{PASSWORD_RULES}</p>
            </div>
            <div className="space-y-1">
              <Label htmlFor="pc-confirm">Repita a nova senha</Label>
              <Input id="pc-confirm" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
              {mismatch && <p className="text-xs text-danger">As senhas não são iguais.</p>}
            </div>
            <Button type="submit" className="w-full" disabled={busy || !current || !next || next !== confirm}>
              {busy ? 'Salvando...' : 'Trocar senha'}
            </Button>
            <button type="button" className="w-full text-center text-sm text-muted-foreground hover:underline" onClick={onCancel}>
              Voltar ao login
            </button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
