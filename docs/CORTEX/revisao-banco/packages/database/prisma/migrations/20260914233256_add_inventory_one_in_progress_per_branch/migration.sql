-- Achado de auditoria de integração: nada impedia dois inventários
-- IN_PROGRESS simultâneos na mesma filial (mesma classe do problema já
-- resolvido para CashRegister via índice único parcial). Sem isto, dois
-- inventários abertos ao mesmo tempo capturariam o mesmo systemQuantity
-- desatualizado e, no fechamento, o segundo sobrescreveria silenciosamente
-- a correção do primeiro.
CREATE UNIQUE INDEX inventories_one_in_progress_per_branch ON public.inventories USING btree ("branchId") WHERE (status = 'IN_PROGRESS'::public."InventoryStatus");
