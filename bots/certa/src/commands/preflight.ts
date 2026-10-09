import { type SlashCommand, UserFacingError } from '@arkhon/shared';
import { SlashCommandBuilder } from 'discord.js';
import type { CertaContext } from '../context.js';
import { buildPreflightEmbed } from '../preflight/embed.js';

const ICAO_PATTERN = /^[A-Z][A-Z0-9]{3}$/;

export function preflightCommand(context: CertaContext): SlashCommand {
  return {
    name: 'preflight',
    data: new SlashCommandBuilder()
      .setName('preflight')
      .setDescription('Weather, space weather, and TFRs for an airport (advisory)')
      .addStringOption((option) =>
        option.setName('icao').setDescription('ICAO airport code, e.g. KDEN').setRequired(true).setMinLength(4).setMaxLength(4),
      ),
    async execute(interaction) {
      const icao = interaction.options.getString('icao', true).trim().toUpperCase();
      if (!ICAO_PATTERN.test(icao)) {
        throw new UserFacingError('Enter a 4-character ICAO code, e.g. `KDEN` (US airports start with K).');
      }
      await interaction.deferReply();
      const report = await context.preflight.report(icao);
      if (report.metar.ok && !report.metar.value && report.taf.ok && !report.taf.value) {
        throw new UserFacingError(`No METAR or TAF found for **${icao}**. Check the identifier; weather-reporting airports only.`);
      }
      await interaction.editReply({ embeds: [buildPreflightEmbed(report)] });
    },
  };
}
