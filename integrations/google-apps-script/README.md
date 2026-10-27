# Relé de notificações em Google Apps Script (e-mail, SMS, WhatsApp)

Código-fonte do relé que o CÓRTEX chama por HTTPS para enviar avisos. **Não está publicado em lugar nenhum**: este diretório é só o código; a publicação é manual, feita por você na sua conta Google, depois de revisar. Visão geral e arquitetura: [docs/CORTEX/APPS_SCRIPT_NOTIFICACOES.md](../../docs/CORTEX/APPS_SCRIPT_NOTIFICACOES.md).

| Arquivo | Papel |
|---|---|
| `Main.gs` | `doPost` (entrada), `handle_` (fluxo), `showConfigStatus` e `selfTestDryRun` (manuais, não enviam) |
| `Security.gs` | envelope, assinatura HMAC-SHA256, janela de tempo, anti-repetição (identificador) |
| `Quota.gs` | limites próprios por canal (hora/dia) com trava |
| `Email.gs` / `Sms.gs` / `Whatsapp.gs` | um arquivo por canal; SMS e WhatsApp têm registro de provedores substituível |
| `Config.gs`, `Log.gs` | leitura de Propriedades do script e log sem dados sensíveis |
| `appsscript.json` | manifesto: fuso, V8, escopos mínimos e modo do aplicativo da web |
| `test/` | testes locais (Node) com os `.gs` reais em contexto simulado — **sem rede, sem envio** |

## Contrato da requisição (`POST` na URL `/exec`)

O `doPost` do Apps Script **não lê cabeçalhos HTTP**; por isso tudo o que é assinado vai no corpo JSON:

```json
{ "v": 1, "ts": 1790000000, "id": "<16-80 caracteres A-Za-z0-9_->", "channel": "email|sms|whatsapp", "payload": "<JSON em TEXTO>", "sig": "<hex de 64>" }
```
`sig = HMAC-SHA256(RELAY_SECRET, v + "\n" + ts + "\n" + id + "\n" + channel + "\n" + payload)`. `payload` é um texto (a string exata assinada). Janela de tempo: ±300 s. Cada `id` só vale uma vez (6 h, `CacheService`); o CÓRTEX gera o mesmo `id` para a mesma notificação, então uma repetição volta como `duplicate`.

Resposta (sempre HTTP 200 com JSON): `{ ok, status, id, channel, detail?, retryable?, ambiguous? }`

| `status` | Significa | O CÓRTEX trata como |
|---|---|---|
| `sent` | enviado e aceito pelo provedor | aceito |
| `duplicate` | esse `id` já foi aceito antes | aceito (não reenvia) |
| `dry_run` | modo de teste: validou tudo, **nada foi enviado** | **falha** (nunca "enviado") |
| `rate_limited` | cota própria ou do Google atingida | falha definitiva (a Central suprime e registra) |
| `not_configured` | falta propriedade, lista permitida, declaração ou provedor | falha definitiva, estado explícito |
| `unauthorized` | assinatura/tempo inválidos | falha definitiva |
| `invalid_request` | envelope ou campos inválidos, destinatário fora da lista | falha definitiva |
| `failed` | provedor falhou (`retryable` e `ambiguous` dizem se vale repetir e se pode ter saído) | repetível só se `retryable` |

## Propriedades do script (Configurações do projeto › Propriedades do script)

**Nada disto vai para o Git.** Defina só o que for usar.

