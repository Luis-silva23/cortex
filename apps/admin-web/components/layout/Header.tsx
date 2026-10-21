'use client';

import { useEffect, useState } from 'react';
import { Bell, Menu, Search, User, LogOut, Settings } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { api, getCurrentUserClaims } from '@/lib/api';

const USER_TYPE_LABELS: Record<string, string> = {
  SUPER_ADMIN: 'Super Admin TI',
  COMPANY_ADMIN: 'Administrador',
  MANAGER: 'Gerente',
  OPERATOR: 'Operador',
  MECHANIC: 'Mecânico',
  VIEWER: 'Visualizador',
};

export function Header({ navOpen = false, onMenuClick }: { navOpen?: boolean; onMenuClick?: () => void }) {
  const router = useRouter();
  // ACHADO DE AUDITORIA (Agente 06): "Admin User"/"Administrador" eram
  // texto fixo, mesmo com GET /auth/me já real e funcionando (usado em
  // Configurações > Segurança) — o comentário que dizia "não existe /auth/me"
  // estava desatualizado/errado, não o backend.
  const [name, setName] = useState<string | null>(null);
  const [userType, setUserType] = useState<string | null>(null);

  useEffect(() => {
    setUserType(getCurrentUserClaims()?.userType ?? null);
    api
      .getMe()
      .then((result) => {
        const me = result?.data;
        if (me) {
          setName(me.name);
          setUserType(me.userType);
        }
      })
      .catch(() => {
        // Mantém o que já veio do token (userType) — nome fica em branco
        // em vez de mostrar um placeholder inventado.
      });
  }, []);

  const handleLogout = async () => {
    try {
      await api.logout();
    } finally {
      router.push('/login');
    }
  };

  return (
    <header className="sticky top-0 z-20 h-16 border-b border-border bg-card text-card-foreground flex items-center justify-between gap-4 px-4 sm:px-6">
      <button
        type="button"
        className="-ml-2 rounded-lg p-2 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground lg:hidden"
        aria-label="Abrir menu"
        aria-expanded={navOpen}
        aria-controls="app-sidebar"
        onClick={onMenuClick}
        data-testid="nav-toggle"
      >
        <Menu className="h-5 w-5" aria-hidden />
      </button>

      <div className="hidden min-w-0 max-w-xl flex-1 sm:block">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <input
            type="search"
            placeholder="Buscar produtos, clientes, vendas..."
            className="w-full pl-10 pr-4 h-10 border border-input bg-background rounded-lg text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
          />
        </div>
      </div>

      <div className="flex items-center gap-2 sm:gap-4">
        {/* O tema (claro/escuro/automático) é configurado só em Configurações →
            Aparência — não há controle de tema espalhado pelas telas. */}
        <button className="relative p-2 text-muted-foreground hover:text-foreground hover:bg-accent rounded-lg transition-colors">
          <Bell className="h-5 w-5" />
          <span className="absolute top-1 right-1 h-2 w-2 bg-danger rounded-full"></span>
        </button>

        <div className="hidden sm:block h-8 w-px bg-border"></div>

        <div className="flex items-center gap-3">
          <div className="hidden sm:block text-right">
            <p className="text-sm font-medium text-foreground">{name || ' '}</p>
            <p className="text-xs text-muted-foreground">{userType ? USER_TYPE_LABELS[userType] || userType : ' '}</p>
          </div>
          <div className="h-10 w-10 rounded-full bg-primary text-primary-foreground flex items-center justify-center font-medium">
            {name ? name.charAt(0).toUpperCase() : <User className="h-5 w-5" />}
          </div>
        </div>

        <button className="hidden sm:block p-2 text-muted-foreground hover:text-foreground hover:bg-accent rounded-lg transition-colors">
          <Settings className="h-5 w-5" />
        </button>

        <button
          className="p-2 text-muted-foreground hover:text-danger hover:bg-danger-soft rounded-lg transition-colors"
          onClick={handleLogout}
          title="Sair"
        >
          <LogOut className="h-5 w-5" />
        </button>
      </div>
    </header>
  );
}
