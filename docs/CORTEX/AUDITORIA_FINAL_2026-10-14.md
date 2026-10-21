# Auditoria final — Playwright, correções e prontidão (2026-10-14)

> Rodada de auditoria sobre o estado `e243ae1` (árvore limpa, branch `master`, sem remote). Tudo abaixo foi **executado**; o que não foi, está em "Não executado". Complementa [CURRENT_STATE](CURRENT_STATE.md), [DECISIONS](DECISIONS.md) e [SECURITY](SECURITY.md).

## 1. Inspeção inicial

| Item | Resultado |
|---|---|
| Git | `master`, `HEAD = e243ae1` (existe), árvore limpa, sem stash, **sem remote** (push impossível) |
| Aplicativos | `api`, `admin-web` (:3002), `super-admin` (:3000), `pdv-desktop` (web :5173 / Electron), `balcao` (:5174), `mobile`, `tv`, `hml`, `e2e` |
| Infra local | PostgreSQL 18 (`lnsystem_db`, 100 conexões, 9 em uso) e Redis no ar; nenhum servidor de aplicativo ligado no início |
| Playwright | já existia: `apps/e2e` com `playwright-core 1.63` + Chrome do sistema, 3 suítes (Suporte/Ajuda/PDV) e fixtures com limpeza por prefixo `[e2e]` — **estendido, não substituído**; lockfile intocado |
| Docker | sem daemon nesta máquina |

## 2. Playwright — execução e evidências

Servidores ligados um a um (API + o frontend do teste), Chrome headless único, execução sequencial (`--runInBand`), desligados ao fim. Dados de teste: empresa demo (`alfa`/`sandbox`); o que o teste cria leva `[e2e]` e é removido.

| Suíte (`apps/e2e/tests`) | Fluxos | Resultado | Evidências |
|---|---|---|---|
| `balcao-flow` | login errado e certo (tela), token em `sessionStorage` (na data desta auditoria; em 2026-10-14, depois, passou a só memória — ver [CONSOLIDACAO_FINAL](CONSOLIDACAO_FINAL.md)), busca vazia → cadastro de cliente, veículo, peça com **disponível** do servidor, serviço, **duplo clique cria 1 orçamento**, total = oficial do servidor, enviar → aprovar → abrir OS, ficha de encaminhamento (total oficial, "pagamento no caixa"), histórico por cliente/veículo, 390 px, VIEWER somente leitura, sair | **12/12** — também **12/12 atrás da CSP** do nginx (§4) | `docs/evidencias/2026-10-13-playwright/balcao/` (13 capturas) |
| `admin-web-flow` | login errado/certo, navegação pelo menu, validação do formulário de cliente, cadastro e listagem, produtos, orçamento novo, 390 px, VIEWER recusado pelo servidor | **9/9** (após a correção do rótulo do login) | `.../admin-web/` (9) |
| `super-admin-flow` | login errado, **MFA TOTP**, 8 módulos da plataforma, sair, usuário de empresa recusado nas rotas de plataforma | **6/6** | `.../super-admin/` (4) |
| `pdv-sale-flow` | caixa (abre se fechado), leitura por SKU, parcelas do crédito = divisão em centavos da API, **duplo clique em Confirmar cria 1 venda** | **6/6** (empresa **sandbox**; a venda é dado de teste, trilha financeira é append-only) | `.../pdv/` (4) |
| `support-*` (3 arquivos, já existiam) | Ajuda, Console, botões contextuais, PDV | **18/18** | — |

Caminhos reais das capturas: `docs/evidencias/2026-10-13-playwright/{balcao,admin-web,super-admin,pdv}/NN-nome.png` (a pasta leva a data de criação dos testes).
Observações visuais: capturas de página inteira de telas com cabeçalho fixo mostram o cabeçalho sobreposto (artefato da captura); o botão flutuante no canto inferior direito do Admin Web em desenvolvimento é o **TanStack Query Devtools**, que o pacote só renderiza em `NODE_ENV=development` (verificado em `node_modules/@tanstack/react-query-devtools`), não aparece em produção.

### Não executado (não declarar validado)
- **Mobile e TV** (Expo): sem aparelho/emulador Android nesta máquina — não há validação visual.
- **PDV Electron empacotado** (instalador, `safeStorage`, impressora, leitor): só a versão web do PDV foi exercitada.
- **Carga, estresse, flood, concorrência em volume, SIGTERM com tráfego, restauração em outro host**: proibidos localmente → **PENDENTE em staging**.

## 3. Defeitos encontrados e corrigidos (com teste de regressão)

