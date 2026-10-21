import { Request, Response, NextFunction } from 'express';
import { Logger } from '../services/logger.service';

/**
 * Mensagens de erro para quem opera o sistema, em português. Os services/rotas ainda lançam várias mensagens em inglês
 * (e algumas rotas COMPARAM esses textos, ex.: `error.message === 'Payment not found'` → 404), então a tradução é feita
 * na saída: toda resposta de erro (status ≥ 400) tem `error`/`message` traduzidos quando o texto está aqui. Logs e
 * mensagens técnicas internas continuam como estão. Mensagem nova em inglês → acrescente aqui (translate-errors.test.ts
 * confere que toda mensagem lançada em inglês pelos services/rotas tem tradução).
 */
export const EXACT_MESSAGES: Record<string, string> = {
  // não encontrado
  'Customer not found': 'Cliente não encontrado',
  'Service order not found': 'Ordem de serviço não encontrada',
  'Product not found': 'Produto não encontrado',
  'Sale not found': 'Venda não encontrada',
  'Follow-up not found': 'Pós-venda não encontrado',
  'Cash register not found or already closed': 'Caixa não encontrado ou já fechado',
  'Cash register not found': 'Caixa não encontrado',
  'Supplier not found': 'Fornecedor não encontrado',
  'Quote not found': 'Orçamento não encontrado',
  'Quote version not found': 'Versão do orçamento não encontrada',
  'Purchase order not found': 'Pedido de compra não encontrado',
  'Payment not found': 'Pagamento não encontrado',
  'Motorcycle not found': 'Moto não encontrada',
  'Motorcycle not found for this customer': 'Moto não encontrada para este cliente',
  'Motorcycle not found or does not belong to this customer': 'Moto não encontrada ou não pertence a este cliente',
  'Motorcycle does not belong to this customer': 'A moto não pertence a este cliente',
  'Branch not found in this company': 'Filial não encontrada nesta empresa',
  'Category not found': 'Categoria não encontrada',
  'Account receivable not found': 'Conta a receber não encontrada',
  'Account payable not found': 'Conta a pagar não encontrada',
  'Revision not found': 'Revisão não encontrada',
  'Fiscal document not found': 'Documento fiscal não encontrado',
  'Appointment not found': 'Agendamento não encontrado',
  'User not found': 'Usuário não encontrado',
  'User email not found': 'E-mail do usuário não encontrado',
  'System log not found': 'Registro de log não encontrado',
  'Entry checklist not found for this service order': 'Checklist de entrada não encontrado para esta ordem de serviço',
  'Mechanic not found in this company': 'Mecânico não encontrado nesta empresa',
  'Authorizer not found': 'Autorizador não encontrado',
  'Backup file not found': 'Arquivo de backup não encontrado',
  'One or more products were not found in this company': 'Um ou mais produtos não foram encontrados nesta empresa',
  'Not Found': 'Não encontrado',
  // estado / regra de negócio
  'This account has already been reversed': 'Esta conta já foi estornada',
  'This quote version has already been converted into a service order': 'Esta versão do orçamento já foi convertida em ordem de serviço',
  'Service order already paid': 'Ordem de serviço já paga',
  'Sale is already fully paid (or fully committed by pending payments)': 'A venda já está paga (ou o saldo está reservado por pagamentos pendentes)',
  'Sale is already fully paid (concurrent payment approved first)': 'A venda já foi paga por outro pagamento aprovado ao mesmo tempo',
  'Sale already cancelled': 'Venda já cancelada',
  'Sale already returned': 'Venda já devolvida',
  'Payment already cancelled or refunded': 'Pagamento já cancelado ou estornado',
  'Only approved payments can be refunded': 'Só pagamentos aprovados podem ser estornados',
  'Fiscal document is already cancelled': 'Documento fiscal já cancelado',
  'Cannot process payment for cancelled or returned sale': 'Não é possível receber pagamento de venda cancelada ou devolvida',
  'Transfer must have at least one item': 'A transferência precisa ter pelo menos um item',
  'This follow-up already has an appointment — reschedule the existing one instead': 'Este pós-venda já tem agendamento — remarque o existente',
  'Service order does not belong to the given customer/motorcycle': 'A ordem de serviço não pertence a este cliente/moto',
  'Sale total cannot be negative — the discounts exceed the subtotal': 'O total da venda não pode ficar negativo — os descontos passam do subtotal',
  'Revision does not belong to the given customer/motorcycle': 'A revisão não pertence a este cliente/moto',
  'Return quantity must be greater than zero': 'A quantidade devolvida deve ser maior que zero',
  'Quote version must have at least one item': 'A versão do orçamento precisa ter pelo menos um item',
  'Quote total exceeds the supported limit': 'O total do orçamento passa do limite permitido',
  'Quote must have at least one item': 'O orçamento precisa ter pelo menos um item',
  'Purchase order must have at least one item': 'O pedido de compra precisa ter pelo menos um item',
  'Purchase order is already cancelled': 'Pedido de compra já cancelado',
  'Product is not part of this purchase order': 'O produto não faz parte deste pedido de compra',
  'Only a received account can be reversed': 'Só uma conta recebida pode ser estornada',
  'Only a paid account can be reversed': 'Só uma conta paga pode ser estornada',
  'Motorcycle does not match the motorcycle linked to this service order': 'A moto não é a mesma vinculada a esta ordem de serviço',
  'Follow-up is already cancelled': 'Pós-venda já cancelado',
  'Customer with this document already exists': 'Já existe um cliente com este documento',
  'A supplier with this document already exists for this company': 'Já existe um fornecedor com este documento nesta empresa',
  'A fiscal document is already active or in progress for this sale': 'Já existe um documento fiscal ativo ou em emissão para esta venda',
  'Cash register is not open': 'O caixa não está aberto',
  'Cash register does not belong to the sale branch': 'O caixa não é da filial da venda',
  'Cannot send a version of a quote that has already been converted into a service order': 'Não é possível enviar versão de um orçamento já convertido em ordem de serviço',
  'Cannot schedule an appointment for a cancelled follow-up': 'Não é possível agendar um pós-venda cancelado',
  'Cannot return a cancelled sale': 'Não é possível devolver uma venda cancelada',
  'Cannot return a cancelled or already returned sale': 'Não é possível devolver uma venda cancelada ou já devolvida',
  'Cannot decide on a version that has not been sent to the customer yet': 'Não é possível decidir sobre uma versão que ainda não foi enviada ao cliente',
  'Cannot close service order financially before payment is confirmed': 'Não é possível encerrar a ordem de serviço antes de o pagamento ser confirmado',
  'Cannot cancel an account that has already been received — use a reversal instead': 'Não é possível cancelar uma conta já recebida — use o estorno',
  'Cannot cancel an account that has already been paid — use a reversal instead': 'Não é possível cancelar uma conta já paga — use o estorno',
  'Cannot cancel a purchase order that has already been received': 'Não é possível cancelar um pedido de compra já recebido',
  'Cannot add items to a service order that has already been paid': 'Não é possível lançar itens numa ordem de serviço já paga',
  'Cannot add a new version to a quote that has already been converted into a service order': 'Não é possível criar versão de um orçamento já convertido em ordem de serviço',
  'Can only return items from a fully received purchase order': 'Só é possível devolver itens de um pedido de compra totalmente recebido',
  'Amount must be greater than zero': 'O valor deve ser maior que zero',
  'Failed to generate a unique quote number after multiple attempts': 'Não foi possível gerar o número do orçamento. Tente de novo',
  'Failed to generate a unique version number after multiple attempts': 'Não foi possível gerar o número da versão. Tente de novo',
  // campos obrigatórios / formato
  'branchId is required': 'Informe a filial',
  'Reason is required (minimum 3 characters)': 'Informe o motivo (mínimo de 3 caracteres)',
  'reason is required to disable a module (minimum 3 characters)': 'Informe o motivo para desativar o módulo (mínimo de 3 caracteres)',
  'Cancellation reason is required': 'Informe o motivo do cancelamento',
  'versionNumber must be a positive integer': 'Número da versão inválido',
  'refreshToken is required': 'Sessão inválida: faça login novamente',
  'items array is required': 'Informe os itens',
  'saleId and branchId are required': 'Informe a venda e a filial',
  'productId, fromBranchId, toBranchId, and quantity are required': 'Informe o produto, a filial de origem, a de destino e a quantidade',
  'paymentMethod is required': 'Informe a forma de pagamento',
  'movementType must be WITHDRAWAL or DEPOSIT': 'Tipo de movimento inválido: use retirada ou reforço',
  'motorcycleId and a non-empty items array are required': 'Informe a moto e pelo menos um item',
  'mechanicId is required': 'Informe o mecânico',
  'isEnabled (boolean) is required': 'Informe se o módulo fica ativo',
  'entryKilometer must be a number greater than or equal to zero': 'A quilometragem de entrada deve ser um número maior ou igual a zero',
  'cashRegisterId is required': 'Informe o caixa',
  'approved must be true or false': 'Informe se aprova ou recusa',
  'Password is required': 'Informe a senha',
  'Filename is required': 'Informe o arquivo',
  'Email (ou numericId) and password are required': 'Informe o e-mail (ou ID numérico) e a senha',
  'Email (ou numericId) and password must be text': 'O e-mail (ou ID numérico) e a senha devem ser texto',
  'MFA token and code are required': 'Informe o código de verificação',
  'MFA token and a valid method (sms|email) are required': 'Informe como receber o código (SMS ou e-mail)',
  'Authorizer MFA code is required': 'Informe o código de verificação do autorizador',
  // autenticação / MFA / autorização
  'Unauthorized': 'Não autenticado',
  'Forbidden': 'Acesso negado',
  'Verification failed': 'Não foi possível verificar',
  'Invalid Code': 'Código inválido',
  'Invalid code': 'Código incorreto. Confira o código do app autenticador e tente de novo',
  'Invalid code format': 'Formato de código inválido',
  'Invalid password': 'Senha incorreta',
  'Invalid or expired authorizer MFA code': 'Código do autorizador inválido ou expirado',
  'Authorizer MFA code already used': 'Código do autorizador já utilizado. Aguarde o próximo código do aplicativo.',
  'Invalid or expired MFA token': 'Verificação expirada: faça login novamente',
  'Invalid or already used backup code': 'Código de recuperação inválido ou já usado',
  'Invalid backup code format': 'Formato do código de recuperação inválido',
  'Invalid authorizer credentials': 'Credenciais do autorizador inválidas',
  'Invalid MFA method': 'Forma de verificação inválida',
  'Failed to send email': 'Não foi possível enviar o e-mail',
  'Failed to send SMS': 'Não foi possível enviar o SMS',
  'Failed to send code': 'Não foi possível enviar o código',
  'Failed to verify backup code': 'Não foi possível verificar o código de recuperação',
  'Failed to verify MFA code': 'Não foi possível verificar o código',
  'Failed to setup MFA': 'Não foi possível configurar a verificação em duas etapas',
  'Failed to disable MFA': 'Não foi possível desativar a verificação em duas etapas',
  'Failed to process logout': 'Não foi possível sair',
  // backup
  'Invalid backup filename': 'Nome de arquivo de backup inválido',
  'Invalid backup file path': 'Caminho de backup inválido',
  'Backup Failed': 'Falha no backup',
  'Restore Failed': 'Falha na restauração',
  'Delete Failed': 'Falha ao excluir',
  'Failed to create backup': 'Não foi possível criar o backup',
  'Failed to restore backup': 'Não foi possível restaurar o backup',
  'Failed to list backups': 'Não foi possível listar os backups',
  'Failed to get backup statistics': 'Não foi possível obter as estatísticas de backup',
  'Failed to delete backup': 'Não foi possível excluir o backup',
};

