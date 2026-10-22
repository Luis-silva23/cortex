# Cloudflare — homologação do Admin Web e do Super Admin em Workers (2026-10-22)

> **Estado (atualizado em 2026-10-22, tarde): VALIDADO NA CLOUDFLARE REAL EM CARÁTER TEMPORÁRIO; NÃO está em produção.** Comprovado: a causa da falha do Workers Builds; o build com o adaptador OpenNext (Windows e Linux); o pacote do Worker; o funcionamento no runtime do Workers local (workerd) **e, depois, o Admin Web e o Super Admin publicados de verdade no edge da Cloudflare** (conta temporária do próprio Wrangler, sem login, apagada em 60 minutos) conversando com a API real em HTTPS (túnel temporário): login, MFA/TOTP, sessão, logout, permissões, isolamento entre empresas, CORS e cabeçalhos (§10). **Não** comprovado/pendente: implantação **permanente** (exige a sua conta Cloudflare ou um token), a configuração do painel do Workers Builds (sem acesso ao painel), domínio próprio, API permanente (o túnel era a minha máquina e foi encerrado) e o comportamento sob uso real. O destino de implantação da API continua sendo o Google Cloud ([GOOGLE_CLOUD](GOOGLE_CLOUD.md)).

## 1. Causa da falha original (comprovada)

