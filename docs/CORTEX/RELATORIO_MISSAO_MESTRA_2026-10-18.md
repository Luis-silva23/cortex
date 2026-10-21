# Relatório mestre — Missão de finalização, integração, implantação e lançamento comercial (2026-10-18)

Escrito para: Luiz, proprietário do CÓRTEX. Cada item traz um estado inequívoco: **CONCLUÍDO E COMPROVADO** · **IMPLEMENTADO, MAS NÃO VALIDADO NO AMBIENTE REAL** · **BLOQUEADO POR DEPENDÊNCIA EXTERNA** · **AINDA NÃO IMPLEMENTADO**. "Comprovado" significa executado **nesta máquina** (Windows 11, PostgreSQL 18.6 e Redis portáteis, sem Docker nem Linux). **Staging e produção não existem**, então nada foi comprovado lá. Não houve commit, push, deploy, criação do Super Admin, apagamento de dado financeiro, desativação de RLS nem teste de carga. Estado vivo: [ESTADO_ATUAL_MISSAO_MESTRA](ESTADO_ATUAL_MISSAO_MESTRA.md).

## Resumo em uma tela

- **Pronto e comprovado localmente:** API, banco (55 migrações), Admin Web, Super Admin, Balcão, e o ciclo de entrega a um cliente (criar empresa → licença → administrador com senha temporária → troca → MFA → filiais → equipe).
- **Gerado e testado em emulador:** app do mecânico (Android) e painel de TV (Android TV).
- **Gerado, mas ainda não entregável:** instalador do PDV (Windows) e APKs de release de teste interno — falta o servidor definitivo com HTTPS e as chaves de assinatura.
- **Não existe / bloqueado:** staging e produção, HTTPS, backup externo e alerta real, restauração em outro servidor, pagamento automático, emissão fiscal, e-mail, preços/planos/termos, assinatura de código.
- **Onde parei por regra, não por falta de trabalho:** só restam itens que dependem de infraestrutura, chaves, contratos, decisões suas ou autorização expressa (seção 14).

## Os 17 itens

### 1. Consolidação do histórico — CONCLUÍDO E COMPROVADO
Pacote anterior conferido contra o manifesto (SHA-256 igual). Documentos vigentes × históricos separados; contagens dos documentos regeneradas do banco e travadas por teste. Um único documento vivo ([ESTADO_ATUAL_MISSAO_MESTRA](ESTADO_ATUAL_MISSAO_MESTRA.md)). Git: último commit de 2026-10-13, **348 arquivos alterados sem commit** (risco: o histórico versionado não reflete o produto; commit só com sua autorização).

### 2. Inventário real de componentes — CONCLUÍDO E COMPROVADO
Tabela completa em [ESTADO_ATUAL_MISSAO_MESTRA §1](ESTADO_ATUAL_MISSAO_MESTRA.md): estado, como rodar/construir/testar, o que foi validado e o que bloqueia clientes.

### 3. Segurança (RLS, papéis, autenticação, MFA, multiempresa) — CONCLUÍDO E COMPROVADO (local)
RLS com contexto assinado e papéis dono × execução provados: a **suíte completa de integração roda também como papel sem posse** (122 suítes / 1705 testes). Regras de escopo provadas em teste e no navegador: administrador vê a empresa; gerente só as filiais vinculadas (A+B sim, C não); convênios seguem o mesmo conjunto; remover o vínculo revoga; ninguém se autopromove. **Novo nesta missão:** senha temporária com troca obrigatória (decisão 157), política mais forte para administradores (12+ caracteres, 3 tipos), troca derruba sessões, gatilho do banco protege senha. **Resíduos** (documentados, não "inviolável"): SQL injetado numa requisição reaproveita o contexto dela por até 120 s; revogação com granularidade de segundo (token emitido no mesmo segundo da troca é recusado — basta entrar de novo); credencial da TV é login comum.

