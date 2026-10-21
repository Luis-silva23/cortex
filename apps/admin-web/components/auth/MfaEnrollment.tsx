'use client';

import { useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { api } from '@/lib/api';

/**
 * Configuração OBRIGATÓRIA da verificação em duas etapas (decisão 123), no primeiro acesso do administrador da empresa.
 * 1) mostra o QR do aplicativo autenticador (gerado AQUI, no navegador — o segredo nunca vai a serviço externo) e o segredo para
 *    digitação manual; 2) confirma com um código; 3) mostra os códigos de recuperação UMA vez e só segue depois de a pessoa confirmar
 *    que os guardou. Segredo, QR e códigos ficam só em memória desta tela: nada vai para localStorage, URL ou log.
 */
export interface EnrollmentSession {
  accessToken: string;
  refreshToken: string;
}

export function MfaEnrollment({ enrollmentToken, onDone, onCancel }: { enrollmentToken: string; onDone: (session: EnrollmentSession) => void; onCancel: () => void }) {
  const [secret, setSecret] = useState('');
  const [qrDataUrl, setQrDataUrl] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ session: EnrollmentSession; backupCodes: string[] } | null>(null);
  const [saved, setSaved] = useState(false);

  // UMA chamada por carregamento: cada begin gera um segredo NOVO no servidor (descarta o pendente). No modo de desenvolvimento do React o
  // efeito roda duas vezes; sem esta trava as duas chamadas gravariam segredos diferentes e a tela poderia mostrar o que o servidor descartou.
  const started = useRef<string | null>(null);
  useEffect(() => {
    if (started.current === enrollmentToken) return;
    started.current = enrollmentToken;
    (async () => {
      try {
        const begun = await api.beginMfaEnrollment(enrollmentToken);
        setSecret(begun.data.secret);
        setQrDataUrl(await QRCode.toDataURL(begun.data.otpauthUrl, { margin: 1, width: 192 }));
      } catch (err: any) {
        setError(err.response?.data?.message || 'Não foi possível iniciar a configuração. Entre novamente.');
      }
    })();
  }, [enrollmentToken]);

  const confirm = async (e: React.FormEvent) => {
    e.preventDefault();
    if (code.length !== 6) return;
    setError('');
    setBusy(true);
    try {
      const result = await api.confirmMfaEnrollment(enrollmentToken, code);
      setDone({ session: { accessToken: result.accessToken, refreshToken: result.refreshToken }, backupCodes: result.backupCodes });
      setSecret('');
      setQrDataUrl('');
    } catch (err: any) {
      setError(err.response?.data?.message || 'Código inválido');
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background p-4">
        <Card className="w-full max-w-md" data-testid="mfa-backup-codes">
          <CardHeader className="space-y-1 text-center">
            <CardTitle className="text-2xl font-bold">Guarde os códigos de recuperação</CardTitle>
            <CardDescription>
              Cada código vale uma vez e serve se você perder o aplicativo autenticador. Eles não serão mostrados de novo.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <ul className="grid grid-cols-2 gap-2 font-mono text-sm" aria-label="Códigos de recuperação">
              {done.backupCodes.map((c) => (
                <li key={c} className="rounded border border-border bg-muted px-2 py-1 text-center">
                  {c}
                </li>
              ))}
            </ul>
            <div className="flex gap-2">
              <Button type="button" variant="outline" className="flex-1" onClick={() => navigator.clipboard?.writeText(done.backupCodes.join('\n'))}>
                Copiar
              </Button>
            </div>
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} className="mt-1" />
              <span>Guardei os códigos em um lugar seguro.</span>
            </label>
            <Button type="button" className="w-full" disabled={!saved} onClick={() => onDone(done.session)}>
              Continuar
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <Card className="w-full max-w-md" data-testid="mfa-enrollment">
        <CardHeader className="space-y-1 text-center">
          <CardTitle className="text-2xl font-bold">Ative a verificação em duas etapas</CardTitle>
          <CardDescription>Sua conta de administrador exige um aplicativo autenticador (Google Authenticator, Microsoft Authenticator, Authy…).</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={confirm} className="space-y-4">
            {error && (
              <div role="alert" className="bg-danger-soft border border-danger/30 text-danger px-4 py-3 rounded-md text-sm">
                {error}
              </div>
            )}
            <ol className="list-decimal pl-5 text-sm space-y-1 text-muted-foreground">
              <li>Abra o aplicativo e escaneie o QR code (ou digite o segredo).</li>
              <li>Digite o código de 6 dígitos que o aplicativo mostrar.</li>
            </ol>
            {qrDataUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={qrDataUrl} alt="QR code para o aplicativo autenticador" width={192} height={192} className="mx-auto rounded border border-border" />
            ) : (
              !error && <p className="text-center text-sm text-muted-foreground">Gerando o QR code…</p>
            )}
            {secret && (
              <p className="text-center text-xs text-muted-foreground">
                Digitação manual: <span className="font-mono break-all" data-testid="mfa-secret">{secret}</span>
              </p>
            )}
            <Input
              type="text"
              inputMode="numeric"
              aria-label="Código de 6 dígitos do aplicativo autenticador"
              autoComplete="one-time-code"
              placeholder="000000"
              maxLength={6}
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
              className="text-center text-2xl tracking-[0.5em]"
            />
            <Button type="submit" className="w-full" disabled={busy || code.length !== 6 || !secret}>
              {busy ? 'Ativando...' : 'Ativar e entrar'}
            </Button>
            <button type="button" className="text-sm text-muted-foreground hover:underline w-full text-center" onClick={onCancel}>
              Voltar
            </button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
