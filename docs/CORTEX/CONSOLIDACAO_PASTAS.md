# Consolidação das pastas e do GitHub (2026-10-22)

Escrito para: o proprietário do CÓRTEX e quem for continuar o desenvolvimento. Objetivo: acabar com a dúvida "qual pasta é a verdadeira" sem perder nenhum dos três meses de trabalho.

## 1. Decisão: pasta principal = `CORTEX-publicacao`

| Critério | `CORTEX-publicacao` | `Saas motos` (original) |
| --- | --- | --- |
| Vínculo com o GitHub | `origin` = `Luis-silva23/cortex`, `main`, sincronizada | `origin` aponta para o mesmo repositório, mas o branch `master` **não** tem relação com a `main` publicada |
| Código | todo o código do original **mais** as correções posteriores (CI, pilha, segurança, dependências) | 5 arquivos mais antigos que a `main` (CI, os dois `next.config.js`, CHANGELOG, PRODUCAO) |
| Alterações pendentes | nenhuma de código (só `docs/evidencias/` não rastreada, cópia do original) | 292 itens não commitados (ver §2) |
| CI | 7 jobs + pilha real, verdes | nunca executado no GitHub |
| Histórico | 1 snapshot + commits novos | **314 commits** (3 meses) |

Para o desenvolvimento futuro, trabalhe só em `CORTEX-publicacao`. **Nada foi apagado nem renomeado**: `Saas motos` continua intacta como arquivo histórico e não deve receber novos commits.

## 2. Os "328 itens pendentes"

A soma é exata: **292 (original) + 36 (publicação) = 328**. Eram **alterações de arquivos** (nenhum é commit): no original, 112 modificados + 180 não rastreados (`git status -uall`; o painel agrupa pastas, por isso a contagem bate só com cada arquivo); na publicação, 36 arquivos não rastreados de `docs/evidencias/`. Que o número do painel seja essa soma é uma inferência (a tela não foi vista), mas os números fecham.

| Classe | Itens | Destino |
| --- | --- | --- |
| Já publicados (código, apps, ícones da marca, `brand/`, CI, docs, `.env.example`) | **124** (51 modificados + 72 novos + `.env.example`) | Idênticos ao que está na `main` (118) ou a `main` já tem versão **mais nova** (5: `ci.yml`, os dois `next.config.js`, `CHANGELOG.md`, `PRODUCAO.md`). Nada a integrar. |
| Evidências de teste (capturas e JSON do Playwright de 13/10, 18/10 e 20/10) | **168** no original (60 modificados + 108 novos) e **36** na publicação (idênticos aos do original) | **Não publicadas, de propósito**: são pesadas (17 MB só aqui), recriáveis pela suíte `apps/e2e`, e os `.log`/`.json` trazem caminhos da máquina. Preservadas no original e no backup. Os links que apontavam para elas viraram texto. |
| Sensíveis | **0** (o único alerta foi o nome `.env.example`, que é o arquivo de exemplo, já publicado e sem valores reais) | — |
| Gerados / temporários | **0** entre os pendentes (os gerados estão ignorados pelo Git) | — |
| Conflitos / ausentes na publicação | **0** | — |
| Duplicatas (mesmo conteúdo, caminhos diferentes) | 72 | São as cópias intencionais dos ícones da marca em vários apps (gerados por `brand/build-assets.js`). Mantidas. |

Os 328 itens estão contabilizados: **124 já publicados + 204 evidências (168 + 36) = 328**. A contagem do painel do original não vai a zero porque ele não será mais commitado (ver §3); isso é esperado, não perda.

## 3. Como recuperar o trabalho anterior

Backup criado fora dos dois repositórios, na pasta `CORTEX-backup-2026-10-22` (ao lado de `Saas motos`), com `SHA256SUMS.txt`:

- `original-historico-completo.bundle` — **314 commits**, todas as refs do original (verificado com `git bundle verify`). Recuperar: `git clone original-historico-completo.bundle recuperado`.
- `original-estado-nao-commitado.tar` — os **292 arquivos** pendentes exatamente como estavam (inclusive evidências). Recuperar: `tar --force-local -xf original-estado-nao-commitado.tar` numa pasta vazia.
- `manifesto-328-itens.csv` e `lista-itens-pendentes-original.txt` — a relação item a item (repositório, status, classe, tamanho, duplicidade).
- `original-HEAD.txt` — `4032618`.

**Histórico acessível dentro da pasta principal**, sem mexer na `main`: o remoto local `original` (somente leitura; a URL de envio está desativada) já foi buscado. Use `git log original/master`, `git show original/master:<caminho>`, `git blame` num arquivo antigo, `git diff main original/master -- <caminho>`. Não há `merge`: os históricos são independentes e não foram unidos.

**Publicar o histórico no GitHub é uma decisão sua** (não foi feito): a varredura dos 314 commits não achou chave, token nem `.env`/credencial jamais commitados, mas o histórico contém as 554 capturas de evidência. Se quiser, em `CORTEX-publicacao`: `git push origin original/master:refs/heads/historico-original` (um branch separado; não toca na `main`).

## 4. Arquivos que existem só localmente (ignorados pelo Git)

Mantidos onde estão, sem copiar para o repositório: `apps/api/.env`, `apps/api/.demo/` (credenciais de demonstração), `apps/hml/.hml/` (credenciais do ambiente isolado), `apps/api/backups/` (dumps do banco de desenvolvimento), `apps/pdv-desktop/dist-installer/` (instaladores), `apps/mobile/android/` (pré-build do Expo) e as pastas regeneráveis (`node_modules`, `.next`, `dist`). Os instaladores e APKs de teste ficam fora do repositório e **não são distribuíveis** (sem assinatura de produção).
