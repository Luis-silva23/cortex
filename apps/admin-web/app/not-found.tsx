import Link from 'next/link';
import { CortexWordmark } from '@/components/ui/brand';

// Só para rota que realmente não existe. Recurso inexistente dentro de uma tela válida (orçamento, OS...)
// continua com a mensagem própria da tela.
export default function NotFound() {
  return (
    <main className="min-h-app flex flex-col items-center justify-center gap-10 bg-background px-4 py-16 text-center">
      <CortexWordmark size="lg" className="justify-center" />
      <div className="space-y-3">
        <p className="text-7xl font-bold tracking-tight text-foreground">404</p>
        <h1 className="text-xl font-semibold text-foreground">Ops. Nada por aqui…</h1>
        <p className="mx-auto max-w-md text-sm text-muted-foreground">
          Página não encontrada: o endereço não existe ou foi alterado. Confira o link ou volte para o início.
        </p>
      </div>
      <div className="flex flex-col gap-3 sm:flex-row">
        <Link
          href="/dashboard"
          className="inline-flex h-10 items-center justify-center rounded-md bg-primary px-5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        >
          Voltar ao início
        </Link>
        <Link
          href="/login"
          className="inline-flex h-10 items-center justify-center rounded-md border border-border px-5 text-sm font-medium text-foreground transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        >
          Entrar novamente
        </Link>
      </div>
    </main>
  );
}
