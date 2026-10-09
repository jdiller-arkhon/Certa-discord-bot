import { type SlashCommand, UserFacingError } from '@arkhon/shared';
import { type ChatInputCommandInteraction, MessageFlags, SlashCommandBuilder } from 'discord.js';
import { type CertaContext, callCerta } from '../context.js';

const LINK_CODE_PATTERN = /^[A-Z0-9-]{6,32}$/;

export function certaCommand(context: CertaContext): SlashCommand {
  const data = new SlashCommandBuilder()
    .setName('certa')
    .setDescription('Manage your Certa account link')
    .addSubcommand((sub) =>
      sub
        .setName('link')
        .setDescription('Link your Discord account using a one-time code from the Certa app')
        .addStringOption((option) =>
          option.setName('code').setDescription('One-time link code from Certa → Settings → Discord').setRequired(true).setMaxLength(32),
        ),
    )
    .addSubcommand((sub) => sub.setName('unlink').setDescription('Remove the link between your Discord and Certa accounts'))
    .addSubcommand((sub) =>
      sub
        .setName('reminders')
        .setDescription('Turn recurrent training reminder DMs on or off')
        .addStringOption((option) =>
          option
            .setName('state')
            .setDescription('on or off')
            .setRequired(true)
            .addChoices({ name: 'on', value: 'on' }, { name: 'off', value: 'off' }),
        ),
    );

  const link = async (interaction: ChatInputCommandInteraction) => {
    const code = interaction.options.getString('code', true).trim().toUpperCase().replace(/\s+/g, '');
    if (!LINK_CODE_PATTERN.test(code)) {
      throw new UserFacingError('That does not look like a Certa link code. Copy the code exactly as shown in the Certa app.');
    }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const result = await callCerta(context, 'redeemLinkCode', () => context.certa.redeemLinkCode(code, interaction.user.id));
    context.store.upsertLink(interaction.user.id, result.certaUserId, result.displayName);
    context.logger.info('Linked Certa account', { discordUserId: interaction.user.id, certaUserId: result.certaUserId });
    await interaction.editReply(
      `Linked to Certa as **${result.displayName}**. Try \`/log\`, \`/hours\`, or \`/currency\`. ` +
        'Recurrent training reminders are on; turn them off with `/certa reminders state:off`.',
    );
  };

  const unlink = async (interaction: ChatInputCommandInteraction) => {
    const removed = context.store.deleteLink(interaction.user.id);
    if (removed) context.logger.info('Unlinked Certa account', { discordUserId: interaction.user.id });
    await interaction.reply({
      content: removed
        ? 'Your Discord account is no longer linked to Certa. Your Certa logbook is unchanged.'
        : "Your Discord account isn't linked to Certa, so there was nothing to remove.",
      flags: MessageFlags.Ephemeral,
    });
  };

  const reminders = async (interaction: ChatInputCommandInteraction) => {
    const enabled = interaction.options.getString('state', true) === 'on';
    if (!context.store.setRemindersEnabled(interaction.user.id, enabled)) {
      throw new UserFacingError("Your Discord account isn't linked to Certa yet. Link it first with `/certa link`.");
    }
    await interaction.reply({
      content: enabled
        ? 'Recurrent training reminders are **on**. You will get DMs 60, 30, 14, and 3 days before your due date.'
        : 'Recurrent training reminders are **off**. Check anytime with `/currency`.',
      flags: MessageFlags.Ephemeral,
    });
  };

  return {
    name: 'certa',
    data,
    async execute(interaction) {
      const subcommand = interaction.options.getSubcommand(true);
      if (subcommand === 'link') return link(interaction);
      if (subcommand === 'unlink') return unlink(interaction);
      if (subcommand === 'reminders') return reminders(interaction);
    },
  };
}
