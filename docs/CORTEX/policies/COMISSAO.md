# Comissão

Comissão **não é uma funcionalidade nova**: é requisito do CÓRTEX desde o início e continua. Esta política só garante que a empresa (e a filial) possa **ligar ou desligar** o cálculo.

**Estado (2026-10-05): PARCIAL.** Implementado: política `commission.enabled` e comissão de mecânico (mão de obra da OS) com `ruleSnapshot`. **Pendente:** comissão sobre venda (PDV e canais), estados, fechamento, liquidação, dashboard de comissão — regra **ainda não definida** (decisão pendente 85 em [DECISIONS](../DECISIONS.md)); nada disso foi inventado no código.

## O que existe hoje

- **Política `commission.enabled`** (grupo "Comissão", Configurações › Políticas): padrão **ligada** (o comportamento anterior é preservado). A filial pode ter valor próprio. Desligada: **nenhuma comissão é calculada** e o pagamento da OS segue normal; o que já foi calculado não muda.
- **Comissão de mecânico (OS):** ao registrar o pagamento de uma OS com mecânico atribuído, e com a política ligada, a primeira **regra de comissão ativa** da empresa (`CommissionRule`) gera uma `MechanicCommission` com base apenas na **mão de obra** (`laborTotal`). Cada comissão guarda um **retrato da regra aplicada** (`ruleSnapshot`: regra, nome, tipo de serviço e percentual). Uma regra alterada depois (3% em janeiro, 5% em fevereiro) **não recalcula** o que já foi gerado.
- **Sem regra ativa** = "sem política": nenhuma comissão é criada, e isso **não é** uma comissão de R$ 0.

## Venda física (PDV): o que já fica registrado para a comissão futura

Toda venda guarda empresa, filial, **operador responsável** (`Sale.userId`), o caixa (`cashRegisterId`, que identifica o PDV) e os itens. A comissão futura de venda deve ser vinculada ao **operador**, não ao número do PDV: João vende no PDV 01 e no PDV 03 e o histórico continua "João → vendas". O PDV é contexto e auditoria.

## O que NÃO foi feito (e como deve ser quando for)

Não existe, ainda, comissão sobre **venda** (PDV ou canal). Quando houver, pela política da empresa:

- produtos ou categorias **elegíveis**, percentual ou valor fixo **vindos da configuração**, nunca fixos no código; produto sem comissão e produto com percentual diferente;
- vendedor/operador, vigência, regras de cancelamento e devolução, fechamento e liquidação;
- política **histórica**: a venda guarda a política aplicada no momento; mudar a política não recalcula o passado;
- estados distintos: sem política · política ativa · pendente de cálculo · calculada · aguardando fechamento · liquidada · estornada (hoje `MechanicCommission` só tem `isPaid`/`paidAt`);
- **canal externo ≠ comissionado**: venda de site, iFood ou marketplace pode não ter vendedor; só terá comissão com política explícita (venda direta sem vendedor, link de vendedor, retirada em loja...). Nada disso é assumido.

Dashboard de comissão (vendedor, vendas, itens, valor vendido, valor elegível, comissão, status) fica **reservado**, sem ranking obrigatório, respeitando permissões e privacidade (decisão 70).

## Arquivos

`services/policy.service.ts` (`commission.enabled`), `services/service-order.service.ts` (`registerPayment`), teste `service-order.service.test.ts` (o caso com a política desligada, e os de comissão que já existiam, preservados).
