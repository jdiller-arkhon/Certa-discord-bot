import type { SlashCommand } from '@arkhon/shared';
import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import { type CertaContext, callCerta, requireLink } from '../context.js';
import { summarizeCurrency } from '../domain/currency.js';
import { currencyEmbed, leaderboardEmbed, totalsEmbed } from '../embeds.js';

export function hoursCommand(context: CertaContext): SlashCommand {
  return {
    name: 'hours',
    data: new SlashCommandBuilder().setName('hours').setDescription('Show your total flights and flight time from Certa'),
    async execute(interaction) {
      const link = requireLink(context, interaction.user.id);
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const totals = await callCerta(context, 'getTotals', () => context.certa.getTotals(link.certaUserId));
      await interaction.editReply({ embeds: [totalsEmbed(link.displayName, totals)] });
    },
  };
}

export function currencyCommand(context: CertaContext): SlashCommand {
  return {
    name: 'currency',
    data: new SlashCommandBuilder().setName('currency').setDescription('Show your Part 107 recurrent training status'),
    async execute(interaction) {
      const link = requireLink(context, interaction.user.id);
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const status = await callCerta(context, 'getCurrency', () => context.certa.getCurrency(link.certaUserId));
      const summary = summarizeCurrency(status, context.now().toISODate()!);
      await interaction.editReply({ embeds: [currencyEmbed(link.displayName, summary)] });
    },
  };
}

export function leaderboardCommand(context: CertaContext): SlashCommand {
  return {
    name: 'leaderboard',
    data: new SlashCommandBuilder()
      .setName('leaderboard')
      .setDescription('Top 10 pilots by flight time')
      .addStringOption((option) =>
        option
          .setName('period')
          .setDescription('Time period (default: this month)')
          .addChoices({ name: 'This month', value: 'month' }, { name: 'All time', value: 'all' }),
      ),
    async execute(interaction) {
      const period = interaction.options.getString('period') === 'all' ? 'all' : 'month';
      await interaction.deferReply();
      const entries = await callCerta(context, 'getLeaderboard', () => context.certa.getLeaderboard(period, { limit: 10 }));
      const title =
        period === 'month' ? `🏆 Flight time leaders: ${context.now().toFormat('LLLL yyyy')}` : '🏆 Flight time leaders: all time';
      await interaction.editReply({
        embeds: [leaderboardEmbed(title, entries, context.store.discordIdsByCertaId())],
        allowedMentions: { parse: [] },
      });
    },
  };
}
