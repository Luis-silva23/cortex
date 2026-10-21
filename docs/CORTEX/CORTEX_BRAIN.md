# CÓRTEX — Lógica de Negócios

Sistema de gestão para lojas e oficinas de motos, multiempresa e multifilial: balcão e PDV, oficina (orçamento → OS →
entrega), estoque, compras, financeiro, fiscal, pós-venda (revisões, contato, agenda), Dashboard gerencial, a **base** de canais de
venda (módulo `CANAIS`, sem integração real) e a operação da plataforma (empresas, licenças, dispositivos, monitoramento, backup).
O que está implementado, parcial, preparado ou pendente: [MAPA_DE_ESTADO](MAPA_DE_ESTADO.md). Próximas fases: [ROADMAP](ROADMAP.md#sequência-oficial-de-evolução). Nome do produto: **CÓRTEX — Lógica de Negócios**; "LN System"
continua em nomes técnicos (pacotes `@ln-system/*`, bundle ids) por decisão do dono (ver [DECISIONS](DECISIONS.md)).

## Quem usa o quê

| Perfil | App | Faz |
|---|---|---|
| Super Admin (plataforma) | Super Admin (web) | empresas, licenças, dispositivos, saúde/alertas, limites de monitoramento, backup, auditoria |
| Administrador da empresa, gerente | Admin Web | cadastros, estoque, vendas, OS, orçamentos, financeiro, fiscal, pós-venda, usuários, módulos, importação |
| Operador de caixa | PDV (Electron) | venda, pagamento, caixa, devolução, sangria |
| Atendente de balcão / oficina | **Balcão** (`apps/balcao`) e Admin Web | cliente, veículo, produto/disponível, orçamento → OS, encaminhar ao caixa (não cobra) |
| Mecânico | App mobile e Admin Web (oficina) | agenda, OS da filial |
| Painel da oficina | App de TV | agenda do dia e OS em andamento |

## Regras que nunca se quebram

1. **Isolamento empresa/filial pelo banco.** Toda tabela de empresa tem RLS com `FORCE`; a aplicação só confirma. Nunca
   confie em `companyId`/`branchId` vindos do corpo, da query ou de cabeçalho — o token manda
   ([contracts/tenant-branch-scope](contracts/tenant-branch-scope.md)).
2. **A API decide a permissão.** Esconder botão na tela é conforto; o bloqueio é da API
   ([contracts/permission-matrix](contracts/permission-matrix.md)).
3. **Não inventar regra comercial nem fiscal.** O que não está definido vira `[DECISÃO NECESSÁRIA]` em
   [DECISIONS](DECISIONS.md), e o código faz o comportamento mais conservador e honesto (ex.: PIX sem provedor fica
   pendente; pagamento aprovado com a venda encerrada vira exceção, não é recusado nem apagado).
4. **Nada de sucesso fingido.** Sem provedor, a tela diz que não há provedor; sem rede, diz que a operação **não** foi
   concluída; "sem dados" nunca aparece como "normal".
5. **Dinheiro e estoque só mudam com guarda.** Transições por `updateMany where status` + contagem, lock da venda no
   pagamento, `Idempotency-Key` nas escritas sensíveis. Duplo clique, reenvio e concorrência não duplicam nada.
6. **Segredos cifrados, nunca em texto puro.** MFA e fiscal com `enc:v1` (AES-256-GCM, `DATA_ENCRYPTION_KEY`); a chave
   nunca vai para o repositório nem para logs ([SECURITY](SECURITY.md)).
7. **Português para quem opera.** Toda mensagem de erro chega em PT-BR; texto técnico (Prisma, Zod, pilha) nunca chega à
   tela.
8. **Auditoria só cresce.** `audit_logs` é append-only; campos sensíveis são mascarados antes de gravar.
9. **PostgreSQL é a fonte da verdade; o CÓRTEX é a autoridade dos dados de negócio.** Redis é cache e apoio (sessões, limites, filas),
   nunca guarda estado de negócio. Integração externa (site, iFood, marketplace) é canal de entrada e saída: não é fonte da verdade, não
   acessa o banco e **não cria banco paralelo**. Pedido externo não é venda, pagamento nem baixa de estoque até uma conversão deliberada
   ([CANAIS](CANAIS.md)). Decisão do dono de 2026-10-05.

## Como trabalhar no código

- Mapa: [CODE_MAP](CODE_MAP.md). Arquitetura: [ARCHITECTURE](ARCHITECTURE.md). Estado atual: [CURRENT_STATE](CURRENT_STATE.md).
- Rota em `apps/api/src/routes/<x>.routes.ts` → regra em `apps/api/src/services/<x>.service.ts`.
- `packages/database` é consumido compilado: depois de mudar o schema, `prisma migrate deploy` + `prisma generate` +
  `npm run build` no pacote. `packages/shared`: `npx tsc` depois de mudar validadores.
- Testes: unitários ao lado do código; integração em `apps/api/test/integration/` contra Postgres/Redis **reais** num
  banco dedicado (`lnsystem_test`) com trava contra limpeza sem escopo. Comandos em [CODE_MAP](CODE_MAP.md#testes-como-rodar).
- Correção de defeito = teste que falha no código antigo e passa no novo. Não remova teste porque revelou bug; não
  aumente timeout para passar.
- Marcações usadas nos documentos: **[CORRIGIDO]**, **[VERIFICADO]** (reproduzido de verdade), **[RELATO]** (não
  reproduzido — não é fato), **[DECISÃO NECESSÁRIA]**, **[LIMITAÇÃO]** (depende de algo que não existe neste ambiente).
- Ambiente local de desenvolvimento, portas e bancos: [VISUAL_REFERENCES](VISUAL_REFERENCES.md#mapa-de-portas--uma-porta-por-frontend).
