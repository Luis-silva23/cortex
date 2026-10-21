-- LN System — baseline schema migration.
--
-- This is a single consolidated "0_init" migration standing in for the
-- real (lost) migration history. It recreates the production schema
-- exactly as extracted from a pg_dump of the live database: enums,
-- tables, constraints (PK/UNIQUE/FK), indexes, the RLS helper functions,
-- RLS enablement, and RLS policies — in that dependency order.
--
-- _prisma_migrations is intentionally NOT created here: Prisma's
-- migration engine manages that table itself.

-- ============================================================================
-- ENUMS
-- ============================================================================

CREATE TYPE public."AccountStatus" AS ENUM (
    'PENDING',
    'PAID',
    'OVERDUE',
    'CANCELLED'
);

CREATE TYPE public."ActivationStatus" AS ENUM (
    'PENDING',
    'APPROVED',
    'REJECTED'
);

CREATE TYPE public."AuditAction" AS ENUM (
    'CREATE',
    'READ',
    'UPDATE',
    'DELETE',
    'LOGIN',
    'LOGOUT',
    'LOGIN_FAILED',
    'PASSWORD_RESET',
    'PERMISSION_CHANGED',
    'LICENSE_APPROVED',
    'LICENSE_SUSPENDED',
    'DEVICE_ACTIVATED',
    'DEVICE_BLOCKED'
);

CREATE TYPE public."CashMovementType" AS ENUM (
    'OPENING',
    'SALE',
    'WITHDRAWAL',
    'DEPOSIT',
    'CLOSING',
    'CANCELLATION',
    'RETURN'
);

CREATE TYPE public."CashRegisterStatus" AS ENUM (
    'OPEN',
    'CLOSED'
);

CREATE TYPE public."ChecklistItemStatus" AS ENUM (
    'OK',
    'DAMAGED',
    'NOT_CHECKED'
);

CREATE TYPE public."CustomerType" AS ENUM (
    'INDIVIDUAL',
    'BUSINESS'
);

CREATE TYPE public."DamageReason" AS ENUM (
    'EXPIRED',
    'DAMAGED',
    'LOST',
    'THEFT',
    'DEFECTIVE',
    'OTHER'
);

CREATE TYPE public."DeviceSessionStatus" AS ENUM (
    'ACTIVE',
    'ENDED',
    'FORCE_ENDED'
);

CREATE TYPE public."DeviceStatus" AS ENUM (
    'PENDING',
    'ACTIVE',
    'BLOCKED',
    'REVOKED'
);

CREATE TYPE public."DeviceType" AS ENUM (
    'DESKTOP',
    'TABLET',
    'MOBILE',
    'POS'
);

CREATE TYPE public."DiscountType" AS ENUM (
    'PERCENTAGE',
    'FIXED'
);

CREATE TYPE public."FiscalDocumentStatus" AS ENUM (
    'DRAFT',
    'PENDING',
    'AUTHORIZED',
    'REJECTED',
    'CANCELLED',
    'CONTINGENCY'
);

CREATE TYPE public."FiscalDocumentType" AS ENUM (
    'NFCE',
    'NFE'
);

CREATE TYPE public."IdempotencyStatus" AS ENUM (
    'PENDING',
    'COMPLETED',
    'FAILED'
);

CREATE TYPE public."InventoryStatus" AS ENUM (
    'DRAFT',
    'IN_PROGRESS',
    'COMPLETED',
    'CANCELLED'
);

CREATE TYPE public."LicenseStatus" AS ENUM (
    'PENDING_APPROVAL',
    'ACTIVE',
    'SUSPENDED',
    'EXPIRED',
    'CANCELLED'
);

CREATE TYPE public."LicenseType" AS ENUM (
    'TRIAL',
    'BASIC',
    'PROFESSIONAL',
    'ENTERPRISE'
);

CREATE TYPE public."MovementType" AS ENUM (
    'PURCHASE',
    'SALE',
    'RETURN',
    'ADJUSTMENT',
    'TRANSFER_OUT',
    'TRANSFER_IN',
    'PRODUCTION',
    'LOSS',
    'INVENTORY'
);

CREATE TYPE public."PartnerDiscountType" AS ENUM (
    'PERCENTAGE',
    'FIXED'
);

CREATE TYPE public."PaymentMethod" AS ENUM (
    'CASH',
    'DEBIT_CARD',
    'CREDIT_CARD',
    'PIX',
    'BANK_TRANSFER',
    'CHECK',
    'VOUCHER',
    'OTHER'
);

CREATE TYPE public."PaymentStatus" AS ENUM (
    'PENDING',
    'APPROVED',
    'REJECTED',
    'CANCELLED',
    'REFUNDED'
);

CREATE TYPE public."PermissionScope" AS ENUM (
    'GLOBAL',
    'BRANCH',
    'OWN'
);

CREATE TYPE public."ProductType" AS ENUM (
    'PRODUCT',
    'SERVICE',
    'COMBO'
);

CREATE TYPE public."PurchaseOrderStatus" AS ENUM (
    'DRAFT',
    'SENT',
    'CONFIRMED',
    'RECEIVED',
    'CANCELLED'
);

CREATE TYPE public."QuoteStatus" AS ENUM (
    'DRAFT',
    'SENT',
    'APPROVED',
    'REJECTED',
    'EXPIRED',
    'CONVERTED'
);

CREATE TYPE public."SaleStatus" AS ENUM (
    'PENDING',
    'PAID',
    'PARTIALLY_PAID',
    'CANCELLED',
    'RETURNED'
);

CREATE TYPE public."ServiceOrderItemType" AS ENUM (
    'SERVICE',
    'PART'
);

CREATE TYPE public."ServiceOrderStatus" AS ENUM (
    'ENTRADA',
    'DIAGNOSTICO',
    'ORCAMENTO',
    'APROVACAO',
    'EXECUCAO',
    'PRONTO',
    'ENTREGA',
    'ENCERRADA',
    'CANCELADA'
);

CREATE TYPE public."TEFPaymentStatus" AS ENUM (
    'PENDING',
    'APPROVED',
    'REJECTED',
    'UNKNOWN',
    'CANCELLED',
    'REFUNDED'
);

CREATE TYPE public."TransferStatus" AS ENUM (
    'PENDING',
    'IN_TRANSIT',
    'RECEIVED',
    'CANCELLED'
);

CREATE TYPE public."UserType" AS ENUM (
    'SUPER_ADMIN',
    'COMPANY_ADMIN',
    'MANAGER',
    'OPERATOR',
    'MECHANIC',
    'VIEWER'
);

CREATE TYPE public."VehicleType" AS ENUM (
    'MOTORCYCLE',
    'CAR'
);

-- ============================================================================
-- TABLES
-- ============================================================================

CREATE TABLE public.accounts_payable (
    id text NOT NULL,
    "companyId" text NOT NULL,
    "branchId" text,
    "supplierId" text,
    description text NOT NULL,
    amount numeric(10,2) NOT NULL,
    "dueDate" timestamp(3) without time zone NOT NULL,
    "paidDate" timestamp(3) without time zone,
    status public."AccountStatus" DEFAULT 'PENDING'::public."AccountStatus" NOT NULL,
    "referenceType" text,
    "referenceId" text,
    notes text,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL
);

CREATE TABLE public.accounts_receivable (
    id text NOT NULL,
    "companyId" text NOT NULL,
    "branchId" text,
    "customerId" text,
    description text NOT NULL,
    amount numeric(10,2) NOT NULL,
    "dueDate" timestamp(3) without time zone NOT NULL,
    "paidDate" timestamp(3) without time zone,
    status public."AccountStatus" DEFAULT 'PENDING'::public."AccountStatus" NOT NULL,
    "referenceType" text,
    "referenceId" text,
    notes text,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL
);

CREATE TABLE public.activations (
    id text NOT NULL,
    "licenseId" text NOT NULL,
    "deviceId" text NOT NULL,
    "userId" text NOT NULL,
    "activationCode" text NOT NULL,
    status public."ActivationStatus" DEFAULT 'PENDING'::public."ActivationStatus" NOT NULL,
    "approvedBy" text,
    "approvedAt" timestamp(3) without time zone,
    "activatedAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "expiresAt" timestamp(3) without time zone,
    "ipAddress" text
);

