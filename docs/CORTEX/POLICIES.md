# Políticas do CÓRTEX

Regras de negócio que mudam de empresa para empresa (e, algumas, de filial para filial) não ficam
mais espalhadas em constantes: vivem no **catálogo de políticas**
([policy.service.ts](../../apps/api/src/services/policy.service.ts)) e são lidas por quem aplica a regra.

## Como funciona

| Conceito | Onde |
|---|---|
| Catálogo (chave, grupo, descrição, validação, padrão, se a filial pode sobrepor) | `POLICY_CATALOG` em `policy.service.ts` |
| Valor gravado | tabela `policy_settings` (única por empresa + filial + chave; filial vazia = empresa) |
| Histórico de alteração (antes, depois, motivo, quem, quando) | tabela `policy_changes` + `audit_logs` (`Policy`) |
| API | `GET /api/policies/effective`, `GET /api/policies`, `GET /api/policies/history`, `PUT /api/policies/:key`, `DELETE /api/policies/:key` |
| Tela | Admin Web → Configurações → **Políticas** |

**Resolução do valor efetivo:** filial (se a chave permite sobrepor) → empresa → padrão do catálogo. A
resposta sempre informa a **origem** (`BRANCH`, `COMPANY`, `DEFAULT`), e a tela mostra essa origem ao lado
do valor.

**Quem altera:** Super Admin e Administrador da empresa. Gerente lê. Usuário de filial só lê a própria
filial (403 `BRANCH_FORBIDDEN` para outra). Toda alteração exige **motivo** (mínimo 5 caracteres).

**Erros (PT-BR, nunca 500):** valor inválido → 400 `INVALID_POLICY_VALUE`; chave só de empresa com filial →
400 `POLICY_NOT_BRANCH_OVERRIDABLE`; corrida entre duas gravações → 409 `POLICY_CONFLICT`.

**Chaves que não aceitam sobreposição por filial** (decisão de segurança: quem autoriza não pode ser
afrouxado numa filial): `discount.authorizerRoles`, `cash.forceCloseRoles`, `cash.requireDifferenceReason`,
`agenda.requireCustomerConfirmation`, `agenda.completionAuthorizerRoles`, `supplierReturn.approverRoles`, cobrança.
Desde 2026-09-28 os convênios habilitados (`employeeAgreement.enabled`, `companyAgreement.enabled`) aceitam valor por
filial, e a capacidade da agenda (`agenda.maxPerDay`, `maxPerMonth`, `boxCount`, `defaultDurationMinutes`) também.

**Regra estrutural × política da empresa:** RLS, autorização, idempotência, auditoria, segurança e integridade
financeira são do sistema e não se configuram. Juros, multa, limites de convênio, capacidade da agenda, prazo de
orçamento, garantia, funcionamento, fechamento e condições comerciais são da empresa — nada disso fica fixo no código.

## Políticas por área

