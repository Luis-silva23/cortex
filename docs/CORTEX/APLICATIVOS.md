# CÓRTEX — Aplicativos: o que existe, o que cada um faz e o que NÃO faz (atualizado em 2026-10-13)

> Levantamento feito no código (pacotes, `app.json`, `electron-builder`, telas, rotas, chamadas à API, dependências). Complementa [CODE_MAP](CODE_MAP.md) e [DISPOSITIVOS](DISPOSITIVOS.md).
>
> **Histórico da pergunta "o PDV é o Balcão? existe aplicativo Balcão?".** Em 2026-10-06 o diagnóstico concluiu, com o que o repositório tinha, que o Balcão era só um fluxo no Admin Web. **Em 2026-10-13 a decisão de produto foi outra e este documento a substitui:** o **Balcão é um aplicativo próprio** (`apps/balcao`), separado do PDV e do Web/Admin. As frases "o Balcão é o PDV Desktop" e "não existe aplicativo Balcão" estão **superadas** e não valem mais.

## 1. Mapa dos aplicativos (separação de responsabilidades)

| Aplicativo | Papel | Quem usa | O que faz | O que NÃO faz |
|---|---|---|---|---|
| **PDV Desktop** (`apps/pdv-desktop`) | **Caixa / frente de loja** | operador de caixa | abrir/fechar caixa, vender, receber pagamento, sangria, cancelar/devolver com autorizador, convênio | atendimento (orçamento/OS/veículo) |
| **Balcão** (`apps/balcao`) | **Atendimento** | balcão/oficina (OPERATOR, MANAGER, COMPANY_ADMIN, SUPER_ADMIN, MECHANIC escrevem; VIEWER só lê) | identificar cliente, ver/cadastrar veículo, consultar produto e **disponível** em estoque, criar/enviar/registrar decisão do orçamento, converter em OS, acompanhar OS, histórico por cliente/veículo, **encaminhar ao caixa** | **cobrar**, abrir caixa, criar venda/pagamento/movimento de caixa, calcular parcela, dado tributário, ver custo de produto |
| **Web/Admin** (`apps/admin-web`) | **Administração e gestão web** | gerência, administrativo, contabilidade | cadastros, estoque, compras, financeiro, fiscal, dashboard, canais, relatórios | ser o PDV ou o Balcão |
| **Super Admin** (`apps/super-admin`) | **Plataforma** | operação do produto (TI) | empresas, licenças, dispositivos (fila de autorização), backup, auditoria, observabilidade | rotina da empresa |
| **Mobile** (`apps/mobile`) | **Mecânico / equipe** | mecânico | agenda e ordens de serviço | caixa, atendimento de balcão |
| **TV** (`apps/tv`) | **Painel da oficina** | oficina/loja | leitura de agenda/OS | qualquer escrita |

Todos falam com **a mesma API** (`apps/api`): não há banco, regra de negócio, estoque, cálculo financeiro ou venda paralelos em nenhum cliente. O backend é a autoridade (RBAC, RLS por empresa/filial, auditoria).

## 2. Inventário técnico

