# Referências visuais, identidade e ambiente dos apps

## Quadro de marca oficial (recebido em 24/09/2026)

Referência visual única do produto. O arquivo do quadro (imagem) foi enviado pelo dono na conversa; **não** há arquivo
Figma nem token de design no repositório. **Desde 2026-10-20** o símbolo existe como vetor em `brand/` (vetorizado das 3 pranchas, ver "Ativos da marca" abaixo); o logotipo completo
(símbolo + "CÓRTEX / LÓGICA DE NEGÓCIOS") continua só como imagem das pranchas.

| Token | Hex | Uso |
|---|---|---|
| Naval profundo | `#050A10` | fundo (tema escuro) |
| Azul noturno | `#091018` | superfícies |
| Cinza grafite | `#10171F` | cards |
| Cinza borda | `#1C2733` | bordas |
| Off-white | `#F6F7F9` | texto |
| Cinza texto | `#9AA5B1` | texto secundário |
| Amarelo atenção | `#D6A84F` | estado de atenção |
| Vermelho erro | `#C95C5C` | estado de erro |

- Não há verde no quadro: sucesso usa um tom derivado. Cor só em indicador semântico (ponto/seta + texto); números de KPI
  neutros; sem roxo, gradiente ou paleta categórica.
- Tipografia: **Montserrat** (Admin Web e Super Admin; o PDV usa a fonte do sistema porque roda sem internet).
- Símbolo: "C" hexagonal + "CÓRTEX / LÓGICA DE NEGÓCIOS". Login de referência: cartão escuro dividido, "Bem-vindo de
  volta!", Usuário/Senha, "Lembrar acesso", "Esqueceu sua senha?".
- Tokens no código: `apps/admin-web/app/globals.css`, `tailwind.config.js`, `lib/theme.ts`, `lib/chart-theme.ts`; guardas
  automáticas `apps/admin-web/lib/design-*.test.ts`. Evidências: `docs/evidencias/2026-09-24` e `2026-09-25`.
- **Gráficos (2026-10-04):** o painel usava um azul vivo (`--chart-1`) e uma cor por barra, o que lia como template e contrariava a regra "sem paleta categórica". Agora
  `--chart-1` é o azul naval da marca (no escuro, um off-white azulado), `--chart-2` o cinza de comparação e o ciano (`--chart-3`) ficou dessaturado; linha para evolução no
  tempo, barras de uma cor para categorias. Os valores são derivados do quadro de marca, **não** de um arquivo Figma (ver abaixo).
- **Figma:** o repositório não tem arquivo, link, token nem Code Connect. O conector do Figma está disponível no ambiente do assistente (conta autenticada, plano
  "starter", assento só de visualização), mas **sem o link do arquivo do CÓRTEX ele não pode ser usado como fonte**; nada foi inventado. Para usá-lo, registre aqui o link
  do arquivo e rode a conferência dos tokens (cores, tipografia, raio, sombra) contra ele. Até lá, a fonte visual é o quadro de marca desta página. Reconferido em 2026-10-04 (ajustes finais do painel): nenhum link do Figma no repositório nem no ambiente; a conferência segue dependente do link oficial.

---

Registro do que cada frontend **exibe hoje** (título, logo, porta) e como os ambientes de banco/Redis
de dev e teste se separam. Não decide marca — só descreve o que existe, para nenhum agente/commit trocar
um título ou uma porta sem perceber que quebrou outro app. Guardado por `apps/admin-web/lib/design-identity.test.ts`
(`cd apps/admin-web && npx jest lib/design-identity`): se este documento e o código divergirem, o teste falha.

Origem: incidente de 21/09/2026 (ver `docs/CORTEX/historico/registro-de-auditoria-2026-09-14-a-25.md`, seção G1) — o PDV foi servido na porta 3002 (a
do Admin Web) para testar no navegador, e como o CORS de dev só liberava 3000/3002, dois frontends
dividiram a mesma porta. O sintoma ("regressão visual", `/pos` 404) era ambiente, não código: o Git prova
que nenhum commit de design mudou nesse intervalo.

## Mapa de portas — uma porta por frontend