/** `subjectLabel` de verifyDualAuthorization (inglês, interno) → nome da operação para quem opera. */
const DUAL_AUTH_SUBJECT_PT: Record<string, string> = {
  withdrawal: 'retirada de caixa',
  'sale cancellation': 'cancelamento de venda',
  'sale return': 'devolução de venda',
  'sale discount': 'desconto',
  discount: 'desconto',
  'cash register force close': 'fechamento forçado do caixa',
};
const dualAuthSubject = (s: string) => DUAL_AUTH_SUBJECT_PT[s] ?? s;

/** Mensagens com valores variáveis (status, nomes, quantidades). */
export const PATTERN_MESSAGES: Array<[RegExp, (...groups: string[]) => string]> = [
  [/^The requesting user cannot authorize their own (.+)$/, (s) => `Quem solicita não pode autorizar a própria operação (${dualAuthSubject(s)}): outra pessoa precisa autorizar`],
  [/^Authorizer does not have permission to approve this (.+)$/, (s) => `O autorizador não tem perfil para aprovar esta operação (${dualAuthSubject(s)})`],
  [/^Sale item (.+) not found$/, (id) => `Item da venda ${id} não encontrado`],
  [/^Return quantity must be positive for item (.+)$/, (n) => `A quantidade devolvida deve ser positiva para o item ${n}`],
  [/^Purchase order must be CONFIRMED before receiving \(current: (.+)\)$/, (s) => `O pedido de compra precisa estar confirmado antes do recebimento (situação atual: ${s})`],
  [/^Product (.+) is inactive and cannot be sold$/, (n) => `O produto ${n} está inativo e não pode ser vendido`],
  [/^Product (.+) not found$/, (id) => `Produto ${id} não encontrado`],
  [/^Payment amount exceeds remaining balance\. Remaining: (.+)$/, (r) => `O valor passa do saldo a pagar. Saldo: ${r}`],
  [/^Item (.+) does not belong to this purchase order$/, (id) => `O item ${id} não faz parte deste pedido de compra`],
  [/^Insufficient stock at source branch\. Available: (.+)$/, (a) => `Estoque insuficiente na filial de origem. Disponível: ${a}`],
  [/^Discount exceeds the item total for product (.+)$/, (n) => `O desconto passa do total do item ${n}`],
  [/^Cannot transition from (.+) to (.+)$/, (a, b) => `Não é possível mudar a situação de ${a} para ${b}`],
  [/^Cannot set estimated delivery on a service order with status (.+)$/, (s) => `Não é possível definir a previsão de entrega com a ordem de serviço em ${s}`],
  [/^Cannot receive payment for an account with status (.+)$/, (s) => `Não é possível receber uma conta na situação ${s}`],
  [/^Cannot pay an account with status (.+)$/, (s) => `Não é possível pagar uma conta na situação ${s}`],
  [/^Cannot convert a quote with status (.+) — only APPROVED quotes can be converted$/, (s) => `Não é possível converter um orçamento na situação ${s} — só orçamentos aprovados`],
  [/^Cannot approve a purchase order with status (.+)$/, (s) => `Não é possível aprovar um pedido de compra na situação ${s}`],
  [/^Cannot add items to a service order with status (.+)$/, (s) => `Não é possível lançar itens com a ordem de serviço em ${s}`],
  [/^Branch (.+) not found in this company$/, () => 'Filial não encontrada nesta empresa'],
  [/^Appointment is (.+) and can no longer be changed$/, (s) => `O agendamento está ${s} e não pode mais ser alterado`],
  [/^(.+): value exceeds the supported limit$/, (l) => `${l}: valor acima do limite permitido`],
  [/^(.+): unitPrice must be a number greater than or equal to zero$/, (l) => `${l}: o preço unitário deve ser maior ou igual a zero`],
  [/^(.+): quantity must be a number greater than zero$/, (l) => `${l}: a quantidade deve ser maior que zero`],
  [/^(.+): itemType must be SERVICE or PART$/, (l) => `${l}: tipo de item inválido (serviço ou peça)`],
  [/^(.+): description is required$/, (l) => `${l}: informe a descrição`],
  [/^(.+) must be a valid date$/, (f) => `${f}: data inválida`],
];

