# Homologação técnica pós-Next 15.5.28 (2026-10-22)

> Rodada controlada depois da subida do Next 14.2.35 → 15.5.28 no Admin Web e no Super Admin ([CHANGELOG](CHANGELOG.md)). Tudo foi executado **localmente** (Windows, PostgreSQL 18.6 e Redis portáteis, banco isolado e descartável); o CI no GitHub é citado à parte. **Não** foi feito teste de carga nem de estresse, nada foi implantado e nenhuma infraestrutura foi criada. Cada item abaixo diz se está **comprovado**, **falhou** ou **continua pendente**.

## 1. Falha isolada do teste de integração

| Item | Estado |
|---|---|
| Ocorrência original | run 39698112731 (`3f8d4c1`): só a suíte completa de integração (passo "papel de execução SEM posse") reprovou. O log do GitHub é privado e as anotações públicas só diziam "exit code 1": **nenhum nome de teste foi preservado**. Desde então, **11 execuções seguidas do CI passaram** com a mesma lógica de testes (o `ci.yml` só ganhou um passo de relatório entre `3f8d4c1` e `1ab9e2f`). |
| Reprodução local, condições do CI (papel sem posse, `--runInBand`) | rodada A: **123 suítes / 1802 testes aprovados**. |
| Reprodução com a CPU saturada (12 processos de queima, só para simular um runner lento — não é teste de carga do produto) | rodada B: **1 suíte reprovou (2 testes de `login-failed-audit`)**; rodadas D e E: aprovadas. Ou seja, 1 falha em 3 execuções completas sob contenção. A suíte `login-failed-audit` **sozinha** passou 3 de 3 sob a mesma contenção: a falha depende da sequência da suíte completa. |
| **Segunda ocorrência, no CI, com o commit desta rodada (`bc62640`)** | Dois runs do mesmo commit: um aprovado (run 39787145737) e um reprovado (run 39787141558) **só na suíte de integração**, agora com o nome do teste na anotação pública: `idempotency-key.integration.test.ts › chave VENCIDA (expiresAt no passado)…` (1 teste de 1802). **Causa raiz PROVADA** (diferente da primeira ocorrência): o middleware `idempotency.ts` grava o resultado (`status = COMPLETED`) **sem esperar** — o `res.json` dispara o `update` e já responde. O teste lia a chave (e repetia a requisição) logo depois da resposta e corria contra essa gravação. **Reprodução determinística:** atrasando o `update` em 400 ms (espião temporário, não commitado), o teste reprovou com `Expected "COMPLETED" Received "PENDING"`, e dois testes irmãos do mesmo arquivo caíram pelo mesmo motivo (um recebeu **409** na repetição imediata). **Correção (só teste):** `waitStatus` espera, com limite de 5 s, a chave chegar a `COMPLETED` antes de ler/repetir, e o vencimento passou a conferir que gravou (`count === 1`). Com o mesmo atraso de 400 ms o arquivo corrigido passa 5/5. O código do produto **não** foi alterado: a janela só existe para quem repete a requisição em milissegundos depois de já ter recebido a resposta; mudar o middleware para gravar antes de responder é uma melhoria possível, com decisão e testes próprios. |
| **Terceira ocorrência, no CI, com `7dce4f5` (correção da idempotência)** | Nesse run a **integração passou** (123 suítes), mas o job **Build** reprovou em `npm run build --workspace=@ln-system/admin-web`. O commit só alterou 1 teste e 2 documentos, e o mesmo passo passou nos runs anteriores (inclusive os dois de `bc62640`) e localmente com o mesmo código: **não é consequência do commit**. O log é privado e a anotação só diz "exit code 1": **causa NÃO determinada**. Hipótese (não confirmada): falha de rede ao baixar a fonte Montserrat do Google durante o build (`next/font/google` em `apps/admin-web/app/layout.tsx`). **Ação:** o `ci.yml` passou a publicar as linhas de erro do build do Admin Web e do Super Admin como anotações públicas (o código de saída é preservado), para que uma próxima ocorrência diga a causa. **Recomendação pendente:** hospedar a fonte no repositório (`next/font/local`) para tirar a dependência de rede do build, inclusive para o Docker/Google Cloud. |
| Causa raiz da **primeira** ocorrência (`3f8d4c1`, e a rodada B local) | **NÃO provada.** A mensagem de erro da rodada B se perdeu (o relatório do script guardava só o nome do teste). Causa **provável**, por leitura de código: o `resetAuthLimits` (usado por 13 suítes que fazem login) esperava só 5 s pelo Redis do limitador e, se ele não estivesse pronto, **seguia em silêncio**: o reset valia só para a memória de reserva e as falhas de login de suítes anteriores ficavam no Redis (limite real: 5 falhas por IP em 15 min, bloqueio de 1 h). A suíte seguinte recebia 429 já no primeiro login. Isso explicaria os **dois** testes do arquivo caírem juntos, mas **não foi confirmado** (nenhuma rodada capturou um 429). Para o teste 1 há uma segunda hipótese, também não confirmada: ele espera a linha de auditoria (gravada de forma assíncrona) por no máximo 2 s (20 × 100 ms), janela curta para uma máquina saturada. A mesma **classe** de defeito (gravação assíncrona lida logo depois da resposta) foi a causa provada da segunda ocorrência. |
| Correção aplicada | `apps/api/test/integration/helpers/reset-auth-limits.ts`: espera até 30 s pelo Redis, **falha explicitamente** se não ficar pronto, apaga os baldes e **confere** que voltaram ao orçamento cheio (5 tentativas), apontando qual balde está sujo. Só código de teste; o limitador do produto não foi alterado. |
| Diagnóstico para a próxima ocorrência | `apps/api/scripts/db-role-split-check.ts`: o relatório (e, portanto, as anotações públicas do CI) agora traz as 4 linhas de mensagem de cada teste reprovado, e `ROLE_SPLIT_FULL_LOG=<arquivo>` grava a saída integral (já redigida). |
| Resultado depois da correção | rodada E (com contenção) e rodada F (sem contenção, estado final): ver §6. **Isso não prova a causa**: 1 falha em 3 também é compatível com sorte. O critério de encerramento é: se voltar a falhar no CI, a anotação já dirá a causa. **Pendente.** |

