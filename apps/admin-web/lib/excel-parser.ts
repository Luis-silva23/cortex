import * as XLSX from 'xlsx';
import { isValidDocument } from '@ln-system/shared/utils/validation';

export interface ParsedExcelData {
  headers: string[];
  rows: any[][];
  totalRows: number;
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

/**
 * Número no formato brasileiro ou internacional: "99,90", "1.234,56", "99.90", 99.9. Mesma regra da API
 * (import-normalizers): antes a tela usava Number("99,90") = NaN e recusava planilhas brasileiras que a API aceitaria.
 */
export function parseNumberBR(value: unknown): number {
  if (typeof value === 'number') return value;
  const s = String(value ?? '').trim();
  if (s === '') return NaN;
  const normalized = s.includes(',') ? s.replace(/\./g, '').replace(',', '.') : s;
  return Number(normalized);
}

/**
 * Texto de CSV com a codificação certa: UTF-8 (com ou sem BOM) quando válido; senão Windows-1252 (o "Salvar como CSV"
 * do Excel em português). Antes o arquivo era lido como binário e "Preço" podia virar "PreÃ§o", quebrando o mapeamento.
 */
export function decodeCsv(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^﻿/, '');
  } catch {
    return new TextDecoder('windows-1252').decode(bytes);
  }
}

/** Separador do CSV pela primeira linha: ";" (Excel pt-BR) ou ",". */
export function detectCsvSeparator(text: string): string {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? '';
  return (firstLine.match(/;/g)?.length ?? 0) > (firstLine.match(/,/g)?.length ?? 0) ? ';' : ',';
}

export class ExcelParser {
  static parseFile(file: File): Promise<ParsedExcelData> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();

      reader.onload = (e) => {
        try {
          const bytes = new Uint8Array(e.target?.result as ArrayBuffer);
          const isCsv = /\.csv$/i.test(file.name) || file.type === 'text/csv';
          const workbook = isCsv
            ? (() => {
                const text = decodeCsv(bytes);
                // raw: mantém "99,90" como texto (a conversão numérica é a regra brasileira acima, igual à da API)
                return XLSX.read(text, { type: 'string', FS: detectCsvSeparator(text), raw: true });
              })()
            : XLSX.read(bytes, { type: 'array' });
          const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
          const jsonData = XLSX.utils.sheet_to_json(firstSheet, {
            header: 1,
            defval: '',
          }) as any[][];

          if (jsonData.length === 0) {
            reject(new Error('Arquivo Excel vazio'));
            return;
          }

          const headers = jsonData[0] as string[];
          const rows = jsonData.slice(1);

          resolve({
            headers,
            rows,
            totalRows: rows.length,
          });
        } catch (error) {
          reject(error);
        }
      };