export function translateMessage(text: string): string {
  const exact = EXACT_MESSAGES[text];
  if (exact) return exact;
  for (const [re, fn] of PATTERN_MESSAGES) {
    const m = re.exec(text);
    if (m) return fn(...m.slice(1));
  }
  return text;
}

/**
 * Erro cru do Prisma (várias rotas devolvem `error.message` direto): traz caminho de arquivo do servidor, trecho do
 * código e a consulta com ids — nunca deve chegar a quem opera.
 */
// Qualquer cliente (`prisma.`, `tx.` de transação, `database_1.prisma.` compilado…) + caminho de arquivo do servidor.
const INTERNAL_ERROR_RE =
  /Invalid `[\w$.]+\(\)` invocation|Invalid `prisma\.|\bPrisma\w*Error\b|[A-Za-z]:\\[^\s"']*\\(?:dist|src|node_modules)\\|\/[^\s"']*\/(?:dist|src|node_modules)\//;
export const INTERNAL_ERROR_MESSAGE = 'Não foi possível concluir a operação com os dados enviados. Confira os campos e tente de novo.';

/**
 * O texto do Prisma repete os argumentos da consulta (`data: { password: "…" }`). Antes de ir para o log, o valor de
 * toda chave sensível (mesma regra da auditoria) vira [REDACTED].
 */
const SENSITIVE_ARG = /((?:\w*(?:pass(?:word)?|secret|token|credential|authorization|cookie|api_?key|private_?key|cvv|mfa_?code|otp)\w*)"?\s*[:=]\s*)("(?:[^"\\]|\\.)*"|'[^']*'|[^\s,}]+)/gi;
export function maskSensitiveValues(text: string): string {
  return text.replace(SENSITIVE_ARG, '$1"[REDACTED]"');
}

const ZOD_DEFAULT_EN =/^(Expected |Required$|Number must|String must|Array must|Invalid |Unrecognized key)/;

function zodIssue(issue: any): string {
  const field = Array.isArray(issue.path) && issue.path.length ? issue.path.join('.') : 'dados';
  // Mensagem própria do schema (já em português) é mantida; só as padrão da biblioteca, em inglês, são reescritas.
  if (typeof issue.message === 'string' && !ZOD_DEFAULT_EN.test(issue.message)) return `${field}: ${issue.message}`;
  const bound = (b: unknown, inclusive: boolean, dir: 'min' | 'max') =>
    issue.type === 'string'
      ? `${dir === 'min' ? 'mínimo' : 'máximo'} de ${b} caracteres`
      : issue.type === 'array'
        ? `${dir === 'min' ? 'mínimo' : 'máximo'} de ${b} itens`
        : `deve ser ${dir === 'min' ? (inclusive ? 'no mínimo' : 'maior que') : inclusive ? 'no máximo' : 'menor que'} ${b}`;
  switch (issue.code) {
    case 'invalid_type':
      return issue.received === 'undefined' ? `${field}: obrigatório` : `${field}: valor inválido`;
    case 'too_small':
      return `${field}: ${bound(issue.minimum, issue.inclusive !== false, 'min')}`;
    case 'too_big':
      return `${field}: ${bound(issue.maximum, issue.inclusive !== false, 'max')}`;
    case 'invalid_enum_value':
      return `${field}: opção inválida`;
    case 'invalid_string':
      return `${field}: formato inválido`;
    default:
      return `${field}: valor inválido`;
  }
}

/** Lista de problemas do Zod serializada como texto (rotas que fazem `error.message` de um ZodError) → português. */
function zodText(text: string): string | null {
  if (!text.trimStart().startsWith('[')) return null;
  try {
    const issues = JSON.parse(text);
    if (!Array.isArray(issues) || issues.length === 0 || !issues.every((i) => i && typeof i === 'object' && 'code' in i && 'path' in i)) return null;
    return issues.map(zodIssue).join('; ');
  } catch {
    return null;
  }
}

/** Mensagens padrão (inglês) do Zod → português. */
const ZOD_DEFAULT_PT: Array<[RegExp, (...g: string[]) => string]> = [
  [/^Required$/, () => 'obrigatório'],
  [/^Expected \w+, received undefined$/, () => 'obrigatório'],
  [/^Expected .+, received .+$/, () => 'valor inválido'],
  [/^String must contain at least (\d+) character/, (n) => `mínimo de ${n} caracteres`],
  [/^String must contain at most (\d+) character/, (n) => `máximo de ${n} caracteres`],
  [/^String must contain exactly (\d+) character/, (n) => `deve ter ${n} caracteres`],
  [/^Number must be greater than or equal to (\S+)$/, (n) => `deve ser no mínimo ${n}`],
  [/^Number must be greater than (\S+)$/, (n) => `deve ser maior que ${n}`],
  [/^Number must be less than or equal to (\S+)$/, (n) => `deve ser no máximo ${n}`],
  [/^Number must be less than (\S+)$/, (n) => `deve ser menor que ${n}`],
  [/^Array must contain at least (\d+) element/, (n) => `mínimo de ${n} itens`],
  [/^Array must contain at most (\d+) element/, (n) => `máximo de ${n} itens`],
  [/^Invalid enum value/, () => 'opção inválida'],
  [/^Invalid email$/, () => 'e-mail inválido'],
  [/^Invalid uuid$/, () => 'identificador inválido'],
  [/^Invalid datetime$/, () => 'data/hora inválida'],
  [/^Unrecognized key/, () => 'campo não reconhecido'],
  [/^Invalid /, () => 'valor inválido'],
];

/**
 * Problemas do Zod já formatados pela rota como "campo: mensagem; campo: mensagem" (routeErrorMessage e similares):
 * só os trechos com a mensagem padrão em inglês são traduzidos; o resto fica como está.
 */
function zodLines(text: string): string | null {
  let changed = false;
  const parts = text.split('; ').map((part) => {
    const m = /^([\w.[\]]+): (.+)$/.exec(part);
    if (!m) return part;
    for (const [re, fn] of ZOD_DEFAULT_PT) {
      const g = re.exec(m[2]);
      if (g) {
        changed = true;
        return `${m[1]}: ${fn(...g.slice(1))}`;
      }
    }
    return part;
  });
  return changed ? parts.join('; ') : null;
}

function forOperator(text: string, req: Request): string {
  if (INTERNAL_ERROR_RE.test(text)) {
    // O detalhe fica no log do servidor (com o id da requisição), não na resposta.
    Logger.warn('Erro interno devolvido por rota — ocultado da resposta', { requestId: (req as any).requestId, path: req.originalUrl, detail: maskSensitiveValues(text).slice(0, 2000) });
    return INTERNAL_ERROR_MESSAGE;
  }
  return zodText(text) ?? zodLines(text) ?? translateMessage(text);
}

/**
 * Banco fora do ar (caos controlado: Postgres parado com a API no ar). Cada rota devolvia o que tinha no catch: 400
 * "confira os campos", 401 "não autenticado" no login, 500 genérico — como se o erro fosse de quem opera. Qualquer
 * resposta de erro cujo texto mostre o banco inacessível vira 503 com mensagem honesta e Retry-After.
 */
const DB_UNAVAILABLE_RE =
  /Can't reach database server|Server has closed the connection|Connection terminated|ECONNREFUSED|Timed out fetching a new connection|Unable to start a transaction in the given time|Transaction already closed|expired transaction|Transaction API error|the database system is (starting up|shutting down|in recovery mode)|PrismaClientInitializationError|\bP10(01|02|17)\b/;
export const DATABASE_UNAVAILABLE_MESSAGE = 'Banco de dados indisponível no momento. Tente de novo em instantes.';

export function translateErrors(req: Request, res: Response, next: NextFunction) {
  const json = res.json.bind(res);
  res.json = ((body: any) => {
    if (res.statusCode >= 400 && body && typeof body === 'object' && !Array.isArray(body)) {
      const texts = [body.error, body.message, body.details].filter((t): t is string => typeof t === 'string');
      if (texts.some((t) => DB_UNAVAILABLE_RE.test(t))) {
        const technical = texts.find((t) => DB_UNAVAILABLE_RE.test(t)) ?? '';
        Logger.warn('Banco de dados indisponível — resposta 503', { requestId: (req as any).requestId, path: req.originalUrl, detail: maskSensitiveValues(technical).slice(0, 1000) });
        res.status(503).setHeader('Retry-After', '5');
        // Mantém os demais campos (ex.: `status` do /health/ready); some só o texto técnico.
        const { error: _e, message: _m, details: _d, stack: _s, statusCode: _c, ...rest } = body;
        return json({ ...rest, error: DATABASE_UNAVAILABLE_MESSAGE, code: 'DATABASE_UNAVAILABLE' });
      }
      const out = { ...body };
      if (typeof out.error === 'string') out.error = forOperator(out.error, req);
      if (typeof out.message === 'string') out.message = forOperator(out.message, req);
      // `details` (ex.: errorHandler em desenvolvimento devolve err.message) também não pode levar erro interno.
      if (typeof out.details === 'string' && INTERNAL_ERROR_RE.test(out.details)) out.details = forOperator(out.details, req);
      return json(out);
    }
    return json(body);
  }) as typeof res.json;
  next();
}