| Propriedade | Para quê |
|---|---|
| `RELAY_SECRET` | **obrigatória**; ≥ 32 caracteres (`openssl rand -hex 32`); o mesmo valor vai em `APPS_SCRIPT_SECRET` no servidor do CÓRTEX |
| `DRY_RUN` | `true` = modo simulado (valida, não envia, não gasta cota) |
| `EMAIL_ALLOWED_RECIPIENTS` | lista (vírgula) de destinatários permitidos; sem ela o e-mail fica `not_configured` |
| `EMAIL_FROM_NAME`, `EMAIL_SUBJECT_PREFIX` | nome exibido e prefixo do assunto (o endereço de origem é sempre o da conta dona do script) |
| `EMAIL_QUOTA_RESERVE` | reserva da cota diária do Gmail (padrão 5) |
| `EMAIL_MAX_PER_HOUR` / `EMAIL_MAX_PER_DAY` | limites próprios (padrão 6 / 30; teto fixo 90/dia) |
| `SMS_PROVIDER` (`twilio`), `SMS_ALLOWED_RECIPIENTS` (E.164), `SMS_SENDER_VERIFIED=true`, `SMS_TWILIO_ACCOUNT_SID`, `SMS_TWILIO_AUTH_TOKEN`, `SMS_FROM` ou `SMS_TWILIO_MESSAGING_SERVICE_SID` | SMS (desligado até haver conta, remetente aprovado e números) |
| `SMS_MAX_PER_HOUR` / `SMS_MAX_PER_DAY` | padrão 3 / 10 (teto 50/dia) |
| `WA_PROVIDER` (`meta`), `WA_ALLOWED_RECIPIENTS` (E.164), `WA_TEMPLATE_APPROVED=true`, `WA_META_TOKEN`, `WA_META_PHONE_NUMBER_ID`, `WA_TEMPLATE_NAME`, `WA_TEMPLATE_LANG` (padrão `pt_BR`), `WA_META_API_VERSION` | WhatsApp oficial (desligado até haver conta Business, número, modelo **aprovado** e destinatários) |
| `WHATSAPP_MAX_PER_HOUR` / `WHATSAPP_MAX_PER_DAY` | limites próprios (padrão 3 / 10; teto 50/dia). Atenção ao nome: é `WHATSAPP_…` (e não `WA_…`), no mesmo padrão `<CANAL>_MAX_PER_…` de e-mail e SMS |

Limitação: Propriedades do script ficam visíveis para quem tem acesso de **edição** ao projeto e para o dono. Compartilhe o projeto com o mínimo de pessoas (idealmente só o dono) e use uma conta própria do projeto.

## Publicação manual (somente quando você decidir)

1. Em [script.google.com](https://script.google.com), crie um projeto novo na conta dona do e-mail (de preferência uma conta própria do CÓRTEX).
2. Copie os arquivos `.gs` e o conteúdo de `appsscript.json` (Configurações do projeto › "Mostrar arquivo de manifesto"), ou use `clasp` (opcional; não incluído aqui).
3. Defina as Propriedades do script acima. **Comece com `DRY_RUN=true`**.
4. No editor, execute `showConfigStatus` (mostra só sim/não por propriedade e a cota restante do Gmail) e `selfTestDryRun` (assina uma requisição com o próprio segredo e passa por todo o caminho **sem enviar**; deve responder `dry_run`). A primeira execução pede autorização dos escopos `script.send_mail` e `script.external_request`.
5. Implantar › Nova implantação › Aplicativo da web · **Executar como: Eu** · **Quem tem acesso: Qualquer pessoa** (o CÓRTEX não é um usuário Google; a URL **não é segredo**: a assinatura é a autenticação). Confira as opções exatas na tela de implantação do Google.
6. No servidor do CÓRTEX defina `APPS_SCRIPT_URL` (URL `/exec`), `APPS_SCRIPT_SECRET` (mesmo valor de `RELAY_SECRET`) e `APPS_SCRIPT_CHANNELS=email`.
7. Com `DRY_RUN=true` o CÓRTEX recebe `dry_run` e registra **falha** (o Resend segue como alternativa). Só depois de validar, defina `DRY_RUN=false` (ou remova) e faça **um** envio real controlado.

## Testes

- **Locais (não precisam do Google, não enviam nada):** `node --test integrations/google-apps-script/test/relay.test.js` — 28 testes. E, no lado do CÓRTEX, `npx jest src/services/monitoring-central/apps-script-relay.test.ts` em `apps/api` (inclui a compatibilidade de assinatura TypeScript ↔ script com os `.gs` reais).
- **Exigem implantação de teste no Google (não feitos):** a autorização dos escopos, o redirecionamento real do `/exec`, a cota real do Gmail, o tempo de partida a frio e o comportamento real de `CacheService`/`LockService`.

## Reversão

Remova `APPS_SCRIPT_CHANNELS` (ou o valor) do servidor: o CÓRTEX volta ao comportamento anterior imediatamente. Para parar o relé em si: Implantar › Gerenciar implantações › arquivar; para invalidar chamadas: troque `RELAY_SECRET` (e `APPS_SCRIPT_SECRET`).
