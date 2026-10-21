import { useEffect } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { LogOut, Search, Package, FileText, Wrench } from 'lucide-react';
import clsx from 'clsx';
import { useAuthStore } from '../store/auth.store';
import { logout as apiLogout, listBranches } from '../api/endpoints';
import { needsBranchChoice } from '../lib/permissions';
import { useAsync } from './ui';
import { CortexMark } from './CortexMark';

const NAV = [
  { to: '/', label: 'Atendimento', icon: Search, end: true },
  { to: '/produtos', label: 'Produtos', icon: Package, end: false },
  { to: '/orcamentos', label: 'Orçamentos', icon: FileText, end: false },
  { to: '/os', label: 'Ordens de serviço', icon: Wrench, end: false },
];

export default function Layout() {
  const { user, branchId, setBranch, logout } = useAuthStore();
  const navigate = useNavigate();
  const mustChoose = !!user && needsBranchChoice(user);
  const branches = useAsync(() => (mustChoose ? listBranches() : Promise.resolve([])), [mustChoose]);

  // Empresa toda sem filial escolhida: se só houver uma filial ativa, usa-a (o servidor valida de qualquer forma).
  useEffect(() => {
    const list = (branches.data ?? []).filter((b) => b.isActive !== false);
    if (mustChoose && !branchId && list.length === 1) setBranch(list[0].id);
  }, [mustChoose, branchId, branches.data, setBranch]);

  const leave = async () => {
    await apiLogout();
    logout();
    navigate('/login', { replace: true });
  };

  return (
    <div className="flex min-h-screen flex-col bg-primary-50">
      <header className="bg-primary-600 text-white">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-4 px-4 py-3">
          <span className="flex items-center gap-2 text-lg font-bold tracking-wide">
            <CortexMark tone="onDark" className="h-7 w-auto shrink-0" />
            CÓRTEX · Balcão
          </span>
          <nav className="flex flex-1 flex-wrap gap-1">
            {NAV.map(({ to, label, icon: Icon, end }) => (
              <NavLink
                key={to}
                to={to}
                end={end}
                className={({ isActive }) => clsx('flex items-center gap-1 rounded-lg px-3 py-1.5 text-sm font-medium', isActive ? 'bg-primary-500' : 'hover:bg-primary-700')}
              >
                <Icon className="h-4 w-4" /> {label}
              </NavLink>
            ))}
          </nav>
          {mustChoose && (
            <label className="flex items-center gap-2 text-sm">
              Filial
              <select
                value={branchId ?? ''}
                onChange={(e) => setBranch(e.target.value || null)}
                className="rounded-md border border-primary-300 bg-white px-2 py-1 text-sm text-primary-700"
                aria-label="Filial da operação"
              >
                <option value="">Escolha…</option>
                {(branches.data ?? []).filter((b) => b.isActive !== false).map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <div className="text-right text-xs leading-tight">
            <div className="font-semibold">{user?.name}</div>
            <div className="opacity-80">{user?.branch?.name ?? user?.company?.name ?? ''}</div>
          </div>
          <button onClick={leave} className="flex items-center gap-1 rounded-lg px-3 py-1.5 text-sm hover:bg-primary-700" aria-label="Sair">
            <LogOut className="h-4 w-4" /> Sair
          </button>
        </div>
      </header>
      <main className="mx-auto w-full max-w-6xl flex-1 space-y-4 px-4 py-6">
        <Outlet />
      </main>
    </div>
  );
}