CREATE TABLE public.audit_logs (
    id text NOT NULL,
    "companyId" text,
    "userId" text,
    action public."AuditAction" NOT NULL,
    entity text NOT NULL,
    "entityId" text,
    "oldValue" text,
    "newValue" text,
    "ipAddress" text,
    "userAgent" text,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE TABLE public.branches (
    id text NOT NULL,
    "companyId" text NOT NULL,
    name text NOT NULL,
    document text,
    address text,
    city text,
    state text,
    "zipCode" text,
    phone text,
    "isActive" boolean DEFAULT true NOT NULL,
    "isHeadquarter" boolean DEFAULT false NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL
);

CREATE TABLE public.cash_movements (
    id text NOT NULL,
    "cashRegisterId" text NOT NULL,
    "movementType" public."CashMovementType" NOT NULL,
    amount numeric(10,2) NOT NULL,
    "paymentMethod" public."PaymentMethod",
    "referenceType" text,
    "referenceId" text,
    notes text,
    "userId" text NOT NULL,
    "requestedBy" text,
    "authorizedBy" text,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE TABLE public.cash_registers (
    id text NOT NULL,
    "companyId" text NOT NULL,
    "branchId" text NOT NULL,
    "userId" text NOT NULL,
    "registerNumber" integer NOT NULL,
    status public."CashRegisterStatus" NOT NULL,
    "openingAmount" numeric(10,2) NOT NULL,
    "expectedAmount" numeric(10,2) DEFAULT 0 NOT NULL,
    "actualAmount" numeric(10,2),
    difference numeric(10,2),
    "openedAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "closedAt" timestamp(3) without time zone,
    "closedBy" text,
    notes text,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL
);

CREATE TABLE public.categories (
    id text NOT NULL,
    "companyId" text NOT NULL,
    name text NOT NULL,
    description text,
    "parentId" text,
    "isActive" boolean DEFAULT true NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL
);

CREATE TABLE public.combo_items (
    id text NOT NULL,
    "comboId" text NOT NULL,
    "productId" text NOT NULL,
    quantity numeric(10,3) NOT NULL
);

CREATE TABLE public.commission_rules (
    id text NOT NULL,
    "companyId" text NOT NULL,
    name text NOT NULL,
    "serviceType" text,
    percentage numeric(5,2) NOT NULL,
    "isActive" boolean DEFAULT true NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL
);

CREATE TABLE public.companies (
    id text NOT NULL,
    name text NOT NULL,
    document text NOT NULL,
    email text NOT NULL,
    phone text,
    "isActive" boolean DEFAULT true NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL
);

CREATE TABLE public.customers (
    id text NOT NULL,
    "companyId" text NOT NULL,
    "customerType" public."CustomerType" DEFAULT 'INDIVIDUAL'::public."CustomerType" NOT NULL,
    name text NOT NULL,
    document text,
    email text,
    phone text,
    mobile text,
    "birthDate" timestamp(3) without time zone,
    address text,
    city text,
    state text,
    "zipCode" text,
    notes text,
    "isActive" boolean DEFAULT true NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL
);

CREATE TABLE public.damage_records (
    id text NOT NULL,
    "companyId" text NOT NULL,
    "branchId" text NOT NULL,
    "productId" text NOT NULL,
    quantity numeric(10,3) NOT NULL,
    reason public."DamageReason" NOT NULL,
    description text,
    "photoUrls" text,
    "approvedBy" text NOT NULL,
    "recordedBy" text NOT NULL,
    "recordedAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "isReversed" boolean DEFAULT false NOT NULL,
    "reversedAt" timestamp(3) without time zone,
    "reversedBy" text,
    "reverseReason" text,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE TABLE public.device_sessions (
    id text NOT NULL,
    "deviceId" text NOT NULL,
    "userId" text NOT NULL,
    "companyId" text NOT NULL,
    "branchId" text,
    status public."DeviceSessionStatus" DEFAULT 'ACTIVE'::public."DeviceSessionStatus" NOT NULL,
    "startedAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "endedAt" timestamp(3) without time zone,
    "endedBy" text,
    "endReason" text,
    "ipAddress" text
);

CREATE TABLE public.devices (
    id text NOT NULL,
    "licenseId" text NOT NULL,
    "deviceName" text NOT NULL,
    "deviceType" public."DeviceType" NOT NULL,
    status public."DeviceStatus" DEFAULT 'PENDING'::public."DeviceStatus" NOT NULL,
    "macAddress" text,
    "ipAddress" text,
    "lastSeenAt" timestamp(3) without time zone,
    "activatedBy" text,
    "activatedAt" timestamp(3) without time zone,
    "revokedBy" text,
    "revokedAt" timestamp(3) without time zone,
    "revocationReason" text,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL
);

CREATE TABLE public.discount_rules (
    id text NOT NULL,
    "companyId" text NOT NULL,
    name text NOT NULL,
    description text,
    "userType" public."UserType",
    "roleId" text,
    "discountType" public."DiscountType" NOT NULL,
    "maxDiscount" numeric(5,2) NOT NULL,
    "requiresApproval" boolean DEFAULT false NOT NULL,
    "isActive" boolean DEFAULT true NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL
);

CREATE TABLE public.fiscal_configs (
    id text NOT NULL,
    "companyId" text NOT NULL,
    "branchId" text NOT NULL,
    "nfceEnabled" boolean DEFAULT false NOT NULL,
    "nfceSeriesNumber" integer DEFAULT 1 NOT NULL,
    "nfceNextNumber" integer DEFAULT 1 NOT NULL,
    "nfeEnabled" boolean DEFAULT false NOT NULL,
    "nfeSeriesNumber" integer DEFAULT 1 NOT NULL,
    "nfeNextNumber" integer DEFAULT 1 NOT NULL,
    "certificatePath" text,
    "certificatePassword" text,
    "cscId" text,
    "cscToken" text,
    environment text DEFAULT 'HOMOLOGACAO'::text NOT NULL,
    "cancelTimeLimit" integer DEFAULT 24 NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL
);

CREATE TABLE public.fiscal_documents (
    id text NOT NULL,
    "companyId" text NOT NULL,
    "branchId" text NOT NULL,
    "documentType" public."FiscalDocumentType" NOT NULL,
    status public."FiscalDocumentStatus" DEFAULT 'DRAFT'::public."FiscalDocumentStatus" NOT NULL,
    series text NOT NULL,
    number integer NOT NULL,
    "accessKey" text,
    "authorizationProtocol" text,
    "saleId" text,
    "serviceOrderId" text,
    "totalAmount" numeric(10,2) NOT NULL,
    "xmlUrl" text,
    "pdfUrl" text,
    "qrCode" text,
    "issuedAt" timestamp(3) without time zone,
    "authorizedAt" timestamp(3) without time zone,
    "cancelledAt" timestamp(3) without time zone,
    "cancelReason" text,
    "rejectionReason" text,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL
);

CREATE TABLE public.idempotency_keys (
    id text NOT NULL,
    key text NOT NULL,
    "companyId" text NOT NULL,
    "userId" text,
    endpoint text NOT NULL,
    "requestHash" text NOT NULL,
    status public."IdempotencyStatus" DEFAULT 'PENDING'::public."IdempotencyStatus" NOT NULL,
    "responseStatus" integer,
    "responseBody" jsonb,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "completedAt" timestamp(3) without time zone,
    "expiresAt" timestamp(3) without time zone NOT NULL
);

CREATE TABLE public.installment_policies (
    id text NOT NULL,
    "companyId" text NOT NULL,
    "branchId" text,
    "paymentMethod" public."PaymentMethod" NOT NULL,
    "maxInstallments" integer DEFAULT 1 NOT NULL,
    "interestFreeInstallments" integer DEFAULT 1 NOT NULL,
    "isActive" boolean DEFAULT true NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL
);

CREATE TABLE public.inventories (
    id text NOT NULL,
    "companyId" text NOT NULL,
    "branchId" text NOT NULL,
    "inventoryNumber" integer NOT NULL,
    status public."InventoryStatus" DEFAULT 'DRAFT'::public."InventoryStatus" NOT NULL,
    "startedBy" text NOT NULL,
    "startedAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "completedAt" timestamp(3) without time zone,
    notes text,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL
);

CREATE TABLE public.inventory_counts (
    id text NOT NULL,
    "inventoryId" text NOT NULL,
    "productId" text NOT NULL,
    "systemQuantity" numeric(10,3) NOT NULL,
    "countedQuantity" numeric(10,3) NOT NULL,
    difference numeric(10,3) NOT NULL,
    "countedBy" text NOT NULL,
    "countedAt" timestamp(3) without time zone NOT NULL,
    notes text
);

CREATE TABLE public.invoices (
    id text NOT NULL,
    "companyId" text NOT NULL,
    "supplierId" text NOT NULL,
    "purchaseOrderId" text,
    "invoiceNumber" text NOT NULL,
    series text NOT NULL,
    "accessKey" text NOT NULL,
    "issueDate" timestamp(3) without time zone NOT NULL,
    "totalAmount" numeric(10,2) NOT NULL,
    "xmlUrl" text,
    "isReceived" boolean DEFAULT false NOT NULL,
    "receivedAt" timestamp(3) without time zone,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL
);

CREATE TABLE public.licenses (
    id text NOT NULL,
    "companyId" text NOT NULL,
    "licenseType" public."LicenseType" NOT NULL,
    status public."LicenseStatus" DEFAULT 'PENDING_APPROVAL'::public."LicenseStatus" NOT NULL,
    "maxDevices" integer DEFAULT 1 NOT NULL,
    "maxUsers" integer DEFAULT 10 NOT NULL,
    "maxBranches" integer DEFAULT 1 NOT NULL,
    "startDate" timestamp(3) without time zone,
    "expiryDate" timestamp(3) without time zone,
    "approvedBy" text,
    "approvedAt" timestamp(3) without time zone,
    notes text,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL
);

CREATE TABLE public.mechanic_commissions (
    id text NOT NULL,
    "companyId" text NOT NULL,
    "serviceOrderId" text NOT NULL,
    "mechanicId" text NOT NULL,
    "ruleSnapshot" jsonb NOT NULL,
    "baseAmount" numeric(10,2) NOT NULL,
    percentage numeric(5,2) NOT NULL,
    "commissionAmount" numeric(10,2) NOT NULL,
    "isPaid" boolean DEFAULT false NOT NULL,
    "paidAt" timestamp(3) without time zone,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE TABLE public.motorcycles (
    id text NOT NULL,
    "companyId" text NOT NULL,
    "customerId" text NOT NULL,
    "licensePlate" text,
    "chassisNumber" text,
    brand text NOT NULL,
    model text NOT NULL,
    year integer,
    color text,
    "engineNumber" text,
    "kilometerReading" numeric(10,1) NOT NULL,
    "isActive" boolean DEFAULT true NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL,
    "vehicleType" public."VehicleType" DEFAULT 'MOTORCYCLE'::public."VehicleType" NOT NULL
);

CREATE TABLE public.partners (
    id text NOT NULL,
    "companyId" text NOT NULL,
    "branchId" text,
    name text NOT NULL,
    description text,
    "discountType" public."PartnerDiscountType" DEFAULT 'PERCENTAGE'::public."PartnerDiscountType" NOT NULL,
    "discountValue" numeric(10,2) NOT NULL,
    "maxDiscountAmount" numeric(10,2),
    stackable boolean DEFAULT false NOT NULL,
    "requiresApproval" boolean DEFAULT false NOT NULL,
    "validFrom" timestamp(3) without time zone,
    "validUntil" timestamp(3) without time zone,
    "isActive" boolean DEFAULT true NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL
);

CREATE TABLE public.payments (
    id text NOT NULL,
    "companyId" text NOT NULL,
    "saleId" text NOT NULL,
    "paymentMethod" public."PaymentMethod" NOT NULL,
    status public."PaymentStatus" DEFAULT 'PENDING'::public."PaymentStatus" NOT NULL,
    amount numeric(10,2) NOT NULL,
    installments integer DEFAULT 1 NOT NULL,
    "transactionId" text,
    "authorizationCode" text,
    "cardBrand" text,
    "cardLastDigits" text,
    "nsuHost" text,
    "nsuTef" text,
    "paidAt" timestamp(3) without time zone,
    "cancelledAt" timestamp(3) without time zone,
    "refundedAt" timestamp(3) without time zone,
    notes text,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL
);

CREATE TABLE public.permissions (
    id text NOT NULL,
    "companyId" text,
    name text NOT NULL,
    description text,
    scope public."PermissionScope" DEFAULT 'BRANCH'::public."PermissionScope" NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL
);

CREATE TABLE public.products (
    id text NOT NULL,
    "companyId" text NOT NULL,
    "branchId" text,
    "categoryId" text,
    sku text NOT NULL,
    barcode text,
    name text NOT NULL,
    description text,
    brand text,
    application text,
    location text,
    "productType" public."ProductType" DEFAULT 'PRODUCT'::public."ProductType" NOT NULL,
    "costPrice" numeric(10,2) NOT NULL,
    "salePrice" numeric(10,2) NOT NULL,
    "minStock" integer DEFAULT 0 NOT NULL,
    "maxStock" integer,
    unit text DEFAULT 'UN'::text NOT NULL,
    "isActive" boolean DEFAULT true NOT NULL,
    "allowNegativeStock" boolean DEFAULT false NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL
);

CREATE TABLE public.purchase_order_items (
    id text NOT NULL,
    "purchaseOrderId" text NOT NULL,
    "productId" text NOT NULL,
    quantity numeric(10,3) NOT NULL,
    "receivedQuantity" numeric(10,3) DEFAULT 0 NOT NULL,
    "unitCost" numeric(10,2) NOT NULL,
    "totalCost" numeric(10,2) NOT NULL
);

CREATE TABLE public.purchase_orders (
    id text NOT NULL,
    "companyId" text NOT NULL,
    "branchId" text NOT NULL,
    "poNumber" integer NOT NULL,
    "supplierId" text NOT NULL,
    status public."PurchaseOrderStatus" DEFAULT 'DRAFT'::public."PurchaseOrderStatus" NOT NULL,
    "orderDate" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "expectedDelivery" timestamp(3) without time zone,
    "receivedDate" timestamp(3) without time zone,
    subtotal numeric(10,2) NOT NULL,
    "taxAmount" numeric(10,2) DEFAULT 0 NOT NULL,
    "totalAmount" numeric(10,2) NOT NULL,
    notes text,
    "approvedBy" text,
    "approvedAt" timestamp(3) without time zone,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL
);

CREATE TABLE public.quote_items (
    id text NOT NULL,
    "quoteVersionId" text NOT NULL,
    "itemType" public."ServiceOrderItemType" NOT NULL,
    "productId" text,
    description text NOT NULL,
    quantity numeric(10,3) NOT NULL,
    "unitPrice" numeric(10,2) NOT NULL,
    "totalPrice" numeric(10,2) NOT NULL
);

CREATE TABLE public.quote_versions (
    id text NOT NULL,
    "quoteId" text NOT NULL,
    "versionNumber" integer NOT NULL,
    "laborTotal" numeric(10,2) DEFAULT 0 NOT NULL,
    "partsTotal" numeric(10,2) DEFAULT 0 NOT NULL,
    "discountAmount" numeric(10,2) DEFAULT 0 NOT NULL,
    "totalAmount" numeric(10,2) DEFAULT 0 NOT NULL,
    "sentAt" timestamp(3) without time zone,
    "isApproved" boolean DEFAULT false NOT NULL,
    "approvedAt" timestamp(3) without time zone,
    "decidedBy" text,
    "decisionNotes" text,
    "createdBy" text NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE TABLE public.quotes (
    id text NOT NULL,
    "companyId" text NOT NULL,
    "branchId" text NOT NULL,
    "customerId" text NOT NULL,
    "motorcycleId" text NOT NULL,
    "quoteNumber" integer NOT NULL,
    status public."QuoteStatus" DEFAULT 'DRAFT'::public."QuoteStatus" NOT NULL,
    "validUntil" timestamp(3) without time zone,
    notes text,
    "createdBy" text NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL
);

CREATE TABLE public.refresh_tokens (
    id text NOT NULL,
    "userId" text NOT NULL,
    "companyId" text,
    token text NOT NULL,
    "expiresAt" timestamp(3) without time zone NOT NULL,
    "isRevoked" boolean DEFAULT false NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "ipAddress" text,
    "userAgent" text
);

CREATE TABLE public.request_logs (
    id text NOT NULL,
    "requestId" text NOT NULL,
    method text NOT NULL,
    route text NOT NULL,
    "statusCode" integer NOT NULL,
    "durationMs" integer NOT NULL,
    "companyId" text,
    "branchId" text,
    "userId" text,
    device text,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE TABLE public.role_permissions (
    id text NOT NULL,
    "roleId" text NOT NULL,
    "permissionId" text NOT NULL
);

CREATE TABLE public.roles (
    id text NOT NULL,
    "companyId" text,
    name text NOT NULL,
    description text,
    "isSystem" boolean DEFAULT false NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL
);

CREATE TABLE public.sale_items (
    id text NOT NULL,
    "saleId" text NOT NULL,
    "productId" text NOT NULL,
    "productName" text NOT NULL,
    "productSku" text NOT NULL,
    quantity numeric(10,3) NOT NULL,
    "unitPrice" numeric(10,2) NOT NULL,
    "discountAmount" numeric(10,2) DEFAULT 0 NOT NULL,
    "discountPercent" numeric(5,2) DEFAULT 0 NOT NULL,
    "totalPrice" numeric(10,2) NOT NULL,
    notes text,
    "returnedQuantity" numeric(10,3) DEFAULT 0 NOT NULL
);

CREATE TABLE public.sales (
    id text NOT NULL,
    "companyId" text NOT NULL,
    "branchId" text NOT NULL,
    "saleNumber" integer NOT NULL,
    "customerId" text,
    "userId" text NOT NULL,
    "cashRegisterId" text NOT NULL,
    status public."SaleStatus" DEFAULT 'PENDING'::public."SaleStatus" NOT NULL,
    subtotal numeric(10,2) NOT NULL,
    "discountAmount" numeric(10,2) DEFAULT 0 NOT NULL,
    "discountPercent" numeric(5,2) DEFAULT 0 NOT NULL,
    "totalAmount" numeric(10,2) NOT NULL,
    "paidAmount" numeric(10,2) DEFAULT 0 NOT NULL,
    "changeAmount" numeric(10,2) DEFAULT 0 NOT NULL,
    notes text,
    "cancelReason" text,
    "cancelledAt" timestamp(3) without time zone,
    "cancelledBy" text,
    "saleDate" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL,
    "partnerDiscountAmount" numeric(10,2) DEFAULT 0 NOT NULL,
    "partnerId" text
);

CREATE TABLE public.service_order_items (
    id text NOT NULL,
    "serviceOrderId" text NOT NULL,
    "itemType" public."ServiceOrderItemType" NOT NULL,
    "productId" text,
    description text NOT NULL,
    quantity numeric(10,3) NOT NULL,
    "unitPrice" numeric(10,2) NOT NULL,
    "totalPrice" numeric(10,2) NOT NULL,
    "isCompleted" boolean DEFAULT false NOT NULL,
    "completedAt" timestamp(3) without time zone
);

CREATE TABLE public.service_order_status_history (
    id text NOT NULL,
    "serviceOrderId" text NOT NULL,
    "fromStatus" public."ServiceOrderStatus",
    "toStatus" public."ServiceOrderStatus" NOT NULL,
    "changedBy" text NOT NULL,
    "changedAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    notes text
);

CREATE TABLE public.service_orders (
    id text NOT NULL,
    "companyId" text NOT NULL,
    "branchId" text NOT NULL,
    "osNumber" integer NOT NULL,
    "customerId" text NOT NULL,
    "motorcycleId" text NOT NULL,
    status public."ServiceOrderStatus" DEFAULT 'ENTRADA'::public."ServiceOrderStatus" NOT NULL,
    "entryDate" timestamp(3) without time zone NOT NULL,
    "entryKilometer" numeric(10,1) NOT NULL,
    "estimatedDelivery" timestamp(3) without time zone,
    "deliveryDate" timestamp(3) without time zone,
    "exitKilometer" numeric(10,1),
    "fuelLevel" text,
    "visibleDamages" text,
    "personalItems" text,
    "entryNotes" text,
    "diagnosticNotes" text,
    "mechanicId" text,
    "mechanicStartedAt" timestamp(3) without time zone,
    "mechanicCompletedAt" timestamp(3) without time zone,
    "laborTotal" numeric(10,2) DEFAULT 0 NOT NULL,
    "partsTotal" numeric(10,2) DEFAULT 0 NOT NULL,
    "discountAmount" numeric(10,2) DEFAULT 0 NOT NULL,
    "finalTotal" numeric(10,2) NOT NULL,
    "isPaid" boolean DEFAULT false NOT NULL,
    "paidAt" timestamp(3) without time zone,
    "paymentMethod" public."PaymentMethod",
    "cancelReason" text,
    "cancelledAt" timestamp(3) without time zone,
    "cancelledBy" text,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL,
    "quoteVersionId" text
);

CREATE TABLE public.stock_movements (
    id text NOT NULL,
    "companyId" text NOT NULL,
    "branchId" text,
    "productId" text NOT NULL,
    "movementType" public."MovementType" NOT NULL,
    quantity numeric(10,3) NOT NULL,
    "unitCost" numeric(10,2),
    "totalCost" numeric(10,2),
    "referenceType" text,
    "referenceId" text,
    notes text,
    "userId" text NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE TABLE public.suppliers (
    id text NOT NULL,
    "companyId" text NOT NULL,
    name text NOT NULL,
    document text NOT NULL,
    email text,
    phone text,
    address text,
    city text,
    state text,
    "zipCode" text,
    "isActive" boolean DEFAULT true NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL,
    "addressComplement" text,
    "addressNumber" text,
    mobile text,
    notes text,
    "tradeName" text
);

CREATE TABLE public.system_logs (
    id text NOT NULL,
    level text NOT NULL,
    category text NOT NULL,
    service text NOT NULL,
    event text NOT NULL,
    message text NOT NULL,
    "requestId" text,
    "companyId" text,
    "branchId" text,
    "userId" text,
    device text,
    "durationMs" integer,
    "errorMessage" text,
    "stackTrace" text,
    metadata jsonb,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE TABLE public.tef_payments (
    id text NOT NULL,
    "companyId" text NOT NULL,
    "saleId" text,
    "serviceOrderId" text,
    "paymentId" text NOT NULL,
    provider text NOT NULL,
    "transactionId" text NOT NULL,
    amount numeric(10,2) NOT NULL,
    status public."TEFPaymentStatus" DEFAULT 'PENDING'::public."TEFPaymentStatus" NOT NULL,
    "cardBrand" text,
    "cardLastDigits" text,
    "authorizationCode" text,
    "nsuHost" text,
    "nsuTef" text,
    "requestedAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "authorizedAt" timestamp(3) without time zone,
    "rejectedAt" timestamp(3) without time zone,
    "rejectionReason" text,
    "reconciliationStatus" text,
    "reconciledAt" timestamp(3) without time zone,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL
);

CREATE TABLE public.transfer_items (
    id text NOT NULL,
    "transferId" text NOT NULL,
    "productId" text NOT NULL,
    "requestedQuantity" numeric(10,3) NOT NULL,
    "sentQuantity" numeric(10,3),
    "receivedQuantity" numeric(10,3),
    notes text
);

CREATE TABLE public.transfers (
    id text NOT NULL,
    "companyId" text NOT NULL,
    "fromBranchId" text NOT NULL,
    "toBranchId" text NOT NULL,
    "transferNumber" integer NOT NULL,
    status public."TransferStatus" DEFAULT 'PENDING'::public."TransferStatus" NOT NULL,
    "requestedBy" text NOT NULL,
    "approvedBy" text,
    "sentBy" text,
    "receivedBy" text,
    "requestedAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "approvedAt" timestamp(3) without time zone,
    "sentAt" timestamp(3) without time zone,
    "receivedAt" timestamp(3) without time zone,
    notes text,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL
);

CREATE TABLE public.user_roles (
    id text NOT NULL,
    "userId" text NOT NULL,
    "roleId" text NOT NULL,
    "branchId" text
);

CREATE TABLE public.users (
    id text NOT NULL,
    "numericId" integer NOT NULL,
    "companyId" text,
    "branchId" text,
    name text NOT NULL,
    email text NOT NULL,
    phone text,
    password text NOT NULL,
    "userType" public."UserType" NOT NULL,
    "isActive" boolean DEFAULT true NOT NULL,
    "emailVerified" boolean DEFAULT false NOT NULL,
    "mfaEnabled" boolean DEFAULT false NOT NULL,
    "mfaSecret" text,
    "mfaBackupCodes" text[] DEFAULT ARRAY[]::text[],
    "loginAttempts" integer DEFAULT 0 NOT NULL,
    "lockedUntil" timestamp(3) without time zone,
    "lastLoginAt" timestamp(3) without time zone,
    "lastLoginIp" text,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL
);

-- The one column in this schema with a database-level (not Prisma-side)
-- default: `numericId` is the short login id used at the PDV, and needs to
-- come from a real Postgres sequence so concurrent signups can't race each
-- other onto the same number the way two app-side `Math.random()` calls
-- could.
CREATE SEQUENCE public."users_numericId_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public."users_numericId_seq" OWNED BY public.users."numericId";

ALTER TABLE ONLY public.users ALTER COLUMN "numericId" SET DEFAULT nextval('public."users_numericId_seq"'::regclass);

CREATE TABLE public.vehicle_entry_checklist_items (
    id text NOT NULL,
    "checklistId" text NOT NULL,
    "itemName" text NOT NULL,
    status public."ChecklistItemStatus" DEFAULT 'NOT_CHECKED'::public."ChecklistItemStatus" NOT NULL,
    description text,
    "photoUrl" text
);

CREATE TABLE public.vehicle_entry_checklists (
    id text NOT NULL,
    "companyId" text NOT NULL,
    "serviceOrderId" text NOT NULL,
    "motorcycleId" text NOT NULL,
    "checkedBy" text NOT NULL,
    "checkedAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

-- ============================================================================
-- CONSTRAINTS (PRIMARY KEY / FOREIGN KEY)
-- ============================================================================

ALTER TABLE ONLY public.accounts_payable
    ADD CONSTRAINT accounts_payable_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.accounts_receivable
    ADD CONSTRAINT accounts_receivable_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.activations
    ADD CONSTRAINT activations_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.audit_logs
    ADD CONSTRAINT audit_logs_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.branches
    ADD CONSTRAINT branches_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.cash_movements
    ADD CONSTRAINT cash_movements_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.cash_registers
    ADD CONSTRAINT cash_registers_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.categories
    ADD CONSTRAINT categories_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.combo_items
    ADD CONSTRAINT combo_items_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.commission_rules
    ADD CONSTRAINT commission_rules_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.companies
    ADD CONSTRAINT companies_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.customers
    ADD CONSTRAINT customers_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.damage_records
    ADD CONSTRAINT damage_records_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.device_sessions
    ADD CONSTRAINT device_sessions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.devices
    ADD CONSTRAINT devices_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.discount_rules
    ADD CONSTRAINT discount_rules_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.fiscal_configs
    ADD CONSTRAINT fiscal_configs_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.fiscal_documents
    ADD CONSTRAINT fiscal_documents_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.idempotency_keys
    ADD CONSTRAINT idempotency_keys_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.installment_policies
    ADD CONSTRAINT installment_policies_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.inventories
    ADD CONSTRAINT inventories_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.inventory_counts
    ADD CONSTRAINT inventory_counts_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.invoices
    ADD CONSTRAINT invoices_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.licenses
    ADD CONSTRAINT licenses_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.mechanic_commissions
    ADD CONSTRAINT mechanic_commissions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.motorcycles
    ADD CONSTRAINT motorcycles_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.partners
    ADD CONSTRAINT partners_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.payments
    ADD CONSTRAINT payments_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.permissions
    ADD CONSTRAINT permissions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.products
    ADD CONSTRAINT products_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.purchase_order_items
    ADD CONSTRAINT purchase_order_items_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.purchase_orders
    ADD CONSTRAINT purchase_orders_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.quote_items
    ADD CONSTRAINT quote_items_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.quote_versions
    ADD CONSTRAINT quote_versions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.quotes
    ADD CONSTRAINT quotes_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.refresh_tokens
    ADD CONSTRAINT refresh_tokens_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.request_logs
    ADD CONSTRAINT request_logs_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.role_permissions
    ADD CONSTRAINT role_permissions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.roles
    ADD CONSTRAINT roles_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.sale_items
    ADD CONSTRAINT sale_items_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.sales
    ADD CONSTRAINT sales_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.service_order_items
    ADD CONSTRAINT service_order_items_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.service_order_status_history
    ADD CONSTRAINT service_order_status_history_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.service_orders
    ADD CONSTRAINT service_orders_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.stock_movements
    ADD CONSTRAINT stock_movements_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.suppliers
    ADD CONSTRAINT suppliers_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.system_logs
    ADD CONSTRAINT system_logs_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.tef_payments
    ADD CONSTRAINT tef_payments_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.transfer_items
    ADD CONSTRAINT transfer_items_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.transfers
    ADD CONSTRAINT transfers_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.user_roles
    ADD CONSTRAINT user_roles_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.vehicle_entry_checklist_items
    ADD CONSTRAINT vehicle_entry_checklist_items_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.vehicle_entry_checklists
    ADD CONSTRAINT vehicle_entry_checklists_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.activations
    ADD CONSTRAINT "activations_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES public.devices(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.activations
    ADD CONSTRAINT "activations_licenseId_fkey" FOREIGN KEY ("licenseId") REFERENCES public.licenses(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.activations
    ADD CONSTRAINT "activations_userId_fkey" FOREIGN KEY ("userId") REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.audit_logs
    ADD CONSTRAINT "audit_logs_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES public.companies(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.audit_logs
    ADD CONSTRAINT "audit_logs_userId_fkey" FOREIGN KEY ("userId") REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE ONLY public.branches
    ADD CONSTRAINT "branches_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES public.companies(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.cash_movements
    ADD CONSTRAINT "cash_movements_cashRegisterId_fkey" FOREIGN KEY ("cashRegisterId") REFERENCES public.cash_registers(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.categories
    ADD CONSTRAINT "categories_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES public.categories(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE ONLY public.combo_items
    ADD CONSTRAINT "combo_items_comboId_fkey" FOREIGN KEY ("comboId") REFERENCES public.products(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.combo_items
    ADD CONSTRAINT "combo_items_productId_fkey" FOREIGN KEY ("productId") REFERENCES public.products(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.damage_records
    ADD CONSTRAINT "damage_records_productId_fkey" FOREIGN KEY ("productId") REFERENCES public.products(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public.device_sessions
    ADD CONSTRAINT "device_sessions_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES public.devices(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.device_sessions
    ADD CONSTRAINT "device_sessions_userId_fkey" FOREIGN KEY ("userId") REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.devices
    ADD CONSTRAINT "devices_licenseId_fkey" FOREIGN KEY ("licenseId") REFERENCES public.licenses(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.installment_policies
    ADD CONSTRAINT "installment_policies_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES public.companies(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.inventory_counts
    ADD CONSTRAINT "inventory_counts_inventoryId_fkey" FOREIGN KEY ("inventoryId") REFERENCES public.inventories(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.inventory_counts
    ADD CONSTRAINT "inventory_counts_productId_fkey" FOREIGN KEY ("productId") REFERENCES public.products(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public.invoices
    ADD CONSTRAINT "invoices_purchaseOrderId_fkey" FOREIGN KEY ("purchaseOrderId") REFERENCES public.purchase_orders(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE ONLY public.invoices
    ADD CONSTRAINT "invoices_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES public.suppliers(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public.licenses
    ADD CONSTRAINT "licenses_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES public.companies(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.mechanic_commissions
    ADD CONSTRAINT "mechanic_commissions_serviceOrderId_fkey" FOREIGN KEY ("serviceOrderId") REFERENCES public.service_orders(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public.motorcycles
    ADD CONSTRAINT "motorcycles_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES public.customers(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public.partners
    ADD CONSTRAINT "partners_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES public.companies(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.payments
    ADD CONSTRAINT "payments_saleId_fkey" FOREIGN KEY ("saleId") REFERENCES public.sales(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.permissions
    ADD CONSTRAINT "permissions_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES public.companies(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.products
    ADD CONSTRAINT "products_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES public.categories(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE ONLY public.purchase_order_items
    ADD CONSTRAINT "purchase_order_items_productId_fkey" FOREIGN KEY ("productId") REFERENCES public.products(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public.purchase_order_items
    ADD CONSTRAINT "purchase_order_items_purchaseOrderId_fkey" FOREIGN KEY ("purchaseOrderId") REFERENCES public.purchase_orders(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.purchase_orders
    ADD CONSTRAINT "purchase_orders_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES public.suppliers(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public.quote_items
    ADD CONSTRAINT "quote_items_quoteVersionId_fkey" FOREIGN KEY ("quoteVersionId") REFERENCES public.quote_versions(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.quote_versions
    ADD CONSTRAINT "quote_versions_quoteId_fkey" FOREIGN KEY ("quoteId") REFERENCES public.quotes(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.quotes
    ADD CONSTRAINT "quotes_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES public.customers(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public.quotes
    ADD CONSTRAINT "quotes_motorcycleId_fkey" FOREIGN KEY ("motorcycleId") REFERENCES public.motorcycles(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public.refresh_tokens
    ADD CONSTRAINT "refresh_tokens_userId_fkey" FOREIGN KEY ("userId") REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.role_permissions
    ADD CONSTRAINT "role_permissions_permissionId_fkey" FOREIGN KEY ("permissionId") REFERENCES public.permissions(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.role_permissions
    ADD CONSTRAINT "role_permissions_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES public.roles(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.roles
    ADD CONSTRAINT "roles_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES public.companies(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.sale_items
    ADD CONSTRAINT "sale_items_productId_fkey" FOREIGN KEY ("productId") REFERENCES public.products(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public.sale_items
    ADD CONSTRAINT "sale_items_saleId_fkey" FOREIGN KEY ("saleId") REFERENCES public.sales(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.sales
    ADD CONSTRAINT "sales_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES public.customers(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE ONLY public.sales
    ADD CONSTRAINT "sales_partnerId_fkey" FOREIGN KEY ("partnerId") REFERENCES public.partners(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE ONLY public.sales
    ADD CONSTRAINT "sales_userId_fkey" FOREIGN KEY ("userId") REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public.service_order_items
    ADD CONSTRAINT "service_order_items_productId_fkey" FOREIGN KEY ("productId") REFERENCES public.products(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE ONLY public.service_order_items
    ADD CONSTRAINT "service_order_items_serviceOrderId_fkey" FOREIGN KEY ("serviceOrderId") REFERENCES public.service_orders(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.service_order_status_history
    ADD CONSTRAINT "service_order_status_history_serviceOrderId_fkey" FOREIGN KEY ("serviceOrderId") REFERENCES public.service_orders(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.service_orders
    ADD CONSTRAINT "service_orders_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES public.customers(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public.service_orders
    ADD CONSTRAINT "service_orders_mechanicId_fkey" FOREIGN KEY ("mechanicId") REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE ONLY public.service_orders
    ADD CONSTRAINT "service_orders_motorcycleId_fkey" FOREIGN KEY ("motorcycleId") REFERENCES public.motorcycles(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public.service_orders
    ADD CONSTRAINT "service_orders_quoteVersionId_fkey" FOREIGN KEY ("quoteVersionId") REFERENCES public.quote_versions(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE ONLY public.stock_movements
    ADD CONSTRAINT "stock_movements_productId_fkey" FOREIGN KEY ("productId") REFERENCES public.products(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.transfer_items
    ADD CONSTRAINT "transfer_items_productId_fkey" FOREIGN KEY ("productId") REFERENCES public.products(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public.transfer_items
    ADD CONSTRAINT "transfer_items_transferId_fkey" FOREIGN KEY ("transferId") REFERENCES public.transfers(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.user_roles
    ADD CONSTRAINT "user_roles_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES public.roles(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.user_roles
    ADD CONSTRAINT "user_roles_userId_fkey" FOREIGN KEY ("userId") REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.users
    ADD CONSTRAINT "users_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES public.branches(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE ONLY public.users
    ADD CONSTRAINT "users_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES public.companies(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.vehicle_entry_checklist_items
    ADD CONSTRAINT "vehicle_entry_checklist_items_checklistId_fkey" FOREIGN KEY ("checklistId") REFERENCES public.vehicle_entry_checklists(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.vehicle_entry_checklists
    ADD CONSTRAINT "vehicle_entry_checklists_motorcycleId_fkey" FOREIGN KEY ("motorcycleId") REFERENCES public.motorcycles(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public.vehicle_entry_checklists
    ADD CONSTRAINT "vehicle_entry_checklists_serviceOrderId_fkey" FOREIGN KEY ("serviceOrderId") REFERENCES public.service_orders(id) ON UPDATE CASCADE ON DELETE CASCADE;

-- ============================================================================
-- INDEXES
-- ============================================================================

CREATE INDEX "accounts_payable_branchId_idx" ON public.accounts_payable USING btree ("branchId");

CREATE INDEX "accounts_payable_companyId_idx" ON public.accounts_payable USING btree ("companyId");

CREATE INDEX "accounts_payable_companyId_status_idx" ON public.accounts_payable USING btree ("companyId", status);

CREATE INDEX "accounts_payable_dueDate_idx" ON public.accounts_payable USING btree ("dueDate");

CREATE INDEX accounts_payable_status_idx ON public.accounts_payable USING btree (status);

CREATE INDEX "accounts_payable_supplierId_idx" ON public.accounts_payable USING btree ("supplierId");

CREATE INDEX "accounts_receivable_branchId_idx" ON public.accounts_receivable USING btree ("branchId");

CREATE INDEX "accounts_receivable_companyId_idx" ON public.accounts_receivable USING btree ("companyId");

CREATE INDEX "accounts_receivable_companyId_status_idx" ON public.accounts_receivable USING btree ("companyId", status);

CREATE INDEX "accounts_receivable_customerId_idx" ON public.accounts_receivable USING btree ("customerId");

CREATE INDEX "accounts_receivable_dueDate_idx" ON public.accounts_receivable USING btree ("dueDate");

CREATE INDEX accounts_receivable_status_idx ON public.accounts_receivable USING btree (status);

CREATE UNIQUE INDEX "activations_activationCode_key" ON public.activations USING btree ("activationCode");

CREATE INDEX "activations_deviceId_idx" ON public.activations USING btree ("deviceId");

CREATE INDEX "activations_licenseId_idx" ON public.activations USING btree ("licenseId");

CREATE INDEX activations_status_idx ON public.activations USING btree (status);

CREATE INDEX "activations_userId_idx" ON public.activations USING btree ("userId");

CREATE INDEX audit_logs_action_idx ON public.audit_logs USING btree (action);

CREATE INDEX "audit_logs_companyId_createdAt_idx" ON public.audit_logs USING btree ("companyId", "createdAt");

CREATE INDEX "audit_logs_companyId_idx" ON public.audit_logs USING btree ("companyId");

CREATE INDEX "audit_logs_createdAt_idx" ON public.audit_logs USING btree ("createdAt");

CREATE INDEX "audit_logs_entity_entityId_idx" ON public.audit_logs USING btree (entity, "entityId");

CREATE INDEX "audit_logs_userId_action_idx" ON public.audit_logs USING btree ("userId", action);

CREATE INDEX "audit_logs_userId_idx" ON public.audit_logs USING btree ("userId");

CREATE INDEX "branches_companyId_idx" ON public.branches USING btree ("companyId");

CREATE INDEX "cash_movements_cashRegisterId_idx" ON public.cash_movements USING btree ("cashRegisterId");

CREATE INDEX "cash_movements_createdAt_idx" ON public.cash_movements USING btree ("createdAt");

CREATE INDEX "cash_movements_movementType_idx" ON public.cash_movements USING btree ("movementType");

CREATE INDEX "cash_movements_referenceType_referenceId_idx" ON public.cash_movements USING btree ("referenceType", "referenceId");

CREATE INDEX "cash_registers_branchId_idx" ON public.cash_registers USING btree ("branchId");

CREATE INDEX "cash_registers_branchId_status_idx" ON public.cash_registers USING btree ("branchId", status);

CREATE INDEX "cash_registers_companyId_idx" ON public.cash_registers USING btree ("companyId");

CREATE UNIQUE INDEX cash_registers_one_open_per_branch_register_number ON public.cash_registers USING btree ("branchId", "registerNumber") WHERE (status = 'OPEN'::public."CashRegisterStatus");

CREATE UNIQUE INDEX cash_registers_one_open_per_user ON public.cash_registers USING btree ("userId") WHERE (status = 'OPEN'::public."CashRegisterStatus");

CREATE INDEX "cash_registers_openedAt_idx" ON public.cash_registers USING btree ("openedAt");

CREATE INDEX cash_registers_status_idx ON public.cash_registers USING btree (status);

CREATE INDEX "cash_registers_userId_idx" ON public.cash_registers USING btree ("userId");

CREATE INDEX "cash_registers_userId_status_idx" ON public.cash_registers USING btree ("userId", status);

CREATE INDEX "categories_companyId_idx" ON public.categories USING btree ("companyId");

CREATE INDEX "categories_parentId_idx" ON public.categories USING btree ("parentId");

CREATE UNIQUE INDEX "combo_items_comboId_productId_key" ON public.combo_items USING btree ("comboId", "productId");

CREATE INDEX "commission_rules_companyId_idx" ON public.commission_rules USING btree ("companyId");

CREATE INDEX "commission_rules_isActive_idx" ON public.commission_rules USING btree ("isActive");

CREATE UNIQUE INDEX companies_document_key ON public.companies USING btree (document);

CREATE INDEX "companies_isActive_createdAt_idx" ON public.companies USING btree ("isActive", "createdAt");

CREATE UNIQUE INDEX "customers_companyId_document_key" ON public.customers USING btree ("companyId", document);

CREATE INDEX "customers_companyId_idx" ON public.customers USING btree ("companyId");

CREATE INDEX customers_document_idx ON public.customers USING btree (document);

CREATE INDEX customers_email_idx ON public.customers USING btree (email);

CREATE INDEX "customers_isActive_idx" ON public.customers USING btree ("isActive");

CREATE INDEX customers_mobile_idx ON public.customers USING btree (mobile);

CREATE INDEX customers_phone_idx ON public.customers USING btree (phone);

CREATE INDEX "damage_records_branchId_idx" ON public.damage_records USING btree ("branchId");

CREATE INDEX "damage_records_companyId_idx" ON public.damage_records USING btree ("companyId");

CREATE INDEX "damage_records_isReversed_idx" ON public.damage_records USING btree ("isReversed");

CREATE INDEX "damage_records_productId_idx" ON public.damage_records USING btree ("productId");

CREATE INDEX "damage_records_recordedAt_idx" ON public.damage_records USING btree ("recordedAt");

CREATE INDEX "device_sessions_companyId_idx" ON public.device_sessions USING btree ("companyId");

CREATE INDEX "device_sessions_deviceId_idx" ON public.device_sessions USING btree ("deviceId");

CREATE UNIQUE INDEX device_sessions_one_active_per_device ON public.device_sessions USING btree ("deviceId") WHERE (status = 'ACTIVE'::public."DeviceSessionStatus");

CREATE UNIQUE INDEX device_sessions_one_active_per_user ON public.device_sessions USING btree ("userId") WHERE (status = 'ACTIVE'::public."DeviceSessionStatus");

CREATE INDEX device_sessions_status_idx ON public.device_sessions USING btree (status);

CREATE INDEX "device_sessions_userId_idx" ON public.device_sessions USING btree ("userId");

CREATE INDEX "devices_lastSeenAt_idx" ON public.devices USING btree ("lastSeenAt");

CREATE INDEX "devices_licenseId_idx" ON public.devices USING btree ("licenseId");

CREATE INDEX devices_status_idx ON public.devices USING btree (status);

CREATE INDEX "discount_rules_companyId_idx" ON public.discount_rules USING btree ("companyId");

CREATE INDEX "discount_rules_roleId_idx" ON public.discount_rules USING btree ("roleId");

CREATE INDEX "discount_rules_userType_idx" ON public.discount_rules USING btree ("userType");

CREATE INDEX "fiscal_configs_branchId_idx" ON public.fiscal_configs USING btree ("branchId");

CREATE UNIQUE INDEX "fiscal_configs_companyId_branchId_key" ON public.fiscal_configs USING btree ("companyId", "branchId");

CREATE INDEX "fiscal_configs_companyId_idx" ON public.fiscal_configs USING btree ("companyId");

CREATE INDEX "fiscal_documents_accessKey_idx" ON public.fiscal_documents USING btree ("accessKey");

CREATE UNIQUE INDEX "fiscal_documents_accessKey_key" ON public.fiscal_documents USING btree ("accessKey");

CREATE INDEX "fiscal_documents_branchId_idx" ON public.fiscal_documents USING btree ("branchId");

CREATE UNIQUE INDEX "fiscal_documents_companyId_branchId_documentType_series_num_key" ON public.fiscal_documents USING btree ("companyId", "branchId", "documentType", series, number);

CREATE INDEX "fiscal_documents_companyId_idx" ON public.fiscal_documents USING btree ("companyId");

CREATE INDEX "fiscal_documents_issuedAt_idx" ON public.fiscal_documents USING btree ("issuedAt");

CREATE INDEX "fiscal_documents_saleId_idx" ON public.fiscal_documents USING btree ("saleId");

CREATE INDEX "fiscal_documents_serviceOrderId_idx" ON public.fiscal_documents USING btree ("serviceOrderId");

CREATE INDEX fiscal_documents_status_idx ON public.fiscal_documents USING btree (status);

CREATE UNIQUE INDEX "idempotency_keys_companyId_endpoint_key_key" ON public.idempotency_keys USING btree ("companyId", endpoint, key);

CREATE INDEX "idempotency_keys_expiresAt_idx" ON public.idempotency_keys USING btree ("expiresAt");

CREATE UNIQUE INDEX "installment_policies_companyId_branchId_paymentMethod_key" ON public.installment_policies USING btree ("companyId", "branchId", "paymentMethod");

CREATE INDEX "installment_policies_companyId_idx" ON public.installment_policies USING btree ("companyId");

CREATE INDEX "inventories_branchId_idx" ON public.inventories USING btree ("branchId");

CREATE UNIQUE INDEX "inventories_branchId_inventoryNumber_key" ON public.inventories USING btree ("branchId", "inventoryNumber");

CREATE INDEX "inventories_companyId_idx" ON public.inventories USING btree ("companyId");

CREATE INDEX "inventories_startedAt_idx" ON public.inventories USING btree ("startedAt");

CREATE INDEX inventories_status_idx ON public.inventories USING btree (status);

CREATE INDEX "inventory_counts_inventoryId_idx" ON public.inventory_counts USING btree ("inventoryId");

CREATE UNIQUE INDEX "inventory_counts_inventoryId_productId_key" ON public.inventory_counts USING btree ("inventoryId", "productId");

CREATE INDEX "inventory_counts_productId_idx" ON public.inventory_counts USING btree ("productId");

CREATE INDEX "invoices_accessKey_idx" ON public.invoices USING btree ("accessKey");

CREATE UNIQUE INDEX "invoices_accessKey_key" ON public.invoices USING btree ("accessKey");

CREATE INDEX "invoices_companyId_idx" ON public.invoices USING btree ("companyId");

CREATE UNIQUE INDEX "invoices_companyId_supplierId_invoiceNumber_series_key" ON public.invoices USING btree ("companyId", "supplierId", "invoiceNumber", series);

CREATE INDEX "invoices_issueDate_idx" ON public.invoices USING btree ("issueDate");

CREATE INDEX "invoices_purchaseOrderId_idx" ON public.invoices USING btree ("purchaseOrderId");

CREATE INDEX "invoices_supplierId_idx" ON public.invoices USING btree ("supplierId");

CREATE INDEX "licenses_companyId_idx" ON public.licenses USING btree ("companyId");

CREATE INDEX "licenses_companyId_status_idx" ON public.licenses USING btree ("companyId", status);

CREATE INDEX "licenses_expiryDate_idx" ON public.licenses USING btree ("expiryDate");

CREATE INDEX "licenses_status_expiryDate_idx" ON public.licenses USING btree (status, "expiryDate");

CREATE INDEX licenses_status_idx ON public.licenses USING btree (status);

CREATE INDEX "mechanic_commissions_companyId_idx" ON public.mechanic_commissions USING btree ("companyId");

CREATE INDEX "mechanic_commissions_isPaid_idx" ON public.mechanic_commissions USING btree ("isPaid");

CREATE INDEX "mechanic_commissions_mechanicId_idx" ON public.mechanic_commissions USING btree ("mechanicId");

CREATE INDEX "mechanic_commissions_serviceOrderId_idx" ON public.mechanic_commissions USING btree ("serviceOrderId");

CREATE INDEX "motorcycles_companyId_idx" ON public.motorcycles USING btree ("companyId");

CREATE UNIQUE INDEX "motorcycles_companyId_licensePlate_key" ON public.motorcycles USING btree ("companyId", "licensePlate");

CREATE INDEX "motorcycles_customerId_idx" ON public.motorcycles USING btree ("customerId");

CREATE INDEX "motorcycles_isActive_idx" ON public.motorcycles USING btree ("isActive");

CREATE INDEX "motorcycles_licensePlate_idx" ON public.motorcycles USING btree ("licensePlate");

CREATE INDEX "motorcycles_vehicleType_idx" ON public.motorcycles USING btree ("vehicleType");

CREATE INDEX "partners_branchId_idx" ON public.partners USING btree ("branchId");

CREATE INDEX "partners_companyId_idx" ON public.partners USING btree ("companyId");

CREATE UNIQUE INDEX "partners_companyId_name_key" ON public.partners USING btree ("companyId", name);

CREATE INDEX "payments_companyId_idx" ON public.payments USING btree ("companyId");

CREATE INDEX "payments_paidAt_idx" ON public.payments USING btree ("paidAt");

CREATE INDEX "payments_paymentMethod_idx" ON public.payments USING btree ("paymentMethod");

CREATE INDEX "payments_saleId_idx" ON public.payments USING btree ("saleId");

CREATE INDEX "payments_saleId_status_idx" ON public.payments USING btree ("saleId", status);

CREATE INDEX payments_status_idx ON public.payments USING btree (status);

CREATE INDEX "payments_transactionId_idx" ON public.payments USING btree ("transactionId");

CREATE UNIQUE INDEX "payments_transactionId_key" ON public.payments USING btree ("transactionId");

CREATE UNIQUE INDEX "permissions_companyId_name_key" ON public.permissions USING btree ("companyId", name);

CREATE INDEX products_barcode_idx ON public.products USING btree (barcode);

CREATE INDEX "products_branchId_idx" ON public.products USING btree ("branchId");

CREATE INDEX "products_categoryId_idx" ON public.products USING btree ("categoryId");

CREATE INDEX "products_companyId_idx" ON public.products USING btree ("companyId");

CREATE INDEX "products_companyId_isActive_idx" ON public.products USING btree ("companyId", "isActive");

CREATE UNIQUE INDEX "products_companyId_sku_key" ON public.products USING btree ("companyId", sku);

CREATE INDEX "products_isActive_idx" ON public.products USING btree ("isActive");

CREATE INDEX products_sku_idx ON public.products USING btree (sku);

CREATE INDEX "purchase_order_items_productId_idx" ON public.purchase_order_items USING btree ("productId");

CREATE INDEX "purchase_order_items_purchaseOrderId_idx" ON public.purchase_order_items USING btree ("purchaseOrderId");

CREATE INDEX "purchase_orders_branchId_idx" ON public.purchase_orders USING btree ("branchId");

CREATE UNIQUE INDEX "purchase_orders_companyId_branchId_poNumber_key" ON public.purchase_orders USING btree ("companyId", "branchId", "poNumber");

CREATE INDEX "purchase_orders_companyId_idx" ON public.purchase_orders USING btree ("companyId");

CREATE INDEX "purchase_orders_orderDate_idx" ON public.purchase_orders USING btree ("orderDate");

CREATE INDEX purchase_orders_status_idx ON public.purchase_orders USING btree (status);

CREATE INDEX "purchase_orders_supplierId_idx" ON public.purchase_orders USING btree ("supplierId");

CREATE INDEX "quote_items_quoteVersionId_idx" ON public.quote_items USING btree ("quoteVersionId");

CREATE INDEX "quote_versions_quoteId_idx" ON public.quote_versions USING btree ("quoteId");

CREATE UNIQUE INDEX "quote_versions_quoteId_versionNumber_key" ON public.quote_versions USING btree ("quoteId", "versionNumber");

CREATE INDEX "quotes_branchId_idx" ON public.quotes USING btree ("branchId");

CREATE INDEX "quotes_companyId_idx" ON public.quotes USING btree ("companyId");

CREATE UNIQUE INDEX "quotes_companyId_quoteNumber_key" ON public.quotes USING btree ("companyId", "quoteNumber");

CREATE INDEX "quotes_customerId_idx" ON public.quotes USING btree ("customerId");

CREATE INDEX "quotes_motorcycleId_idx" ON public.quotes USING btree ("motorcycleId");

CREATE INDEX quotes_status_idx ON public.quotes USING btree (status);

CREATE INDEX "refresh_tokens_companyId_userId_idx" ON public.refresh_tokens USING btree ("companyId", "userId");

CREATE INDEX refresh_tokens_token_idx ON public.refresh_tokens USING btree (token);

CREATE UNIQUE INDEX refresh_tokens_token_key ON public.refresh_tokens USING btree (token);

CREATE INDEX "refresh_tokens_userId_idx" ON public.refresh_tokens USING btree ("userId");

CREATE INDEX "request_logs_companyId_createdAt_idx" ON public.request_logs USING btree ("companyId", "createdAt");

CREATE INDEX "request_logs_createdAt_idx" ON public.request_logs USING btree ("createdAt");

CREATE UNIQUE INDEX "request_logs_requestId_key" ON public.request_logs USING btree ("requestId");

CREATE INDEX "request_logs_route_createdAt_idx" ON public.request_logs USING btree (route, "createdAt");

CREATE INDEX "request_logs_statusCode_createdAt_idx" ON public.request_logs USING btree ("statusCode", "createdAt");

CREATE UNIQUE INDEX "role_permissions_roleId_permissionId_key" ON public.role_permissions USING btree ("roleId", "permissionId");

CREATE UNIQUE INDEX "roles_companyId_name_key" ON public.roles USING btree ("companyId", name);

CREATE INDEX "sale_items_productId_idx" ON public.sale_items USING btree ("productId");

CREATE INDEX "sale_items_saleId_idx" ON public.sale_items USING btree ("saleId");

CREATE INDEX "sales_branchId_idx" ON public.sales USING btree ("branchId");

CREATE INDEX "sales_branchId_saleDate_idx" ON public.sales USING btree ("branchId", "saleDate");

CREATE INDEX "sales_cashRegisterId_idx" ON public.sales USING btree ("cashRegisterId");

CREATE UNIQUE INDEX "sales_companyId_branchId_saleNumber_key" ON public.sales USING btree ("companyId", "branchId", "saleNumber");

CREATE INDEX "sales_companyId_idx" ON public.sales USING btree ("companyId");

CREATE INDEX "sales_companyId_saleDate_idx" ON public.sales USING btree ("companyId", "saleDate");

CREATE INDEX "sales_companyId_status_idx" ON public.sales USING btree ("companyId", status);

CREATE INDEX "sales_customerId_idx" ON public.sales USING btree ("customerId");

CREATE INDEX "sales_partnerId_idx" ON public.sales USING btree ("partnerId");

CREATE INDEX "sales_saleDate_idx" ON public.sales USING btree ("saleDate");

CREATE INDEX sales_status_idx ON public.sales USING btree (status);

CREATE INDEX "sales_userId_idx" ON public.sales USING btree ("userId");

CREATE INDEX "service_order_items_productId_idx" ON public.service_order_items USING btree ("productId");

CREATE INDEX "service_order_items_serviceOrderId_idx" ON public.service_order_items USING btree ("serviceOrderId");

CREATE INDEX "service_order_status_history_changedAt_idx" ON public.service_order_status_history USING btree ("changedAt");

CREATE INDEX "service_order_status_history_serviceOrderId_idx" ON public.service_order_status_history USING btree ("serviceOrderId");

CREATE INDEX "service_orders_branchId_idx" ON public.service_orders USING btree ("branchId");

CREATE UNIQUE INDEX "service_orders_branchId_osNumber_key" ON public.service_orders USING btree ("branchId", "osNumber");

CREATE INDEX "service_orders_companyId_idx" ON public.service_orders USING btree ("companyId");

CREATE INDEX "service_orders_customerId_idx" ON public.service_orders USING btree ("customerId");

CREATE INDEX "service_orders_entryDate_idx" ON public.service_orders USING btree ("entryDate");

CREATE INDEX "service_orders_mechanicId_idx" ON public.service_orders USING btree ("mechanicId");

CREATE INDEX "service_orders_motorcycleId_idx" ON public.service_orders USING btree ("motorcycleId");

CREATE UNIQUE INDEX "service_orders_quoteVersionId_key" ON public.service_orders USING btree ("quoteVersionId");

CREATE INDEX service_orders_status_idx ON public.service_orders USING btree (status);

CREATE INDEX "stock_movements_branchId_idx" ON public.stock_movements USING btree ("branchId");

CREATE INDEX "stock_movements_branchId_productId_idx" ON public.stock_movements USING btree ("branchId", "productId");

CREATE INDEX "stock_movements_companyId_idx" ON public.stock_movements USING btree ("companyId");

CREATE INDEX "stock_movements_createdAt_idx" ON public.stock_movements USING btree ("createdAt");

CREATE INDEX "stock_movements_movementType_idx" ON public.stock_movements USING btree ("movementType");

CREATE INDEX "stock_movements_productId_createdAt_idx" ON public.stock_movements USING btree ("productId", "createdAt");

CREATE INDEX "stock_movements_productId_idx" ON public.stock_movements USING btree ("productId");

CREATE INDEX "stock_movements_referenceType_referenceId_idx" ON public.stock_movements USING btree ("referenceType", "referenceId");

CREATE UNIQUE INDEX "suppliers_companyId_document_key" ON public.suppliers USING btree ("companyId", document);

CREATE INDEX "suppliers_companyId_idx" ON public.suppliers USING btree ("companyId");

CREATE INDEX suppliers_document_idx ON public.suppliers USING btree (document);

CREATE INDEX "suppliers_isActive_idx" ON public.suppliers USING btree ("isActive");

CREATE INDEX "system_logs_category_createdAt_idx" ON public.system_logs USING btree (category, "createdAt");

CREATE INDEX "system_logs_companyId_createdAt_idx" ON public.system_logs USING btree ("companyId", "createdAt");

CREATE INDEX "system_logs_createdAt_idx" ON public.system_logs USING btree ("createdAt");

CREATE INDEX "system_logs_level_createdAt_idx" ON public.system_logs USING btree (level, "createdAt");

CREATE INDEX "system_logs_requestId_idx" ON public.system_logs USING btree ("requestId");

CREATE INDEX "tef_payments_companyId_idx" ON public.tef_payments USING btree ("companyId");

CREATE INDEX "tef_payments_paymentId_idx" ON public.tef_payments USING btree ("paymentId");

CREATE UNIQUE INDEX "tef_payments_provider_transactionId_key" ON public.tef_payments USING btree (provider, "transactionId");

CREATE INDEX "tef_payments_requestedAt_idx" ON public.tef_payments USING btree ("requestedAt");

CREATE INDEX "tef_payments_saleId_idx" ON public.tef_payments USING btree ("saleId");

CREATE INDEX "tef_payments_serviceOrderId_idx" ON public.tef_payments USING btree ("serviceOrderId");

CREATE INDEX tef_payments_status_idx ON public.tef_payments USING btree (status);

CREATE INDEX "tef_payments_transactionId_idx" ON public.tef_payments USING btree ("transactionId");

CREATE INDEX "transfer_items_productId_idx" ON public.transfer_items USING btree ("productId");

CREATE INDEX "transfer_items_transferId_idx" ON public.transfer_items USING btree ("transferId");

CREATE INDEX "transfers_companyId_idx" ON public.transfers USING btree ("companyId");

CREATE UNIQUE INDEX "transfers_companyId_transferNumber_key" ON public.transfers USING btree ("companyId", "transferNumber");

CREATE INDEX "transfers_fromBranchId_idx" ON public.transfers USING btree ("fromBranchId");

CREATE INDEX "transfers_requestedAt_idx" ON public.transfers USING btree ("requestedAt");

CREATE INDEX transfers_status_idx ON public.transfers USING btree (status);

CREATE INDEX "transfers_toBranchId_idx" ON public.transfers USING btree ("toBranchId");

CREATE UNIQUE INDEX "user_roles_userId_roleId_branchId_key" ON public.user_roles USING btree ("userId", "roleId", "branchId");

CREATE INDEX "users_branchId_idx" ON public.users USING btree ("branchId");

CREATE INDEX "users_companyId_idx" ON public.users USING btree ("companyId");

CREATE INDEX "users_companyId_isActive_idx" ON public.users USING btree ("companyId", "isActive");

CREATE INDEX users_email_idx ON public.users USING btree (email);

CREATE UNIQUE INDEX users_email_key ON public.users USING btree (email);

CREATE INDEX "users_isActive_idx" ON public.users USING btree ("isActive");

CREATE UNIQUE INDEX "users_numericId_key" ON public.users USING btree ("numericId");

CREATE INDEX "vehicle_entry_checklist_items_checklistId_idx" ON public.vehicle_entry_checklist_items USING btree ("checklistId");

CREATE INDEX "vehicle_entry_checklists_companyId_idx" ON public.vehicle_entry_checklists USING btree ("companyId");

CREATE INDEX "vehicle_entry_checklists_motorcycleId_idx" ON public.vehicle_entry_checklists USING btree ("motorcycleId");

CREATE UNIQUE INDEX "vehicle_entry_checklists_serviceOrderId_key" ON public.vehicle_entry_checklists USING btree ("serviceOrderId");

-- ============================================================================
-- RLS HELPER FUNCTIONS
-- ============================================================================

CREATE FUNCTION public.get_current_branch_id() RETURNS text
    LANGUAGE sql STABLE
    AS $$
  SELECT NULLIF(current_setting('app.current_branch_id', TRUE), '');
$$;

CREATE FUNCTION public.get_current_company_id() RETURNS text
    LANGUAGE sql STABLE
    AS $$
  SELECT NULLIF(current_setting('app.current_company_id', TRUE), '');
$$;

CREATE FUNCTION public.get_current_user_type() RETURNS text
    LANGUAGE sql STABLE
    AS $$
  SELECT NULLIF(current_setting('app.user_type', TRUE), '');
$$;

CREATE FUNCTION public.is_company_wide_role() RETURNS boolean
    LANGUAGE sql STABLE
    AS $$
  SELECT get_current_user_type() IN ('SUPER_ADMIN', 'COMPANY_ADMIN');
$$;

CREATE FUNCTION public.is_super_admin() RETURNS boolean
    LANGUAGE sql STABLE
    AS $$
  SELECT get_current_user_type() = 'SUPER_ADMIN';
$$;

-- rls_company_match must be defined before rls_company_branch_match, which
-- calls it — these were originally assembled in plain alphabetical order,
-- which happens to put the caller before the callee ("branch_match" <
-- "match"). SQL-language functions are validated at CREATE time (unlike
-- plpgsql, which only checks at call time), so the wrong order fails
-- migrate deploy outright rather than failing later at query time.
CREATE FUNCTION public.rls_company_match(row_company_id text) RETURNS boolean
    LANGUAGE sql STABLE
    AS $$
  SELECT is_super_admin() OR row_company_id = get_current_company_id();
$$;

CREATE FUNCTION public.rls_company_branch_match(row_company_id text, row_branch_id text) RETURNS boolean
    LANGUAGE sql STABLE
    AS $$
  SELECT rls_company_match(row_company_id)
    AND (
      is_super_admin()
      OR is_company_wide_role()
      OR row_branch_id IS NULL
      OR row_branch_id = get_current_branch_id()
    );
$$;

-- ============================================================================
-- RLS ENABLE
-- ============================================================================

ALTER TABLE public.accounts_payable ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.accounts_payable FORCE ROW LEVEL SECURITY;

ALTER TABLE public.accounts_receivable ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.accounts_receivable FORCE ROW LEVEL SECURITY;

ALTER TABLE public.activations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.activations FORCE ROW LEVEL SECURITY;

ALTER TABLE public.audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_logs FORCE ROW LEVEL SECURITY;

ALTER TABLE public.branches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.branches FORCE ROW LEVEL SECURITY;

ALTER TABLE public.cash_movements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cash_movements FORCE ROW LEVEL SECURITY;

ALTER TABLE public.cash_registers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cash_registers FORCE ROW LEVEL SECURITY;

ALTER TABLE public.categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.categories FORCE ROW LEVEL SECURITY;

ALTER TABLE public.combo_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.combo_items FORCE ROW LEVEL SECURITY;

ALTER TABLE public.commission_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.commission_rules FORCE ROW LEVEL SECURITY;

ALTER TABLE public.companies ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.companies FORCE ROW LEVEL SECURITY;

ALTER TABLE public.customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.customers FORCE ROW LEVEL SECURITY;

ALTER TABLE public.damage_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.damage_records FORCE ROW LEVEL SECURITY;

ALTER TABLE public.device_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.device_sessions FORCE ROW LEVEL SECURITY;

ALTER TABLE public.devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.devices FORCE ROW LEVEL SECURITY;

ALTER TABLE public.discount_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.discount_rules FORCE ROW LEVEL SECURITY;

ALTER TABLE public.fiscal_configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fiscal_configs FORCE ROW LEVEL SECURITY;

ALTER TABLE public.fiscal_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fiscal_documents FORCE ROW LEVEL SECURITY;

ALTER TABLE public.idempotency_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.idempotency_keys FORCE ROW LEVEL SECURITY;

ALTER TABLE public.installment_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.installment_policies FORCE ROW LEVEL SECURITY;

ALTER TABLE public.inventories ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inventories FORCE ROW LEVEL SECURITY;

ALTER TABLE public.inventory_counts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inventory_counts FORCE ROW LEVEL SECURITY;

ALTER TABLE public.invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.invoices FORCE ROW LEVEL SECURITY;

ALTER TABLE public.licenses ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.licenses FORCE ROW LEVEL SECURITY;

ALTER TABLE public.mechanic_commissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mechanic_commissions FORCE ROW LEVEL SECURITY;

ALTER TABLE public.motorcycles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.motorcycles FORCE ROW LEVEL SECURITY;

ALTER TABLE public.partners ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.partners FORCE ROW LEVEL SECURITY;

ALTER TABLE public.payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payments FORCE ROW LEVEL SECURITY;

ALTER TABLE public.permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.permissions FORCE ROW LEVEL SECURITY;

ALTER TABLE public.products ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.products FORCE ROW LEVEL SECURITY;

ALTER TABLE public.purchase_order_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.purchase_order_items FORCE ROW LEVEL SECURITY;

ALTER TABLE public.purchase_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.purchase_orders FORCE ROW LEVEL SECURITY;

ALTER TABLE public.quote_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.quote_items FORCE ROW LEVEL SECURITY;

ALTER TABLE public.quote_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.quote_versions FORCE ROW LEVEL SECURITY;

ALTER TABLE public.quotes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.quotes FORCE ROW LEVEL SECURITY;

ALTER TABLE public.refresh_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.refresh_tokens FORCE ROW LEVEL SECURITY;

ALTER TABLE public.request_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.request_logs FORCE ROW LEVEL SECURITY;

ALTER TABLE public.role_permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.role_permissions FORCE ROW LEVEL SECURITY;

ALTER TABLE public.roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.roles FORCE ROW LEVEL SECURITY;

ALTER TABLE public.sale_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sale_items FORCE ROW LEVEL SECURITY;

ALTER TABLE public.sales ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sales FORCE ROW LEVEL SECURITY;

ALTER TABLE public.service_order_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.service_order_items FORCE ROW LEVEL SECURITY;

ALTER TABLE public.service_order_status_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.service_order_status_history FORCE ROW LEVEL SECURITY;

ALTER TABLE public.service_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.service_orders FORCE ROW LEVEL SECURITY;

ALTER TABLE public.stock_movements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.stock_movements FORCE ROW LEVEL SECURITY;

ALTER TABLE public.suppliers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.suppliers FORCE ROW LEVEL SECURITY;

ALTER TABLE public.system_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.system_logs FORCE ROW LEVEL SECURITY;

ALTER TABLE public.tef_payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tef_payments FORCE ROW LEVEL SECURITY;

ALTER TABLE public.transfer_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.transfer_items FORCE ROW LEVEL SECURITY;

ALTER TABLE public.transfers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.transfers FORCE ROW LEVEL SECURITY;

ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_roles FORCE ROW LEVEL SECURITY;

ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.users FORCE ROW LEVEL SECURITY;

ALTER TABLE public.vehicle_entry_checklist_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.vehicle_entry_checklist_items FORCE ROW LEVEL SECURITY;

ALTER TABLE public.vehicle_entry_checklists ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.vehicle_entry_checklists FORCE ROW LEVEL SECURITY;

-- ============================================================================
-- RLS POLICIES
-- ============================================================================

CREATE POLICY accounts_payable_isolation ON public.accounts_payable USING (public.rls_company_match("companyId")) WITH CHECK (public.rls_company_match("companyId"));

CREATE POLICY accounts_receivable_isolation ON public.accounts_receivable USING (public.rls_company_match("companyId")) WITH CHECK (public.rls_company_match("companyId"));

CREATE POLICY activations_isolation ON public.activations USING ((public.is_super_admin() OR ("licenseId" IN ( SELECT licenses.id
   FROM public.licenses
  WHERE (licenses."companyId" = public.get_current_company_id()))))) WITH CHECK ((public.is_super_admin() OR ("licenseId" IN ( SELECT licenses.id
   FROM public.licenses
  WHERE (licenses."companyId" = public.get_current_company_id())))));

CREATE POLICY audit_logs_isolation ON public.audit_logs USING ((public.is_super_admin() OR ("companyId" = public.get_current_company_id()))) WITH CHECK ((public.is_super_admin() OR ("companyId" = public.get_current_company_id()) OR ("companyId" IS NULL)));

CREATE POLICY branches_isolation ON public.branches USING (public.rls_company_branch_match("companyId", id)) WITH CHECK (public.rls_company_match("companyId"));

CREATE POLICY cash_movements_isolation ON public.cash_movements USING (("cashRegisterId" IN ( SELECT cash_registers.id
   FROM public.cash_registers))) WITH CHECK (("cashRegisterId" IN ( SELECT cash_registers.id
   FROM public.cash_registers)));

CREATE POLICY cash_registers_isolation ON public.cash_registers USING (public.rls_company_branch_match("companyId", "branchId")) WITH CHECK (public.rls_company_branch_match("companyId", "branchId"));

CREATE POLICY categories_isolation ON public.categories USING (public.rls_company_match("companyId")) WITH CHECK (public.rls_company_match("companyId"));

CREATE POLICY combo_items_isolation ON public.combo_items USING (("comboId" IN ( SELECT products.id
   FROM public.products))) WITH CHECK (("comboId" IN ( SELECT products.id
   FROM public.products)));

CREATE POLICY commission_rules_isolation ON public.commission_rules USING (public.rls_company_match("companyId")) WITH CHECK (public.rls_company_match("companyId"));

CREATE POLICY companies_isolation ON public.companies USING ((public.is_super_admin() OR (id = public.get_current_company_id()))) WITH CHECK (public.is_super_admin());

CREATE POLICY customers_isolation ON public.customers USING (public.rls_company_match("companyId")) WITH CHECK (public.rls_company_match("companyId"));

CREATE POLICY damage_records_isolation ON public.damage_records USING (public.rls_company_branch_match("companyId", "branchId")) WITH CHECK (public.rls_company_branch_match("companyId", "branchId"));

CREATE POLICY device_sessions_isolation ON public.device_sessions USING (public.rls_company_branch_match("companyId", "branchId")) WITH CHECK (public.rls_company_branch_match("companyId", "branchId"));

CREATE POLICY devices_isolation ON public.devices USING ((public.is_super_admin() OR ("licenseId" IN ( SELECT licenses.id
   FROM public.licenses
  WHERE (licenses."companyId" = public.get_current_company_id()))))) WITH CHECK ((public.is_super_admin() OR ("licenseId" IN ( SELECT licenses.id
   FROM public.licenses
  WHERE (licenses."companyId" = public.get_current_company_id())))));

CREATE POLICY discount_rules_isolation ON public.discount_rules USING (public.rls_company_match("companyId")) WITH CHECK (public.rls_company_match("companyId"));

CREATE POLICY fiscal_configs_isolation ON public.fiscal_configs USING (public.rls_company_branch_match("companyId", "branchId")) WITH CHECK (public.rls_company_branch_match("companyId", "branchId"));

CREATE POLICY fiscal_documents_isolation ON public.fiscal_documents USING (public.rls_company_branch_match("companyId", "branchId")) WITH CHECK (public.rls_company_branch_match("companyId", "branchId"));

CREATE POLICY idempotency_keys_isolation ON public.idempotency_keys USING (public.rls_company_match("companyId")) WITH CHECK (public.rls_company_match("companyId"));

CREATE POLICY installment_policies_isolation ON public.installment_policies USING (public.rls_company_match("companyId")) WITH CHECK (public.rls_company_match("companyId"));

CREATE POLICY inventories_isolation ON public.inventories USING (public.rls_company_branch_match("companyId", "branchId")) WITH CHECK (public.rls_company_branch_match("companyId", "branchId"));

CREATE POLICY inventory_counts_isolation ON public.inventory_counts USING (("inventoryId" IN ( SELECT inventories.id
   FROM public.inventories))) WITH CHECK (("inventoryId" IN ( SELECT inventories.id
   FROM public.inventories)));

CREATE POLICY invoices_isolation ON public.invoices USING (public.rls_company_match("companyId")) WITH CHECK (public.rls_company_match("companyId"));

CREATE POLICY licenses_isolation ON public.licenses USING ((public.is_super_admin() OR ("companyId" = public.get_current_company_id()))) WITH CHECK (public.is_super_admin());

CREATE POLICY mechanic_commissions_isolation ON public.mechanic_commissions USING (public.rls_company_match("companyId")) WITH CHECK (public.rls_company_match("companyId"));

CREATE POLICY motorcycles_isolation ON public.motorcycles USING (public.rls_company_match("companyId")) WITH CHECK (public.rls_company_match("companyId"));

CREATE POLICY partners_isolation ON public.partners USING (public.rls_company_match("companyId")) WITH CHECK (public.rls_company_match("companyId"));

CREATE POLICY payments_isolation ON public.payments USING (public.rls_company_match("companyId")) WITH CHECK (public.rls_company_match("companyId"));

CREATE POLICY permissions_isolation ON public.permissions USING ((public.is_super_admin() OR ("companyId" = public.get_current_company_id()) OR ("companyId" IS NULL))) WITH CHECK ((public.is_super_admin() OR ("companyId" = public.get_current_company_id())));

CREATE POLICY products_isolation ON public.products USING (public.rls_company_branch_match("companyId", "branchId")) WITH CHECK (public.rls_company_branch_match("companyId", "branchId"));

CREATE POLICY purchase_order_items_isolation ON public.purchase_order_items USING (("purchaseOrderId" IN ( SELECT purchase_orders.id
   FROM public.purchase_orders))) WITH CHECK (("purchaseOrderId" IN ( SELECT purchase_orders.id
   FROM public.purchase_orders)));

CREATE POLICY purchase_orders_isolation ON public.purchase_orders USING (public.rls_company_branch_match("companyId", "branchId")) WITH CHECK (public.rls_company_branch_match("companyId", "branchId"));

CREATE POLICY quote_items_isolation ON public.quote_items USING (("quoteVersionId" IN ( SELECT quote_versions.id
   FROM public.quote_versions))) WITH CHECK (("quoteVersionId" IN ( SELECT quote_versions.id
   FROM public.quote_versions)));

CREATE POLICY quote_versions_isolation ON public.quote_versions USING (("quoteId" IN ( SELECT quotes.id
   FROM public.quotes))) WITH CHECK (("quoteId" IN ( SELECT quotes.id
   FROM public.quotes)));

CREATE POLICY quotes_isolation ON public.quotes USING (public.rls_company_branch_match("companyId", "branchId")) WITH CHECK (public.rls_company_branch_match("companyId", "branchId"));

CREATE POLICY refresh_tokens_isolation ON public.refresh_tokens USING ((public.is_super_admin() OR ("companyId" = public.get_current_company_id()) OR ("companyId" IS NULL))) WITH CHECK ((public.is_super_admin() OR ("companyId" = public.get_current_company_id()) OR ("companyId" IS NULL)));

CREATE POLICY request_logs_isolation ON public.request_logs USING ((public.is_super_admin() OR ("companyId" = public.get_current_company_id()) OR ("companyId" IS NULL))) WITH CHECK (true);

CREATE POLICY role_permissions_isolation ON public.role_permissions USING (("roleId" IN ( SELECT roles.id
   FROM public.roles))) WITH CHECK (("roleId" IN ( SELECT roles.id
   FROM public.roles)));

CREATE POLICY roles_isolation ON public.roles USING ((public.is_super_admin() OR ("companyId" = public.get_current_company_id()) OR ("companyId" IS NULL))) WITH CHECK ((public.is_super_admin() OR ("companyId" = public.get_current_company_id())));

CREATE POLICY sale_items_isolation ON public.sale_items USING (("saleId" IN ( SELECT sales.id
   FROM public.sales))) WITH CHECK (("saleId" IN ( SELECT sales.id
   FROM public.sales)));

CREATE POLICY sales_isolation ON public.sales USING (public.rls_company_branch_match("companyId", "branchId")) WITH CHECK (public.rls_company_branch_match("companyId", "branchId"));

CREATE POLICY service_order_items_isolation ON public.service_order_items USING (("serviceOrderId" IN ( SELECT service_orders.id
   FROM public.service_orders))) WITH CHECK (("serviceOrderId" IN ( SELECT service_orders.id
   FROM public.service_orders)));

CREATE POLICY service_order_status_history_isolation ON public.service_order_status_history USING (("serviceOrderId" IN ( SELECT service_orders.id
   FROM public.service_orders))) WITH CHECK (("serviceOrderId" IN ( SELECT service_orders.id
   FROM public.service_orders)));

CREATE POLICY service_orders_isolation ON public.service_orders USING (public.rls_company_branch_match("companyId", "branchId")) WITH CHECK (public.rls_company_branch_match("companyId", "branchId"));

CREATE POLICY stock_movements_isolation ON public.stock_movements USING (public.rls_company_branch_match("companyId", "branchId")) WITH CHECK (public.rls_company_branch_match("companyId", "branchId"));

CREATE POLICY suppliers_isolation ON public.suppliers USING (public.rls_company_match("companyId")) WITH CHECK (public.rls_company_match("companyId"));

CREATE POLICY system_logs_isolation ON public.system_logs USING ((public.is_super_admin() OR ("companyId" = public.get_current_company_id()) OR ("companyId" IS NULL))) WITH CHECK (true);

CREATE POLICY tef_payments_isolation ON public.tef_payments USING (public.rls_company_match("companyId")) WITH CHECK (public.rls_company_match("companyId"));

CREATE POLICY transfer_items_isolation ON public.transfer_items USING (("transferId" IN ( SELECT transfers.id
   FROM public.transfers))) WITH CHECK (("transferId" IN ( SELECT transfers.id
   FROM public.transfers)));

CREATE POLICY transfers_isolation ON public.transfers USING (public.rls_company_match("companyId")) WITH CHECK (public.rls_company_match("companyId"));

CREATE POLICY user_roles_isolation ON public.user_roles USING (("userId" IN ( SELECT users.id
   FROM public.users))) WITH CHECK (("userId" IN ( SELECT users.id
   FROM public.users)));

CREATE POLICY users_isolation ON public.users USING ((public.is_super_admin() OR ("companyId" = public.get_current_company_id()) OR ("companyId" IS NULL))) WITH CHECK ((public.is_super_admin() OR ("companyId" = public.get_current_company_id())));

CREATE POLICY vehicle_entry_checklist_items_isolation ON public.vehicle_entry_checklist_items USING (("checklistId" IN ( SELECT vehicle_entry_checklists.id
   FROM public.vehicle_entry_checklists))) WITH CHECK (("checklistId" IN ( SELECT vehicle_entry_checklists.id
   FROM public.vehicle_entry_checklists)));

CREATE POLICY vehicle_entry_checklists_isolation ON public.vehicle_entry_checklists USING (("serviceOrderId" IN ( SELECT service_orders.id
   FROM public.service_orders))) WITH CHECK (("serviceOrderId" IN ( SELECT service_orders.id
   FROM public.service_orders)));