## 2. Suíte E2E (`apps/e2e`, Chrome real, Next 15 em modo produção)

Ambiente: banco isolado recém-migrado (57 migrations) + `demo:seed`; API na 3001, Admin Web (3002) e Super Admin (3000) compilados por `next build` e servidos por `next start`; PDV web (5173) e Balcão (5174) em modo dev. **A API conectou como o superusuário do banco isolado** (a RLS não foi exercida nesta execução; a RLS é provada pela suíte de integração como papel sem posse).

| Execução | Resultado |
|---|---|
| 1ª (completa, 11 arquivos) | **7 aprovados, 4 reprovados; 85 de 93 testes passaram, 8 falharam.** |
| Causa das 8 falhas | **todas por dado/configuração ausente do banco novo, nenhuma por regressão do Next 15** (detalhe na tabela abaixo). |
| Depois de preparar os dados | `catalog-and-help` 7/7, `super-admin-flow` e `support-contextual-buttons` aprovados (19 testes nos 3 arquivos, 1 falha restante era a Central de Ajuda ainda não publicada), `mfa-privacy-image` 6/6 com a API em modo MFA. **Os 11 arquivos passaram, em execuções separadas**, não numa única execução contínua. |

| Arquivo | Falha | Causa real | Preparo |
|---|---|---|---|
| `mfa-privacy-image` (3 testes) | MFA não apareceu | a API precisa de `REQUIRE_MFA_COMPANY_ADMIN=true` | reiniciar a API com a variável |
| `catalog-and-help` (1) | busca sem resultado | `help:seed` sem `--apply` só **simula**; artigos nunca gravados | `npm run help:seed -- --apply --publish` |
| `super-admin-flow` (1) | `licenses` vazia | banco novo sem licença da Alfa | licença ACTIVE criada |
| `support-contextual-buttons` (3) | sem garantia | `demo:seed` só cria a garantia sobre uma OS **encerrada** existente | OS encerrada sintética + novo `demo:seed` |