| # | Problema | Causa | Correção | Regressão |
|---|---|---|---|---|
| 1 | **Leitura de código devolvia produto ao acaso**: um código que é o SKU de um produto e o código de barras de outro (ou o código de barras de dois ativos) respondia 200 com um deles | `findFirst` com `OR(sku, barcode)` sem ordem (`product.service.ts`) | entre os **ativos**, mais de um produto distinto → `409 CODE_AMBIGUOUS`; ativo vence inativo; ordem determinística (`isActive desc, createdAt, id`). O PDV já mostra a mensagem (409 não é silencioso) e cai na lista por nome | `product-code-resolution.integration.test.ts` (6): reproduzido (2 falhas) antes da correção |
| 2 | **Compras sem custo**: com a redação de `costPrice` (rodada anterior), um atendente/mecânico com **perfil de compras** perdia o custo e o pedido saía com custo unitário 0 | o filtro olhava só o papel, não a permissão | `purchases:manage`/`approve`/`receive` (por perfil) também veem o custo; VIEWER nunca | `balcao-api.integration.test.ts` (caso novo) |
| 3 | **Login do Admin Web inacessível**: `<label>` sem `for`/`id` (leitor de tela e `getByLabel` não achavam os campos); campo MFA sem rótulo | marcação | `htmlFor`/`id`, `autoComplete`, `aria-label` do código | `admin-web-flow` (reproduzido: 5 falhas em cascata) |
| 4 | **nginx do Balcão não enviava os cabeçalhos de segurança**: `add_header` dentro de `location` anula os do `server` | regra de herança do nginx; erro meu na rodada anterior | cabeçalhos só no `server`; cache por `expires`; **CSP** (§4) | provado por servidor equivalente + `balcao-flow` com checagem de violação de CSP; **nginx real não executado** |
| 5 | CI não construía a imagem do Balcão | omissão | passo no job `docker-build` | revisão estática (YAML válido) |

Investigados e **não** reproduzidos: erro de página `Invalid or unexpected token` em `/dashboard/customers` na primeira carga do `next dev` (não repetiu em 3 visitas; compatível com recompilação a quente); `403` em `/dashboard/channels` e em `/stock/availability` da empresa sandbox = **módulo desativado** por empresa (comportamento esperado; o Balcão mostra "—" e a mensagem).

## 4. Segurança — decisão 108 (token no navegador e CSP)

**Onde o token fica**

| Aplicativo | Armazenamento | Legível por JS injetado? |
|---|---|---|
| Admin Web | `localStorage` (`token`, `refreshToken`) | **sim** |
| Super Admin | `localStorage` (`accessToken`, `refreshToken`) | **sim** |
| PDV web (dev) | `localStorage` (`pdv-auth-storage`) | sim |
| PDV Electron | Electron `safeStorage` (DPAPI/Keychain), cai em `localStorage` fora do Electron | não no Electron; sim no navegador |
| **Balcão** | memória da página (antes `sessionStorage`; mudou na consolidação por poder ser restaurado pelo navegador) | sim, enquanto a aba vive |
| Mobile / TV | `expo-secure-store` (Keystore) | não |

**Risco real:** XSS (ou dependência comprometida) lê o `refreshToken` e mantém a sessão por dias fora do navegador. **Mitigações existentes:** React escapa por padrão; sem `dangerouslySetInnerHTML` nos fluxos de usuário (testado no suporte: HTML no assunto não executa); refresh com rotação e revogação; `X-Frame-Options: DENY`, `nosniff`, HSTS nos painéis; access token de 15 min.

**O que foi feito (compatível, sem migrar token nem contrato):**
- **Balcão:** CSP no nginx — `script-src 'self'` (bloqueia script injetado), `connect-src 'self' <origem da API>`, `frame-ancestors 'none'`, `object-src 'none'`. `style-src 'unsafe-inline'` é necessário (react-hot-toast cria `<style>`). A origem da API entra por `API_ORIGIN` (template do nginx). **Provado** num servidor com os mesmos cabeçalhos: fluxo completo 12/12 sem violação.
- **Admin Web e Super Admin: CSP NÃO adicionada.** O Next.js injeta scripts inline de hidratação e o layout tem script de tema inline; uma CSP estrita exige **nonce por requisição** (middleware do Next) e teste de regressão em todas as páginas. Uma CSP sem isso ou quebra o painel ou vira `unsafe-inline` (sem efeito contra XSS). Não foi improvisada.

**Alternativas e recomendação (decisão do dono — mudança arquitetural):**

