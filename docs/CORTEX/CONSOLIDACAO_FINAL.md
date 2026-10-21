# Consolidação final — PDV Desktop, sessão do operador, parcelamento e integrações (2026-10-14)

> Base: `e243ae1` + a auditoria de [AUDITORIA_FINAL](AUDITORIA_FINAL_2026-10-14.md). Tudo marcado **COMPROVADO** foi lido no código ou executado; **NÃO VERIFICADO** diz o que falta. Sem commit nem push.

## 1. O que já estava implementado e foi preservado (COMPROVADO por leitura do código)

- **PDV Desktop** (`apps/pdv-desktop`, Electron + React): caixa, venda, pagamento, convênio, devolução com autorizador, parcelas em centavos, telemetria, suporte, `DeviceGate` (registro → autorização do administrador → login com id + chave), impressão por IPC, endereço do servidor fixado no build com recusa de HTTP em produção. Todo valor, estoque e pagamento é decidido pela API; o aplicativo só guarda em cache busca de produto/cliente (`offline.service.ts`) — **venda, pagamento e caixa nunca são enfileirados** nem simulados em falha de rede (mensagem "a operação NÃO foi concluída").
- **Backend:** RLS por empresa/filial, RBAC, auditoria, sessões presas ao equipamento (`dsid`), revogação de access token (Redis) e refresh com rotação e detecção de reuso, `devices.requiredUserTypes` (padrão vazio), corte do legado id/MAC.
- **Estoque/produtos:** livro de movimentos, disponível = saldo − reservas, transferências, desativação em vez de exclusão, resolução de código **sem escolha arbitrária** (409 `CODE_AMBIGUOUS`, rodada anterior).
- **Parcelamento:** divisão em centavos única (API + PDV), política por empresa/filial/forma de pagamento, padrão 1x.
- **Fiscal:** adaptador não configurado nunca simula autorização; IBS/CBS/Split inexistentes.

## 2. O que foi corrigido nesta consolidação

| # | Problema (reproduzido) | Correção | Prova |
|---|---|---|---|
| 1 | **O PDV restaurava a sessão do último operador ao reabrir** (zustand `persist` em `safeStorage`): num computador de loja, quem abrisse o aplicativo herdava a identidade e o caixa de quem saiu | sessão **só em memória**; legado `secure-pdv-auth-storage.dat`/`pdv-auth-storage` apagado na 1ª abertura | E2E: recarregar → login, sem chave de sessão em nenhum storage |
| 2 | **Fechar a janela não encerrava a sessão** no servidor | processo principal segura o `close`, o renderer revoga (`POST /auth/logout`) e libera; prazo de segurança 4,5 s | smoke do Electron real: janela fecha em 4 ms pelo handshake |
| 3 | **Logout sem rede perdia a revogação** (uma tentativa, falha descartada) | fila mínima do refresh token, cifrada pelo SO, reenviada na abertura e quando a rede volta; **nunca** usada para autenticar | `session-revocation.test.ts` (8) |
| 4 | **Não existia "bloquear a tela"** | `Bloquear tela` → nada do PDV é renderizado; desbloqueio exige a **própria senha**, conferida no servidor (`POST /api/auth/reauthenticate`, 3 erros/5 min, auditado, sem sessão nova) | `reauthenticate.integration.test.ts` (5) + E2E |
| 5 | **Após queda do PDV o operador ficava trancado fora** (a sessão de equipamento ativa dava `DEVICE_BUSY` até o encerramento administrativo — antes mascarado pela restauração da sessão) | o **mesmo** operador, com senha + chave do equipamento, substitui a própria sessão presa (`SUPERSEDED_BY_RELOGIN`, renovações revogadas); **outro** operador segue `DEVICE_BUSY` | `device-authorization.integration.test.ts` (+2) |
| 6 | **Sair do Balcão/Admin Web/Mobile derrubava o PDV** do mesmo usuário (logout encerrava todas as sessões de equipamento do usuário) | logout encerra só a sessão de equipamento **do refresh token que saiu** | idem |
| 7 | **Balcão guardava a sessão em `sessionStorage`**, que o navegador restaura ("reabrir abas") | sessão só em memória (igual ao PDV) | E2E do Balcão (13) |
| 8 | **Instalador do Windows referenciava `public/icon.ico`, que não existe** | referência removida (ícone de marca é pendência de ativo, não inventado) | busca no repositório: nenhum `.ico` |
| 9 | A tela de parcelamento chamava de "Sem juros" um campo que **nenhum cálculo usa** | aviso explícito na tela (não há juros) | leitura do serviço e do `payment.service` |
| 10 | Smoke do Electron anterior ao `DeviceGate` (reprovaria o app correto) | reconhece a tela do portão, diz o que NÃO foi verificado, e agora testa o fechamento | execução real |

