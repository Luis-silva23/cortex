# Testes de navegador (E2E)

Chrome real (via `playwright-core`) contra o ambiente de **desenvolvimento** com a empresa demo. Não rodam em produção nem no
banco dos testes de integração (o código recusa). Não ficam no `npm test` do monorepo: precisam dos servidores no ar.

## Antes de rodar

1. Postgres e Redis de desenvolvimento no ar; `cd apps/api && npm run demo:seed` (cria as empresas demo, os usuários e uma
   garantia de demonstração; a senha fica em `apps/api/.demo/`, ignorado pelo git).
2. API (3001), Admin Web (3002), Super Admin (3000) e PDV web (`cd apps/pdv-desktop && npm run dev:web`, porta 5173).
3. Chrome instalado (ou `CHROME_PATH`). Portas diferentes: `E2E_API_URL`, `E2E_ADMIN_URL`, `E2E_SUPER_ADMIN_URL`, `E2E_PDV_URL`.

```
cd apps/e2e && npm test
```

Se um servidor estiver fora do ar o teste **falha** dizendo qual (nunca "passa" pulando).

## O que cobrem

| Arquivo | Cobertura |
|---|---|
| `support-ticket-flow` | Ajuda: busca, artigo, contexto, cartão recusado, criar, resposta do suporte, aviso, encerrar, 390 px; HTML no assunto não executa; empresa B não abre chamado da empresa A (tela e API) |
| `support-console-pdv` | Console: categoria e artigo (validar, criar, editar, publicar, despublicar), rascunho invisível à empresa, script no artigo não executa; PDV: recusas, duplo clique cria um chamado só |
| `support-contextual-buttons` | Botões "Relatar problema" em OS, garantia da OS, cobrança e Pós-venda › Garantias |
| `balcao-flow` | Balcão (:5174): login (erro/sucesso), cliente, veículo, peça com disponível, orçamento (duplo clique = 1), total oficial, aprovar → OS, ficha ao caixa, histórico, 390 px, VIEWER. `E2E_BALCAO_URL` aponta para o servidor (use um servidor com a CSP do nginx para provar que ela não bloqueia nada) |
| `admin-web-flow` | Admin Web (:3002): login, navegação, validação e cadastro de cliente, produtos, orçamento novo, 390 px, VIEWER recusado |
| `super-admin-flow` | Super Admin (:3000): login com MFA TOTP, módulos da plataforma, sair, acesso de usuário de empresa |
| `catalog-and-help` | Admin Web: códigos de barras múltiplos na edição do produto (adicionar com zeros, conflito `BARCODE_IN_USE`, desativar/reativar), perfil de consulta recebe a mensagem padrão de falta de autorização, Central de Ajuda (busca e artigo). Produtos `E2E-…` removidos por id com `companyId` |
| `mfa-privacy-image` | Admin Web com a API iniciada com **`REQUIRE_MFA_COMPANY_ADMIN=true`**: administrador sem MFA é levado à configuração (QR, código errado recusado, códigos de recuperação), próximo login pede o código, o **mesmo código não vale duas vezes**, código de recuperação vale uma vez, o Super Admin reinicia o fator; Privacidade (LGPD): exportar baixa o JSON do titular e anonimizar mostra o plano, exige confirmar e sobrescreve; imagem do produto (enviar, remover, arquivo falso recusado). Capturas **sem segredo** (QR, segredo TOTP e códigos são mascarados antes de capturar) em `docs/evidencias/2026-10-14-playwright/mfa-privacidade-imagem/` |
| `monitoring-central` | Central de Monitoramento do Super Admin (:3000 em produção `next start` ou dev + API :3001): KPIs, 8 gráficos, backup em 3 níveis, períodos/atualizar, estados carregando/erro/vazio (interceptação de rede), empresas (busca, ordenação, detalhe, isolamento), alertas (ciclo reconhecer→tratar→resolver com nota→reabrir e histórico; ação inválida recusada), funil (criar, mover, motivo obrigatório para cancelar), serviços externos (pendentes sem credencial, ajuste só restringe, provedor indisponível), permissões (empresa e anônimo recusados em todas as rotas), 390 px sem rolagem horizontal e acessibilidade básica. Cria só dados `[e2e]` (oportunidades e alertas de teste, removidos por id); **não envia e-mail nem evento Sentry** (nada configurado). Capturas em `docs/evidencias/2026-10-18-playwright/central-monitoramento/` |
| `pdv-sale-flow` | PDV web (:5173) na empresa **sandbox**: abre caixa (nº 91), leitura por SKU, parcelas do crédito, duplo clique em Confirmar = 1 venda (a venda é dado de teste e **não** é removida: trilha financeira append-only) |

