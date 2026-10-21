# Políticas — privacidade, segurança, acesso e retenção (minuta)

> **Minuta para revisão jurídica.** Marcadores: **[PREENCHER]** informação do negócio; **[REVISÃO JURÍDICA]** texto/enquadramento a confirmar. Não alega certificação nem conformidade integral.

## 1. Política de Privacidade (versão para publicação, após revisão)

**Quem somos.** O CÓRTEX — Lógica de Negócios é uma plataforma de gestão para lojas de peças e oficinas de motocicletas. Responsável: **[PREENCHER: razão social, CNPJ, endereço]**. Encarregado (DPO): **[PREENCHER: nome e e-mail do encarregado]**.

**Dois papéis.** (a) Para os dados dos **clientes finais de cada loja** (cadastro, veículos, vendas, ordens de serviço), a **loja é a controladora** e o CÓRTEX atua como **operadora**, tratando os dados somente para prestar o serviço contratado e conforme as instruções da loja. (b) Para os dados dos **usuários da plataforma** (nome, e-mail, identificador, registros de acesso, chamados de suporte), o **CÓRTEX é controlador**.

**Que dados tratamos.** Usuários: nome, e-mail, telefone (opcional), identificador de login, perfil, registros de acesso e de ações. Clientes finais (por conta da loja): nome, CPF/CNPJ (opcional), telefone, e-mail, endereço, data de nascimento (opcional), veículos, histórico de compras e serviços. Equipamentos: identificação do computador do PDV e telemetria técnica (uso de CPU/memória/disco, versão).

**Para quê.** Prestar o serviço (vendas, caixa, estoque, oficina), segurança e prevenção de fraude, suporte, cumprimento de obrigações legais e fiscais **[REVISÃO JURÍDICA: bases legais por finalidade]**.

**Com quem compartilhamos.** Não vendemos dados pessoais nem os usamos para finalidade própria incompatível. Compartilhamos apenas com fornecedores necessários à prestação do serviço (hospedagem, e-mail, provedor fiscal, meios de pagamento), sob contrato e com o mínimo necessário — **lista em [INVENTARIO_E_FORNECEDORES.md](INVENTARIO_E_FORNECEDORES.md); [PREENCHER] fornecedores e países de armazenamento**.

**Por quanto tempo.** Pelo prazo necessário à finalidade e às obrigações legais (ver §5). **[REVISÃO JURÍDICA]**

**Seus direitos.** Confirmação de tratamento, acesso, correção, anonimização/eliminação quando cabível, portabilidade, informação sobre compartilhamento e revogação de consentimento, conforme a LGPD. Para dados de clientes de uma loja, procure a loja; para dados de usuários da plataforma, procure **[PREENCHER: canal do encarregado]**. Detalhes em [TITULARES_E_INCIDENTES.md](TITULARES_E_INCIDENTES.md).

**Segurança.** Controle de acesso por perfil, isolamento entre empresas, senhas armazenadas apenas como hash, dados sensíveis de integração cifrados, registro de ações e verificação em duas etapas para contas privilegiadas (ver §3).

## 2. Aviso de Privacidade nos pontos de coleta (texto curto)

| Ponto de coleta | Texto sugerido |
|---|---|
| Cadastro de cliente (Admin Web, Balcão, PDV) | "Os dados informados são usados para atendimento, vendas e serviços desta loja. Informe só o necessário. Seus direitos: fale com a loja." **[REVISÃO JURÍDICA]** |
| Login | "O acesso é pessoal e registrado. Ao entrar você concorda com o registro das suas ações para segurança." |
| Chamado de suporte | "Não inclua senhas, números de cartão ou dados pessoais desnecessários no texto." (já presente na Central de Ajuda) |
| Instalação do PDV | "Este computador será identificado e enviará dados técnicos de funcionamento ao servidor." |

> **Estado do produto:** estes avisos **ainda não estão nas telas** (só a orientação na Central de Ajuda). Inserir depois da revisão jurídica.

