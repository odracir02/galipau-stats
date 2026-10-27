// Tipos del script de alta del primer superadministrador (para las pruebas).
export const ENROLLMENT_MINUTES: number;
export function generateCode(length?: number): string;
export function enrollmentHash(code: string, pepper: string): string;
export function buildBootstrapSql(args: {
  identityId: string;
  displayName: string;
  code: string;
  pepper: string;
  now?: Date;
}): string;
