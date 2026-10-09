import { type Db, jobRunsMigrationSql, type Migration, openDatabase } from '@arkhon/shared';

/**
 * The bot stores only Discord/Certa identifiers, display names, and
 * preferences. Never add certificate numbers or other government IDs here.
 */
export const certaMigrations: Migration[] = [
  {
    version: 1,
    name: 'initial',
    sql: `
      CREATE TABLE links (
        discord_user_id TEXT PRIMARY KEY,
        certa_user_id TEXT NOT NULL UNIQUE,
        display_name TEXT NOT NULL,
        reminders_enabled INTEGER NOT NULL DEFAULT 1,
        linked_at TEXT NOT NULL
      );

      -- One row per reminder threshold sent for a given due date. When the
      -- pilot completes recurrent training the due date changes and the
      -- reminder cycle starts fresh.
      CREATE TABLE reminder_sends (
        discord_user_id TEXT NOT NULL,
        due_date TEXT NOT NULL,
        threshold_days INTEGER NOT NULL,
        sent_at TEXT NOT NULL,
        PRIMARY KEY (discord_user_id, due_date, threshold_days)
      );

      -- Minimal public summary kept so the "Share to #flight-logs" button can
      -- post after the modal reply. Notes are deliberately not stored.
      CREATE TABLE shareable_flights (
        flight_id TEXT PRIMARY KEY,
        discord_user_id TEXT NOT NULL,
        date TEXT NOT NULL,
        public_location TEXT NOT NULL,
        aircraft TEXT NOT NULL,
        duration_minutes INTEGER NOT NULL,
        mission_type TEXT NOT NULL,
        shared_at TEXT,
        created_at TEXT NOT NULL
      );

      ${jobRunsMigrationSql}

      -- Tables below back MockCertaClient only (CERTA_CLIENT=mock).
      CREATE TABLE mock_users (
        certa_user_id TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        last_training_date TEXT,
        last_training_kind TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE mock_redeemed_codes (
        code TEXT PRIMARY KEY,
        certa_user_id TEXT NOT NULL REFERENCES mock_users(certa_user_id),
        discord_user_id TEXT NOT NULL,
        redeemed_at TEXT NOT NULL
      );

      CREATE TABLE mock_flights (
        flight_id TEXT PRIMARY KEY,
        certa_user_id TEXT NOT NULL REFERENCES mock_users(certa_user_id),
        date TEXT NOT NULL,
        location TEXT NOT NULL,
        location_is_icao INTEGER NOT NULL,
        aircraft TEXT NOT NULL,
        duration_minutes INTEGER NOT NULL,
        mission_type TEXT NOT NULL,
        notes TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX mock_flights_user_date ON mock_flights (certa_user_id, date);
      CREATE INDEX mock_flights_date ON mock_flights (date);
    `,
  },
];

export function openCertaDatabase(path: string): Db {
  return openDatabase(path, certaMigrations);
}
