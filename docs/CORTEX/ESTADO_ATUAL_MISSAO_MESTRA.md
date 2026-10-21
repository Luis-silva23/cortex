# Estado atual — Missão mestra de finalização, integração, implantação e lançamento comercial

Documento **único e vivo** (missão de 2026-10-18). Cada linha usa um estado inequívoco: **CONCLUÍDO E COMPROVADO** · **IMPLEMENTADO, MAS NÃO VALIDADO NO AMBIENTE REAL** · **BLOQUEADO POR DEPENDÊNCIA EXTERNA** · **AINDA NÃO IMPLEMENTADO**. "Comprovado" quer dizer **executado nesta máquina** (Windows 11, PostgreSQL 18.6 e Redis portáteis, sem Docker, sem Linux); nenhum item foi comprovado em staging ou produção porque **não existem**. Relatório final: [RELATORIO_MISSAO_MESTRA_2026-10-18](RELATORIO_MISSAO_MESTRA_2026-10-18.md).

## 0. Consolidação do histórico (verificado nesta missão)

| Verificação | Resultado |
| --- | --- |
| Pacote `CORTEX-seguranca-producao-2026-10-15.zip` × manifesto | SHA-256 **igual** (`01e360fd…`), conferido em 2026-10-18 |
| Documentos vigentes × superados | vigentes: este documento, `RELATORIO_MISSAO_MESTRA_2026-10-18`, `RELATORIO_SEGURANCA_PRODUCAO_2026-10-15`, `RLS_CONTEXTO_ASSINADO`, `PRODUCAO` §17, `BACKUP_RECUPERACAO`, `DECISIONS` (143–161); `RELATORIO_FINALIZACAO_PRODUCAO` e o ZIP `finalizacao-producao` são **históricos** |
| Relatórios × código | as contagens dos documentos vigentes foram regeneradas do banco (`db:docs`) e travadas por teste (`docs-consistency`: 55 migrações, decisões 128–161) |
| Git | último commit de **2026-10-13** (`e243ae1`); **348 arquivos com alteração sem commit**. **Nenhum commit foi feito** (exige autorização expressa). Risco: o histórico versionado não reflete o produto |

## 1. Inventário de componentes (estado real)

| Componente | Estado | Evidência / o que falta |
| --- | --- | --- |
| API (`apps/api`) | **CONCLUÍDO E COMPROVADO** | build; unitários **1202/1202**; integração **122 suítes / 1705** com Postgres e Redis reais, **também como papel sem posse** (`db:role-split-check --all`) |
| Banco / migrações (55) | **CONCLUÍDO E COMPROVADO** (dev/teste) | replay do zero = catálogo do dev (**3593** itens, 0 diferenças), `db:check-rls` OK, 3 FKs `NOT VALID` do recebível órfão **preservadas**; staging/produção **não existem** |
| Admin Web (Next) | **CONCLUÍDO E COMPROVADO** (navegador local) | build; 549 testes; Playwright: jornada de acesso (novo), catálogo/ajuda, suporte, MFA/privacidade/imagem, fluxo administrativo |
| Super Admin (Next) | **CONCLUÍDO E COMPROVADO** (navegador local) | build; Playwright; **conta Super Admin NÃO criada** (exige autorização) |
| Balcão (Vite) | **CONCLUÍDO E COMPROVADO** (navegador local) | build; 9 testes lógicos; Playwright 13/13 |
| PDV Desktop (Electron 44.9.0) | **IMPLEMENTADO, MAS NÃO VALIDADO NO AMBIENTE REAL** | 37 testes lógicos; instalador NSIS x64 gerado, aplicativo empacotado **inicia** (`smoke:electron`); **sem assinatura de código**; sem servidor de produção; sem teste em máquina limpa nem com periféricos |
| App do mecânico (`CÓRTEX Equipe`) | **CONCLUÍDO E COMPROVADO** (emulador) / release **BLOQUEADO** (keystore) | APK de debug instalado e usado em emulador (login, agenda, OS, sair); release de teste interno gerado; release de produção recusado sem keystore |
| Painel de TV (`CÓRTEX Painel`) | **CONCLUÍDO E COMPROVADO** (emulador Android TV) / aparelho físico **NÃO TESTADO** | defeito real achado e corrigido (dois `react-native`; `metro.config.js`); login por D-pad e painel provados; release de teste interno abre |
| Redis / filas / agendador | **IMPLEMENTADO, MAS NÃO VALIDADO NO AMBIENTE REAL** | exercitado em dev e na integração; sem HA |
| Backup / PITR / anonimização | scripts **CONCLUÍDOS E COMPROVADOS em laboratório** (`backup:verify` 19/19); destino externo, alerta real e outro servidor **BLOQUEADOS POR DEPENDÊNCIA EXTERNA** | [BACKUP_RECUPERACAO](BACKUP_RECUPERACAO.md) |
| Docker/Compose, staging, HTTPS | **IMPLEMENTADO, MAS NÃO VALIDADO NO AMBIENTE REAL** | `validar-homologacao.sh` pronto; **nunca executado** (sem host Linux/Docker) |