| Opção | Efeito | Custo/risco |
|---|---|---|
| A. CSP com nonce no Next (middleware) mantendo `localStorage` | bloqueia execução de script injetado; mais barato | teste em todas as telas; scripts de terceiros (nenhum hoje) |
| B. `refreshToken` em cookie `HttpOnly; Secure; SameSite=Strict` (rota BFF do Next/proxy) e access token só em memória | XSS não rouba o refresh | muda o contrato de autenticação, CORS com credenciais, proteção CSRF, impacto em Mobile/TV/PDV que usam o mesmo endpoint |
| C. Reduzir a vida do access token e do refresh | reduz a janela | mais logins; não resolve |
| **Recomendação** | **A agora, B em seguida** (após A medir violações em modo `Report-Only`) | — |

Responsável: dono do produto + responsável de segurança. **Não declarado como garantido por testes estáticos**: a efetividade da CSP do nginx real só se confirma em staging.

## 5. Estoque, produtos e códigos de barras

Regras do dono × modelo atual (`Product`, `packages/database/prisma/schema.prisma`):

| Regra | Situação | Evidência |
|---|---|---|
| Identificador interno estável e imutável | **PARCIAL.** `id` (uuid) é imutável e é a chave de todas as relações; `sku` é único por empresa (`@@unique([companyId, sku])`) mas **editável** (`updateProductSchema` aceita `sku`) | schema; `pdv.validators.ts` |
| Vários códigos de barras por produto | **LACUNA.** Há um único `barcode String?`, **sem unicidade** por empresa | schema |
| Código de barras não substitui o interno; trocar/desativar não muda a identidade | **OK** (o `id` não muda); mas não há "desativar um código" (só limpar o campo) | — |
| Leitura resolve para o produto certo, respeitando empresa/filial | **CORRIGIDO** (§3.1); empresa isolada por RLS e `companyId` (teste: mesmo texto em duas empresas) | `product-code-resolution` |
| Unidade/embalagem na leitura | **LACUNA** — `unit` é texto livre, sem fator de embalagem | schema |
| Disponível = saldo − reservas | **OK** (`/stock/availability`, `StockReservation`) | `balcao-api` |
| Histórico preservado / sem exclusão física | **OK** (livro `stock_movements`; produto desativa) | — |

**Proposta (não aplicada — altera o modelo de identidade e exige migração com RLS e backfill; aguarda aprovação):** tabela `product_barcodes` (`id`, `companyId`, `productId`, `code`, `kind` EAN/GTIN/interno, `isActive`, `createdAt`, `unique(companyId, code)`, RLS `FORCE` + policy por `companyId`), backfill de `products.barcode` (duplicados legados ficam sinalizados para correção, não descartados), leitura por `code` ativo → produto; `products.barcode` mantido como "principal" por compatibilidade; `sku` passa a imutável após a primeira movimentação. Reversível (tabela aditiva).

## 6. Fiscal e tabela legada

- **A tabela fiscal legada citada no pedido não foi anexada** nem existe no repositório: **não foi analisada** e nenhum campo foi copiado. Quando vier, classificar cada coluna em: (1) cadastro fiscal do produto (NCM, CEST, origem, unidade tributável); (2) regra tributária (por UF/regime/operação, com vigência); (3) cálculo por operação/item (resultado, **nunca** no cadastro); (4) documento e emissão; (5) devolução e rastreabilidade de lote; (6) compatibilidade/importação legada.
- **Estado do código (verificado):** `Sale`, `SaleItem` e `Payment` **não** têm campo tributário (teste estático `domain-separation`); `FiscalConfig`/`FiscalDocument` por empresa/filial; o adaptador não configurado **não simula autorização da SEFAZ** (`unconfigured-adapter.ts`); IBS, CBS e Split Payment **não existem** (decisão 113).
- **Lacuna:** não há cadastro fiscal do **produto** (NCM/CEST/origem) — hoje a emissão depende do que a operação informa. Implementar exige a tabela legada, a fonte oficial das regras e o provedor/adaptador.

## 7. Decisões 109 a 117 — quadro

Estado, impacto e recomendação por decisão. **Nenhuma recomendação virou regra**; o responsável é sempre o dono do produto, com o apoio indicado.