### 4. Integridade do banco — CONCLUÍDO E COMPROVADO (dev/teste)
`db:replay-check`: as **55 migrações do zero** = catálogo do dev (**3593** itens, 0 diferenças) e os 4 cenários com dado inconsistente. `db:check-rls` OK. FKs compostas, RESTRICT, append-only e idempotência já provados nas rodadas anteriores e reexecutados pela integração. As **3 FKs `NOT VALID` do recebível órfão foram preservadas** (aguardam sua decisão). *Corrigi o script de replay:* ele criava usuário pelo Prisma atual num banco anterior à migração nova.

### 5. Fluxos ponta a ponta (backend + frontend) — CONCLUÍDO E COMPROVADO (local)
- **Onboarding de empresa:** 9 casos de integração (Super Admin cria empresa, licença com limites, administrador com senha temporária, troca, MFA, filiais, gerente, limites, isolamento).
- **Jornada de acesso no navegador (novo):** administrador cadastra gerente com filial principal, concede segunda filial, gerente entra com a temporária, troca (política na tela), entra, troca de novo em Configurações › Segurança, e perde a filial retirada com a mesma sessão (403). Evidências em `docs/evidencias/2026-10-18-playwright/user-access`.
- **Lacunas de produto achadas e fechadas:** não havia troca de senha nem senha temporária; a tela de usuários não atribuía filial; o Super Admin não bloqueava/reativava empresa; o limite de **usuários** da licença não era aplicado.

### 6. Integrações — inventário e classificação
Em [ESTADO_ATUAL_MISSAO_MESTRA §3](ESTADO_ATUAL_MISSAO_MESTRA.md). **Pagamento manual (dinheiro, cartão confirmado pelo operador, PIX pendente): CONCLUÍDO E COMPROVADO.** **PSP/TEF: AINDA NÃO IMPLEMENTADO** (nenhum provedor definido). **Fiscal: AINDA NÃO IMPLEMENTADO** (a primeira versão não emite documento fiscal). **E-mail/WhatsApp: AINDA NÃO IMPLEMENTADO** como envio. **Commerce API / Gateway: sandbox genérico** (nenhum marketplace real). Nada foi simulado como "pronto para produção".

### 7. Infraestrutura (Linux, Docker, Compose, staging, HTTPS) — BLOQUEADO POR DEPENDÊNCIA EXTERNA
`docker-compose.yml`, overlay de WAL, Compose de staging e `deploy/homologacao/validar-homologacao.sh` (com `--wal` e `--tls <domínio>`) estão **prontos e nunca foram executados**: esta máquina não tem Docker, WSL nem Linux. **Não declaro o Compose validado.** O que dá para fazer sem host Linux (pipeline simulado com papéis separados, replay, role-split, backup) foi feito.

### 8. Backup e recuperação (DR) — scripts CONCLUÍDOS E COMPROVADOS em laboratório; resto BLOQUEADO POR DEPENDÊNCIA EXTERNA
`backup:verify` reexecutado: **19/19 verificações**, restauração em banco temporário, segredo MFA conferido sem exibir. WAL/PITR cifrado, anonimização e delegação ao serviço de backup provados em laboratório (rodadas anteriores). **Bloqueados:** destino externo com retenção, alerta recebido por uma pessoa, WAL em produção, restauração em outro servidor, RTO real. **RPO 15 min / RTO 1 h e retenção 30/12/12 continuam propostas NÃO aprovadas.**

### 9. Aplicativos e artefatos — auditoria específica
| Aplicativo | Existe? | Compila? | Instalou/testou? | Artefato | Pendente |
|---|---|---|---|---|---|
| CÓRTEX Equipe (`com.lnsystem.mobile`, 1.0.0, versionCode 1, minSdk 24) | sim | **sim** (debug e release) | **sim, em emulador Android** (login, agenda, OS, sair) | APK de teste interno | keystore, URL https, AAB, aparelho físico |
| CÓRTEX Painel (`com.lnsystem.tv`, 1.0.0, versionCode 1) | sim | **sim** | **sim, em emulador Android TV** (login só por D-pad, painel, sessão persiste); release abre | APK de teste interno | keystore, URL https, AAB, aparelho/controle reais |
| PDV Desktop (Electron 44.9.0, Windows x64) | sim | **sim** | aplicativo empacotado **inicia** (smoke); não instalado em máquina limpa | instalador NSIS | assinatura de código, `VITE_API_URL`, máquina limpa, periféricos |

