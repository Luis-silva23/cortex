# Preparação para a primeira venda — o que existe, o que falta e o que só o proprietário decide

Escrito para: o proprietário do CÓRTEX (decisões) e quem opera a plataforma (roteiros). Data-base: **2026-10-18**. Cada afirmação diz se foi **comprovada por teste/execução**, está **só implementada** ou **não existe**. Nada aqui inventa preço, plano, contrato, prazo legal ou aprovação fiscal.

## 1. O que o cliente recebe hoje (e o que não)

| Capacidade | Estado | Observação para quem vende |
| --- | --- | --- |
| Admin Web, PDV Desktop (Windows 64 bits), Balcão, app do mecânico (Android), painel de TV (Android TV) | **Implementados** | PDV/Balcão/Admin Web: testes automatizados e navegador; app do mecânico: **testado em emulador** (login, agenda, OS, sair); TV: **testada em emulador Android TV** (login por D-pad e painel), **não** em aparelho físico |
| Multiempresa e multifilial com isolamento (administrador vê a empresa; gerente vê as filiais vinculadas; outra empresa nada) | **Comprovado** (integração com papel real) | gerente de várias filiais configurável pela tela (Admin Web › Usuários › Filiais) |
| Estoque, vendas, caixa, oficina/OS, orçamentos, convênios, recebíveis, compras, dashboards | **Implementados e testados** | módulos ligam/desligam por empresa |
| Pagamento: dinheiro, cartão **confirmado pelo operador na maquininha**, PIX **pendente até conciliação humana** | **Implementado** (provedor `MANUAL`) | **não há integração com adquirente/PSP/TEF**: o sistema não confirma sozinho que o dinheiro entrou |
| **Documento fiscal (NFC-e/NF-e)** | **NÃO existe** | a empresa **emite fora do sistema**; depende de provedor, certificado, homologação e orientação contábil (decisão do proprietário) |
| WhatsApp/e-mail de cobrança e pós-venda | **Manual** (link/registro pelo atendente) | sem robô nem envio automático (decisão registrada) |
| Recuperação de senha pelo próprio usuário (e-mail) | **NÃO existe** | a redefinição é do **administrador da empresa**; o usuário **troca** a senha temporária no primeiro acesso e pode trocá-la quando quiser (decisão 157) |
| Cobrança da mensalidade, planos, preços | **NÃO existem no sistema** | só a **licença** (tipo, validade, limites); cobrança é externa até decisão (seção 6) |
| Backup, restauração, anonimização | Scripts **provados em laboratório**; destino externo e alerta real **dependem de infraestrutura** | [BACKUP_RECUPERACAO](BACKUP_RECUPERACAO.md) |

## 2. Roteiro do operador: entregar o sistema a um cliente (testado de ponta a ponta)

Provado por `company-onboarding.integration.test.ts` (9 casos, Postgres e Redis reais, política de produção do MFA ligada).

1. **Super Admin › Empresas › Nova Empresa** (nome, CNPJ, e-mail do cliente).
2. **Super Admin › Licenças › Nova Licença** (tipo, validade, **limites de dispositivos, usuários e filiais**) e **Aprovar**. Sem licença ativa não há limite aplicado.
3. **Super Admin › Usuários › novo `Admin da Empresa`** (a empresa escolhida, e-mail do responsável, **senha temporária**). O sistema marca a senha como temporária.
4. Entregue a senha temporária **por um canal seguro** (combine por telefone ou presencialmente; não a envie junto de mensagem em texto aberto).
5. O responsável abre o **Admin Web**, entra com a temporária e é **obrigado a definir a própria senha** (mín. 10 caracteres, letras e números, não contendo o e-mail) → em seguida **configura o aplicativo autenticador (MFA, obrigatório em produção)** e **guarda os códigos de recuperação** (exibidos uma vez).
6. **Admin Web › Filiais**: o cliente cria a(s) filial(is) (o limite da licença barra a excedente com 409).
7. **Admin Web › Usuários**: o cliente cadastra a equipe — **filial principal obrigatória** para gerente/operador/mecânico/visualizador; botão **Filiais** para conceder filiais adicionais a um gerente. A senha definida pelo administrador é temporária por padrão (opção desligável, não recomendada).
8. Equipamentos do PDV: instalação e atualização em [DISTRIBUICAO_APLICATIVOS](DISTRIBUICAO_APLICATIVOS.md); autorização de dispositivo conforme [DISPOSITIVOS](DISPOSITIVOS.md); módulos em Admin Web › Configurações.
9. Registrar a entrega (data, responsável, licença) no seu controle — o sistema audita as ações, mas não substitui o registro comercial.

**Limite de plano aplicado hoje:** filiais, dispositivos e **usuários ativos** (409 `USER_LIMIT_REACHED`; desativar libera a vaga; reativar além do limite é recusado). Em duas criações simultâneas exatamente no limite um usuário a mais pode passar (limite de plano, não de segurança).

## 3. Operar o dia a dia

| Situação | Procedimento | Estado |
| --- | --- | --- |
| Esqueci a senha | o **administrador da empresa** redefine (Admin Web › Usuários › chave); o usuário troca no próximo acesso | comprovado |
| Conta bloqueada por tentativas | administrador desbloqueia (cadeado) | comprovado |
| Atendimento ao cliente | **Central de Ajuda e Suporte** dentro do sistema (chamados, base de conhecimento) — [SUPPORT](SUPPORT.md); o console é do Super Admin | implementado e testado em navegador |
| Atualizar o sistema | [PRODUCAO §17](PRODUCAO.md) (ordem, verificações, reversão) | procedimento pronto; **nunca executado em ambiente real** |
| Incidente de segurança / dados pessoais | [TITULARES_E_INCIDENTES](../privacidade/TITULARES_E_INCIDENTES.md) (**minuta sem revisão jurídica**: prazos e enquadramentos a confirmar) | minuta |
| Perda de dados | restauração **em banco novo** a partir do backup; nunca sobre o de produção | testado em laboratório; **outro servidor não** |
| Pedido do titular (LGPD) | Admin Web › Privacidade (exportação cifrada; anonimização irreversível com retenção fiscal e de garantia) | implementado e testado |

