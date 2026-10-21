-- A política de users deixava QUALQUER contexto de empresa ler as linhas dos usuários da plataforma (companyId nulo:
-- Super Admins) — hash de senha e segredo de MFA (cifrado) incluídos — pela cláusula `OR "companyId" IS NULL`.
-- O login não depende dela (busca o usuário em contexto SUPER_ADMIN). Leitura agora: Super Admin, ou a própria empresa.
ALTER POLICY users_isolation ON public.users
  USING (public.is_super_admin() OR ("companyId" = public.get_current_company_id()));
