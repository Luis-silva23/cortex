-- Central de Ajuda e Suporte (2026-09-28). Chamados da empresa (RLS empresa+filial), histórico e mensagens que só
-- crescem, anexos no banco (sob RLS) e base de conhecimento global (leitura para todos os logados, escrita só da
-- plataforma). Carga inicial da base ANTES de ligar a RLS: com FORCE, até o dono da tabela passaria pela política.

-- 1. Número do chamado: sequência global (não depende de enxergar as linhas de outras filiais/empresas) -------------
CREATE SEQUENCE IF NOT EXISTS "support_ticket_number_seq" START WITH 1000;

-- 2. Chamados --------------------------------------------------------------------------------------------------------
CREATE TABLE "support_tickets" (
    "id" TEXT NOT NULL,
    "ticketNumber" INTEGER NOT NULL DEFAULT nextval('support_ticket_number_seq'::regclass),
    "companyId" TEXT NOT NULL,
    "branchId" TEXT,
    "requesterId" TEXT NOT NULL,
    "requesterName" TEXT NOT NULL,
    "requesterEmail" TEXT,
    "requesterPhone" TEXT,
    "requesterRole" TEXT NOT NULL,
    "companyName" TEXT,
    "branchName" TEXT,
    "subject" TEXT NOT NULL,
    "module" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "priority" TEXT NOT NULL DEFAULT 'NORMAL',
    "status" TEXT NOT NULL DEFAULT 'ABERTO',
    "description" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'ADMIN_WEB',
    "appVersion" TEXT,
    "context" JSONB,
    "assignedToId" TEXT,
    "assignedToName" TEXT,
    "assignedAt" TIMESTAMP(3),
    "firstResponseAt" TIMESTAMP(3),
    "resolvedAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "lastMessageAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastMessageBy" TEXT NOT NULL DEFAULT 'REQUESTER',
    "requesterLastReadAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "supportLastReadAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "support_tickets_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "support_tickets_status_check" CHECK ("status" IN ('ABERTO','EM_ANALISE','AGUARDANDO_USUARIO','AGUARDANDO_SUPORTE','RESOLVIDO','ENCERRADO')),
    CONSTRAINT "support_tickets_priority_check" CHECK ("priority" IN ('BAIXA','NORMAL','ALTA','CRITICA')),
    CONSTRAINT "support_tickets_last_by_check" CHECK ("lastMessageBy" IN ('REQUESTER','COMPANY','SUPPORT'))
);
ALTER SEQUENCE "support_ticket_number_seq" OWNED BY "support_tickets"."ticketNumber";
CREATE UNIQUE INDEX "support_tickets_ticketNumber_key" ON "support_tickets"("ticketNumber");
CREATE INDEX "support_tickets_companyId_status_createdAt_idx" ON "support_tickets"("companyId", "status", "createdAt");
CREATE INDEX "support_tickets_companyId_branchId_idx" ON "support_tickets"("companyId", "branchId");
CREATE INDEX "support_tickets_requesterId_createdAt_idx" ON "support_tickets"("requesterId", "createdAt");
CREATE INDEX "support_tickets_assignedToId_status_idx" ON "support_tickets"("assignedToId", "status");
CREATE INDEX "support_tickets_module_idx" ON "support_tickets"("module");
CREATE INDEX "support_tickets_status_createdAt_idx" ON "support_tickets"("status", "createdAt");

