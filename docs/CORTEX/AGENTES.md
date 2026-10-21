# Agentes e orquestração no desenvolvimento do CÓRTEX

Recuperação de 2026-10-04 (Fase 4). Trata de **como o trabalho de desenvolvimento é dividido entre agentes de IA**, não de
funcionalidade do produto. (A "autorização" do produto — autorizador no PDV, dupla autorização — está em
[permission-matrix](contracts/permission-matrix.md) e [SEGURANCA-PDV](policies/SEGURANCA-PDV.md).)

**Escopo (esclarecido pelo dono em 2026-10-04):** este documento é só um levantamento. Os agentes são ferramentas externas de desenvolvimento e homologação
(Claude Code/ECC) e **não fazem parte do CÓRTEX**; não se cria arquitetura de agentes, `.claude/`, hooks ou skills como requisito do produto. A arquitetura definitiva
deles será decidida depois, se necessário; a "proposta" abaixo não está em vigor.

Princípio dos briefs do dono: **resultado > quantidade de agentes**; 0 agentes se não houver ganho, 1 se houver tarefa
especializada, 2 ou mais só com trabalho realmente independente; nada de agentes/skills "para parecer complexo"; agentes não
sobrescrevem trabalho um do outro; o agente principal revisa e integra; **nenhum agente declara o CÓRTEX finalizado sozinho**.

## O que existe (verificado em 2026-10-04)

| Item | Situação |
|---|---|
| Agentes definidos **no repositório** | **Nenhum.** Não há `.claude/`, `CLAUDE.md` nem `AGENTS.md` na raiz, e o Git nunca teve esses arquivos |
| Agentes disponíveis na máquina | Plugin ECC 2.2.1 (instalado no usuário, fora do repositório): 68 agentes genéricos (revisores de TypeScript/React/banco/segurança, `e2e-runner`, `tdd-guide`, `architect`, `planner`, `build-error-resolver`, `performance-optimizer`, `doc-updater`…), 292 skills, 94 comandos, mais `Explore`, `Plan` e `general-purpose` |
| Agente específico de PDV | **Não existe.** Conhecimento do PDV fica em [PDV](policies/PDV.md), [SEGURANCA-PDV](policies/SEGURANCA-PDV.md), nos testes (`payment-flow`, `cash-*`, `discount-cash-fiscal-policies`) e em `apps/e2e` |
| Agente de privilégios/autorização | **Não existe.** Existem controles pontuais, listados abaixo |
| Orquestração | Só a manual: o agente principal (esta sessão) decide caso a caso quando chamar subagentes. Sem registro, fila, papéis fixos nem protocolo de comunicação |
| Memória do dono (fora do repositório, por máquina e usuário) | `feedback_autonomous_audit_loop`, `feedback_no_cmd_powershell_tests`, `project_cortex_brand_and_master_brief`, `reference_dev_environment` |

### Histórico de agentes (reconstruído)

Rodadas anteriores usaram subagentes avulsos por especialidade (os briefs citam 5: arquitetura, segurança, backend, frontend,
banco/QA/UX conforme a rodada). Nenhum deixou definição persistente. O que sobrou são os **relatórios** incorporados aos
documentos: "agente 5" (PDV, rodada de 2026-09-27), "agente de caixa", "agente de descontos", agentes "pdv" e "design"
(registro de auditoria §E–H). Estes continuam úteis como fonte, e as pistas deles marcadas **[RELATO]** não são fato até serem
reproduzidas. O brief de 2026-09-27 já dizia para **não recriar automaticamente** os 5 agentes anteriores.

## Controles de autorização/validação que já existem

| Controle | Onde | O que faz | O que **não** faz |
|---|---|---|---|
| Modo de permissão do Claude Code | harness do usuário | pede aprovação a comandos e edições conforme o modo escolhido | não conhece regra do CÓRTEX |
| GateGuard (ECC) | hooks `PreToolUse` | exige declarar fatos antes da primeira edição/criação de arquivo e antes de Bash destrutivo | é portão de qualidade, **não** de autorização; passa com qualquer texto |
| Trava de carga HML | `apps/hml/LOAD_DISABLED` + `HML_ALLOW_LOAD` | impede `load.js`/`sampler.js` nesta máquina | só cobre as ferramentas HML |
| `lib/proc.js` + guard test | `apps/hml`, `hml-tooling.guard.test.ts` | processos filhos ocultos, com prazo e limpeza | só cobre `apps/hml` |
| Trava de limpeza dos testes de integração | suíte de integração | impede apagar dados sem escopo no banco de desenvolvimento | só cobre os testes |
| Papel do banco sem `BYPASSRLS` | Postgres/RLS FORCE | a aplicação não vê dado de outra empresa | não restringe quem opera o banco |

