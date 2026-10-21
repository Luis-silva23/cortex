import { useState } from 'react';
import { Lock, LogOut } from 'lucide-react';
import { useAuthStore } from '../store/auth.store';
import { signOut, verifyOwnPassword } from '../services/session';

/**
 * TELA BLOQUEADA. Substitui TODO o conteúdo do PDV (o Layout não renderiza as páginas enquanto `locked`): atalhos de teclado,
 * leitor de código de barras e botões não chegam a nada. A venda em andamento (carrinho/pagamento) continua guardada; quem
 * desbloqueia é o MESMO operador, confirmando a própria senha no servidor. Outra pessoa entra por "Sair da conta" + login.
 */
export default function LockScreen({ onLoggedOut }: { onLoggedOut: () => void }) {
  const user = useAuthStore((s) => s.user);
  const unlock = useAuthStore((s) => s.unlock);
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy || !password) return;
    setBusy(true);
    setError(null);
    const result = await verifyOwnPassword(password);
    setBusy(false);
    setPassword('');
    if (result.ok) unlock();
    else setError(result.message);
  };

  const leave = async () => {
    await signOut();
    onLoggedOut();
  };

  return (
    <div className="flex min-h-screen w-full items-center justify-center bg-gray-900/95 p-6" role="dialog" aria-modal="true" aria-label="Tela bloqueada">
      <form onSubmit={submit} className="w-full max-w-sm rounded-2xl bg-white p-8 shadow-lg">
        <div className="mb-6 text-center">
          <Lock className="mx-auto mb-3 text-primary-600" size={36} />
          <h1 className="text-xl font-bold text-gray-900">Tela bloqueada</h1>
          <p className="mt-1 text-sm text-gray-600">
            {user?.name ?? 'Operador'} (ID {user?.numericId}) — digite a sua senha para continuar.
          </p>
        </div>
        {error && (
          <p role="alert" className="mb-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
            {error}
          </p>
        )}
        <label htmlFor="unlock-password" className="mb-2 block text-sm font-medium text-gray-700">
          Senha
        </label>
        <input
          id="unlock-password"
          type="password"
          autoFocus
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="mb-4 w-full rounded-lg border border-gray-300 px-4 py-3 text-lg outline-none focus:border-transparent focus:ring-2 focus:ring-primary-500"
        />
        <button
          type="submit"
          disabled={busy || !password}
          className="mb-3 w-full rounded-lg bg-primary-600 px-6 py-3 font-semibold text-white transition-colors hover:bg-primary-700 disabled:opacity-50"
        >
          {busy ? 'Conferindo…' : 'Desbloquear'}
        </button>
        <button type="button" onClick={leave} className="flex w-full items-center justify-center gap-2 rounded-lg px-6 py-3 text-sm font-semibold text-gray-700 hover:bg-gray-100">
          <LogOut size={16} /> Sair da conta (outro operador)
        </button>
      </form>
    </div>
  );
}
