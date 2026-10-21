# Inventário das operações de tratamento e registro de fornecedores

> **Minuta.** Montado a partir do modelo de dados e do código do CÓRTEX. **[PREENCHER]** = depende de contrato/infraestrutura ainda não definidos. Nenhum fornecedor foi inventado: o que não está contratado aparece como **não definido**.

## 1. Inventário (visão por operação)

| # | Operação | Titulares | Dados | Finalidade | Base legal sugerida **[REVISÃO JURÍDICA]** | Papel do CÓRTEX | Onde fica | Acesso | Retenção |
|---|---|---|---|---|---|---|---|---|---|
| 1 | Cadastro de clientes | clientes finais das lojas | nome, CPF/CNPJ, telefone/WhatsApp, e-mail, endereço, nascimento, observações | atendimento, venda, garantia, cobrança | execução de contrato / legítimo interesse da loja | operadora | PostgreSQL (`customers`) | perfis com permissão; RLS por empresa | até decisão 120 (hoje só desativa) |
| 2 | Veículos do cliente | clientes | placa, marca/modelo, ano, km, histórico de OS | oficina, revisões, garantia | execução de contrato | operadora | `motorcycles`, `service_orders`, `quotes` | idem | idem |
| 3 | Vendas e pagamentos | clientes, operadores | itens, valores, forma de pagamento, referência da transação; **sem** número de cartão/CVV | venda, caixa, financeiro, fiscal | obrigação legal / execução de contrato | operadora | `sales`, `payments`, `cash_*` | financeiro/caixa | **não apagar** (legal) |
| 4 | Contas e acesso de usuários | funcionários e administradores | nome, e-mail, telefone, ID de login, perfil, hash de senha, segredo MFA (cifrado) | autenticação e autorização | execução de contrato / legítimo interesse (segurança) | controlador | `users`, `refresh_tokens`, `roles*` | admin da empresa; Super Admin | enquanto a conta existir |
| 5 | Auditoria e segurança | usuários | autor, ação, entidade, IP, user-agent, horário | prestação de contas, segurança | legítimo interesse / obrigação legal | controlador (e operadora para a loja) | `audit_logs`, `system_logs`, `request_logs` | gestão/SA | 90/90/30 dias (configurável) |
| 6 | Equipamentos (PDV) | operadores (indireto) | id do equipamento, nome da máquina, telemetria técnica, sessões | segurança e suporte técnico | legítimo interesse | controlador | `devices`, `device_sessions`, telemetria | SA | 30 dias (telemetria) |
| 7 | Suporte | usuários | texto do chamado, contexto de tela, anexos | atendimento | execução de contrato | controlador | `support_*` | SA e empresa | **[PREENCHER]** |
| 8 | Fiscal | clientes (destinatário), loja | dados do documento fiscal, certificado (cifrado) | emissão fiscal | obrigação legal | operadora | `fiscal_*` + arquivos | fiscal | legal |
| 9 | Pedidos de titular (exportação/anonimização) | clientes finais; administradores | quem pediu, quando, justificativa (texto livre: **orientar a não colocar dado pessoal**), o que foi feito/retido; exportação **cifrada** (cópia dos dados do titular) por 24 h | atender direitos do titular, prestar contas | obrigação legal (LGPD art. 18) | operadora | `privacy_requests` | só COMPANY_ADMIN da empresa | registro do pedido: **[PREENCHER]**; arquivo de exportação: **24 h / 3 downloads** (apagado por rotina) |
| 10 | Revogação de sessão | usuários | hash do token, identificador do usuário/empresa, horário | segurança (encerrar sessão) | legítimo interesse (segurança) | controlador | `access_revocations` (+ Redis) | sistema (sem tela) | até o fim da validade do token / 24 h (apagado por rotina) |
| 11 | Imagem do produto | — (sem dado pessoal por finalidade; saneada: sem EXIF/GPS) | foto do produto | catálogo | execução de contrato | operadora | `product_images` | perfis com leitura de produto | enquanto o produto existir |
| 12 | Canais comerciais (futuro) | compradores externos | nome, e-mail, telefone, documento, endereço do pedido | pedido e entrega | execução de contrato | operadora | `external_orders` | integrações | **[PREENCHER]** (decisão 93) |

**Dados sensíveis (art. 5º, II):** o sistema **não** coleta saúde, biometria, origem racial etc. Observações livres de cliente (`notes`) podem receber texto livre: orientar a loja a não registrar dado sensível.

**Crianças/adolescentes:** não há tratamento direcionado; data de nascimento é opcional.

**Transferência internacional:** depende da hospedagem escolhida **[PREENCHER]**.

## 2. Registro de fornecedores e operadores

| Fornecedor / serviço | Função | Dados envolvidos | País | Contrato/DPA | Estado |
|---|---|---|---|---|---|
| Hospedagem/servidores (PostgreSQL, aplicação) | armazenar e processar tudo | todos | **[PREENCHER]** | **[PREENCHER]** | **não definido** (staging não executado) |
| Redis (cache, filas, limites) | desempenho e fila | sessões/revogação, contadores; **não** é fonte de verdade de dinheiro | **[PREENCHER]** | idem | não definido |
| Autoridade certificadora TLS (Caddy: Let's Encrypt/ZeroSSL por padrão) | certificado HTTPS | nomes de domínio (sem dado pessoal) | n/d | termos públicos | previsto no staging, **não executado** |
| E-mail transacional / SMTP | notificações | e-mail e texto da mensagem | **[PREENCHER]** | **[PREENCHER]** | **nenhum instalado** (`NOT_CONFIGURED`) |
| Provedor fiscal / SEFAZ | emissão de documentos | dados fiscais do destinatário | BR | **[PREENCHER]** | **nenhum configurado** (adaptador não configurado) |
| Adquirente / PSP / TEF | pagamento | referência da transação | BR | **[PREENCHER]** | **nenhum** (cartão é registro manual) |
| Repositório e CI (GitHub) | código e testes | **sem** dados pessoais (não colocar dados reais) | EUA | termos do GitHub | **sem remoto configurado** |
| Serviços de IA/análise externos | — | **proibido** enviar dados reais de clientes sem base legal e autorização | — | — | **nenhum em uso** |

**Regra:** novo fornecedor só entra em produção depois de (1) registro nesta tabela, (2) contrato/DPA, (3) avaliação do que é enviado (mínimo necessário) e (4) credencial guardada fora do código.