      reader.onerror = () => reject(new Error('Erro ao ler arquivo'));
      reader.readAsArrayBuffer(file);
    });
  }

  static validateProductData(
    rows: any[][],
    columnMap: Record<string, number>,
    scenario: 'basic' | 'with-categories' | 'update'
  ): ValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    // SKU em todos os cenários: identifica o produto (criar ou atualizar). Sem
    // ele o backend recusa a linha — antes sobrescrevia o primeiro produto.
    const requiredFields: Record<string, string[]> = {
      basic: ['sku', 'name', 'price'],
      'with-categories': ['sku', 'name', 'price', 'category'],
      update: ['sku', 'price'],
    };

    const required = requiredFields[scenario] || requiredFields.basic;

    // Validar campos obrigatórios
    for (const field of required) {
      if (columnMap[field] === undefined) {
        errors.push(`Campo obrigatório "${field}" não foi mapeado`);
      }
    }

    if (errors.length > 0) return { valid: false, errors, warnings };

    // Validar dados linha por linha
    rows.forEach((row, index) => {
      const rowNum = index + 2; // +2 porque Excel começa em 1 e tem header

      // Nome
      if (columnMap.name !== undefined) {
        const name = row[columnMap.name];
        if (!name || String(name).trim().length === 0) {
          errors.push(`Linha ${rowNum}: Nome é obrigatório`);
        }
      }

      // Preço
      if (columnMap.price !== undefined) {
        const price = row[columnMap.price];
        const priceNum = parseNumberBR(price);
        if (isNaN(priceNum) || priceNum < 0) {
          errors.push(`Linha ${rowNum}: Preço inválido (${price})`);
        }
      }

      // SKU (todos os cenários)
      if (columnMap.sku !== undefined) {
        const sku = row[columnMap.sku];
        if (!sku || String(sku).trim().length === 0) {
          errors.push(`Linha ${rowNum}: SKU é obrigatório`);
        }
      }

      // Estoque
      if (columnMap.stock !== undefined) {
        const stock = row[columnMap.stock];
        if (stock !== '' && (isNaN(parseNumberBR(stock)) || parseNumberBR(stock) < 0)) {
          warnings.push(`Linha ${rowNum}: Estoque inválido (${stock}), será ignorado`);
        }
      }

      // Barcode
      if (columnMap.barcode !== undefined) {
        const barcode = row[columnMap.barcode];
        if (barcode && String(barcode).length > 50) {
          warnings.push(`Linha ${rowNum}: Código de barras muito longo`);
        }
      }
    });

    return {
      valid: errors.length === 0,
      errors,
      warnings,
    };
  }

  static validateStockData(
    rows: any[][],
    columnMap: Record<string, number>,
    _scenario: string
  ): ValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    // Precisamos de ao menos um identificador de produto (SKU ou código de
    // barras) e da quantidade. Diferente de product/customer, aceitamos
    // qualquer um dos dois identificadores — o casamento real com o produto
    // acontece no backend (matchProductsForImport), aqui só validamos que a
    // planilha tem o mínimo necessário.
    if (columnMap.sku === undefined && columnMap.barcode === undefined) {
      errors.push('Mapeie ao menos uma coluna de identificação do produto (SKU ou Código de Barras)');
    }
    if (columnMap.quantity === undefined) {
      errors.push('Campo obrigatório "quantity" não foi mapeado');
    }

    if (errors.length > 0) return { valid: false, errors, warnings };

    rows.forEach((row, index) => {
      const rowNum = index + 2; // +2 porque Excel começa em 1 e tem header

      const sku = columnMap.sku !== undefined ? row[columnMap.sku] : undefined;
      const barcode = columnMap.barcode !== undefined ? row[columnMap.barcode] : undefined;
      const hasSku = sku !== undefined && sku !== null && String(sku).trim().length > 0;
      const hasBarcode = barcode !== undefined && barcode !== null && String(barcode).trim().length > 0;

      if (!hasSku && !hasBarcode) {
        errors.push(`Linha ${rowNum}: informe SKU ou código de barras`);
      }

      const quantity = columnMap.quantity !== undefined ? row[columnMap.quantity] : undefined;
      const quantityNum = parseNumberBR(quantity);
      if (quantity === undefined || quantity === '' || isNaN(quantityNum) || quantityNum < 0) {
        errors.push(`Linha ${rowNum}: Quantidade inválida (${quantity})`);
      }
    });

    return {
      valid: errors.length === 0,
      errors,
      warnings,
    };
  }

  static validateCustomerData(
    rows: any[][],
    columnMap: Record<string, number>,
    scenario: 'simple' | 'complete' | 'update'
  ): ValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    const requiredFields: Record<string, string[]> = {
      simple: ['name', 'document'],
      complete: ['name', 'document', 'phone', 'email'],
      update: ['document'],
    };

    const required = requiredFields[scenario] || requiredFields.simple;

    // Validar campos obrigatórios
    for (const field of required) {
      if (columnMap[field] === undefined) {
        errors.push(`Campo obrigatório "${field}" não foi mapeado`);
      }
    }

    if (errors.length > 0) return { valid: false, errors, warnings };

    // Validar dados linha por linha
    rows.forEach((row, index) => {
      const rowNum = index + 2;

      // Nome
      if (columnMap.name !== undefined) {
        const name = row[columnMap.name];
        if (!name || String(name).trim().length === 0) {
          errors.push(`Linha ${rowNum}: Nome é obrigatório`);
        }
      }

      // Documento (CPF/CNPJ)
      // Mesma regra da API: 11 ou 14 dígitos COM dígito verificador válido (antes só conferia o tamanho).
      if (columnMap.document !== undefined) {
        const raw = String(row[columnMap.document] ?? '');
        if (!isValidDocument(raw)) {
          errors.push(`Linha ${rowNum}: CPF/CNPJ inválido (${raw.replace(/\D/g, '')})`);
        }
      }

      // Email
      if (columnMap.email !== undefined) {
        const email = row[columnMap.email];
        if (email && !String(email).includes('@')) {
          warnings.push(`Linha ${rowNum}: Email parece inválido (${email})`);
        }
      }

      // Telefone
      if (columnMap.phone !== undefined) {
        const phone = String(row[columnMap.phone]).replace(/\D/g, '');
        if (phone && phone.length < 10) {
          warnings.push(`Linha ${rowNum}: Telefone muito curto (${phone})`);
        }
      }
    });

    return {
      valid: errors.length === 0,
      errors,
      warnings,
    };
  }

  static mapColumnsToData(
    rows: any[][],
    columnMap: Record<string, number>
  ): any[] {
    return rows.map((row) => {
      const mapped: any = {};
      Object.entries(columnMap).forEach(([field, colIndex]) => {
        mapped[field] = row[colIndex];
      });
      return mapped;
    });
  }

  static downloadTemplate(
    type: 'product' | 'customer' | 'stock',
    scenario: string
  ): void {
    const templates: Record<string, any[][]> = {
      'product-basic': [
        ['SKU', 'Nome', 'Preço', 'Estoque', 'Código de Barras'],
        ['PROD001', 'Produto Exemplo', '99.90', '100', '7891234567890'],
      ],
      'product-with-categories': [
        ['SKU', 'Nome', 'Preço', 'Estoque', 'Categoria', 'Código de Barras'],
        ['PROD001', 'Produto Exemplo', '99.90', '100', 'Eletrônicos', '7891234567890'],
      ],
      'product-update': [
        ['SKU', 'Preço', 'Estoque'],
        ['PROD001', '129.90', '50'],
      ],
      'customer-simple': [
        ['Nome', 'CPF/CNPJ', 'Telefone'],
        ['João da Silva', '529.982.247-25', '(11) 98765-4321'],
      ],
      'customer-complete': [
        ['Nome', 'CPF/CNPJ', 'Telefone', 'Email', 'CEP', 'Endereço', 'Cidade', 'Estado'],
        [
          'João da Silva',
          '529.982.247-25',
          '(11) 98765-4321',
          'joao@example.com',
          '01234-567',
          'Rua Exemplo, 123',
          'São Paulo',
          'SP',
        ],
      ],
      'customer-update': [
        ['CPF/CNPJ', 'Telefone', 'Email'],
        ['529.982.247-25', '(11) 98765-4321', 'novo@example.com'],
      ],
      'stock-initial': [
        ['SKU', 'Código de Barras', 'Quantidade'],
        ['PROD001', '7891234567890', '25'],
      ],
    };

    const key = `${type}-${scenario}`;
    const template = templates[key];

    if (!template) {
      console.error('Template não encontrado:', key);
      return;
    }

    const ws = XLSX.utils.aoa_to_sheet(template);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Template');
    XLSX.writeFile(wb, `template_${key}.xlsx`);
  }
}
