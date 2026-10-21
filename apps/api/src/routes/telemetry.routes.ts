import { Router, Request, Response } from 'express';
import { z } from 'zod';
import telemetryService, { TelemetryError } from '../services/telemetry.service';
import { authMiddleware } from '../middleware/auth';
import { tenantIsolation } from '../middleware/tenant';

const router = Router();
router.use(authMiddleware, tenantIsolation);

const metric = (max: number) => z.number().finite().min(0).max(max).nullable().optional();
const telemetrySchema = z.object({
  collectedAt: z.string().datetime(),
  cpuLoadPct: metric(100),
  memUsedPct: metric(100),
  diskUsedPct: metric(100),
  apiRttMs: metric(600_000),
  packetLossPct: metric(100),
  appVersion: z.string().max(40).nullable().optional(),
  runtimeVersion: z.string().max(80).nullable().optional(),
  uptimeSec: z.number().int().min(0).nullable().optional(),
});

// Telemetria do equipamento (PDV): empresa, filial e equipamento vêm da sessão do usuário, não do corpo.
router.post('/', async (req: Request, res: Response) => {
  try {
    const data = telemetrySchema.parse(req.body);
    const result = await telemetryService.ingest((req as any).user, data);
    return res.status(result.accepted ? 201 : 200).json(result);
  } catch (error: any) {
    if (error instanceof TelemetryError) return res.status(error.status).json({ error: error.message });
    return res.status(400).json({ error: error?.errors ? 'Telemetria inválida' : error.message });
  }
});

export default router;
