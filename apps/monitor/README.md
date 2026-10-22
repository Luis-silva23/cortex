# Monitor independente do CÓRTEX

Processo **separado** da API e do painel que mede, de fora, se o sistema responde, e **avisa por e-mail, SMS e WhatsApp** quando não responde. Foi feito para rodar **em outro provedor/região** que a plataforma monitorada: um monitor que roda dentro da infraestrutura que ele vigia cai junto com ela e não avisa ninguém.

> **Estado honesto (2026-10-22):** o código está pronto e testado (42 testes). **Nenhum monitor está implantado** em lugar nenhum, nenhum provedor real foi contactado e nenhuma mensagem real foi enviada. Isto **não é** monitoramento 24/7 até que o processo rode em um host externo e a verificação do fim desta página seja feita. Ver [docs/CORTEX/MONITORAMENTO_EXTERNO.md](../../docs/CORTEX/MONITORAMENTO_EXTERNO.md).

## O que faz

- Sonda cada alvo (HTTPS) a cada `intervalSec` (padrão 30 s): status esperado, texto esperado opcional, prazo, latência. Nunca envia credencial e nunca grava o corpo da resposta.
- **Proteção contra falso positivo:** retentativas rápidas (2×, 3 s) antes de contar uma falha; só **3 falhas seguidas** abrem a queda; só **2 sucessos seguidos** a encerram; **pontos de referência** (`controlUrls`): se nem eles respondem, o problema é a rede do próprio monitor e nada é acusado contra o alvo.
- Detecta **queda**, **lentidão** (mediana das últimas sondagens acima do limite por 3 avaliações) e **taxa de erros** (≥ 25% em 20 sondagens, falha intermitente que a regra de falhas seguidas não pega).
- **Agrupa:** se o alvo tem `parent` e o pai caiu, a queda do filho vai sob o pai e **não gera aviso próprio** (um problema, uma mensagem).
- **Avisa:** queda crítica → e-mail + SMS + WhatsApp (cada canal é uma tarefa independente, com retentativas e teto por hora); atenção → só e-mail; **recuperação** só vai ao canal que avisou da queda; lembrete a cada 60 min (até 6).
- Guarda o estado em arquivo (`state.json`, gravação atômica): reiniciar não perde incidente nem aviso pendente. Histórico de latência em `history.jsonl`.
- Opcional: envia resultados e incidentes assinados (HMAC) para `POST /monitor/v1/ingest` da API, para aparecerem em **Super Admin › Infraestrutura**. Se a API estiver fora, fica em fila e não perde nada.

O que **não** faz: não abre porta (nenhum servidor HTTP), não acessa banco, não monitora PostgreSQL/Redis (não são públicos; a API mede por dentro) e não confirma entrega no aparelho (só "aceito pelo provedor").

## Como rodar

```bash
cd apps/monitor
npm run build
cp monitor.example.json /caminho/seguro/monitor.json   # edite alvos e canais
export MONITOR_CONFIG_FILE=/caminho/seguro/monitor.json
export MONITOR_STATE_DIR=/var/lib/cortex-monitor
npm run check-config        # valida e imprime o resumo SEM segredos
node dist/apps/monitor/src/main.js --once --dry-run   # mede e decide; não avisa, não envia, não grava
node dist/apps/monitor/src/main.js --test-notify      # UMA mensagem de teste por canal configurado (só quando você mandar)
npm start                   # laço contínuo
```

Contêiner: `docker build -f apps/monitor/Dockerfile -t cortex-monitor .` (a partir da raiz). O `Dockerfile` **não foi executado** nesta máquina (sem Docker); a compilação foi provada numa cópia mínima isolada.

## Variáveis de ambiente (segredos só aqui, nunca no JSON nem no Git)

| Variável | Para quê |
|---|---|
| `MONITOR_CONFIG_FILE`, `MONITOR_STATE_DIR`, `MONITOR_ID`, `MONITOR_LOCATION` | arquivo de alvos, pasta de estado, identificação |
| `MONITOR_INGEST_URL`, `MONITOR_INGEST_SECRET` (≥ 32 caracteres) | envio ao painel (opcional); o **mesmo segredo** vai na API como `MONITOR_INGEST_SECRET` |
| `RESEND_API_KEY`, `ALERT_EMAIL_FROM`, `ALERT_EMAIL_TO`, `RESEND_DOMAIN_VERIFIED=true` | e-mail |
| `TWILIO_ACCOUNT_SID` + (`TWILIO_AUTH_TOKEN` ou `TWILIO_API_KEY_SID`+`TWILIO_API_KEY_SECRET`), `ALERT_SMS_FROM` ou `TWILIO_MESSAGING_SERVICE_SID`, `ALERT_SMS_TO`, `ALERT_SMS_SENDER_VERIFIED=true` | SMS |
| `META_WHATSAPP_TOKEN`, `META_WHATSAPP_PHONE_NUMBER_ID`, `ALERT_WHATSAPP_TEMPLATE_NAME`, `ALERT_WHATSAPP_TEMPLATE_APPROVED=true`, `ALERT_WHATSAPP_TO` (e/ou Twilio: `TWILIO_WHATSAPP_FROM`, `TWILIO_WHATSAPP_CONTENT_SID`) | WhatsApp |

Canal sem configuração completa **não envia** e o log diz "NÃO ENVIADO (faltam: …)" — nunca finge que avisou.

## Verificação para poder dizer "monitoramento externo ativo"

1. O processo roda em host **fora** da infraestrutura monitorada (outro provedor/região), com reinício automático.
2. `--check-config` passa e `--test-notify` entregou de verdade em cada canal que você pretende usar (confirmado por quem recebeu).
3. Em **Super Admin › Infraestrutura** o cartão "Monitor externo" mostra **Relatando** e os alvos aparecem "medidos de fora".
4. Derrubar de propósito um alvo de teste gera o aviso e a recuperação (ensaio controlado, não em produção).
5. A API tem o alerta `EXTERNAL_MONITOR_STALE`: se o monitor calar, o painel avisa.

## Testes

`npm test` (compila e roda `node --test`): configuração, sondagem, motor de decisão, persistência, avisos e envio ao painel — 42 testes, rede simulada.
