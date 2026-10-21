# Diagnóstico — Fase 6 interrompida (2026-10-04)

A Fase 6 (homologação visual) foi pausada no meio da frente Admin Web, foi investigada de forma isolada (seção "Resultado da investigação
isolada", no fim) e retomada só no que faltava. Todo o ambiente foi encerrado (portas 3002, 3101, 5433 e 6390 livres). Dos dois problemas, **um defeito
real de código foi corrigido** (classificação do erro de banco no login, seção "Correção aplicada"); a queda do Postgres **não foi reproduzida**.

## Linha do tempo (hora local; o `bash-commands.log` registra o comando ao terminar)

| Hora | Fato | Fonte |
|---|---|---|
| ~16:38:50 | `infra.js start` sobe Postgres HML (5433) e Redis HML (6390) | `~/.claude/bash-commands.log` |
| 16:39:06 | API HML sobe (`dist` recém-compilado) | `apps/hml/.hml/api.log` |
| ~16:39:25 | Next dev do Admin Web pronto na 3002 | `scratchpad/admin-dev.log` |
| 16:39:44–16:40:18 | `ui-evidence.js` (Chrome headless) captura CEO e Visualizador, tudo 200 | API log, PNGs |
| **16:40:15.766** | **último COMMIT** gravado no Postgres antes do evento | WAL (`pg_waldump`) |
| **16:40:23** | `POST /api/auth/login` do Mecânico → **503**; `Failed to write failed-login audit` (P1017); job de métricas `jobId 47` falha duas vezes com `Server has closed the connection` | API log, linhas 33929–33956 |
| 16:41:00 | primeiro COMMIT depois do evento (job `evaluate-health`); a API se recuperou sozinha, sem reiniciar | WAL, API log |
| 16:42:23 | o script desiste (`waitForURL` de 120 s) e grava `notas-admin.json` | log do script |
| 16:47:57 | `api-stop` e `infra.js stop` | `bash-commands.log` |

Nenhum comando meu estava rodando entre 16:40:15 e 16:41:00, exceto o próprio `ui-evidence.js`.

## Problema 1 — `POST /api/auth/login` do Mecânico retornou 503

**É o mesmo evento do problema 2**, visto pelo login. A cadeia no código:

1. `auth.service` → `prisma.user.findUnique` falhou com P1017.
2. `auth.routes.ts:104` registra `Failed login attempt` para **qualquer** erro.
3. `auth.routes.ts:115` classifica o erro como "conhecido" por **regex sobre `error.message`** (`/Credenciais inválidas|Conta desativada|Conta bloqueada/`).
   A mensagem do Prisma inclui o **trecho do código-fonte** (`110 throw new Error('Credenciais inválidas')`), então casou. Por isso o log
   mostra a tentativa de `recordFailedLogin` (que também falhou: P1017).
4. A resposta virou 503 porque `translate-errors` reconhece "Server has closed the connection" como banco indisponível (`DB_UNAVAILABLE_RE`).
   Ou seja, o 503 é o **comportamento previsto** para banco fora; o defeito está na causa, não na resposta.

Evidência de que o limitador **não** puniu o usuário: `FAILED_ATTEMPT_STATUSES = {400,401,403,404,422,423}` (`advancedRateLimit.ts:79`) não contém 503.
Verificado depois: o limitador conta no `res.end` com o status final, já traduzido para 503, portanto não contou.

**Causa provável do 503:** o Postgres HML foi interrompido naquele instante (ver problema 2).
**Achado secundário (risco, não corrigido):** a classificação por regex no texto da mensagem pode tratar um erro de banco como falha de credencial e tentar gravar
`LOGIN_FAILED` falso se o banco estiver de pé e só a consulta falhar. Investigar com teste que simule um erro do Prisma cujo texto contenha o trecho.
**Achado do script:** `ui-evidence.js` não lê a mensagem de erro da tela; esperou 120 s por `/dashboard` em vez de falhar na hora.

## Problema 2 — Prisma P1017 "Server has closed the connection"

**Evidência do banco (leitura do WAL, sem iniciar nada):**
- Entre o último COMMIT (16:40:15.766) e o primeiro seguinte (16:41:00) há um `CHECKPOINT_SHUTDOWN` (LSN `0/090D9408`) e só 14 registros no total.
- Depois dele, o `NextXID` avança só 7 vezes até o desligamento final: os 7 commits por minuto do `evaluate-health`.
- Não há `END_OF_RECOVERY` no segmento (esse registro só existe em promoção) e o `CHECKPOINT_ONLINE` seguinte é das ~16:45, longe do evento.
- O Redis HML **não** apareceu em erro: só o Postgres foi interrompido. A API continuou viva e reconectou.

**O que o `CHECKPOINT_SHUTDOWN` significa (conhecimento do PostgreSQL, não verificado aqui):** ele é gravado em desligamento limpo **e também no fim da recuperação
após uma queda** (o checkpoint de fim de recuperação usa o mesmo tipo de registro).

**Hipóteses, da mais para a menos provável:**

| # | Hipótese | A favor | Contra / falta |
|---|---|---|---|
| A | Um processo servidor do Postgres caiu e o postmaster **reiniciou todos os processos e recuperou o banco no mesmo postmaster**, em segundos | ninguém precisa ter iniciado nada; recuperação antes de 16:41:00; todas as conexões caem ao mesmo tempo (login, auditoria e job falharam no mesmo segundo); o job `47` falhou **também na repetição**, ou seja, o banco ficou fora por mais que uma conexão velha | **não há log do Postgres** (iniciado com `stdio: 'ignore'`, `logging_collector` desligado) |
| B | Desligamento rápido (`pg_ctl stop -m fast`) seguido de nova partida por alguém | o `CHECKPOINT_SHUTDOWN` também é típico disso | nenhum comando meu no intervalo; o Redis não foi tocado (`infra.js stop` o mataria); alguém teria de iniciar o Postgres de novo em menos de 45 s |
| C | Encerramento por evento do Windows/segurança (EDR, antivírus) | a máquina é corporativa | sem evidência |

**Contexto do Windows (hipótese não verificada):** uma queda de processo do Postgres no Windows é típica de falta de recursos do sistema (heap de área de trabalho, limite de
processos de console). A máquina tinha 17–21 `conhost.exe` e ~20 processos `node` de hooks e servidores no momento, e o usuário viu ~17 janelas de CMD.

**Recorrência (evidência nova):** na **primeira** execução das capturas do Admin Web (arquivos de 14:07–14:09), o log da API já mostra `P1001 Can't reach database server at 127.0.0.1:5433`
em 14:08:17 e 14:09:22, e o `notas-admin.json` original registrava 503 em `/dashboard/financial`, `/dashboard/workshop`, `/dashboard/stock` e `/branches`.
Antes se atribuiu isso à saturação da carga de 60 req/s; **essa atribuição não foi provada**. O padrão — **o Postgres HML some por instantes enquanto roda a evidência no navegador** —
aconteceu nas duas execuções. **Atualização:** os `P1001` de 14:08 têm causa confirmada (rajada de conexões com o pool frio, ver a seção "Atualização" abaixo); o `P1017` de 16:40 não.

## Pendência — Next dev chegou a ~1 GB de RAM

Na porta 3002, `node.exe` PID 428, ~1 GB (medido às ~16:44 pelo `tasklist`, com o dashboard, usuários, ajuda e clientes já compilados: 2.102 módulos).
Causa provável: cache do compilador do `next dev` no modo desenvolvimento, que cresce a cada rota aberta e sem limite. **Não investigado.**
Impacto: pesa numa máquina corporativa e pode contribuir para o problema 2 (memória e processos). Alternativas a avaliar depois: `next build` + `next start` para as capturas
(menos memória e sem recompilação), limitar `NODE_OPTIONS=--max-old-space-size`, ou capturar uma frente por vez com o servidor reiniciado entre elas.

## O que investigar antes de qualquer nova execução (nada foi feito)

1. **Reproduzir sem navegador:** subir só Postgres e API HML por alguns minutos, sem Next dev e sem Chrome, e ver se o Postgres cai sozinho (descarta o Postgres/API como causa).
2. **Registrar o Postgres:** subir o Postgres HML com arquivo de log (`-l` ou `logging_collector`) para capturar `terminated by exception`, `server process … was terminated` ou
   `received fast shutdown request`.
3. **Log do Windows:** conferir no Visualizador de Eventos (Aplicativo e Sistema, às 16:40 e às 14:08) falhas de `postgres.exe`, relatórios de erro e eventos de recurso.
4. **Medir recursos** durante a captura: processos totais, `conhost`, memória do `next dev` e do Chrome.
5. **Código:** `auth.routes.ts:115` (classificação por texto), ordem `failureCountingMiddleware` × `translateErrors`, e se o limite de conexões do Prisma (padrão de 29 por processo em 14 núcleos)
   e `max_connections` (`infra.js` passa 200, o `postgresql.conf` diz 100) importam.
6. **Script de evidência:** falhar na hora quando a tela mostrar erro de login; nunca sobrescrever PNG existente.

## Resultado da investigação isolada (2026-10-04, 16:57–17:14)

Só o Postgres HML com log detalhado (`apps/hml/.hml/pg-hml.log`), sem Next, Chrome, Playwright, carga nem laço de teste; espera passiva por um único processo `node`.

| Etapa | Duração | Resultado |
|---|---|---|
| A. Só Postgres HML | 16:57:21–17:02:33 (5 min) | nenhum evento além da partida |
| B. Postgres + Redis + API HML | 17:02:43–17:10:49 (8 min) | mesmo postmaster (PID 12292), nenhuma linha anormal no log, **0 erros** na API (`evaluate-health` toda minuto), 2 conexões da API estáveis |
| C. Captura mínima (Next dev limitado a 768 MB + 1 Chrome, 3 cenários de login) | 17:12–17:14 | Postgres sem eventos anormais, 0 erros P1017/P1001/503 na API |

**Conclusão: a queda espontânea do Postgres NÃO foi reproduzida** (13,5 min sem navegador, 2 min com Next + Chrome em carga leve). O desligamento só aparece no log quando é pedido
(`interrompendo quaisquer transações ativas`, `sistema de banco de dados está desligado`), o que mostra que o log pegaria um desligamento ou uma queda. As duas ocorrências anteriores
(14:08 e 16:40) continuam **sem causa confirmada**: acompanharam a execução completa do navegador (Next dev sem limite + Chrome, 7 perfis em 2 minutos) e uma máquina com 17–23 `conhost.exe`;
a hipótese de falta de recursos do Windows segue como a mais provável, mas **não está provada**. Se voltar a acontecer, o log do Postgres (já ativo no script de partida usado) dirá a causa.

## Atualização — causa confirmada de parte das "quedas" (rodada do grupo A, 2026-10-04 18:00)

Ao refazer a captura do painel, com o log do Postgres já ligado, três chamadas (`/dashboard/financial`, `/workshop`, `/ceo`) deram **503 com `P1001 Can't reach database server` depois de 5030–5064 ms**,
e o log do Postgres **não registrou nenhum evento** (nem queda, nem desligamento). Conclusão: **o Postgres estava de pé**; as conexões novas da API não abriram em 5 s, o `connect_timeout` padrão do Prisma.

- **Mecanismo:** ao entrar no painel, o navegador dispara 5 a 6 chamadas ao mesmo tempo, cada uma com várias consultas em transação; com o pool da API ainda frio, são cerca de 30 conexões novas de uma vez.
  Neste computador (Postgres no Windows, que cria um processo por conexão, e varredura de segurança) isso passa de 5 s. É a mesma assinatura do teste de refresh que falhou com "Can't reach database server" ao abrir 25 conexões
  num Postgres recém-iniciado.
- **Explica:** os 503 das 14:08 (`P1001`, mesma assinatura em vários pedidos no mesmo segundo) e os de 18:00. **Não explica** o `P1017` das 16:40 (conexão fechada pelo servidor, com `CHECKPOINT_SHUTDOWN` no WAL): esse continua sem causa confirmada.
- **Prova da correção do ambiente:** com `connect_timeout=30&pool_timeout=30` só no `DATABASE_URL` da API HML (`infra.js`), a mesma captura passou com 0 erros 5xx.
- **Não alterado (decisão 57):** o produto continua com os tempos padrão do Prisma, o pool frio na partida e o painel disparando várias consultas em paralelo.

## Correção aplicada (sem mudar regra, RLS, RBAC, MFA, sessão nem limites)

- `apps/api/src/middleware/errorHandler.ts`: novo `isDatabaseUnavailableError` (mesmo critério de antes: falha de inicialização do Prisma, P1001, P1002, P1017, P2024, P2028), usado pelo próprio `errorHandler`.
- `apps/api/src/routes/auth.routes.ts`: no `catch` do login, erro de banco indisponível devolve **503 + `Retry-After: 5`** com o mesmo corpo de antes (`error`, `code: DATABASE_UNAVAILABLE`), sem registrar
  "Failed login attempt" nem tentar gravar `LOGIN_FAILED`; e erro do Prisma nunca é classificado como "credencial inválida" pela regex (o texto do Prisma cita o código-fonte).
- Teste novo `apps/api/src/routes/auth.routes.login-db-down.test.ts` (4 testes): **3 falham no código antigo** e passam no novo; o controle (credencial inválida de verdade: 401 + `LOGIN_FAILED`) passa nos dois.
- Verificado depois: o limitador conta no `res.end` com o status final (`advancedRateLimit.ts:335`), então um 503 por banco fora nunca contou como tentativa falha (nem antes, nem agora).

## Fechamento da homologação visual (2026-10-04)

Investigação **controlada** do `P1001`/`P2028` e da rajada do primeiro carregamento do painel. Sem carga: um login e um carregamento do painel do Admin (9 a 10 chamadas), mais uma recarga; Postgres e Redis de
desenvolvimento, API compilada na 3101, Chrome com uma página. Nada foi repetido em laço e nenhum arquivo do produto foi mudado por causa disto.

**Configuração atual (lida no código):** um único `PrismaClient` (`packages/database/src/index.ts`), sem `$connect()` na partida, tempos padrão do Prisma (`connect_timeout` 5 s, `pool_timeout` 10 s, transação em lote com espera
máxima de 2 s), pool de 2×núcleos físicos+1 (nesta medição o pool chegou a 23 conexões). `DATABASE_URL` de desenvolvimento sem parâmetros de pool. `GET /api/health/ready` faz um `SELECT 1` e um PING no Redis:
responde "pronto" com o pool frio (uma conexão), não mede o pool. O job repetido de saúde (`evaluate-health`, a cada minuto) abre 2 a 3 conexões logo depois da partida.

**Medições:**

| Momento | Conexões da API no Postgres |
|---|---|
| Logo depois de subir a API (antes do navegador) | 3 (todas do job de saúde) |
| Depois do **primeiro** painel do Admin (pool frio) e da recarga | 23 (20 novas: 15 no primeiro painel, 5 na recarga) |
| Depois de alguns minutos parado | 2 (o pool encolhe sozinho) |
| Depois de um painel com o pool encolhido | 20 |

| Carregamento | Chamadas | Erros 5xx | Mais lenta |
|---|---|---|---|
| 1º, pool frio (partida) | 9 | **4 × 503** (`workshop`, `financial`, `branches`, `stock`; ≈ 5,1 s) | 5141 ms |
| recarga seguinte, pool aquecido | 9 | 0 | 1543 ms |
| 1º depois de alguns minutos parado | 10 | **2 × 503** (`financial`, `ceo`; ≈ 5,0 s) | 5094 ms |
| recarga seguinte | 9 | 0 | 886 ms |

**Causa comprovada:** o `backend_start` das conexões em `pg_stat_activity` mostra o Postgres (no Windows) criando as conexões **em série**, não em paralelo: 15 conexões do primeiro painel em 4,1 s (76–190 ms de intervalo entre uma e outra, com
paradas de 986 ms e 1223 ms; a recarga ainda abriu 5, depois de uma parada de 2725 ms). Uma conexão sequencial custa ≈ 300–500 ms medida de fora (≈ 130 ms só para o servidor). O painel dispara 5 a 6 chamadas ao mesmo tempo e cada uma faz de 4 a 5 consultas em paralelo
(`Promise.all` em `dashboard.service.ts`), e cada consulta usa uma conexão (o cliente estendido envolve toda operação numa transação em lote). Com o pool frio são ≈ 15 a 20 conexões novas; as últimas passam do
`connect_timeout` de 5 s (`P1001`, 503 em ≈ 5,1 s) ou da espera de 2 s por uma transação (`P2028`). Com o pool aquecido não há erro. O registro de conexões do Postgres (`log_connections`) não gravou nada nesta máquina
(saída dos processos filhos sem destino); a prova vem de `pg_stat_activity` e dos tempos das chamadas.

**O que isto explica:** os 503 `P1001` das 14:08, 18:00 e 20:02, o `P2028` do `/health` das 20:07 e as 4 + 2 falhas desta rodada. **Novo:** acontece também depois de alguns minutos sem uso (o pool encolhe), não só na
partida. **O que não explica:** o `P1017` das 16:40, que continua sem causa.

**Não alterado (decisão 57):** nem timeout, nem tamanho do pool, nem aquecimento na partida, nem paralelismo do painel. O aquecimento sequencial na partida custaria ≈ 2 a 4 s e não esconderia erro real, mas só ajuda
a primeira vez; depois de ficar parado o pool volta a encolher. Em Linux a abertura de conexão é muito mais rápida: confirmar com medição no ambiente real antes de decidir. Pendência técnica **aberta, com causa comprovada**.

**Agrupamento por dia em UTC (corrigido):** `observability.service.ts` agrupava com `date_trunc(unidade, "createdAt")` em UTC. Passa a cortar no relógio de `America/Sao_Paulo`
(`date_trunc(unidade, ("createdAt" AT TIME ZONE 'UTC') AT TIME ZONE 'America/Sao_Paulo') AT TIME ZONE 'America/Sao_Paulo'`). Conferido no Postgres 18 desta máquina, com instantes de teste (sem escrever nada):

| `createdAt` (UTC) | Dia antigo (UTC) | Dia novo (Brasília) | Hora nova (Brasília) |
|---|---|---|---|
| 2026-09-28 02:59:59 | 28/09 | **27/09** | 27/09 23:00 |
| 2026-09-28 03:00:00 | 28/09 | **28/09** | 28/09 00:00 |
| 2026-10-01 02:30:00 (virada de mês) | 01/10 | **30/09** | 30/09 23:00 |
| 2026-12-31 02:59:00 | 31/12 | **30/12** | 30/12 23:00 |
| 2027-01-01 02:59:00 (virada de ano) | 01/01/2027 | **31/12/2026** | 31/12/2026 23:00 |
| 2027-01-01 03:00:00 | 01/01/2027 | **01/01/2027** | 01/01/2027 00:00 |

No navegador (7 dias), o ponto que antes era "27/09/2026, 21:00:00" agora é **"28/09/2026, 00:00:00 — Requisições 19"** e o último é "04/10/2026, 00:00:00 — Requisições 279"; as 24 h seguem por hora de Brasília.
Observação separada, não alterada: o agrupamento dos gráficos de monitoramento da filial usa `date_bin` com origem UTC; em intervalos de 6 h (30 dias) as faixas começam em 21h, 03h, 09h e 15h de Brasília.

## Evidências

- **Preservadas:** `apps/hml/.hml/api.log` (gitignorado, **não apagar**), `~/.claude/bash-commands.log`, o WAL do Postgres HML (`%LOCALAPPDATA%\ln-system-tools\hml\pgdata\pg_wal`, segmento `…09`) e
  `scratchpad/admin-dev.log`.
- **Sobrescritas pela execução interrompida (perdidas, a pasta não está no Git):** `a01-ceo-login.png`, `a01-ceo-mfa.png`, `a02-ceo-dashboard.png`, `a03-ceo-usuarios.png`,
  `a04-ceo-central-de-ajuda.png`, `a05-visualizador-dashboard.png`, `a06-visualizador-clientes-sem-botao-novo.png` (16:39:44–16:40:18). As novas mostram a mesma cena, mas as de 14:07–14:09 não existem mais.
- **`notas-admin.json`:** restaurado ao conteúdo original (14 notas, 4 erros 503 de 14:08). O da execução interrompida está em `notas-admin-execucao-fase6-interrompida.json`
  (7 notas, 1 erro: `POST /api/auth/login` 503).
- Criados depois, sem sobrescrever nada: `e01`–`e03` (senha errada, 5ª falha sem aviso, login correto com o IP bloqueado) e `notas-errors.json`. O harness `ui-evidence.js` agora grava com sufixo de execução
  se o arquivo já existir. Observação: o `a02-ceo-dashboard.png` atual foi capturado com três cartões ainda carregando (esqueletos), porque as chamadas do painel levaram 2–3,7 s.
