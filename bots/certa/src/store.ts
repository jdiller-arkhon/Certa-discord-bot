import type { Db } from '@arkhon/shared';
import type { MissionType } from './certa/types.js';

export interface Link {
  discordUserId: string;
  certaUserId: string;
  displayName: string;
  remindersEnabled: boolean;
  linkedAt: string;
}

export interface ShareableFlight {
  flightId: string;
  discordUserId: string;
  date: string;
  publicLocation: string;
  aircraft: string;
  durationMinutes: number;
  missionType: MissionType;
  sharedAt: string | null;
}

interface LinkRow {
  discord_user_id: string;
  certa_user_id: string;
  display_name: string;
  reminders_enabled: number;
  linked_at: string;
}

const toLink = (row: LinkRow): Link => ({
  discordUserId: row.discord_user_id,
  certaUserId: row.certa_user_id,
  displayName: row.display_name,
  remindersEnabled: row.reminders_enabled === 1,
  linkedAt: row.linked_at,
});

/** Data access for the bot's own tables. */
export class CertaStore {
  constructor(readonly db: Db) {}

  getLink(discordUserId: string): Link | undefined {
    const row = this.db.prepare('SELECT * FROM links WHERE discord_user_id = ?').get(discordUserId) as LinkRow | undefined;
    return row ? toLink(row) : undefined;
  }

  listLinks(): Link[] {
    return (this.db.prepare('SELECT * FROM links ORDER BY linked_at').all() as LinkRow[]).map(toLink);
  }

  listLinksWithRemindersEnabled(): Link[] {
    return (this.db.prepare('SELECT * FROM links WHERE reminders_enabled = 1 ORDER BY linked_at').all() as LinkRow[]).map(
      toLink,
    );
  }

  /**
   * Stores the mapping. A Certa account can be linked to only one Discord
   * account, so any previous link for either side is replaced.
   */
  upsertLink(discordUserId: string, certaUserId: string, displayName: string, now: Date = new Date()): void {
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM links WHERE certa_user_id = ? AND discord_user_id != ?').run(certaUserId, discordUserId);
      this.db
        .prepare(
          `INSERT INTO links (discord_user_id, certa_user_id, display_name, reminders_enabled, linked_at)
           VALUES (?, ?, ?, 1, ?)
           ON CONFLICT (discord_user_id) DO UPDATE SET
             certa_user_id = excluded.certa_user_id,
             display_name = excluded.display_name,
             linked_at = excluded.linked_at`,
        )
        .run(discordUserId, certaUserId, displayName, now.toISOString());
    })();
  }

  /** Removes the link and everything the bot holds for that user. */
  deleteLink(discordUserId: string): boolean {
    return this.db.transaction(() => {
      const removed = this.db.prepare('DELETE FROM links WHERE discord_user_id = ?').run(discordUserId).changes > 0;
      this.db.prepare('DELETE FROM reminder_sends WHERE discord_user_id = ?').run(discordUserId);
      this.db.prepare('DELETE FROM shareable_flights WHERE discord_user_id = ? AND shared_at IS NULL').run(discordUserId);
      return removed;
    })();
  }

  setRemindersEnabled(discordUserId: string, enabled: boolean): boolean {
    return (
      this.db
        .prepare('UPDATE links SET reminders_enabled = ? WHERE discord_user_id = ?')
        .run(enabled ? 1 : 0, discordUserId).changes > 0
    );
  }

  /** Map of Certa user ID -> Discord user ID for every linked user. */
  discordIdsByCertaId(): Map<string, string> {
    const rows = this.db.prepare('SELECT certa_user_id, discord_user_id FROM links').all() as Pick<
      LinkRow,
      'certa_user_id' | 'discord_user_id'
    >[];
    return new Map(rows.map((row) => [row.certa_user_id, row.discord_user_id]));
  }

  sentReminderThresholds(discordUserId: string, dueDate: string): number[] {
    const rows = this.db
      .prepare('SELECT threshold_days FROM reminder_sends WHERE discord_user_id = ? AND due_date = ?')
      .all(discordUserId, dueDate) as { threshold_days: number }[];
    return rows.map((row) => row.threshold_days);
  }

  recordRemindersSent(discordUserId: string, dueDate: string, thresholds: readonly number[], now: Date = new Date()): void {
    const insert = this.db.prepare(
      'INSERT OR IGNORE INTO reminder_sends (discord_user_id, due_date, threshold_days, sent_at) VALUES (?, ?, ?, ?)',
    );
    this.db.transaction(() => {
      for (const threshold of thresholds) insert.run(discordUserId, dueDate, threshold, now.toISOString());
    })();
  }

  saveShareableFlight(flight: Omit<ShareableFlight, 'sharedAt'>, now: Date = new Date()): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO shareable_flights
           (flight_id, discord_user_id, date, public_location, aircraft, duration_minutes, mission_type, shared_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
      )
      .run(
        flight.flightId,
        flight.discordUserId,
        flight.date,
        flight.publicLocation,
        flight.aircraft,
        flight.durationMinutes,
        flight.missionType,
        now.toISOString(),
      );
  }

  getShareableFlight(flightId: string): ShareableFlight | undefined {
    const row = this.db.prepare('SELECT * FROM shareable_flights WHERE flight_id = ?').get(flightId) as
      | {
          flight_id: string;
          discord_user_id: string;
          date: string;
          public_location: string;
          aircraft: string;
          duration_minutes: number;
          mission_type: MissionType;
          shared_at: string | null;
        }
      | undefined;
    if (!row) return undefined;
    return {
      flightId: row.flight_id,
      discordUserId: row.discord_user_id,
      date: row.date,
      publicLocation: row.public_location,
      aircraft: row.aircraft,
      durationMinutes: row.duration_minutes,
      missionType: row.mission_type,
      sharedAt: row.shared_at,
    };
  }

  /** Marks a flight shared; returns false if it was already shared (double click). */
  markShared(flightId: string, now: Date = new Date()): boolean {
    return (
      this.db
        .prepare('UPDATE shareable_flights SET shared_at = ? WHERE flight_id = ? AND shared_at IS NULL')
        .run(now.toISOString(), flightId).changes > 0
    );
  }

  /** Reverts {@link markShared} when posting fails, so the user can retry. */
  unmarkShared(flightId: string): void {
    this.db.prepare('UPDATE shareable_flights SET shared_at = NULL WHERE flight_id = ?').run(flightId);
  }

  /** Drops unshared summaries older than `days` so the table stays small. */
  pruneShareableFlights(days: number, now: Date = new Date()): void {
    const cutoff = new Date(now.getTime() - days * 86_400_000).toISOString();
    this.db.prepare('DELETE FROM shareable_flights WHERE shared_at IS NULL AND created_at < ?').run(cutoff);
  }
}
