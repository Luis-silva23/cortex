-- RLS for the Revisões / Pós-venda / Agenda domain (revisions, follow_ups,
-- follow_up_events, appointments, appointment_events). Same pattern as the
-- rest of the schema: tenant-scoped tables (own companyId/branchId) use
-- rls_company_branch_match, which already treats a NULL branchId as
-- "company-wide" (see 0_init/migration.sql). Event tables (no companyId of
-- their own) isolate via a join to their parent, matching
-- service_order_status_history_isolation — the parent's own RLS filters
-- the subquery, so this only works because the connecting role never
-- bypasses RLS (verified live this session: FORCE ROW LEVEL SECURITY +
-- non-superuser role).

ALTER TABLE public.revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.revisions FORCE ROW LEVEL SECURITY;

CREATE POLICY revisions_isolation ON public.revisions
  USING (public.rls_company_branch_match("companyId", "branchId"))
  WITH CHECK (public.rls_company_branch_match("companyId", "branchId"));

ALTER TABLE public.follow_ups ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.follow_ups FORCE ROW LEVEL SECURITY;

CREATE POLICY follow_ups_isolation ON public.follow_ups
  USING (public.rls_company_branch_match("companyId", "branchId"))
  WITH CHECK (public.rls_company_branch_match("companyId", "branchId"));

ALTER TABLE public.follow_up_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.follow_up_events FORCE ROW LEVEL SECURITY;

CREATE POLICY follow_up_events_isolation ON public.follow_up_events
  USING (("followUpId" IN (SELECT follow_ups.id FROM public.follow_ups)))
  WITH CHECK (("followUpId" IN (SELECT follow_ups.id FROM public.follow_ups)));

ALTER TABLE public.appointments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.appointments FORCE ROW LEVEL SECURITY;

CREATE POLICY appointments_isolation ON public.appointments
  USING (public.rls_company_branch_match("companyId", "branchId"))
  WITH CHECK (public.rls_company_branch_match("companyId", "branchId"));

ALTER TABLE public.appointment_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.appointment_events FORCE ROW LEVEL SECURITY;

CREATE POLICY appointment_events_isolation ON public.appointment_events
  USING (("appointmentId" IN (SELECT appointments.id FROM public.appointments)))
  WITH CHECK (("appointmentId" IN (SELECT appointments.id FROM public.appointments)));