## 3. Autenticação do PDV — comportamento real

| Situação | O que acontece | Estado |
|---|---|---|
| **Entrar** | identificador numérico + senha (+ MFA se ligado) + id/chave do equipamento; o servidor decide | COMPROVADO |
| **Bloquear a tela** | sessão continua; telas desmontadas; só a **própria** senha desbloqueia (servidor); "Sair da conta" disponível; carrinho/pagamento em andamento não se perdem | COMPROVADO (E2E) |
| **Sair da conta** | store zerado na hora (carrinho, caixa em memória e pagamento em andamento limpos), `replace` para o login (voltar não reabre), refresh token revogado no servidor, sessão de equipamento encerrada; **não fecha o caixa** | COMPROVADO |
| **Fechar a janela / Alt+F4 / encerramento do SO** | mesmo encerramento acima antes de fechar (até 4,5 s; depois fecha mesmo assim) | COMPROVADO no Electron real; **encerramento do Windows não executado** |
| **Reiniciar o computador / reabrir** | nada restaurado; cada operador faz login; fila de revogação pendente é reenviada | COMPROVADO (E2E de recarga; reinício real não executado) |
| **Kill do processo / queda de energia** | nada é executado; o token só existia na memória do processo morto (inutilizável); a sessão de equipamento fica ativa até o **mesmo** operador entrar de novo (substitui) ou um administrador encerrar; refresh expira por vez | COMPROVADO (integração) |
| **Sem rede ao sair** | acesso local cai de imediato; revogação fica na fila e é reenviada | COMPROVADO (unidade); rede real não simulada |
| **Token expirado/revogado/equipamento bloqueado** | 401 → refresh recusado → logout local e login | COMPROVADO (testes anteriores `logout-revokes-access`, `device-authorization`) |
| **Fechamento do caixa** | só pela tela Caixa (operação financeira); sair/fechar nunca o executa. Venda/cobrança pendente permanece no servidor; outro operador **não** assume a identidade (precisa autenticar-se); recuperação por usuário autorizado | COMPROVADO por leitura; sem teste automatizado dedicado |
| **Acesso autenticado offline** | **não existe** (não implementado; depende de decisão — 118) | — |
| **Logs** | `reauthenticate` e logout não gravam senha nem token; auditoria guarda só o motivo | COMPROVADO por leitura |

Limites honestos: (a) a sessão **no servidor** de um processo morto só some quando o mesmo operador reentra, um administrador encerra ou o refresh expira (7 dias por padrão); (b) a fila de revogação guarda o refresh token cifrado pelo SO — é o preço de poder revogar depois; fora do Electron (navegador de desenvolvimento) nada é guardado; (c) o bloqueio é por ação do operador — **não há bloqueio automático por inatividade** (não pedido, não inventado).

## 4. PDV Desktop — instalação e configuração

