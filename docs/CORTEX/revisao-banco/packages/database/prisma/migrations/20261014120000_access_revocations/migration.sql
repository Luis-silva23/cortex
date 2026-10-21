-- Revogação durável de access token (decisão 107, 2026-10-14). ADITIVA: tabela nova, nada existente é alterado.
--  * O Redis segue como caminho rápido da checagem; esta tabela é a fonte de verdade quando o Redis cai (a API passa a consultar aqui
--    em vez de aceitar um token revogado) e a origem da ressincronização do Redis quando ele volta.
--  * kind = TOKEN (subject = sha256 do access token) | USER | COMPANY (subject = id; revokedAt = "tudo emitido até aqui está revogado").
--  * Só a plataforma (SUPER_ADMIN no contexto RLS) lê e grava: o middleware de autenticação roda antes de existir contexto de empresa.
-- ROLLBACK (a API volta a depender só do Redis; sem dado de negócio aqui):
--   DROP TABLE "access_revocations";

CREATE TABLE "access_revocations" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "revokedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "access_revocations_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "access_revocations_kind_valid" CHECK ("kind" IN ('TOKEN', 'USER', 'COMPANY'))
);

CREATE UNIQUE INDEX "access_revocations_kind_subject_key" ON "access_revocations"("kind", "subject");
CREATE INDEX "access_revocations_expiresAt_idx" ON "access_revocations"("expiresAt");

ALTER TABLE public."access_revocations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."access_revocations" FORCE ROW LEVEL SECURITY;
CREATE POLICY "access_revocations_platform" ON public."access_revocations"
  FOR ALL USING (public.is_super_admin()) WITH CHECK (public.is_super_admin());
