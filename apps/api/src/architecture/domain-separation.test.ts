import * as fs from 'fs';
import * as path from 'path';

/**
 * SEPARAÇÃO DE DOMÍNIOS: Venda → Parcelas → Liquidação → Fiscal. Teste estático (lê o código-fonte): se alguém acoplar tributo ao
 * cálculo de parcelas, ao recebimento ou ao fluxo de balcão, ele quebra. O Fiscal é administrativo/configurável (FiscalConfig por
 * empresa/filial, política `fiscal.enabledOperations`); o operador do PDV nunca digita dado tributário. IBS, CBS e Split Payment
 * NÃO estão implementados (ver docs/CORTEX/policies/FISCAL.md): nada aqui os declara prontos.
 */
const API_SRC = path.resolve(__dirname, '..');
const REPO = path.resolve(API_SRC, '..', '..', '..');
const read = (...p: string[]) => fs.readFileSync(path.join(...p), 'utf8');
const walk = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return ['node_modules', 'dist', 'dist-electron'].includes(e.name) ? [] : walk(p);
    return /\.(ts|tsx)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [p] : [];
  });
const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, ''); // código sem comentários
const TAX_WORDS = /\b(ncm|cfop|icms|ibs|cbs|csosn|cst|pis|cofins|splitPayment|split_payment)\b/i;

describe('separação Venda → Parcelas → Liquidação → Fiscal', () => {
  it('só a rota fiscal chama o serviço fiscal: venda e pagamento não emitem nem calculam tributo', () => {
    const importers = walk(API_SRC)
      .filter((f) => /from ['"][./]+(\/)?(services\/)?fiscal\.service['"]/.test(read(f)) || /from ['"]\.\/fiscal\.service['"]/.test(read(f)))
      .map((f) => path.relative(API_SRC, f).replace(/\\/g, '/'));
    expect(importers).toEqual(['routes/fiscal.routes.ts']);
  });

  it('cálculo de parcelas (shared), pagamento e venda não têm tributo nem Fiscal no código', () => {
    const files = [
      path.join(REPO, 'packages', 'shared', 'utils', 'installments.ts'),
      path.join(API_SRC, 'services', 'payment.service.ts'),
      path.join(API_SRC, 'services', 'sale.service.ts'),
      path.join(API_SRC, 'services', 'installment-policy.service.ts'),
    ];
    for (const f of files) {
      const code = strip(read(f));
      expect({ file: path.basename(f), taxWord: code.match(TAX_WORDS)?.[0] ?? null, fiscal: /\bfiscal\b/i.test(code) }).toEqual({ file: path.basename(f), taxWord: null, fiscal: false });
    }
  });

  it('o PDV (caixa) não tem campo tributário: o operador não digita ICMS/NCM/CFOP/IBS/CBS na venda', () => {
    const offenders: string[] = [];
    for (const f of walk(path.join(REPO, 'apps', 'pdv-desktop', 'src'))) {
      const m = strip(read(f)).match(TAX_WORDS);
      if (m) offenders.push(`${path.relative(REPO, f)}: ${m[0]}`);
    }
    expect(offenders).toEqual([]);
  });

  it('Balcão (atendimento) ≠ PDV (caixa): o Balcão não cobra, não abre caixa, não cria venda nem tem campo tributário; os dois apps não se importam', () => {
    const balcao = path.join(REPO, 'apps', 'balcao', 'src');
    const offenders: string[] = [];
    for (const f of walk(balcao)) {
      const code = strip(read(f));
      const money = code.match(/\.(post|put|patch|delete)\(\s*[`'"]\/(payments|cash-register|sales|fiscal|payment-settings)/);
      if (money) offenders.push(`${path.relative(REPO, f)}: chama ${money[0]}`);
      const tax = code.match(TAX_WORDS);
      if (tax) offenders.push(`${path.relative(REPO, f)}: campo tributário ${tax[0]}`);
      if (/from ['"][^'"]*pdv-desktop/.test(code)) offenders.push(`${path.relative(REPO, f)}: importa o PDV`);
    }
    for (const f of walk(path.join(REPO, 'apps', 'pdv-desktop', 'src'))) {
      if (/from ['"][^'"]*(apps\/|\.\.\/)balcao/.test(strip(read(f)))) offenders.push(`${path.relative(REPO, f)}: importa o Balcão`);
    }
    expect(offenders).toEqual([]);
  });

  it('Sale, SaleItem e Payment não guardam dado tributário (o Fiscal vive em FiscalConfig/FiscalDocument)', () => {
    const schema = read(REPO, 'packages', 'database', 'prisma', 'schema.prisma');
    for (const model of ['Sale', 'SaleItem', 'Payment']) {
      const block = schema.match(new RegExp(`^model ${model} \\{[\\s\\S]*?^\\}`, 'm'))?.[0] ?? '';
      expect(block.length).toBeGreaterThan(0);
      const fields = block.split('\n').map((l) => l.trim().split(/\s+/)[0]);
      expect(fields.filter((f) => TAX_WORDS.test(f) || /^tax/i.test(f))).toEqual([]);
    }
  });

  it('o contrato do adaptador fiscal não fixa regra tributária (cada regime/UF/IBS/CBS é de camada própria, ainda inexistente)', () => {
    const types = strip(read(API_SRC, 'services', 'fiscal-adapters', 'types.ts'));
    expect(types).toMatch(/taxes\?: Record<string, unknown>/); // extensível e genérico, sem alíquota hardcoded
    expect(types.match(/\b(aliquota|alíquota|ibs|cbs)\b/i)).toBeNull();
  });
});
