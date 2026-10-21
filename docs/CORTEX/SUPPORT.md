# Central de Ajuda, Suporte e Chamados

Usuário da empresa abre e acompanha os próprios chamados no Admin Web. A plataforma (SUPER_ADMIN) atende no Console de
Suporte do Super Admin. Sem IA, sem chatbot, sem SLA (SLA está no [ROADMAP](ROADMAP.md)).

## Quem vê o quê

| Quem | Vê | Faz |
|---|---|---|
| Usuário da empresa (qualquer perfil, inclusive VIEWER) | Os chamados que abriu | Abrir, responder, anexar; encerrar o próprio chamado |
| Usuário com `support:view_company` (COMPANY_ADMIN por padrão) | Todos os chamados da empresa | Responder e anexar nos da empresa; reabrir resolvidos |
| Usuário preso a uma filial, sem a permissão acima | Só chamados da própria filial | O mesmo, dentro da filial |
| SUPER_ADMIN | Chamados de todas as empresas, pelo console | Atribuir, mudar situação e prioridade, responder, gerir a base de conhecimento |

Empresa, filial, usuário, perfil e contato do solicitante vêm sempre da autenticação. `companyId`, `branchId` e `userId`
enviados pelo frontend não são aceitos (o schema de criação é `.strict()`). Toda leitura do SUPER_ADMIN sobre chamado de
empresa é explícita e auditada (`LEITURA_PELA_PLATAFORMA`).

## Chamado

- Campos obrigatórios: assunto (3–160), módulo, tipo, descrição (mínimo 10). Opcionais: prioridade (padrão Normal),
  anexos, contexto.
- Valores de módulo, tipo, prioridade e situação vêm do catálogo do servidor (`GET /api/support-kb/catalog`,
  `support-catalog.ts`); o frontend não inventa valor.
- Número do chamado: sequência global a partir de 1000.
- Situações: ABERTO, EM_ANALISE, AGUARDANDO_USUARIO, AGUARDANDO_SUPORTE, RESOLVIDO, ENCERRADO.
- Resposta do suporte leva o chamado a "Aguardando você" (ou à situação escolhida pelo suporte). Resposta da empresa leva
  a "Aguardando suporte"; num chamado ainda ABERTO ele continua ABERTO. O suporte pode levar o chamado a qualquer
  situação, menos voltar a ABERTO.
- Só quem abriu o chamado o encerra (ENCERRADO). **ENCERRADO é final:** não aceita mensagem nem anexo; a empresa abre
  outro chamado citando o número. Só RESOLVIDO pode ser reaberto (por resposta ou por reabrir → Aguardando suporte).
- Histórico (`support_ticket_events`) e mensagens são append-only: nada é editado nem apagado. Cada mudança de situação,
  prioridade, responsável e anexo gera evento.
- Notificação: só dentro do sistema — contador de não lidos no menu "Ajuda e Suporte" (consulta a cada 60 s).

### Contexto automático

Criar com `context: { screen?, route?, terminal?, entityType?, entityId? }` (`entityType` e `entityId` juntos). O servidor
resolve a entidade dentro do escopo (empresa e filial) do usuário; referência de outra empresa não resolve e é recusada.
Botões "Relatar problema":

| Onde | Contexto enviado |
|---|---|
| PDV (menu lateral) | Tela atual, caixa |
| PDV → Pagamento | Tela "Pagamento", venda, pagamento pendente, caixa |
| Admin Web → Ordem de serviço | OS |
| Admin Web → Garantia da OS | Garantia |
| Admin Web → Cobrança (recebível) | Recebível |
| Admin Web → Pós-venda → Garantia | Garantia |

O "terminal" do PDV é o **caixa** (`Caixa #<número>`): não existe identificador de terminal TEF real hoje.

### Dado sensível

Número de cartão completo (13–19 dígitos com Luhn válido) em assunto, descrição ou mensagem é recusado com
"Não informe número de cartão, senha ou token no chamado…" (`support-sensitive.ts`, testado). Senha, token e segredo
não têm detector automático — a orientação está na tela e o texto não é registrado em log.

## Anexos

PNG, JPG, PDF e log (texto). Até 2 MB cada, 10 por chamado. O tipo é decidido pelos bytes do arquivo (magic bytes), não
pela extensão nem pelo `Content-Type` enviado; executável (MZ, ELF…), HTML e script são recusados. O nome é normalizado.
O conteúdo fica no banco (bytea) sob RLS — sem URL pública. Download só com autorização, como `attachment`, `nosniff` e
`no-store`.

## Base de conhecimento

