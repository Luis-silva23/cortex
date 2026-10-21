import { Router } from 'express';
import { backupService } from '../services/BackupService';
import { authMiddleware as authenticate, requireSuperAdmin } from '../middleware/auth';
import { tenantIsolation } from '../middleware/tenant';
import { logger } from '../utils/logger';
import { auditLog } from '../middleware/audit';
import { AuditAction } from '@ln-system/database';

const router = Router();

// ACHADO DE AUDITORIA DE SEGURANÇA (CRÍTICO): esta rota usava
// `requirePermission('backup:*')`, o mesmo gate genérico e por-empresa que
// financial.routes.ts/purchase-orders.routes.ts usam para ações que ficam
// contidas dentro da própria empresa (ex.: `finance:reverse` só afeta
// contas daquela empresa, RLS + companyId no service garantem isso).
// Backup/restore é fundamentalmente diferente: BackupService faz
// pg_dump/pg_restore do BANCO INTEIRO (todas as empresas, todos os
// tenants) — não há como escopar por companyId num dump físico do banco.
// E como QUALQUER COMPANY_ADMIN pode, dentro do RBAC normal da própria
// empresa, criar uma Permission com nome livre (ex.: "backup:restore"),
// criar uma Role, anexar a permissão, e atribuir essa role A SI MESMO
// (confirmado: role.service.ts não tem checagem de auto-atribuição nem
// allowlist de nomes de permissão) — `requirePermission` sozinho
// concedia a qualquer admin de QUALQUER empresa um caminho self-service
// para ler/restaurar/apagar o backup de TODAS as empresas da plataforma.
// `requireSuperAdmin` é uma checagem de userType, não de RBAC
// configurável por tenant — imune a esse tipo de auto-concessão.
router.use(authenticate, tenantIsolation, requireSuperAdmin);

/**
 * @swagger
 * /api/backup/create:
 *   post:
 *     summary: Create a database backup
 *     tags: [Backup]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Backup created successfully
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Insufficient permissions
 *       500:
 *         description: Backup failed
 */
router.post(
  '/create',
  auditLog(AuditAction.CREATE, 'Backup', { describe: (_req, body) => ({ entityId: body?.filename ?? body?.data?.filename ?? null, newValue: { filename: body?.filename ?? body?.data?.filename ?? null } }) }),
  async (req, res) => {
    try {
      logger.info(`Backup requested by user: ${(req as any).user.userId}`);

      const result = await backupService.createBackup((req as any).user.userId);

      if (result.success && result.requested) {
        // modo delegado (decisão 152): a API não tem a credencial de backup; o serviço dedicado executa em até ~1 min e publica o manifesto
        res.status(202).json({
          success: true,
          requested: true,
          requestId: result.requestId,
          message: 'Backup solicitado ao serviço de backup dedicado; ele aparece na lista em até alguns minutos.',
        });
      } else if (result.success) {
        res.json({
          success: true,
          message: 'Backup created successfully',
          filePath: result.filePath,
        });
      } else {
        res.status(500).json({
          success: false,
          error: 'Backup Failed',
          message: result.error,
        });
      }
    } catch (error) {
      logger.error('Backup creation error:', error);
      res.status(500).json({
        error: 'Internal Server Error',
        message: 'Failed to create backup',
      });
    }
  }
);

/**
 * @swagger
 * /api/backup/list:
 *   get:
 *     summary: List all available backups
 *     tags: [Backup]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of backups
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Insufficient permissions
 */
router.get(
  '/list',
  async (_req, res) => {
    try {
      const backups = await backupService.listBackups();

      res.json({
        success: true,
        data: backups.map((backup) => ({
          filename: backup.filename,
          size: backup.size,
          sizeFormatted: `${(backup.size / 1024 / 1024).toFixed(2)} MB`,
          createdAt: backup.createdAt,
        })),
      });
    } catch (error) {
      logger.error('Backup list error:', error);
      res.status(500).json({
        error: 'Internal Server Error',
        message: 'Failed to list backups',
      });
    }
  }
);

/**
 * @swagger
 * /api/backup/restore:
 *   post:
 *     summary: Restore database from backup
 *     tags: [Backup]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - filename
 *             properties:
 *               filename:
 *                 type: string
 *                 description: Backup filename to restore
 *     responses:
 *       200:
 *         description: Backup restored successfully
 *       400:
 *         description: Invalid filename
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Insufficient permissions
 *       500:
 *         description: Restore failed
 */