- **Build** (numa máquina Windows, com o endereço oficial): `VITE_API_URL=https://api.<domínio> npm run build --workspace=@ln-system/pdv-desktop` (`tsc` + `vite build` + `electron-builder`; NSIS x64 e ia32, instalação por usuário padrão do `electron-builder`). O endereço é **fixado no build**; em produção o aplicativo **recusa abrir** com HTTP, endereço ausente ou credencial na URL. Não há campo para o operador editar o servidor.
- **Primeira execução:** o aplicativo se registra (equipamento PENDENTE, código de conferência) → o Super Admin vincula licença e filial → o aplicativo passa a autorizado e libera o login. A chave do equipamento fica no `safeStorage` do SO.
- **NÃO VERIFICADO / PENDENTE:** o instalador **nunca foi gerado** nesta máquina (`dist-installer` inexistente; `electron-builder` precisa baixar binários e, para publicar, de certificado de assinatura — nenhuma configuração de assinatura); **não há atualização automática** (sem `electron-updater`): atualizar = reinstalar a nova versão; ícone de marca não existe (usa o padrão do Electron); execução do instalador numa máquina de loja não foi feita.

## 5. PDV e Balcão no mesmo computador

| Tema | Comportamento (COMPROVADO) |
|---|---|
| Instalação | PDV = aplicativo instalado; Balcão = página web (`https://balcao.<domínio>`) no navegador do mesmo computador; nenhum exige hardware extra |
| Sessões | **separadas**: tokens diferentes, nenhum compartilha memória; entrar ou sair de um não entra nem sai do outro |
| Permissões | cada um passa pelo RBAC do servidor; o login do Balcão não concede caixa (o Balcão não chama escrita de pagamento/caixa/venda — teste estático) |
| Equipamento | só o PDV tem portão de equipamento (decisão 112 para o Balcão) |
| Logout cruzado | **corrigido**: sair do Balcão não encerra a sessão do PDV do mesmo usuário |
| Dados residuais | PDV e Balcão guardam sessão só em memória; sair zera. O Balcão não usa mais o `sessionStorage` para a sessão |
| Mesmo operador nos dois | permitido (sessões independentes); o PDV mantém a regra "um usuário, um equipamento" |

## 6. Parcelamento — o que existe e o que falta

| Item pedido | Estado (código lido) |
|---|---|
| Número máximo de parcelas | **EXISTE** — `InstallmentPolicy.maxInstallments` |
| Formas de pagamento autorizadas | **EXISTE** — uma política por forma (`paymentMethod`); sem política = 1x |
| Empresa e filial | **EXISTE** — política da filial vence a da empresa; unicidade por (empresa, filial, forma) |
| Permissões / auditoria | **EXISTE** — só COMPANY_ADMIN/SUPER_ADMIN alteram; auditado. **Não existe** aprovação por segunda pessoa |
| Vigência | **NÃO EXISTE** (só `isActive`) |
| Taxa de juros, base de cálculo, "a partir de qual parcela" | **NÃO EXISTE.** `interestFreeInstallments` é guardado e **não é usado por nenhum cálculo**; o total cobrado é o da venda, dividido em centavos (resíduo nas últimas parcelas). Portanto **não há fórmula de juros** (nem por parcela, nem mensal) para documentar |
| Vendas já concluídas | não são alteradas: a política só é consultada ao criar o pagamento (`validateInstallments`) |
| Cobrança conforme adquirente | **fora do que existe**: cartão é `MANUAL` (operador confirma na maquininha); sem PSP/TEF e sem cronograma de recebimento (decisão 114) |

Para ter juros é preciso **decidir** o modelo (quem paga a taxa: loja ou cliente; tabela por parcela ou taxa mensal composta; base = total ou saldo; arredondamento), a vigência e a aprovação — **decisão 119**. Nenhum percentual foi inventado; a política inicial segue 1x.

## 7. Conectores — inventário real