| Projeto (`apps/`) | O que é | Identificador de build | Telas / rotas | API que consome | Autorização de equipamento |
|---|---|---|---|---|---|
| `api` | API Express (+ workers BullMQ, agendador) | imagem Docker | `/api/*`, `/commerce/v1`, `/integrations/v1` | — | rotas `/api/device/*`; portão no login; guarda de caixa |
| `admin-web` | Console da empresa (Next.js, :3002) | imagem Docker | `app/dashboard/*` | `/api/*` (lê e cancela vendas; **não cria** venda, pagamento nem movimento de caixa) | não (navegador; login por e-mail + MFA) |
| `super-admin` | Console da plataforma (Next.js, :3000) | imagem Docker | `app/dashboard/*` | `/api/*` | não (navegador) |
| **`pdv-desktop`** | **PDV / frente de caixa** (Electron + Vite/React) | `appId com.lnsystem.pdv`, `productName "LN System PDV"` | `/login`, `/pos`, `/cash-register`, `/sales`, `/settings` | `/api/auth/*`, `/api/sales`, `/api/payments`, `/api/cash-register/*`, `/api/products`, `/api/customers`, `/api/policies/effective`, `/api/payment-settings`, convênios, `/api/telemetry`, `/api/support/tickets` | **sim** (`DeviceGate`) |
| **`balcao`** | **Aplicativo de atendimento** (Vite + React + TS, SPA estática, :5174) | pacote `@ln-system/balcao`; imagem Docker (nginx) em `apps/balcao/Dockerfile` | `/login`, `/` (atendimento), `/clientes/:id`, `/veiculos/:id`, `/produtos`, `/orcamentos`, `/orcamentos/novo`, `/orcamentos/:id`, `/os`, `/os/:id` | `/api/auth/*`, `/api/customers`, `/api/motorcycles`, `/api/products`, **`/api/stock/availability`**, `/api/quotes*`, `/api/service-orders*`, `/api/sales` (**só leitura**: histórico), `/api/branches` | não (ver §4) |
| `mobile` | App do mecânico (Expo/React Native) | `package com.lnsystem.mobile` | `LoginScreen`, `MfaScreen`, `HomeScreen`, `AgendaScreen`, `ServiceOrdersScreen`, `ServiceOrderDetailScreen` | `/api/auth/*`, `/api/appointments`, `/api/service-orders` | não (pendência 111) |
| `tv` | Painel da oficina (Expo + TV) | `package com.lnsystem.tv` | `LoginScreen`, `MfaScreen`, `PainelScreen` | `/api/auth/*`, leitura de agenda/OS | não (pendência 111) |
| `hml`, `e2e` | **ferramentas** (homologação, testes de navegador): não são aplicativos | — | — | — | — |

`mobile` e `tv` são projetos **Expo gerenciados**: não há `android/`, `AndroidManifest.xml`, `build.gradle` nem APK gerado (o pacote só nasce no build do Expo/EAS, que não roda aqui). O Balcão **também não tem APK**: é web — empacotamento = decisão 116.

## 3. Balcão — o que é e como funciona

**Fluxos entregues** (todos contra a API oficial; provados em [balcao-api.integration.test.ts](../../apps/api/test/integration/balcao-api.integration.test.ts), 10 testes em PostgreSQL/Redis reais):

1. **Identificar cliente** — busca por nome/documento/telefone; cadastro rápido (só o nome é obrigatório); estatísticas e histórico.
2. **Veículo** — lista por cliente, cadastro, histórico de OS e orçamentos por veículo (`GET /api/service-orders?motorcycleId=`).
3. **Produto e estoque** — busca por nome/SKU/código de barras; **disponível** = saldo − reservas vivas (`GET /api/stock/availability`, por filial, nunca o saldo físico cru); **o custo não aparece** para quem não é gestão (a API remove `costPrice` para OPERATOR/MECHANIC/VIEWER).
4. **Orçamento** — criar (itens de produto e serviço, desconto), enviar, registrar decisão (aprovar/recusar), nova versão; **um orçamento aberto por cliente/veículo** (a API devolve `OPEN_QUOTE_EXISTS` com o id existente e o app leva até ele). A prévia do total na tela usa aritmética em centavos; **o total oficial é o do servidor**.
5. **Ordem de serviço** — converter o orçamento aprovado em OS, acompanhar status, itens e histórico (cliente/veículo).
6. **Encaminhar ao caixa** — "ficha de encaminhamento" (copiar/imprimir) com cliente, veículo, itens e **o total oficial do servidor**. O PDV recebe pelo fluxo dele; o Balcão não cria venda. Importação automática no PDV = **decisão 115**.

**Garantias de projeto**

- Identidade própria (`X-Client-Source: BALCAO`, sessão **só em memória** (2026-10-14; recarregar exige login), [.env.example](../../apps/balcao/.env.example)); sessão com refresh em *single-flight*; MFA no login.
- Endereço da API fixado no build (`VITE_API_URL`); em produção **recusa abrir** se não for `https://` (mesma função do PDV: `packages/shared/utils/server-url.ts`).
- Estados de carregando/erro/vazio/sucesso em todas as telas; ações protegidas contra duplo envio (`useSubmitOnce`); a API também protege (um orçamento aberto por cliente/veículo; conversão idempotente).
- Sem campo tributário, sem cobrança, sem caixa — **verificado por teste estático** ([domain-separation.test.ts](../../apps/api/src/architecture/domain-separation.test.ts): o Balcão não chama escrita em `/payments`, `/cash-register`, `/sales`, `/fiscal`, não tem termo tributário e não importa o PDV; o PDV não importa o Balcão).
- Dicas por papel na tela (`lib/permissions.ts`) **não são autorização**: o backend segue recusando (403).

