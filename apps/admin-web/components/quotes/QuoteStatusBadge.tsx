import { Badge } from '@/components/ui/badge';
import { QUOTE_STATUS_LABEL, QUOTE_STATUS_VARIANT, type QuoteStatus } from '@/lib/quotes';

export function QuoteStatusBadge({ status }: { status: string }) {
  const known = status in QUOTE_STATUS_LABEL;
  return (
    <Badge variant={known ? QUOTE_STATUS_VARIANT[status as QuoteStatus] : 'secondary'} data-status={status}>
      {known ? QUOTE_STATUS_LABEL[status as QuoteStatus] : status}
    </Badge>
  );
}
