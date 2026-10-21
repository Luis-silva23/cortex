# Homologação por perfil (ambiente HML isolado)

Resultado da rodada de homologação feita em um ambiente **isolado** (Postgres 5433, Redis 6390, API 3101, Admin Web 3102),
com usuários de homologação — não a conta demo. Credenciais só em `apps/hml/.hml/` (ignorado pelo git). Scripts em
`apps/hml/`. **Nada de stress pesado roda nesta máquina** (computador corporativo): ver [Limites](#limites-e-o-que-fica-para-outro-ambiente).

## Perfis reais do sistema

Não existe seed de perfis. O que existe é o enum `UserType` (6 tipos) mais perfis granulares criados pela empresa
(`Role` → `Permission`). Ver [matriz de permissões](contracts/permission-matrix.md).

| Perfil de negócio | Como existe de fato | Usuário HML |
|---|---|---|
| Super ADM TI | `SUPER_ADMIN` | `sa` (e-mail + MFA) |
| CEO | `COMPANY_ADMIN` | `ceo.a`, `ceo.b` (MFA) |
| Gerente | `MANAGER` + perfil "HML Gerente" | `gerente.a1`, `gerente.a2`, `gerente.b1` (MFA) |
| Administrativo | `OPERATOR` + perfil "HML Administrativo" (`finance:manage/pay`, `purchases:manage/receive`) | `administrativo.a1` |
| Caixa | `OPERATOR` sem perfil | `caixa.a1`, `caixa.a1b`, `caixa.a2`, `caixa.b1` |
| Balcão | `OPERATOR` sem perfil (**igual ao Caixa**; não há tipo "balcão") | `balcao.a1` (#327) |
| Mecânico | `MECHANIC` | `mecanico.a1` (#328) |
| Visualizador | `VIEWER` | `viewer.a1` (#329) |

Empresa Alfa (2 filiais) e empresa Beta (1 filial). Nenhuma permissão extra foi concedida para facilitar teste.
**[DECISÃO NECESSÁRIA]** Caixa e Balcão são o mesmo `UserType` sem perfil; diferenciá-los é decisão de produto.

## O que cada perfil faz e não faz (provado na API, sem depender da tela)

Gates com permissão (`/api/...`): "pode" = passou do gate; "não" = 403.

| Ação | CEO | Gerente | Administrativo | Caixa/Balcão | Mecânico | Visualizador |
|---|---|---|---|---|---|---|
| Ajustar/movimentar/transferir estoque | pode | pode | não | não | não | não |
| Contas a pagar/receber (criar, pagar, receber) | pode | não | pode | não | não | não |
| Estornar/cancelar financeiro e pagamento | pode | não | não | não | não | não |
| Pedido de compra: criar/receber/devolver | pode | não | pode | não | não | não |
| Pedido de compra: aprovar | pode | pode | não | não | não | não |
| Receber pagamento de OS | pode | não | pode | não | não | não |
| Usuários, perfis, filiais, permissões | pode | não | não | não | não | não |
| Auditoria e políticas (leitura) | pode | pode | não | não | não | não |
| Empresas, backup, observabilidade | não | não | não | não | não | não |
| Caixa, vendas, financeiro | pode | pode | pode | caixa/vendas sim | **não (403)** | só leitura |
| Qualquer escrita (38 rotas de escrita testadas) | pode | conforme perfil | conforme perfil | conforme perfil | conforme perfil | **403 em todas** |

Isolamento: cada um dos 3 perfis novos tentou ler, alterar e apagar registro da empresa B, forjou `companyId`/`branchId` na
query e `X-Company-Id`/`X-Branch-Id` no cabeçalho, e tentou escalar para `COMPANY_ADMIN` — tudo recusado.

## Resultados desta rodada

| Verificação | Resultado |
|---|---|
| Matriz de perfis (`profiles.js`) | 185/185 |
| Perfis novos (`profiles-extra.js`: mecânico, balcão, visualizador) | 118/118 |
| Segurança adversarial limitada (`security.js`) | 79/79 |
| RLS com `companyId` forjado (`rls.js`) | 26/26 |
| Invariantes pós-teste (`invariants.js`) | 45/45 |
| Concorrência de oficina/agenda (`workshop-concurrency.js`) | 29/29 |
| Interface real (Chrome, `ui-profiles.js`), 7 perfis | 350/350 na navegação completa + 41/41 no logout |
| API unit | 933/933 · `tsc` da API limpo |

Interface: login pela tela (com MFA quando há), menu, URL direta de 22 telas, busca, abas, abrir/fechar modal, logout e
"depois do logout `/dashboard` exige login". Telas restritas por perfil mostram "Acesso restrito" ao digitar a URL.

## Falhas encontradas e corrigidas (cada uma com teste que falha no código antigo)

| Achado | Causa | Correção |
|---|---|---|
| Logins simultâneos davam 500 (20 de 25 falhavam) | refresh token inserido com `token: ''` (coluna UNIQUE) antes do update | `auth.service.ts`: id gerado antes, token real em uma única escrita (login e refresh) |
| 400 com texto cru do Prisma e **caminho do disco do servidor** | `translate-errors` só reconhecia `prisma.x.y()`; o cliente de transação (`tx.`) escapava; o campo `details` não passava pela checagem | regex cobre qualquer cliente e caminho de arquivo; `details` incluído; detalhe segue no log do servidor (mascarado) |
| Transação expirada sob saturação virava 400 | `Transaction already closed` (P2028) não era tratada como banco indisponível | vira 503 + `Retry-After` (a transação foi revertida: repetir é seguro) |
| >5 logins **corretos** simultâneos do mesmo IP bloqueavam o IP por 60 min | reserva de tentativa antes de processar; excedente acionava o bloqueio longo | ver abaixo |
| Estoque −1 na última unidade (OS) | corrida entre OS na baixa de peças | travamento da linha do produto (rodada anterior) |
| Usuário excluído mantinha token por até 15 min | token não revogado na exclusão | revogação (rodada anterior) |

### Bloqueio de login por IP — análise e correção

- **Onde:** `apps/api/src/middlewares/advancedRateLimit.ts`. Login: 5 falhas por 15 min, bloqueio de **60 min**. MFA e segunda
  autorização: 3 falhas por 5 min, bloqueio de 30 min. Chave: o **IP** quando ainda não há usuário (login); `user:<id>` quando
  há token. Desbloqueio: **só pelo tempo** (não há desbloqueio administrativo). Mensagem: "Muitas tentativas. Tente novamente em
  60 minutos." Auditoria: `LOGIN_FAILED` por tentativa; o 429 é só log de aplicação.
- **Defeito (corrigido, decisão do usuário):** a reserva era feita antes de processar e só devolvida em sucesso. Com 6+ logins
  corretos ao mesmo tempo, a 6ª reserva passava do limite e bloqueava o IP inteiro por 60 min.
- **Correção:** mesmos limites e mesmo bloqueio, mas agora são dois baldes — **falhas** (só gastas por tentativa que falhou) e
  **reservas em andamento** (curto, sem bloqueio longo). Admite a tentativa só se `falhas + reservas ≤ limite`; logo palpites
  verificados continuam nunca passando do limite (testes antigos de rajada de palpites seguem verdes). O excedente simultâneo
  recebe 429 `TOO_MANY_CONCURRENT_ATTEMPTS` com `Retry-After: 2`. A resposta só é enviada depois de contabilizar a falha.
  Provado ao vivo: 12 logins corretos simultâneos → 5 passam, 7 recebem 429 curto, e o login seguinte funciona (sem bloqueio).
- **Ainda em aberto — decisão necessária (não alterado):**
  1. a API **não define `trust proxy`**: atrás de proxy reverso/balanceador, todos os clientes teriam o IP do proxy e dividiriam
     **um único balde** de login (5 falhas bloqueiam todos por 60 min). Em produção isso precisa ser configurado com a topologia real;
  2. a chave por IP faz uma loja atrás de NAT dividir o balde: 5 senhas erradas de qualquer funcionário bloqueiam todos por 60 min
     (trocar a chave por IP+usuário enfraquece a defesa contra varredura de senhas — é decisão de segurança);
  3. não há desbloqueio administrativo nem alerta no Monitoramento para bloqueios de login.

## Observações (sem alteração)

- **Limite geral de 100 req/min por usuário:** cada navegação no Admin Web faz de 5 a 17 chamadas (em dev o `StrictMode` dobra
  algumas) e a tela de Orçamentos chama `GET /quotes` 12 vezes por carga. Navegando rápido, um Gerente recebeu 429 em 10 telas.
  Reduzir chamadas por tela ou rever o limite é decisão sua.
- **RLS:** as políticas de `refresh_tokens`, `request_logs`, `system_logs` e `permissions` admitem `companyId IS NULL` para
  qualquer empresa; `refresh_tokens` guarda o JWT cru com `companyId` nulo. Opções: guardar hash (SHA-256), preencher `companyId` ou
  restringir a política. **Não alterado** (RLS exige decisão). **[ATUALIZAÇÃO 2026-10-15: corrigido — `refresh_tokens` guarda SHA-256 com `companyId` preenchido e policy sem o ramo nulo (decisão 128); logs e `permissions` com policy estrita (decisão 125).]**
- `isAccessTokenRevoked` libera o acesso se o Redis estiver fora; o JWT assinado é confiado até expirar.
- Lacunas já documentadas: (a falta de `auditLog` em pagamento de OS, importação e backup já foi corrigida; conferido no código em 2026-10-04); CEO altera perfis de sistema;
  Mecânico mexe em estoque e decide orçamento; restauração de backup sem segundo fator.

## Capacidade medida nesta máquina (14 núcleos, tudo junto: gerador, API, Postgres, Redis)

| Nível | Carga | Resultado |
|---|---|---|
| 1 | 20 req/s, 20 usuários | 0 erro, p95 69 ms, 358 vendas e 358 pagamentos conferidos no banco |
| 2 | 60 req/s, 50 usuários | saturou: PostgreSQL ~94% de CPU, API ~325%, 132 respostas 503, p95 10,9 s; invariantes 45/45 |
| 3 a 5 | — | **não executados** (computador corporativo) |

O primeiro gargalo observado foi o **PostgreSQL** (CPU) com a API logo atrás; sob saturação o sistema degradou para 503 com
`Retry-After` e **não** corrompeu dados. Esses números valem só para esta máquina e **não** são capacidade de produção.

## Ferramentas HML: processos filhos e trava de carga

Incidente: o amostrador de carga (`sampler.js`) tinha um laço infinito que criava cerca de 5 processos de console por ciclo
(`netstat` ×3, `powershell`, `psql`) sem `windowsHide`, e o `load.js` só o encerrava no caminho de sucesso — no Windows, filho de
console criado por processo sem console abre janela própria, e dezenas de janelas de CMD/PowerShell apareceram. Regras agora:

- todo processo filho das ferramentas passa por `apps/hml/lib/proc.js`: oculto (`windowsHide`), com prazo e com orçamento de
  processos por execução (`HML_MAX_SPAWNS`, padrão 400); só os daemons do `infra.js` (Postgres, Redis, API) usam `spawn` direto,
  sempre `detached` + `windowsHide`;
- filhos de longa duração (`spawnTracked`) morrem na saída, em Ctrl+C, SIGTERM, SIGHUP e erro não tratado; o amostrador ainda sai
  sozinho se o pai morrer, se o canal IPC fechar ou após 15 min (máx. 30), roda no mínimo a cada 5 s e usa 1 `netstat` por ciclo;
- **carga está travada**: `load.js` e `sampler.js` recusam executar enquanto existir `apps/hml/LOAD_DISABLED` e sem
  `HML_ALLOW_LOAD` com a frase de confirmação. Em outra máquina, remover o arquivo e definir a variável;
- o teste `apps/api/src/hml-tooling.guard.test.ts` falha se alguém voltar a usar `child_process` direto, remover o `windowsHide`,
  reintroduzir laço infinito no amostrador ou tirar a trava.

Os hooks do plugin ECC rodam em quase toda chamada de ferramenta (dezenas de milhares de `node` curtos numa sessão longa); isso é
configuração do usuário fora do repositório e não foi alterado.

### Ajustes de 2026-10-04 (rodada do grupo A)

- `infra.js start`/`init`/`start-pg` esperam o Postgres **aceitar consultas** (`pg_isready`), não só a porta abrir; o Postgres HML sobe com **log por padrão** em `apps/hml/.hml/pg-hml.log` (gitignorado).
- `tests/rls.js` distingue **banco indisponível** (sai com 2 e diz "BANCO HML INDISPONÍVEL") de **banco disponível sem tabelas** (sai com 2 e manda aplicar as migrações) e nunca mais quebra com `FROM () x`.
- A API HML sobe com `connect_timeout=30&pool_timeout=30` no `DATABASE_URL`: com o pool frio, o painel abre ~30 conexões de uma vez e, neste computador, isso passava dos 5 s do Prisma (503 `P1001` com o banco de pé).
- `tests/ui-evidence.js`: falha na hora com o texto do erro de login, espera os cartões do painel (sem `animate-pulse`), nunca sobrescreve captura (sufixo de execução) e ganhou as frentes `errors`, `dashboard` e `dashboard-demo`. Para capturar telas use `next build` + `next start` (`NEXT_BUILD_CPUS=2`), não `next dev`.
- `tests/payments.js` fecha qualquer caixa aberto do operador antes de abrir o seu (o caixa 71 da evidência do PDV a travava).
- Rodada: `profiles` 185/185, `profiles-extra` 121/121, `payments` 37/37, `rls` 26/26, `invariants` 45/45. **Não repetidas de propósito:** `security` (força bruta), `concurrency` e `workshop-concurrency` (rajadas simultâneas) e `ui-profiles` (navegação longa), por serem testes de pressão ou pesados para este computador.

## Limites e o que fica para outro ambiente

- **Não executado aqui, de propósito:** níveis 3 a 5 de carga, brute force massivo, flood, resiliência com queda de API/Redis/Postgres,
  carga de Redis lento. Devem rodar em outra máquina/ambiente controlado.
- **Não executado nesta rodada:** a suíte de integração completa (precisa do Postgres e Redis de desenvolvimento, parados) — ficou
  coberta pelas suítes HML acima e pelo teste de regressão do refresh token, que passou antes desta rodada de documentação.
  Interface do PDV e do Super Admin pelo navegador também não foram percorridas (só o Admin Web).
- **Dependência externa:** só existe o provedor de pagamento MANUAL; timeout/5xx/desconhecido são provados com provedor falso nos
  testes de integração. Falta um TEF/PSP real para homologação de pagamento.