| App | Porta | Como sobe | Observação |
| --- | ---: | --- | --- |
| Super Admin (Next) | **3000** | `npm run dev` em `apps/super-admin` | painel de plataforma (SA TI) |
| API | **3001** | `npm run dev` em `apps/api` | `API_PORT \|\| 3001` (`apps/api/src/index.ts`) |
| Admin Web (Next) | **3002** | `npm run dev` em `apps/admin-web` | painel da empresa (tenant) |
| PDV Desktop (Vite, navegador) | **5173** | `npm run dev:web` em `apps/pdv-desktop` (`vite.web.config.ts`, `--strictPort`) | app empacotado usa `file://`, não porta |
| Mobile/TV (Expo) | **8081** | `expo start` | porta padrão do Metro bundler |

Regra: **uma porta por frontend, sempre**. Nunca sirva dois apps na mesma porta (mesmo temporariamente
para um teste manual) — o CORS de dev (`resolveDevCorsOrigins`, `apps/api/src/index.ts`) libera uma lista
fixa de origens (`http://localhost:3000`, `:3002`, `:5173`), e um app servido fora da sua porta some do
que a API aceita, ou pior, some sob outra origem sem ninguém perceber.

Verificar o que está ocupando uma porta no Windows antes de subir um app:

```powershell
Get-NetTCPConnection -LocalPort 3002 -State Listen | Select-Object LocalAddress, LocalPort, OwningProcess
Get-Process -Id <OwningProcess>
```

## <title>, logo e nome exibido — hoje

| App | `<title>` / título da janela | `description` do metadata | Logo (sidebar) | Login |
| --- | --- | --- | --- | --- |
| Admin Web | `CÓRTEX — Admin` (`app/layout.tsx`, fonte Montserrat) | "Painel administrativo do CÓRTEX — Lógica de Negócios" | marca `CÓRTEX` / "Lógica de Negócios" (`components/ui/brand.tsx`) | marca + "Bem-vindo de volta"; 404 própria em `app/not-found.tsx` |
| Super Admin | `CÓRTEX — Super Admin` (`app/layout.tsx`, fonte Montserrat) | "Painel de administração Super ADM TI" | `CÓRTEX` / "Plataforma" (`components/layout/sidebar.tsx`) | título `CÓRTEX`, subtítulo `Painel Super ADM TI`, desafio MFA |
| PDV Desktop | `CÓRTEX PDV` (`index.html`, título da janela Electron em `electron/main.ts`) | — | `CÓRTEX` / `PDV Desktop` (`src/components/Layout.tsx`) | `CÓRTEX PDV` (`src/pages/LoginPage.tsx`) |
| Mobile (Expo) | app `CÓRTEX Equipe` (`app.json`, slug `ln-system-mobile`, bundle `com.lnsystem.mobile`) | — | `CÓRTEX` (`src/screens/LoginScreen.tsx`) |
| TV (Expo) | app `CÓRTEX Painel` (`app.json`, slug `ln-system-tv`, bundle `com.lnsystem.tv`) | — | `CÓRTEX — Painel` (`src/screens/LoginScreen.tsx`) |

Os três `<title>` de app web (`CÓRTEX — Admin`, `CÓRTEX — Super Admin`, `CÓRTEX PDV`)
são **únicos** — se dois ficarem iguais, ou um voltar a aparecer no lugar do outro, é o mesmo sintoma do
incidente de 21/09.

`package.json.build.productName`/`appId` do PDV empacotado seguem técnicos: `LN System PDV` / `com.lnsystem.pdv` — o Electron deriva de `productName` a pasta `userData` (sessão, número do caixa, `safeStorage`); renomear apagaria esses dados nos terminais instalados. Trocar só com migração da pasta.

## DECISÃO DE MARCA — tomada em 24/09/2026

O dono do produto definiu a identidade: **"CÓRTEX — Lógica de Negócios"** (quadro de marca oficial: paleta,
Montserrat, símbolo hexagonal "C"). "LN System" pode permanecer em nomes técnicos internos (pacotes `@ln-system/*`,
bundle ids, chaves de armazenamento) enquanto a migração não termina — sem renomeação estrutural só por marca.

