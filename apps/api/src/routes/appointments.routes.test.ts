/**
 * ACHADO DE AUDITORIA: nenhum write deste arquivo tinha trava de papel —
 * inclusive VIEWER (papel só-leitura por definição no resto do sistema)
 * conseguia criar/confirmar/reagendar/cancelar/concluir/marcar-no-show
 * qualquer agendamento. Exclui só o VIEWER — confirmar/reagendar/cancelar
 * são fluxos reais do app mobile usado por mecânicos em campo, então
 * restringir a Gerência+ quebraria essas telas (mesmo padrão de
 * customers.routes.ts).
 */

const verifyAccessTokenMock = jest.fn();
jest.mock('../services/branch-scope.service', () => require('../../test/helpers/branch-scope-from-token'));
jest.mock('@ln-system/shared/utils/token', () => ({
  verifyAccessToken: verifyAccessTokenMock,
}));

jest.mock('@ln-system/shared/src/validators/revision.validators', () => ({
  createAppointmentSchema: { parse: (data: any) => data },
  confirmAppointmentSchema: { parse: (data: any) => data },
  rescheduleAppointmentSchema: { parse: (data: any) => ({ ...data, newScheduledAt: data.newScheduledAt ?? new Date().toISOString() }) },
  cancelAppointmentSchema: { parse: (data: any) => data },
  appointmentFilterSchema: { parse: (data: any) => data },
}));

const listMock = jest.fn().mockResolvedValue({ appointments: [], pagination: { page: 1, limit: 20, total: 0, pages: 1 } });
const getByIdMock = jest.fn().mockResolvedValue({ id: 'appt-1' });
const proposeMock = jest.fn().mockResolvedValue({ id: 'appt-new' });
const confirmMock = jest.fn().mockResolvedValue({ id: 'appt-1', status: 'CONFIRMED' });

jest.mock('../services/appointment.service', () => ({
  __esModule: true,
  default: {
    list: (...args: any[]) => listMock(...args),
    getById: (...args: any[]) => getByIdMock(...args),
    propose: (...args: any[]) => proposeMock(...args),
    confirm: (...args: any[]) => confirmMock(...args),
    reschedule: jest.fn().mockResolvedValue({ id: 'appt-1' }),
    cancel: jest.fn().mockResolvedValue({ id: 'appt-1' }),
    complete: jest.fn().mockResolvedValue({ id: 'appt-1' }),
    markNoShow: jest.fn().mockResolvedValue({ id: 'appt-1' }),
  },
}));

jest.mock('@ln-system/database', () => ({
  prisma: { companyModuleSetting: { findMany: jest.fn().mockResolvedValue([]) } },
  runWithRLSContext: (_ctx: any, fn: () => any) => fn(),
  AuditAction: { CREATE: 'CREATE', UPDATE: 'UPDATE' },
}));

jest.mock('../middleware/audit', () => ({
  auditLog: () => (_req: any, _res: any, next: any) => next(),
}));

import express from 'express';
import request from 'supertest';
import appointmentsRoutes from './appointments.routes';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/appointments', appointmentsRoutes);
  return app;
}

beforeEach(() => {
  jest.clearAllMocks();
  listMock.mockResolvedValue({ appointments: [], pagination: { page: 1, limit: 20, total: 0, pages: 1 } });
  getByIdMock.mockResolvedValue({ id: 'appt-1' });
  proposeMock.mockResolvedValue({ id: 'appt-new' });
});

describe('appointments.routes — GET aberto ao tenant, escrita exclui só VIEWER', () => {
  const app = buildApp();

  it('bloqueia VIEWER de criar agendamento (POST) com 403', async () => {
    verifyAccessTokenMock.mockReturnValue({ userId: 'u1', userType: 'VIEWER', companyId: 'company-A' });

    const res = await request(app)
      .post('/api/appointments')
      .set('Authorization', 'Bearer t')
      .send({ customerId: 'c1', scheduledAt: new Date().toISOString() });

    expect(res.status).toBe(403);
    expect(proposeMock).not.toHaveBeenCalled();
  });

  it.each(['OPERATOR', 'MECHANIC'])('permite %s criar (POST) e confirmar (/confirm) agendamento — fluxo real do mobile', async (userType) => {
    verifyAccessTokenMock.mockReturnValue({ userId: 'u1', userType, companyId: 'company-A' });

    const createRes = await request(app)
      .post('/api/appointments')
      .set('Authorization', 'Bearer t')
      .send({ customerId: 'c1', scheduledAt: new Date().toISOString() });
    expect(createRes.status).toBe(201);

    const confirmRes = await request(app).post('/api/appointments/appt-1/confirm').set('Authorization', 'Bearer t').send({});
    expect(confirmRes.status).toBe(200);
  });

  it('NÃO restringe leitura (GET /, GET /:id) — inclusive VIEWER continua consultando agendamentos', async () => {
    verifyAccessTokenMock.mockReturnValue({ userId: 'u1', userType: 'VIEWER', companyId: 'company-A' });

    const listRes = await request(app).get('/api/appointments').set('Authorization', 'Bearer t');
    expect(listRes.status).toBe(200);

    const getRes = await request(app).get('/api/appointments/appt-1').set('Authorization', 'Bearer t');
    expect(getRes.status).toBe(200);
  });
});
