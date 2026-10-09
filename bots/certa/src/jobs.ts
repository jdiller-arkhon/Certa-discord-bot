import { Colors, postEmbeds, type ScheduledJob, sendDm } from '@arkhon/shared';
import { type Client, EmbedBuilder } from 'discord.js';
import { DateTime } from 'luxon';
import { type CertaContext, callCerta } from './context.js';
import { summarizeCurrency } from './domain/currency.js';
import { selectReminder } from './domain/reminders.js';
import { currencyEmbed, leaderboardEmbed } from './embeds.js';
import { buildPreflightEmbed } from './preflight/embed.js';

export type DmSender = (discordUserId: string, embed: EmbedBuilder) => Promise<boolean>;

export interface ReminderRunResult {
  checked: number;
  sent: number;
  failed: number;
}

/**
 * Checks every linked pilot with reminders enabled and DMs those who have
 * reached a new threshold. A reminder is recorded only after the DM succeeds,
 * so a closed DM inbox is retried on the next daily run.
 */
export async function runRecurrentReminders(context: CertaContext, send: DmSender): Promise<ReminderRunResult> {
  const today = context.now().toISODate()!;
  const result: ReminderRunResult = { checked: 0, sent: 0, failed: 0 };

  for (const link of context.store.listLinksWithRemindersEnabled()) {
    result.checked++;
    try {
      const status = await callCerta(context, 'getCurrency', () => context.certa.getCurrency(link.certaUserId));
      const summary = summarizeCurrency(status, today);
      if (!summary.dueDate || summary.daysRemaining === null) continue;

      const decision = selectReminder(summary.daysRemaining, context.store.sentReminderThresholds(link.discordUserId, summary.dueDate));
      if (!decision) continue;

      const embed = currencyEmbed(link.displayName, summary)
        .setTitle(
          summary.daysRemaining === 0
            ? '⏰ Part 107 recurrent training is due today'
            : `⏰ Part 107 recurrent training due in ${summary.daysRemaining} day${summary.daysRemaining === 1 ? '' : 's'}`,
        )
        .addFields({
          name: 'Reminder settings',
          value: 'Turn these DMs off with `/certa reminders state:off`.',
        });
      if (await send(link.discordUserId, embed)) {
        context.store.recordRemindersSent(link.discordUserId, summary.dueDate, decision.markSent);
        result.sent++;
      } else {
        result.failed++;
      }
    } catch (error) {
      result.failed++;
      context.logger.warn('Reminder check failed for user', { discordUserId: link.discordUserId, error });
    }
  }
  return result;
}

export function previousMonth(now: DateTime): string {
  return now.startOf('month').minus({ months: 1 }).toFormat('yyyy-LL');
}

export function createJobs(context: CertaContext, client: Client): ScheduledJob[] {
  const { env } = context.config;
  const jobs: ScheduledJob[] = [
    {
      name: 'recurrent-reminders',
      schedule: { kind: 'daily', time: env.CERTA_REMINDER_TIME },
      run: async () => {
        const result = await runRecurrentReminders(context, (userId, embed) =>
          sendDm(client, userId, { embeds: [embed] }, context.logger),
        );
        context.store.pruneShareableFlights(30);
        context.logger.info('Recurrent reminders complete', { ...result });
      },
    },
  ];

  const preflightChannel = env.CERTA_PREFLIGHT_CHANNEL_ID;
  if (preflightChannel && env.CERTA_PREFLIGHT_AIRPORTS.length > 0) {
    jobs.push({
      name: 'daily-preflight',
      schedule: { kind: 'daily', time: env.CERTA_PREFLIGHT_TIME },
      run: async ({ now }) => {
        const reports = await Promise.all(env.CERTA_PREFLIGHT_AIRPORTS.map((icao) => context.preflight.report(icao)));
        const posted = await postEmbeds(
          client,
          preflightChannel,
          reports.map(buildPreflightEmbed),
          context.logger,
          `**Daily preflight summary for ${now.toFormat('cccc, LLL d')}**`,
        );
        if (!posted) throw new Error('Could not post to the preflight channel');
      },
    });
  } else {
    context.logger.info('Daily preflight job disabled (set CERTA_PREFLIGHT_CHANNEL_ID and CERTA_PREFLIGHT_AIRPORTS)');
  }

  const loungeChannel = env.CERTA_PILOT_LOUNGE_CHANNEL_ID;
  if (loungeChannel) {
    jobs.push({
      name: 'monthly-leaderboard',
      schedule: { kind: 'monthly', day: 1, time: env.CERTA_LEADERBOARD_TIME },
      run: async ({ now }) => {
        const month = previousMonth(now);
        const entries = await context.certa.getLeaderboard('month', { month, limit: 10 });
        const label = DateTime.fromFormat(month, 'yyyy-LL').toFormat('LLLL yyyy');
        const embed = leaderboardEmbed(`🏆 Final leaderboard: ${label}`, entries, context.store.discordIdsByCertaId())
          .setColor(Colors.success)
          .setFooter({ text: 'A new month starts now. Log flights with /log.' });
        const posted = await postEmbeds(client, loungeChannel, [embed], context.logger);
        if (!posted) throw new Error('Could not post to the pilot lounge channel');
      },
    });
  } else {
    context.logger.info('Monthly leaderboard job disabled (set CERTA_PILOT_LOUNGE_CHANNEL_ID)');
  }

  return jobs;
}
