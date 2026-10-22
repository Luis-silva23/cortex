# Organização das pastas, Git, GitHub Desktop e backup

Atualizado em 2026-10-22. Escrito para o dono do projeto: o que existe, qual pasta usar para continuar trabalhando, e como restaurar se algo der errado.

## 1. As duas pastas

| | **CORTEX-publicacao** (pasta oficial de desenvolvimento) | **Saas motos** (original, histórico) |
|---|---|---|
| Ramo | `main` | `master` |
| Commits | 28 (histórico limpo, preparado para publicação) | 314 (histórico de desenvolvimento antigo) |
| Último commit | `a3b425a` (2026-10-22) = **igual ao GitHub** (`origin/main`) | `4032618` (2026-10-19) |
| Remoto `origin` | `https://github.com/Luis-silva23/cortex.git` | **o mesmo endereço** do GitHub |
| Alterações não commitadas | as desta rodada (ver §5) | 145 arquivos (trabalho anterior, **intocado**) |

**Por quê CORTEX-publicacao é a oficial:** é a única cuja história bate com o GitHub, a única com CI, workflows e documentação atualizados, e a que recebeu todas as correções recentes (Next 15, Cloudflare, canais de alerta, monitor). A original **não foi alterada, apagada nem renomeada**: ela é o registro do que existia e continua como cópia de segurança.

## 2. Risco real a evitar (GitHub Desktop)

A pasta **original aponta para o mesmo repositório do GitHub**, mas com **outra história**. Se alguém abrir a original no GitHub Desktop e tentar publicar (`push`), o GitHub recusa (história divergente) — e a "solução" que o programa pode sugerir (forçar) **apagaria** o histórico publicado. Por isso:

1. **No GitHub Desktop, abra somente `CORTEX-publicacao`.** Não adicione `Saas motos` (se já estiver adicionada, remova da lista do programa — isso **não apaga arquivos**).
2. Nunca use "force push" nem "reset hard". Para sincronizar: *Fetch origin* → *Pull* → trabalhar → *Commit* → *Push*.
3. Proteção opcional na original (não aplicada, decisão sua): `git -C "Saas motos" remote set-url --push origin DESATIVADO` — o `push` dela passa a falhar de propósito, sem afetar leitura.
4. **Não existe sincronização automática entre as duas pastas e não deve existir.** Uma funcionalidade tem **uma** fonte oficial: a `CORTEX-publicacao`. Se precisar de algo da original, traga **arquivo a arquivo**, olhando a diferença antes (nunca copiar pasta sobre pasta).
5. A chave `ssh-key-2026-10-20.key` fica **fora dos repositórios** (está na pasta pai). Nunca a coloque dentro de uma das duas pastas, de um backup ou de um ZIP compartilhado.

## 3. Backup datado (fora das pastas de trabalho)

Local: `…\saas_m_fixed\CORTEX-backup-2026-10-22-1635\` (irmã das pastas de trabalho; os backups anteriores ficam ao lado, **nenhum foi sobrescrito**).

| Arquivo | O que é |
|---|---|
| `publicacao-historico-completo.bundle` | todo o histórico Git da CORTEX-publicacao (todos os ramos) |
| `original-historico-completo.bundle` | todo o histórico Git da Saas motos |
| `publicacao-arvore.tar` / `original-arvore.tar` | árvore de trabalho **incluindo alterações não commitadas** (`git ls-files -co --exclude-standard`: exclui só o que é regenerável — `node_modules`, `dist`, `.next`, caches — e o que o `.gitignore` marca como segredo, como `.env`) |
| `*-HEAD.txt`, `*-status.txt`, `*-lista-arquivos.txt`, `*-sha256-arquivos.txt` | commit, estado, lista e SHA-256 de cada arquivo |
| `SHA256SUMS.txt` | SHA-256 de todos os itens acima |
| `README-RESTAURAR.md` | passo a passo da restauração |

**Verificação feita:** `git bundle verify` dos dois bundles, conferência do `SHA256SUMS`, *clone* de teste a partir do bundle e conferência de hash arquivo por arquivo da árvore — 0 falhas. O backup **não inclui** `.env` nem chaves (por desenho); guarde esses segredos em cofre próprio.

**Restaurar (resumo):**
```bash
# histórico completo
git clone publicacao-historico-completo.bundle CORTEX-restaurada
# árvore com alterações não commitadas (GNU tar no Windows precisa de --force-local)
mkdir restaurada && tar --force-local -xf publicacao-arvore.tar -C restaurada
```
Depois: `npm ci` na raiz, recriar o `.env` a partir de `.env.example` e rodar `npm run build --workspace=@ln-system/shared`.

## 4. Política de commits

Nada é commitado nem enviado automaticamente. Antes de commitar, revisar a diferença (`git diff`), garantir que não há segredo (`.env`, chaves, tokens) e que `next-env.d.ts` e `idempotency.ts` — que aparecem como alterados só por fim de linha — não entram. Commits normais, sem `--amend` de histórico já publicado, sem `--force`.

## 5. Estado desta rodada

Alterações novas na CORTEX-publicacao (canais de alerta, monitor independente, Infraestrutura): ver [CHANGELOG](CHANGELOG.md) (2026-10-22, "Organização, infraestrutura, alertas"). Ainda **não** publicadas no GitHub até o commit/push da rodada ser feito e a CI conferida.
