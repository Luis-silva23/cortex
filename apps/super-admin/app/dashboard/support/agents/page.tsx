'use client';

import { Card } from '@/components/ui/card';
import { EmptyState, ErrorState, LoadingState, PageTitle } from '../_components/states';
import { useSupportAgents } from '../_lib/hooks';

export default function SupportAgentsPage() {
  const { agents, error, reload } = useSupportAgents();

  return (
    <div className="space-y-4">
      <PageTitle title="Responsáveis" description="Equipe da plataforma que atende os chamados e quantos chamados abertos cada pessoa tem. A atribuição é feita dentro de cada chamado." />
      {error ? (
        <ErrorState message={error} onRetry={reload} />
      ) : !agents ? (
        <LoadingState label="Carregando equipe..." />
      ) : agents.length === 0 ? (
        <EmptyState message="Nenhum responsável de suporte cadastrado." />
      ) : (
        <Card>
          <ul className="divide-y" data-testid="agent-list">
            {agents.map((a) => (
              <li key={a.id} className="flex flex-col gap-1 p-4 sm:flex-row sm:items-center sm:justify-between" data-testid="agent-row">
                <div className="min-w-0">
                  <p className="break-words font-medium">{a.name}</p>
                  <p className="break-all text-xs text-muted-foreground">{a.email}</p>
                </div>
                <p className="text-sm text-muted-foreground">{a.openTickets} chamado(s) aberto(s)</p>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
