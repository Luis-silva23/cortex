import { Router } from 'express';
import healthRoutes from './health.routes';
import authRoutes from './auth.routes';
import mfaRoutes from './mfa.routes';
import companyRoutes from './company.routes';
import branchRoutes from './branch.routes';
import licenseRoutes from './license.routes';
import activationRoutes from './activation.routes';
import deviceEnrollmentRoutes from './device-enrollment.routes';
import userRoutes from './user.routes';
import rolesRoutes from './roles.routes';
import permissionsRoutes from './permissions.routes';
import customersRoutes from './customers.routes';
import privacyRoutes from './privacy.routes';
import productsRoutes from './products.routes';
import categoriesRoutes from './categories.routes';
import stockRoutes from './stock.routes';
import inventoryRoutes from './inventory.routes';
import damageRoutes from './damage.routes';
import discountRulesRoutes from './discount-rules.routes';
import partnersRoutes from './partners.routes';
import installmentPoliciesRoutes from './installment-policies.routes';
import transfersRoutes from './transfers.routes';
import mechanicsRoutes from './mechanics.routes';
import commissionRulesRoutes from './commission-rules.routes';
import salesRoutes from './sales.routes';
import paymentsRoutes from './payments.routes';
import cashRegisterRoutes from './cash-register.routes';
import importRoutes from './import.routes';
import backupRoutes from './backup.routes';
import motorcyclesRoutes from './motorcycles.routes';
import serviceOrdersRoutes from './service-orders.routes';
import suppliersRoutes from './suppliers.routes';
import purchaseOrdersRoutes from './purchase-orders.routes';
import quotesRoutes from './quotes.routes';
import financialRoutes from './financial.routes';
import fiscalRoutes from './fiscal.routes';
import dashboardRoutes from './dashboard.routes';
import salesChannelsRoutes from './sales-channels.routes'; // canais de venda (módulo CANAIS, nasce desativado)
import observabilityRoutes from './observability.routes';
import auditLogsRoutes from './audit-logs.routes';
import revisionsRoutes from './revisions.routes';
import followUpsRoutes from './follow-ups.routes';
import appointmentsRoutes from './appointments.routes';
import moduleSettingsRoutes from './module-settings.routes';
import paymentSettingsRoutes from './payment-settings.routes';
import telemetryRoutes from './telemetry.routes';
import monitoringRoutes from './monitoring.routes';
import monitoringCentralRoutes from './monitoring-central.routes';
// Políticas por empresa/filial e domínios de 2026-09-27 (docs/CORTEX/POLICIES.md)
import policiesRoutes from './policies.routes';
import businessHoursRoutes from './business-hours.routes';
import companyProfileRoutes from './company-profile.routes';
// [imports de domínio 2026-09-27 — cada área acrescenta a sua linha abaixo]
import { supportRoutes, supportKbRoutes, supportAdminRoutes } from './support.routes'; // Central de Ajuda e Suporte (docs/CORTEX/SUPPORT.md)
import serviceOrderDiscountRoutes from './service-order-discount.routes'; // desconto de OS (agente desconto/caixa/fiscal)
import discountEventsRoutes from './discount-events.routes'; // consulta de descontos concedidos
import warrantiesRoutes from './warranties.routes'; // garantia de OS e ocorrências (agente garantia/cliente)
import employeeAgreementsRoutes from './employee-agreements.routes'; // convênio de funcionário (agente convênios)
import agreementCompaniesRoutes from './agreement-companies.routes'; // convênio com empresa externa (agente convênios)
import receivablesRoutes from './receivables.routes'; // detalhe de conta a receber + cobrança manual (agente convênios)
import supplierReturnsRoutes from './supplier-returns.routes'; // devolução ao fornecedor (não é garantia ao cliente)
import { requestContext } from '../middleware/requestContext';
import { rejectInvalidDateQuery } from '../middleware/dateQuery';
import { translateErrors } from '../middleware/translate-errors';
import { companyScoped } from '../middleware/tenant';

const router = Router();

// Request ID + métrica assíncrona de toda requisição — precisa vir antes de
// qualquer rota para que req.requestId exista em todo o pipeline, mas a
// métrica só é enfileirada no fechamento da resposta (res.on('finish')),
// quando req.route já está populado com o padrão da rota.
router.use(requestContext);

// Mensagens de erro em português para quem opera (tradução na saída; ver middleware/translate-errors.ts).
router.use(translateErrors);

// startDate/endDate inválidos → 400 (antes 500 em 13 rotas; ver middleware/dateQuery.ts).
router.use(rejectInvalidDateQuery);

// Health check
router.use('/health', healthRoutes);

// Rotas de autenticação (público)
router.use('/auth', authRoutes);
// MFA usa authMiddleware internamente rota a rota (não é público, mas
// também não deveria ficar sob o mesmo prefixo de auth)
router.use('/mfa', mfaRoutes);

// Rotas Super Admin
router.use('/companies', companyRoutes);
router.use('/branches', branchRoutes);
router.use('/licenses', licenseRoutes);
router.use('/activations', activationRoutes);
// Entrada de equipamento novo (PÚBLICO e restrito: enrolar e consultar o próprio estado; nenhum dado de empresa antes da autorização)
router.use('/device', deviceEnrollmentRoutes);
router.use('/backup', backupRoutes);

