import { useEffect, useState } from 'react';
import { Outlet, NavLink, useLocation, useNavigate } from 'react-router-dom';
import { ShoppingCart, DollarSign, FileText, Settings, LogOut, User, LifeBuoy, Lock } from 'lucide-react';
import ReportProblemModal from './ReportProblemModal';
import LockScreen from './LockScreen';
import { useAuthStore } from '../store/auth.store';
import { signOut } from '../services/session';
import toast from 'react-hot-toast';
import { startTelemetry } from '../services/telemetry';
import { CortexMark } from './CortexMark';

function Layout() {
  const { user, locked, lock } = useAuthStore();
  const navigate = useNavigate();
  const location = useLocation();
  const [reportOpen, setReportOpen] = useState(false);

  // Telemetria do equipamento enquanto há operador autenticado (só no PDV desktop com equipamento ativo).
  useEffect(() => startTelemetry(), [user?.id]);

  // SAIR DA CONTA: a sessão local cai na hora (signOut zera o store antes de qualquer espera) e o servidor é avisado para
  // revogar o refresh token; sem rede, a revogação fica pendente (services/session.ts). `replace`: o "voltar" não reabre telas.
  // Não fecha o caixa — isso é a tela Caixa, uma operação financeira à parte.
  const handleLogout = () => {
    void signOut();
    navigate('/login', { replace: true });
    toast.success('Você saiu da conta');
  };

  // Tela bloqueada: nada do PDV é renderizado (nem atalhos nem leitor chegam às páginas) até a senha ser conferida.
  if (locked) {
    return <LockScreen onLoggedOut={() => navigate('/login', { replace: true })} />;
  }

  const navItems = [
    { to: '/pos', icon: ShoppingCart, label: 'Vendas' },
    { to: '/cash-register', icon: DollarSign, label: 'Caixa' },
    { to: '/sales', icon: FileText, label: 'Histórico' },
    { to: '/settings', icon: Settings, label: 'Configurações' },
  ];

  return (
    <div className="flex h-screen bg-gray-50">
      {/* Sidebar — superfície clara + navy só no item ativo/avatar (mesma convenção do Admin Web CÓRTEX) */}
      <aside className="w-64 bg-white border-r border-gray-200 text-gray-900 flex flex-col">
        {/* Logo */}
        <div className="p-4 border-b border-gray-200 flex items-center gap-3">
          <CortexMark className="h-9 w-auto shrink-0" />
          <div>
            <h1 className="text-2xl font-bold tracking-[0.12em]">CÓRTEX</h1>
            <p className="text-sm text-gray-500">PDV Desktop</p>
          </div>
        </div>

        {/* User Info */}
        <div className="p-4 border-b border-gray-200">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-primary-600 text-white rounded-full flex items-center justify-center">
              <User size={20} />
            </div>
            <div className="flex-1 min-w-0">
              <p className="font-medium truncate">{user?.name}</p>
              <p className="text-sm text-gray-500 truncate">ID: {user?.numericId}</p>
            </div>
          </div>
        </div>

        {/* Navigation */}
        <nav className="flex-1 p-4 space-y-2">
          {navItems.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) =>
                `flex items-center gap-3 px-4 py-3 rounded-lg transition-colors ${
                  isActive
                    ? 'bg-primary-600 text-white'
                    : 'text-gray-700 hover:bg-gray-100'
                }`
              }
            >
              <item.icon size={20} />
              <span className="font-medium">{item.label}</span>
            </NavLink>
          ))}
        </nav>

        {/* Logout */}
        <div className="p-4 border-t border-gray-200 space-y-1">
          <button
            onClick={() => setReportOpen(true)}
            className="flex items-center gap-3 px-4 py-3 w-full rounded-lg text-gray-700 hover:bg-gray-100 transition-colors"
          >
            <LifeBuoy size={20} />
            <span className="font-medium">Relatar problema</span>
          </button>
          <button
            onClick={lock}
            className="flex items-center gap-3 px-4 py-3 w-full rounded-lg text-gray-700 hover:bg-gray-100 transition-colors"
          >
            <Lock size={20} />
            <span className="font-medium">Bloquear tela</span>
          </button>
          <button
            onClick={handleLogout}
            className="flex items-center gap-3 px-4 py-3 w-full rounded-lg text-gray-700 hover:bg-gray-100 transition-colors"
          >
            <LogOut size={20} />
            <span className="font-medium">Sair</span>
          </button>
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 overflow-auto">
        <Outlet />
      </main>
      <ReportProblemModal
        isOpen={reportOpen}
        onClose={() => setReportOpen(false)}
        screen={navItems.find((n) => location.pathname.startsWith(n.to))?.label ?? 'PDV'}
      />
    </div>
  );
}

export default Layout;