| # | Estado atual (implementado) | Impacto operacional | Risco | Alternativas | Recomendação | Quem decide |
|---|---|---|---|---|---|---|
| 109 Perfis que exigem equipamento | mecanismo pronto (`devices.requiredUserTypes`), **padrão vazio** | enquanto vazio, caixa opera sem equipamento autorizado | máquina não registrada vende | listar OPERATOR (+ MANAGER) por empresa | ligar OPERATOR **depois** de registrar todos os PDVs da empresa (ordem: registrar → autorizar → ligar) | dono + operação |
| 110 Corte do legado id/MAC | conjunto fechado + corte **31/12/2026 23:59:59 (Brasília)**, `DEVICE_LEGACY_CUTOFF`, igual em código/docs/`.env.example` | máquinas antigas pedem novo registro após a data | trabalhar com id clonável até o corte | antecipar a data; manter | manter a data e **antecipar** para 30 dias após o último PDV registrado | dono |
| 111 Portão no Mobile/TV | **não** têm portão (só política + HTTPS) | tablet/TV não precisam de autorização | baixo (não operam caixa) | tratar como equipamento; manter | manter sem portão; reavaliar se TV exibir dado sensível | dono |
| 112 Balcão em equipamento autorizado | Balcão **não** tem portão (não opera caixa) | qualquer navegador logado atende | exposição de cadastro/orçamento em máquina não autorizada | exigir autorização como o PDV; sessão curta | exigir só se a empresa tratar cadastro de cliente como sensível; reutiliza `/api/device/*` | dono |
| 113 IBS/CBS/Split | **inexistente** (nada parcial) | sem cálculo da Reforma | emitir fora da regra | aguardar regulamentação/provedor | manter bloqueado; modelar só com fonte oficial | dono + contador |
| 114 Cronograma de recebimento do cartão | pagamento grava total e nº de parcelas; **não vira recebível por parcela** | conciliação do cartão é manual | divergência com a adquirente | recebível por parcela com taxa/antecipação | implementar após escolher adquirente/PSP | dono + financeiro |
| 115 Balcão → PDV como "venda aguardando pagamento" | **ficha de encaminhamento** (copiar/imprimir) com o total oficial; nada é criado | caixa redigita/localiza o atendimento | erro de digitação; preço mudar entre atendimento e cobrança | entidade com idempotência, validação de preço/disponível, **expiração** | só depois de definir estado, expiração e reserva de estoque | dono + arquiteto |
| 116 Distribuição do Balcão | SPA estática (nginx), aberta no navegador | sem ícone/offline | depende do navegador do balcão | PWA (instalável, HTTPS, atualização automática); wrapper Electron (como o PDV); APK (só se houver tablet) | **PWA** primeiro (menor manutenção, mesma API); Electron só se precisar de impressora/leitor local | dono |
| 117 Parcela de R$ 0,00 | **recusada** (`INSTALLMENT_TOO_SMALL`: cada parcela ≥ R$ 0,01) | R$ 0,01 em 3x não parcela | título sem valor, divergência com adquirente | permitir com parcelas zeradas; manter recusa | **manter a recusa** | dono + financeiro |

**Parcelamento (preservado):** 100/3 = 33,33 + 33,33 + 33,34; 10/3 = 3,33 + 3,33 + 3,34; 100,01/3 = 33,33 + 33,34 + 33,34; mesma função em API e PDV (a captura `pdv/03-pagamento-credito-parcelas.png` mostra "3x de R$ 3,33 (última de R$ 3,34)" para R$ 10,00).

## 8. Infraestrutura

| Item | Estado |
|---|---|
| `Dockerfile`/nginx do Balcão, `balcao` no compose e no staging/Caddy, `API_ORIGIN`, CI | **prontos e revisados estaticamente** (YAML válido; cabeçalhos conferidos); **não executados** (sem Docker) |
| HTTPS, domínio, certificados, 426 em HTTP | **pendente de infraestrutura** (código e testes locais prontos) |
| Health/readiness | `/api/health/{live,ready}` respondem localmente |
| Backup/restore | `backup:verify` provou restauração em **banco temporário na mesma instância** (18/18, 2026-10-06); **restauração em ambiente separado: pendente** — não considerar validado |
| CI remoto | nunca executado (sem remote) |

## 9. Próximas ações

**Locais (já posso fazer):** nonce de CSP em modo `Report-Only` nos painéis; tabela `product_barcodes` (após sua aprovação); cadastro fiscal do produto (após a tabela legada).
**Dependem de você:** anexar a tabela fiscal legada; decisões 109–117; escolher distribuição do Balcão.
**Dependem de infraestrutura:** staging com Docker/domínio/HTTPS; smoke de dispositivo; carga/estresse; restauração em outro host; execução do CI; Mobile/TV em aparelho.
