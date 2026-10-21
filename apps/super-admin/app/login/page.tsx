'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import api, { apiErrorMessage } from '@/lib/api';
import { CortexMark } from '@/components/ui/cortex-mark';

// A API devolve 429 com `retryAfter` (segundos)
// e o de código MFA errado como 400 "Invalid code" — aqui viram mensagens claras em português.
function rateLimitMessage(data: any): string {
  const seconds = Number(data?.retryAfter);
  if (Number.isFinite(seconds) && seconds > 0) {
    const wait = seconds >= 90 ? `${Math.ceil(seconds / 60)} minutos` : `${seconds} segundos`;
    return `Muitas tentativas. Aguarde ${wait} e tente novamente.`;
  }
  return 'Muitas tentativas. Aguarde alguns minutos e tente novamente.';
}

function loginErrorMessage(err: any): string {
  if (!err.response) return 'Sem conexão com o servidor. Verifique a rede e tente novamente.';
  if (err.response.status === 429) return rateLimitMessage(err.response.data);
  return apiErrorMessage(err.response.data, 'Erro ao fazer login');
}

function mfaErrorMessage(err: any): string {
  if (!err.response) return 'Sem conexão com o servidor. Verifique a rede e tente novamente.';
  const { status, data } = err.response;
  if (status === 429) return rateLimitMessage(data);
  const text = apiErrorMessage(data, '');
  // Token de verificação vencido (10 min) ou inválido: o jwt.verify da API lança "jwt expired"/"jwt malformed"
  // e a rota devolve isso como 400 (ou 401). Não adianta digitar outro código: é preciso entrar de novo.
  if (status === 401 || /jwt|token|expired|malformed|signature/i.test(text)) {
    return 'A verificação expirou (vale 10 minutos). Volte e entre novamente com e-mail e senha.';
  }
  if (status === 400) {
    return 'Código incorreto. Confira o código de 6 dígitos do app autenticador (ele muda a cada 30 segundos) e tente de novo.';
  }
  return text || 'Erro ao verificar o código';
}

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  // Usuário com MFA ativo: /auth/login devolve `{ mfaRequired: true, mfaToken }` (sem accessToken) e a sessão
  // só é emitida depois de POST /auth/verify-mfa — mesmo fluxo do Admin Web.
  const [mfaToken, setMfaToken] = useState<string | null>(null);
  const [mfaCode, setMfaCode] = useState('');
  // Senha TEMPORÁRIA (redefinida por outro Super Admin): o login devolve 403 + credencial de troca de 10 min (decisão 157).
  const [passwordChangeToken, setPasswordChangeToken] = useState<string | null>(null);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [notice, setNotice] = useState('');

  // 403 PASSWORD_CHANGE_REQUIRED (no login ou depois do código MFA): abre a troca de senha em vez de mostrar erro
  const openPasswordChange = (err: any): boolean => {
    const data = err?.response?.data;
    if (err?.response?.status === 403 && data?.error === 'PASSWORD_CHANGE_REQUIRED' && data?.passwordChangeToken) {
      setPasswordChangeToken(data.passwordChangeToken);
      setMfaToken(null);
      setMfaCode('');
      setPassword('');
      setError('');
      setNotice('');
      setLoading(false);
      return true;
    }
    return false;
  };

  const handlePasswordChange = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!passwordChangeToken || !currentPassword || !newPassword || newPassword !== confirmPassword) return;
    setError('');
    setLoading(true);
    try {
      await api.post('/auth/password-change/complete', { passwordChangeToken, currentPassword, newPassword });
      setPasswordChangeToken(null);
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      setNotice('Senha trocada. Entre com a nova senha.');
    } catch (err: any) {
      setError(loginErrorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  // Mesmo fim para os dois caminhos (com e sem MFA): só Super Admin entra neste painel.
  const finishLogin = (data: { accessToken: string; refreshToken: string; user: any }): boolean => {
    if (data.user?.userType !== 'SUPER_ADMIN') {
      setError('Acesso permitido apenas para Super Administradores');
      return false;
    }
    localStorage.setItem('accessToken', data.accessToken);
    localStorage.setItem('refreshToken', data.refreshToken);
    localStorage.setItem('user', JSON.stringify(data.user));
    router.push('/dashboard');
    return true;
  };

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const response = await api.post('/auth/login', { email, password });

      if (response.data.mfaRequired) {
        setMfaToken(response.data.mfaToken);
        setMfaCode('');
        setLoading(false);
        return;
      }

      if (!finishLogin(response.data)) setLoading(false);
    } catch (err: any) {
      if (openPasswordChange(err)) return;
      setError(loginErrorMessage(err));
      setLoading(false);
    }
  };

  const handleVerifyMfa = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!mfaToken || mfaCode.length !== 6) return;
    setError('');
    setLoading(true);

    try {
      const response = await api.post('/auth/verify-mfa', { mfaToken, code: mfaCode, method: 'totp' });
      if (!finishLogin(response.data)) {
        setMfaToken(null);
        setMfaCode('');
        setLoading(false);
      }
    } catch (err: any) {
      if (openPasswordChange(err)) return;
      setError(mfaErrorMessage(err));
      setMfaCode('');
      setLoading(false);
    }
  };

  if (passwordChangeToken) {
    const mismatch = confirmPassword.length > 0 && newPassword !== confirmPassword;
    return (
      <div className="flex min-h-screen items-center justify-center bg-background p-4">
        <Card className="w-full max-w-md" data-testid="password-change">
          <CardHeader className="space-y-1">
            <CardTitle className="text-2xl font-bold">Defina uma nova senha</CardTitle>
            <CardDescription>Sua senha atual é temporária. Escolha uma senha só sua para continuar.</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handlePasswordChange} className="space-y-4">
              {error && (
                <div role="alert" className="rounded-md border border-danger/30 bg-danger-soft px-4 py-3 text-sm text-danger">
                  {error}
                </div>
              )}
              <div className="space-y-2">
                <label htmlFor="pc-current" className="text-sm font-medium">Senha temporária</label>
                <input id="pc-current" type="password" autoComplete="current-password" value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm" required autoFocus />
              </div>
              <div className="space-y-2">
                <label htmlFor="pc-new" className="text-sm font-medium">Nova senha</label>
                <input id="pc-new" type="password" autoComplete="new-password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm" required />
                <p className="text-xs text-muted-foreground">Pelo menos 12 caracteres, com 3 tipos entre minúscula, maiúscula, número e símbolo. Não use o seu e-mail nem a senha temporária.</p>
              </div>
              <div className="space-y-2">
                <label htmlFor="pc-confirm" className="text-sm font-medium">Repita a nova senha</label>
                <input id="pc-confirm" type="password" autoComplete="new-password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm" required />
                {mismatch && <p className="text-xs text-danger">As senhas não são iguais.</p>}
              </div>
              <Button type="submit" className="w-full" disabled={loading || !currentPassword || !newPassword || newPassword !== confirmPassword}>
                {loading ? 'Salvando...' : 'Trocar senha'}
              </Button>
              <button type="button" className="w-full text-center text-sm text-muted-foreground hover:underline" onClick={() => { setPasswordChangeToken(null); setError(''); }}>
                Voltar ao login
              </button>
            </form>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (mfaToken) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background p-4">
        <Card className="w-full max-w-md">
          <CardHeader className="space-y-1">
            <CardTitle className="text-2xl font-bold">Verificação em duas etapas</CardTitle>
            <CardDescription>Digite o código de 6 dígitos do seu app autenticador</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleVerifyMfa} className="space-y-4">
              <div className="space-y-2">
                <label htmlFor="mfa-code" className="text-sm font-medium">
                  Código
                </label>
                <input
                  id="mfa-code"
                  type="text"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                  value={mfaCode}
                  onChange={(e) => setMfaCode(e.target.value.replace(/\D/g, ''))}
                  className="flex h-12 w-full rounded-md border border-input bg-background px-3 py-2 text-center text-2xl tracking-[0.5em] ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                  placeholder="000000"
                  autoFocus
                />
              </div>
              {error && (
                <p role="alert" className="text-sm text-destructive">
                  {error}
                </p>
              )}
              <Button type="submit" className="w-full" disabled={loading || mfaCode.length !== 6}>
                {loading ? 'Verificando...' : 'Confirmar'}
              </Button>
              <button
                type="button"
                className="w-full text-center text-sm text-muted-foreground hover:underline"
                onClick={() => {
                  setMfaToken(null);
                  setMfaCode('');
                  setError('');
                  setPassword('');
                }}
              >
                Voltar
              </button>
            </form>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <Card className="w-full max-w-md">
        <CardHeader className="space-y-1">
          <div className="flex items-center gap-3">
            <CortexMark className="h-10 w-auto shrink-0" />
            <CardTitle className="text-2xl font-bold tracking-[0.12em]">CÓRTEX</CardTitle>
          </div>
          <CardDescription>Painel Super ADM TI</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleLogin} className="space-y-4">
            {notice && (
              <div role="status" data-testid="login-notice" className="rounded-md border border-success/30 bg-success-soft px-4 py-3 text-sm text-success">
                {notice}
              </div>
            )}
            <div className="space-y-2">
              <label htmlFor="email" className="text-sm font-medium">
                Email
              </label>
              <input
                id="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                placeholder="seu@email.com"
                required
              />
            </div>
            <div className="space-y-2">
              <label htmlFor="password" className="text-sm font-medium">
                Senha
              </label>
              <input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                placeholder="••••••••"
                required
              />
            </div>
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
            <Button type="submit" className="w-full" disabled={loading}>
              {loading ? 'Entrando...' : 'Entrar'}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
