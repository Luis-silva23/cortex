import { useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { LogIn, ShieldCheck } from 'lucide-react';
import toast from 'react-hot-toast';
import { login, verifyMfa } from '../api/endpoints';
import { toApiError } from '../api/http';
import { useAuthStore } from '../store/auth.store';
import { Button, ErrorBox, inputClass, useSubmitOnce } from '../components/ui';
import { CortexMark } from '../components/CortexMark';

/**
 * Entrada do atendente: mesma autenticação oficial do CÓRTEX (e-mail ou ID numérico + senha; MFA quando o usuário tem). O
 * servidor decide tudo (credencial, bloqueio, empresa desativada, MFA); a tela só mostra a mensagem em português.
 */
export default function LoginPage() {
  const { isAuthenticated, login: store } = useAuthStore();
  const navigate = useNavigate();
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [mfaToken, setMfaToken] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const { run, busy } = useSubmitOnce();

  if (isAuthenticated) return <Navigate to="/" replace />;

  const finish = (r: Awaited<ReturnType<typeof login>>) => {
    if (r.kind === 'ok') {
      store(r.user, r.accessToken, r.refreshToken);
      toast.success(`Bem-vindo, ${r.user.name}!`);
      navigate('/', { replace: true });
    } else {
      setMfaToken(r.mfaToken);
      setPassword(''); // a senha não fica na memória durante o segundo fator
    }
  };

  const submitCredentials = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!identifier.trim() || !password) return setError('Informe o e-mail (ou ID) e a senha.');
    void run(async () => {
      try {
        finish(await login(identifier, password));
      } catch (err) {
        setError(toApiError(err).message);
      }
    });
  };

  const submitMfa = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!mfaToken || code.trim().length < 6) return setError('Informe o código de 6 dígitos do aplicativo autenticador.');
    void run(async () => {
      try {
        finish(await verifyMfa(mfaToken, code.trim(), 'totp'));
      } catch (err) {
        setError(toApiError(err).message);
      }
    });
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-primary-50 p-6">
      <div className="w-full max-w-sm rounded-xl bg-white p-8 shadow">
        <CortexMark className="mx-auto mb-2 h-10 w-auto" />
        <h1 className="text-center text-xl font-bold text-primary-600">CÓRTEX · Balcão</h1>
        <p className="mb-6 mt-1 text-center text-sm text-gray-500">Atendimento ao cliente</p>
        {error && <div className="mb-4"><ErrorBox message={error} /></div>}
        {!mfaToken ? (
          <form onSubmit={submitCredentials} className="space-y-4">
            <label className="block text-sm font-medium">
              E-mail ou ID
              <input className={`${inputClass} mt-1`} value={identifier} onChange={(e) => setIdentifier(e.target.value)} autoFocus autoComplete="username" />
            </label>
            <label className="block text-sm font-medium">
              Senha
              <input className={`${inputClass} mt-1`} type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
            </label>
            <Button type="submit" loading={busy} className="w-full">
              <LogIn className="h-4 w-4" /> Entrar
            </Button>
          </form>
        ) : (
          <form onSubmit={submitMfa} className="space-y-4">
            <p className="flex items-center gap-2 text-sm text-gray-600">
              <ShieldCheck className="h-4 w-4" /> Confirmação em duas etapas
            </p>
            <label className="block text-sm font-medium">
              Código do aplicativo autenticador
              <input className={`${inputClass} mt-1 text-center tracking-widest`} inputMode="numeric" maxLength={8} value={code} onChange={(e) => setCode(e.target.value)} autoFocus autoComplete="one-time-code" />
            </label>
            <Button type="submit" loading={busy} className="w-full">
              Confirmar
            </Button>
            <button type="button" className="w-full text-sm text-primary-500 underline" onClick={() => { setMfaToken(null); setCode(''); setError(null); }}>
              Voltar
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
