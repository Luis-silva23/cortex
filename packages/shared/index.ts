export * from './types';

export class AppError extends Error {
  public statusCode: number;
  public code: string;
  public isOperational: boolean;

  constructor(message: string, statusCode: number, code?: string) {
    super(message);
    this.statusCode = statusCode;
    this.code = code ?? 'INTERNAL_ERROR';
    this.isOperational = true;
    this.name = 'AppError';

    // TS-compiled classes extending the built-in `Error` lose correct
    // `instanceof` behavior on some targets/module setups unless the
    // prototype chain is fixed up explicitly. apps/api/src/middleware/errorHandler.ts
    // relies on `err instanceof AppError`, so this must be correct.
    Object.setPrototypeOf(this, AppError.prototype);
  }

  toJSON(): { message: string; code: string; statusCode: number } {
    return {
      message: this.message,
      code: this.code,
      statusCode: this.statusCode,
    };
  }
}

export class AuthorizationError extends AppError {
  constructor(message: string, code?: string) {
    super(message, 403, code ?? 'FORBIDDEN');
    this.name = 'AuthorizationError';
    Object.setPrototypeOf(this, AuthorizationError.prototype);
  }
}

export class ConflictError extends AppError {
  constructor(message: string, code?: string) {
    super(message, 409, code ?? 'CONFLICT');
    this.name = 'ConflictError';
    Object.setPrototypeOf(this, ConflictError.prototype);
  }
}

export function isOperationalError(err: unknown): boolean {
  return err instanceof AppError && err.isOperational === true;
}

export function formatCurrency(value: number): string {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(value);
}

export function formatDate(date: Date): string {
  return date.toLocaleDateString('pt-BR');
}
