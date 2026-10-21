import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { LogIn, Loader2, ShieldCheck, ArrowLeft } from 'lucide-react';
import { useAuthStore } from '../store/auth.store';
import { api, apiErrorMessage } from '../services/api';
import { MfaMethod, isMfaCodeComplete, mfaErrorMessage, normalizeMfaCode } from '../services/mfa-login';
import toast from 'react-hot-toast';
import { CortexMark } from '../components/CortexMark';

// Desafio MFA pendente: o /auth/login confirmou ID e senha e devolveu um token de verificação de curta duração.
interface MfaChallenge {
  mfaToken: string;
  numericId: string;
}

function LoginPage() {
  const [numericId, setNumericId] = useState('');
  const [password, setPassword] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [challenge, setChallenge] = useState<MfaChallenge | null>(null);
  const [mfaMethod, setMfaMethod] = useState<MfaMethod>('totp');
  const [mfaCode, setMfaCode] = useState('');
  const [mfaError, setMfaError] = useState('');
  const codeInputRef = useRef<HTMLInputElement>(null);
  // Enter repetido / duplo clique não disparam duas verificações (cada código errado conta no limite de tentativas).
  const inFlight = useRef(false);
  const { login, isAuthenticated } = useAuthStore();
  const navigate = useNavigate();

  useEffect(() => {
    if (isAuthenticated) {
      navigate('/pos');
    }
  }, [isAuthenticated, navigate]);

  useEffect(() => {
    if (challenge) codeInputRef.current?.focus();
  }, [challenge, mfaMethod]);

  const finishLogin = (response: any) => {
    login(response.user, response.accessToken, response.refreshToken);
    toast.success(`Bem-vindo, ${response.user.name}!`);
    navigate('/pos');
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (inFlight.current) return;

    if (!numericId || !password) {
      toast.error('Preencha o ID e a senha');
      return;
    }

    inFlight.current = true;
    setIsLoading(true);

    try {
      const response = await api.login(numericId, password);

      if (response.mfaRequired) {
        // A senha não fica guardada: a segunda etapa usa só o token de verificação.
        setPassword('');
        setMfaCode('');
        setMfaError('');
        setMfaMethod('totp');
        setChallenge({ mfaToken: response.mfaToken, numericId });
        return;
      }

      finishLogin(response);
    } catch (error: any) {
      console.error('Login error:', error);
      // O interceptor de api.ts já mostra o toast de todo erro que NÃO é 401 (rede, 429, 5xx...);
      // o 401 (senha errada) ele suprime, então só ele é mostrado aqui — sem toast duplicado.
      if (error.response?.status === 401) {
        toast.error(apiErrorMessage(error.response?.data, 'ID ou senha incorretos'));
      }
    } finally {
      inFlight.current = false;
      setIsLoading(false);
    }
  };

  const handleVerifyMfa = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!challenge || inFlight.current) return;
    if (!isMfaCodeComplete(mfaMethod, mfaCode)) {
      setMfaError(
        mfaMethod === 'totp'
          ? 'Digite os 6 números do aplicativo autenticador.'
          : 'O código de recuperação tem 16 caracteres (números e letras de a até f).'
      );
      return;
    }

    inFlight.current = true;
    setIsLoading(true);
    setMfaError('');
    try {
      const response = await api.verifyMfa(challenge.mfaToken, mfaCode, mfaMethod);
      finishLogin(response);
    } catch (error: any) {
      const { message, restart } = mfaErrorMessage(error, mfaMethod);
      setMfaCode('');
      if (restart) {
        setChallenge(null);
        toast.error(message);
      } else {
        setMfaError(message);
        codeInputRef.current?.focus();
      }
    } finally {
      inFlight.current = false;
      setIsLoading(false);
    }
  };

  const backToPassword = () => {
    setChallenge(null);
    setMfaCode('');
    setMfaError('');
  };

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        <div className="bg-white rounded-2xl shadow-lg border border-gray-200 p-8">
          {/* Logo */}
          <div className="text-center mb-8">
            <div className="inline-flex items-center justify-center w-16 h-16 bg-primary-100 rounded-full mb-4">
              {challenge ? <ShieldCheck size={32} className="text-primary-600" /> : <CortexMark className="h-9 w-auto" />}
            </div>
            <h1 className="text-3xl font-bold tracking-[0.08em] text-gray-900">CÓRTEX PDV</h1>
            <p className="text-gray-600 mt-2">
              {challenge ? 'Verificação em duas etapas' : 'Faça login para continuar'}
            </p>
          </div>

          {!challenge ? (
            <form onSubmit={handleSubmit} className="space-y-6">
              <div>
                <label htmlFor="numericId" className="block text-sm font-medium text-gray-700 mb-2">
                  ID do Usuário
                </label>
                <input
                  id="numericId"
                  type="text"
                  inputMode="numeric"
                  value={numericId}
                  onChange={(e) => setNumericId(e.target.value.replace(/\D/g, ''))}
                  placeholder="Digite seu ID (6 dígitos)"
                  maxLength={6}
                  className="w-full px-4 py-3 rounded-lg border border-gray-300 focus:ring-2 focus:ring-primary-500 focus:border-transparent outline-none transition-all"
                  disabled={isLoading}
                  autoFocus
                />
              </div>

              <div>
                <label htmlFor="password" className="block text-sm font-medium text-gray-700 mb-2">
                  Senha
                </label>
                <input
                  id="password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Digite sua senha"
                  className="w-full px-4 py-3 rounded-lg border border-gray-300 focus:ring-2 focus:ring-primary-500 focus:border-transparent outline-none transition-all"
                  disabled={isLoading}
                />
              </div>

              <button
                type="submit"
                disabled={isLoading}
                className="w-full bg-primary-600 hover:bg-primary-700 text-white font-semibold py-3 px-4 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
              >
                {isLoading ? (
                  <>
                    <Loader2 size={20} className="animate-spin" />
                    Entrando...
                  </>
                ) : (
                  <>
                    <LogIn size={20} />
                    Entrar
                  </>
                )}
              </button>
            </form>
          ) : (
            <form onSubmit={handleVerifyMfa} className="space-y-5" aria-label="Verificação em duas etapas">
              <p className="text-sm text-gray-700">
                ID <strong>{challenge.numericId}</strong>: senha conferida.{' '}
                {mfaMethod === 'totp'
                  ? 'Digite o código de 6 números que aparece agora no seu aplicativo autenticador.'
                  : 'Digite um dos códigos de recuperação que você guardou ao ativar a verificação (cada um vale uma vez).'}
              </p>

              <div>
                <label htmlFor="mfaCode" className="block text-sm font-medium text-gray-700 mb-2">
                  {mfaMethod === 'totp' ? 'Código do autenticador' : 'Código de recuperação'}
                </label>
                <input
                  id="mfaCode"
                  ref={codeInputRef}
                  type="text"
                  inputMode={mfaMethod === 'totp' ? 'numeric' : 'text'}
                  autoComplete="one-time-code"
                  value={mfaCode}
                  onChange={(e) => {
                    setMfaCode(normalizeMfaCode(mfaMethod, e.target.value));
                    if (mfaError) setMfaError('');
                  }}
                  placeholder={mfaMethod === 'totp' ? '000000' : '16 caracteres'}
                  maxLength={mfaMethod === 'totp' ? 6 : 16}
                  className="w-full px-4 py-3 rounded-lg border border-gray-300 focus:ring-2 focus:ring-primary-500 focus:border-transparent outline-none text-center text-2xl tracking-[0.3em] font-mono"
                  disabled={isLoading}
                  aria-invalid={!!mfaError}
                  aria-describedby={mfaError ? 'mfa-error' : undefined}
                />
                {mfaError && (
                  <p id="mfa-error" role="alert" className="mt-2 text-sm text-red-700">
                    {mfaError}
                  </p>
                )}
              </div>

              <button
                type="submit"
                disabled={isLoading || !isMfaCodeComplete(mfaMethod, mfaCode)}
                className="w-full bg-primary-600 hover:bg-primary-700 text-white font-semibold py-3 px-4 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
              >
                {isLoading ? (
                  <>
                    <Loader2 size={20} className="animate-spin" />
                    Verificando...
                  </>
                ) : (
                  <>
                    <ShieldCheck size={20} />
                    Verificar e entrar
                  </>
                )}
              </button>

              <div className="flex items-center justify-between text-sm">
                <button type="button" onClick={backToPassword} disabled={isLoading} className="flex items-center gap-1 text-gray-600 hover:text-gray-900 disabled:opacity-50">
                  <ArrowLeft size={16} /> Voltar
                </button>
                <button
                  type="button"
                  disabled={isLoading}
                  onClick={() => {
                    setMfaMethod((m) => (m === 'totp' ? 'backup' : 'totp'));
                    setMfaCode('');
                    setMfaError('');
                  }}
                  className="text-primary-700 hover:underline disabled:opacity-50"
                >
                  {mfaMethod === 'totp' ? 'Usar código de recuperação' : 'Usar o aplicativo autenticador'}
                </button>
              </div>
            </form>
          )}

          {/* Device Info */}
          <div className="mt-6 pt-6 border-t border-gray-200">
            <p className="text-xs text-gray-500 text-center">
              Dispositivo não ativado? Entre em contato com o administrador.
            </p>
          </div>
        </div>

        {/* Footer */}
        <p className="text-center text-gray-500 text-sm mt-6">
          CÓRTEX · Lógica de Negócios © {new Date().getFullYear()}
        </p>
      </div>
    </div>
  );
}

export default LoginPage;
