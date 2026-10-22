# Cloudflare — homologação do Admin Web e do Super Admin em Workers (2026-10-22)

> **Estado: NÃO homologado para produção e NADA implantado.** Comprovado: a causa da falha do Workers Builds; o build com o adaptador OpenNext (Windows e Linux); o pacote do Worker; a execução no runtime do Workers (workerd, local) com login, sessão, CORS, rotas e permissões do Admin Web. **Não** comprovado: implantação real, domínio/HTTPS reais, o comportamento no edge da Cloudflare e a configuração do painel do Workers Builds (sem acesso ao painel e sem credencial nesta sessão). O destino de implantação continua sendo o Google Cloud ([GOOGLE_CLOUD](GOOGLE_CLOUD.md)); a Cloudflare é uma opção para as telas web e para o DNS/HTTPS.

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
| **Implantação de teste na Cloudflare** | **NÃO executada**: sem credencial/conta nesta sessão (e sem autorização para criar recursos) | — |
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

## 9. Como reproduzir

- **Linux, sem conta:** Actions → "Cloudflare (homologação do Worker, sem implantar)" → *Run workflow*.
- **Local:** em `apps/admin-web`, `npm install --no-save @opennextjs/cloudflare@1.20.13 wrangler@4.151.3`, `NEXT_PUBLIC_API_URL=http://localhost:3001/api npx opennextjs-cloudflare build`, `npx wrangler dev --local --port 8787`; a API precisa liberar `http://localhost:8787` (`DEV_CORS_ORIGINS`).
- Arquivos: `apps/*/wrangler.jsonc`, `apps/*/open-next.config.ts` (fora do `tsconfig.json`), `.github/workflows/cloudflare-homologacao.yml`.