**Relação com os outros**

| Com | Relação |
|---|---|
| PDV Desktop | **Vizinhos, nunca acoplados.** Nenhum importa o outro. O Balcão termina no "encaminhar"; a cobrança é do PDV. |
| Web/Admin | O Admin Web **mantém** a gestão (cadastros, relatórios, finanças) e continua tendo orçamento/OS para a gerência; o Balcão é a frente rápida de atendimento. Mesmas rotas e regras: o que um grava, o outro lê. |
| Mobile / TV | O mecânico segue na agenda/OS do Mobile; a OS criada no Balcão aparece lá (mesma entidade). |

## 4. Equipamento autorizado × Balcão

A política `devices.requiredUserTypes` ([DISPOSITIVOS](DISPOSITIVOS.md)) protege **operações de caixa** (abrir/fechar caixa, movimento, venda, pagamento). O Balcão **não executa nenhuma delas**, então não tem portão de equipamento e **não** enrola equipamento. Se o dono decidir que o Balcão também deve rodar só em máquinas autorizadas, a infraestrutura (`/api/device/*`, `DeviceSession`) já existe e é reaproveitável — **decisão 112 (reescrita)**; nada foi inventado.

## 5. Respostas objetivas (histórico + estado atual)

1. **PVD/PDV:** "PVD" é a grafia de PDV. O **PDV** é `apps/pdv-desktop` — a frente de caixa.
2. **Existe aplicação Balcão?** **Sim, desde 2026-10-13: `apps/balcao`.** Antes existia só como fluxo (Admin Web), perfil (OPERATOR, decisão 15) e rótulo do catálogo de suporte.
3. **Existe APK Balcão?** **Não** (nem para Mobile/TV há APK no repositório: são Expo). O Balcão é uma SPA web; empacotamento (PWA/APK/wrapper) = decisão 116.
4. **`apps/pdv-desktop` é o Balcão?** **Não.** É o PDV (caixa).
5. **Código de Balcão misturado ao PDV?** **Não** — separação provada por teste.
6. **Compartilhado:** `packages/shared` (tipos, validadores zod, `utils/{token,password,email,secret-box,validation,installments,server-url}`) e `packages/database` (Prisma, só na API). Sem biblioteca de UI compartilhada. PDV e Balcão importam os `.ts` do shared por alias do Vite (o `.js` ao lado é CommonJS).
7. **APIs específicas:** PDV → `/api/cash-register/*`, `/api/payments`, `/api/payment-settings`, `/api/telemetry`; **Balcão → `/api/stock/availability`, `/api/quotes*`, `/api/service-orders*`**; mobile/TV → `/api/appointments`, `/api/service-orders`; Super Admin → `/api/activations/*`, `/api/licenses`, `/api/companies`, `/api/backup/*`; equipamento → `/api/device/*`.

## 6. Pendências do Balcão

| Item | Situação | Natureza |
|---|---|---|
| Importar o encaminhamento direto no PDV (sem copiar/imprimir) | **decisão 115** — exigiria uma entidade "venda aguardando pagamento" que o modelo não tem | 🟣 decisão de produto |
| Empacotar (PWA/APK/Electron) | **decisão 116** | 🟣 decisão de produto |
| Portão de equipamento no Balcão | **decisão 112** (a infraestrutura existe) | 🟣 decisão de produto |
| Imagem Docker/nginx e HTTPS (`balcao.<domínio>`) | pronto no repositório, **não executado** (sem Docker/domínio na máquina de desenvolvimento) | 🟡 infraestrutura |
| Perfil "Balcão" distinto de "Caixa" (hoje ambos OPERATOR) | decisão 15 | 🟣 decisão de produto |