## 4. Suspender, cancelar e encerrar uma conta (sem perder dado)

1. **Suspender** (inadimplência, pausa): **Super Admin › Empresas › Bloquear acesso**. A empresa deixa de entrar em todos os aplicativos e as sessões abertas são encerradas; **nada é apagado**. **Reativar acesso** desfaz. (Botão novo desta missão; a regra de bloqueio e de revogação de sessões já tinha teste.)
2. **Cancelar o contrato**: licença rejeitada/cancelada no Super Admin + bloqueio da empresa.
3. **Entregar os dados ao cliente**: exportação pelo próprio administrador (Admin Web › Privacidade e relatórios) **antes** de qualquer eliminação.
4. **Eliminar dados pessoais**: anonimização irreversível pelo fluxo de privacidade, **respeitando retenção fiscal/garantia** — prazos **[decisão jurídica]**.
5. **Nunca** excluir a empresa com movimento: o sistema só permite excluir empresa **vazia** (sem filiais nem usuários); registros financeiros, de estoque e de auditoria são append-only e permanecem.

## 5. Documentos legais

| Documento | Estado |
| --- | --- |
| Termos de uso | **minuta técnica** em [TERMOS_DE_USO_MINUTA](../privacidade/TERMOS_DE_USO_MINUTA.md) (o que o sistema faz e não faz; preço, prazo, multa, foro e responsabilidade em **[PREENCHER]**); **sem revisão jurídica** |
| Política de privacidade e minutas de contrato com a loja (operadora × controladora) | **minutas** em [docs/privacidade](../privacidade/README.md), **sem revisão jurídica** |
| Encarregado (DPO), prazos legais, retenção | **[PREENCHER / decisão jurídica]** |
| Fiscal | o sistema **não emite**; obrigação de emitir continua com a empresa e seu contador |

## 6. Decisões que só o proprietário toma (com as opções preparadas)

| # | Decisão | Opções | Impacto técnico |
| --- | --- | --- | --- |
| 1 | **Planos e preços** | (a) tabela fixa por tipo de licença (TRIAL/BASIC/PROFESSIONAL/ENTERPRISE com limites de usuários/filiais/dispositivos); (b) preço por filial; (c) preço sob consulta | os limites já existem na licença; o preço não está no sistema |
| 2 | **Cobrança da mensalidade** | (a) manual (boleto/PIX fora do sistema) + validade da licença controlada pelo Super Admin — **funciona hoje**; (b) gateway de assinatura recorrente — **exige escolher o provedor e implementar a integração** | (a) nenhum; (b) integração nova + conciliação |
| 3 | **Provedor de pagamento na loja** (cartão/PIX automáticos) | manter manual; ou contratar PSP/TEF | adaptador já tem contrato (`registerPaymentProvider`), falta provedor e credenciais |
| 4 | **Emissão fiscal** | cliente emite fora; ou integrar um provedor fiscal (certificado A1, homologação, orientação do contador) | adaptador já tem contrato; falta provedor, certificado e ambiente |
| 5 | **Recuperação de senha por e-mail** | manter pelo administrador; ou contratar e-mail transacional | exige provedor de e-mail e fluxo novo |
| 6 | **Teste gratuito (trial)** | duração e limites da licença TRIAL | já suportado (tipo e validade) |
| 7 | **RPO/RTO e retenção de backup** | propostas 15 min / 1 h e 30/12/12 | [BACKUP_RECUPERACAO §9](BACKUP_RECUPERACAO.md) — aprovação pendente |
| 8 | **Regras de visibilidade** | gerente vê administradores/usuários sem filial; convênio "da empresa toda" por gerente; teto de 50 filiais | decisões 153/146 |
| 9 | **Suporte** | horário, canais, prazo de resposta (SLA) | o sistema registra chamados e prazos internos, mas **não define o SLA** |

## 7. Checklist de abertura comercial

**Já comprovado**
- [x] Isolamento entre clientes e filiais (teste de integração com papel real).
- [x] Onboarding de empresa (9 casos), senha temporária e troca de senha, MFA obrigatório do administrador.
- [x] Limites de plano: filiais, dispositivos e usuários.
- [x] Bloqueio/reativação de empresa pelo Super Admin; auditoria das ações.
- [x] Backup cifrado, verificação sem novo dump, restauração isolada e anonimização (laboratório).

**Falta antes de cobrar um cliente real** *(nenhum item abaixo foi executado nem está ao alcance de código)*
- [ ] Staging com HTTPS e `validar-homologacao.sh` num host Linux com Docker; só depois produção ([PRODUCAO §16–17](PRODUCAO.md)).
- [ ] Destino externo do backup, alerta real recebido por uma pessoa e restauração em outro servidor.
- [ ] Conta Super Admin criada pelo procedimento de [PRODUCAO §13](PRODUCAO.md) (**não criada**: exige autorização expressa).
- [ ] Assinatura de código do instalador do PDV e keystore de produção dos aplicativos Android (chaves do proprietário).
- [ ] Decisões 1, 2, 7 e 9 da seção 6 (no mínimo) e os termos/privacidade revisados por jurídico.
- [ ] Definir como o cliente emite documento fiscal (decisão 4) e deixar isso claro no contrato.
