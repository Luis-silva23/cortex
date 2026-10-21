'use client';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { eventPhrase, formatDateTime } from '../_lib/format';
import type { SupportCatalog, TicketEvent } from '../_lib/types';

/** Histórico imutável do chamado (eventos gravados pelo backend; nada aqui é editável). */
export function TicketHistory({ events, catalog }: { events: TicketEvent[]; catalog: SupportCatalog | null }) {
  return (
    <Card>
      <CardHeader className="p-4 pb-2">
        <CardTitle className="text-base">Histórico</CardTitle>
        <p className="text-xs text-muted-foreground">Registro permanente de tudo o que aconteceu com o chamado.</p>
      </CardHeader>
      <CardContent className="p-4 pt-2">
        {events.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nenhum evento registrado.</p>
        ) : (
          <ol className="relative space-y-4 border-l pl-4" data-testid="ticket-history">
            {events.map((e) => (
              <li key={e.id} className="relative" data-testid="ticket-event" data-event-type={e.type}>
                <span className="absolute -left-[21px] top-1.5 h-2.5 w-2.5 rounded-full border-2 border-background bg-muted-foreground" aria-hidden="true" />
                <p className="break-words text-sm">{eventPhrase(e, catalog)}</p>
                <p className="text-xs text-muted-foreground">{formatDateTime(e.createdAt)}</p>
              </li>
            ))}
          </ol>
        )}
      </CardContent>
    </Card>
  );
}