Os dados de preparo (licença, cliente `[e2e-prereq]`, OS encerrada) foram criados por um script temporário (apagado) **só no banco isolado e descartável**. As quatro dependências ficaram documentadas em [apps/e2e/README](../../apps/e2e/README.md) ("Banco novo, sem histórico"). `pdv-sale-flow` grava uma venda persistente (trilha append-only) no banco isolado; não foi repetido.

## 3. Regressão funcional e visual controlada (Admin Web e Super Admin)

Um único Chrome, uma página por vez, 1366×900. Script avulso (não publicado) + capturas em `docs/evidencias/2026-10-22-regressao-next15/` (pasta **não publicada** no GitHub, como as demais evidências; 70 capturas, 7 MB).

| Cobertura | Resultado |
|---|---|
| Admin Web: login pela tela | senha errada fica no `/login` ✔; senha correta leva ao `/dashboard` ✔; sair volta ao `/login` e `/dashboard` sem sessão redireciona ao `/login` ✔ (conferido com o botão real, `title="Sair"`) |
| Admin Web: 30 rotas navegáveis (dashboard, clientes, produtos, estoque, vendas, orçamentos, OS, motos, fornecedores, compras, financeiro, conciliação, pós-venda, convênios, descontos, canais, fiscal, relatórios, usuários, filiais, configurações, privacidade, ajuda, chamados, mecânicos, avarias e telas "novo") | **30/30 abrem sem erro de página, sem erro de console, sem tela de erro do Next e sem rolagem horizontal.** Única resposta ≥ 400: `403 /api/sales-channels` em `/dashboard/channels`, e é **o esperado**: `MODULE_DISABLED` (o módulo Canais nasce desativado). |
| Super Admin: login com senha + TOTP | ✔; sair ✔; administrador de empresa **não** entra no console ✔ |
| Super Admin: 24 rotas (empresas, licenças, dispositivos, usuários, auditoria, backup, suporte ×5, observabilidade ×13) | **24/24 sem erro de página, console, tela de erro ou rolagem horizontal.** |
| Responsivo 390 px | Admin Web (dashboard, clientes, produtos, novo orçamento) e Super Admin (dashboard, Central): **6/6 sem rolagem horizontal.** |
| Permissões por papel (token emitido) | VIEWER, gerente, balcão, caixa e mecânico: `/dashboard/users` e `/dashboard/financial` mostram negação de acesso; o administrador vê 25 itens de menu, os demais 15 a 23. **Por API:** VIEWER criando cliente → **403**; administrador da empresa Beta lendo cliente da Alfa → **404**. |
| Comparação visual | Capturas novas comparadas à captura de 2026-10-14 (Next 14, `docs/evidencias/2026-10-14-playwright/…/04-dashboard-apos-configurar.png`): mesmo logotipo, barra lateral, tipografia (Montserrat) e cores (fundo `rgb(249,250,251)`). Comparação **qualitativa, não por pixel** (os dados e o estado de carregamento diferem). |

**Observações (não são regressão, nada foi alterado):** (a) a barra lateral dos papéis restritos ainda lista itens cujas páginas negam o acesso (20 links para VIEWER/balcão/caixa); a negação funciona, mas é um ponto de UX para confirmar com o dono; (b) a detecção de "acesso negado" foi por texto da página, não por matriz de permissões; a garantia de verdade é a API (403/404 acima e a suíte de integração).

**Limites:** não é regressão visual por pixel contra uma linha de base aprovada (não existe linha de base automatizada); não cobriu fluxos de escrita além dos já cobertos pelos arquivos E2E; PDV (Electron) e apps Android não fazem parte desta rodada.

## 4. Documentação corrigida (106/107 → 113 tabelas)

