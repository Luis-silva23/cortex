/**
 * Printer Service - Integração com impressoras térmicas
 * Suporta ESC/POS para impressoras de 80mm e 58mm
 */

// A ponte com o processo principal vem do preload (`window.electron.printer`). Importar
// `ipcRenderer` de 'electron' aqui NÃO funciona: o main usa contextIsolation: true e
// nodeIntegration: false, então o renderer só recebeu um stub e nada era impresso.
const printerIpc = {
  async list(): Promise<Array<{ name: string }>> {
    const bridge = window.electron?.printer;
    if (!bridge) throw new Error('Impressão disponível apenas no aplicativo desktop');
    return bridge.list();
  },
  async print(payload: { printerName: string; data: string; options?: Record<string, unknown> }): Promise<void> {
    const bridge = window.electron?.printer;
    if (!bridge) throw new Error('Impressão disponível apenas no aplicativo desktop');
    // O main devolve { success, error }: antes o resultado era ignorado e toda falha virava "true".
    const result = await bridge.print(payload);
    if (!result?.success) throw new Error(result?.error || 'Falha ao imprimir');
  },
};

export interface PrinterConfig {
  name: string;
  width: 80 | 58; // mm
  encoding: 'UTF-8' | 'ISO-8859-1';
}

export interface SalePrintData {
  saleId: string;
  numericId: number;
  date: string;
  items: Array<{
    name: string;
    quantity: number;
    unitPrice: number;
    total: number;
  }>;
  subtotal: number;
  discount: number;
  total: number;
  changeAmount?: number;
  payments: Array<{
    method: string;
    amount: number;
  }>;
  customer?: {
    name: string;
    cpfCnpj?: string;
  };
  seller: {
    name: string;
  };
  // Opcional só por robustez de runtime (ex.: sessão sem empresa carregada);
  // todo usuário do PDV pertence a uma empresa em condições normais.
  company?: {
    name: string;
    cnpj: string;
    address: string;
    phone: string;
  };
}

class PrinterService {
  private config: PrinterConfig = {
    name: '',
    width: 80,
    encoding: 'UTF-8',
  };

  /**
   * Configurar impressora
   */
  setConfig(config: Partial<PrinterConfig>) {
    this.config = { ...this.config, ...config };
  }

  /**
   * Listar impressoras disponíveis
   */
  async listPrinters(): Promise<string[]> {
    try {
      const printers = await printerIpc.list();
      return printers.map((p: any) => p.name);
    } catch (error) {
      console.error('Erro ao listar impressoras:', error);
      return [];
    }
  }

  /**
   * Imprimir cupom de venda
   */
  async printSale(data: SalePrintData): Promise<boolean> {
    try {
      const content = this.generateSaleReceipt(data);
      
      await printerIpc.print({
        printerName: this.config.name,
        data: content,
        options: {
          preview: false,
          silent: true,
          copies: 1,
        },
      });

      return true;
    } catch (error) {
      console.error('Erro ao imprimir:', error);
      throw new Error('Falha na impressão. Verifique se a impressora está conectada.');
    }
  }

  /**
   * Preferências salvas em Configurações (impressora e impressão automática). Antes eram gravadas e NUNCA lidas:
   * o PDV sempre tentava imprimir na impressora padrão, mesmo com "imprimir automaticamente" desligado.
   */
  async loadPreferences(): Promise<{ printerName: string; autoprint: boolean }> {
    try {
      if (window.electron?.loadConfig) {
        const result = await window.electron.loadConfig();
        const cfg = result?.success ? result.config ?? {} : {};
        return { printerName: cfg.printerName || '', autoprint: cfg.autoprint !== false };
      }
      const raw = localStorage.getItem('pdv-config');
      const cfg = raw ? JSON.parse(raw) : {};
      return { printerName: cfg.printerName || '', autoprint: cfg.autoprint !== false };
    } catch {
      return { printerName: '', autoprint: true };
    }
  }

  /**
   * Cupom da venda já concluída: nunca desfaz nem bloqueia a venda; devolve o que aconteceu, em texto para o operador.
   */
  async printSaleReceipt(data: SalePrintData): Promise<{ printed: boolean; note: string }> {
    if (!window.electron?.printer) {
      return { printed: false, note: 'Cupom não impresso: a impressão só funciona no aplicativo PDV instalado.' };
    }
    const prefs = await this.loadPreferences();
    if (!prefs.autoprint) {
      return { printed: false, note: 'Cupom não impresso: impressão automática desligada em Configurações.' };
    }
    this.setConfig({ name: prefs.printerName });
    try {
      await this.printSale(data);
      return { printed: true, note: 'Cupom impresso.' };
    } catch {
      return {
        printed: false,
        note: `Cupom NÃO impresso: ${prefs.printerName ? `impressora "${prefs.printerName}"` : 'impressora padrão'} não respondeu. Verifique se está ligada e conectada (Configurações).`,
      };
    }
  }