| Evidência | O que mostra |
|---|---|
| Mensagem do Workers Builds (recebida do responsável) | "The Cloudflare application detection logic has been run in the root of a workspace instead of targeting a specific project." Configuração: **Root directory `/`**, **Build command vazio**, **Deploy command `npx wrangler deploy`**. |
| Repositório | **Nenhum** `wrangler.jsonc` / `wrangler.toml` existia; o `/` é a raiz de um monorepo npm com 8 aplicativos (2 Next, 2 Vite, 2 Expo, Electron, API). |
| Documentação oficial da Cloudflare ([configuração automática](https://developers.cloudflare.com/workers/framework-guides/automatic-configuration/)) | Sem arquivo de configuração, o `wrangler deploy` roda a **configuração automática**, que só analisa o diretório em que roda, **não enxerga dependências instaladas na raiz do workspace** e **falha quando o projeto contém vários frameworks**; a correção indicada é definir o **diretório raiz** para uma pasta com um só framework. |
| Check do GitHub ("Workers Builds: cortex") | Reprovado em **todo** push (inclusive commits só de documentação), com início e fim no mesmo segundo: falha antes de qualquer build. |

**Conclusão:** a falha é de **configuração do projeto no painel** (raiz `/` sem configuração de Worker), não de versão de dependência, de Next ou de código. Avisos de pacote obsoleto nos logs não são a causa.

## 2. Compatibilidade de versões (verificada em 2026-10-22)

| Item | Requisito | Estado no CÓRTEX |
|---|---|---|
| Next.js | `@opennextjs/cloudflare` 1.20.13 exige `next` `>=15.5.28 <16` ou `>=16.4.1` | **15.5.28** (limite inferior exato: não rebaixar) |
| Wrangler | adaptador exige `^4.148.0`; Wrangler 4.151.3 exige **Node ≥ 22** | testado com 4.151.3 e Node 22 (os demais jobs do CI usam Node 20; o workflow da Cloudflare usa 22) |
| React | Next 15 | 18.3.1 (o App Router usa o React embutido do Next) |
| Runtime do Workers | `nodejs_compat` e `compatibility_date` ≥ 2024-09-23 | `nodejs_compat`, `global_fetch_strictly_public`, data 2025-03-01 |
| Edge runtime do Next | **não suportado** pelo adaptador | **não usado** (nenhum `runtime = 'edge'`) |
| Middleware / rotas de API do Next / `next/image` | exigem atenção no adaptador | **nenhum** middleware, **nenhuma** rota `route.ts`; `next/image` não é usado (otimizador desligado: `/_next/image` responde 404, conferido no Worker) |
| Observação de roteiro | a Cloudflare passou a **recomendar o vinext** (exige Next 16) e a configuração automática usa vinext; o OpenNext segue para aplicativos existentes | decisão de produto/engenharia futura; **não testado** |

Um **build bem-sucedido não basta**: o pacote foi também executado no workerd e consultado (§5).

## 3. Arquitetura recomendada para a Cloudflare

| Componente | Papel recomendado | Motivo |
|---|---|---|
| **Admin Web** e **Super Admin** (Next, 100% telas de cliente que chamam a API por HTTPS) | **Workers (OpenNext)** é tecnicamente viável; alternativa: manter no Google Cloud (compose) | sem SSR com dados, sem middleware, sem rota própria; a API é externa |
| **API** (Express, Prisma, workers BullMQ, agendador) | **NÃO em Workers** | processo Node de longa duração, conexões TCP a PostgreSQL e Redis, filas em processo; fica no Google Cloud |
| **PostgreSQL e Redis/BullMQ** | **NÃO na Cloudflare** | Workers não falam direto com o PostgreSQL/Redis do projeto; ficam atrás da API |
| **Domínio, DNS, HTTPS, proxy, proteção** | **Sim: DNS + proxy da Cloudflare** na frente de tudo (certificados, WAF, limitação de taxa) | independe de onde roda cada serviço |
| **Super Admin** | considerar **Cloudflare Access** (SSO/MFA de borda) na frente | superfície administrativa da plataforma |
| **PDV Electron / apps Android** | **nada** na Cloudflare | instalador/APK; falam com a API pela URL HTTPS |
| **Uploads/armazenamento** | não aplicável hoje (imagens e anexos ficam no banco, sob a API) | — |

## 4. O que foi executado e o resultado

| Etapa | Resultado | Onde |
|---|---|---|
| `opennextjs-cloudflare build` do Admin Web | **OK** (Windows, Node 22.14) | local |
| Pacote do Worker (`wrangler deploy --dry-run`) | **10,5 MiB, 2,1 MiB gzip** (173 arquivos de assets); limite do plano gratuito **3 MiB gzip**: **margem pequena** (pago: 10 MiB) | local |
| Admin Web no **workerd** (`wrangler dev --local`), API em `localhost:3001` como o papel de banco **sem posse e sem BYPASSRLS** | login pela tela (senha errada fica; certa entra, **CORS entre origens funcionou**), sessão no navegador, **21 rotas** sem erro de página/console, rota interna sem token volta ao login, **sair** funciona, 390 px sem rolagem horizontal, **VIEWER negado** em usuários; páginas dinâmicas `[id]` (cliente e produto) abrem (o único 404 é a imagem do produto, que não existe) | local, `docs/evidencias/2026-10-22-cloudflare-worker-local/` (não publicado) |
| Cabeçalhos entregues pelo Worker | CSP, HSTS, `X-Frame-Options`, `nosniff`, `Referrer-Policy`, `Permissions-Policy` **preservados**; `/_next/image` **404** | local |
| Workflow `cloudflare-homologacao.yml` (**runner Linux**, Node 22, sem segredos) para os **dois** apps | **aprovado** (build OpenNext, dry-run, workerd local, cabeçalhos, 404 do otimizador e de rota inexistente) | GitHub Actions, commit `1477fe1` |
| Primeira tentativa do workflow | **reprovou** nos dois apps: o OpenNext 1.20.13 **exige** `open-next.config.ts` (a documentação o chama de opcional) e o pacote resolvível; corrigido (arquivo nos dois apps + instalação `--no-save`) | commit `2607c80` → `1477fe1` |
| **Implantação de teste na Cloudflare** | **Executada em conta temporária (sem login), ver §10**: Admin Web e Super Admin publicados no edge e testados com a API real em HTTPS. **Implantação permanente: NÃO feita** (sem conta/credencial) | `wrangler deploy --temporary` |
| **Super Admin** no workerd | build e consulta básica **só no Linux (workflow)**; o fluxo funcional completo (login com TOTP) **não** foi repetido no Worker | — |

## 5. Requisitos atendidos × não atendidos

- **Atendidos:** versão do Next; Node/Wrangler; sem edge runtime/middleware/rota própria; pacote dentro do limite; CSP/HSTS preservados; login, sessão, CORS, rotas e permissões do Admin Web no workerd.
- **Não atendidos / não verificados:** deploy real; domínio próprio e HTTPS (os testes locais usam `http://localhost`); comportamento no edge (limites de CPU, cache de borda); Workers Builds (configuração do painel); Super Admin funcional completo no Worker; teste com a API pública em HTTPS (a API ainda não tem destino: Google Cloud pendente); monitoramento/logs do Worker.

## 6. Riscos de segurança e pontos de atenção

1. **A URL da API é fixada no build** (`NEXT_PUBLIC_API_URL`, `https://` obrigatório: o build recusa HTTP fora de localhost) **e entra na CSP** (`connect-src`). Trocar de API exige novo build.
2. **CORS da API**: a origem do Worker (`https://<nome>.<conta>.workers.dev` ou o domínio próprio) precisa estar em `WEB_URL`/`SUPER_ADMIN_URL` da API (produção). Sem isso o navegador bloqueia as chamadas.
3. **Sessão em `localStorage`** (JWT + refresh): o risco de XSS é o mesmo de hoje; a CSP tem `script-src 'unsafe-inline'` (decisão registrada no `next.config.js`).
4. **Cache:** as páginas pré-geradas saem com `Cache-Control: s-maxage=31536000`; após um deploy, confirmar que a borda serve a versão nova (não testado no edge).
5. **Nenhum segredo vai para o Worker** (só a URL pública da API em variável de build). Não colocar `.env` da API, senha de banco ou chave JWT no painel da Cloudflare.
6. **Dependências de build** (`@opennextjs/cloudflare` → `glob` 10.x: injeção de comando só pela CLI `-c`) entram no `npm audit` se forem adicionadas ao `package.json` (4 altas a mais, só de build). Por isso o adaptador **não** foi adicionado às dependências do projeto: é instalado no passo de build com versão fixada.
7. `workers.dev` expõe uma URL pública por padrão: desligar ou proteger (Access) para o Super Admin.

## 7. Serviços e custos adicionais

Plano gratuito de Workers: 100 mil requisições/dia e **3 MiB gzip por Worker** (o pacote tem 2,1 MiB). Plano pago: a partir de US$ 5/mês por conta (10 MiB gzip). Domínio próprio exige a zona na Cloudflare (DNS). Não são necessários R2, KV, D1 nem Images (o cache incremental e o otimizador de imagens ficam desligados). **Nenhum serviço foi contratado.**

## 8. Ações manuais que realmente continuam necessárias (painel da Cloudflare)

O Workers Builds continua **reprovando** a cada push até que isso seja feito. **Não apague o Worker nem desconecte o GitHub** se a ideia for usá-lo.

1. Painel → Workers & Pages → **cortex** → Settings → **Builds**.
2. **Root directory:** `apps/admin-web` (hoje `/`).
3. **Build command:** `npm install --no-save @opennextjs/cloudflare@1.20.13 wrangler@4.151.3 && npx opennextjs-cloudflare build`
4. **Deploy command:** `npx wrangler deploy`
5. **Variáveis de build:** `NEXT_PUBLIC_API_URL` = `https://<api>/api` (HTTPS real; para testes use um valor que não seja um domínio real), `NODE_VERSION` = `22`.
6. **Super Admin:** criar um Worker novo chamado **`cortex-super-admin`**, mesmo repositório, **Root directory** `apps/super-admin`, mesmos comandos, `NEXT_PUBLIC_API_URL` = `https://<api>` (o Super Admin acrescenta `/api`).
7. **Nome do Worker = `name` do `wrangler.jsonc`** (`cortex` e `cortex-super-admin`); divergência faz o build falhar.

**Atenção:** os itens 2 a 7 seguem a documentação oficial, mas **não foram executados no painel** (sem acesso). A forma como o Workers Builds instala as dependências quando a raiz é uma subpasta de um monorepo npm **não foi verificada**: se a instalação falhar, trocar o *Build command* por `cd ../.. && npm ci && cd apps/admin-web && npm install --no-save … && npx opennextjs-cloudflare build` e registrar o resultado aqui. Alternativa que dispensa o Workers Builds: desconectar o GitHub no painel e implantar pelo workflow com um token da Cloudflare em segredo do GitHub (a criar, com autorização).

## 10. Teste real no edge da Cloudflare (2026-10-22, tarde)

**Como foi feito, sem credencial e sem custo:** (a) `wrangler deploy --temporary` (Wrangler ≥ 4.102; documentado pela Cloudflare) cria uma **conta temporária** sem login, publica o Worker em `*.workers.dev` e a apaga em 60 minutos se ninguém a reivindicar (não reivindiquei); (b) a API rodou **na máquina local** (banco isolado descartável, dados sintéticos) **em modo de produção** (`NODE_ENV=production`, `TRUST_PROXY=1`, HTTPS obrigatório, MFA obrigatório, CORS só para as origens dos Workers, conectada ao banco como o papel **sem posse e sem BYPASSRLS**) e foi exposta **só ela** (porta 3001) por um **túnel rápido** `cloudflared` (`trycloudflare.com`, binário oficial 2026.10.3 com SHA-256 conferido), encerrado ao final. PostgreSQL e Redis **não** foram expostos. Os dois Workers foram construídos com `NEXT_PUBLIC_API_URL` apontando para o HTTPS do túnel.

**Resultados (URLs reais, navegador Chrome contra o edge da Cloudflare):**

| Verificação | Resultado |
|---|---|
| Publicação | Admin Web (`cortex`) e Super Admin (`cortex-super-admin`) publicados; pacote do Super Admin 7,4 MiB / **1,5 MiB gzip**; início do Worker 16 ms |
| Cabeçalhos entregues pelo edge (os dois apps) | `Content-Security-Policy` com `connect-src` só da própria origem e da API real, HSTS, `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy`; `/_next/image` 404: **6/6** |
| CORS da API (preflight) | origem do Admin Web **liberada**, origem do Super Admin **liberada**, origem desconhecida (`https://evil.example`) **não liberada**: **3/3** |
| Admin Web: login | senha errada recusada; administrador da empresa **sem MFA é levado à configuração do MFA (obrigatório em produção)**; código errado recusado; TOTP correto ativa e mostra os códigos de recuperação; chega ao `/dashboard`; **sair** encerra a sessão; rota interna sem sessão volta ao login; **no login seguinte exige o TOTP**; senha + TOTP entra |
| Admin Web: rotas autenticadas | rodada A (primeira conta temporária): 15 de 20 sem problema; as 5 restantes receberam **429/503 do próprio edge** quando a conta temporária passou a ser **limitada por taxa** ("This website has been temporarily rate limited"), não erro do app; rodada B (nova conta temporária, teste enxuto): **12/12 verificações de login e 6/6 rotas** (`/dashboard`, clientes, produtos, usuários, configurações, relatórios) sem erro de console nem resposta ≥ 400 |
| Super Admin | senha errada recusada; senha correta **pede o segundo fator**; TOTP errado recusado; **TOTP correto abre o console**; **16/16 rotas** sem erro de página/console; sair volta ao login; rota interna sem sessão volta ao login; **administrador de empresa não entra** no console |
| Permissões por papel (login real pela tela) | gerente e consulta (VIEWER) entram com senha; `/dashboard/users` mostra negação de acesso |
| Isolamento entre empresas e papéis (API pública HTTPS) | login por API dos três perfis 200; listas de clientes Alfa (2) × Beta (1) **sem sobreposição**; gerente da Beta lendo cliente da Alfa **404**; VIEWER criando cliente **403**; rota protegida sem token **401**: **5/5** |
| 390 px | `/login` do Admin Web e do Super Admin sem rolagem horizontal |

**Limites do teste (não esconder):** (1) as duas contas temporárias eram **diferentes** (o Super Admin foi validado na primeira, que expirou; o teste enxuto do Admin Web, na segunda); (2) a conta temporária impõe **limite de taxa** que a conta permanente não tem nesse formato, então a varredura completa de rotas autenticadas do Admin Web só foi concluída até onde o limite permitiu (15/20 + 6/6 em outra conta); (3) a API era a **minha máquina** atrás de um túnel sem garantia de disponibilidade: isso **não** é uma API de produção; (4) houve **HTTPS de ponta a ponta** (diferente dos testes locais em `http://localhost`), mas com subdomínios `workers.dev`/`trycloudflare.com`, não com domínio próprio; (5) sem carga, sem Access na frente do Super Admin; (6) dados sintéticos; (7) o MFA do administrador de demonstração foi reiniciado entre as rodadas (banco descartável). Evidências (capturas sem segredo; o enrolamento de MFA não é fotografado): `docs/evidencias/2026-10-22-cloudflare-real/` e `…-admin-lite/` (não publicadas).

**O que isso muda:** a hipótese "a Cloudflare é inviável para as telas" **caiu**: o que falta é conta permanente, API permanente (Google Cloud) e domínio, não compatibilidade técnica. **Por isso a alternativa Vercel + Neon não foi iniciada.**

**Recurso já existente no projeto:** `docker-compose.cloudflare.yml` + `deploy/Caddyfile.cloudflare` (idênticos em `Saas motos`) colocam a **pilha inteira** (API, Admin Web, Super Admin, Balcão) num **servidor com Docker** atrás da Cloudflare (proxy laranja, certificado de origem, SSL "Full (strict)", só IPs da Cloudflare chegam à origem; PostgreSQL e Redis nunca saem). **Não é um túnel** e exige servidor, domínio e certificado de origem; esta máquina não tem Docker. Serve ao desenho "tudo no mesmo servidor", não ao desenho "telas em Workers + API no Google Cloud". Não existe nada de Wrangler/OpenNext em `Saas motos`.

## 9. Como reproduzir

- **Linux, sem conta:** Actions → "Cloudflare (homologação do Worker, sem implantar)" → *Run workflow*.
- **Local:** em `apps/admin-web`, `npm install --no-save @opennextjs/cloudflare@1.20.13 wrangler@4.151.3`, `NEXT_PUBLIC_API_URL=http://localhost:3001/api npx opennextjs-cloudflare build`, `npx wrangler dev --local --port 8787`; a API precisa liberar `http://localhost:8787` (`DEV_CORS_ORIGINS`).
- Arquivos: `apps/*/wrangler.jsonc`, `apps/*/open-next.config.ts` (fora do `tsconfig.json`), `.github/workflows/cloudflare-homologacao.yml`.