| Integração | Estado no código | Estados visíveis | Depende de |
|---|---|---|---|
| Pagamento (TEF/PSP/PIX) | `registerPaymentProvider`: só `MANUAL`; PIX fica PENDING honesto; provedor configurado e não registrado **falha antes de cobrar** | PENDING / recusa explícita | contrato com adquirente + adaptador |
| Fiscal | `unconfigured-adapter`: nunca simula autorização; `FiscalConfig` por empresa/filial com segredos `enc:v1` | não configurado × configurado | provedor/certificado + regras (113) |
| E-mail/notificações | `EmailNotConfiguredProvider`: resultado `NOT_CONFIGURED` ("e-mail NÃO enviado"), mesmo com `SMTP_HOST`; nenhum transporte instalado | `NOT_CONFIGURED` | provedor SMTP/SES + transporte |
| Canais comerciais (Commerce API) e Integration Gateway | credencial de canal HMAC, reservas, outbox, provedor **sandbox** (só fora de produção) | por canal: ativo/desativado, falhas na outbox | provedor real + decisões 82–99 |
| Observabilidade | `/api/observability/integrations` (estatística de tentativas, não "estado de conexão") | — | — |
| GitHub / CI | `ci.yml` pronto; **sem remote** configurado | — | repositório remoto e autorização |
| Armazenamento externo, SSO, monitoramento externo | **inexistentes** | — | necessidade comprovada |

**Estados "não configurada / configurada / conectada / falha de autenticação / indisponível":** existem de forma **parcial e por integração** (acima); **não há um registro único** de integrações com esses cinco estados. Criar um agora seria uma tela/serviço sem provedor por trás — **não foi criado** (regra do pedido). Variáveis: nenhuma credencial foi adicionada ao repositório; `SMTP_*` (declarada, sem transporte) e `FISCAL_STORAGE_PATH` são as únicas lidas; novas entram no `.env.example` junto com o adaptador real.

## 8. Uma empresa agora, várias depois (COMPROVADO)

Isolamento já é multiempresa/multifilial no banco (RLS `FORCE` com `db:check-rls` OK), no token (`companyId` nunca vem do corpo), no cache (chave com escopo) e nos testes de integração entre empresas. Nada precisa ser reconstruído para a segunda empresa. **Escalabilidade futura (documentada, não contratada):** banco → réplica de leitura e PITR gerenciado; aplicação → N instâncias (já sem estado; workers com `jobId` fixo); filas/cache → Redis gerenciado separado para fila e para cache; arquivos fiscais/anexos → armazenamento de objetos; monitoramento → coletor externo sobre `/api/health/*` e `/api/observability/*`. Nada disso é necessário para a implantação inicial.

## 9. Pendências que impedem a produção

1. **Infraestrutura (externa):** domínio, DNS e **HTTPS real**; Docker/staging executado; PostgreSQL e Redis gerenciados, segredos no cofre, `TRUST_PROXY`; **restauração de backup em outro ambiente**; CI remoto executado.
2. **PDV Desktop:** gerar e instalar o instalador numa máquina de loja; assinatura de código; ícone de marca; atualização (sem auto-update).
3. **Segurança:** CSP com nonce nos painéis (108); revisão da senha do bloqueio para quem tem MFA (hoje só senha).
4. **Operação:** testes pesados em staging (carga, estresse, SIGTERM com tráfego); Mobile e TV em aparelho.

## 10. Decisões aguardando você

109 a 117 (quadro em [AUDITORIA_FINAL §7](AUDITORIA_FINAL_2026-10-14.md#7-decisões-109-a-117--quadro)) e as novas **118** (acesso autenticado offline no PDV) e **119** (modelo de juros/taxa do parcelamento) em [DECISIONS](DECISIONS.md).

## 11. Afirmações: comprovadas × não verificadas

**Comprovadas** (leitura ou execução desta rodada): sessão do PDV e do Balcão só em memória; handshake de fechamento (Electron real); fila de revogação (unidade); reautenticação (integração + E2E); relogin do mesmo operador e logout escopado (integração); lock/logout/recarga (E2E do PDV web); parcelamento sem juros; inventário de integrações; ausência de ícone/auto-update/assinatura.
**Não verificadas:** instalador gerado e instalado; encerramento real pelo Windows (logoff/desligamento); perda real de rede durante o logout; MFA no desbloqueio; Mobile/TV; nginx/Docker reais; HTTPS; qualquer integração externa.
