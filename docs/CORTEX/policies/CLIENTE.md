# Cadastro de cliente

Decidido pelo dono em 2026-09-27. Código: `apps/api/src/services/customer.service.ts`, `routes/customers.routes.ts`,
validadores `customerSchema`/`updateCustomerSchema` em `packages/shared/src/validators/pdv.validators.ts`; telas
`apps/admin-web/app/dashboard/customers/**` (campos em `components/customers/CustomerFormFields.tsx`, checagem em
`lib/customers.ts`) e cadastro rápido do PDV `apps/pdv-desktop/src/components/CustomerSearchModal.tsx`.

## Campos (conforme aplicabilidade)

Nome (obrigatório), tipo (pessoa física/jurídica), CPF/CNPJ, data de nascimento (pessoa física), telefone, **WhatsApp**,
e-mail, endereço (rua, cidade, UF, CEP) e **contato preferencial** (`PHONE`, `WHATSAPP`, `EMAIL`, `SMS`, `IN_PERSON`).
Um cliente pode ter vários veículos (inalterado). Todos opcionais exceto o nome: o balcão continua cadastrando só com o nome.

- WhatsApp: DDD + número (10 a 13 dígitos, com ou sem 55).
- Nascimento: não pode ser futura nem anterior a 1900.
- Na edição, campo vazio **limpa** o valor.

## CPF/CNPJ

- Informado ⇒ precisa ter **dígito verificador válido** (11 dígitos = CPF, 14 = CNPJ): senão **400 `INVALID_DOCUMENT`**.
  Vazio continua permitido (vários clientes sem documento).
- **Duplicidade por dígitos** dentro da empresa: `529.982.247-25`, `52998224725` e qualquer outra formatação gravada são o
  mesmo cliente ⇒ **409 `CUSTOMER_DOCUMENT_DUPLICATE`** ("Já existe cliente com este CPF/CNPJ nesta empresa: <nome>").
  A comparação é feita no banco sobre os dígitos do valor gravado, então também pega documento legado gravado sem máscara.
  Outra empresa pode ter o mesmo CPF.
- **Formato gravado**: documento novo ou alterado é gravado no formato padrão (`000.000.000-00` / `00.000.000/0000-00`).
  **Nenhum dado existente é migrado**: se a edição reenvia o mesmo documento (mesmos dígitos), o valor gravado fica como
  está — inclusive documento legado inválido, que não impede editar o resto do cadastro.
- Sem tipo informado (cadastro rápido do PDV), CNPJ ⇒ pessoa jurídica.
- A busca (lista e busca rápida do PDV) acha o CPF/CNPJ completo digitado com ou sem máscara, e também procura no WhatsApp.

## Contato preferencial coerente

| Preferência | Exige |
|---|---|
| WhatsApp | WhatsApp preenchido |
| E-mail | e-mail preenchido |
| Telefone / SMS | telefone ou celular preenchido |
| Presencial | nada |

Incoerente ⇒ **400 `PREFERRED_CONTACT_INCOHERENT`** com mensagem PT-BR (vale na criação e na edição, comparando com o que
já está gravado — limpar o WhatsApp de quem prefere WhatsApp é recusado).

## Respostas e permissões

- Erros do cadastro mantêm o corpo `{ error, code }` que PDV e Admin Web já exibem. Conflito da unique no banco (corrida)
  também vira 409 `CUSTOMER_DOCUMENT_DUPLICATE` (antes: 400 com texto em inglês).
- Permissões inalteradas: criar = todos menos VIEWER (fluxo do PDV); editar/desativar = gerência+.
- Auditoria inalterada (`CREATE`/`UPDATE Customer`).

## Provas

- `apps/api/test/integration/customer-registration.integration.test.ts` (9 casos, HTTP + Postgres): CPF inválido recusado;
  duplicado com/sem máscara recusado; duplicado contra legado só-dígitos (sem migrar); outra empresa e documento vazio
  permitidos; CNPJ vira pessoa jurídica; contato preferencial incoerente (WhatsApp/e-mail/telefone); cadastro completo na
  lista, detalhe e busca do PDV; edição (limpar WhatsApp preferido, CPF inválido, CPF de outro cliente); legado inválido
  continua editável.
- Unitários: `customer.schema.test.ts`, `customers.routes.test.ts`; Admin Web `lib/customers.test.ts`.

## Pendências

- Documentos legados fora do padrão continuam como estão; uma normalização em massa (e a revisão dos inválidos) é decisão
  do dono — não foi feita.
- Não há checagem de coerência entre tipo (PF/PJ) e CPF/CNPJ além da sugestão automática no cadastro rápido.