| Área | Documento |
|---|---|
| Empresa, filial, horário de funcionamento | [abaixo](#empresa-e-filial) |
| Desconto | [policies/DESCONTO.md](policies/DESCONTO.md) |
| Caixa (fechamento normal e forçado) | [policies/CAIXA.md](policies/CAIXA.md) |
| Fiscal | [policies/FISCAL.md](policies/FISCAL.md) |
| PDV (estados de pagamento, venda cancelada) | [policies/PDV.md](policies/PDV.md) |
| Segurança do PDV (MFA, papéis) | [policies/SEGURANCA-PDV.md](policies/SEGURANCA-PDV.md) |
| Orçamento | [policies/ORCAMENTO.md](policies/ORCAMENTO.md) |
| Agenda | [policies/AGENDA.md](policies/AGENDA.md) |
| Garantia | [policies/GARANTIA.md](policies/GARANTIA.md) |
| Oficina | [policies/OFICINA.md](policies/OFICINA.md) |
| Cliente | [policies/CLIENTE.md](policies/CLIENTE.md) |
| Convênios (funcionário e empresa conveniada) | [policies/CONVENIOS.md](policies/CONVENIOS.md) |
| Financeiro (recebíveis dos convênios) | [policies/FINANCEIRO.md](policies/FINANCEIRO.md) |
| Cobrança manual | [policies/COBRANCA.md](policies/COBRANCA.md) |
| Comissão (`commission.enabled`; só a de OS está implementada) | [policies/COMISSAO.md](policies/COMISSAO.md) |
| Devolução ao fornecedor (não é garantia ao cliente) | [policies/DEVOLUCAO-FORNECEDOR.md](policies/DEVOLUCAO-FORNECEDOR.md) |
| Segurança e auditoria (transversal) | [abaixo](#segurança-e-auditoria) |

## Empresa e filial

### Cadastro da empresa

`GET/PUT /api/company-profile` ([company-profile.service.ts](../../apps/api/src/services/company-profile.service.ts)),
tela Configurações → **Empresa**.

Campos: razão social, nome fantasia, CNPJ/CPF, inscrição estadual, inscrição municipal, regime tributário
(`SIMPLES_NACIONAL`, `SIMPLES_NACIONAL_EXCESSO`, `REGIME_NORMAL`, `MEI`), e-mail, responsável, telefone,
WhatsApp, CEP (8 dígitos), logradouro, número, complemento, bairro, cidade e UF.

- **CNPJ/CPF só o Super Admin altera** (identifica a licença) → 403 `DOCUMENT_CHANGE_FORBIDDEN`; documento
  de outra empresa → 409.
- Administrador da empresa edita os demais campos da **própria** empresa; gerente lê.
- A tabela `companies` continua protegida por RLS com `WITH CHECK is_super_admin()`. A gravação do
  cadastro usa uma elevação **estreita**, restrita ao `update` dos campos acima e à empresa do token, sem
  tocar `isActive`, `id` ou licença (testado).
- Auditoria `Company` com campos alterados, antes e depois.
- Nenhum campo fiscal foi inventado: CSC, certificado, série e ambiente continuam na configuração fiscal
  própria ([policies/FISCAL.md](policies/FISCAL.md)).

A filial ganhou IE, e-mail, WhatsApp e endereço estruturado (logradouro, número, complemento, bairro).

### Horário de funcionamento

`/api/business-hours` ([business-hours.service.ts](../../apps/api/src/services/business-hours.service.ts)),
tela Configurações → **Funcionamento**.

- Semana (domingo a sábado): fechado ou abertura/fechamento, com intervalo opcional.
- A filial pode ter semana própria; sem ela, segue a da empresa ("Seguir o horário da empresa").
- Exceções por data: `HOLIDAY` (feriado), `CLOSED` (fechamento excepcional) e `SPECIAL_HOURS` (horário
  especial). A exceção da filial prevalece sobre a da empresa.
- `GET /api/business-hours/check?at=` responde `{configured, open, reason}` no fuso da política
  `company.timezone` (padrão `America/Sao_Paulo`, sobreponível por filial).
- **Sem horário cadastrado = "não configurado"**, nunca "aberto" por suposição. A agenda só bloqueia
  horário quando existe configuração e `agenda.respectBusinessHours` está ligada.

## Segurança e auditoria

- **Papéis:** a autorização de exceções (desconto acima do livre, fechamento forçado, conclusão de
  agendamento sem confirmação) usa `verifyDualAuthorization`: **solicitante ≠ autorizador**, autorizador
  com papel da política e MFA quando exigido. Nenhuma proteção foi removida para facilitar a operação.
- **Tenant:** `companyId` e filial vêm do token; `req.body`/`req.query`/headers nunca definem a empresa. Todas
  as tabelas novas têm RLS `FORCE` com `rls_company_branch_match`.
- **Evidência imutável:** `discount_events` e `collection_attempts` só aceitam `SELECT` e `INSERT` para a
  aplicação. A exclusão existe apenas para limpeza de teste/retenção pela plataforma (Super Admin com
  `app.audit_purge='on'` na transação), igual a `audit_logs`.
- **Auditoria:** toda alteração de política, horário, cadastro, desconto, fechamento forçado, orçamento
  encerrado/reaberto, garantia, convênio e tentativa de cobrança grava quem, empresa, filial, antes, depois,
  motivo e data/hora.
- **Respostas:** recusas de negócio são 400/403/409/422 com mensagem em PT-BR e código; nada de stack
  trace, caminho ou SQL.
