import {
  ConfigError,
  createInteractionRouter,
  createLogger,
  registerCommands,
  sqliteJobRunStore,
  startScheduler,
} from '@arkhon/shared';
import { Client, Events, GatewayIntentBits } from 'discord.js';
import { createContext } from './app.js';
import { createCommands, createComponents } from './commands/index.js';
import { loadCertaConfig } from './config.js';
import { createJobs } from './jobs.js';

async function main(): Promise<void> {
  const config = loadCertaConfig();
  const logger = createLogger('certa', config.env.LOG_LEVEL);
  const context = createContext(config, logger);
  const commands = createCommands(context);

  logger.info('Starting Certa bot', { certaClient: config.env.CERTA_CLIENT, timezone: config.timezone });

  // Guilds is the only intent needed: slash commands, buttons, modals, and
  // outgoing DMs/channel posts do not require privileged intents.
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  client.on(Events.InteractionCreate, createInteractionRouter({ commands, components: createComponents(context), logger }));

  let stopScheduler: (() => void) | undefined;
  client.once(Events.ClientReady, async (ready) => {
    logger.info('Connected to Discord', { user: ready.user.tag, guilds: ready.guilds.cache.size });
    try {
      const count = await registerCommands({
        token: config.env.DISCORD_TOKEN,
        applicationId: config.env.DISCORD_APPLICATION_ID,
        guildId: config.env.DISCORD_GUILD_ID,
        commands,
      });
      logger.info('Registered slash commands', { count, scope: config.env.DISCORD_GUILD_ID ? 'guild' : 'global' });
    } catch (error) {
      logger.error('Failed to register slash commands', { error });
    }
    stopScheduler = startScheduler(createJobs(context, ready), {
      timezone: config.timezone,
      store: sqliteJobRunStore(context.store.db),
      logger,
    });
  });

  const shutdown = async (signal: string) => {
    logger.info('Shutting down', { signal });
    stopScheduler?.();
    await client.destroy();
    context.store.db.close();
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));

  await client.login(config.env.DISCORD_TOKEN);
}

main().catch((error: unknown) => {
  if (error instanceof ConfigError) {
    process.stderr.write(`${error.message}\n`);
  } else {
    process.stderr.write(`Fatal error: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  }
  process.exit(1);
});
