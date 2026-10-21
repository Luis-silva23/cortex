'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';

const tabs = [
  { name: 'Central', href: '/dashboard/observability/central' },
  { name: 'Empresas', href: '/dashboard/observability/empresas' },
  { name: 'Alertas', href: '/dashboard/observability/alertas' },
  { name: 'Funil', href: '/dashboard/observability/funil' },
  { name: 'Serviços externos', href: '/dashboard/observability/externos' },
  { name: 'Resumo técnico', href: '/dashboard/observability' },
  { name: 'Performance', href: '/dashboard/observability/performance' },
  { name: 'Segurança', href: '/dashboard/observability/security' },
  { name: 'Infraestrutura', href: '/dashboard/observability/health' },
  { name: 'Integrações', href: '/dashboard/observability/integrations' },
  { name: 'Jobs', href: '/dashboard/observability/jobs' },
  { name: 'Logs', href: '/dashboard/observability/logs' },
];

export default function ObservabilityLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold">Observabilidade</h1>
        <p className="text-muted-foreground">
          Saúde técnica, performance e segurança da plataforma
        </p>
      </div>

      <div className="border-b">
        <nav className="-mb-px flex gap-4 overflow-x-auto">
          {tabs.map((tab) => {
            const isActive =
              tab.href === '/dashboard/observability'
                ? pathname === tab.href
                : pathname === tab.href || pathname.startsWith(`${tab.href}/`);
            return (
              <Link
                key={tab.href}
                href={tab.href}
                className={cn(
                  'whitespace-nowrap border-b-2 px-1 py-3 text-sm font-medium transition-colors',
                  isActive
                    ? 'border-primary text-primary'
                    : 'border-transparent text-muted-foreground hover:border-muted-foreground/40 hover:text-foreground'
                )}
              >
                {tab.name}
              </Link>
            );
          })}
        </nav>
      </div>

      {children}
    </div>
  );
}