router.post(
  '/restore',
  auditLog(AuditAction.UPDATE, 'Backup', { describe: (req) => ({ entityId: req.body?.filename ?? null, newValue: { restoredFrom: req.body?.filename ?? null } }) }),
  async (req, res) => {
    try {
      // Restaurar (`pg_restore -c`) apaga e recria objetos do banco em uso: nunca pela API em produção nem no modo delegado (sem credencial);
      // é procedimento de DBA em banco novo e isolado (docs/CORTEX/BACKUP_RECUPERACAO.md §7).
      if (process.env.NODE_ENV === 'production' || backupService.mode === 'delegated') {
        return res.status(403).json({
          error: 'Restore Disabled',
          code: 'RESTORE_DISABLED',
          message: 'A restauração não é feita pela API: é procedimento de DBA em banco novo e isolado (docs/CORTEX/BACKUP_RECUPERACAO.md).',
        });
      }

      const { filename } = req.body;

      if (!filename) {
        return res.status(400).json({
          error: 'Bad Request',
          message: 'Filename is required',
        });
      }

      logger.warn(`Database restore requested by user: ${(req as any).user.userId} - ${filename}`);

      // Get backup path
      const backups = await backupService.listBackups();
      const backup = backups.find((b) => b.filename === filename);

      if (!backup) {
        return res.status(404).json({
          error: 'Not Found',
          message: 'Backup file not found',
        });
      }

      const result = await backupService.restoreBackup(backup.path);

      if (result.success) {
        return res.json({
          success: true,
          message: 'Database restored successfully',
        });
      } else {
        return res.status(500).json({
          success: false,
          error: 'Restore Failed',
          message: result.error,
        });
      }
    } catch (error) {
      logger.error('Backup restore error:', error);
      return res.status(500).json({
        error: 'Internal Server Error',
        message: 'Failed to restore backup',
      });
    }
  }
);

/**
 * @swagger
 * /api/backup/delete/{filename}:
 *   delete:
 *     summary: Delete a backup file
 *     tags: [Backup]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: filename
 *         required: true
 *         schema:
 *           type: string
 *         description: Backup filename
 *     responses:
 *       200:
 *         description: Backup deleted successfully
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Insufficient permissions
 *       404:
 *         description: Backup not found
 */
router.delete(
  '/delete/:filename',
  auditLog(AuditAction.DELETE, 'Backup', { describe: (req) => ({ entityId: req.params.filename, newValue: { deleted: req.params.filename } }) }),
  async (req, res) => {
    try {
      const { filename } = req.params;

      // No modo delegado a API não apaga backup: a retenção é do serviço dedicado (o destino externo ainda tem proteção contra exclusão).
      if (backupService.mode === 'delegated') {
        return res.status(403).json({
          error: 'Delete Disabled',
          code: 'BACKUP_DELETE_DISABLED',
          message: 'A API não apaga backups: a retenção é do serviço de backup dedicado.',
        });
      }

      logger.info(`Backup deletion requested by user: ${(req as any).user.userId} - ${filename}`);

      const result = await backupService.deleteBackup(filename);

      if (result.success) {
        return res.json({
          success: true,
          message: 'Backup deleted successfully',
        });
      }
      return res.status(500).json({
        success: false,
        error: 'Delete Failed',
        message: result.error,
      });
    } catch (error) {
      logger.error('Backup deletion error:', error);
      return res.status(500).json({
        error: 'Internal Server Error',
        message: 'Failed to delete backup',
      });
    }
  }
);

/**
 * @swagger
 * /api/backup/stats:
 *   get:
 *     summary: Get backup statistics
 *     tags: [Backup]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Backup statistics
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Insufficient permissions
 */
router.get(
  '/stats',
  async (_req, res) => {
    try {
      const stats = await backupService.getBackupStats();

      res.json({
        success: true,
        data: {
          totalBackups: stats.totalBackups,
          totalSize: stats.totalSize,
          totalSizeFormatted: `${(stats.totalSize / 1024 / 1024).toFixed(2)} MB`,
          oldestBackup: stats.oldestBackup,
          newestBackup: stats.newestBackup,
        },
      });
    } catch (error) {
      logger.error('Backup stats error:', error);
      res.status(500).json({
        error: 'Internal Server Error',
        message: 'Failed to get backup statistics',
      });
    }
  }
);

export default router;
