// Formas das respostas da API oficial que o Balcão lê. Decimal chega do Prisma como STRING ("129.90"): por isso `number | string`.
// Nada aqui é regra: o servidor define estados, totais e permissões.

export type Money = number | string;

export interface AuthUser {
  id: string;
  numericId?: number;
  name: string;
  email?: string;
  userType: string;
  companyId?: string;
  branchId?: string;
  company?: { id: string; name: string };
  branch?: { id: string; name: string };
}

export type LoginResult =
  | { kind: 'ok'; user: AuthUser; accessToken: string; refreshToken: string }
  | { kind: 'mfa'; mfaToken: string };

export interface Pagination {
  page: number;
  limit: number;
  total: number;
  pages?: number;
}

export interface Branch {
  id: string;
  name: string;
  isActive?: boolean;
}

export interface Customer {
  id: string;
  name: string;
  document?: string | null;
  phone?: string | null;
  mobile?: string | null;
  whatsapp?: string | null;
  email?: string | null;
  notes?: string | null;
  isActive?: boolean;
}

export interface CustomerStats {
  customer: Customer;
  stats: { totalPurchases: number; totalSales: number; avgTicket: number; lastPurchase: string | null };
}

export interface Motorcycle {
  id: string;
  customerId: string;
  brand: string;
  model: string;
  licensePlate?: string | null;
  year?: number | null;
  color?: string | null;
  kilometerReading?: Money | null;
  customer?: Customer;
}

export interface Product {
  id: string;
  sku: string;
  barcode?: string | null;
  name: string;
  brand?: string | null;
  unit?: string | null;
  location?: string | null;
  salePrice: Money;
  isActive?: boolean;
}

export interface Availability {
  productId: string;
  branchId: string;
  balance: number;
  reserved: number;
  available: number;
}

export interface QuoteItem {
  id?: string;
  itemType: 'SERVICE' | 'PART';
  productId?: string | null;
  description: string;
  quantity: Money;
  unitPrice: Money;
  totalPrice?: Money;
}

export interface QuoteVersion {
  versionNumber: number;
  totalAmount: Money;
  sentAt?: string | null;
  isApproved?: boolean | null;
  approvedAt?: string | null;
  items?: QuoteItem[];
  serviceOrder?: { id: string; osNumber: number; status: string } | null;
}

export interface Quote {
  id: string;
  quoteNumber: number;
  status: string;
  branchId: string;
  createdAt: string;
  validUntil?: string | null;
  notes?: string | null;
  overdue?: boolean;
  customer?: Pick<Customer, 'id' | 'name' | 'phone'> & Partial<Customer>;
  motorcycle?: Pick<Motorcycle, 'id' | 'brand' | 'model' | 'licensePlate'> & Partial<Motorcycle>;
  versions: QuoteVersion[];
}

export interface ServiceOrder {
  id: string;
  osNumber: number;
  status: string;
  branchId?: string;
  entryDate?: string;
  estimatedDelivery?: string | null;
  finalTotal?: Money;
  laborTotal?: Money;
  partsTotal?: Money;
  customer?: Pick<Customer, 'id' | 'name' | 'phone'> & Partial<Customer>;
  motorcycle?: Pick<Motorcycle, 'id' | 'brand' | 'model' | 'licensePlate'> & Partial<Motorcycle>;
  mechanic?: { id: string; name: string } | null;
  items?: Array<{ id: string; itemType: string; description: string; quantity: Money; unitPrice: Money; totalPrice?: Money }>;
  statusHistory?: Array<{ id?: string; toStatus: string; changedAt: string; notes?: string | null }>;
}

export interface Sale {
  id: string;
  saleNumber: number;
  status: string;
  totalAmount: Money;
  saleDate?: string;
}

export interface QuoteItemPayload {
  itemType: 'SERVICE' | 'PART';
  productId?: string;
  description: string;
  quantity: number;
  unitPrice: number;
}
