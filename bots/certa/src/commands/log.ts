import { Colors, type ComponentHandler, customId, type SlashCommand, UserFacingError } from '@arkhon/shared';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  ModalBuilder,
  SlashCommandBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import { MISSION_TYPES, type MissionType, missionTypeSchema } from '../certa/types.js';
import { type CertaContext, callCerta, requireLink } from '../context.js';
import { formatDuration, publicLocation, validateFlightForm } from '../domain/flight.js';

const MODAL_PREFIX = 'certa-log';
const SHARE_PREFIX = 'certa-share';

/**
 * Discord modals hold at most five inputs, so mission type is picked from the
 * command's choice list and the modal collects the remaining five fields.
 */
export function logCommand(context: CertaContext): SlashCommand {
  const data = new SlashCommandBuilder()
    .setName('log')
    .setDescription('Log a drone flight to your Certa logbook')
    .addStringOption((option) =>
      option
        .setName('mission')
        .setDescription('Mission type')
        .setRequired(true)
        .addChoices(...MISSION_TYPES.map((type) => ({ name: type, value: type }))),
    );

  return {
    name: 'log',
    data,
    async execute(interaction) {
      requireLink(context, interaction.user.id);
      const mission = missionTypeSchema.parse(interaction.options.getString('mission', true));
      const today = context.now().toISODate()!;

      const modal = new ModalBuilder()
        .setCustomId(customId(MODAL_PREFIX, mission))
        .setTitle(`Log ${mission} flight`)
        .addComponents(
          new ActionRowBuilder<TextInputBuilder>().addComponents(
            new TextInputBuilder()
              .setCustomId('date')
              .setLabel('Date (YYYY-MM-DD)')
              .setStyle(TextInputStyle.Short)
              .setValue(today)
              .setMinLength(5)
              .setMaxLength(10)
              .setRequired(true),
          ),
          new ActionRowBuilder<TextInputBuilder>().addComponents(
            new TextInputBuilder()
              .setCustomId('location')
              .setLabel('Location (city/site or ICAO code)')
              .setPlaceholder('e.g. Boulder, CO or KBJC (no coordinates)')
              .setStyle(TextInputStyle.Short)
              .setMaxLength(100)
              .setRequired(true),
          ),
          new ActionRowBuilder<TextInputBuilder>().addComponents(
            new TextInputBuilder()
              .setCustomId('aircraft')
              .setLabel('Aircraft')
              .setPlaceholder('e.g. DJI Mavic 3 Enterprise')
              .setStyle(TextInputStyle.Short)
              .setMaxLength(80)
              .setRequired(true),
          ),
          new ActionRowBuilder<TextInputBuilder>().addComponents(
            new TextInputBuilder()
              .setCustomId('duration')
              .setLabel('Flight duration (minutes)')
              .setPlaceholder('e.g. 25')
              .setStyle(TextInputStyle.Short)
              .setMaxLength(4)
              .setRequired(true),
          ),
          new ActionRowBuilder<TextInputBuilder>().addComponents(
            new TextInputBuilder()
              .setCustomId('notes')
              .setLabel('Notes (optional)')
              .setStyle(TextInputStyle.Paragraph)
              .setMaxLength(1000)
              .setRequired(false),
          ),
        );
      await interaction.showModal(modal);
    },
  };
}

function flightEmbed(fields: {
  title: string;
  color: number;
  date: string;
  location: string;
  aircraft: string;
  durationMinutes: number;
  missionType: MissionType;
}): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle(fields.title)
    .setColor(fields.color)
    .addFields(
      { name: 'Date', value: fields.date, inline: true },
      { name: 'Duration', value: formatDuration(fields.durationMinutes), inline: true },
      { name: 'Mission', value: fields.missionType, inline: true },
      { name: 'Location', value: fields.location, inline: true },
      { name: 'Aircraft', value: fields.aircraft, inline: true },
    );
}