Aplicado: **Admin Web** (título, marca, 404, Montserrat), **Super Admin** (título, marca, Montserrat) e **PDV** (título
da janela, marca; fonte ainda a do sistema — o PDV roda offline, sem Google Fonts). **Mobile ("CÓRTEX Equipe") e TV ("CÓRTEX Painel")** migraram o nome exibido em 2026-10-18 (app + `lib/design-identity.test.ts` +
este documento no mesmo commit); slug e `applicationId` seguem técnicos (`ln-system-*`, `com.lnsystem.*`). O símbolo hexagonal está em `brand/` (vetorizado das pranchas em 2026-10-20) e
aparece ao lado do texto nos logins e na navegação de cada app; o arquivo vetorial ORIGINAL do proprietário, quando chegar, substitui `brand/svg/cortex-mark.svg`.

## Ativos da marca (`brand/`, 2026-10-20)

Fonte: as 3 pranchas oficiais enviadas pelo dono (guardadas em `brand/referencias/`: 1 = identidade completa/favicon/aplicações, 2 = logo horizontal/variações/tipografia/dashboard,
3 = identidade visual/paleta). O símbolo foi **vetorizado** do recorte ampliado da prancha 3 (maior resolução do símbolo: ~150 px de altura): duas faces brancas com gradiente suave por baixo e
três faces cinza por cima, contorno por seguimento de borda + simplificação (IoU 0,985 com o recorte; arestas retas preservadas). **Não é um redesenho** e não substitui o arquivo original.
Tudo é gerado por `node brand/build-assets.js [--apply]` (precisa do Chrome e de `playwright-core`; `--apply` copia para os apps).

| Arquivo | Finalidade |
|---|---|
| `brand/svg/cortex-mark.svg` | símbolo em cor (faces brancas/cinza) para fundo escuro — fonte única; os demais derivam dele |
| `brand/svg/cortex-mark-sobre-fundo-claro.svg` | símbolo escuro (`#071016` / `#0F1D2A`, lidos da variante "fundo claro" da prancha) para fundo claro |
| `brand/svg/cortex-mark-monocromatico-branco.svg` | monocromático: `#F6F7F9`, faces cinza a 62% |
| `brand/svg/cortex-app-icon*.svg` | ícone do app: ladrilho azulado escuro (`#0E1B25→#050F18`, borda `#1C2733`) com o símbolo; versão sobre fundo claro; versão "pequena" (símbolo maior) para 16/32 px |
| `brand/png/cortex-mark-{256,512,1024}.png` e variações | símbolo com fundo transparente |
| `brand/png/cortex-app-icon-{16…1024}.png` | ícones do app em PNG (16/32/48/64 como no quadro "Favicon e ícones") |
| `brand/png/android-icon-*.png`, `splash-icon.png`, `cortex-app-icon-cheio-1024.png` | Android adaptativo (primeiro plano na zona segura de 66%, fundo, monocromático), abertura e ícone quadrado cheio |
| `brand/ico/favicon.ico` (16/32/48/64), `brand/ico/cortex.ico` (16…256) | favicon dos web apps; ícone do instalador Windows |

Onde cada ativo é usado: Admin Web e Super Admin — `app/favicon.ico`, `app/icon.png`, `app/apple-icon.png` (convenção do Next, servidos em `/favicon.ico`, `/icon.png`, `/apple-icon.png`) e
`components/ui/cortex-mark.tsx` (símbolo em cor no tema escuro, escuro no claro; os SVG ficam em `components/ui/brand-assets/` — arquivos, porque a guarda `design-forbidden.test.ts` proíbe cor fixa em
código de tela); Balcão e PDV — `public/favicon.*`, `src/components/CortexMark.tsx` + `src/assets/brand/`; instalador do PDV — `apps/pdv-desktop/resources/icon.ico` (`build.directories.buildResources`;
a pasta `build/` é ignorada pelo Git); Android Equipe/Painel — `assets/icon.png`, `android-icon-*.png`, `splash-icon.png`, `favicon.png`, `cortex-mark.png` (login) e `adaptiveIcon.backgroundColor #091018`.
O Super Admin passou a usar no tema escuro os mesmos tokens do Admin Web (`#050A10` etc.; antes um azul antigo ≈ `#070A13`). Os apps Android (Equipe/Painel) trocaram o azul `#2563eb`/slate pelos tokens da
paleta (botão principal `#F6F7F9` com texto `#050A10`, cards neutros).