Artigos e categorias globais (não pertencem a empresa), busca por texto completo em português no Postgres. Só artigos
publicados e categorias ativas aparecem para a empresa. Escrita só pelo SUPER_ADMIN. Sugestão de artigos ao digitar o
assunto nunca bloqueia o envio do chamado.

## API

| Rota | Quem | Conteúdo |
|---|---|---|
| `/api/support` | Empresa autenticada | `tickets` (listar, criar), `tickets/unread-count`, `context`, mensagens, `close`, `reopen`, anexos |
| `/api/support-kb` | Empresa autenticada | `catalog`, `categories`, `articles`, `articles/:slug` |
| `/api/support-admin` | SUPER_ADMIN | `catalog`, `dashboard`, `agents` (leitura), `companies`, `tickets` (listar, detalhe, mensagens, atribuir, situação, prioridade, anexos), `kb/articles` (listar, criar, editar, situação), `kb/categories` (listar, criar, editar) |

Rotas de escrita exigem `Idempotency-Key`. Na criação, `X-Client-Source` (Admin Web, PDV, …) e `X-App-Version` ficam no
chamado.

## Telas

- **Admin Web:** `/dashboard/help` (busca e categorias), `help/articles/[slug]`, `help/tickets` (meus chamados),
  `help/tickets/new`, `help/tickets/[id]`.
- **Super Admin:** grupo "Suporte" no menu — `/dashboard/support` (painel), `tickets`, `tickets/[id]`, `kb`, `kb/new`,
  `kb/[id]`, `categories`, `agents` (somente leitura; a atribuição é feita dentro do chamado).

## Banco

Migração `20260928200000_support_center`: `support_tickets`, `support_ticket_messages`, `support_ticket_attachments`,
`support_ticket_events`, `support_kb_categories`, `support_kb_articles`. RLS com FORCE nas tabelas de chamado; mensagens e
eventos só aceitam inserção. Expurgo de fixture de teste exige `app.audit_purge=on` e `companyId` explícito.

## Provas

- Integração `support.integration.test.ts`: isolamento entre empresas e filiais, adulteração de `companyId`/`branchId`,
  IDOR em chamado e anexo, fluxo completo, anexos, RLS, recusa de cartão.
- Unitários: validação de anexo, detector de cartão, `lib/support.test.ts` (Admin Web), `support-report.test.ts` (PDV).
- Navegador real (Chrome, 2026-10-04): 24/24 — busca, artigo, contexto, botão desabilitado com formulário vazio, recusa
  de cartão, criação, lista, painel e páginas do console, resposta do suporte, badge, resposta e encerramento pela
  empresa, histórico, 390 px sem rolagem horizontal. Sem erro de página e sem resposta 5xx.
- Navegador real, 2º roteiro (2026-10-04): 14/14 — console (criar e renomear categoria, nome curto recusado; criar, validar,
  salvar rascunho, editar, publicar e despublicar artigo; o publicado aparece na busca da empresa) e botão do PDV (texto
  curto e cartão recusados, envio válido abre "Chamado #N" com origem e módulo PDV). Os dados do teste foram removidos.
- Navegador real, 3º roteiro (2026-10-04): 8/9 — botões contextuais em OS e cobrança; os de garantia ficaram sem verificação
  por falta de garantia nos dados de demonstração. Fechado: o `demo:seed` agora cria uma garantia numa OS encerrada da empresa
  Alfa (idempotente) e o teste de navegador cobre "OS → Garantia" e "Pós-venda › Garantias".
- Achado do navegador, corrigido: depois de uma recusa do servidor (ex.: cartão no texto) o PDV reenviava com a mesma
  `Idempotency-Key` e recebia 422, porque a API guarda a resposta 4xx sob a chave. O PDV agora renova a chave após 4xx e a mantém
  sem resposta ou em 5xx. A regra de idempotência da API não mudou (é a mesma dos pagamentos).
- **E2E automatizado no repositório** (`apps/e2e`, 18/18, [README](../../apps/e2e/README.md)): os três roteiros viraram testes
  (Chrome real, desenvolvimento + empresa demo), com provas adversariais — HTML no assunto e script no artigo não executam,
  empresa B não abre o chamado da empresa A (tela e API), duplo clique no PDV cria um chamado só. Tudo que criam leva o prefixo
  `[e2e]` e é removido com `companyId` explícito. Limite: precisam dos servidores no ar, então não rodam no CI.

## Fora do escopo desta entrega

SLA, notificação por e-mail/WhatsApp, avaliação do atendimento, tela de configurações do suporte (não há endpoint),
atribuição e escalonamento automáticos. Ver [ROADMAP](ROADMAP.md).
