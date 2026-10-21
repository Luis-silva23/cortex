'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { CortexWordmark } from '@/components/ui/brand';
import { api } from '@/lib/api';
import { MfaEnrollment } from '@/components/auth/MfaEnrollment';
import { PasswordChange } from '@/components/auth/PasswordChange';

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  // ACHADO DE AUDITORIA DE INTEGRAÇÃO: /auth/login devolve `{ mfaRequired:
  // true, mfaToken }` (sem accessToken) para um usuário com MFA ativo — a
  // página só tratava o caso sem MFA, então `localStorage.setItem('token',
  // undefined)` seguido de redirecionar para /dashboard quebrava
  // silenciosamente o login de qualquer usuário que tivesse ativado o MFA
  // pela tela de Configurações (Segurança) construída nesta mesma sessão.
  const [mfaToken, setMfaToken] = useState<string | null>(null);
  const [mfaCode, setMfaCode] = useState('');
  // Código de recuperação (16 caracteres) no lugar do código do aplicativo — para quem perdeu o aparelho.
  const [useBackup, setUseBackup] = useState(false);
  // Perfil com MFA obrigatório e sem MFA ativo: o login devolve 403 + credencial de configuração (decisão 123).
  const [enrollmentToken, setEnrollmentToken] = useState<string | null>(null);
  // Senha TEMPORÁRIA (definida por um administrador): o login devolve 403 + credencial de troca (decisão 157).
  const [passwordChangeToken, setPasswordChangeToken] = useState<string | null>(null);
  const [notice, setNotice] = useState('');

  const persistSession = (data: { accessToken: string; refreshToken: string }) => {
    localStorage.setItem('token', data.accessToken);
    localStorage.setItem('refreshToken', data.refreshToken);
  };

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const data = await api.login(email, password);
      if (data.mfaRequired) {
        setMfaToken(data.mfaToken);
        return;
      }
      persistSession(data);
      router.push('/dashboard');
    } catch (err: any) {
      if (err.response?.status === 403 && err.response?.data?.error === 'PASSWORD_CHANGE_REQUIRED' && err.response?.data?.passwordChangeToken) {
        setPasswordChangeToken(err.response.data.passwordChangeToken);
        setPassword(''); // a senha temporária não fica na memória da tela depois de provada
        setNotice('');
        return;
      }
      if (err.response?.status === 403 && err.response?.data?.error === 'MFA_ENROLLMENT_REQUIRED' && err.response?.data?.enrollmentToken) {
        setEnrollmentToken(err.response.data.enrollmentToken);
        setPassword(''); // a senha não fica na memória da tela depois de provada
        return;
      }
      setError(err.response?.data?.message || 'Erro ao fazer login');
    } finally {
      setLoading(false);
    }
  };

  const mfaCodeValid = useBackup ? mfaCode.length === 16 : mfaCode.length === 6;

  const handleVerifyMfa = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!mfaToken || !mfaCodeValid) return;
    setError('');
    setLoading(true);
    try {
      const data = await api.verifyLoginMfa(mfaToken, mfaCode, useBackup ? 'backup' : 'totp');
      persistSession(data);
      router.push('/dashboard');
    } catch (err: any) {
      // conta com MFA e senha temporária: o código confirmado abre a troca de senha (decisão 157)
      if (err.response?.status === 403 && err.response?.data?.error === 'PASSWORD_CHANGE_REQUIRED' && err.response?.data?.passwordChangeToken) {
        setPasswordChangeToken(err.response.data.passwordChangeToken);
        setMfaToken(null);
        setMfaCode('');
        setNotice('');
        return;
      }
      setError(err.response?.data?.message || 'Código inválido');
    } finally {
      setLoading(false);
    }
  };

  if (passwordChangeToken) {
    return (
      <PasswordChange
        passwordChangeToken={passwordChangeToken}
        onDone={() => {
          setPasswordChangeToken(null);
          setMfaToken(null);
          setMfaCode('');
          setError('');
          setNotice('Senha trocada. Entre com a nova senha.');
        }}
        onCancel={() => {
          setPasswordChangeToken(null);
          setError('');
        }}
      />
    );
  }

  if (enrollmentToken) {
    return (
      <MfaEnrollment
        enrollmentToken={enrollmentToken}
        onDone={(session) => {
          persistSession(session);
          router.push('/dashboard');
        }}
        onCancel={() => {
          setEnrollmentToken(null);
          setError('');
        }}
      />
    );
  }

  if (mfaToken) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background p-4">
        <Card className="w-full max-w-md">
          <CardHeader className="space-y-1 text-center">
            <CardTitle className="text-2xl font-bold">Verificação em duas etapas</CardTitle>
            <CardDescription>Digite o código do seu app autenticador</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleVerifyMfa} className="space-y-4">
              {error && (
                <div className="bg-danger-soft border border-danger/30 text-danger px-4 py-3 rounded-md text-sm">
                  {error}
                </div>
              )}
              <Input
                type="text"
                inputMode={useBackup ? 'text' : 'numeric'}
                aria-label={useBackup ? 'Código de recuperação de 16 caracteres' : 'Código de 6 dígitos do aplicativo autenticador'}
                autoComplete="one-time-code"
                placeholder={useBackup ? '0123456789abcdef' : '000000'}
                maxLength={useBackup ? 16 : 6}
                value={mfaCode}
                onChange={(e) => setMfaCode(useBackup ? e.target.value.toLowerCase().replace(/[^0-9a-f]/g, '') : e.target.value.replace(/\D/g, ''))}
                className={useBackup ? 'text-center text-lg font-mono tracking-widest' : 'text-center text-2xl tracking-[0.5em]'}
                autoFocus
              />
              <Button type="submit" className="w-full" disabled={loading || !mfaCodeValid}>
                {loading ? 'Verificando...' : 'Confirmar'}
              </Button>
              <button
                type="button"
                className="text-sm text-muted-foreground hover:underline w-full text-center"
                onClick={() => {
                  setUseBackup((v) => !v);
                  setMfaCode('');
                  setError('');
                }}
              >
                {useBackup ? 'Usar o código do aplicativo' : 'Perdi o aplicativo: usar um código de recuperação'}
              </button>
              <button
                type="button"
                className="text-sm text-muted-foreground hover:underline w-full text-center"
                onClick={() => {
                  setMfaToken(null);
                  setMfaCode('');
                  setUseBackup(false);
                  setError('');
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
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <Card className="w-full max-w-md">
        <CardHeader className="space-y-1 text-center">
          <div className="flex justify-center mb-6">
            <CortexWordmark size="lg" className="justify-center" />
          </div>
          <CardTitle className="text-2xl font-bold">Bem-vindo de volta</CardTitle>
          <CardDescription>
            Entre com suas credenciais para acessar o sistema
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleLogin} className="space-y-4">
            {notice && (
              <div role="status" data-testid="login-notice" className="bg-success-soft border border-success/30 text-success px-4 py-3 rounded-md text-sm">
                {notice}
              </div>
            )}
            {error && (
              <div className="bg-danger-soft border border-danger/30 text-danger px-4 py-3 rounded-md text-sm">
                {error}
              </div>
            )}

            <div className="space-y-2">
              <label htmlFor="login-email" className="text-sm font-medium">Email</label>
              <Input
                id="login-email"
                type="email"
                autoComplete="username"
                placeholder="seu@email.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
            </div>

            <div className="space-y-2">
              <label htmlFor="login-password" className="text-sm font-medium">Senha</label>
              <Input
                id="login-password"
                type="password"
                autoComplete="current-password"
                placeholder="••••••••"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </div>

            <Button type="submit" className="w-full" disabled={loading}>
              {loading ? 'Entrando...' : 'Entrar'}
            </Button>

            <p className="text-center text-sm text-muted-foreground" data-testid="password-help">
              Esqueceu a senha? Peça ao administrador da sua empresa para redefini-la.
            </p>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