export function logComponents(context: CertaContext): ComponentHandler[] {
  const modalHandler: ComponentHandler = {
    prefix: MODAL_PREFIX,
    async handleModal(interaction, [missionArg]) {
      const link = requireLink(context, interaction.user.id);
      const mission = missionTypeSchema.safeParse(missionArg);
      if (!mission.success) throw new UserFacingError('That form has expired. Run `/log` again.');

      const validation = validateFlightForm(
        {
          date: interaction.fields.getTextInputValue('date'),
          location: interaction.fields.getTextInputValue('location'),
          aircraft: interaction.fields.getTextInputValue('aircraft'),
          duration: interaction.fields.getTextInputValue('duration'),
          notes: interaction.fields.getTextInputValue('notes') ?? '',
          missionType: mission.data,
        },
        context.now(),
      );
      if (!validation.ok) {
        throw new UserFacingError(
          `Flight not logged. Please fix the following and run \`/log\` again:\n${validation.errors.map((e) => `• ${e}`).join('\n')}`,
        );
      }

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const { flight } = validation;
      const { flightId } = await callCerta(context, 'logFlight', () => context.certa.logFlight(link.certaUserId, flight));
      context.logger.info('Flight logged', { discordUserId: interaction.user.id, flightId });

      const embed = flightEmbed({
        title: '✅ Flight logged to Certa',
        color: Colors.success,
        date: flight.date,
        location: flight.location,
        aircraft: flight.aircraft,
        durationMinutes: flight.durationMinutes,
        missionType: flight.missionType,
      }).setFooter({ text: `Certa flight ID ${flightId}` });
      if (flight.notes) embed.addFields({ name: 'Notes', value: flight.notes });

      // The flight is already saved, so skip the share button rather than fail
      // if the backend's flight ID would not fit in a Discord custom ID.
      const shareChannel = context.config.env.CERTA_FLIGHT_LOGS_CHANNEL_ID;
      if (!shareChannel || SHARE_PREFIX.length + 1 + flightId.length > 100) {
        await interaction.editReply({ embeds: [embed] });
        return;
      }

      context.store.saveShareableFlight({
        flightId,
        discordUserId: interaction.user.id,
        date: flight.date,
        publicLocation: publicLocation(flight.location, flight.locationIsIcao),
        aircraft: flight.aircraft,
        durationMinutes: flight.durationMinutes,
        missionType: flight.missionType,
      });
      const button = new ButtonBuilder()
        .setCustomId(customId(SHARE_PREFIX, flightId))
        .setLabel('Share to #flight-logs')
        .setStyle(ButtonStyle.Secondary)
        .setEmoji('📣');
      await interaction.editReply({
        embeds: [embed],
        components: [new ActionRowBuilder<ButtonBuilder>().addComponents(button)],
      });
    },
  };

  const shareHandler: ComponentHandler = {
    prefix: SHARE_PREFIX,
    async handleButton(interaction, args) {
      const flightId = args.join(':');
      const channelId = context.config.env.CERTA_FLIGHT_LOGS_CHANNEL_ID;
      const flight = context.store.getShareableFlight(flightId);
      if (!channelId || !flight || flight.discordUserId !== interaction.user.id) {
        throw new UserFacingError('This flight can no longer be shared.');
      }
      if (!context.store.markShared(flightId)) {
        throw new UserFacingError('This flight has already been shared.');
      }

      const channel = await interaction.client.channels.fetch(channelId).catch(() => null);
      if (!channel || !channel.isSendable()) {
        context.store.unmarkShared(flightId);
        context.logger.warn('Flight logs channel missing or not sendable', { channelId });
        throw new UserFacingError('The flight log channel is not available right now. Ask an admin to check the bot setup.');
      }

      const embed = flightEmbed({
        title: `🛩️ ${interaction.user.displayName} logged a flight`,
        color: Colors.primary,
        date: flight.date,
        location: flight.publicLocation,
        aircraft: flight.aircraft,
        durationMinutes: flight.durationMinutes,
        missionType: flight.missionType,
      });
      try {
        await channel.send({ embeds: [embed], allowedMentions: { parse: [] } });
      } catch (error) {
        context.store.unmarkShared(flightId);
        throw error;
      }

      const disabled = ButtonBuilder.from(interaction.component as Parameters<typeof ButtonBuilder.from>[0])
        .setDisabled(true)
        .setLabel(`Shared to #${'name' in channel && channel.name ? channel.name : 'flight-logs'}`);
      await interaction.update({ components: [new ActionRowBuilder<ButtonBuilder>().addComponents(disabled)] });
    },
  };

  return [modalHandler, shareHandler];
}
