# Notificações por Google Apps Script (e-mail, SMS e WhatsApp)

Atualizado em 2026-10-23. Escrito para quem vai publicar, configurar e operar o relé.

> **Estado honesto:** o código está pronto e testado **localmente**, mas **nada foi publicado, configurado ou enviado**. Não existe projeto no Google, nenhum segredo foi criado, nenhuma mensagem real foi enviada, nenhum serviço foi contratado. O relé vem **desligado por padrão** (sem `APPS_SCRIPT_CHANNELS` o CÓRTEX se comporta exatamente como antes). Depois de publicado, só o **e-mail** é utilizável sem contratar nada; **SMS e WhatsApp seguem pendentes** de provedor externo.

## 1. O que foi criado e alterado

**Novos**
- `integrations/google-apps-script/` — o relé: `Main.gs`, `Security.gs`, `Quota.gs`, `Email.gs`, `Sms.gs`, `Whatsapp.gs`, `Config.gs`, `Log.gs`, `appsscript.json`, `README.md` (passo a passo de publicação manual) e `test/` (harness + 29 testes).
- `packages/shared/utils/apps-script-relay.ts` — cliente do relé (configuração, assinatura, envio, tradução da resposta).
- `apps/api/src/services/monitoring-central/apps-script-relay.test.ts` — 42 testes do lado do CÓRTEX (inclui compatibilidade de assinatura com os `.gs` reais).

**Alterados (mudança mínima, sem refatoração)**
- `packages/shared/utils/alert-channels.ts` — `emailConfig/smsConfig/whatsappConfig` passam a reconhecer o relé como provedor; novas `emailAttempts/smsAttempts/whatsappAttempts` (lista de tentativas na ordem configurada); `sendEmailResend` agora exige as credenciais **do próprio Resend**.
- `apps/api/src/services/monitoring-central/{resend,sms,whatsapp}.service.ts` — usam as listas de tentativas (o `sendWithFailover`, limites, deduplicação, disjuntor e registro continuam os mesmos).
- `apps/api/src/services/monitoring-central/external-status.service.ts` — novo bloco `appsScript` (só estado) e o bloco do e-mail mostra `providers`.
- `apps/monitor/src/notify.ts`, `Dockerfile`, `tsconfig.json` — o monitor externo usa as mesmas listas.
- `apps/super-admin/.../externos/page.tsx` — cartão "Relé Google Apps Script" (estado, canais, o que falta; sem URL e sem segredo).
- `docker-compose.yml`, `.env.example`, `.github/workflows/ci.yml`, `apps/api/test/integration/monitoring-central.integration.test.ts`, docs.

## 2. Arquitetura

```
 CÓRTEX (API ou monitor externo)                     Google (conta dona do script)
  notificação ─▶ lista de tentativas ─▶ POST /exec ─▶ Main.doPost ─▶ Security (HMAC, tempo, id)
   (limites, dedupe, disjuntor,          corpo assinado             ─▶ canal: Email | Sms | Whatsapp
    registro: iguais aos de hoje)                                   ─▶ Quota (hora/dia) ─▶ MailApp / UrlFetchApp
        ▲                                                                        │
        └──────────── JSON { ok, status, … } (sempre HTTP 200) ◀─────────────────┘
```

Decisão: o Apps Script é **um adaptador de envio dentro da lista de provedores existente**, não um serviço novo nem um substituto. O que já funcionava (limites por hora/dia/mês, deduplicação, disjuntor, tentativas, registro, tela) **não foi duplicado**: o relé é só mais um item de `sendWithFailover`.

- **E-mail:** ordem `ALERT_EMAIL_PROVIDERS` (padrão `apps-script,resend`: o gratuito primeiro; o **Resend continua como alternativa** quando também estiver completo). Com o relé desligado, a lista é só o Resend — igual a antes.
- **SMS / WhatsApp:** o relé entra **depois** dos provedores diretos (Twilio, Meta). Os destinatários continuam vindo de `ALERT_SMS_TO` / `ALERT_WHATSAPP_TO`; as declarações `ALERT_SMS_SENDER_VERIFIED` e `ALERT_WHATSAPP_TEMPLATE_APPROVED` continuam obrigatórias.
- **Monitor externo:** usa as mesmas funções (um adaptador só).

