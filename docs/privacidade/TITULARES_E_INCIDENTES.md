# Atendimento aos titulares e resposta a incidentes (procedimento)

> **Minuta operacional, sem revisão jurídica.** Prazos legais e enquadramentos **devem ser confirmados com assessoria jurídica**; aqui estão indicados como **[REVISÃO JURÍDICA]**.

## A. Direitos dos titulares

### Quem atende

- Pedido sobre dados de **cliente final de uma loja** → a **loja** (controladora). O CÓRTEX (operadora) apoia tecnicamente **a pedido da loja**, sem responder ao titular por ela.
- Pedido sobre dados de **usuário da plataforma** → o **CÓRTEX** (controlador): encarregado **[PREENCHER]**.

### Fluxo

1. **Registrar** o pedido (data, canal, titular, direito exercido): a tela **Admin Web › Privacidade (LGPD)** (só o administrador da empresa) já guarda quem pediu, quando, a justificativa e o resultado de cada exportação/anonimização. O canal de entrada do pedido (e-mail, balcão) continua sendo da loja — registre o protocolo na justificativa, **sem dado pessoal no texto**.
2. **Confirmar a identidade** do solicitante antes de entregar ou alterar qualquer dado (documento/dado já conhecido; nunca por canal não verificado).
3. **Executar** conforme o direito (tabela abaixo) com usuário autorizado; tudo fica na auditoria.
4. **Responder** ao titular no prazo legal **[REVISÃO JURÍDICA: prazo]** e registrar a conclusão.

### Como cada direito é atendido hoje

| Direito | O que existe | Como atender |
|---|---|---|
| Confirmação / acesso | **exportação do titular** (Admin Web › Privacidade; `/api/privacy`): JSON estruturado só com os dados do cliente (cadastro, veículos, orçamentos, vendas, OS, revisões, agenda, garantias, contas a receber, tentativas de cobrança e a trilha do cadastro, **sem** dados de outros clientes nem de cartão), cifrado, válido 24 h e até 3 downloads | administrador identifica o titular, informa a justificativa e a senha, baixa o arquivo e o entrega por canal seguro **depois de confirmar a identidade do solicitante** |
| Correção | edição do cadastro | administrador/gerente edita; fica na auditoria |
| Anonimização / eliminação | **anonimização irreversível** do cadastro e dos textos livres ligados ao cliente (Admin Web › Privacidade): planeja (mostra o que muda e o que é retido), exige a senha para executar, tudo numa transação. **Não apaga** vendas, financeiro nem fiscal: valores, datas, números e vínculos ficam | ver "Dados que precisam ser retidos" — o resultado pode ser **concluído**, **parcial** (retenção fiscal/garantia) ou **bloqueado** (cobrança em aberto); a resposta ao titular diz qual |
| Portabilidade | a mesma exportação (JSON estruturado, formato `cortex.data-subject-export.v1`) | como em "Confirmação / acesso"; o formato é o do próprio CÓRTEX (**[REVISÃO JURÍDICA]** sobre o formato a entregar) |
| Revogação de consentimento | o sistema não registra consentimento por cadastro | a loja trata conforme a base legal que usa |
| Informação sobre compartilhamento | inventário/fornecedores | ver [INVENTARIO_E_FORNECEDORES.md](INVENTARIO_E_FORNECEDORES.md) |

### Dados que precisam ser retidos

Registros **fiscais, financeiros, de garantia** e **de auditoria** não são eliminados a pedido do titular quando houver obrigação legal ou exercício regular de direitos. A resposta ao titular deve **informar** o que foi mantido e por quê. **[REVISÃO JURÍDICA]**

O que o sistema faz hoje (regras técnicas, **a validar pelo jurídico/contador**):

| Situação | O que o sistema faz |
|---|---|
| Cliente com documento fiscal **autorizado** nos últimos 5 anos (`PRIVACY_FISCAL_RETENTION_YEARS`) | mantém **nome e CPF/CNPJ** (e as observações das vendas com documento) até o fim do prazo; apaga o contato, endereço e observações → resultado **parcial**, com a data de fim da retenção |
| Garantia vigente | mantém placa, chassi e motor do veículo até o fim da garantia; anonimiza o titular → **parcial** |
| Cobrança em aberto, venda não quitada ou OS em andamento | **bloqueia** (nada muda) até a situação se resolver (exercício regular de direitos / execução do contrato) |
| Tentativas de cobrança já registradas | são **evidência que não pode ser reescrita**: o destinatário (telefone/e-mail) permanece → **parcial** |
| Trilha de auditoria, pedidos de canais externos (o conteúdo do pedido não tem vínculo com o cadastro) e backups | **fora do alcance** da anonimização; seguem o ciclo de retenção deles — a resposta ao titular deve dizer isso |
| Risco de reidentificação | datas, valores e modelo do veículo continuam nos registros financeiros; numa loja pequena isso pode permitir reidentificar a pessoa. Avaliar caso a caso **[REVISÃO JURÍDICA]** |

## B. Resposta a incidentes de segurança

### Definição

Incidente: qualquer evento que comprometa confidencialidade, integridade ou disponibilidade de dados pessoais (acesso indevido, vazamento, perda, alteração não autorizada, credencial exposta, dispositivo comprometido).

### Fluxo interno

| Etapa | Ação | Responsável |
|---|---|---|
| 1. Detectar/reportar | qualquer pessoa avisa o responsável de TI (chamado marcado como segurança) | todos |
| 2. Conter | revogar sessões (`bloquear/revogar equipamento`, desativar usuário, trocar senha), revogar credencial/segredo exposto, isolar sistema | TI |
| 3. Preservar evidência | auditoria e logs (não apagar), data/hora, quem, o quê, sistemas | TI |
| 4. Avaliar | quais dados/titulares/empresas; risco ou dano relevante; houve acesso de fato | TI + encarregado |
| 5. Decidir comunicação | **à ANPD e aos titulares**, quando houver risco ou dano relevante, conforme a **Resolução CD/ANPD nº 15/2024** — conferir o prazo e o conteúdo mínimos vigentes (a norma fixa prazo curto, contado do conhecimento do incidente) **[REVISÃO JURÍDICA]**; empresas-clientes afetadas são avisadas pelo CÓRTEX (operadora) para que cumpram seus deveres de controladoras | encarregado + jurídico |
| 6. Corrigir | causa raiz, correção, teste de regressão | TI |
| 7. Registrar | relatório do incidente (linha do tempo, dados afetados, decisões, comunicações) e lições | encarregado |

Nem todo incidente exige a mesma comunicação: a decisão deve ser **fundamentada e registrada**, inclusive quando se conclui que **não** há dever de comunicar.

### Como o sistema ajuda

- Revogação imediata de sessão de usuário/equipamento (efeito na hora, no servidor).
- Auditoria com autor, horário e alteração; trilha de login falho.
- `incident` e alertas de operação para falhas técnicas (retenção 365 dias).
- Segredos cifrados em repouso e rotacionáveis.

### Contatos **[PREENCHER]**

Encarregado (DPO): … · Responsável de TI: … · Jurídico: … · Canal de abertura (chamado/telefone): …
