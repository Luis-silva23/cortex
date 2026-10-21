import { z } from 'zod';

// Thin wrapper — intentionally lets ZodError propagate unmodified.
// apps/api/src/middleware/errorHandler.ts catches plain ZodError instances,
// not a wrapped/custom type.
export function validateData<T>(schema: z.ZodSchema<T>, data: unknown): T {
  return schema.parse(data);
}

function onlyDigits(value: string): string {
  return value.replace(/\D/g, '');
}

function isAllSameDigit(value: string): boolean {
  return /^(\d)\1*$/.test(value);
}

// Standard Receita Federal CPF check-digit algorithm. Accepts masked
// (111.444.777-35) or unmasked (11144477735) input.
export function isValidCPF(doc: string): boolean {
  const cpf = onlyDigits(doc);

  if (cpf.length !== 11 || isAllSameDigit(cpf)) {
    return false;
  }

  const digits = cpf.split('').map((d) => parseInt(d, 10));

  let sum = 0;
  for (let i = 0; i < 9; i++) {
    sum += digits[i] * (10 - i);
  }
  let checkDigit1 = (sum * 10) % 11;
  if (checkDigit1 === 10) checkDigit1 = 0;
  if (checkDigit1 !== digits[9]) {
    return false;
  }

  sum = 0;
  for (let i = 0; i < 10; i++) {
    sum += digits[i] * (11 - i);
  }
  let checkDigit2 = (sum * 10) % 11;
  if (checkDigit2 === 10) checkDigit2 = 0;
  if (checkDigit2 !== digits[10]) {
    return false;
  }

  return true;
}

// Standard CNPJ weighted check-digit algorithm. Accepts masked
// (11.222.333/0001-81) or unmasked (11222333000181) input.
export function isValidCNPJ(doc: string): boolean {
  const cnpj = onlyDigits(doc);

  if (cnpj.length !== 14 || isAllSameDigit(cnpj)) {
    return false;
  }

  const digits = cnpj.split('').map((d) => parseInt(d, 10));

  const weights1 = [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
  let sum = 0;
  for (let i = 0; i < 12; i++) {
    sum += digits[i] * weights1[i];
  }
  let checkDigit1 = sum % 11;
  checkDigit1 = checkDigit1 < 2 ? 0 : 11 - checkDigit1;
  if (checkDigit1 !== digits[12]) {
    return false;
  }

  const weights2 = [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
  sum = 0;
  for (let i = 0; i < 13; i++) {
    sum += digits[i] * weights2[i];
  }
  let checkDigit2 = sum % 11;
  checkDigit2 = checkDigit2 < 2 ? 0 : 11 - checkDigit2;
  if (checkDigit2 !== digits[13]) {
    return false;
  }

  return true;
}

export function isValidDocument(doc: string): boolean {
  const digits = onlyDigits(doc);

  if (digits.length === 11) {
    return isValidCPF(digits);
  }
  if (digits.length === 14) {
    return isValidCNPJ(digits);
  }
  return false;
}
