# Oficina — regras novas de 2026-09-27

Este documento cobre só o que mudou na oficina em 2026-09-27. A máquina de estados completa da OS continua em
[contracts/business-state-machines.md §5](../contracts/business-state-machines.md).

## Encerramento da OS com decisão de garantia

- A transição **ENTREGA → ENCERRADA** (que já exigia pagamento confirmado) passa a levar a **decisão de garantia** no corpo
  de `POST /api/service-orders/:id/status`:

  ```json
  { "toStatus": "ENCERRADA", "warranty": { "decision": "NONE" } }
  { "toStatus": "ENCERRADA", "warranty": { "decision": "GRANTED", "coverage": "SERVICE_AND_PART", "durationValue": 3,
    "durationUnit": "MONTHS", "kmLimit": 3000, "startKm": 42350, "coveredItemIds": ["…"], "conditions": "…" } }
  ```

- Com a política padrão (`warranty.enabled` e `warranty.requireDecisionOnClose` ligados), encerrar sem decisão é recusado
  (400 `WARRANTY_DECISION_REQUIRED`). Garantia desligada: não pede decisão e recusa `GRANTED` (409 `WARRANTY_DISABLED`).
- A garantia é gravada **na mesma transação** do encerramento; a data de início é a da **ENTREGA** (`deliveryDate`).
- O km inicial informado no encerramento vira o **km de saída** da OS (`exitKilometer`) quando ainda não havia.
- Recusas de regra dessa rota agora respondem `{ message, code, statusCode }` (AppError); os demais erros da rota mantêm o
  400 `{ error }` de antes.
- `GET /api/service-orders/:id` traz `warranty` (com ocorrências).
- Admin Web: "Avançar para Encerrada" com a OS paga abre o diálogo de encerramento
  (`components/service-orders/CloseServiceOrderDialog.tsx`: sem/com garantia, tipo, prazo com atalhos, km "o que ocorrer
  primeiro", km inicial, itens cobertos a partir dos itens da OS, condições e observações; sugestões das políticas
  efetivas da filial). OS encerrada mostra o cartão "Garantia" (`WarrantyCard.tsx`).

Regra completa, vigência, ocorrências e códigos: [GARANTIA.md](GARANTIA.md).

## Desconto na OS

O desconto na OS (painel na tela da OS e rotas de desconto) foi implementado por outra frente em 2026-09-27 e é
documentado por ela — não faz parte deste documento.
