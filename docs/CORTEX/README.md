# Documentação do CÓRTEX — índice

Toda a documentação do produto fica aqui. Comece por [CORTEX_BRAIN](CORTEX_BRAIN.md).

| Documento | Para quê |
|---|---|
| [CORTEX_BRAIN](CORTEX_BRAIN.md) | Ponto de entrada: o que é o produto, regras que nunca se quebram, como trabalhar no código. |
| [CURRENT_STATE](CURRENT_STATE.md) | O que existe e funciona hoje (estado de 2026-10-05), com números de teste e a data de cada um, e limites conhecidos. |
| [ARCHITECTURE](ARCHITECTURE.md) | Monorepo, apps, pacotes, caminho de uma requisição, filas, adaptadores, monitoramento. |
| [CODE_MAP](CODE_MAP.md) | Onde está cada responsabilidade (arquivo, dependências, segurança, testes). |
| [BUSINESS_RULES](BUSINESS_RULES.md) | Regras de negócio vigentes (o que o código faz) e as que dependem de decisão. |
| [POLICIES](POLICIES.md) | Políticas configuráveis por empresa/filial (catálogo, origem, motivo, histórico) e o índice de [policies/](policies/) por área: desconto, caixa, fiscal, PDV, orçamento, agenda, garantia, oficina, cliente, convênios, financeiro, cobrança, comissão. |
| [DECISIONS](DECISIONS.md) | Decisões tomadas (com data e motivo) e decisões pendentes `[DECISÃO NECESSÁRIA]`. |
| [ROADMAP](ROADMAP.md) | A **sequência oficial** (Fases 1 a 5: Commerce API, reserva de estoque, integrações reais, produção, auditoria dos processos), o que falta antes de produção, dependências externas, próximos passos. |
| [DASHBOARD_GERENCIAL](DASHBOARD_GERENCIAL.md) | Dashboard gerencial (Administrador e Gerente): o que o código faz hoje, regra única de período, KPIs, API, segurança. Base do Manual. |
| [DASHBOARD_GERENCIAL_VARREDURA](DASHBOARD_GERENCIAL_VARREDURA.md) | Varredura de 2026-10-04 que antecedeu o painel (87 indicadores, decisões 60–81). Histórico. |
| [CANAIS](CANAIS.md) | Canais de venda: **base arquitetural** (módulo `CANAIS`, canal, pedido externo, gateway). Sem integração real. |
| [COMMERCE_API](COMMERCE_API.md) | Desenho das decisões 82 a 92 (Commerce API, reserva, pedido → venda, pagamento externo, cancelamento, sincronização, fulfillment, falha de provedor) e, na §0, **o que as Fases 1 e 2 já implementou** (2026-10-05). As regras comerciais seguem pendentes. |
| [PRODUCAO](PRODUCAO.md) | Runbook de produção: topologia, variáveis de ambiente (e a validação da partida), banco/migrações, sondas de saúde e desligamento ordenado, deploy, rollback, backup (RPO/RTO), observabilidade, CI e checklist de go-live. **Nada executado em produção.** |
| [DIAGNOSTICO_PRODUCAO](DIAGNOSTICO_PRODUCAO.md) | Diagnóstico independente de prontidão para produção (Fase 4): o que foi auditado, corrigido e provado, o que depende de infraestrutura ou de decisão do dono, pendências P0 a P3 e o veredito. |
| [INTEGRATION_GATEWAY](INTEGRATION_GATEWAY.md) | Integration Gateway (Fase 3): contrato genérico de provedor, webhook assinado idempotente, consulta periódica, caixa de saída com retentativa, política de falha, segurança e como implementar um provedor real. |
| [commerce-api.openapi.yaml](commerce-api.openapi.yaml) | Contrato OpenAPI da Commerce API (`/commerce/v1`): autenticação por assinatura, recursos, erros. |
| [SECURITY](SECURITY.md) | Autenticação, MFA, isolamento, permissões, segredos (`DATA_ENCRYPTION_KEY`), auditoria, limites. |
| [DATABASE](DATABASE.md) | Migrações, RLS, livro de estoque, backup e restauração. |
| [BANCO_DE_DADOS](BANCO_DE_DADOS.md) | Inventário das 107 tabelas (finalidade, relacionamentos, RLS), migrações por ambiente, diferenças conhecidas entre schema e banco, lacunas por decisão e o que falta para staging/produção. |
| [MAPA_RELACIONAMENTOS](MAPA_RELACIONAMENTOS.md) | Mapa de relacionamentos do banco: cadeias empresa → filial → usuário → produto → estoque → venda → caixa → compra → pagamento, todas as FKs (com a regra ao apagar), relações só lógicas (sem FK) e diagramas Mermaid por domínio. Gerado do catálogo. |
| [RELATORIO_MIGRATIONS](RELATORIO_MIGRATIONS.md) | As 57 migrations: ordem de execução, finalidade, tabelas e estruturas afetadas, aplicação por ambiente (dev, teste, staging/produção), checksums e divergências; prova de reaplicação do zero. Gerado. |
| [REVISAO_BANCO_PENDENCIAS](REVISAO_BANCO_PENDENCIAS.md) | Revisão do banco: registro de achados (A/B/C, D-01…D-11, E-01…E-05) com estado **corrigido / pendente de decisão / pendente de infraestrutura**, o que foi implementado, testado e o que precisa de validação externa; achados automáticos do catálogo. |
| [RELATORIO_EXECUCAO_REVISAO_BANCO](RELATORIO_EXECUCAO_REVISAO_BANCO.md) | Relatório de execução da correção completa do banco (2026-10-14/15): o que foi implementado por prioridade, arquivos, migrations, comandos, **falhas encontradas e correções** (falha → causa → correção → prova), pendências e garantias. |
| [revisao-banco/](revisao-banco/LEIA-ME.md) | Pacote de revisão: cópia do `schema.prisma` e das migrations (com SHA-256), diff schema × banco, resultado da reaplicação do zero e dos 4 cenários com dado, prova dos papéis dono × execução e resultados de teste. Só estrutura e números. |
| [BACKUP_RECUPERACAO](BACKUP_RECUPERACAO.md) | Backup e recuperação de desastre: estratégia (dump diário 00:00 + verificação 12:00 sem novo dump + WAL/PITR), retenção, cifragem, custo, execução real do `backup.sh`, ensaio de restauração (21 verificações), PITR em laboratório, RPO/RTO **propostos e pendentes de aprovação**. |
| [RLS_CONTEXTO_ASSINADO](RLS_CONTEXTO_ASSINADO.md) | **Contexto de RLS assinado (decisão 151):** o risco de "SQL arbitrário na conexão da API escolher o contexto", como o banco confere a assinatura, o que isso garante, o que **não** garante (risco residual), rotação, restauração e rollback. |
| [RELATORIO_SEGURANCA_PRODUCAO_2026-10-15](RELATORIO_SEGURANCA_PRODUCAO_2026-10-15.md) | **Relatório da missão de segurança e liberação:** matriz de permissões, evidências (autorização, RLS, backup, PITR, alertas, anonimização), o que foi executado × o que é só código × o que depende de infraestrutura, riscos residuais, aprovações e procedimento de implantação/reversão. |
| [RELATORIO_MISSAO_MESTRA_2026-10-18](RELATORIO_MISSAO_MESTRA_2026-10-18.md) | **Relatório mestre da missão de finalização e lançamento comercial:** 17 itens, cada um com estado inequívoco (comprovado / não validado no ambiente real / bloqueado por dependência externa / não implementado), artefatos gerados com hash, deploy e rollback, pendências, riscos e checklist de abertura. |
| [ESTADO_ATUAL_MISSAO_MESTRA](ESTADO_ATUAL_MISSAO_MESTRA.md) | **Documento vivo da missão mestra de 2026-10-18:** inventário real de cada componente (API, Admin Web, Super Admin, Balcão, PDV, apps Android, banco, backup, infraestrutura), integrações, artefatos gerados com hash e bloqueios — cada linha com um estado inequívoco. |
| [PREPARACAO_COMERCIAL](PREPARACAO_COMERCIAL.md) | Primeira venda: o que o cliente recebe, roteiro de entrega de uma empresa (testado), suporte, suspensão/cancelamento sem perder dado, documentos legais (minutas) e as **decisões que só o proprietário toma** (planos, cobrança, fiscal, SLA). Nada de preço, plano ou prazo legal foi inventado. |
| [DISTRIBUICAO_APLICATIVOS](DISTRIBUICAO_APLICATIVOS.md) | Como construir, assinar, instalar e atualizar cada aplicativo (PDV Windows, apps Android mecânico/TV, web); estado real de cada artefato e o que impede entregar ao cliente. |
| [RELATORIO_FINALIZACAO_PRODUCAO](RELATORIO_FINALIZACAO_PRODUCAO.md) | Relatório da finalização de produção (2026-10-16): regra de acesso por empresa/filial (matriz por perfil), migrações 51–52, PostgreSQL, homologação, backup/restauração, testes, bloqueios que permanecem e integridade do pacote. |
| [FRONTEND](FRONTEND.md) | Admin Web, Super Admin e PDV (web/Electron). |
| [MOBILE](MOBILE.md) | App do mecânico/equipe (Expo). |
| [ANDROID_TV](ANDROID_TV.md) | Painel de oficina para TV (Expo Android TV). |
| [VISUAL_REFERENCES](VISUAL_REFERENCES.md) | Quadro de marca, identidade de cada app, portas, bancos de dev/teste (guardado por teste). |
| [SUPPORT](SUPPORT.md) | Central de Ajuda e Suporte: chamados, base de conhecimento, contexto automático, limites. |
| [HML_HOMOLOGACAO](HML_HOMOLOGACAO.md) | Homologação por perfil em ambiente isolado (`apps/hml`): perfis, resultados, bloqueio de login, ferramentas e trava de carga. |
| [RELATORIO_MESTRE_2026-10-04](RELATORIO_MESTRE_2026-10-04.md) | **Histórico (2026-10-04).** Relatório mestre das Fases 1–11: o que foi feito, corrigido, o que segue errado, decisões e correções necessárias. Com aviso do que mudou depois. |
| [MAPA_DE_ESTADO](MAPA_DE_ESTADO.md) | **Mapa de estado por área, atualizado em 2026-10-05** (✅ implementado · 🟡 parcial · 🧱 preparado · 🔴 pendente · 🔵 decisão pendente · 🟣 produção/externo), com Dashboard, Canais, Comissão, Produção e testes separados por data. |
| [AGENTES](AGENTES.md) | Levantamento dos agentes de desenvolvimento (ferramentas externas; não fazem parte do produto). |
| [DIAGNOSTICO_FASE6](DIAGNOSTICO_FASE6.md) | Diagnóstico da queda do Postgres HML e do 503 no login durante a homologação visual. |
| [CONSOLIDACAO_FINAL](CONSOLIDACAO_FINAL.md) | Consolidação final (2026-10-14): sessão do operador no PDV Desktop e no Balcão (logout, fechamento, reinício, queda, bloqueio de tela), instalação do PDV, PDV e Balcão no mesmo computador, parcelamento (o que existe e o que falta), inventário de conectores, pendências de produção e afirmações comprovadas × não verificadas. |
| [AUDITORIA_FINAL_2026-10-14](AUDITORIA_FINAL_2026-10-14.md) | Auditoria final com Playwright (Balcão, Web/Admin, Super Admin, PDV): fluxos executados, defeitos corrigidos, decisão 108 (token e CSP), códigos de barras, fiscal legado, quadro das decisões 109 a 117 e o que não foi executado. |
| [../privacidade/](../privacidade/README.md) | LGPD técnica: políticas (privacidade, segurança, acesso, retenção), titulares e incidentes, inventário de dados e fornecedores, cláusulas e RIPD. **Minutas sem revisão jurídica.** |
| [../ajuda/](../ajuda/CENTRAL_DE_AJUDA.md) | Central de Ajuda da loja: artigos operacionais em texto (publicados por `npm run help:seed`). |
| [AUDITORIA_PRODUTO](AUDITORIA_PRODUTO.md) | Lacunas de produto levantadas em 2026-10-04 (canais externos de venda, fiscal, LGPD e demais), com a atualização de 2026-10-05 sobre o que virou base preparada. |
| [CHANGELOG](CHANGELOG.md) | O que mudou, rodada a rodada, com commits. |
| [FINAL_ACCEPTANCE](FINAL_ACCEPTANCE.md) | Critérios objetivos de aceite por área, com teste, evidência e situação. |
| [contracts/](contracts/) | Contratos normativos: permissões, escopo empresa/filial, máquinas de estado, módulos/licença, auditoria. |
| [historico/](historico/) | Documentos antigos mantidos integralmente (não descrevem o estado atual). |
| ../evidencias/ (evidência arquivada fora do repositório publicado: `docs/evidencias/README.md`) | Capturas e relatórios de prova, por rodada. |

## Caminhos antigos

Arquivos que o código, as migrações já aplicadas (imutáveis) ou documentos antigos ainda citam pelo caminho anterior:

| Caminho antigo | Onde está agora |
|---|---|
| `docs/tech-debt.md` | [historico/registro-de-auditoria-2026-09-14-a-25.md](historico/registro-de-auditoria-2026-09-14-a-25.md) (integral); itens vigentes em DECISIONS e ROADMAP |
| `docs/CODE_MAP.md` | [CODE_MAP.md](CODE_MAP.md) |
| `docs/contracts/*.md` | [contracts/](contracts/) (mesmos nomes) |
| `docs/migracoes-e-rls.md` | [DATABASE.md](DATABASE.md) |
| `docs/identidade-e-ambiente.md` | [VISUAL_REFERENCES.md](VISUAL_REFERENCES.md) |
| `MFA_EXPLICACAO.md`, `MFA_INTEGRACAO.md`, `RESUMO_EXECUTIVO.md` (raiz) | [historico/](historico/) com sufixo `-original` — desatualizados; MFA atual em [SECURITY](SECURITY.md#mfa) |
| `docs/ln-system/*` (citado em comentários antigos) | nunca esteve no repositório; as referências foram removidas do código |
