// GUARDA DE DESIGN — dinheiro sempre no formato brasileiro ("R$ 1.234,56"), via formatCurrency. Montar "R$ " à
// mão com toFixed(2) ou interpolação mostrava "R$ 50.00" (OS, compras, vendas, produtos, descontos, gráficos).
import { listUiSources, readText, formatViolations, Violation } from './design-guard';

const HANDMADE = [/R\$ \{[^}]*toFixed\(/, /R\$ \$\{/];

function findHandmadeCurrency(files: string[]): Violation[] {
  const out: Violation[] = [];
  for (const file of files) {
    readText(file)
      .split('\n')
      .forEach((line, i) => {
        if (HANDMADE.some((re) => re.test(line))) out.push({ file, line: i + 1, rule: 'moeda', detail: line.trim().slice(0, 100) });
      });
  }
  return out;
}

describe('moeda no formato brasileiro', () => {
  it('o auditor detecta "R$" montado à mão', () => {
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const tmp = path.join(os.tmpdir(), `currency-guard-${Date.now()}.tsx`);
    fs.writeFileSync(tmp, 'export const X = ({ v }: any) => <p>R$ {v.toFixed(2)}</p>;\nconst f = (v: number) => `R$ ${v}`;\n');
    try {
      expect(findHandmadeCurrency([tmp])).toHaveLength(2);
    } finally {
      fs.unlinkSync(tmp);
    }
  });

  it('nenhuma tela monta "R$" à mão', () => {
    const violations = findHandmadeCurrency(listUiSources());
    if (violations.length) throw new Error('Use formatCurrency:\n' + formatViolations(violations));
  });
});
