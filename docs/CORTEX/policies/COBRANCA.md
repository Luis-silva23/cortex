# Cobrança — manual e autorizada

> Área: convênios (2026-09-27). Código: `apps/api/src/services/collection.service.ts`,
> `apps/api/src/services/channels/` (camada de canal), `routes/receivables.routes.ts`. Tela: Admin Web ›
> Financeiro › conta a receber (`/dashboard/financial/receivables/[id]`).

## Princípio

**O CÓRTEX não é robô de cobrança nesta fase.** Não há envio automático, conversa automática nem job de cobrança
(teste: nenhum job com "collect/cobran" em `SCHEDULED_JOB_NAMES`; o job de bloqueio não cria tentativas).

Gerente ou Administrador (política `collection.allowedRoles`, padrão `MANAGER` + `COMPANY_ADMIN`) abre uma conta
**vencida** e clica **[ENVIAR COBRANÇA]**, escolhendo WhatsApp, e-mail ou os dois (canais habilitados em
`collection.channels`). **Uma mensagem por canal naquela ação.** Depois disso, a conversa é manual, pelo responsável.
Nova cobrança só por nova ação humana. A tela manda um `Idempotency-Key` por ação: duplo clique não gera duas mensagens.

## API

| Chamada | Quem | Efeito |
|---|---|---|
| `GET /api/receivables/:id` | não-mecânico, módulo FINANCEIRO | detalhe: devedor, dias de atraso, juros/multa informativos, tentativas, política |
| `GET /api/receivables/:id/collections` | idem | histórico (nº da tentativa, quem, quando, canal, destinatário, valor, vencimento, resultado) |
| `POST /api/receivables/:id/collections` `{ channels: ['WHATSAPP'\|'EMAIL'] }` | perfis de `collection.allowedRoles` | uma tentativa por canal; `201` com `attempts[]` (e `link` do WhatsApp) |

Recusas: `403 COLLECTION_FORBIDDEN` (perfil fora da política), `400 CHANNEL_DISABLED` (canal desligado na política),
`400 VALIDATION_ERROR` (canal inválido/vazio/repetido), `409 RECEIVABLE_NOT_OVERDUE` (conta paga, cancelada ou a vencer),
`404 RECEIVABLE_NOT_FOUND` (inclusive de outra empresa).

## Registro (`collection_attempts`, append-only)

Quem enviou (`sentBy`), data/hora, conta, conveniada, valor, vencimento, canal, destinatário usado, resultado
(`status`), provedor e mensagem do provedor. Linha da empresa inteira (`branchId` nulo) para o histórico ser o mesmo
em todas as filiais. Auditoria da rota: `CollectionAttempt` com canais e resultados. O log de sistema mascara o
destinatário (`***6666`, `fi***@dominio`); nenhum token/senha é registrado.

## Camada de canal (`services/channels/`)

Interface `ChannelProvider { name, channel, send(message) }` e registro `registerChannelProvider()`/`providerFor()` —
mesmo desenho de `payment-adapters/`. O financeiro não conhece o mecanismo de envio.

| Canal | Provedor atual | Resultado |
|---|---|---|
| WhatsApp | `whatsapp-click-to-chat` — **provisório**, sem API oficial | `LINK_GENERATED`: link `https://wa.me/55DDDNUMERO?text=<mensagem>`; a tela abre o WhatsApp do usuário e **quem envia é o usuário**. Nunca `SENT` (o CÓRTEX não sabe se foi enviada). Número ausente/inválido → `FAILED`. |
| E-mail | `email-not-configured` | `NOT_CONFIGURED` honesto — **nunca "enviado"**. |

**Futuro**: um `WhatsAppProvider` oficial (WhatsApp Business API) ou um provedor de e-mail (SMTP/SES/…) implementa
`ChannelProvider` e se registra no boot (ex.: quando `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM`
estiverem definidos). Nenhum transporte SMTP está instalado neste build: mesmo com `SMTP_HOST` definido o resultado
continua `NOT_CONFIGURED`, dizendo o porquê. Nenhum provedor foi inventado.

## Mensagem padrão (PT-BR)

```
Olá, <responsável ou conveniada>!
Aqui é da <empresa credora>.
Consta em aberto: <descrição da conta>.
Valor: R$ 400,00 — vencimento em 22/09/2026 (5 dias de atraso).
Por favor, entre em contato para combinarmos a regularização. Se o pagamento já foi feito, desconsidere esta mensagem.
```

Sem CPF/CNPJ, itens ou outro dado sensível. Devedor: conveniada (WhatsApp → telefone; e-mail) ou, em conta de
cliente, o cliente (WhatsApp → celular → telefone; e-mail).

## [DECISÃO NECESSÁRIA]

Definido pelo dono em 2026-09-28: **não há obrigação de integração oficial agora** — a cobrança é manual (link do
WhatsApp aberto pelo usuário; e-mail sem provedor aparece como "não configurado"); a troca por provedor oficial é só
um adaptador em `services/channels/`, sem mudar o domínio. **Proibido**: robô autônomo, conversa automática e
lembrete recorrente automático.

1. Qual provedor oficial de WhatsApp/e-mail contratar, e quando (credenciais fora do repositório).
2. Lembrete **manual** de conta ainda não vencida (uma ação humana, não recorrente) — hoje recusado.
3. Limite de frequência entre ações de cobrança da mesma conta (hoje só a idempotência por ação).
