import { clampPage, collectAllPages } from './list-pagination';

describe('clampPage', () => {
  it('mantém a página quando ela existe', () => {
    expect(clampPage(2, 5)).toBe(2);
    expect(clampPage(5, 5)).toBe(5);
  });

  it('volta para a última página quando a atual deixou de existir', () => {
    expect(clampPage(3, 2)).toBe(2);
  });

  it('lista vazia (pages 0 ou ausente) volta para a página 1', () => {
    expect(clampPage(4, 0)).toBe(1);
    expect(clampPage(4, undefined)).toBe(1);
    expect(clampPage(4, null)).toBe(1);
  });

  it('nunca devolve página menor que 1', () => {
    expect(clampPage(0, 3)).toBe(1);
    expect(clampPage(-2, 3)).toBe(1);
  });
});

describe('collectAllPages', () => {
  const pageOf = (data: string[], pages: number) => Promise.resolve({ data, pagination: { pages } });

  it('percorre todas as páginas na ordem e concatena os itens', async () => {
    const fetchPage = jest.fn((page: number) =>
      pageOf([`a${page}`, `b${page}`], 3)
    );
    await expect(collectAllPages(fetchPage)).resolves.toEqual(['a1', 'b1', 'a2', 'b2', 'a3', 'b3']);
    expect(fetchPage.mock.calls.map((c) => c[0])).toEqual([1, 2, 3]);
  });

  it('uma página só: uma única requisição', async () => {
    const fetchPage = jest.fn(() => pageOf(['x'], 1));
    await expect(collectAllPages(fetchPage)).resolves.toEqual(['x']);
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });

  it('resposta sem paginação/sem dados vira lista vazia, sem laço', async () => {
    const fetchPage = jest.fn(() => Promise.resolve(undefined));
    await expect(collectAllPages(fetchPage)).resolves.toEqual([]);
    expect(fetchPage).toHaveBeenCalledTimes(1);

    const noPagination = jest.fn(() => Promise.resolve({ data: ['y'] }));
    await expect(collectAllPages(noPagination)).resolves.toEqual(['y']);
    expect(noPagination).toHaveBeenCalledTimes(1);
  });

  it('para no teto de páginas se a API declarar páginas demais', async () => {
    const fetchPage = jest.fn((page: number) => pageOf([`p${page}`], 9999));
    const result = await collectAllPages(fetchPage, 3);
    expect(result).toEqual(['p1', 'p2', 'p3']);
    expect(fetchPage).toHaveBeenCalledTimes(3);
  });

  it('propaga o erro da requisição (a tela mostra a mensagem em vez de uma lista parcial)', async () => {
    const fetchPage = jest.fn((page: number) => (page === 2 ? Promise.reject(new Error('falhou')) : pageOf(['ok'], 3)));
    await expect(collectAllPages(fetchPage)).rejects.toThrow('falhou');
  });
});
