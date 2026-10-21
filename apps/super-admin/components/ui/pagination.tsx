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

// Mesmo componente de apps/admin-web/components/ui/pagination.tsx — ver
// comentário lá sobre o achado original (listas sem controle de paginação
// nenhum na UI, mesmo com o backend já limitando `limit` no servidor).
export function Pagination({ page, pages, total, itemCount, onPageChange, itemLabel = 'registros' }: PaginationProps) {
  return (
    <div className="p-4 border-t flex items-center justify-between">
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