// Rotas da aplicação (requer autenticação + tenant).
// As que operam dados de UMA empresa levam `companyScoped()`: o SUPER_ADMIN (JWT sem
// empresa) precisa informar o alvo (?companyId= / X-Company-Id) — ver middleware/tenant.ts.
// Rotas sem a marca são de plataforma ou tratam o alvo explicitamente.
router.use('/users', userRoutes);
router.use('/roles', rolesRoutes);
router.use('/permissions', permissionsRoutes);
router.use('/customers', companyScoped(), customersRoutes);
router.use('/privacy', companyScoped(), privacyRoutes); // pedidos de titular (LGPD, decisão 120): só COMPANY_ADMIN da empresa
router.use('/products', companyScoped(), productsRoutes);
// ACHADO DE AUDITORIA DE INTEGRAÇÃO: o client do admin-web já chamava
// GET/POST /categories há tempos (api.getCategories()/createCategory()),
// mas esta rota nunca foi montada — toda chamada real 404ava, engolida
// silenciosamente pelo catch das telas de criar/editar produto (o <select>
// de categoria ficava sempre vazio). Ver comentário em category.service.ts.
router.use('/categories', companyScoped(), categoriesRoutes);
router.use('/stock', companyScoped(), stockRoutes);
router.use('/inventory', companyScoped(), inventoryRoutes);
router.use('/damage', companyScoped(), damageRoutes);
router.use('/discount-rules', companyScoped(), discountRulesRoutes);
router.use('/partners', companyScoped(), partnersRoutes);
router.use('/installment-policies', companyScoped(), installmentPoliciesRoutes);
router.use('/transfers', companyScoped(), transfersRoutes);
router.use('/mechanics', companyScoped(), mechanicsRoutes);
router.use('/commission-rules', companyScoped(), commissionRulesRoutes);
router.use('/sales', companyScoped(), salesRoutes);
router.use('/payments', companyScoped(), paymentsRoutes);
router.use('/cash-register', companyScoped(), cashRegisterRoutes);
router.use('/import', companyScoped(), importRoutes);
router.use('/motorcycles', companyScoped(), motorcyclesRoutes);
router.use('/service-orders', companyScoped(), serviceOrdersRoutes);
router.use('/suppliers', companyScoped(), suppliersRoutes);
router.use('/purchase-orders', companyScoped(), purchaseOrdersRoutes);
router.use('/quotes', companyScoped(), quotesRoutes);
router.use('/financial', companyScoped(), financialRoutes);
router.use('/fiscal', companyScoped(), fiscalRoutes);
router.use('/dashboard', companyScoped({ except: ['/super-admin'] }), dashboardRoutes);
router.use('/sales-channels', companyScoped(), salesChannelsRoutes);
router.use('/observability', observabilityRoutes);
router.use('/audit-logs', auditLogsRoutes);

// Revisões / Pós-venda / Agenda (domínio novo, 2026-09-14)
router.use('/revisions', companyScoped(), revisionsRoutes);
router.use('/follow-ups', companyScoped(), followUpsRoutes);
router.use('/appointments', companyScoped(), appointmentsRoutes);

// Ativação/desativação de módulos por empresa/filial (2026-09-15) — não é
// gated por requireModuleEnabled (óbvio: a tela que liga/desliga módulos
// não pode ficar presa atrás de um módulo).
router.use('/module-settings', moduleSettingsRoutes);
router.use('/payment-settings', paymentSettingsRoutes);
router.use('/telemetry', telemetryRoutes);
// Central de Monitoramento (Super Admin): montada ANTES de /monitoring para o prefixo /monitoring/central ser dela (todas as rotas exigem SUPER_ADMIN).
router.use('/monitoring/central', monitoringCentralRoutes);
router.use('/monitoring', monitoringRoutes);

// Políticas por empresa/filial (empresa define o padrão; filial sobrescreve só o que o catálogo permite)
router.use('/policies', companyScoped(), policiesRoutes);
router.use('/business-hours', companyScoped(), businessHoursRoutes);
router.use('/company-profile', companyScoped(), companyProfileRoutes);
// [montagens de domínio 2026-09-27 — cada área acrescenta a sua linha abaixo]
// Suporte: empresa/filial/usuário do token (Super Admin é recusado em /support e atende em /support-admin, que exige
// requireSuperAdmin); /support-kb é leitura para todos os logados.
router.use('/support', supportRoutes);
router.use('/support-kb', supportKbRoutes);
router.use('/support-admin', supportAdminRoutes);
router.use('/service-orders', companyScoped(), serviceOrderDiscountRoutes); // só /:id/discount (demais rotas da OS acima)
router.use('/discount-events', companyScoped(), discountEventsRoutes);
router.use('/warranties', companyScoped(), warrantiesRoutes);
router.use('/employee-agreements', companyScoped(), employeeAgreementsRoutes);
router.use('/agreement-companies', companyScoped(), agreementCompaniesRoutes);
router.use('/receivables', companyScoped(), receivablesRoutes);
router.use('/supplier-returns', companyScoped(), supplierReturnsRoutes);

export default router;