Achados corrigidos: **o painel de TV nunca tinha rodado** (dois `react-native` empacotados → tela vermelha; `apps/tv/metro.config.js`); release Android usava chave de debug, `allowBackup=true` e permissões extras (agora release **recusado** sem keystore, `allowBackup=false`, permissões bloqueadas); Electron 28 não era suportado (agora 44.9.0); marca ainda "LN System" nos apps (agora CÓRTEX; o `author` do PDV ainda diz "LN System" — razão social do proprietário a preencher). **Lista do que foi realmente gerado:** 2 APKs de teste interno e 1 instalador do PDV (hashes na seção 17). **AAB: não gerado.** Detalhes: [DISTRIBUICAO_APLICATIVOS](DISTRIBUICAO_APLICATIVOS.md), [MOBILE](MOBILE.md), [ANDROID_TV](ANDROID_TV.md).

### 10. Testes — CONCLUÍDO E COMPROVADO (local; sem carga/stress)
| Verificação | Resultado |
|---|---|
| Type-check (shared, database, api, admin-web, super-admin, balcão, pdv, mobile, tv) | 9/9 sem erro |
| Lint | 0 erros (avisos antigos de API/Next) |
| Unitários API / Admin Web / Balcão / PDV | **1202/1202** · **549/549** · **9/9** · **37/37** |
| Integração (Postgres e Redis reais) | **122 suítes / 1705/1705** como dono **e** como papel sem posse |
| Replay 55 migrações, check-rls, backup:verify | OK (3593 itens; 19/19) |
| Builds | API, Admin Web, Super Admin, Balcão, instalador do PDV: OK |
| Playwright | **79 testes em 9 suítes** passaram (acesso 7, Balcão 13, MFA/privacidade/imagem 6, suporte, catálogo/ajuda, Super Admin, administrativo). **Não rodei `pdv-sale-flow`** (cria venda permanente). A limpeza do E2E do Balcão estava quebrada desde as FKs RESTRICT: corrigida |

Falhas que apareceram e foram resolvidas (nenhuma escondida): testes antigos que criavam usuário e logavam com a senha (agora `requirePasswordChange:false`); rota pública nova na lista do `auth-coverage`; mock de login com banco fora; dois testes dependentes de temporização (espera fixa de 50 ms e granularidade de segundo da revogação). **Nenhum teste de carga ou stress foi executado.**

### 11. Preparação comercial — IMPLEMENTADO (processo e minutas); decisões BLOQUEADAS por você
[PREPARACAO_COMERCIAL](PREPARACAO_COMERCIAL.md): o que o cliente recebe, roteiro de entrega (testado), suporte, suspensão/cancelamento sem perder dado (bloqueio de empresa no Super Admin, exportação, anonimização respeitando retenção), incidentes, minutas ([TERMOS_DE_USO_MINUTA](../privacidade/TERMOS_DE_USO_MINUTA.md) e pacote de privacidade — **sem revisão jurídica**) e as **9 decisões que são suas** (planos, preços, cobrança, provedor de pagamento, fiscal, e-mail, trial, RPO/RTO, SLA). **Nenhum preço, plano, contrato ou prazo legal foi inventado.**

### 12. Instalação e distribuição — IMPLEMENTADO, MAS NÃO VALIDADO NO AMBIENTE REAL
Procedimentos em [DISTRIBUICAO_APLICATIVOS](DISTRIBUICAO_APLICATIVOS.md): construir, assinar, instalar, atualizar, reverter (PDV: reinstalar a versão anterior; Android: `versionCode` maior com a mesma chave). Nunca executados com assinatura de produção nem em máquina de cliente.

### 13. Deploy e rollback — IMPLEMENTADO, MAS NÃO VALIDADO NO AMBIENTE REAL
[PRODUCAO §17](PRODUCAO.md): ordem (backup restaurável → `migrate deploy` como **dono** → reiniciar a API → verificações), reversão por migração (cada uma traz o rollback no cabeçalho; a 55: `DROP COLUMN` das duas colunas e recriar `users_guard_privileged_columns` com a definição da 20261016110000) e restauração a partir do backup. **Nunca executado em ambiente real; deploy de produção não foi feito** (e não deve ser antes dos critérios de liberação: staging com HTTPS aprovado, Super Admin criado pelo procedimento, backup externo e alerta reais).

