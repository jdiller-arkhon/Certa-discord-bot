import { Colors } from '@arkhon/shared';
import { EmbedBuilder } from 'discord.js';
import { DateTime } from 'luxon';
import type { FlightTotals, LeaderboardEntry } from './certa/types.js';
import type { CurrencySummary } from './domain/currency.js';
import { formatDuration, formatHours } from './domain/flight.js';

export function totalsEmbed(displayName: string, totals: FlightTotals): EmbedBuilder {
  const period = (label: string, p: { flights: number; minutes: number }) => ({
    name: label,
    value: `${p.flights} flight${p.flights === 1 ? '' : 's'}\n${formatHours(p.minutes)} (${formatDuration(p.minutes)})`,
    inline: true,
  });
  return new EmbedBuilder()
    .setTitle(`Flight time: ${displayName}`)
    .setColor(Colors.primary)
    .setDescription(
      `**${totals.totalFlights}** total flight${totals.totalFlights === 1 ? '' : 's'} · ` +
        `**${formatHours(totals.totalMinutes)}** total flight time`,
    )
    .addFields(period('Last 30 days', totals.last30Days), period('Last 90 days', totals.last90Days), period('Last 365 days', totals.last365Days));
}

const formatDate = (iso: string) => DateTime.fromISO(iso).toFormat('LLL d, yyyy');

export function currencyEmbed(displayName: string, summary: CurrencySummary): EmbedBuilder {
  const embed = new EmbedBuilder().setTitle(`Part 107 recurrent training: ${displayName}`);

  if (summary.state === 'unknown' || !summary.dueDate || summary.daysRemaining === null) {
    return embed
      .setColor(Colors.neutral)
      .setDescription(
        'No Part 107 knowledge test or recurrent training is on file in Certa. Add your most recent training ' +
          'in the Certa app to track your due date.',
      );
  }

  const days = summary.daysRemaining;
  const status =
    summary.state === 'lapsed'
      ? `🔴 **Lapsed**: recurrent training was due ${Math.abs(days)} day${Math.abs(days) === 1 ? '' : 's'} ago. ` +
        'Complete recurrent training before operating under Part 107.'
      : summary.state === 'due-soon'
        ? `🟡 **Due soon**: ${days === 0 ? 'due **today**' : `**${days}** day${days === 1 ? '' : 's'} remaining`}`
        : `🟢 **Current**: **${days}** days remaining`;

  const kind = summary.lastTrainingKind === 'initial' ? 'Initial knowledge test' : 'Recurrent training';
  return embed
    .setColor(summary.state === 'lapsed' ? Colors.danger : summary.state === 'due-soon' ? Colors.warning : Colors.success)
    .setDescription(status)
    .addFields(
      { name: 'Due date', value: formatDate(summary.dueDate), inline: true },
      { name: 'Days remaining', value: String(Math.max(days, 0)), inline: true },
      { name: `Last completed (${kind.toLowerCase()})`, value: formatDate(summary.lastTrainingDate!), inline: true },
    )
    .setFooter({ text: 'Recurrent training is due every 24 calendar months (14 CFR 107.65).' });
}

/**
 * Leaderboard embed. Linked pilots are shown as Discord mentions; others by
 * their Certa display name.
 */
export function leaderboardEmbed(
  title: string,
  entries: readonly LeaderboardEntry[],
  discordIdsByCertaId: ReadonlyMap<string, string>,
): EmbedBuilder {
  const medals = ['🥇', '🥈', '🥉'];
  const lines = entries.slice(0, 10).map((entry) => {
    const discordId = discordIdsByCertaId.get(entry.certaUserId);
    const who = discordId ? `<@${discordId}>` : entry.displayName;
    const badge = medals[entry.rank - 1] ?? `**${entry.rank}.**`;
    return `${badge} ${who}: ${formatHours(entry.totalMinutes)} · ${entry.flightCount} flight${entry.flightCount === 1 ? '' : 's'}`;
  });
  return new EmbedBuilder()
    .setTitle(title)
    .setColor(Colors.primary)
    .setDescription(lines.length > 0 ? lines.join('\n') : 'No flights logged yet. Be the first with `/log`!');
}