## 2. Segurança e integridade (resumo; detalhe em [SECURITY](SECURITY.md))

| Item | Estado |
| --- | --- |
| RLS com contexto assinado, papéis dono × execução, FKs compostas, append-only | **CONCLUÍDO E COMPROVADO** (replay + role-split + integração sem posse) |
| Escopo: administrador na empresa; gerente só nas filiais vinculadas (A+B sim, C não); convênios pelo mesmo conjunto; remoção revoga; sem autopromoção | **CONCLUÍDO E COMPROVADO** (integração + E2E de acesso no navegador) |
| Senha temporária, troca obrigatória, política (admin 12+/3 tipos), revogação de sessões | **CONCLUÍDO E COMPROVADO** (decisão 157; testes unitários e de integração novos; E2E no navegador) |
| Limite de usuários da licença | **CONCLUÍDO E COMPROVADO** (409 `USER_LIMIT_REACHED`; corrida exatamente no limite pode admitir um a mais — limite de plano) |
| Resíduos documentados | contexto de RLS assinado (SQL injetado numa requisição reutiliza a própria assinatura por até 120 s); revogação por segundo (token do mesmo segundo da revogação é recusado); credencial de TV é login comum |

## 3. Integrações (descoberta no código — nada foi inventado)

| Integração | Classificação | Impacto na primeira versão |
| --- | --- | --- |
| Pagamento em dinheiro / cartão confirmado pelo operador / PIX pendente (provedor `MANUAL`) | **Implementada e testada** | funciona sem contrato; PIX fica pendente até conciliação humana |
| PSP/TEF (cartão, PIX automático) | **AINDA NÃO IMPLEMENTADO** — contrato do adaptador existe, **nenhum provedor definido** | decisão do proprietário; credenciais e sandbox do provedor |
| Fiscal (NFC-e/NF-e) | **AINDA NÃO IMPLEMENTADO** — só o adaptador "não configurado" | **a primeira versão não emite documento fiscal**; depende de provedor, certificado, homologação e orientação contábil |
| Commerce API / Integration Gateway | **Implementada e testada em sandbox** (provedor genérico) | nenhum marketplace real integrado; módulo `CANAIS` nasce desativado |
| E-mail e WhatsApp | **AINDA NÃO IMPLEMENTADO** como envio | cobrança/pós-venda manuais; sem recuperação de senha por e-mail |
| Monitoramento externo | variáveis opcionais, **não ativadas** | logs e métricas internas existem |

## 4. Artefatos gerados (hashes SHA-256) — **nenhum é distribuível ainda**

| Artefato | Caminho (fora do repositório) | SHA-256 | Observação |
| --- | --- | --- | --- |
| CÓRTEX Equipe 1.0.0 (versionCode 1) — release de **teste interno** | `C:\cx-build\artifacts\CORTEX-Equipe-1.0.0-internal-debugsigned.apk` | `5db63f1921b3bb775cd34ca75a4572d75965143ab70aa5c9d1f63597d1a09df3` | v2-assinado com a chave de **debug**; URL de API inválida de propósito; `allowBackup=false`, sem permissões de armazenamento/sobreposição |
| CÓRTEX Painel 1.0.0 (versionCode 1) — release de **teste interno** | `C:\cx-build\artifacts\CORTEX-Painel-1.0.0-internal-debugsigned.apk` | `567c16dcc323134f514f229fed1e5c72371f7797144a6a598b37d2f977af95d0` | idem; com `metro.config.js` |
| CORTEX PDV Setup 1.0.0 (Windows x64, NSIS por usuário) | `apps/pdv-desktop/dist-installer/CORTEX-PDV-Setup-1.0.0.exe` (gitignored) | `0c5dbd88c07ecac9a665b8491db5f65a6c75e7028dfbce56ae64ec0782cb1521` | **NotSigned**; sem `VITE_API_URL` de produção |
| AAB (Google Play) | — | — | **não gerado** (exige keystore do proprietário) |
| Pacote da missão (código + docs) | `docs/CORTEX/CORTEX-missao-mestra-2026-10-18.zip` | no manifesto `SHA256SUMS-missao-mestra-2026-10-18.txt` (fora do ZIP) | sem `.env`, `node_modules`, builds, keystores |

## 5. Bloqueios que dependem do proprietário ou da infraestrutura (acumulado)

- **Infraestrutura:** host Linux com Docker; DNS/HTTPS; armazenamento externo de backup; webhook de alerta recebido por uma pessoa; restauração em outro servidor; cofre do `RLS_CONTEXT_SECRET`.
- **Chaves:** keystore Android de produção; certificado de assinatura de código do Windows.
- **Provedores:** pagamento (PSP/TEF), fiscal (certificado digital, homologação), e-mail transacional.
- **Decisões/aprovações:** RPO/RTO/retenção; regras de visibilidade; planos, preços, cobrança, SLA; termos e privacidade com revisão jurídica.
- **Autorizações:** criação da conta Super Admin; commit/push; deploy em produção.