## 3. Política de Segurança da Informação (resumo operacional)

1. **Princípios:** mínimo privilégio, defesa em profundidade, falha fechada (na dúvida, nega), registro de ações sensíveis, segredos fora do código.
2. **Autenticação:** senha com hash forte; bloqueio por tentativas; MFA (TOTP) **obrigatório para Super Admin em produção**; sessões revogáveis no servidor; PDV/Balcão sem restauração de sessão.
3. **Segredos:** chaves e credenciais só em variáveis de ambiente/cofre; nunca no repositório, em log, em auditoria ou em resposta; dados sensíveis de integração e MFA cifrados em repouso.
4. **Dados:** isolamento por empresa/filial no banco (RLS) e no servidor; consultas sempre com escopo; testes de acesso cruzado.
5. **Rede:** HTTPS obrigatório em produção (aplicativos recusam HTTP); cabeçalhos de segurança; CSP no Balcão (painéis: pendente, decisão 108).
6. **Registro:** auditoria de ações (autor, alvo, horário, mudança); mudanças de permissão com `PERMISSION_CHANGED`.
7. **Continuidade:** backup e restauração testados em banco temporário; restauração em outro ambiente **pendente**.
8. **Mudanças:** migrations aditivas e reversíveis; revisão de diff; testes de regressão.
9. **Incidentes:** procedimento em [TITULARES_E_INCIDENTES.md](TITULARES_E_INCIDENTES.md).
10. **Pessoas:** contas individuais (sem compartilhamento), desativação imediata ao desligamento, treinamento básico **[PREENCHER]**.

## 4. Política de Controle de Acesso

| Regra | Como o sistema aplica |
|---|---|
| Acesso por função | perfis e permissões granulares por ação; atribuição só por Super Admin e Administrador da empresa; ninguém atribui perfil a si mesmo |
| Escopo | empresa e filial do token; o servidor ignora `companyId`/`branchId` enviados pelo cliente |
| Privilégio máximo | Super Admin de TI: MFA obrigatório em produção; ações auditadas; criação por procedimento administrativo (`npm run admin:bootstrap`), nunca por tela |
| Consulta | perfil de consulta nunca altera; custos/margens só para gestão ou compras |
| Revisão | revisar perfis atribuídos **[PREENCHER: periodicidade, sugerida trimestral]**; desativar contas inativas |
| Mudança | toda concessão/retirada de permissão gera registro com autor, alvo, escopo e operação |
| Dispositivos | PDV só opera em equipamento autorizado quando a política da empresa exige; bloqueio/revogação derruba a sessão na hora |

## 5. Política de Retenção e Descarte

| Dado | Prazo técnico atual | Observação |
|---|---|---|
| Registros de auditoria | **90 dias** (configurável `AUDIT_LOG_RETENTION_DAYS`) | **[REVISÃO JURÍDICA]**: ações financeiras podem exigir prazo maior |
| Logs de sistema / de requisição | 90 / 30 dias (`SYSTEM_LOG_RETENTION_DAYS`, `REQUEST_LOG_RETENTION_DAYS`) | sem senha/token |
| Telemetria de equipamento | 30 dias (`TELEMETRY_RETENTION_DAYS`) | só métricas técnicas |
| Incidentes de operação | 365 dias (`INCIDENT_RETENTION_DAYS`) | |
| Clientes e veículos | **sem prazo automático**; "excluir" apenas **desativa** | eliminação/anonimização = decisão 120 |
| Vendas, financeiro, fiscal | **não são apagados** (obrigação legal/fiscal; histórico imutável) | prazo legal **[REVISÃO JURÍDICA]** |
| Backups | **[PREENCHER]** retenção e criptografia (infraestrutura) | |

**Descarte:** nunca por exclusão física indiscriminada de registros fiscais, financeiros ou de auditoria. Eliminação de dados pessoais deve preservar o que a lei manda reter e registrar quem pediu, quando e o que foi feito.