`npm run db:docs -- --write` foi executado depois de conferir o que escreveria (BANCO_DE_DADOS só entre marcadores, MAPA_RELACIONAMENTOS, RELATORIO_MIGRATIONS, REVISAO_BANCO_PENDENCIAS entre marcadores e o pacote `revisao-banco/`). Resultado: o catálogo tem **113 tabelas = 113 modelos, 57 migrations, 0 sem RLS, 0 sem policy** e o Anexo A **já estava correto** (só a data mudava). O restante do diff gerado descrevia o **banco isolado**, não o ambiente de desenvolvimento do projeto (por exemplo, conexão como superusuário e datas de aplicação das migrations de hoje), então foi **descartado**, restaurando os cinco arquivos gerados a partir do HEAD. Foram corrigidos à mão só os textos vivos:

| Arquivo | Correção |
|---|---|
| `BANCO_DE_DADOS.md` | 106 → 113 tabelas (introdução, RLS, inventário), 50 → 57 migrations (link do RELATORIO e migrações aplicadas em teste), com a data da conferência |
| `README.md` (docs/CORTEX) | "107 tabelas" → 113 |
| `CURRENT_STATE.md` | linha do banco: 107/55 → 113/57 |

**Preservados de propósito** (registros datados do que foi medido na época): CHANGELOG, `RELATORIO_*`, `revisao-banco/evidencias-*`, `BACKUP_RECUPERACAO` (43 MB, 106 tabelas era a medição de então) e a linha de missão de 2026-10-15/18 do CURRENT_STATE.

## 5. Vulnerabilidades restantes (`npm audit`)

Antes desta rodada: 101 (0 críticas, 69 altas, 32 moderadas; 55 em dependências de produção). **Atualização aplicada** (somente arquivo de lock, versões dentro do intervalo já declarado, sem mudar `package.json`): `express` 4.22.2 → 4.22.3, `body-parser` 1.20.6 → 1.20.9, `qs` 6.15.3 → 6.16.1, `fast-uri` 3.1.7 → 3.1.9, `joi` 17.13.7 → 17.13.8. **Depois: 96 (0 críticas, 69 altas, 27 moderadas; 51 em produção).** Validação: `tsc` de todos os workspaces, lint, 1296 testes unitários da API, 556 do Admin Web, 37 do PDV, 9 do Balcão, links 843/0 e integração completa (§6). `npm audit fix` não funciona nesta versão do npm (o serviço foi aposentado).

Os "demais" itens da lista são dependências que só repassam a advisory de outro pacote (Expo/React Native, Jest, electron-builder). Pacotes com advisory própria:

