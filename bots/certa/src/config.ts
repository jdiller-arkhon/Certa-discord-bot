import { csvList, loadEnv, localTime, snowflake } from '@arkhon/shared';
import { IANAZone } from 'luxon';
import { z } from 'zod';

const icao = z.string().regex(/^[A-Z0-9]{4}$/, 'expected a 4-character ICAO code');

const number = (fallback: number) => z.coerce.number().finite().nonnegative().default(fallback);

export const certaEnvSchema = z
  .object({
    DISCORD_TOKEN: z.string().min(1),
    DISCORD_APPLICATION_ID: snowflake,
    /** When set, commands are registered to this guild only (instant updates). */
    DISCORD_GUILD_ID: snowflake.optional(),

    CERTA_CLIENT: z.enum(['http', 'mock']).default('http'),
    CERTA_API_BASE_URL: z.string().url().optional(),
    CERTA_API_TOKEN: z.string().min(1).optional(),
    CERTA_DB_PATH: z.string().default('./data/certa.sqlite'),
    CERTA_TIMEZONE: z
      .string()
      .default('America/Denver')
      .refine((zone) => IANAZone.isValidZone(zone), 'expected an IANA time zone, e.g. America/Denver'),

    CERTA_FLIGHT_LOGS_CHANNEL_ID: snowflake.optional(),
    CERTA_PREFLIGHT_CHANNEL_ID: snowflake.optional(),
    CERTA_PILOT_LOUNGE_CHANNEL_ID: snowflake.optional(),

    CERTA_REMINDER_TIME: localTime.default('09:00'),
    CERTA_PREFLIGHT_TIME: localTime.default('06:30'),
    CERTA_PREFLIGHT_AIRPORTS: csvList.pipe(z.array(icao)).default(''),
    CERTA_LEADERBOARD_TIME: localTime.default('09:00'),

    PREFLIGHT_MAX_WIND_KT: number(15),
    PREFLIGHT_MAX_GUST_KT: number(20),
    PREFLIGHT_MIN_VISIBILITY_SM: number(3),
    PREFLIGHT_MIN_CEILING_FT: number(1000),
    PREFLIGHT_KP_CAUTION: number(5),
    PREFLIGHT_TFR_RADIUS_NM: number(30),

    LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  })
  .superRefine((env, ctx) => {
    if (env.CERTA_CLIENT === 'http') {
      if (!env.CERTA_API_BASE_URL) {
        ctx.addIssue({ code: 'custom', path: ['CERTA_API_BASE_URL'], message: 'required when CERTA_CLIENT=http' });
      }
      if (!env.CERTA_API_TOKEN) {
        ctx.addIssue({ code: 'custom', path: ['CERTA_API_TOKEN'], message: 'required when CERTA_CLIENT=http' });
      }
    }
  });

export type CertaEnv = z.infer<typeof certaEnvSchema>;

export interface PreflightThresholds {
  maxWindKt: number;
  maxGustKt: number;
  minVisibilitySm: number;
  minCeilingFt: number;
  kpCaution: number;
}

export interface CertaConfig {
  env: CertaEnv;
  timezone: string;
  thresholds: PreflightThresholds;
  tfrRadiusNm: number;
}

export function loadCertaConfig(source: Record<string, string | undefined> = process.env): CertaConfig {
  const env = loadEnv(certaEnvSchema, source);
  return {
    env,
    timezone: env.CERTA_TIMEZONE,
    thresholds: {
      maxWindKt: env.PREFLIGHT_MAX_WIND_KT,
      maxGustKt: env.PREFLIGHT_MAX_GUST_KT,
      minVisibilitySm: env.PREFLIGHT_MIN_VISIBILITY_SM,
      minCeilingFt: env.PREFLIGHT_MIN_CEILING_FT,
      kpCaution: env.PREFLIGHT_KP_CAUTION,
    },
    tfrRadiusNm: env.PREFLIGHT_TFR_RADIUS_NM,
  };
}
