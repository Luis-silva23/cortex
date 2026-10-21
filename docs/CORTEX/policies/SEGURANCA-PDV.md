# Segurança do PDV — login com MFA

Complementa [SECURITY.md](../SECURITY.md) para a frente de caixa (`apps/pdv-desktop`). Vigente desde 2026-09-27.

## Fluxo

1. `POST /api/auth/login` com `numericId`, `password` e, no aplicativo instalado, `deviceId` + `deviceKey` (**id e chave
   do equipamento registrado e autorizado**, ver [DISPOSITIVOS](../DISPOSITIVOS.md); até 2026-10-05 era o MAC/hostname).
   Equipamento pendente, desconhecido, bloqueado, revogado, de outra filial ou com chave errada: **403** com código
   (`DEVICE_*`) e sem token. Sem MFA: sessão emitida como antes.
2. Usuário com MFA: a API devolve `{ mfaRequired: true, mfaToken }`. O PDV **descarta a senha** da memória e mostra a
   2ª etapa. Antes o PDV recusava ("ainda não suportada no PDV").
3. `POST /api/auth/verify-mfa` `{ mfaToken, code, method }` com `method = 'totp'` (6 dígitos do aplicativo
   autenticador) ou `'backup'` (código de recuperação de 16 caracteres, uso único). A sessão emitida é idêntica à do
   login sem MFA.

**Sessão de equipamento preservada:** o equipamento é conferido (autorizado + chave + filial) no passo 1 e o seu UUID viaja
**dentro** do `mfaToken` assinado (`generateMfaPendingToken`); a API reconfere o estado e abre a sessão de equipamento ao
completar o MFA. O cliente não reenvia nem pode trocar o equipamento no passo 2.

## Regras da tela (`src/pages/LoginPage.tsx`, `src/services/mfa-login.ts`)

- O código só é enviado quando completo (TOTP: 6 dígitos; recuperação: 16 hexadecimais); o campo normaliza o que foi
  digitado. Enter repetido / duplo clique não disparam duas verificações (cada erro conta no limite `rateLimitMFA`).
- Mensagens em PT-BR, na própria tela (sem toast genérico em inglês):
  - código errado → "Código incorreto. Digite o código que aparece AGORA no aplicativo autenticador (ele muda a cada
    30 segundos) e confira se a hora deste computador está certa." — continua na 2ª etapa;
  - recuperação inválida/já usada → explica que cada código vale uma vez;
  - `mfaToken` expirado/inválido (401) → volta ao ID/senha: "A verificação expirou…";
  - 409 (operador já conectado em outro PDV) → volta ao ID/senha com a mensagem do servidor;
  - 429 → mensagem do limite de tentativas; sem rede → "o login NÃO foi concluído".
- Nada do desafio (`mfaToken`, código) é persistido; o armazenamento da sessão (`pdv-auth-storage`, cifrado pelo
  `safeStorage` no Electron) guarda só usuário e tokens da sessão já emitida.
- SMS/e-mail não são oferecidos no PDV (a API aceita, mas o balcão usa autenticador/recuperação).

## O que não mudou

- Operações sensíveis continuam exigindo **SOLICITANTE ≠ AUTORIZADOR** (cancelamento, devolução, retirada, desconto
  acima do limite); o autorizador informa as próprias credenciais e o próprio MFA (`AuthorizerCredentialsForm`).
  Um usuário com mais de uma função continua sendo **uma** pessoa: não autoriza a própria solicitação.
- Logout revoga o refresh token no servidor e zera carrinho, caixa e venda em andamento do operador.

## Provas (2026-09-27)

Navegador real contra 5173 + API 3001, MFA habilitado temporariamente em `balcao.alfa.2` via `/api/mfa/setup` +
`/api/mfa/verify` e **desabilitado no fim** (`/api/mfa/disable`, 200): 2ª etapa exibida; código errado explicado;
sem toast em inglês; código de recuperação entra; TOTP entra; sessão salva sem `mfaToken`/senha; recuperação reutilizada
recusada — 8/8 (`walk-mfa-agent5.js`, capturas `shots-agent5/20…24`). Regras puras: `npm run test:logic`.
[LIMITAÇÃO] a abertura da sessão de equipamento com MFA foi conferida no código (o `deviceId` só existe dentro do
Electron); o smoke do Electron não faz login real.