| Pacote (gravidade) | Onde | Exposição real | Correção recomendada / impacto |
|---|---|---|---|
| `xlsx` (alta; protótipo + ReDoS) — direta | Admin Web (`lib/excel-parser.ts`, importação de planilha no navegador) | O arquivo vem do próprio usuário autenticado, processado **no navegador dele**; não roda no servidor. Risco: um arquivo malicioso travar/poluir a aba de quem o abre. Média/baixa. | Não há versão corrigida no npm (0.18.5 é a última). Trocar por `exceljs`/`read-excel-file` ou SheetJS oficial (fora do npm): **muda o parser de importação**, exige testes de compatibilidade dos formatos. Decisão do dono. |
| `postcss` ≤ 8.5.22 dentro do `next` (alta; XSS em `</style>` e leitura de arquivo por `sourceMappingURL`) | build do Admin Web / Super Admin | Só processa o CSS **do próprio projeto** em build; não recebe CSS de usuário. Baixa. | Correção só em Next 16 (major). Não subir agora; reavaliar na próxima rodada de framework. |
| `braces` (alta; DoS por padrão aninhado) | `tailwindcss`/`chokidar` (build) e Expo/Metro | Ferramenta de build/dev; nunca roda em produção. Baixa. | Corrige com React Native major (Expo). Sem ação. |
| `node-forge` (alta; assinatura RSA) | `@expo/code-signing-certificates` (ferramenta do Expo) | Só no build dos apps Android. Baixa. | Sem correção disponível; acompanhar o Expo. |
| `vite` ≤ 6.4.3 (alta, dev) e `esbuild` (moderada, dev) | servidor de desenvolvimento do Balcão e do PDV | **Só em desenvolvimento** (o servidor de dev aceita requisições de qualquer site da máquina). Produção usa o build estático (nginx). Baixa. | Vite 8 é major: exige teste do Balcão/PDV. Fazer em rodada própria. |
| `react-router` 6.x (moderada; open redirect por `\`) | Balcão (SPA, **produção**) | Exige link ou navegação montada com entrada do usuário contendo `\`; o Balcão não monta rotas a partir de entrada externa (a confirmar por revisão de código). Baixa. | `react-router-dom` 7 é major: exige teste do Balcão e do PDV. |
| `decode-uri-component` (moderada; DoS) | app Equipe (mobile), via `@react-navigation` | Só decodifica parâmetros da própria navegação do app. Baixa. | Correção em major do pacote; depende do `query-string` do Expo/React Navigation. Sem ação isolada. |
| `postcss-selector-parser` (moderada) | `tailwindcss-animate`/`postcss-nested` (build) | Build. Baixa. | Sem correção disponível. |
| `uuid` < 11.1.1 (moderada) — direta na API | `apps/api` declara `uuid@^9`, mas **nenhum arquivo da API importa `uuid`** (só há `format: 'uuid'` no OpenAPI) | Nenhuma no código da API; versões aninhadas vêm de `node-cron` e `xcode`. | Remover a dependência não usada do `apps/api/package.json` (baixo risco; fazer com `npm install` revisado, que reordena os `package.json`). |
| `turbo` ≤ 2.9.13-canary.1 (moderada; dev) | ferramenta de repositório | Só na máquina de quem desenvolve. Baixa. | Turbo 2 é major; avaliar à parte. |
| `sprintf-js`, `joi` (dev) | Jest/electron-builder, `wait-on` do PDV | Só ferramentas de teste/build. | `joi` já corrigido; o restante acompanha major do Jest. |

Nenhuma das 96 está **explorável pela internet contra a API em produção**; as de produção que sobram estão no navegador (Admin Web, Balcão) ou no app, ou são de build. **Pendente**: decidir `xlsx` e o pacote de majors (Vite 8, React Router 7, Next 16) com testes de compatibilidade.

## 6. Estado final dos testes desta rodada

| Verificação (local, estado final do código) | Resultado |
|---|---|
| Integração completa como papel **sem posse** (`db:role-split-check -- --all`) | rodada A **123/1802**, B **1 suíte e 2 testes reprovados** (com CPU saturada), D **123/1802** (CPU saturada), E **123/1802** (CPU saturada, helper corrigido), **F 123/1802 (estado final, sem contenção)**. Total: 5 execuções completas, 4 aprovadas e 1 reprovada; nenhuma repetida "até ficar verde": todas estão registradas. |
| Unitários da API | **128 suítes / 1296 testes** aprovados |
| Unitários do Admin Web | **33 suítes / 556 testes** aprovados |
| Lógica do PDV / do Balcão | **37/37** e **9/9** |
| `type-check` (database, shared, api, admin-web, super-admin, pdv-desktop, balcao) | os 7 sem erro |
| Lint (api, admin-web, super-admin) | 0 erros (3 avisos antigos: `no-unsafe-function-type`, `aria-invalid` em `li`, dependência de `useEffect`) |
| Links da documentação | 843 conferidos, 0 quebrados |
| `next build` (Admin Web e Super Admin, Next 15.5.28) | os 2 compilam |
| E2E (`apps/e2e`) | 11/11 arquivos aprovados, em execuções separadas (§2) |
| Regressão funcional/visual | 30 + 24 rotas, login/saída, permissões e 390 px sem falha (§3) |

**CI no GitHub, commit `bc62640`** (o GitHub criou dois runs de cada workflow para o mesmo commit): "Stack (compose real)" **aprovado nos dois** (pilha real do compose, Next 15 incluído); "CI" **um aprovado e um reprovado** — o reprovado foi a falha de idempotência da §1, já corrigida no commit seguinte. Commit `7dce4f5` (correção da idempotência): integração, lint/typecheck, unitários, segurança e infra **aprovados**; o job **Build** reprovou no Admin Web por causa não determinada (§1, terceira ocorrência). O estado do CI do commit seguinte, com as anotações de build, está no relatório de entrega. Último estado verde completo antes desta rodada: `7fb154a`.

## 7. Pendências (o que esta rodada NÃO resolveu)

- Falha isolada de integração: a **segunda ocorrência** (idempotência) tem causa **provada e corrigida** (§1); a **primeira** (`3f8d4c1`, `login-failed-audit` na rodada B) continua com causa **não provada**, com duas hipóteses e o reset do limitador endurecido. A suíte tem outros pontos da mesma classe (leitura logo após gravação assíncrona): se uma terceira falha aparecer, a anotação do CI agora traz a mensagem.
- E2E: os 11 arquivos passaram, mas **em execuções separadas e com preparo de dados**; não houve uma execução única contínua; a API conectou como superusuário.
- Regressão visual **qualitativa**, sem linha de base por pixel; PDV Electron e apps Android fora do escopo.
- Vulnerabilidades: `xlsx`, `react-router`, Vite/esbuild e Next 16 pendem de decisão e teste de compatibilidade.
- Divergência do Balcão (SPA web × "APK") continua **aguardando decisão** ([APLICATIVOS](APLICATIVOS.md), decisão 116).
- Produção: servidor/projeto Google Cloud (aguarda o suporte), domínio e HTTPS, bucket de backup externo + teste de restauração, monitoramento e alertas reais, Super Admin real, assinatura do PDV/Android, RPO/RTO aprovados. **O CÓRTEX não está pronto para produção.**

## 8. Segunda rodada (2026-10-22, tarde): Cloudflare, falhas intermitentes, E2E contínuo com RLS

Esta seção **atualiza** os itens acima. Onde houver divergência, vale o que está aqui.

### 8.1 Cloudflare

Detalhe completo em [CLOUDFLARE](CLOUDFLARE.md). **Causa da falha do Workers Builds: comprovada** (raiz `/` sem configuração de Worker, num monorepo com vários frameworks: a configuração automática do Wrangler falha, por documentação e por mensagem). **Compatibilidade**: Next 15.5.28 atende o adaptador (`>=15.5.28 <16`). **Build, pacote (2,1 MiB gzip) e execução no workerd com login, sessão, CORS, 21 rotas e permissões: OK** (Windows) e **build + dry-run + workerd + cabeçalhos: OK no runner Linux** para o Admin Web e o Super Admin. **Implantação real: NÃO feita** (sem credencial). O Workers Builds segue reprovando até a configuração manual do painel. **Não homologado para produção.**

### 8.2 Falhas intermitentes — causas e classificação

| Falha | Investigação desta rodada | Classificação |
|---|---|---|
| **`idempotency-key`** (CI, `bc62640`) | causa provada na rodada anterior; agora: 3 execuções seguidas aprovadas; **teste de mutação** (o produto deixa de liberar a chave vencida) **faz o teste reprovar** (1 falha), então a espera não mascara um defeito real; com a gravação atrasada em 400 ms o arquivo passa 5/5. Middleware **não alterado** (sem defeito de comportamento: a gravação assíncrona só é visível a quem lê em milissegundos). | **Resolvida com causa comprovada** |
| **`login-failed-audit`** (CI `3f8d4c1`; local, rodada B) | **Hipótese do Redis (reset do limitador): NÃO observada.** Rodada R1 (CPU saturada, helper original instrumentado, 65 resets): o Redis ficou pronto em **no máximo 0,94 s** (janela de 5 s), `usingRedis` verdadeiro em **todos** os resets, e **os 19 resets que encontraram falhas acumuladas** (5 por IP/15 min) **limparam todos** os baldes; R1 passou 123/1802. **Hipótese da auditoria assíncrona: tem sustentação.** Medição com a CPU saturada (40 logins falhos): latência até a linha de auditoria aparecer **p50 0,8 s, p90 1,1 s, máximo 2,5 s, 1 de 40 acima de 2 s**, e o teste esperava só 2 s. A janela foi ampliada para 15 s (**mitigação por tempo, não sincronização**). **O segundo teste do arquivo (400 para corpos inválidos), que também caiu na rodada B, continua SEM explicação.** O helper `resetAuthLimits` endurecido fica como defesa; seu comentário foi corrigido para não afirmar uma causa que não se observou. | **Mitigada, mas não comprovada** (teste 1 com sustentação experimental; teste 2 sem explicação). Placar com o helper original sob contenção: 1 falha em 3 execuções completas. |
| **Build do Admin Web** (CI, `7dce4f5`) | **Mecanismo reproduzido, causa do CI não provada.** Com a rede bloqueada (proxy para porta morta) o build do Admin Web **falha sempre** com "`next/font` error: Failed to fetch `Montserrat` from Google Fonts": o build **depende de rede** e esse é um modo de falha real. **Alternativa testada e revertida:** com a fonte hospedada (`next/font/local`, usando o próprio arquivo latino que o Next baixa, mesmo hash `904be59b…woff2`) o build **passa sem rede** (exit 0). Não há como afirmar que o build reprovado do CI foi isso (log privado; o `ci.yml` agora anota erros de build). **Não mudei a fonte**: o teste `design-identity.test.ts` fixa `import { Montserrat } from 'next/font/google'` (identidade de marca, "visual só com aprovação"). | **Mitigada em parte (diagnóstico melhor), causa não provada; hospedar a fonte = decisão do responsável** |

### 8.3 E2E completo com a API como papel de aplicação (RLS exercida)

Ambiente isolado: banco novo e migrado (57 migrations), API conectada como **`cortex_e2e_app`** (`rolsuper = f`, `rolbypassrls = f`, não dono; confirmado em `pg_stat_activity`), contexto de RLS assinado, Redis e servidores locais.

| Rodada | Configuração | Resultado |
|---|---|---|
| **A** (11 arquivos, uma execução, 9 min 18 s) | MFA obrigatório para administrador de empresa | **83/93** testes; `mfa-privacy-image` **6/6**; **`admin-web-flow` e `user-access-flow` reprovam (10 testes)** porque entram pela tela como `admin.alfa` (sem MFA) e a API exige MFA: **conflito de configuração do desenho do E2E**, não regressão |
| **B** (10 arquivos, uma execução, 3 min 41 s) | MFA desligado | **87/87**; por arquivo: `user-access-flow` 7/7, `admin-web-flow` 9/9, `support-console-pdv` 4/4, `monitoring-central` 18/18, `support-ticket-flow` 8/8, `balcao-flow` 13/13, `super-admin-flow` 6/6, `catalog-and-help` 7/7, `pdv-sale-flow` 9/9, `support-contextual-buttons` 6/6 |

**Resumo honesto:** os 11 arquivos passam (93 testes) com a API como papel de aplicação, mas **em duas execuções contínuas com configurações diferentes da API**, porque o arquivo de MFA exige a API com a variável ligada e os de login por tela exigem desligada. **Uma única execução verde de todos os 11 não é possível com o desenho atual** (exigiria que o E2E de MFA use um administrador próprio ou que os demais usem um administrador já com MFA). O `pdv-sale-flow` gravou duas vendas no banco isolado (descartável).

**RLS no banco, como o papel de aplicação** (sonda direta): sem contexto, **0** clientes/usuários/vendas visíveis; contexto da empresa Alfa vê só os dela (2 clientes, 10 usuários, 2 vendas); contexto da Beta só os dela; contexto de plataforma vê todos; **escrita cruzada Beta → Alfa negada** ("violates row-level security policy for table customers"). Por API: administrador da Beta lendo cliente da Alfa → 404; VIEWER criando cliente → 403. A suíte de integração como papel sem posse segue como evidência complementar (123 suítes / 1802 testes).

**Observação operacional — EXPLICADA depois (2026-10-22, tarde):** no banco novo, o contexto de plataforma deixou de enxergar usuários para o papel de aplicação até um novo `db:provision-context`. **Causa: artefato do meu ambiente de teste, não defeito do projeto.** O arquivo que montava as variáveis (`ci-env/env.sh`) gera `RLS_CONTEXT_SECRET` e `DATA_ENCRYPTION_KEY` **novos a cada `source`**; cada vez que reescrevi o `.env` o segredo da API deixou de bater com o provisionado no banco, e o banco, corretamente, **rejeitou** o contexto assinado. A verificação de segurança do modo produção da API (`checkDatabaseSecurity`) pegou isso ("o banco REJEITOU o contexto assinado desta API (RLS_CONTEXT_SECRET diferente do provisionado)") e **se recusou a subir**, que é o comportamento desejado. Consequência colateral: a mesma troca de `DATA_ENCRYPTION_KEY` invalidou o segredo TOTP selado do Super Admin de demonstração (re-selado). Lição para a implantação: **fixar** esses segredos no cofre e nunca gerá-los a cada execução.

### 8.4 Regressão funcional e visual repetida

Repetida com a API como papel de aplicação, no mesmo script: Admin Web 30/30 e Super Admin 24/24 rotas sem erro de página/console e sem rolagem horizontal (única resposta ≥ 400: o 403 de Canais, módulo desativado), login com senha errada/certa, TOTP, sair e acesso negado ao console para administrador de empresa (todos **ok**), 390 px (6/6), VIEWER 403, isolamento entre empresas 404. Evidências anteriores preservadas em `docs/evidencias/2026-10-22-regressao-next15-api-superusuario/` (não publicado). **Continua sem comparação por pixel; PDV Electron e apps Android continuam sem rodada própria.** Questão de UX registrada: a barra lateral lista páginas que o papel não pode abrir.

### 8.5 Dependências e banco

- [SEGURANCA_DEPENDENCIAS](SEGURANCA_DEPENDENCIAS.md): análise **por advisory** (12 pacotes, 25 advisories) com caminho, exposição, mitigação e testes. Estado: **96 (0 críticas, 69 altas, 27 moderadas)**, sem mudança nesta rodada; `uuid` e `turbo` não têm uso real; `xlsx`, Vite 8, React Router 7 e Next 16 dependem de decisão e teste.
- Banco reconfirmado (`db:docs` em dry-run, banco recém-migrado): **113 tabelas = 113 modelos, 57 migrations, 0 sem RLS, 0 sem policy, 0 sem chave primária**; nenhum arquivo gerado foi regravado nesta rodada.

### 8.6 Classificação das pendências

| Pendência | Classe |
|---|---|
| Idempotência | **Resolvida com causa comprovada** |
| Causa da falha do Workers Builds | **Resolvida com causa comprovada** (a correção é configuração manual no painel) |
| `login-failed-audit` | **Mitigada, mas ainda não comprovada** |
| Build do Admin Web (rede/fonte) | **Mitigada em parte; causa do CI não provada** |
| E2E com RLS | **Comprovado em duas execuções contínuas**; execução única **pendente de ajuste do E2E** |
| Cloudflare (deploy real, domínio, painel, Super Admin funcional) | **Bloqueada por autorização/credencial externa** |
| Hospedar a fonte; `xlsx`; Vite 8; React Router 7; Next 16; Balcão (APK × web); barra lateral | **Dependente de decisão do responsável pelo produto** |
| Google Cloud, domínio/HTTPS, backup externo + restauração, alertas, Super Admin real, assinatura PDV/Android, RPO/RTO | **Bloqueadas por infraestrutura ou autorização externa** |
| PDV Electron e apps Android (rodada própria), regressão visual por pixel | **Pendentes de teste** |
