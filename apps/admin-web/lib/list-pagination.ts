// Regras puras de paginação das listagens do Admin Web.

// Página válida mais próxima de `page` dado o total de páginas devolvido pela
// API. Serve para o caso em que a página atual deixou de existir depois de uma
// ação (ex.: pagar a última conta da página 2 com o filtro "Pendente" ligado):
// sem isso a tela ficaria em "Nenhum registro" sem controle para voltar,
// porque o rodapé de paginação só aparece quando há linhas.
// `pages` 0/ausente (lista vazia) conta como 1.
export function clampPage(page: number, pages: number | null | undefined): number {
  const last = Math.max(1, pages ?? 1);
  return Math.min(Math.max(1, page), last);
}

// Junta todas as páginas de uma listagem paginada da API (`{ data, pagination:
// { pages } }`), para seletores que precisam do conjunto inteiro (ex.: todos os
// mecânicos da empresa) e não de uma página. `maxPages` é um teto contra laço
// infinito se a API devolver `pages` absurdo; passando dele a lista sai
// truncada, por isso quem chama deve filtrar no servidor (o conjunto real é
// pequeno) e não depender do teto.
export async function collectAllPages<T>(
  fetchPage: (page: number) => Promise<{ data?: T[] | null; pagination?: { pages?: number | null } | null } | null | undefined>,
  maxPages = 20
): Promise<T[]> {
  const collected: T[] = [];
  let page = 1;
  let pages = 1;
  while (page <= pages && page <= maxPages) {
    const res = await fetchPage(page);
    collected.push(...(res?.data ?? []));
    pages = res?.pagination?.pages ?? 1;
    page += 1;
  }
  return collected;
}