-- 3. Mensagens (só crescem) -------------------------------------------------------------------------------------------
CREATE TABLE "support_ticket_messages" (
    "id" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "branchId" TEXT,
    "authorId" TEXT NOT NULL,
    "authorName" TEXT NOT NULL,
    "authorRole" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "statusFrom" TEXT,
    "statusTo" TEXT,
    "source" TEXT NOT NULL DEFAULT 'ADMIN_WEB',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "support_ticket_messages_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "support_ticket_messages_role_check" CHECK ("authorRole" IN ('REQUESTER','COMPANY','SUPPORT')),
    CONSTRAINT "support_ticket_messages_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "support_tickets"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "support_ticket_messages_ticketId_createdAt_idx" ON "support_ticket_messages"("ticketId", "createdAt");

-- 4. Anexos (no banco, sob RLS; remoção lógica) -----------------------------------------------------------------------
CREATE TABLE "support_ticket_attachments" (
    "id" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "messageId" TEXT,
    "companyId" TEXT NOT NULL,
    "branchId" TEXT,
    "fileName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "data" BYTEA NOT NULL,
    "uploadedBy" TEXT NOT NULL,
    "uploadedByName" TEXT NOT NULL,
    "removedAt" TIMESTAMP(3),
    "removedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "support_ticket_attachments_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "support_ticket_attachments_mime_check" CHECK ("mimeType" IN ('image/png','image/jpeg','application/pdf','text/plain')),
    CONSTRAINT "support_ticket_attachments_size_check" CHECK ("size" > 0 AND "size" <= 2097152),
    CONSTRAINT "support_ticket_attachments_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "support_tickets"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "support_ticket_attachments_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "support_ticket_messages"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "support_ticket_attachments_ticketId_idx" ON "support_ticket_attachments"("ticketId");

-- 5. Histórico (só cresce) --------------------------------------------------------------------------------------------
CREATE TABLE "support_ticket_events" (
    "id" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "branchId" TEXT,
    "type" TEXT NOT NULL,
    "fromValue" TEXT,
    "toValue" TEXT,
    "actorId" TEXT NOT NULL,
    "actorName" TEXT NOT NULL,
    "actorRole" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "support_ticket_events_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "support_ticket_events_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "support_tickets"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "support_ticket_events_ticketId_createdAt_idx" ON "support_ticket_events"("ticketId", "createdAt");

-- 6. Base de conhecimento (global) -------------------------------------------------------------------------------------
CREATE TABLE "support_kb_categories" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "support_kb_categories_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "support_kb_categories_slug_key" ON "support_kb_categories"("slug");

CREATE TABLE "support_kb_articles" (
    "id" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "summary" TEXT,
    "body" TEXT NOT NULL,
    "keywords" TEXT,
    "module" TEXT,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "authorId" TEXT NOT NULL,
    "authorName" TEXT NOT NULL,
    "publishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "search" tsvector GENERATED ALWAYS AS (
      setweight(to_tsvector('portuguese'::regconfig, coalesce("title", '')), 'A') ||
      setweight(to_tsvector('portuguese'::regconfig, coalesce("summary", '') || ' ' || coalesce("keywords", '')), 'B') ||
      setweight(to_tsvector('portuguese'::regconfig, coalesce("body", '')), 'C')
    ) STORED,
    CONSTRAINT "support_kb_articles_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "support_kb_articles_status_check" CHECK ("status" IN ('DRAFT','PUBLISHED')),
    CONSTRAINT "support_kb_articles_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "support_kb_categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "support_kb_articles_slug_key" ON "support_kb_articles"("slug");
CREATE INDEX "support_kb_articles_categoryId_status_idx" ON "support_kb_articles"("categoryId", "status");
CREATE INDEX "support_kb_articles_search_idx" ON "support_kb_articles" USING GIN ("search");

-- 7. Carga inicial da base de conhecimento (conteúdo do produto, descrito a partir do comportamento real) --------------
INSERT INTO "support_kb_categories" ("id", "slug", "name", "sortOrder") VALUES
  ('kbcat-pdv', 'pdv', 'PDV', 10),
  ('kbcat-estoque', 'estoque', 'Estoque', 20),
  ('kbcat-financeiro', 'financeiro', 'Financeiro', 30),
  ('kbcat-oficina', 'oficina', 'Oficina', 40),
  ('kbcat-convenios', 'convenios', 'Convênios', 50),
  ('kbcat-agenda', 'agenda', 'Agenda', 60),
  ('kbcat-pos-venda', 'pos-venda', 'Pós-venda', 70),
  ('kbcat-fiscal', 'fiscal', 'Fiscal', 80),
  ('kbcat-conta', 'conta-e-acesso', 'Conta e acesso', 90),
  ('kbcat-outros', 'outros', 'Outros', 100)
ON CONFLICT ("slug") DO NOTHING;

INSERT INTO "support_kb_articles" ("id", "categoryId", "slug", "title", "summary", "body", "keywords", "module", "status", "authorId", "authorName", "publishedAt") VALUES
('kb-pagamento-nao-confirmado', 'kbcat-pdv', 'pagamento-nao-confirmado', 'Pagamento não confirmado',
 'O que significa "PAGAMENTO NÃO CONFIRMADO — VENDA NÃO CONCLUÍDA" e como resolver sem cobrar duas vezes.',
 $$Quando o PDV não recebe a confirmação do pagamento (sem resposta do servidor ou pagamento ainda pendente, como um PIX aguardando), a tela mostra "PAGAMENTO NÃO CONFIRMADO — VENDA NÃO CONCLUÍDA". A venda não é concluída até a confirmação.

O que fazer:
1. Use "Verificar de novo". O PDV reenvia a MESMA tentativa (mesma chave), então não existe cobrança em dobro.
2. Se for PIX pendente, confira no aplicativo do banco se o valor entrou antes de qualquer nova cobrança.
3. Não inicie outra cobrança enquanto a primeira não estiver resolvida.
4. Se precisar desistir, "Cancelar pagamento pendente" exige a permissão de estorno; sem ela, peça à gerência.

Se o problema continuar, abra um chamado a partir da própria venda: o número da venda vai junto automaticamente.$$,
 'pagamento pendente pix verificar cobrar de novo não concluída', 'PDV', 'PUBLISHED', 'SYSTEM', 'Equipe CÓRTEX', CURRENT_TIMESTAMP),
('kb-cancelar-venda', 'kbcat-pdv', 'como-cancelar-uma-venda', 'Como cancelar uma venda?',
 'Cancelamento com autorizador e motivo; o que acontece com o caixa e com o pagamento.',
 $$No PDV, abra Histórico, escolha a venda e use "Cancelar". O cancelamento pede o motivo e as credenciais de um gerente ou administrador (outra pessoa — quem pede não autoriza o próprio cancelamento).

O que acontece:
- Se a venda já tinha sido paga e o caixa ainda está aberto, o estorno sai do esperado do caixa.
- Venda cancelada não recebe pagamento e não é reaberta: uma nova compra é uma nova venda.
- Venda cancelada não gera nota fiscal.

Se o provedor aprovar um pagamento depois do cancelamento, isso aparece em Financeiro › Conciliação para uma pessoa autorizada tratar.$$,
 'cancelar venda estorno autorizador motivo', 'PDV', 'PUBLISHED', 'SYSTEM', 'Equipe CÓRTEX', CURRENT_TIMESTAMP),
('kb-estornar-pagamento', 'kbcat-financeiro', 'como-estornar-um-pagamento', 'Como estornar um pagamento?',
 'Quem pode estornar e o caso especial do pagamento aprovado depois do cancelamento.',
 $$Cancelar ou estornar um pagamento aprovado exige a permissão de estorno (padrão do administrador da empresa; outros perfis só se o perfil granular conceder). O estorno sai do esperado do caixa, na forma de pagamento original.

Pagamento aprovado pelo provedor com a venda já cancelada é uma inconsistência de integração: não é estornado pelo caminho comum. Trate em Financeiro › Conciliação — por estorno confirmado no provedor ou por registro manual com justificativa.$$,
 'estorno estornar pagamento conciliação permissão', 'Financeiro', 'PUBLISHED', 'SYSTEM', 'Equipe CÓRTEX', CURRENT_TIMESTAMP),
('kb-fechamento-caixa', 'kbcat-pdv', 'fechamento-de-caixa-por-forma-de-pagamento', 'Fechamento de caixa por forma de pagamento',
 'Esperado × informado em dinheiro, cartão, PIX e convênios; motivo da diferença; pendências e fechamento forçado.',
 $$O fechamento considera todo o movimento do caixa. A tela mostra o esperado de cada forma de pagamento — dinheiro (fundo de troco + vendas + reforços − sangrias − estornos), cartão, PIX e convênios — e você informa o realizado de cada uma (dinheiro contado, relatório da maquininha, extrato do PIX).

- Se houver diferença, informe o motivo: ele fica registrado no fechamento.
- Pagamento aguardando confirmação ou venda em aberto bloqueiam o fechamento normal (política da loja). Resolva em Vendas ou peça à gerência o fechamento forçado, que exige motivo e autorizador e não apaga nada.$$,
 'fechar caixa diferença motivo esperado informado forçado pendência', 'PDV', 'PUBLISHED', 'SYSTEM', 'Equipe CÓRTEX', CURRENT_TIMESTAMP),
('kb-convenio-nao-habilitado', 'kbcat-convenios', 'convenio-nao-habilitado-para-esta-filial', 'Convênio não habilitado para esta filial',
 'Por que o convênio aparece cinza no caixa e quem pode habilitar.',
 $$No pagamento, "Convênio funcionário" e "Convênio empresa" aparecem cinza com a mensagem "Convênio não habilitado para esta filial" quando:
- o tipo de convênio está desligado nas Políticas da empresa ou desta filial; ou
- o convênio escolhido vale só para outras filiais; ou
- a empresa conveniada está bloqueada ou inativa.

O operador não consegue liberar pelo caixa. Quem habilita e autoriza convênio é a administração da empresa (Configurações › Políticas e Convênios).$$,
 'convênio cinza desabilitado filial bloqueado administração', 'Convênios', 'PUBLISHED', 'SYSTEM', 'Equipe CÓRTEX', CURRENT_TIMESTAMP),
('kb-garantia-os', 'kbcat-pos-venda', 'garantia-da-ordem-de-servico', 'Garantia da ordem de serviço',
 'Decisão de garantia no encerramento da OS e registro de ocorrência no pós-venda.',
 $$Ao encerrar a OS, decida a garantia: sem garantia ou com garantia de serviço, peça ou ambos, com prazo (dias, meses ou anos) e, se quiser, limite de km — vale o que ocorrer primeiro. O prazo começa na entrega do veículo.

Em Pós-venda › Garantias você vê as garantias vigentes e vencidas e registra uma ocorrência, sempre ligada à OS original. Ocorrência fora do prazo ou acima do km é recusada com o motivo.$$,
 'garantia os ocorrência prazo km pós-venda', 'Pós-venda', 'PUBLISHED', 'SYSTEM', 'Equipe CÓRTEX', CURRENT_TIMESTAMP),
('kb-agenda-horario-indisponivel', 'kbcat-agenda', 'horario-indisponivel-na-agenda', 'Horário indisponível na agenda',
 'O que significa cada recusa ao propor ou remarcar um horário.',
 $$A agenda segue a capacidade que a sua empresa configurou. Ao propor ou remarcar, o horário pode ser recusado por:
- fora do horário de funcionamento (o atendimento inteiro precisa caber, inclusive a duração);
- indisponibilidade da filial ou do mecânico;
- mecânico já ocupado;
- horário, dia ou mês lotado, ou nenhum box livre.

A grade de horários do dia mostra o que está livre e o motivo do que não está. A confirmação do horário é sempre do cliente.$$,
 'agenda lotado box mecânico indisponível horário funcionamento', 'Agenda', 'PUBLISHED', 'SYSTEM', 'Equipe CÓRTEX', CURRENT_TIMESTAMP),
('kb-codigo-mfa', 'kbcat-conta', 'codigo-de-verificacao-mfa', 'Código de verificação (MFA) não aceito',
 'Código do aplicativo autenticador, códigos de recuperação e limite de tentativas.',
 $$Se o código do aplicativo autenticador não for aceito:
1. Confira se o relógio do celular está na hora automática — o código depende do horário.
2. Digite o código atual (ele muda a cada 30 segundos).
3. Sem acesso ao aplicativo, use um código de recuperação: cada um vale uma única vez.

Depois de várias tentativas erradas o acesso fica bloqueado por alguns minutos. Se perdeu o aplicativo e os códigos, peça ao administrador da empresa.$$,
 'mfa código autenticador recuperação login bloqueado', 'Usuários e permissões', 'PUBLISHED', 'SYSTEM', 'Equipe CÓRTEX', CURRENT_TIMESTAMP),
('kb-devolucao-fornecedor', 'kbcat-estoque', 'devolucao-ao-fornecedor', 'Devolução ao fornecedor',
 'Produto danificado ou errado recebido do fornecedor: da solicitação ao resultado.',
 $$Em Compras › Devolução ao fornecedor: solicite (produto, quantidade, motivo), a gerência aprova — e a aprovação retira o item do estoque —, registre o envio e, por fim, o resultado (crédito, reposição, reembolso ou recusa do fornecedor). Cancelar antes do envio devolve o item ao estoque. Tudo fica no histórico.

Isto não é garantia ao cliente: garantia de serviço/peça do cliente é registrada no encerramento da OS.$$,
 'devolução fornecedor avaria defeito estoque crédito reposição', 'Estoque', 'PUBLISHED', 'SYSTEM', 'Equipe CÓRTEX', CURRENT_TIMESTAMP),
('kb-nota-venda-cancelada', 'kbcat-fiscal', 'nota-fiscal-de-venda-cancelada-ou-pendente', 'Nota fiscal de venda cancelada ou pendente',
 'Por que a venda não aparece para emissão.',
 $$A tela Fiscal oferece só vendas pagas. Venda cancelada não gera nota (seria nota de uma venda que não existe), e venda pendente ou parcialmente paga ainda não foi concluída.

A emissão real depende do provedor fiscal configurado para a empresa; sem provedor, o CÓRTEX não simula emissão.$$,
 'nota fiscal emissão venda cancelada pendente sefaz', 'Fiscal', 'PUBLISHED', 'SYSTEM', 'Equipe CÓRTEX', CURRENT_TIMESTAMP)
ON CONFLICT ("slug") DO NOTHING;

-- 8. RLS -----------------------------------------------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  -- chamados e anexos: empresa + filial (anexo sofre remoção lógica → precisa de UPDATE)
  FOREACH t IN ARRAY ARRAY['support_tickets','support_ticket_attachments'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON public.%I USING (public.rls_company_branch_match("companyId", "branchId")) WITH CHECK (public.rls_company_branch_match("companyId", "branchId"))', t || '_isolation', t);
  END LOOP;
  -- mensagens e histórico: só leitura e inclusão (sem alteração silenciosa); exclusão só na limpeza sinalizada da plataforma
  FOREACH t IN ARRAY ARRAY['support_ticket_messages','support_ticket_events'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT USING (public.rls_company_branch_match("companyId", "branchId"))', t || '_read', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR INSERT WITH CHECK (public.rls_company_branch_match("companyId", "branchId"))', t || '_insert', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR DELETE USING (public.is_super_admin() AND current_setting(''app.audit_purge'', true) = ''on'')', t || '_purge', t);
  END LOOP;
END $$;

-- base de conhecimento: todos os logados leem (artigo só publicado; a plataforma vê rascunhos); só a plataforma escreve
ALTER TABLE "support_kb_categories" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "support_kb_categories" FORCE ROW LEVEL SECURITY;
CREATE POLICY support_kb_categories_read ON "support_kb_categories" FOR SELECT USING (true);
CREATE POLICY support_kb_categories_write ON "support_kb_categories" FOR ALL USING (public.is_super_admin()) WITH CHECK (public.is_super_admin());

ALTER TABLE "support_kb_articles" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "support_kb_articles" FORCE ROW LEVEL SECURITY;
CREATE POLICY support_kb_articles_read ON "support_kb_articles" FOR SELECT USING ("status" = 'PUBLISHED' OR public.is_super_admin());
CREATE POLICY support_kb_articles_write ON "support_kb_articles" FOR ALL USING (public.is_super_admin()) WITH CHECK (public.is_super_admin());
