import { useMemo } from 'react';
import { Copy, Printer } from 'lucide-react';
import toast from 'react-hot-toast';
import { buildHandoffText, type HandoffInput } from '../lib/handoff';
import { Button, Card } from './ui';

/** Ficha para o CAIXA: leva ao PDV a referência do atendimento. O Balcão não cobra nem cria venda (ver lib/handoff.ts). */
export default function HandoffCard({ input }: { input: HandoffInput }) {
  const text = useMemo(() => buildHandoffText(input), [input]);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success('Ficha copiada.');
    } catch {
      toast.error('Não foi possível copiar. Use Imprimir.');
    }
  };
  return (
    <Card
      title="Encaminhar ao caixa"
      action={
        <span className="flex gap-2">
          <Button variant="secondary" onClick={copy}>
            <Copy className="h-4 w-4" /> Copiar
          </Button>
          <Button variant="secondary" onClick={() => window.print()}>
            <Printer className="h-4 w-4" /> Imprimir
          </Button>
        </span>
      }
    >
      <p className="mb-2 text-sm text-gray-600">O pagamento é feito no caixa (PDV). Entregue esta ficha ao operador do caixa.</p>
      <pre className="print-area whitespace-pre-wrap rounded-lg bg-primary-50 p-3 text-xs">{text}</pre>
    </Card>
  );
}
