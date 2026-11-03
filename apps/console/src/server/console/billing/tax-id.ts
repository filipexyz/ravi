// CPF and CNPJ checks for billing details. Stored as digits only.

export type TaxIdKind = "cpf" | "cnpj";

export function normalizeTaxId(value: string): string {
  return value.replace(/\D/g, "");
}

export function taxIdKind(value: string): TaxIdKind | null {
  const digits = normalizeTaxId(value);
  if (digits.length === 11 && isValidCpf(digits)) return "cpf";
  if (digits.length === 14 && isValidCnpj(digits)) return "cnpj";
  return null;
}

export function formatTaxId(value: string): string {
  const digits = normalizeTaxId(value);
  if (digits.length === 11) return digits.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, "$1.$2.$3-$4");
  if (digits.length === 14) return digits.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, "$1.$2.$3/$4-$5");
  return digits;
}

function allSame(digits: string) {
  return /^(\d)\1+$/.test(digits);
}

function isValidCpf(digits: string): boolean {
  if (allSame(digits)) return false;
  const numbers = [...digits].map(Number);
  for (const length of [9, 10]) {
    let sum = 0;
    for (let index = 0; index < length; index += 1) sum += numbers[index]! * (length + 1 - index);
    const check = ((sum * 10) % 11) % 10;
    if (check !== numbers[length]) return false;
  }
  return true;
}

function isValidCnpj(digits: string): boolean {
  if (allSame(digits)) return false;
  const numbers = [...digits].map(Number);
  const weights = [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
  for (const length of [12, 13]) {
    let sum = 0;
    const offset = 13 - length;
    for (let index = 0; index < length; index += 1) sum += numbers[index]! * weights[index + offset]!;
    const remainder = sum % 11;
    const check = remainder < 2 ? 0 : 11 - remainder;
    if (check !== numbers[length]) return false;
  }
  return true;
}
