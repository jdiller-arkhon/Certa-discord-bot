/**
 * Runs the Certa Discord bot on Cloudflare Containers. The bot holds a gateway connection to
 * Discord, so the container must never sleep: activity expiry is ignored, and a Cron Trigger
 * starts the container again within five minutes if it stops (deploy, crash, host maintenance).
 *
 * The container's disk isn't kept across restarts, so Litestream replicates the bot's SQLite
 * database to R2 and restores it on start (bots/certa/entrypoint.sh).
 */
import { Container, getContainer } from '@cloudflare/containers';

interface Env {
  CERTA_BOT: DurableObjectNamespace<CertaBot>;
  // Plain vars (wrangler.jsonc)
  CERTA_API_BASE_URL: string;
  CERTA_TIMEZONE: string;
  LITESTREAM_BUCKET: string;
  // Secrets (wrangler secret put …)
  DISCORD_TOKEN: string;
  DISCORD_APPLICATION_ID: string;
  CERTA_API_TOKEN: string;
  LITESTREAM_ENDPOINT: string;
  LITESTREAM_ACCESS_KEY_ID: string;
  LITESTREAM_SECRET_ACCESS_KEY: string;
  // Optional: unset ones are left out
  DISCORD_GUILD_ID?: string;
  CERTA_FLIGHT_LOGS_CHANNEL_ID?: string;
  CERTA_PREFLIGHT_CHANNEL_ID?: string;
  CERTA_PILOT_LOUNGE_CHANNEL_ID?: string;
  CERTA_PREFLIGHT_AIRPORTS?: string;
}

function botEnv(env: Env): Record<string, string> {
  const vars: Record<string, string | undefined> = {
    LOG_LEVEL: 'info',
    CERTA_CLIENT: 'http',
    CERTA_API_BASE_URL: env.CERTA_API_BASE_URL,
    CERTA_API_TOKEN: env.CERTA_API_TOKEN,
    CERTA_TIMEZONE: env.CERTA_TIMEZONE,
    DISCORD_TOKEN: env.DISCORD_TOKEN,
    DISCORD_APPLICATION_ID: env.DISCORD_APPLICATION_ID,
    DISCORD_GUILD_ID: env.DISCORD_GUILD_ID,
    CERTA_FLIGHT_LOGS_CHANNEL_ID: env.CERTA_FLIGHT_LOGS_CHANNEL_ID,
    CERTA_PREFLIGHT_CHANNEL_ID: env.CERTA_PREFLIGHT_CHANNEL_ID,
    CERTA_PILOT_LOUNGE_CHANNEL_ID: env.CERTA_PILOT_LOUNGE_CHANNEL_ID,
    CERTA_PREFLIGHT_AIRPORTS: env.CERTA_PREFLIGHT_AIRPORTS,
    LITESTREAM_BUCKET: env.LITESTREAM_BUCKET,
    LITESTREAM_ENDPOINT: env.LITESTREAM_ENDPOINT,
    LITESTREAM_ACCESS_KEY_ID: env.LITESTREAM_ACCESS_KEY_ID,
    LITESTREAM_SECRET_ACCESS_KEY: env.LITESTREAM_SECRET_ACCESS_KEY,
  };
  return Object.fromEntries(Object.entries(vars).filter((e): e is [string, string] => !!e[1]));
}

export class CertaBot extends Container<Env> {
  sleepAfter = '1h';
  constructor(ctx: DurableObjectState<object>, env: Env) {
    super(ctx, env);
    this.envVars = botEnv(env);
  }

  /** Never sleep: the bot's work arrives over its own outbound connection, not as requests. */
  override async onActivityExpired(): Promise<void> {
    this.renewActivityTimeout();
  }

  override onStop(params: { exitCode?: number; reason?: string }): void {
    console.log(JSON.stringify({ msg: 'certa bot container stopped', ...params }));
  }
}

const bot = (env: Env) => getContainer(env.CERTA_BOT, 'main');

export default {
  async fetch(): Promise<Response> {
    return new Response('Not found', { status: 404 });
  },

  /** Every five minutes: start the bot if it isn't running (a no-op when it is). */
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(bot(env).start());
  },
} satisfies ExportedHandler<Env>;