  /**
   * Imprimir relatório de abertura de caixa
   */
  async printCashOpen(data: {
    cashRegisterId: string;
    numericId: number;
    openedBy: string;
    openedAt: string;
    initialAmount: number;
  }): Promise<boolean> {
    try {
      const content = this.generateCashOpenReceipt(data);
      
      await printerIpc.print({
        printerName: this.config.name,
        data: content,
      });

      return true;
    } catch (error) {
      console.error('Erro ao imprimir abertura de caixa:', error);
      return false;
    }
  }

  /**
   * Imprimir relatório de fechamento de caixa
   */
  async printCashClose(data: {
    cashRegisterId: string;
    numericId: number;
    openedBy: string;
    closedBy: string;
    openedAt: string;
    closedAt: string;
    initialAmount: number;
    finalAmount: number;
    totalSales: number;
    totalExpenses: number;
    expected: number;
    difference: number;
    paymentMethods: Array<{
      method: string;
      amount: number;
    }>;
  }): Promise<boolean> {
    try {
      const content = this.generateCashCloseReceipt(data);
      
      await printerIpc.print({
        printerName: this.config.name,
        data: content,
      });

      return true;
    } catch (error) {
      console.error('Erro ao imprimir fechamento de caixa:', error);
      return false;
    }
  }

  /**
   * Gerar conteúdo do cupom de venda (ESC/POS)
   */
  private generateSaleReceipt(data: SalePrintData): string {
    const width = this.config.width === 80 ? 48 : 32;
    const line = '='.repeat(width);
    const halfLine = '-'.repeat(width);

    let content = '\n';

    // Cabeçalho da empresa
    if (data.company) {
      content += this.center(data.company.name, width) + '\n';
      if (data.company.cnpj) {
        content += this.center(`CNPJ: ${this.formatCNPJ(data.company.cnpj)}`, width) + '\n';
      }
      if (data.company.address) {
        content += this.center(data.company.address, width) + '\n';
      }
      if (data.company.phone) {
        content += this.center(`Tel: ${data.company.phone}`, width) + '\n';
      }
      content += line + '\n';
    }

    // Informações da venda
    content += this.center('CUPOM NÃO FISCAL', width) + '\n';
    content += halfLine + '\n';
    content += `Venda: ${data.numericId.toString().padStart(6, '0')}\n`;
    content += `Data: ${data.date}\n`;
    content += `Vendedor: ${data.seller.name}\n`;
    
    if (data.customer) {
      content += `Cliente: ${data.customer.name}\n`;
      if (data.customer.cpfCnpj) {
        content += `CPF/CNPJ: ${data.customer.cpfCnpj}\n`;
      }
    }

    content += halfLine + '\n';

    // Itens
    content += 'ITEM DESCRIÇÃO         QTD   VL.UNIT  TOTAL\n';
    content += halfLine + '\n';

    data.items.forEach((item, index) => {
      const itemNum = (index + 1).toString().padStart(3, '0');
      const name = item.name.substring(0, 20).padEnd(20);
      const qty = item.quantity.toFixed(2).padStart(6);
      const price = this.formatMoney(item.unitPrice).padStart(9);
      const total = this.formatMoney(item.total).padStart(9);

      content += `${itemNum} ${name}\n`;
      content += `    ${qty} x ${price} = ${total}\n`;
    });

    content += halfLine + '\n';

    // Totais
    content += this.rightAlign(`Subtotal: ${this.formatMoney(data.subtotal)}`, width) + '\n';
    
    if (data.discount > 0) {
      content += this.rightAlign(`Desconto: ${this.formatMoney(data.discount)}`, width) + '\n';
    }

    content += line + '\n';
    content += this.rightAlign(`TOTAL: ${this.formatMoney(data.total)}`, width) + '\n';
    content += line + '\n';

    // Formas de pagamento
    content += 'FORMA DE PAGAMENTO:\n';
    data.payments.forEach((payment) => {
      content += this.rightAlign(
        `${payment.method}: ${this.formatMoney(payment.amount)}`,
        width
      ) + '\n';
    });

    if (data.changeAmount && data.changeAmount > 0) {
      content += this.rightAlign(`Troco: ${this.formatMoney(data.changeAmount)}`, width) + '\n';
    }

    content += halfLine + '\n';

    // Rodapé
    content += this.center('Obrigado pela preferência!', width) + '\n';
    content += this.center('Volte sempre!', width) + '\n';
    content += '\n\n\n';

    return content;
  }

