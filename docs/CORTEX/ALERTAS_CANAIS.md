# Alertas por e-mail, SMS e WhatsApp

Atualizado em 2026-10-22. Escrito para quem vai configurar e operar os avisos de incidente.

## 1. Quatro níveis — nunca confundir

| Nível | Significa | Como saber |
|---|---|---|
| **Implementado** | O código existe e está testado | testes automatizados (rede **simulada**) |
| **Configurado** | As variáveis de ambiente estão completas e válidas | Super Admin › Infraestrutura (canais) e › Observabilidade › Serviços externos mostram "Configurado e ligado" ou o que **falta** |
| **Enviado** | O provedor **aceitou** a mensagem (HTTP 2xx) | registro de entrega com status `SENT` (sem texto nem número) |
| **Confirmado pelo provedor** | O provedor confirmou a **entrega no aparelho** | **não implementado** (exigiria receber o webhook de status do provedor) |

### Estado real hoje (2026-10-22)

| Canal | Implementado | Configurado | Enviado de verdade | Confirmado pelo provedor |
|---|---|---|---|---|
| E-mail (Resend) | sim | **não** | **não** | não |
| SMS (Twilio) | sim | **não** | **não** | não |
| WhatsApp (Cloud API da Meta e/ou Twilio WhatsApp) | sim | **não** | **não** | não |

Nenhum provedor real foi contactado em nenhum teste: todos usam resposta simulada. **Nenhuma mensagem real foi enviada.** Nenhuma conta, crédito, número, remetente ou modelo foi criado ou contratado.

## 2. Política de aviso

- **Gravidade mínima por canal** (`ALERT_<CANAL>_MIN_SEVERITY`, padrão `CRITICAL` nos três): atenção não dispara SMS nem WhatsApp por padrão.
- **Cada canal é independente:** falha ou limite de um não afeta os outros (execução paralela, cada um com seus próprios limites, disjuntor e registro).
- **Deduplicação:** o mesmo alerta (tipo + alvo) não reenvia dentro de `ALERT_<CANAL>_DEDUPE_MINUTES` (e-mail 60, SMS/WhatsApp 120). Atualizar um alerta aberto não reenvia.
- **Limites de custo:** por hora/dia/mês e por canal (SMS/WhatsApp: 3 / 10 / 100). Passou do limite, a mensagem é **suprimida e registrada** — nunca contrata plano nem "estoura" crédito. Sem leitura dos contadores, suprime (falha segura).
- **Falha repetível** (rede, tempo esgotado, 429, 5xx): tentativas controladas com espera; **falha de configuração/credencial/destinatário não repete**. Falhas seguidas abrem um **disjuntor** (3 falhas → pausa de 15 min).
- **Alternância de provedor:** WhatsApp tenta os provedores na ordem de `ALERT_WHATSAPP_PROVIDERS` (padrão `meta,twilio`) e passa ao próximo se o primeiro falhar. SMS e e-mail têm um provedor cada hoje.
- **Recuperação:** a mensagem "RECUPERADO" (com a duração) só vai ao canal que **já tinha avisado** daquele incidente. Sem aviso de queda aceito, não há aviso de recuperação.
- **Privacidade:** nada de texto da mensagem, número ou e-mail nos logs nem no registro de entrega — só canal, resultado, motivo curto (mascarado) e identificador de deduplicação.

Quem avisa: o **notificador da API** (alertas que a própria API detecta) e o **monitor independente** (`apps/monitor`, que continua avisando mesmo com a API fora). Alerta `EXTERNAL_*` registrado no painel pelo monitor **não é avisado de novo** pela API.

## 3. O que falta para ligar cada canal (e é com você)

### E-mail — Resend
`RESEND_API_KEY`, `ALERT_EMAIL_FROM` (remetente num **domínio verificado** no provedor), `ALERT_EMAIL_TO` (lista), `RESEND_DOMAIN_VERIFIED=true` (declaração sua depois de verificar o domínio: DNS SPF/DKIM). Custo: o provedor tem plano gratuito com limite próprio — confira a página de preços; o CÓRTEX só limita, não contrata.

### SMS — Twilio
`TWILIO_ACCOUNT_SID` + (`TWILIO_AUTH_TOKEN` **ou** `TWILIO_API_KEY_SID`+`TWILIO_API_KEY_SECRET` — prefira a chave de API restrita), remetente (`ALERT_SMS_FROM` ou `TWILIO_MESSAGING_SERVICE_SID`), `ALERT_SMS_TO` (números em E.164 `+5511999998888` ou nacionais), `ALERT_SMS_SENDER_VERIFIED=true`.
**Atenção:** cada país/operadora tem regras próprias de remetente e de entrega no Brasil (pode exigir cadastro/aprovação). A declaração `…SENDER_VERIFIED` existe para você afirmar, **depois de conferir na documentação do provedor**, que o remetente está apto. Teste com `--test-notify` e **confirme no aparelho**: "aceito" não é "entregue". É conta paga/pré-paga: **não foi criada**.

### WhatsApp — somente integração oficial
Mensagem iniciada pela empresa exige **modelo (template) aprovado** no provedor. Dois caminhos oficiais, em ordem configurável:
- **WhatsApp Cloud API (Meta):** `META_WHATSAPP_TOKEN`, `META_WHATSAPP_PHONE_NUMBER_ID`, `ALERT_WHATSAPP_TEMPLATE_NAME` (e `…_LANG`, padrão `pt_BR`); o modelo precisa aceitar **um** parâmetro de corpo (o texto do alerta).
- **Twilio WhatsApp:** as credenciais Twilio acima + `TWILIO_WHATSAPP_FROM` (número habilitado para WhatsApp) + `TWILIO_WHATSAPP_CONTENT_SID` (modelo aprovado com **uma** variável `{{1}}`, que recebe o texto do alerta).
Em qualquer caminho: `ALERT_WHATSAPP_TO` e `ALERT_WHATSAPP_TEMPLATE_APPROVED=true` (declaração sua **depois** da aprovação). Nenhum modelo foi criado nem submetido; nenhum número foi cadastrado. Não há automação não oficial nem "WhatsApp Web".

Segredos **só** em variável de ambiente do servidor (ou cofre do provedor de hospedagem) — nunca no código, no Git, em log ou em captura de tela. `.env.example` lista os nomes, sem valores.

## 4. Como testar com segurança

1. **Sempre antes:** `npm run check-config --workspace=@ln-system/monitor` (monitor) e a tela de serviços externos (API) — dizem o que falta, sem mostrar segredo.
2. **Teste real de um canal** (gasta 1 mensagem, só quando você mandar): `node apps/monitor/dist/apps/monitor/src/main.js --test-notify`. A saída diz `ACEITO PELO PROVEDOR` ou `FALHOU: <motivo mascarado>` — e você confere no aparelho/caixa de entrada.
3. Por conta e risco financeiro **seu**: os limites padrão (3/h, 10/dia, 100/mês por canal) contêm o gasto, mas o preço por mensagem é do provedor.

## 5. Onde está no código

`packages/shared/utils/alert-channels.ts` (transportes puros, mascaramento, mensagem), `apps/api/src/services/monitoring-central/{channel-core,sms.service,whatsapp.service,resend.service,notifier}.ts` (limites, deduplicação, disjuntor, registro), `apps/monitor/src/notify.ts` (avisos do monitor independente). Testes: `alert-channels.test.ts`, `channels.test.ts`, `notifier.test.ts`, `resend.test.ts`, `apps/monitor/src/notify.test.ts`.
