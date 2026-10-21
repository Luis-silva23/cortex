'use client';

import Link from 'next/link';
import { LifeBuoy } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { buildReportHref, type ReportContext } from '@/lib/support';

/**
 * "Relatar problema" contextual: leva ao Novo chamado já com módulo, tela e a referência da entidade (OS, cobrança,
 * garantia…). O usuário não redigita o que o sistema já sabe; o servidor confere a referência na empresa dele.
 */
export function ReportProblemButton({ context, label = 'Relatar problema', size = 'sm' }: { context: ReportContext; label?: string; size?: 'sm' | 'default' }) {
  return (
    <Link href={buildReportHref(context)} data-testid="report-problem">
      <Button variant="outline" size={size} type="button" tabIndex={-1}>
        <LifeBuoy className="mr-2 h-4 w-4" aria-hidden />
        {label}
      </Button>
    </Link>
  );
}
