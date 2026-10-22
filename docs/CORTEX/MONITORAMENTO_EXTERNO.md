# Monitoramento externo e tela de Infraestrutura

Atualizado em 2026-10-22. Escrito para quem opera a plataforma e vai decidir onde implantar o monitor.

> **Estado honesto:** o monitor está **pronto e testado, mas NÃO implantado**. Não existe hoje nenhum processo externo vigiando o CÓRTEX; portanto **não há monitoramento 24/7 real**. A tela de Infraestrutura mostra isso de forma explícita ("Monitor externo: Desligado / Nunca relatou").

## 1. Por que um monitor separado

O monitoramento que já existia roda **dentro** da API (um job a cada minuto grava amostras). Se a API, o servidor ou a rede caírem, esse job cai junto — ninguém é avisado de que **tudo** parou. O monitor independente (`apps/monitor`) é outro processo, em outro lugar, sem banco e sem porta aberta: mede por HTTPS, decide e avisa sozinho.

```
 [host externo]                                   [infraestrutura do CÓRTEX]
  apps/monitor ──HTTPS sonda──▶ site / API (/api/health/ready)
      │  decide (3 falhas seguidas, grupos, lentidão, erros)
      ├── avisa direto: e-mail / SMS / WhatsApp (não passa pela API)
      └── POST assinado ─────────▶ /monitor/v1/ingest ─▶ service_health_samples (EXT_<ALVO>)
           (opcional; fila local se a API estiver fora)          └▶ monitoring_alerts (origem EXTERNAL)
                                                                         ▼
                                                    Super Admin › Infraestrutura
```

## 2. Proteções contra falso positivo
Retentativas rápidas antes de contar falha · 3 falhas seguidas para abrir / 2 sucessos para fechar · mediana (não pico) para lentidão · **pontos de referência**: se nem eles respondem, a rede do monitor é que caiu e **nada é acusado** (provado em execução real, ver §6) · agrupamento por alvo "pai" (uma mensagem só) · lembretes limitados · teto por hora e por canal · estado persistido (reinício não duplica nem perde aviso).

## 3. Entrada na API (`/monitor/v1/ingest`)
Superfície de máquina própria, fora de `/api`: sem JWT de usuário e sem CORS; corpo ≤ 256 KB lido cru; **assinatura HMAC-SHA256** (mesmo código da Commerce API, janela de 300 s) com segredo exclusivo `MONITOR_INGEST_SECRET` (≥ 32 caracteres, só variável de ambiente); falha de assinatura conta no limite por IP; validação campo a campo (alvo, tipo, tamanhos, relógio plausível); resposta de falha de identidade sempre igual (401). **Sem o segredo a entrada fica desligada (503).** Reenvio não duplica amostra; reenvio atrasado de incidente já encerrado **não reabre** o alerta. Alerta de origem `EXTERNAL` é registrado pelo mesmo mecanismo da Central de Alertas, **sem aviso duplicado**.

Homem-morto: se o monitor já relatou alguma vez e calou por `MONITOR_STALE_MINUTES` (10), a API abre o alerta `EXTERNAL_MONITOR_STALE`.

Sondas públicas `/api/health` e `/api/health/ready`: chamadas simultâneas dividem **uma** verificação e o resultado vale `HEALTH_CACHE_MS` (2 s) — uma enxurrada não vira enxurrada no banco.

## 4. Tela Super Admin › Infraestrutura
Menu principal. Mostra apenas o que é **monitorado de verdade**: serviços e dependências (API, banco, Redis, filas, servidor, backup e alvos medidos de fora) com estado, última verificação, latência atual/média/p95, disponibilidade e falhas; gráficos no tempo (**Linha por padrão, Colunas como alternativa** — o mesmo componente do restante do painel) de latência, disponibilidade, volume de requisições, taxa de 5xx, latência da API e uso do servidor; classes e códigos HTTP (5xx em destaque); backup; estado dos canais de aviso (E-mail/SMS/WhatsApp/Sentry, com o que falta); **incidentes** (técnicos × operacionais, duração, recuperação automática/manual, causa provável e orientação) lidos da **mesma** tabela da Central de Alertas (sem duplicar registros). Filtros: serviço, gravidade, estado, tipo; períodos 1 h / 24 h / 7 d / 30 d. Estados de carregando, vazio ("sem dados", nunca "100%") e erro; atualiza a cada 30 s; responsivo. Exclusivo de SUPER_ADMIN (administrador, gerente e operador recebem 403 — provado em teste de integração). A aba antiga "Infraestrutura" de Observabilidade passou a se chamar **"Servidor e filas"** (mesmo conteúdo, sem duplicar nome).

## 5. Onde implantar (decisão sua — nada foi contratado)
Requisito: **fora** da infraestrutura monitorada (outro provedor ou, no mínimo, outra região/conta), com reinício automático e relógio correto.
- **Uma máquina pequena em outro provedor** (qualquer VM Linux com Docker ou só Node 20). Preferida.
- **Uma máquina sua sempre ligada** (menos confiável: depende de energia/internet suas).
- O monitor **não** deve rodar na mesma VM/rede da API (cai junto) nem depender de PostgreSQL/Redis.
Cuidados: guardar `monitor.json` e as variáveis num lugar seguro; volume persistente para `/data`; e-mail/SMS/WhatsApp só depois de conferir `--check-config` e `--test-notify`.

## 6. O que foi provado e o que não foi

| Provado (local, simulado) | Como |
|---|---|
| 42 testes do monitor + testes da API (ingestão, rota assinada, alerta EXTERNAL sem aviso, infraestrutura, sondas de saúde) | `npm test --workspace=@ln-system/monitor`; `jest` na API; integração com Postgres/Redis reais (110/110 em `monitoring-central`) |
| Processo real `main.js --once` contra servidores locais: saudável → 3 falhas abrem `EXTERNAL_ALVO_DOWN` → canais sem configuração registrados como **NÃO ENVIADO** → 2 sucessos recuperam → rede de referência fora **não acusa** → 6 envios assinados ao painel simulado, todos com assinatura válida, nenhum segredo no estado | `node apps/monitor/scripts/smoke-local.js` (depois de `npm run build --workspace=@ln-system/monitor`) |
| **Não provado** | monitor rodando em host externo · envio real por qualquer canal · entrega no aparelho · `Dockerfile` executado (sem Docker aqui) · Super Admin › Infraestrutura em produção com dados de um monitor real |

## 7. Checklist para declarar "monitoramento externo ativo"
Ver o fim de [apps/monitor/README.md](../../apps/monitor/README.md). Enquanto os itens não estiverem cumpridos e verificados, **não** chame de 24/7.
