jest.mock('@ln-system/database', () => ({ prisma: {}, runInTransaction: jest.fn() }));

import { firstViolation, localDayRange, localMonthRange, peakConcurrency, type WindowFacts } from './agenda-capacity.service';
import { windowOpenIn, type BusinessSchedule } from './business-hours.service';

/** Regras puras da capacidade da agenda (docs/CORTEX/policies/AGENDA.md). A integração real está em
 * test/integration/agenda-capacity-resources.integration.test.ts. */
describe('agenda: capacidade — regras puras', () => {
  const H = 3_600_000;
  const t0 = Date.parse('2026-10-05T13:00:00.000Z'); // 10:00 em São Paulo

  describe('peakConcurrency (boxes)', () => {
    it('conta o pico simultâneo dentro da janela, não o total de sobrepostos', () => {
      // 10:00–10:30 e 10:30–11:00 nunca se encostam: pico 1 na janela 10:00–11:00
      expect(peakConcurrency([{ start: t0, end: t0 + H / 2 }, { start: t0 + H / 2, end: t0 + H }], t0, t0 + H)).toBe(1);
      // 09:00–10:30 e 10:00–11:00: pico 2 entre 10:00 e 10:30
      expect(peakConcurrency([{ start: t0 - H, end: t0 + H / 2 }, { start: t0, end: t0 + H }], t0, t0 + H)).toBe(2);
      // quem termina no início não ocupa
      expect(peakConcurrency([{ start: t0 - H, end: t0 }], t0, t0 + H)).toBe(0);
    });
  });

  describe('dia e mês no fuso da empresa', () => {
    it('dia local: Manaus (UTC−4) e São Paulo (UTC−3)', () => {
      const at = new Date('2026-10-06T03:30:00.000Z'); // 23:30 de 05/10 em Manaus; 00:30 de 06/10 em São Paulo
      expect(localDayRange(at, 'America/Manaus').start.toISOString()).toBe('2026-10-05T04:00:00.000Z');
      expect(localDayRange(at, 'America/Manaus').end.toISOString()).toBe('2026-10-06T04:00:00.000Z');
      expect(localDayRange(at, 'America/Sao_Paulo').start.toISOString()).toBe('2026-10-06T03:00:00.000Z');
    });

    it('mês local: dia 1 00:00 até o dia 1 do mês seguinte, inclusive fevereiro', () => {
      const oct = localMonthRange(new Date('2026-10-31T12:00:00.000Z'), 'America/Sao_Paulo');
      expect([oct.start.toISOString(), oct.end.toISOString()]).toEqual(['2026-10-01T03:00:00.000Z', '2026-11-01T03:00:00.000Z']);
      const feb = localMonthRange(new Date('2027-02-15T12:00:00.000Z'), 'America/Manaus');
      expect([feb.start.toISOString(), feb.end.toISOString()]).toEqual(['2027-02-01T04:00:00.000Z', '2027-03-01T04:00:00.000Z']);
      // 31/10 23:30 em Manaus já é 01/11 em São Paulo
      const edge = new Date('2026-11-01T03:30:00.000Z');
      expect(localMonthRange(edge, 'America/Manaus').start.toISOString()).toBe('2026-10-01T04:00:00.000Z');
      expect(localMonthRange(edge, 'America/Sao_Paulo').start.toISOString()).toBe('2026-11-01T03:00:00.000Z');
    });
  });

  describe('firstViolation — ordem e mensagens', () => {
    const base: WindowFacts = {
      tz: 'America/Sao_Paulo',
      start: new Date(t0),
      end: new Date(t0 + H),
      limits: { maxPerSlot: null, maxPerDay: null, maxPerMonth: null, boxCount: null },
      slot: { start: new Date(t0), end: new Date(t0 + H) },
      slotCount: 0,
      dayCount: 0,
      monthCount: 0,
      branchBusy: [],
      mechanicBusy: [],
      branchBlocks: [],
      mechanicBlocks: [],
    };

    it('sem limite configurado nada bloqueia', () => {
      expect(firstViolation({ ...base, slotCount: 99, dayCount: 999, monthCount: 9999, branchBusy: [{ start: t0, end: t0 + H }] })).toBeNull();
    });

    it('cada limite devolve o seu código com o que aconteceu e o que fazer', () => {
      expect(firstViolation({ ...base, limits: { ...base.limits, maxPerDay: 3 }, dayCount: 3 })).toMatchObject({
        code: 'DAY_FULL',
        message: expect.stringMatching(/05\/10\/2026 está lotada.*limite 3 por dia.*Escolha outro dia/),
      });
      expect(firstViolation({ ...base, limits: { ...base.limits, maxPerMonth: 10 }, monthCount: 10 })).toMatchObject({
        code: 'MONTH_FULL',
        message: expect.stringMatching(/10\/2026 está lotada/),
      });
      expect(firstViolation({ ...base, limits: { ...base.limits, boxCount: 2 }, branchBusy: [{ start: t0, end: t0 + H }, { start: t0 - H, end: t0 + 1 }] })).toMatchObject({
        code: 'NO_BOX_AVAILABLE',
        message: expect.stringMatching(/Não há box livre.*os 2 boxes.*fale com a gerência/),
      });
      expect(firstViolation({ ...base, mechanicBusy: [{ start: t0 + H / 2, end: t0 + 2 * H }] })).toMatchObject({
        code: 'MECHANIC_CONFLICT',
        message: expect.stringMatching(/já tem um atendimento em 05\/10\/2026 das 10:30 às 12:00/),
      });
      const block = { startsAt: new Date(t0 - H), endsAt: new Date(t0 + H), reason: 'Treinamento' };
      expect(firstViolation({ ...base, branchBlocks: [block] })).toMatchObject({ code: 'AGENDA_UNAVAILABLE', message: expect.stringMatching(/\(Treinamento\)/) });
      expect(firstViolation({ ...base, mechanicBlocks: [block] })).toMatchObject({ code: 'MECHANIC_UNAVAILABLE' });
    });

    it('indisponibilidade vem antes de capacidade (motivo mais específico primeiro)', () => {
      const block = { startsAt: new Date(t0), endsAt: new Date(t0 + H), reason: 'Manutenção do elevador' };
      expect(firstViolation({ ...base, limits: { ...base.limits, maxPerDay: 1 }, dayCount: 5, branchBlocks: [block] })?.code).toBe('AGENDA_UNAVAILABLE');
    });
  });

  describe('windowOpenIn — a janela inteira precisa caber no funcionamento', () => {
    const schedule: BusinessSchedule = {
      source: 'COMPANY',
      days: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
        weekday,
        isClosed: weekday === 0,
        opensAt: weekday === 0 ? null : '08:00',
        closesAt: weekday === 0 ? null : '18:00',
        breakStart: weekday === 0 ? null : '12:00',
        breakEnd: weekday === 0 ? null : '13:00',
      })),
      companyDays: [],
      exceptions: [],
      timezone: 'America/Sao_Paulo',
    };
    const at = (hhmm: string) => new Date(`2026-10-05T${hhmm}:00.000-03:00`); // segunda-feira
    const win = (hhmm: string, min: number) => windowOpenIn(schedule, null, at(hhmm), new Date(at(hhmm).getTime() + min * 60_000));

    it('cabe: 10:00 + 60, 13:00 + 300 (termina 18:00 em ponto)', () => {
      expect(win('10:00', 60).open).toBe(true);
      expect(win('13:00', 300).open).toBe(true);
    });

    it('passa do fechamento ou atravessa o intervalo: recusa com o motivo', () => {
      expect(win('17:30', 60)).toMatchObject({ open: false, reason: expect.stringMatching(/60 min \(17:30–18:30\) termina depois do fechamento \(18:00\)/) });
      expect(win('11:30', 60)).toMatchObject({ open: false, reason: expect.stringMatching(/passa pelo intervalo das 12:00 às 13:00/) });
    });

    it('início fechado mantém a mensagem de sempre', () => {
      expect(win('12:30', 30)).toMatchObject({ open: false, reason: 'Intervalo das 12:00 às 13:00' });
      expect(win('20:00', 30)).toMatchObject({ open: false, reason: 'Fora do horário de funcionamento (08:00–18:00)' });
    });
  });
});
