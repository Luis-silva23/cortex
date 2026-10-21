'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  Building2,
  Key,
  Monitor,
  Users,
  LayoutDashboard,
  Activity,
  ScrollText,
  DatabaseBackup,
  Gauge,
  MessagesSquare,
  BookOpen,
  FolderTree,
  UserCog,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { CortexMark } from '@/components/ui/cortex-mark';

const navigation: Array<{ name: string; href: string; icon: typeof Activity; match?: string }> = [
  { name: 'Dashboard', href: '/dashboard', icon: LayoutDashboard },
  { name: 'Empresas', href: '/dashboard/companies', icon: Building2 },
  { name: 'Licenças', href: '/dashboard/licenses', icon: Key },
  { name: 'Dispositivos', href: '/dashboard/devices', icon: Monitor },
  { name: 'Usuários', href: '/dashboard/users', icon: Users },
  { name: 'Auditoria', href: '/dashboard/audit-logs', icon: ScrollText },
  { name: 'Backup', href: '/dashboard/backup', icon: DatabaseBackup },
  { name: 'Observabilidade', href: '/dashboard/observability/central', icon: Activity, match: '/dashboard/observability' },
];

// Console de Suporte (app/dashboard/support/**).
const supportNavigation = [
  { name: 'Painel', href: '/dashboard/support', icon: Gauge, exact: true },
  { name: 'Chamados', href: '/dashboard/support/tickets', icon: MessagesSquare },
  { name: 'Base de conhecimento', href: '/dashboard/support/kb', icon: BookOpen },
  { name: 'Categorias', href: '/dashboard/support/categories', icon: FolderTree },
  { name: 'Responsáveis', href: '/dashboard/support/agents', icon: UserCog },
];

/** md+: coluna fixa. Abaixo: gaveta sobre o conteúdo, aberta pelo botão de menu do cabeçalho. */
export function Sidebar({ open = false, onClose }: { open?: boolean; onClose?: () => void }) {
  const pathname = usePathname();

  return (
    <>
      {open && <div className="fixed inset-0 z-40 bg-black/50 md:hidden" onClick={onClose} aria-hidden="true" />}
      <div
        id="sidebar"
        className={cn(
          'fixed inset-y-0 left-0 z-50 flex h-full w-64 flex-col border-r bg-card transition-transform md:static md:translate-x-0',
          open ? 'translate-x-0' : '-translate-x-full'
        )}
      >
        <div className="flex h-16 items-center gap-3 border-b px-6">
          <CortexMark className="h-8 w-auto shrink-0" />
          <div className="flex flex-col leading-none">
            <h1 className="text-xl font-bold tracking-[0.12em]">CÓRTEX</h1>
            <span className="mt-1 text-[9px] font-medium uppercase tracking-[0.32em] text-muted-foreground">Plataforma</span>
          </div>
        </div>
        <nav className="flex-1 space-y-1 overflow-y-auto p-4">
          {navigation.map((item) => {
            const isActive =
              item.href === '/dashboard'
                ? pathname === item.href
                : pathname === (item.match ?? item.href) || pathname.startsWith(`${item.match ?? item.href}/`);
            return (
              <Link
                key={item.name}
                href={item.href}
                className={cn(
                  'flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
                  isActive
                    ? 'bg-primary text-primary-foreground'
                    : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground'
                )}
              >
                <item.icon className="h-5 w-5" />
                {item.name}
              </Link>
            );
          })}
          <div className="pt-4" role="group" aria-labelledby="nav-support-title">
            <p id="nav-support-title" className="px-3 pb-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
              Suporte
            </p>
            {supportNavigation.map((item) => {
              const isActive = item.exact ? pathname === item.href : pathname === item.href || pathname.startsWith(`${item.href}/`);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  data-testid={`nav-support-${item.href.split('/').pop()}`}
                  className={cn(
                    'flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
                    isActive
                      ? 'bg-primary text-primary-foreground'
                      : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground'
                  )}
                >
                  <item.icon className="h-5 w-5" />
                  {item.name}
                </Link>
              );
            })}
          </div>
        </nav>
      </div>
    </>
  );
}
