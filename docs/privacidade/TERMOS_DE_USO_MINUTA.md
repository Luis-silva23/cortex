# Termos de Uso do CÓRTEX — MINUTA para revisão jurídica

> **Status: minuta técnica, NÃO é o contrato.** Escrita a partir do que o sistema **realmente faz** (verificado no código e nos testes). Tudo que é **comercial ou jurídico** está marcado **[PREENCHER]** ou **[REVISÃO JURÍDICA]**: preço, prazo, multa, foro, limites de responsabilidade, prazos de retenção e o enquadramento LGPD não foram inventados. Só vale depois de revisada por advogado e aprovada pelo proprietário.

## 1. Partes e objeto
- **CÓRTEX** [PREENCHER: razão social, CNPJ, endereço] licencia o uso de uma plataforma de gestão (estoque, vendas, caixa, oficina/ordens de serviço, convênios, financeiro) à **Empresa Contratante** [PREENCHER].
- Aplicativos incluídos conforme a licença: Admin Web, PDV Desktop (Windows 64 bits), Balcão, app do mecânico (Android), painel de TV (Android TV). O que **não** está incluído está na seção 4.

## 2. Licença, limites e vigência
- O uso é regido pela **licença** emitida para a empresa: tipo, validade e limites de **filiais, equipamentos (dispositivos) e usuários ativos**. Ao atingir um limite o sistema recusa novos cadastros até a regularização.
- Preço, periodicidade, reajuste, forma de pagamento, período de teste e renovação: **[PREENCHER — decisão do proprietário]**.
- Licença vencida, rejeitada ou empresa **bloqueada** impedem o acesso de todos os usuários; **nenhum dado é apagado** por isso.

## 3. Responsabilidades da Empresa Contratante
- Designar administradores, guardar suas credenciais e **configurar a verificação em duas etapas (MFA)**, obrigatória para administradores em produção.
- Cadastrar usuários com o papel e as filiais corretos; **desativar** quem sair. A senha entregue a um usuário é **temporária** e deve ser trocada no primeiro acesso.
- Conferir os valores lançados no caixa: o cartão é **confirmado pelo operador na maquininha** e o PIX fica **pendente até a conciliação humana** — o sistema não recebe confirmação automática do banco ou da operadora.
- Cumprir as obrigações **fiscais** próprias (ver seção 4) e a LGPD como **controladora** dos dados dos seus clientes **[REVISÃO JURÍDICA]**.

## 4. O que o serviço NÃO faz (para não gerar expectativa indevida)
- **Não emite documento fiscal** (NFC-e/NF-e): a empresa deve emitir por meio próprio ou de terceiro **[PREENCHER: se e quando haverá integração fiscal]**.
- **Não processa pagamentos** nem se integra a adquirente/PSP/TEF; não há conciliação bancária automática.
- **Não envia** cobranças por e-mail ou WhatsApp automaticamente; cobrança e pós-venda são ações humanas registradas no sistema.
- **Não há recuperação de senha por e-mail:** a redefinição é feita por um administrador da empresa.

## 5. Segurança, dados e disponibilidade
- Isolamento entre empresas e entre filiais no banco e na API; senhas armazenadas somente como hash; segredos de integração e MFA cifrados; auditoria das ações sensíveis ([SECURITY](../CORTEX/SECURITY.md), [POLITICAS](POLITICAS.md)).
- **Backup e recuperação:** metas de recuperação (RPO/RTO), retenção dos backups e disponibilidade (SLA) **[PREENCHER — hoje são propostas não aprovadas, ver BACKUP_RECUPERACAO]**. Nenhuma garantia de disponibilidade é dada por esta minuta.
- Tratamento de dados pessoais: CÓRTEX como **operadora** dos dados da empresa e **controladora** dos dados de usuários da plataforma **[REVISÃO JURÍDICA]**; direitos dos titulares e incidentes: [TITULARES_E_INCIDENTES](TITULARES_E_INCIDENTES.md); cláusulas: [CLAUSULAS_E_RIPD](CLAUSULAS_E_RIPD.md).

## 6. Suporte
- Chamados pela Central de Ajuda do próprio sistema. Horário, canais e prazos de resposta (SLA): **[PREENCHER]**.

## 7. Suspensão, cancelamento e devolução dos dados
- **Suspensão** por inadimplência ou uso indevido: bloqueio de acesso da empresa, reversível, sem apagar dados **[PREENCHER: prazos e avisos]**.
- **Cancelamento:** a empresa pode exportar seus dados antes do encerramento. Registros financeiros, fiscais e de auditoria seguem **retidos pelos prazos legais** e não são apagados por pedido do titular; dados pessoais não sujeitos a retenção podem ser **anonimizados** de forma irreversível **[REVISÃO JURÍDICA: prazos de retenção e de eliminação]**.

## 8. Limitação de responsabilidade, foro e disposições gerais
**[PREENCHER / REVISÃO JURÍDICA]** — limites de responsabilidade, multa, penalidades, propriedade intelectual, confidencialidade, alterações destes termos, lei aplicável e foro. Nada deste item foi redigido por falta de decisão do proprietário e de revisão jurídica.