  /**
   * Gerar conteúdo de abertura de caixa
   */
  private generateCashOpenReceipt(data: {
    cashRegisterId: string;
    numericId: number;
    openedBy: string;
    openedAt: string;
    initialAmount: number;
  }): string {
    const width = this.config.width === 80 ? 48 : 32;
    const line = '='.repeat(width);

    let content = '\n';
    content += this.center('ABERTURA DE CAIXA', width) + '\n';
    content += line + '\n';
    content += `Caixa: ${data.numericId.toString().padStart(6, '0')}\n`;
    content += `Abertura: ${data.openedAt}\n`;
    content += `Operador: ${data.openedBy}\n`;
    content += line + '\n';
    content += this.rightAlign(`Valor Inicial: ${this.formatMoney(data.initialAmount)}`, width) + '\n';
    content += line + '\n';
    content += '\n\n\n';

    return content;
  }

  /**
   * Gerar conteúdo de fechamento de caixa
   */
  private generateCashCloseReceipt(data: {
    cashRegisterId: string;
    numericId: number;
    openedBy: string;
    closedBy: string;
    openedAt: string;
    closedAt: string;
    initialAmount: number;
    finalAmount: number;
    totalSales: number;
    totalExpenses: number;
    expected: number;
    difference: number;
    paymentMethods: Array<{ method: string; amount: number }>;
  }): string {
    const width = this.config.width === 80 ? 48 : 32;
    const line = '='.repeat(width);
    const halfLine = '-'.repeat(width);

    let content = '\n';
    content += this.center('FECHAMENTO DE CAIXA', width) + '\n';
    content += line + '\n';
    content += `Caixa: ${data.numericId.toString().padStart(6, '0')}\n`;
    content += `Abertura: ${data.openedAt}\n`;
    content += `Fechamento: ${data.closedAt}\n`;
    content += `Aberto por: ${data.openedBy}\n`;
    content += `Fechado por: ${data.closedBy}\n`;
    content += halfLine + '\n';

    // Valores
    content += this.rightAlign(`Valor Inicial: ${this.formatMoney(data.initialAmount)}`, width) + '\n';
    content += this.rightAlign(`Total Vendas: ${this.formatMoney(data.totalSales)}`, width) + '\n';
    content += this.rightAlign(`Total Despesas: ${this.formatMoney(data.totalExpenses)}`, width) + '\n';
    content += halfLine + '\n';
    content += this.rightAlign(`Valor Esperado: ${this.formatMoney(data.expected)}`, width) + '\n';
    content += this.rightAlign(`Valor Informado: ${this.formatMoney(data.finalAmount)}`, width) + '\n';

    const diffLabel = data.difference >= 0 ? 'Sobra' : 'Falta';
    content += line + '\n';
    content += this.rightAlign(`${diffLabel}: ${this.formatMoney(Math.abs(data.difference))}`, width) + '\n';
    content += line + '\n';

    // Formas de pagamento
    content += 'RESUMO POR FORMA DE PAGAMENTO:\n';
    content += halfLine + '\n';
    data.paymentMethods.forEach((pm) => {
      content += this.rightAlign(`${pm.method}: ${this.formatMoney(pm.amount)}`, width) + '\n';
    });

    content += line + '\n';
    content += '\n\n\n';

    return content;
  }

  /**
   * Helpers de formatação
   */
  private center(text: string, width: number): string {
    const padding = Math.max(0, Math.floor((width - text.length) / 2));
    return ' '.repeat(padding) + text;
  }

  private rightAlign(text: string, width: number): string {
    const padding = Math.max(0, width - text.length);
    return ' '.repeat(padding) + text;
  }

  private formatMoney(value: number): string {
    return value.toLocaleString('pt-BR', {
      style: 'currency',
      currency: 'BRL',
    });
  }

  private formatCNPJ(cnpj: string): string {
    return cnpj.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5');
  }

  /**
   * Testar impressão
   */
  async testPrint(): Promise<boolean> {
    try {
      const width = this.config.width === 80 ? 48 : 32;
      const line = '='.repeat(width);

      let content = '\n\n';
      content += this.center('TESTE DE IMPRESSÃO', width) + '\n';
      content += line + '\n';
      content += this.center('Impressora configurada corretamente!', width) + '\n';
      content += line + '\n';
      content += `Impressora: ${this.config.name}\n`;
      content += `Largura: ${this.config.width}mm\n`;
      content += `Encoding: ${this.config.encoding}\n`;
      content += line + '\n';
      content += '\n\n\n';

      await printerIpc.print({
        printerName: this.config.name,
        data: content,
      });

      return true;
    } catch (error) {
      console.error('Erro no teste de impressão:', error);
      return false;
    }
  }
}

export const printerService = new PrinterService();