## Lacunas

1. **As regras do dono não acompanham o subagente.** Subagentes não herdam a conversa. As regras "nada de stress/CMD/PowerShell
   em massa neste computador", "não alterar RLS/RBAC/limite de login/MFA/sessão sem decisão" e "não commitar segredo" estão no
   chat e na memória do usuário; só `CORTEX_BRAIN` cobre as regras do produto. Não há um texto único que todo agente receba.
2. **Não há protocolo de operação privilegiada.** Nada define quais alterações exigem autorização humana nem como ela é pedida
   e registrada; hoje depende do agente principal lembrar.
3. **Sem rastro do que cada agente fez.** Relatório de subagente não é guardado; só o que o agente principal copia para os
   documentos fica.
4. **Sem agente de PDV.** Aceitável hoje: o PDV está homologado e coberto por testes e e2e; o ganho de um agente fixo seria
   pequeno. Só passa a valer se vierem trabalhos paralelos e recorrentes no PDV.
5. **Custo dos hooks.** Os hooks do ECC rodam em quase toda chamada de ferramenta e criam processos `node` curtos. Não é
   defeito do projeto; é configuração do usuário (fora do repositório) e pesa em máquina corporativa.

## Modelo recomendado (PROPOSTA — não vigente até o dono aprovar)

Manter a orquestração **dinâmica e sem agentes permanentes**. O agente principal é o orquestrador e o único que integra,
commita e declara fim de fase. Papéis são **chamados por tarefa**, usando os agentes que o ECC já oferece; não se criam
definições novas enquanto os genéricos bastarem.

| Papel (conceitual) | Chamar quando | Agente existente que cobre |
|---|---|---|
| PDV | trabalho paralelo e independente no PDV (caixa, venda, pagamento, tela, testes do PDV) | `general-purpose` com o briefing de PDV abaixo; `ecc:e2e-runner` para navegador |
| Segurança/Privilégios | mudança em auth, RBAC, RLS, sessão, MFA, limite de login, segredos, migração | `ecc:security-reviewer` + `ecc:database-reviewer` (somente leitura, parecer) |
| Backend / Frontend | tarefas independentes em `apps/api` e nos apps web | `ecc:typescript-reviewer`, `ecc:react-reviewer`, `ecc:code-reviewer` |
| Banco/RLS | migração, policy, plano de consulta | `ecc:database-reviewer` |
| Testes | cobertura de uma correção, e2e | `ecc:tdd-guide`, `ecc:e2e-runner` |

Regras de uso: só se a tarefa for independente de outra em curso; agente de revisão **não edita**; alterações em arquivos que
outro agente toca são **serializadas**; o orquestrador relê o que foi alterado antes de aceitar; relatório do agente é
tratado como **[RELATO]** até o orquestrador reproduzir.

### Protocolo de operação privilegiada (proposta)

O "agente de privilégios" é, na prática, **uma checagem do orquestrador antes de agir**, com parecer opcional do
`ecc:security-reviewer`. Exigem autorização expressa do dono, citada no registro da mudança:

- alterar RLS, policies, migrações, matriz de permissões, limite/bloqueio de login, MFA, sessão, política de senha;
- conceder permissão a perfil ou papel; apagar, restaurar ou expurgar dados; restaurar backup;
- tocar em segredo, `.env`, `DATA_ENCRYPTION_KEY`, ou nos arquivos do `apps/hml/.hml/`;
- carga, stress, benchmark ou força bruta; iniciar/parar Postgres e Redis fora do fluxo HML;
- `git push`, `reset --hard`, `--force`, e qualquer ação em ambiente que não seja o local.

Sem autorização: o agente **para, descreve a ação e o risco, e registra a pendência**; não tenta caminho alternativo que
produza o mesmo efeito.

### Briefing mínimo para todo subagente (proposta)

Objetivo e arquivos permitidos · "somente leitura" ou "pode editar X" · proibições acima · não rodar teste dinâmico nem abrir
CMD/PowerShell sem o orquestrador pedir · não afirmar teste não executado · devolver: o que leu, o que achou (com arquivo e
linha), o que alterou, o que **não** verificou.

## Evolução somente se necessária

Os itens abaixo **não** foram feitos; ficam para decisão do dono:

1. Criar um `CLAUDE.md` na raiz que aponte para [CORTEX_BRAIN](CORTEX_BRAIN.md) e carregue as proibições acima, de modo que
   toda sessão e todo subagente do repositório as recebam. É a única mudança que resolve a lacuna 1 e custa uma página.
2. Reduzir os hooks do ECC nesta máquina (configuração do usuário).
3. Criar definição de agente de PDV só se surgirem frentes paralelas recorrentes no PDV (hoje não há).