### Segurança
- **Autenticação:** HMAC-SHA256 do corpo com segredo compartilhado (`RELAY_SECRET` no script × `APPS_SCRIPT_SECRET` no servidor). O `doPost` não lê cabeçalhos HTTP, então `v`, `ts`, `id`, `channel` e `payload` vão **no corpo assinado**. Comparação em tempo constante; recusa de assinatura e de janela de tempo (±300 s) é a **mesma** resposta (`unauthorized`).
- **Repetição/duplicidade:** `id` único por notificação+destinatário e estável entre tentativas; o script o reserva antes de enviar (`CacheService`, 6 h). Falha com certeza de que nada saiu **libera** o id e devolve a cota; falha ambígua (timeout, 5xx) **mantém** o id (a repetição volta como `duplicate`, sem reenviar). `CacheService` é melhor esforço: a deduplicação do CÓRTEX continua sendo a primeira barreira.
- **Destinatários:** nunca livres. Só endereços/números da **lista permitida** do script; `to` da requisição precisa ser subconjunto; máximo 5 e-mails por chamada; assunto sem quebra de linha (anti-injeção de cabeçalho); tamanhos validados.
- **Limites:** por canal e por hora/dia no próprio script (padrões 6/30 e-mail, 3/10 SMS e WhatsApp; **teto fixo** que a propriedade não ultrapassa) + cota diária do Gmail com reserva. Excedeu: `rate_limited`.
- **Segredos:** só em Propriedades do script e variáveis de ambiente do servidor. Nunca no navegador, no Git, na tela (que só mostra "configurado/pendente" e o host) nem nos logs. Logs do script: lista fixa de campos, `id` abreviado, sem destinatário, texto, assinatura ou token.
- **Estados** (`status`): `sent`, `duplicate`, `rate_limited`, `not_configured`, `failed`, `unauthorized`, `invalid_request` e `dry_run` (modo de teste; **nunca** conta como enviado). Sem provedor/credencial: `not_configured` — nunca sucesso simulado.
- **Isolamento e permissão:** o relé não toca em dados de empresas (a mensagem só carrega tipo, alvo, hora e gravidade, igual ao que já era enviado). A tela e a API de Serviços externos continuam **exclusivas do Super Admin** (403 para administrador, gerente e operador — teste de integração).

## 3. Variáveis de ambiente do servidor (sem valores)

| Variável | Uso |
|---|---|
| `APPS_SCRIPT_CHANNELS` | canais a enviar pelo relé: `email`, `sms`, `whatsapp` (vazio = desligado) |
| `APPS_SCRIPT_URL` | URL `/exec` do aplicativo da web (só `https://script.google.com/…`; trate como reservada) |
| `APPS_SCRIPT_SECRET` | segredo ≥ 32 caracteres (igual ao `RELAY_SECRET` do script) |
| `ALERT_EMAIL_PROVIDERS` | ordem dos provedores de e-mail prontos (padrão `apps-script,resend`) |
| `ALERT_EMAIL_TO` | (opcional com o relé) destinatários; sem ele o script usa a lista permitida dele |
| `ALERT_SMS_TO`, `ALERT_SMS_SENDER_VERIFIED`, `ALERT_WHATSAPP_TO`, `ALERT_WHATSAPP_TEMPLATE_APPROVED` | continuam valendo para SMS/WhatsApp |

Propriedades do script e passo a passo: [integrations/google-apps-script/README.md](../../integrations/google-apps-script/README.md).

## 4. Cotas, limites e condições (Google)

Conferido na página oficial de cotas do Apps Script em 2026-10-22 (podem mudar: confira antes de ligar):

| | Conta gmail.com | Google Workspace |
|---|---|---|
| Destinatários de e-mail por dia (MailApp) | **100** | **1.500** |
| Chamadas `UrlFetch` por dia | 20.000 | 100.000 |
| Tempo por execução | 6 min | 6 min |
| Execuções simultâneas por usuário | 30 | 30 |