### 14. Pendências por dependência externa — BLOQUEADO POR DEPENDÊNCIA EXTERNA
Host Linux com Docker; DNS/HTTPS e staging; armazenamento externo e alerta de backup; restauração em outro servidor; keystore Android e certificado de assinatura do Windows; provedores de pagamento, fiscal e e-mail; aprovação de RPO/RTO/retenção e das regras de visibilidade; planos, preços, cobrança, SLA; revisão jurídica de termos e privacidade; **autorização** para criar o Super Admin, para commit/push e para o deploy; destino do recebível órfão (3 FKs `NOT VALID`).

### 15. Riscos residuais
Sem staging/produção nada foi provado em Linux nem sob a rede real; histórico git defasado (348 arquivos sem commit); instalador do PDV e APKs sem assinatura de produção; app do mecânico sem portão de equipamento (pendência 111); revogação por segundo e contexto de RLS assinado (seção 3); limite de usuários com corrida no limite; PDV/APK gerados com endereço de servidor provisório; Electron/Expo em versões recentes sem histórico de produção; backup só provado em laboratório.

### 16. Checklist de abertura comercial
Em [PREPARACAO_COMERCIAL §7](PREPARACAO_COMERCIAL.md): já comprovado (isolamento, onboarding, senha temporária/MFA, limites, bloqueio de empresa, backup de laboratório) × **falta antes de cobrar um cliente real** (staging HTTPS aprovado, backup externo e alerta, Super Admin criado, assinaturas, decisões 1/2/7/9, termos revisados, definição fiscal).

### 17. Hashes dos artefatos finais (SHA-256)
| Artefato | SHA-256 |
|---|---|
| `CORTEX-Equipe-1.0.0-internal-debugsigned.apk` (47 184 726 bytes) | `5db63f1921b3bb775cd34ca75a4572d75965143ab70aa5c9d1f63597d1a09df3` |
| `CORTEX-Painel-1.0.0-internal-debugsigned.apk` | `567c16dcc323134f514f229fed1e5c72371f7797144a6a598b37d2f977af95d0` |
| `CORTEX-PDV-Setup-1.0.0.exe` (111 679 093 bytes; **NotSigned**) | `0c5dbd88c07ecac9a665b8491db5f65a6c75e7028dfbce56ae64ec0782cb1521` |
| `CORTEX-missao-mestra-2026-10-18.zip` | no manifesto `SHA256SUMS-missao-mestra-2026-10-18.txt` (fora do ZIP, para não depender de si mesmo) |

Os APKs ficam em `C:\cx-build\artifacts` e o instalador em `apps/pdv-desktop/dist-installer` (ambos fora do versionamento). **Os APKs estão assinados com a chave de debug e apontam para `https://api.invalido.cortex`; o instalador não tem servidor de produção: são prova de construção, não entrega.**

## Arquivos principais alterados ou criados
Banco: `20261018100000_user_password_change`. API: `password-policy`, `auth.service`, `auth.routes`, `user.service`, `user.routes`; script `db-replay-check`. Admin Web: login, `PasswordChange`, usuários, configurações, `api.ts`. Super Admin: login, empresas. Apps: `apps/mobile` e `apps/tv` (`app.json`, plugin de assinatura, `metro.config.js` da TV), `apps/pdv-desktop/package.json`. E2E: `fixtures`, `user-access-flow`. Docs: este relatório, `ESTADO_ATUAL_MISSAO_MESTRA`, `PREPARACAO_COMERCIAL`, `DISTRIBUICAO_APLICATIVOS`, `TERMOS_DE_USO_MINUTA`, `DECISIONS` 157–161, `SECURITY`, `PRODUCAO`, `MOBILE`, `ANDROID_TV`, matriz de permissões, `CHANGELOG`, `CURRENT_STATE`, `.gitignore` (keystores/APK/AAB).
