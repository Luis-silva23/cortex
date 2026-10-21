'use client';

import React, { useState, useCallback } from 'react';
import { useDropzone } from 'react-dropzone';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { Alert } from '@/components/ui/alert';
import { Select } from '@/components/ui/select';
import {
  Upload,
  FileSpreadsheet,
  Download,
  CheckCircle,
  XCircle,
  AlertCircle,
  AlertTriangle,
  ArrowRight,
} from 'lucide-react';
import { ExcelParser, type ParsedExcelData } from '@/lib/excel-parser';
import { cn } from '@/lib/cn';

type ImportStep = 'upload' | 'preview' | 'map' | 'validate' | 'match' | 'import' | 'result';

interface ImportScenario {
  id: string;
  label: string;
  description: string;
  requiredFields: string[];
}

interface StockMatchResult {
  matched: Array<{ sku?: string; barcode?: string; productId: string; productName: string }>;
  unmatched: Array<{ sku?: string; barcode?: string }>;
  totalChecked: number;
}

interface ExcelImportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  type: 'product' | 'customer' | 'stock';
  scenarios: ImportScenario[];
  onImport: (data: any[], scenario: string) => Promise<{ success: boolean; errors?: string[]; warnings?: string[]; imported?: number }>;
  // Só usado quando type === 'stock': confere, ANTES da confirmação, quais
  // linhas (por SKU/código de barras) correspondem a produtos existentes —
  // para nunca importar (ou descartar) uma linha sem produto correspondente
  // sem o usuário ver isso primeiro.
  onPreviewMatch?: (items: Array<{ sku?: string; barcode?: string }>) => Promise<StockMatchResult>;
}