Os limites padrão do CÓRTEX (6 por hora, 30 por dia por canal) cabem na cota de uma conta gmail.com. Considerações: a mensagem sai **da conta dona do script** (o `MailApp` não troca o remetente; só o nome exibido); uso é para notificações do próprio sistema (não envio em massa nem marketing); dependência de **uma** conta Google (suspensão = relé fora; para produção, preferir Workspace e conta própria do projeto); o aplicativo da web é "Executar como Eu" com acesso público e **a assinatura é a única autenticação** — por isso o segredo é obrigatório.

## 5. SMS e WhatsApp — dependências e custos

- **Pesquisa (2026-10-22):** não encontrei alternativa **oficial, gratuita e adequada** para alertas por SMS no Brasil (o teste gratuito da Twilio só envia a números verificados, até cinco, e prefixa a mensagem). Para WhatsApp, a página oficial de preços da Meta (atualizada em 30/03/2026) indica mensagens dentro da janela de atendimento gratuitas, mas **alerta enviado pela empresa exige modelo aprovado e é cobrado por mensagem**; fontes de terceiros indicam mudança de cobrança a partir de 1º/10/2026 (não confirmada em anúncio oficial) — confira a tabela oficial do mercado Brasil antes de ligar.
- **Decisão:** os dois canais ficam **implementados e desligados**: o adaptador de SMS (Twilio) e o de WhatsApp (Meta Cloud API, modelo de uma variável `{{1}}`) existem, **sem simular sucesso** e sem nada de WhatsApp não oficial. Ativam-se quando houver: conta e remetente aprovado (SMS); conta Business, número, modelo **aprovado** e destinatários (WhatsApp); credenciais nas Propriedades do script; e as declarações do operador no servidor.
- **Custo potencial:** SMS e WhatsApp são pagos por mensagem (ou exigem crédito). Os limites (3/h e 10/dia por canal, teto 50/dia) contêm o gasto, mas o preço é do provedor.

## 6. Testes

| Teste | Onde | Resultado nesta entrega |
|---|---|---|
| Relé (`.gs` reais, contexto simulado) | `node --test integrations/google-apps-script/test/relay.test.js` | 29/29 |
| Lado CÓRTEX (config, assinatura ↔ script, tradução, rede simulada, failover, serviços, vazamento) | `npx jest src/services/monitoring-central/apps-script-relay.test.ts` (apps/api) | 42/42 |
| Integração com Postgres/Redis reais (inclui relé: estado sem vazamento + 403 aos demais papéis) | `monitoring-central.integration.test.ts` | 115/115 |
| Monitor externo | `npm test --workspace=@ln-system/monitor` | 42/42 |
| Cobertura: assinatura certa/errada, timestamp expirado, repetição, payload e destinatários inválidos, cotas, canal não configurado, falha/timeout/HTTP inesperado do provedor, sem segredo nos logs, failover preservado, autorização | todos acima | ver arquivos |

**Não feitos (exigem o Google):** autorização de escopos, redirecionamento real do `/exec`, cota real do Gmail, partida a frio, comportamento real de `CacheService`/`LockService`, um envio real.

## 7. Reversão

1. Servidor: remova `APPS_SCRIPT_CHANNELS` → o CÓRTEX volta ao comportamento anterior na hora (Resend/Twilio/Meta como antes).
2. Google: arquive a implantação e/ou troque `RELAY_SECRET` (e `APPS_SCRIPT_SECRET`).
3. Código: reverter o commit da integração (nenhuma migração de banco, nenhuma mudança de dados).

## 8. O que falta antes de ativar (nada disto foi feito)

1. Decidir a conta Google dona do script (gmail.com: 100/dia; Workspace: 1.500/dia) e a lista de destinatários permitidos.
2. Criar o projeto, colar o código, definir as Propriedades (com `DRY_RUN=true`), rodar `showConfigStatus` e `selfTestDryRun`, publicar como aplicativo da web.
3. Definir `APPS_SCRIPT_URL`, `APPS_SCRIPT_SECRET`, `APPS_SCRIPT_CHANNELS=email` no servidor e conferir o cartão "Relé Google Apps Script" em Serviços externos.
4. Validar em modo simulado (o CÓRTEX registrará falha porque `dry_run` não é envio) e então **um** envio real controlado com `DRY_RUN=false`, conferindo na caixa de entrada.
5. Só depois, avaliar o Resend como segundo da lista ou desligá-lo; e decidir se SMS/WhatsApp serão contratados.
