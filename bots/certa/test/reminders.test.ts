import { silentLogger } from '@arkhon/shared';
import { DateTime } from 'luxon';
import { describe, expect, it } from 'vitest';
import { MockCertaClient } from '../src/certa/mock-client.js';
import type { CertaConfig } from '../src/config.js';
import type { CertaContext } from '../src/context.js';
import { openCertaDatabase } from '../src/db.js';
import { REMINDER_THRESHOLDS, selectReminder } from '../src/domain/reminders.js';
import { runRecurrentReminders } from '../src/jobs.js';
import type { PreflightService } from '../src/preflight/service.js';
import { CertaStore } from '../src/store.js';

describe('selectReminder', () => {
  it('uses the 60/30/14/3 day thresholds', () => {
    expect(REMINDER_THRESHOLDS).toEqual([60, 30, 14, 3]);
  });

  it('sends nothing before the first threshold', () => {
    expect(selectReminder(61, [])).toBeNull();
    expect(selectReminder(400, [])).toBeNull();
  });

  it('fires exactly on each threshold', () => {
    expect(selectReminder(60, [])).toEqual({ threshold: 60, markSent: [60] });
    expect(selectReminder(30, [60])).toEqual({ threshold: 30, markSent: [30] });
    expect(selectReminder(14, [60, 30])).toEqual({ threshold: 14, markSent: [14] });
    expect(selectReminder(3, [60, 30, 14])).toEqual({ threshold: 3, markSent: [3] });
  });

  it('does not repeat a threshold already sent', () => {
    expect(selectReminder(59, [60])).toBeNull();
    expect(selectReminder(31, [60])).toBeNull();
    expect(selectReminder(2, [60, 30, 14, 3])).toBeNull();
    expect(selectReminder(0, [60, 30, 14, 3])).toBeNull();
  });

  it('sends only the most urgent reached threshold and marks skipped ones', () => {
    // Bot offline or pilot linked late: at 10 days, send the 14-day reminder once.
    expect(selectReminder(10, [])).toEqual({ threshold: 14, markSent: [60, 30, 14] });
    expect(selectReminder(10, [60])).toEqual({ threshold: 14, markSent: [30, 14] });
  });

  it('still reminds on the due date and stops once lapsed', () => {
    expect(selectReminder(0, [60, 30, 14])).toEqual({ threshold: 3, markSent: [3] });
    expect(selectReminder(-1, [])).toBeNull();
  });

  it('emits each threshold exactly once over a daily countdown', () => {
    const sent: number[] = [];
    const fired: number[] = [];
    for (let days = 90; days >= -5; days--) {
      const decision = selectReminder(days, sent);
      if (decision) {
        fired.push(days);
        sent.push(...decision.markSent);
      }
    }
    expect(fired).toEqual([60, 30, 14, 3]);
    expect([...sent].sort((a, b) => b - a)).toEqual([60, 30, 14, 3]);
  });
});

describe('runRecurrentReminders', () => {
  function setup(startDate: string) {
    let now = DateTime.fromISO(`${startDate}T09:00`, { zone: 'America/Denver' });
    const db = openCertaDatabase(':memory:');
    const store = new CertaStore(db);
    const certa = new MockCertaClient(db, { timezone: 'America/Denver', now: () => now });
    const context: CertaContext = {
      config: { timezone: 'America/Denver' } as CertaConfig,
      store,
      certa,
      preflight: {} as PreflightService,
      logger: silentLogger,
      now: () => now,
    };
    return {
      context,
      store,
      certa,
      advanceDays: (days: number) => {
        now = now.plus({ days });
      },
    };
  }

  async function link(env: ReturnType<typeof setup>, discordUserId: string, trainingDate: string) {
    const result = await env.certa.redeemLinkCode(`CODE-${discordUserId}`, discordUserId);
    env.certa.setTraining(result.certaUserId, trainingDate);
    env.store.upsertLink(discordUserId, result.certaUserId, result.displayName);
  }

  it('DMs at each threshold once across daily runs and survives repeated runs per day', async () => {
    // Training 2024-11-20 -> due 2026-11-30. Start 70 days out.
    const env = setup('2026-09-21');
    await link(env, '100000000000000001', '2024-11-20');

    const dms: { day: string; title: string | undefined }[] = [];
    for (let day = 0; day < 80; day++) {
      for (let run = 0; run < 2; run++) {
        await runRecurrentReminders(env.context, async (_userId, embed) => {
          dms.push({ day: env.context.now().toISODate()!, title: embed.data.title });
          return true;
        });
      }
      env.advanceDays(1);
    }

    expect(dms.map((dm) => dm.day)).toEqual(['2026-10-01', '2026-10-31', '2026-11-16', '2026-11-27']);
    expect(dms[0]?.title).toContain('60 days');
    expect(dms[3]?.title).toContain('3 days');
  });

  it('skips opted-out pilots and retries when a DM fails', async () => {
    const env = setup('2026-10-01');
    await link(env, '100000000000000002', '2024-11-20');
    await link(env, '100000000000000003', '2024-11-20');
    env.store.setRemindersEnabled('100000000000000003', false);

    let deliver = false;
    const attempts: string[] = [];
    const send = async (userId: string) => {
      attempts.push(userId);
      return deliver;
    };

    expect(await runRecurrentReminders(env.context, send)).toEqual({ checked: 1, sent: 0, failed: 1 });
    deliver = true;
    env.advanceDays(1);
    expect(await runRecurrentReminders(env.context, send)).toEqual({ checked: 1, sent: 1, failed: 0 });
    expect(await runRecurrentReminders(env.context, send)).toEqual({ checked: 1, sent: 0, failed: 0 });
    expect(attempts).toEqual(['100000000000000002', '100000000000000002']);
  });

  it('starts a new cycle when the due date moves after recurrent training', async () => {
    const env = setup('2026-11-27');
    await link(env, '100000000000000004', '2024-11-20');
    const sent: number[] = [];
    const send = async () => {
      sent.push(1);
      return true;
    };

    await runRecurrentReminders(env.context, send);
    expect(sent).toHaveLength(1);

    // Pilot completes recurrent training: next due 2028-11-30, far outside every threshold.
    env.certa.setTraining('mock-100000000000000004', '2026-11-28');
    env.advanceDays(1);
    await runRecurrentReminders(env.context, send);
    expect(sent).toHaveLength(1);
    expect(env.store.sentReminderThresholds('100000000000000004', '2028-11-30')).toEqual([]);
  });
});