export function ExcelImportDialog({
  open,
  onOpenChange,
  type,
  scenarios,
  onImport,
  onPreviewMatch,
}: ExcelImportDialogProps) {
  const [step, setStep] = useState<ImportStep>('upload');
  const [scenario, setScenario] = useState<string>(scenarios[0]?.id || '');
  const [file, setFile] = useState<File | null>(null);
  const [parsedData, setParsedData] = useState<ParsedExcelData | null>(null);
  const [columnMap, setColumnMap] = useState<Record<string, number>>({});
  const [validationResult, setValidationResult] = useState<{
    valid: boolean;
    errors: string[];
    warnings: string[];
  } | null>(null);
  const [matchResult, setMatchResult] = useState<StockMatchResult | null>(null);
  const [isChecking, setIsChecking] = useState(false);
  const [matchError, setMatchError] = useState<string | null>(null);
  const [importResult, setImportResult] = useState<{
    success: boolean;
    imported?: number;
    errors?: string[];
    warnings?: string[];
  } | null>(null);
  const [isImporting, setIsImporting] = useState(false);

  const selectedScenario = scenarios.find((s) => s.id === scenario);

  const onDrop = useCallback(async (acceptedFiles: File[]) => {
    const file = acceptedFiles[0];
    if (!file) return;

    try {
      setFile(file);
      const data = await ExcelParser.parseFile(file);
      setParsedData(data);
      
      // Auto-map columns based on header names
      const autoMap: Record<string, number> = {};
      data.headers.forEach((header, index) => {
        const normalizedHeader = header.toLowerCase().trim();
        
        // Product mappings
        if (normalizedHeader.includes('nome') || normalizedHeader === 'name') {
          autoMap.name = index;
        } else if (normalizedHeader.includes('preço') || normalizedHeader === 'price') {
          autoMap.price = index;
        } else if (normalizedHeader.includes('estoque') || normalizedHeader === 'stock') {
          autoMap.stock = index;
        } else if (normalizedHeader.includes('categoria') || normalizedHeader === 'category') {
          autoMap.category = index;
        } else if (normalizedHeader.includes('sku')) {
          autoMap.sku = index;
        } else if (normalizedHeader.includes('barras') || normalizedHeader === 'barcode') {
          autoMap.barcode = index;
        } else if (
          normalizedHeader.includes('quantidade') ||
          normalizedHeader === 'quantity' ||
          normalizedHeader === 'qtd'
        ) {
          autoMap.quantity = index;
        }
        
        // Customer mappings
        else if (normalizedHeader.includes('cpf') || normalizedHeader.includes('cnpj') || normalizedHeader === 'document') {
          autoMap.document = index;
        } else if (normalizedHeader.includes('telefone') || normalizedHeader === 'phone') {
          autoMap.phone = index;
        } else if (normalizedHeader.includes('email')) {
          autoMap.email = index;
        } else if (normalizedHeader.includes('cep') || normalizedHeader === 'zipcode') {
          autoMap.zipcode = index;
        } else if (normalizedHeader.includes('endereço') || normalizedHeader === 'address') {
          autoMap.address = index;
        } else if (normalizedHeader.includes('cidade') || normalizedHeader === 'city') {
          autoMap.city = index;
        } else if (normalizedHeader.includes('estado') || normalizedHeader === 'state') {
          autoMap.state = index;
        }
      });
      
      setColumnMap(autoMap);
      setStep('preview');
    } catch (error) {
      console.error('Error parsing file:', error);
      alert('Erro ao ler arquivo. Verifique se é um arquivo Excel válido.');
    }
  }, []);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: {
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx'],
      'application/vnd.ms-excel': ['.xls'],
      'text/csv': ['.csv'],
    },
    multiple: false,
  });

  const handleColumnMap = (field: string, columnIndex: number) => {
    setColumnMap((prev) => ({ ...prev, [field]: columnIndex }));
  };

  const handleValidate = () => {
    if (!parsedData) return;

    const result =
      type === 'product'
        ? ExcelParser.validateProductData(parsedData.rows, columnMap, scenario as any)
        : type === 'stock'
        ? ExcelParser.validateStockData(parsedData.rows, columnMap, scenario)
        : ExcelParser.validateCustomerData(parsedData.rows, columnMap, scenario as any);

    setValidationResult(result);
    setStep('validate');
  };

  // Só para type === 'stock': antes de importar de fato, confere no backend
  // quais SKUs/códigos de barras existem — e mostra explicitamente ao
  // usuário as linhas que não casaram com nenhum produto (nunca descarta
  // silenciosamente).
  const handleCheckMatches = async () => {
    if (!parsedData || !onPreviewMatch) {
      handleImport();
      return;
    }

    setMatchError(null);
    setIsChecking(true);
    try {
      const mappedData = ExcelParser.mapColumnsToData(parsedData.rows, columnMap);
      const items = mappedData.map((row) => ({ sku: row.sku, barcode: row.barcode }));
      const result = await onPreviewMatch(items);
      setMatchResult(result);
      setStep('match');
    } catch (error: any) {
      console.error('Error checking stock matches:', error);
      setMatchError(
        error?.response?.data?.error ?? 'Erro ao verificar produtos correspondentes. Tente novamente.'
      );
    } finally {
      setIsChecking(false);
    }
  };

  const handleImport = async () => {
    if (!parsedData || !validationResult?.valid) return;

    setIsImporting(true);
    setStep('import');

    try {
      const mappedData = ExcelParser.mapColumnsToData(parsedData.rows, columnMap);
      const result = await onImport(mappedData, scenario);
      setImportResult(result);
      setStep('result');
    } catch (error) {
      console.error('Import error:', error);
      setImportResult({
        success: false,
        errors: ['Erro ao importar dados. Tente novamente.'],
      });
      setStep('result');
    } finally {
      setIsImporting(false);
    }
  };

  const handleDownloadTemplate = () => {
    ExcelParser.downloadTemplate(type, scenario);
  };

  const handleClose = () => {
    setStep('upload');
    setFile(null);
    setParsedData(null);
    setColumnMap({});
    setValidationResult(null);
    setMatchResult(null);
    setMatchError(null);
    setImportResult(null);
    onOpenChange(false);
  };

  const renderUploadStep = () => (
    <div className="space-y-4">
      <div className="space-y-2">
        <label className="text-sm font-medium">Selecione o cenário de importação:</label>
        <Select
          value={scenario}
          onChange={(e) => setScenario(e.target.value)}
          className="w-full"
        >
          {scenarios.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
        </Select>
        {selectedScenario && (
          <p className="text-sm text-gray-500">{selectedScenario.description}</p>
        )}
      </div>

      <div
        {...getRootProps()}
        className={cn(
          'border-2 border-dashed rounded-lg p-12 text-center cursor-pointer transition-colors',
          isDragActive
            ? 'border-blue-500 bg-blue-50'
            : 'border-gray-300 hover:border-gray-400'
        )}
      >
        <input {...getInputProps()} />
        <Upload className="h-12 w-12 mx-auto mb-4 text-gray-400" />
        {isDragActive ? (
          <p className="text-blue-600 font-medium">Solte o arquivo aqui...</p>
        ) : (
          <div className="space-y-2">
            <p className="text-gray-600 font-medium">
              Arraste um arquivo Excel aqui ou clique para selecionar
            </p>
            <p className="text-sm text-gray-500">Formatos: .xlsx, .xls, .csv</p>
          </div>
        )}
      </div>

      <Button
        variant="outline"
        onClick={handleDownloadTemplate}
        className="w-full"
      >
        <Download className="h-4 w-4 mr-2" />
        Baixar modelo
      </Button>
    </div>
  );

  const renderPreviewStep = () => {
    if (!parsedData) return null;

    const preview = parsedData.rows.slice(0, 5);

    return (
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-medium">
              Arquivo: <span className="font-normal">{file?.name}</span>
            </p>
            <p className="text-sm text-gray-500">{parsedData.totalRows} linhas detectadas</p>
          </div>
          <Button variant="outline" size="sm" onClick={() => setStep('upload')}>
            Trocar arquivo
          </Button>
        </div>

        <div className="border rounded-lg overflow-auto max-h-[300px]">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 sticky top-0">
              <tr>
                {parsedData.headers.map((header, i) => (
                  <th key={i} className="px-4 py-2 text-left font-medium text-gray-700 whitespace-nowrap">
                    {header}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {preview.map((row, i) => (
                <tr key={i} className="border-t">
                  {row.map((cell, j) => (
                    <td key={j} className="px-4 py-2 whitespace-nowrap">
                      {String(cell)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <p className="text-xs text-gray-500 text-center">
          Mostrando primeiras 5 linhas de {parsedData.totalRows}
        </p>

        <Button onClick={() => setStep('map')} className="w-full">
          Próximo: Mapear Colunas
          <ArrowRight className="h-4 w-4 ml-2" />
        </Button>
      </div>
    );
  };

  const renderMapStep = () => {
    if (!parsedData || !selectedScenario) return null;

    return (
      <div className="space-y-4">
        <Alert>
          <AlertCircle className="h-4 w-4" />
          <p className="text-sm">
            Mapeie as colunas do Excel para os campos do sistema. Campos marcados com * são obrigatórios.
          </p>
        </Alert>

        <div className="space-y-3">
          {selectedScenario.requiredFields.map((field) => (
            <div key={field} className="flex items-center gap-4">
              <label className="text-sm font-medium w-32">
                {field} <span className="text-red-500">*</span>
              </label>
              <Select
                value={columnMap[field]?.toString() || ''}
                onChange={(e) => handleColumnMap(field, Number(e.target.value))}
                className="flex-1"
              >
                <option value="">Selecione uma coluna</option>
                {parsedData.headers.map((header, index) => (
                  <option key={index} value={index}>
                    {header}
                  </option>
                ))}
              </Select>
            </div>
          ))}
        </div>

        <div className="flex gap-2">
          <Button variant="outline" onClick={() => setStep('preview')} className="flex-1">
            Voltar
          </Button>
          <Button onClick={handleValidate} className="flex-1">
            Validar Dados
            <ArrowRight className="h-4 w-4 ml-2" />
          </Button>
        </div>
      </div>
    );
  };

  const renderValidateStep = () => {
    if (!validationResult) return null;

    return (
      <div className="space-y-4">
        {validationResult.valid ? (
          <Alert className="border-green-200 bg-green-50">
            <CheckCircle className="h-4 w-4 text-green-600" />
            <p className="text-sm text-green-800 font-medium">
              Validação concluída com sucesso!
            </p>
          </Alert>
        ) : (
          <Alert variant="destructive">
            <XCircle className="h-4 w-4" />
            <p className="text-sm font-medium">
              Foram encontrados {validationResult.errors.length} erro(s) nos dados.
            </p>
          </Alert>
        )}

        {validationResult.errors.length > 0 && (
          <div className="border border-red-200 rounded-lg p-4 max-h-[200px] overflow-auto bg-red-50">
            <p className="text-sm font-medium text-red-800 mb-2">Erros:</p>
            <ul className="text-sm text-red-700 space-y-1">
              {validationResult.errors.map((error, i) => (
                <li key={i}>• {error}</li>
              ))}
            </ul>
          </div>
        )}

        {validationResult.warnings.length > 0 && (
          <div className="border border-yellow-200 rounded-lg p-4 max-h-[200px] overflow-auto bg-yellow-50">
            <p className="text-sm font-medium text-yellow-800 mb-2">Avisos:</p>
            <ul className="text-sm text-yellow-700 space-y-1">
              {validationResult.warnings.map((warning, i) => (
                <li key={i}>• {warning}</li>
              ))}
            </ul>
          </div>
        )}

        {matchError && (
          <Alert variant="destructive">
            <XCircle className="h-4 w-4" />
            <p className="text-sm">{matchError}</p>
          </Alert>
        )}

        <div className="flex gap-2">
          <Button variant="outline" onClick={() => setStep('map')} className="flex-1">
            Voltar
          </Button>
          <Button
            onClick={type === 'stock' && onPreviewMatch ? handleCheckMatches : handleImport}
            disabled={!validationResult.valid || isChecking}
            className="flex-1"
          >
            {type === 'stock' && onPreviewMatch
              ? isChecking
                ? 'Verificando produtos...'
                : 'Verificar Produtos'
              : 'Importar Dados'}
          </Button>
        </div>
      </div>
    );
  };

  const renderMatchStep = () => {
    if (!matchResult) return null;
    const { matched, unmatched, totalChecked } = matchResult;

    return (
      <div className="space-y-4">
        <Alert variant={unmatched.length === 0 ? 'success' : 'warning'}>
          {unmatched.length === 0 ? (
            <CheckCircle className="h-4 w-4" />
          ) : (
            <AlertTriangle className="h-4 w-4" />
          )}
          <p className="text-sm font-medium">
            {matched.length} de {totalChecked} linha(s) correspondem a produtos existentes.
          </p>
        </Alert>

        {unmatched.length > 0 && (
          <div className="border border-yellow-200 rounded-lg p-4 max-h-[200px] overflow-auto bg-yellow-50">
            <p className="text-sm font-medium text-yellow-800 mb-2">
              {unmatched.length} linha(s) sem produto correspondente — não serão importadas.
              Corrija o SKU/código de barras e reenvie o arquivo se necessário:
            </p>
            <ul className="text-sm text-yellow-700 space-y-1">
              {unmatched.map((item, i) => (
                <li key={i}>
                  • SKU: {item.sku || '-'} / Código de barras: {item.barcode || '-'}
                </li>
              ))}
            </ul>
          </div>
        )}

        {matched.length > 0 && (
          <div className="border rounded-lg p-4 max-h-[150px] overflow-auto">
            <p className="text-sm font-medium text-gray-700 mb-2">Produtos que serão atualizados:</p>
            <ul className="text-sm text-gray-600 space-y-1">
              {matched.slice(0, 20).map((item, i) => (
                <li key={i}>
                  • {item.productName} ({item.sku || item.barcode})
                </li>
              ))}
              {matched.length > 20 && <li>... e mais {matched.length - 20}</li>}
            </ul>
          </div>
        )}

        <div className="flex gap-2">
          <Button variant="outline" onClick={() => setStep('validate')} className="flex-1">
            Voltar
          </Button>
          <Button onClick={handleImport} disabled={matched.length === 0} className="flex-1">
            Confirmar Importação ({matched.length})
          </Button>
        </div>
      </div>
    );
  };

  const renderImportStep = () => (
    <div className="space-y-4 py-8">
      <div className="text-center">
        <FileSpreadsheet className="h-16 w-16 mx-auto mb-4 text-blue-600 animate-pulse" />
        <p className="text-lg font-medium">Importando dados...</p>
        <p className="text-sm text-gray-500 mt-1">Por favor, aguarde</p>
      </div>
      <Progress value={50} className="w-full" />
    </div>
  );

  const renderResultStep = () => {
    if (!importResult) return null;

    const importedCount = importResult.imported ?? 0;
    const hasErrors = (importResult.errors?.length ?? 0) > 0;
    // Nunca fabricamos um resultado "tudo importado com sucesso" quando o
    // backend reportou falhas em algumas linhas — mostramos exatamente o que
    // teve sucesso e o que falhou, mesmo em caso de sucesso parcial.
    const isPartial = hasErrors && importedCount > 0;
    const isFullFailure = hasErrors && importedCount === 0;

    return (
      <div className="space-y-4">
        {!hasErrors ? (
          <div className="text-center py-8">
            <CheckCircle className="h-16 w-16 mx-auto mb-4 text-green-600" />
            <p className="text-lg font-medium text-green-800">
              Importação concluída com sucesso!
            </p>
            <p className="text-sm text-gray-600 mt-2">
              {importedCount} registro(s) importado(s)
            </p>
          </div>
        ) : (
          <div className="text-center py-8">
            {isPartial ? (
              <AlertTriangle className="h-16 w-16 mx-auto mb-4 text-amber-500" />
            ) : (
              <XCircle className="h-16 w-16 mx-auto mb-4 text-red-600" />
            )}
            <p className={`text-lg font-medium ${isPartial ? 'text-amber-800' : 'text-red-800'}`}>
              {isPartial ? 'Importação concluída parcialmente' : 'Erro na importação'}
            </p>
            {isPartial && (
              <p className="text-sm text-gray-600 mt-2">
                {importedCount} registro(s) importado(s) com sucesso, {importResult.errors?.length} falharam
              </p>
            )}
            {isFullFailure && (
              <p className="text-sm text-gray-600 mt-2">Nenhum registro foi importado.</p>
            )}
            {importResult.errors && (
              <div className="mt-4 text-left">
                <p className="text-sm font-medium text-red-800 mb-2">
                  {isPartial ? 'Linhas que falharam:' : 'Erros:'}
                </p>
                <div className="max-h-[200px] overflow-auto">
                  <ul className="text-sm text-red-700 space-y-1">
                    {importResult.errors.map((error, i) => (
                      <li key={i}>• {error}</li>
                    ))}
                  </ul>
                </div>
              </div>
            )}
          </div>
        )}

        {(importResult.warnings?.length ?? 0) > 0 && (
          <div className="text-left">
            <p className="text-sm font-medium text-amber-800 mb-2">Avisos (a linha foi importada):</p>
            <div className="max-h-[160px] overflow-auto">
              <ul className="text-sm text-amber-700 space-y-1">
                {importResult.warnings!.map((warning, i) => (
                  <li key={i}>• {warning}</li>
                ))}
              </ul>
            </div>
          </div>
        )}

        <Button onClick={handleClose} className="w-full">
          Fechar
        </Button>
      </div>
    );
  };

  const renderStep = () => {
    switch (step) {
      case 'upload':
        return renderUploadStep();
      case 'preview':
        return renderPreviewStep();
      case 'map':
        return renderMapStep();
      case 'validate':
        return renderValidateStep();
      case 'match':
        return renderMatchStep();
      case 'import':
        return renderImportStep();
      case 'result':
        return renderResultStep();
      default:
        return null;
    }
  };

  const getStepTitle = () => {
    switch (step) {
      case 'upload':
        return 'Upload de Arquivo';
      case 'preview':
        return 'Prévia dos dados';
      case 'map':
        return 'Mapear Colunas';
      case 'validate':
        return 'Validação';
      case 'match':
        return 'Produtos Correspondentes';
      case 'import':
        return 'Importando';
      case 'result':
        return 'Resultado';
      default:
        return 'Importar Excel';
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-3xl" onClose={handleClose}>
        <DialogHeader>
          <DialogTitle>{getStepTitle()}</DialogTitle>
          <DialogDescription>
            {step === 'upload' &&
              `Importe dados de ${
                type === 'product' ? 'produtos' : type === 'stock' ? 'estoque' : 'clientes'
              } via Excel`}
            {step === 'preview' && 'Verifique os dados antes de continuar'}
            {step === 'map' && 'Configure o mapeamento das colunas'}
            {step === 'validate' && 'Resultado da validação dos dados'}
            {step === 'match' && 'Confira quais linhas correspondem a produtos existentes'}
            {step === 'import' && 'Processando importação...'}
            {step === 'result' && 'Importação finalizada'}
          </DialogDescription>
        </DialogHeader>
        {/* Mesmo recuo do cabeçalho (p-6): antes o corpo só tinha py-4 e listas/botões encostavam na borda do diálogo. */}
        <div className="px-6 pb-6 pt-4">{renderStep()}</div>
      </DialogContent>
    </Dialog>
  );
}
