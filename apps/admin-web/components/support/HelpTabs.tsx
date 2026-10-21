'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/cn';
import { HELP_HOME, NEW_TICKET_PATH } from '@/lib/support';

const TABS = [
  { href: HELP_HOME, label: 'Pesquisar ajuda' },
  { href: '/dashboard/help/tickets', label: 'Meus chamados' },
  { href: NEW_TICKET_PATH, label: 'Novo chamado' },
];

/** Navegação interna da Central de Ajuda (aba ativa = rota mais específica). */
export function HelpTabs() {
  const pathname = usePathname() ?? '';
  const active =
    pathname.startsWith(NEW_TICKET_PATH) ? NEW_TICKET_PATH : pathname.startsWith('/dashboard/help/tickets') ? '/dashboard/help/tickets' : HELP_HOME;
  return (
    <nav aria-label="Central de Ajuda" className="flex gap-1 overflow-x-auto border-b border-border">
      {TABS.map((t) => (
        <Link
          key={t.href}
          href={t.href}
          aria-current={active === t.href ? 'page' : undefined}
          className={cn(
            'whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium transition-colors',
            active === t.href ? 'border-foreground text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'
          )}
        >
          {t.label}
        </Link>
      ))}
    </nav>
  );
}