**Limites e decisões abertas (do dono):** (1) a imagem 3 traz verde `#2E8B70` ("acento/status") mas a imagem 2 diz "Verde não será utilizado" e o quadro de 24/09 não tem verde — as cores de status "ok"
continuam derivadas (`#22c55e` nos badges Android) até a decisão; (2) o amarelo lido na imagem 1 é `#D6AB4F`, o do repositório `#D6A84F` (não confirmável na resolução das pranchas); (3) Inter como fonte
secundária das aplicações (imagens 2 e 3) não foi adotada — só Montserrat; (4) o logotipo completo, o banner da TV, a capa do Meet e a apresentação institucional dependem do arquivo original; (5) o layout de
login dividido e "Lembrar acesso" da prancha 1 **não** foi aplicado (mudança de layout: aguarda aprovação).

## Bancos e Redis — dev vs. teste

| | Dev | Teste (integração) |
| --- | --- | --- |
| Postgres | `lnsystem_db` (`DATABASE_URL`) | `lnsystem_test` — banco **dedicado**, derivado do nome de dev; `scripts/prepare-test-db.ts` recusa iniciar se o nome não contiver "test" ou for o de dev |
| Redis | `REDIS_DB=0` | `REDIS_DB=1` (`setupIntegrationEnv.ts`) — fila e cache de teste nunca colidem com os de dev |

Proteção contra teste destrutivo (`apps/api/test/integration/helpers/destructive-guard.ts`, ver
`docs/CORTEX/historico/registro-de-auditoria-2026-09-14-a-25.md` seção G2): um middleware `$use` no Prisma **dos testes** lança em vez de executar
quando `deleteMany`/`updateMany`/`delete`/`update` recebe `undefined` em qualquer profundidade do `where`,
ou `deleteMany`/`updateMany` com `where` vazio — a mesma classe de bug que apagou `stock_movements` de
todas as empresas do banco de dev numa rodada anterior (`afterAll` com variável `undefined` ignorada pelo
Prisma). `destroyFixture`/`destroyWorld` só apagam empresa **sintética**, sempre com nome começando em
**"Integration Test Co"** e id válido.

Empresas de demonstração (seed idempotente `npm run demo:seed`) usam o prefixo **"CÓRTEX Demo"** e são
protegidas — nunca apagadas por teste ou fixture, mesmo que o nome pareça sintético.

## Referência

- Mapa completo do incidente de 21/09 e as correções (CORS, porta própria do PDV, roteador por
  protocolo): `docs/CORTEX/historico/registro-de-auditoria-2026-09-14-a-25.md`, seção G1.
- Travas de banco de teste, seed de demo: `docs/CORTEX/historico/registro-de-auditoria-2026-09-14-a-25.md`, seção G2.
- Empresas antigas do banco de dev (classificação, não apagadas sem autorização): `docs/CORTEX/historico/registro-de-auditoria-2026-09-14-a-25.md`,
  seção G3.
- Migrações/RLS em outros ambientes: `docs/CORTEX/DATABASE.md`.

## Decisão técnica provisória de cores e tipografia (2026-10-20, a confirmar pelo dono)

Comparação das 3 pranchas: as pranchas 1 e 2 coincidem (8 cores: naval `#050A10`, azul noturno `#091018`, grafite `#10171F`, borda `#1C2733`, off-white `#F6F7F9`, cinza texto `#9AA5B1`, amarelo, vermelho `#C95C5C`; a prancha 2 diz "Verde não será utilizado"; tipografia principal Montserrat, Inter só em "aplicações secundárias"); a prancha 3 é a única com verde (`#2E8B70`) e sem amarelo/vermelho. Prevalece a identidade das pranchas 1 e 2 (a mesma do quadro de 24/09 e dos tokens atuais). Portanto: **sem verde de marca** (o "ok" de status continua um tom derivado, não uma cor de identidade); amarelo mantido em `#D6A84F` (a leitura `#D6AB4F` é indistinguível na resolução das pranchas; diferença de ~3/255 no canal verde, sem efeito visível); **Montserrat única** (Inter não foi aplicada: nos componentes de dados do Admin Web a troca mudaria largura de colunas/tabelas e exige revisão visual de cada tela). Nenhuma cor de status foi alterada. Trocar qualquer um destes pontos é decisão do dono e deve passar por `apps/admin-web/lib/design-tokens.test.ts`.
