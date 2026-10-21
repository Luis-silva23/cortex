import * as fs from 'fs';
import * as path from 'path';
import { SCHEDULED_JOB_NAMES } from './scheduled-jobs';

// Todo job agendado em setupRecurringJobs precisa ser despachado pelo worker e tratado em processScheduledJob.
describe('jobs recorrentes', () => {
  const scheduler = fs.readFileSync(path.join(__dirname, 'scheduler.ts'), 'utf8');
  // process-notification é a notificação avulsa (processNotificationJob), despachada em outro ramo do worker.
  const scheduled = [...scheduler.matchAll(/notificationQueue\.add\(\s*'([^']+)'/g)]
    .map((m) => m[1])
    .filter((n) => n !== 'process-notification');
  const handled = [...scheduler.matchAll(/case '([^']+)':/g)].map((m) => m[1]);

  it('encontra os jobs agendados', () => {
    expect(scheduled.length).toBeGreaterThanOrEqual(8);
  });

  it.each(scheduled)('%s é despachado pelo worker e tratado pelo scheduler', (name) => {
    expect(SCHEDULED_JOB_NAMES).toContain(name);
    expect(handled).toContain(name);
  });
});
