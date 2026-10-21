import { Navigate, Route, Routes } from 'react-router-dom';
import { SERVER_URL_PROBLEM } from './config';
import { useAuthStore } from './store/auth.store';
import Layout from './components/Layout';
import LoginPage from './pages/LoginPage';
import AtendimentoPage from './pages/AtendimentoPage';
import CustomerPage from './pages/CustomerPage';
import VehiclePage from './pages/VehiclePage';
import ProductsPage from './pages/ProductsPage';
import QuoteNewPage from './pages/QuoteNewPage';
import QuotesPage from './pages/QuotesPage';
import QuotePage from './pages/QuotePage';
import OrdersPage from './pages/OrdersPage';
import OrderPage from './pages/OrderPage';

function Private({ children }: { children: React.ReactNode }) {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  return isAuthenticated ? <>{children}</> : <Navigate to="/login" replace />;
}

export default function App() {
  // Falha fechada: endereço do servidor ausente/inválido/sem HTTPS em produção → o aplicativo não abre o login.
  if (SERVER_URL_PROBLEM) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-primary-50 p-6">
        <div role="alert" className="max-w-md rounded-xl bg-white p-8 text-center shadow">
          <h1 className="text-xl font-bold text-primary-600">Instalação inválida</h1>
          <p className="mt-2 text-sm text-gray-600">{SERVER_URL_PROBLEM}</p>
        </div>
      </div>
    );
  }
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route
        element={
          <Private>
            <Layout />
          </Private>
        }
      >
        <Route index element={<AtendimentoPage />} />
        <Route path="clientes/:id" element={<CustomerPage />} />
        <Route path="veiculos/:id" element={<VehiclePage />} />
        <Route path="produtos" element={<ProductsPage />} />
        <Route path="orcamentos" element={<QuotesPage />} />
        <Route path="orcamentos/novo" element={<QuoteNewPage />} />
        <Route path="orcamentos/:id" element={<QuotePage />} />
        <Route path="os" element={<OrdersPage />} />
        <Route path="os/:id" element={<OrderPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
