# CÓRTEX — Dispositivos: como uma máquina entra, como o aplicativo conecta e como o administrador autoriza ou revoga

> **Estado (2026-10-06):** implementado e provado contra PostgreSQL e Redis reais (suíte `device-authorization.integration`, 36 testes) e por testes unitários do cliente. **Não** foi provado em staging real com HTTPS e domínio (não existem aqui): ver [§10](#10-o-que-foi-provado-e-o-que-falta). Decisões em aberto: 109 a 112 ([DECISIONS](DECISIONS.md)).

## 1. A regra (cadeia de acesso)

```
REDE → API acessível → DISPOSITIVO identificado → AUTORIZADO → LICENÇA válida → EMPRESA → FILIAL → USUÁRIO → PERMISSÕES → RLS
```

**Alcançar a API não é estar autorizado.** Uma máquina nova chega à API (sem isso ela não consegue nem pedir autorização), mas só consegue duas coisas: **se registrar** e **perguntar o próprio estado**. Nenhuma das duas lê ou devolve dado de empresa, filial, produto, cliente, estoque, venda, caixa, OS, usuário, painel ou integração. Todo o resto exige login, e o login exige equipamento autorizado.

## 2. O que existe (e o que não existe)

| Peça | Situação |
|---|---|
| **PDV / frente de caixa** = `apps/pdv-desktop` (Electron) | **Tem o portão de autorização** (`DeviceGate`): primeira abertura registra o equipamento, mostra "Dispositivo aguardando autorização" com o código e só libera depois que o administrador autoriza. É a única aplicação que cria venda, pagamento e movimento de caixa |
| **"Balcão" / "APK Balcão"** | **O Balcão é um aplicativo próprio (`apps/balcao`, desde 2026-10-13)**: atendimento (cliente, veículo, produto/disponível, orçamento → OS, encaminhar ao caixa), separado do PDV (caixa) e do Web/Admin. **Não executa operação de caixa**, portanto **não passa pelo portão de equipamento** hoje (a política `devices.requiredUserTypes` só alcança abrir/fechar caixa, movimento, venda e pagamento). **Não existe APK Balcão** (nenhum `AndroidManifest`/`applicationId`; é uma SPA web). Se o dono decidir que o Balcão só rode em equipamento autorizado, ele usa **os mesmos endpoints** (§6) e as mesmas regras de HTTPS (§4) — decisão 112. Ver [APLICATIVOS](APLICATIVOS.md) |
| `apps/mobile` (mecânico/equipe) e `apps/tv` (painel) | **Não** têm o portão de equipamento (não enviam identidade de equipamento). Protegidos pelo servidor só pela **política** `devices.requiredUserTypes` (§8). Build de produção **recusa URL sem HTTPS**. Pendência 111 |
| Admin Web e Super Admin (navegador) | Não usam equipamento: o login por e-mail segue sem ele (a política só exige equipamento dos perfis que a empresa listar) |
| Super Admin → tela **Dispositivos** | Fila "Aguardando autorização" com código, nome, tipo, MAC/IP e hora; **Autorizar** (escolhe licença/empresa e filial), **Recusar/Revogar**, **Bloquear/Desbloquear**; coluna de última atividade e status |

## 3. Como uma máquina nova entra no CÓRTEX

1. **Instalação.** O instalador do PDV já leva o **endereço oficial** do servidor (§4). O operador não digita IP, porta, banco nem Redis.
2. **Primeira abertura.** O aplicativo confere o endereço (HTTPS em produção) e **se registra**: `POST /api/device/enroll` com nome do computador, tipo e uma dica de hardware (MAC). O servidor cria o equipamento **PENDENTE, sem empresa e sem filial**, e devolve um **id**, uma **chave secreta** (mostrada uma vez; no banco só o hash SHA-256) e um **código curto** (`ABCD-2345`). O aplicativo guarda id e chave no armazenamento **cifrado do sistema** (Electron `safeStorage`: DPAPI/Keychain/libsecret), nunca em texto puro.
3. **Espera.** A tela mostra **"Dispositivo aguardando autorização"** e o código. A cada 5 s o aplicativo consulta `POST /api/device/status` (id + chave). Nada do CÓRTEX, nem a tela de login, aparece.
4. **Autorização.** O administrador (Super ADM TI) vê o equipamento na fila, **confere o código** com o da tela, escolhe a **licença (empresa)** e a **filial** e autoriza. O servidor valida (licença ativa, filial da mesma empresa, vaga na licença, tudo serializado pela licença) e marca o equipamento **ATIVO**, vinculado a licença e filial. **Gera auditoria.**
5. **Liberação.** O próximo `status` devolve `ACTIVE` com **só o nome** da empresa e da filial; o aplicativo libera a tela de login.
6. **Login do operador.** `POST /api/auth/login` com usuário, senha, **id e chave do equipamento**. O servidor confere (nessa ordem): senha → empresa ativa → **equipamento da empresa do usuário, ATIVO, com a chave certa e da filial do usuário** → MFA (se houver) → abre a **DeviceSession** e emite o token **preso a ela** (`dsid`).
7. **Uso.** Toda requisição confere que a sessão de equipamento do token continua ativa e que o equipamento continua ativo (consulta ao PostgreSQL; cache positivo de 3 s: na instância que executou a revogação o efeito é imediato e nas demais vale em até 3 s). O usuário **não escolhe** empresa nem filial: vêm da autorização e do próprio usuário; não há troca manual de filial para escapar do escopo.

Recusas do login (sempre `403`, **só depois** de a senha estar certa, com código): `DEVICE_PENDING`, `DEVICE_UNKNOWN` (não existe **ou** é de outra empresa: a resposta não distingue), `DEVICE_BLOCKED`, `DEVICE_REVOKED`, `DEVICE_KEY_INVALID`, `DEVICE_BRANCH_MISMATCH`, `DEVICE_REENROLL_REQUIRED` (equipamento legado sem chave fora do conjunto fechado ou depois do corte, §8). **`DEVICE_REQUIRED` não é do login:** é a recusa da **operação de caixa** feita sem equipamento (§8). Essas recusas **não contam** como tentativa de adivinhar senha no limitador por IP (senão um PDV pendente bloquearia todos os operadores da loja).

## 4. Como o aplicativo encontra e conecta no servidor

- **Endereço fixado na instalação:** variável de build `VITE_API_URL` (PDV) / `EXPO_PUBLIC_API_URL` (mobile/TV). A tela de Configurações do PDV só **mostra** o endereço (não edita). **Nenhum domínio foi inventado:** o valor real só existe quando o domínio de produção for definido (pendência de infraestrutura).
- **HTTPS obrigatório em produção, nos dois lados:**
  - **Servidor:** `NODE_ENV=production` responde **426 `HTTPS_REQUIRED`** a qualquer requisição que não chegou por HTTPS (a API não termina TLS: o certificado fica no proxy/balanceador e `TRUST_PROXY` faz o `X-Forwarded-Proto` valer). Só as sondas `GET /api/health`, `/live` e `/ready` passam por HTTP (rede privada do orquestrador). Sem redirecionamento (o `Host` vem do cliente). A **API não sobe** em produção sem `TRUST_PROXY` (ou `ENFORCE_HTTPS=false` explícito, com aviso). HSTS: cabeçalho do `helmet` na API e no proxy do staging.
  - **Cliente:** o PDV em produção **recusa** endereço sem HTTPS, ausente, inválido ou com usuário/senha (`DeviceGate` mostra "Instalação inválida"); mobile e TV lançam erro na partida de um build de produção sem URL https. **Não existe opção de ignorar erro de certificado**: vale a validação padrão do sistema (certificado inválido = falha de conexão). Nenhuma credencial vai em URL.
- **Bootstrap:** abrir → conferir endereço → HTTPS → (enroll na 1ª vez) → `status` → autorizado → login. `status` é o "bootstrap" do aplicativo.
- **Servidor:** Internet → HTTPS → proxy → API → PostgreSQL/Redis/workers. **Nunca** Internet→PostgreSQL, nunca aplicativo→PostgreSQL, nunca Redis exposto: aplicativos só falam HTTP(S) com a API. No `docker-compose.yml` o banco e o Redis só escutam em `127.0.0.1`; em produção, só a rede privada da API deve alcançá-los (regra de firewall: **configuração de infraestrutura**).

## 5. Como o administrador autoriza, bloqueia e revoga

| Ação | Onde | O que acontece |
|---|---|---|
| Ver pendentes | Super Admin → Dispositivos → "Aguardando autorização" (`GET /api/activations/enrollments`) | Código, nome, tipo, MAC/IP, quando pediu. Só Super ADM TI |
| **Autorizar** | botão **Autorizar** (`POST /api/activations/enrollments/:id/authorize`, corpo `licenseId`+`branchId`) | Vincula licença+filial e ativa. `409 DEVICE_LIMIT_REACHED` se a licença não tem vaga; `404` se a filial não é da empresa da licença; `409 DEVICE_NOT_PENDING` se já foi tratado (duas autorizações simultâneas: só uma vence). **Auditoria** |
| **Bloquear** (reversível) | `POST /api/activations/devices/:id/block` | Equipamento `BLOCKED`; **encerra a sessão de equipamento e as renovações na mesma transação**: o token para de valer **na hora**. Desbloquear (`/unblock`) volta a `ACTIVE`; novo login é necessário. **Auditoria** |
| **Revogar** (permanente) | `POST /api/activations/devices/:id/revoke` (motivo obrigatório) | Igual ao bloqueio, sem volta. Para usar a máquina de novo: **reenrolar** (novo id e nova chave) e ser autorizada outra vez. **Auditoria** |
| Encerrar sessão travada | `POST /api/activations/devices/:id/force-end-session` (gerente/administrador da empresa) | Libera um equipamento ocupado (queda de energia). **Auditoria** |
| Último acesso, status | tela Dispositivos | `lastSeenAt` (atualizado pelo `status`, 1×/min) e status |

Toda ação do administrador passa por `auditLog` (entidade `Device`/`DeviceSession`, quem, quando, IP). A auditoria **não** carrega a chave (redação de campos sensíveis).

## 6. API (resumo)

| Rota | Quem | Função |
|---|---|---|
| `POST /api/device/enroll` | **pública**, limite por IP (10/h), fila pendente limitada (200; pendência esquecida some em 7 dias) | Cria equipamento PENDENTE sem empresa/filial; corpo fechado (`deviceName`, `deviceType`, `hardwareHint?`): **o equipamento não escolhe empresa nem filial** (corpo extra = 400) |
| `POST /api/device/status` | **pública**, id + chave; falhas por IP limitadas (20/min) | Estado do equipamento. Erro **uniforme** `401` para chave errada, id inexistente ou corpo vazio. Pendente: só código. Ativo: só nome da empresa e da filial. Bloqueado/revogado: só o status. `Cache-Control: no-store` |
| `GET /api/activations/enrollments`, `POST /api/activations/enrollments/:id/authorize` | Super ADM TI | fila e autorização |
| `POST /api/activations/devices/:id/{block,unblock,revoke,force-end-session}` | Super ADM TI (force-end: gerente+) | ver §5 |
| `POST /api/auth/login` | pública (limite de tentativas) | aceita `deviceId` + `deviceKey` |

O fluxo **legado** (`/api/activations/request` → `/:id/approve`, por usuário já logado) continua existindo e passa pelo mesmo portão do login; equipamentos aprovados por ele **não têm chave** e só entram no login dentro do **conjunto fechado e antes da data de corte** (§8, decisão 110).

## 7. Modelo de dados e garantias

- `devices`: `licenseId` e `branchId` **nulos enquanto PENDENTE** (migração `20261006200000_device_enrollment`); `secretHash` (SHA-256 da chave), `enrollmentCode` (único). Restrição `devices_active_needs_license_check`: **um equipamento ATIVO sempre tem licença**. `refresh_tokens.deviceSessionId` prende a renovação à sessão.
- `device_sessions`: dois **índices únicos parciais** (um por equipamento ativo, um por usuário ativo) no PostgreSQL: **um usuário não opera em dois PDVs ao mesmo tempo e um equipamento não tem dois operadores** (`409 DEVICE_BUSY` / `USER_ALREADY_ACTIVE`). Mantido e provado.
- **RLS:** `devices_isolation` (FORCE): equipamento só é visto pela empresa da licença; **o sem licença só pelo Super Admin**. O enrolamento público roda no contexto de sistema e **só** toca `devices`. `db:check-rls`: todas as invariantes OK.
- **Separação de identidades** (correção da Fase 4 preservada): `deviceId`/`licenseId` nunca se confundem com `userId`; a credencial de dispositivo nunca é sessão de usuário; `verifyAccessToken` recusa esses tokens.
- **Refresh:** a renovação presa a uma sessão de equipamento encerrada é recusada **sem** disparar a detecção de "token roubado" (que derrubaria as outras sessões do usuário).

## 8. Configuração obrigatória e legado

- **Política `devices.requiredUserTypes`** (por empresa; padrão **vazio**). **O que ela faz:** lista os perfis que só podem **operar o caixa** — abrir/fechar caixa, movimentar/sangria, vender e receber pagamento (`POST /api/sales`, `/api/payments`, `/api/cash-register/{open,:id/close,movement,:id/withdrawal}`) — por um **equipamento autorizado**: a operação sem a sessão de equipamento no token responde `403 DEVICE_REQUIRED` (`middleware/device.ts`). **O que ela NÃO faz:** não bloqueia o **login** nem a consulta: o mesmo perfil (OPERATOR/Balcão) usa o Admin Web pelo navegador para atendimento (orçamento, OS, consulta), e o Admin Web **não cria** venda, pagamento nem movimento de caixa. Por isso a exigência vive na **operação**, não no login — e não depende de o cliente "se declarar terminal": quem omite o equipamento só perde a capacidade de mexer em dinheiro. Quem **informa** um equipamento no login sempre precisa que ele esteja autorizado, com a lista vazia ou não (sem fallback permissivo nesse caminho). **Lista vazia = sem exigência de caixa**: é um padrão de **transição**, não uma configuração correta de go-live — enquanto estiver vazia, uma credencial de usuário usada em qualquer máquina, sem equipamento, ainda opera o caixa. Pela segurança, **ligar assim que os PDVs da empresa estiverem registrados** (ex.: `OPERATOR`, e os perfis de gerência que operam caixa). O que cada empresa lista e quando liga é a **decisão 109** (o mecanismo é testado nos dois estados; padrão vazio testado para não mudar em silêncio).
- **Equipamentos legados** (aprovados pelo fluxo antigo, **sem chave**; identidade = id/MAC, que não é segredo): **onde ainda são aceitos:** só em `POST /api/auth/login` (`assertLoginDevice`), por id (UUID) ou MAC **dentro da própria empresa**; nenhum outro endpoint aceita identificação sem chave, e eles **não** burlam a DeviceSession (sessão única por equipamento/usuário, revogação e encerramento valem igual). **Risco:** quem conhece o MAC de um equipamento legado ativo e tem a senha de um usuário da empresa "é" aquele equipamento (clonagem trivial). **Estratégia de encerramento (decisão 110, implementada e testada):** (1) **conjunto fechado** — só vale para equipamento criado antes de `2026-10-07` (entrega do enrolamento com chave): o fluxo antigo ainda cria linhas, mas elas **não** entram no login sem chave, então o legado não cresce; (2) **data de corte** — depois de `DEVICE_LEGACY_CUTOFF` (padrão **31/12/2026, 23:59:59 em Brasília**; ajustável por variável de ambiente, validada na partida) nenhum legado entra: `403 DEVICE_REENROLL_REQUIRED` e a máquina precisa se registrar de novo (o PDV novo já o faz sozinho, nunca usa MAC); (3) cada login legado aceito gera o evento de segurança `DEVICE_LEGACY_LOGIN` (empresa, usuário, equipamento) para medir quantos faltam migrar. A **data** é um padrão técnico: o dono pode antecipá-la sem mudar código.
- **Clonagem:** copiar o arquivo de credencial para outra máquina não funciona (cifrado pelo sistema do usuário: DPAPI). Isso **não é atestação de hardware**: quem controla a mesma conta do sistema na mesma máquina usa a credencial. Se uma máquina for clonada/roubada: **revogar** (encerra tudo na hora) e reenrolar. Atestação de hardware (TPM) é evolução, não existe.

## 9. Segredos e auditoria

- Chave do equipamento: **nunca** em texto puro no banco (hash), no log, na auditoria nem na resposta do `status`; comparada em tempo constante.
- Nada de segredo real em documentação ou no Git; `scripts/smoke-device-flow.js` lê credenciais **só de variáveis de ambiente**.

## 10. O que foi provado e o que falta

**Provado (automatizado, PostgreSQL e Redis reais, RLS ligada) — `device-authorization.integration` (36 testes):**
máquina nova alcança a API e **não** abre dado protegido (401 sem token; a chave não serve de token; JWT forjado 401) → login com senha certa em equipamento pendente = 403 `DEVICE_PENDING`, sem token nem sessão → só Super ADM TI vê a fila e autoriza → autorização de licença/filial de outra empresa recusada → autoriza (auditoria gerada, sem a chave) → segunda autorização 409 → login sem chave/chave errada recusado → login autorizado abre DeviceSession da empresa e filial certas, token com `dsid` → consulta de produto própria 200 e **de outra empresa negada** → renovação mantém a sessão → **revogação: o mesmo token vira 401 na hora, renovação recusada, sessão `FORCE_ENDED`, login `DEVICE_REVOKED`, status só `REVOKED`**, e as outras sessões do usuário seguem valendo → reenrolar gera id e chave novos → isolamento: empresa B não usa equipamento de A (e vice-versa), filial A2 não usa equipamento de A1, chave de outro equipamento não vale → DEVICE_BUSY e USER_ALREADY_ACTIVE → bloquear derruba na hora, desbloquear volta a ATIVO → limite da licença → autorizações simultâneas → política `DEVICE_REQUIRED` → limites das rotas públicas (429).
Mais: `https.test` (426 em produção, sondas, opt-out), `env.test` (a API não sobe sem proxy declarado), `device-enrollment.test` do PDV (HTTPS, estados do portão), `pdv-device-login`, `auth-coverage` (as duas rotas públicas novas têm motivo escrito).

**Provado numa cadeia TLS real local (2026-10-06, sem Docker):** um proxy HTTPS com certificado autoassinado (gerado com `openssl`, sockets reais em `127.0.0.1`) à frente do `middleware/https.ts` com `TRUST_PROXY=1`: (1) cliente com a **validação padrão de certificado** recusa o certificado autoassinado (`DEPTH_ZERO_SELF_SIGNED_CERT` — nada de "ignorar erro SSL"); (2) com o certificado confiado, `GET /api/data` → 200; (3) **HTTP direto na API → 426 `HTTPS_REQUIRED`**; (4) sonda `/api/health/ready` por HTTP direto → 200. É a prova do mecanismo (proxy → `X-Forwarded-Proto` → API), **não** de um certificado emitido para um domínio real.

**Não provado aqui (depende de infraestrutura — PENDENTE: executar somente em staging/infraestrutura adequada):**

| Item | Por quê | Como fechar |
|---|---|---|
| HTTPS real (certificado, redirecionamento 80→443, 426 em HTTP direto, HSTS) | não há domínio, certificado nem proxy | `docker-compose.staging.yml` + `deploy/Caddyfile` (preparados, **não executados**); depois `node scripts/smoke-device-flow.js` contra o domínio |
| Fluxo no aplicativo real (instalar → abrir → autorizar → login → balcão → revogar) | exige o aplicativo empacotado e o servidor de staging | rodar o PDV com `VITE_API_URL` do staging e a fumaça acima; marcar o resultado aqui |
| Servidor Linux, PostgreSQL/Redis gerenciados protegidos por rede, SIGTERM real, restauração | infraestrutura | [PRODUCAO](PRODUCAO.md) §10 e §12 |
| Balcão (`apps/balcao`) em equipamento autorizado | **não exigido** (o Balcão não opera caixa; sem APK) | só se o dono definir (decisão 112) |

## 11. Pendências e decisões

| # | Item | Natureza |
|---|---|---|
| 109 | Quais perfis de cada empresa passam a só operar o caixa por equipamento autorizado e **quando ligar** (mecanismo pronto e testado; padrão vazio por transição) | 🟣 decisão de negócio (configuração por empresa) |
| 110 | Confirmar a data de corte do legado sem chave (padrão técnico: 31/12/2026, ajustável por `DEVICE_LEGACY_CUTOFF`) | 🟣 confirmação do dono (a trava existe e é testada) |
| 111 | Portão de equipamento no `apps/mobile` e `apps/tv` (hoje só política + HTTPS) | cliente pendente (depende de aparelho Android para provar) |
| 112 | Se o **Balcão** (aplicativo próprio, [APLICATIVOS](APLICATIVOS.md)) deve rodar só em equipamento autorizado, e se terá empacotamento (APK/PWA — 116). Hoje: aplicativo web sem portão, porque não opera caixa | 🟣 decisão de produto |

## Atualização 2026-10-14 — sessão de equipamento e PDV sem restauração

- O PDV não restaura sessão (ver [CONSOLIDACAO_FINAL](CONSOLIDACAO_FINAL.md)). Após queda de energia ou processo encerrado à força a sessão de equipamento fica ATIVA no servidor; o **mesmo** operador, com senha + chave do equipamento, a substitui no login seguinte (`endReason = SUPERSEDED_BY_RELOGIN`, renovações revogadas). Outro operador continua recebendo `DEVICE_BUSY` e depende do encerramento administrativo (`force-end-session`).
- `POST /api/auth/logout` encerra **apenas** a sessão de equipamento do refresh token apresentado. Sair do Balcão, do Admin Web ou do Mobile (logins sem equipamento) não derruba mais o PDV do mesmo usuário.
