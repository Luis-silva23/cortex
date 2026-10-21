'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  LayoutDashboard,
  Package,
  Users,
  ShoppingCart,
  BarChart3,
  Settings,
  Bike,
  Building2,
  Truck,
  ClipboardList,
  Percent,
  Bell,
  Wrench,
  ShieldCheck,
  Boxes,
  Wallet,
  UserCog,
  AlertTriangle,
  FileStack,
  FileText,
  Scale,
  Briefcase,
  PackageX,
  LifeBuoy,
  Globe,
} from 'lucide-react';
import { cn } from '@/lib/cn';
import { canAccessPath, getActiveHref, moduleForPath } from '@/lib/navigation';
import { useModuleSettings } from '@/components/providers/ModuleSettingsProvider';
import { getCurrentUserClaims } from '@/lib/api';
import { CortexWordmark } from '@/components/ui/brand';
import { supportApi } from '@/lib/api/support';

// Itens sem page.tsx (Caixa, Notas Fiscais) ficam fora até a tela existir. Papel por tela: ROLE_ROUTES
// (lib/navigation.ts), a mesma fonte da moldura para URL digitada; módulo por tela: MODULE_ROUTES. Só UX — cada rota
// da API continua com requireModuleEnabled/requireUserType/requirePermission.
const navigation: Array<{ name: string; href: string; icon: any }> = [
  { name: 'Dashboard', href: '/dashboard', icon: LayoutDashboard },
  { name: 'Produtos', href: '/dashboard/products', icon: Package },
  { name: 'Clientes', href: '/dashboard/customers', icon: Users },
  { name: 'Motos', href: '/dashboard/motorcycles', icon: Bike },
  { name: 'Vendas', href: '/dashboard/sales', icon: ShoppingCart },
  { name: 'Compras', href: '/dashboard/purchases', icon: ClipboardList },
  { name: 'Devolução ao fornecedor', href: '/dashboard/purchases/returns', icon: PackageX },
  { name: 'Fornecedores', href: '/dashboard/suppliers', icon: Truck },
  { name: 'Estoque e Transferências', href: '/dashboard/inventory', icon: Boxes },
  { name: 'Avarias', href: '/dashboard/damage', icon: AlertTriangle },
  { name: 'Fiscal', href: '/dashboard/fiscal', icon: FileStack },
  { name: 'Financeiro', href: '/dashboard/financial', icon: Wallet },
  { name: 'Conciliação', href: '/dashboard/financial/reconciliation', icon: Scale },
  { name: 'Convênios', href: '/dashboard/agreements', icon: Briefcase },
  { name: 'Oficina', href: '/dashboard/service-orders', icon: Wrench },
  { name: 'Orçamentos', href: '/dashboard/quotes', icon: FileText },
  { name: 'Mecânicos e Comissões', href: '/dashboard/mechanics', icon: UserCog },
  { name: 'Pós-venda / Agenda', href: '/dashboard/post-sale', icon: Bell },
  { name: 'Descontos', href: '/dashboard/discounts', icon: Percent },
  { name: 'Filiais', href: '/dashboard/branches', icon: Building2 },
  { name: 'Canais de venda', href: '/dashboard/channels', icon: Globe },
  { name: 'Usuários e Perfis', href: '/dashboard/users', icon: ShieldCheck },
  { name: 'Privacidade (LGPD)', href: '/dashboard/privacy', icon: ShieldCheck },
  { name: 'Relatórios', href: '/dashboard/reports', icon: BarChart3 },
  { name: 'Ajuda e Suporte', href: '/dashboard/help', icon: LifeBuoy },
  { name: 'Configurações', href: '/dashboard/settings', icon: Settings },
];

export function Sidebar({ open = false, onNavigate }: { open?: boolean; onNavigate?: () => void }) {
  const pathname = usePathname();
  const [userType, setUserType] = useState<string | null>(null);
  // Até a primeira leitura tudo aparece (mesmo default "opt-out" do backend); a API é quem barra.
  const { disabled: disabledModules } = useModuleSettings();

  const [unreadTickets, setUnreadTickets] = useState(0);

  useEffect(() => {
    setUserType(getCurrentUserClaims()?.userType ?? null);
  }, []);

  // Contador de respostas novas dos chamados. Atualiza ao trocar de tela e a cada minuto; falha silenciosa — o menu nunca
  // depende do suporte para funcionar.
  useEffect(() => {
    if (!userType || userType === 'SUPER_ADMIN') return;
    let alive = true;
    const refresh = () =>
      supportApi
        .unreadCount()
        .then((n) => alive && setUnreadTickets(n))
        .catch(() => undefined);
    refresh();
    const timer = setInterval(refresh, 60_000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [userType, pathname]);

  // Um único item ativo: o mais específico (o Dashboard, em /dashboard, não
  // pode acender em todas as telas). Calculado sobre o menu INTEIRO.
  const activeHref = getActiveHref(
    pathname,
    navigation.map((item) => item.href)
  );

  const visibleNavigation = navigation.filter((item) => {
    if (!canAccessPath(item.href, userType)) return false;
    const moduleKey = moduleForPath(item.href);
    if (moduleKey && disabledModules.has(moduleKey)) return false;
    return true;
  });

  return (
    <div
      id="app-sidebar"
      className={cn(
        'fixed inset-y-0 left-0 z-40 flex h-full w-64 flex-col border-r border-border bg-card text-card-foreground transition-[transform,visibility] duration-200 lg:visible lg:sticky lg:top-0 lg:z-auto lg:h-app lg:shrink-0 lg:translate-x-0 lg:self-start',
        open ? 'translate-x-0' : 'invisible -translate-x-full'
      )}
    >
      {/* Logo */}
      <div className="flex h-16 items-center border-b border-border px-6">
        <CortexWordmark as="h1" />
      </div>

      {/* Navigation */}
      <nav aria-label="Menu principal" className="flex-1 space-y-1 overflow-y-auto px-3 py-4">
        {visibleNavigation.map((item) => {
          const isActive = item.href === activeHref;
          const Icon = item.icon;

          return (
            <Link
              key={item.name}
              href={item.href}
              className={cn(
                'flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
                isActive
                  ? 'bg-accent text-foreground shadow-[inset_2px_0_0_hsl(var(--primary))]'
                  : 'text-muted-foreground hover:bg-accent hover:text-foreground'
              )}
              aria-current={isActive ? 'page' : undefined}
              onClick={onNavigate}
            >
              <Icon className="h-5 w-5" />
              {item.name}
              {item.href === '/dashboard/help' && unreadTickets > 0 && (
                <span
                  data-testid="support-unread-badge"
                  aria-label={`${unreadTickets} chamado(s) com resposta nova`}
                  className="ml-auto rounded-full bg-foreground px-2 py-0.5 text-xs font-semibold text-background"
                >
                  {unreadTickets > 99 ? '99+' : unreadTickets}
                </span>
              )}
            </Link>
          );
        })}
      </nav>

      {/* Footer */}
      <div className="border-t border-border p-4">
        <div className="text-xs text-muted-foreground">
          <p>Versão 1.0.0</p>
          <p>© {new Date().getFullYear()} CÓRTEX · Lógica de Negócios</p>
        </div>
      </div>
    </div>
  );
}