Evidências (capturas) vão para `docs/evidencias/2026-10-13-playwright/`. Rode **um servidor de aplicativo por vez** quando possível e desligue-os antes da suíte de integração completa (o PostgreSQL portátil tem 100 conexões).

Tudo que o teste cria leva o prefixo `[e2e]` e é removido ao final por id/prefixo com `companyId` explícito (e, no começo,
sobras de execução interrompida). Cada arquivo falha se houver erro de página ou resposta 5xx.

## Banco novo, sem histórico (2026-10-22)

A suíte foi escrita para um banco de desenvolvimento antigo, que já tinha dados. Num banco **recém-migrado** + `npm run demo:seed`, quatro arquivos falham por falta de dado, não por defeito de tela (verificado na homologação pós-Next 15, [HOMOLOGACAO_POS_NEXT15](../../docs/CORTEX/HOMOLOGACAO_POS_NEXT15.md)):

| Arquivo | O que falta | Como preparar |
|---|---|---|
| `catalog-and-help` | artigos da Central de Ajuda publicados | `cd apps/api && npm run help:seed -- --apply --publish` (sem `--apply` é só simulação e não grava nada) |
| `super-admin-flow` | uma licença ativa da empresa Alfa | criar uma licença `ACTIVE` para a Alfa (tela de Licenças do Super Admin) |
| `support-contextual-buttons` | uma **OS encerrada** na matriz da Alfa (o `demo:seed` só cria a garantia em cima de uma OS encerrada que já exista) | encerrar uma OS da Alfa e rodar `npm run demo:seed` de novo |
| `mfa-privacy-image` | a API iniciada com `REQUIRE_MFA_COMPANY_ADMIN=true` | reiniciar a API com a variável só para este arquivo |

Se um desses falhar com "timeout esperando um elemento" ou "esperava > 0 e recebeu 0", confira primeiro esta tabela.

**Duas configurações da API, duas execuções (2026-10-22):** com `REQUIRE_MFA_COMPANY_ADMIN=true`, `admin-web-flow` e `user-access-flow` reprovam (entram pela tela como `admin.alfa`, que não tem MFA, e caem na configuração de MFA); com a variável desligada, `mfa-privacy-image` reprova. Rode em duas execuções contínuas: (A) API com a variável, só `mfa-privacy-image`; (B) API sem a variável, `npx jest --runInBand --forceExit --testPathIgnorePatterns mfa-privacy-image`. Resultado de 2026-10-22, com a API como papel de banco **sem posse e sem BYPASSRLS**: A 6/6, B 87/87.

## Limite de requisições da API (causa de falha intermitente, 2026-10-14)

A API limita **100 requisições por minuto por usuário** (balde `general`, bloqueio de 60 s) e todos os arquivos usam o mesmo usuário de
demonstração (`admin.alfa`). Um arquivo como `support-contextual-buttons` faz ~50 chamadas; duas execuções seguidas (ou o arquivo logo
depois de `admin-web-flow`) estouram o balde, a API responde **429** e a tela perde dados — o teste falhava por *timeout* esperando um
botão, parecendo problema de compilação a frio (que foi **descartado**: com o cache `.next` apagado a primeira navegação leva ~6,5 s,
longe dos 15 s do teste). Correção **só no teste** (o limitador do produto não foi alterado): `launchBrowser()` zera, no Redis de
**desenvolvimento**, os baldes `ratelimit_(mfa|auth|authorizer|general)*` antes de cada arquivo, e `watch()` agora conta as chamadas
à API e registra recusas 401/403/429 (por ora só `support-contextual-buttons` afirma que não houve recusa: se houver, falha dizendo qual rota recebeu 429, em vez de só "elemento não encontrado"; os demais arquivos apenas se beneficiam do balde limpo).
**Não** rode estas suítes contra um servidor que não seja o de desenvolvimento; `pdv-sale-flow` cria uma venda persistente na
empresa sandbox (trilha financeira append-only, sem como limpar) — **não repetir** sem isolamento e plano de limpeza aprovados.
