'use client';

import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from './button';

interface PaginationProps {
  page: number;
  pages: number;
  total: number;
  itemCount: number;
  onPageChange: (page: number) => void;
  itemLabel?: string;
}

// ACHADO DE AUDITORIA (Agente 06, 2026-09-15): várias telas de listagem
// buscavam um `limit` fixo (ex.: 100) sem NENHUM controle pra ver o
// restante — acima do limite, os demais registros ficavam simplesmente
// inacessíveis pela UI. Fica mais estrito ainda desde que o backend passou
// a travar `limit` em 100 no servidor (apps/api/src/middleware/
// paginationLimit.ts) — não dá mais pra "resolver" pedindo um limit maior.
export function Pagination({ page, pages, total, itemCount, onPageChange, itemLabel = 'registros' }: PaginationProps) {
  return (
    <div className="p-4 border-t border-border flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <p className="text-sm text-muted-foreground">
        Mostrando {itemCount} de {total} {itemLabel}
        {pages > 1 && ` — página ${page} de ${pages}`}
      </p>
      {pages > 1 && (
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={page <= 1}
            onClick={() => onPageChange(page - 1)}
          >
            <ChevronLeft className="h-4 w-4 mr-1" />
            Anterior
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={page >= pages}
            onClick={() => onPageChange(page + 1)}
          >
            Próxima
            <ChevronRight className="h-4 w-4 ml-1" />
          </Button>
        </div>
      )}
    </div>
  );
}
