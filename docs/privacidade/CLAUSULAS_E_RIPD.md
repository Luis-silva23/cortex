# Modelo de cláusulas de proteção de dados e avaliação do RIPD

> **Modelo de trabalho, sem revisão jurídica.** Serve como ponto de partida para o jurídico adaptar; não substitui contrato nem parecer.

## 1. Modelo de cláusulas — contrato CÓRTEX (operadora) × empresa cliente (controladora)

**Cláusula 1 — Papéis.** A CONTRATANTE é controladora dos dados pessoais de seus clientes e usuários inseridos na plataforma; a CONTRATADA (CÓRTEX) atua como operadora, tratando-os somente para a prestação do serviço contratado e conforme instruções documentadas da CONTRATANTE.

**Cláusula 2 — Finalidade e escopo.** O tratamento limita-se às finalidades do contrato (gestão de vendas, caixa, estoque, oficina e administração). É vedado à CONTRATADA usar os dados para finalidade própria, vendê-los ou cedê-los.

**Cláusula 3 — Instruções.** A CONTRATADA seguirá as instruções da CONTRATANTE e a informará se considerar uma instrução ilícita.

**Cláusula 4 — Segurança.** A CONTRATADA adota medidas técnicas e administrativas adequadas: controle de acesso por perfil, isolamento entre clientes, criptografia de segredos, registro de acessos, autenticação reforçada de administradores e testes de segurança **[PREENCHER: anexo técnico]**.

**Cláusula 5 — Suboperadores.** A CONTRATADA mantém a lista de suboperadores (anexo) e comunica a CONTRATANTE antes de incluir ou substituir algum **[PREENCHER: prazo]**, impondo-lhes obrigações equivalentes.

**Cláusula 6 — Direitos dos titulares.** A CONTRATADA auxilia a CONTRATANTE, por meios técnicos adequados, a atender solicitações de titulares **[PREENCHER: prazo de apoio]**; não responde diretamente ao titular pelos dados da CONTRATANTE, salvo determinação legal.

**Cláusula 7 — Incidentes.** A CONTRATADA comunica a CONTRATANTE, sem demora injustificada **[PREENCHER: prazo contratual]**, sobre incidente que afete dados pessoais da CONTRATANTE, com as informações disponíveis para que esta cumpra os deveres perante a ANPD e os titulares.

**Cláusula 8 — Confidencialidade.** Pessoal da CONTRATADA com acesso aos dados fica sujeito a dever de confidencialidade.

**Cláusula 9 — Retenção e término.** Ao término do contrato, a CONTRATADA devolve ou elimina os dados em **[PREENCHER: prazo]**, ressalvada a retenção exigida por lei ou necessária ao exercício regular de direitos; backups são eliminados conforme ciclo de retenção.

**Cláusula 10 — Auditoria.** A CONTRATANTE pode solicitar informações necessárias para demonstrar o cumprimento destas cláusulas **[PREENCHER: periodicidade/forma]**.

**Cláusula 11 — Transferência internacional.** Só ocorre se informada à CONTRATANTE e amparada em hipótese legal **[REVISÃO JURÍDICA]**.

## 2. Avaliação da necessidade de RIPD (Relatório de Impacto)

O RIPD é a documentação que descreve os processos de tratamento que podem gerar riscos às liberdades civis e aos direitos fundamentais, com medidas de mitigação. A ANPD pode solicitá-lo ao controlador; ele é recomendável quando o tratamento envolve risco elevado.

| Critério | Situação do CÓRTEX | Peso |
|---|---|---|
| Dados sensíveis (saúde, biometria…) | **não** coleta | baixo |
| Volume e escala | multiempresa; cadastro de clientes de várias lojas; CPF/CNPJ | médio |
| Dados financeiros | valores e referências de pagamento; **sem** cartão/CVV/PIN | médio |
| Perfilamento/decisão automatizada | **não** há | baixo |
| Monitoramento sistemático | auditoria e telemetria técnica de equipamentos (não de pessoas) | baixo |
| Dados de crianças | não direcionado | baixo |
| Tecnologia nova / fornecedores | integrações futuras (fiscal, pagamento, canais) ainda não ativas | a reavaliar |

**Conclusão provisória (a validar pelo jurídico):** **risco médio**; não há tratamento de alto risco evidente hoje. **Recomenda-se** elaborar um RIPD simplificado **antes da operação em produção com dados reais** e **reavaliar** quando entrarem provedor fiscal, adquirente e canais comerciais. Estrutura sugerida: descrição das operações (usar o [inventário](INVENTARIO_E_FORNECEDORES.md)), necessidade e proporcionalidade, riscos identificados, medidas de segurança (usar a [política](POLITICAS.md)), responsável e data de revisão.
