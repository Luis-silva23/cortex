// User.email is @unique in Postgres but case-sensitive by default, and
// login forms don't lowercase input — this exists so "Joao@Empresa.com"
// and "joao@empresa.com" collide correctly.
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}
