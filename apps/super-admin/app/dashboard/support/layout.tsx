export default function SupportLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto w-full max-w-7xl space-y-6">
      <div>
        <h1 className="text-3xl font-bold">Console de Suporte</h1>
        <p className="text-muted-foreground">Chamados das empresas clientes, base de conhecimento e equipe de atendimento da plataforma.</p>
      </div>
      {children}
    </div>
  );
}
