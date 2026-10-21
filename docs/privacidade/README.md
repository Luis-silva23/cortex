# Privacidade e proteção de dados (LGPD) — pacote do CÓRTEX

> **Status: minuta técnica, sem revisão jurídica.** Descreve o que o sistema **realmente faz** hoje e o que a operação precisa fazer. **Não** é parecer jurídico nem declaração de conformidade com a Lei nº 13.709/2018 (LGPD) ou com as normas da ANPD; os pontos marcados **[REVISÃO JURÍDICA]** e **[PREENCHER]** dependem de assessoria jurídica e de informações do negócio. Nenhuma certificação (ISO/IEC 27001, SOC 2 etc.) é alegada: **nenhuma existe**.

## Documentos

| Documento | Para quê |
|---|---|
| [POLITICAS.md](POLITICAS.md) | Política de Privacidade, Aviso de Privacidade (pontos de coleta), Segurança da Informação, Controle de Acesso, Retenção e Descarte |
| [TITULARES_E_INCIDENTES.md](TITULARES_E_INCIDENTES.md) | Atendimento aos direitos dos titulares e resposta a incidentes |
| [INVENTARIO_E_FORNECEDORES.md](INVENTARIO_E_FORNECEDORES.md) | Inventário das operações de tratamento, registro de fornecedores/operadores |
| [CLAUSULAS_E_RIPD.md](CLAUSULAS_E_RIPD.md) | Modelo de cláusulas de proteção de dados para contratos e avaliação da necessidade de RIPD |
| [TERMOS_DE_USO_MINUTA.md](TERMOS_DE_USO_MINUTA.md) | Minuta dos Termos de Uso a partir do que o sistema faz e **não** faz; itens comerciais e jurídicos ficam **[PREENCHER]** / **[REVISÃO JURÍDICA]** |

## Papéis (resumo)

| Quem | Papel na LGPD | Dados |
|---|---|---|
| **Empresa cliente (a loja/oficina)** | **Controladora** dos dados dos seus clientes finais, veículos, vendas e ordens de serviço | clientes, veículos, vendas, OS, financeiro da loja |
| **CÓRTEX (plataforma)** | **Operadora** desses dados (presta o serviço seguindo as instruções da loja) e **controladora** dos dados dos usuários da plataforma (login, auditoria, suporte) | usuários, sessões, auditoria, chamados, telemetria |
| **Fornecedores do CÓRTEX** | Suboperadores (hospedagem, e-mail, provedor fiscal, adquirente…) — **ainda não contratados/definidos** | ver inventário |

**[REVISÃO JURÍDICA]** a classificação por operação deve ser confirmada em contrato.

## O que o sistema já faz de verdade (controles técnicos verificados no código)

- Isolamento por empresa e filial no banco (RLS `FORCE`) e no token; testes de acesso cruzado entre empresas.
- Senhas só como hash (bcrypt, custo 12); segredos de integração e MFA cifrados em repouso (`enc:v1`); senha e token nunca em log nem auditoria (filtro `redactSensitive`).
- Autorização no servidor (perfis/permissões por ação), MFA para Super Admin em produção, sessão do PDV/Balcão só em memória, revogação no servidor.
- Auditoria de ações sensíveis (quem, o quê, quando) com retenção configurável.
- Custo e margem só para quem tem função de gestão ou compras.

## O que **não** existe ainda (lacunas conhecidas)

| Lacuna | Efeito | Encaminhamento |
|---|---|---|
| Exportação dos dados de um titular (portabilidade/acesso) por tela | atendimento manual por consulta autorizada | procedimento em TITULARES_E_INCIDENTES; funcionalidade = decisão 120 |
| Anonimização de cliente a pedido do titular | "excluir" cliente só **desativa** (os dados continuam) | decisão 120 (precisa definir o que a lei obriga reter) |
| Registro formal de consentimento / base legal por cadastro | não há campo de base legal | [REVISÃO JURÍDICA] — baseia-se em execução de contrato/legítimo interesse da loja |
| Política de Privacidade publicada na tela de login / cadastro | só existe esta minuta | publicar depois da revisão jurídica |
| Criptografia em repouso do banco/backup no nível de disco | depende da infraestrutura | pendência de infraestrutura (PRODUCAO.md) |
