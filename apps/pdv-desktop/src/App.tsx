// O roteador depende do protocolo em que o renderer foi carregado:
//  - `file:` (Electron empacotado, `loadFile('dist/index.html')`): HashRouter. Com BrowserRouter o path
//    vira `/C:/…/index.html`, nenhuma rota casa e a janela abre EM BRANCO (só o Toaster renderiza) —
//    reproduzido rodando o Electron real sobre o dist.
//  - `http(s):` (dev no navegador / Electron dev em http://localhost:5173): BrowserRouter, para que a
//    URL direta `http://localhost:5173/pos` e o F5 funcionem (o Vite devolve o index.html em qualquer path).
import { useEffect } from 'react';
import { BrowserRouter, HashRouter, Routes, Route, Navigate } from 'react-router-dom';
import { Toaster } from 'react-hot-toast';
import { useAuthStore } from './store/auth.store';
import { startSessionHousekeeping } from './services/session';

// Pages
import LoginPage from './pages/LoginPage';
import POSPage from './pages/POSPage';
import CashRegisterPage from './pages/CashRegisterPage';
import SalesPage from './pages/SalesPage';
import SettingsPage from './pages/SettingsPage';

// Layout
import Layout from './components/Layout';
import ErrorBoundary from './components/ErrorBoundary';
import DeviceGate from './components/DeviceGate';
import DiscountAuthorizationDialog from './components/DiscountAuthorizationDialog';

function PrivateRoute({ children }: { children: React.ReactNode }) {
  const { isAuthenticated, hasHydrated } = useAuthStore();
  // A sessão salva agora é lida de forma assíncrona (secure storage via
  // Electron, ver auth.store.ts) — decidir a rota antes da reidratação
  // terminar mandaria até quem já está logado para /login por um instante.
  if (!hasHydrated) {
    return null;
  }
  return isAuthenticated ? <>{children}</> : <Navigate to="/login" replace />;
}

const Router = window.location.protocol === 'file:' ? HashRouter : BrowserRouter;

function App() {
  // Revogações de sessão que ficaram pendentes (sem rede) são reenviadas agora e quando a rede volta; ao FECHAR a janela o
  // processo principal pede aqui o encerramento da sessão antes de fechar (services/session.ts).
  useEffect(() => startSessionHousekeeping(), []);

  return (
    <>
      <ErrorBoundary>
      {/* Nada do CÓRTEX (nem o login) aparece antes de o servidor autorizar ESTE equipamento — ver DeviceGate */}
      <DeviceGate>
      <Router>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route
            path="/"
            element={
              <PrivateRoute>
                <Layout />
              </PrivateRoute>
            }
          >
            <Route index element={<Navigate to="/pos" replace />} />
            <Route path="pos" element={<POSPage />} />
            <Route path="cash-register" element={<CashRegisterPage />} />
            <Route path="sales" element={<SalesPage />} />
            <Route path="settings" element={<SettingsPage />} />
          </Route>
          {/* rota desconhecida (URL digitada errada, link antigo): volta ao início em vez de tela em branco */}
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Router>
      </DeviceGate>
      </ErrorBoundary>
      {/* Pedido de autorização de desconto acima do limite livre (aberto por api.createSale) */}
      <DiscountAuthorizationDialog />
      <Toaster
        position="top-right"
        toastOptions={{
          duration: 3000,
          style: {
            background: '#363636',
            color: '#fff',
          },
          success: {
            duration: 2000,
            iconTheme: {
              primary: '#4ade80',
              secondary: '#fff',
            },
          },
          error: {
            duration: 4000,
            iconTheme: {
              primary: '#ef4444',
              secondary: '#fff',
            },
          },
        }}
      />
    </>
  );
}

export default App;
