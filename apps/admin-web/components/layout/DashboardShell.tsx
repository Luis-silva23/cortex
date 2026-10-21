'use client';

import { useCallback, useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import Link from 'next/link';
import { Lock, PowerOff } from 'lucide-react';
import { Sidebar } from '@/components/layout/Sidebar';
import { Header } from '@/components/layout/Header';
import { ModuleSettingsProvider, useModuleSettings } from '@/components/providers/ModuleSettingsProvider';
import { MODULE_DISABLED_MESSAGE, canAccessPath, isRoleRestrictedPath, moduleForPath, type SystemModule } from '@/lib/navigation';
import { useUserType } from '@/lib/hooks/useUserType';

const MODULE_LABELS: Record<SystemModule, string> = {
  ESTOQUE: 'Estoque',
  COMPRAS: 'Compras',
  VENDAS: 'Vendas',
  FINANCEIRO: 'Financeiro',
  FISCAL: 'Fiscal',
  OFICINA: 'Oficina',
  POS_VENDA: 'Pós-venda',
  CANAIS: 'Canais de venda',
};

// URL digitada (ou favorito) de um módulo desligado: estado próprio em vez da tela quebrada com o 403 da API.
function ModuleGate({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { disabled } = useModuleSettings();
  const moduleKey = moduleForPath(pathname);
  if (!moduleKey || !disabled.has(moduleKey)) return <>{children}</>;
  return (
    <div role="status" className="mx-auto flex max-w-lg flex-col items-center gap-4 py-20 text-center">
      <div className="rounded-full bg-muted p-4">
        <PowerOff className="h-6 w-6 text-muted-foreground" aria-hidden />
      </div>
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{MODULE_LABELS[moduleKey]}</p>
      <h1 className="text-lg font-semibold text-foreground">{MODULE_DISABLED_MESSAGE}</h1>
      <Link
        href="/dashboard"
        className="inline-flex h-10 items-center rounded-md border border-border px-4 text-sm font-medium text-foreground hover:bg-accent"
      >
        Voltar ao painel
      </Link>
    </div>
  );
}

// URL digitada de uma tela que o papel não acessa (ex.: mecânico em /dashboard/financial): estado próprio em vez da
// tela com botões de ação e um "Tente novamente" que nunca funcionaria. Até ler o papel, a tela restrita não carrega.
function RoleGate({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { userType, ready } = useUserType();
  if (!isRoleRestrictedPath(pathname)) return <>{children}</>;
  if (!ready) return null;
  if (canAccessPath(pathname, userType)) return <>{children}</>;
  return (
    <div role="status" className="mx-auto flex max-w-lg flex-col items-center gap-4 py-20 text-center">
      <div className="rounded-full bg-muted p-4">
        <Lock className="h-6 w-6 text-muted-foreground" aria-hidden />
      </div>
      <h1 className="text-xl font-semibold text-foreground">Acesso restrito</h1>
      <p className="text-sm text-muted-foreground">
        O seu perfil não tem acesso a esta área. Se precisar dela, peça ao administrador da empresa.
      </p>
      <Link
        href="/dashboard"
        className="inline-flex h-10 items-center rounded-md border border-border px-4 text-sm font-medium text-foreground hover:bg-accent"
      >
        Voltar ao painel
      </Link>
    </div>
  );
}

// Moldura do dashboard. Em telas >= lg a sidebar é fixa ao lado do conteúdo
// (como sempre foi); abaixo de lg ela vira uma gaveta aberta pelo botão de
// menu do Header — antes ocupava 256px de qualquer tela e sobravam ~130px
// para o conteúdo num celular.
export function DashboardShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [navOpen, setNavOpen] = useState(false);
  const closeNav = useCallback(() => setNavOpen(false), []);

  // Navegou para outra página: fecha a gaveta.
  useEffect(() => {
    setNavOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!navOpen) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setNavOpen(false);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [navOpen]);

  return (
    // O DOCUMENTO rola (não um <main> com overflow interno): sidebar e header
    // são `sticky`. Antes a moldura era `h-screen overflow-hidden` com só o
    // <main> rolando — PageDown/Espaço/End não faziam nada ao carregar (o foco
    // fica no <body>, que não rola), a roda do mouse sobre header/sidebar não
    // rolava o conteúdo e, em celular, `100vh` inclui a área sob a barra do
    // navegador (o fim do formulário ficava escondido).
    <ModuleSettingsProvider>
    <div className="flex min-h-app bg-background text-foreground">
      <Sidebar open={navOpen} onNavigate={closeNav} />
      {navOpen && (
        <div
          className="fixed inset-0 z-30 bg-overlay/60 lg:hidden"
          aria-hidden="true"
          data-testid="nav-backdrop"
          onClick={closeNav}
        />
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <Header navOpen={navOpen} onMenuClick={() => setNavOpen((open) => !open)} />
        <main className="flex-1 bg-background p-4 sm:p-6">
          <RoleGate>
            <ModuleGate>{children}</ModuleGate>
          </RoleGate>
        </main>
      </div>
    </div>
    </ModuleSettingsProvider>
  );
}
