import { randomUUID } from 'node:crypto';
import type { Db } from '@arkhon/shared';
import { DateTime } from 'luxon';
import { type CertaClient, CertaInvalidLinkCodeError, CertaUserNotFoundError } from './client.js';
import {
  type CurrencyStatus,
  type FlightInput,
  flightInputSchema,
  type FlightTotals,
  type LeaderboardEntry,
  type LeaderboardOptions,
  type LeaderboardPeriod,
  type LinkResult,
  type LogFlightResult,
  type PeriodTotals,
} from './types.js';

export interface MockCertaClientOptions {
  timezone: string;
  now?: () => DateTime;
  /**
   * Calendar months before "now" that new mock pilots last completed
   * recurrent training. The default of 23 puts them inside the 60-day
   * reminder window so reminders can be exercised right away.
   */
  seedTrainingMonthsAgo?: number;
}

/**
 * CertaClient backed by the bot's local SQLite database (`mock_*` tables), so
 * every command works before the Certa backend ships. Any well-formed link
 * code is accepted once; the resulting Certa user ID is stable per Discord
 * user so unlinking and relinking keeps logged flights.
 */
export class MockCertaClient implements CertaClient {
  private readonly now: () => DateTime;

  constructor(
    private readonly db: Db,
    private readonly options: MockCertaClientOptions,
  ) {
    this.now = options.now ?? (() => DateTime.now().setZone(options.timezone));
  }

  async redeemLinkCode(code: string, discordUserId: string): Promise<LinkResult> {
    const normalized = code.trim().toUpperCase();
    const existing = this.db.prepare('SELECT 1 FROM mock_redeemed_codes WHERE code = ?').get(normalized);
    if (existing) throw new CertaInvalidLinkCodeError('Link code has already been used');

    const certaUserId = `mock-${discordUserId}`;
    const now = this.now();
    this.db.transaction(() => {
      const trainingDate = now.minus({ months: this.options.seedTrainingMonthsAgo ?? 23 }).toISODate();
      this.db
        .prepare(
          `INSERT OR IGNORE INTO mock_users (certa_user_id, display_name, last_training_date, last_training_kind, created_at)
           VALUES (?, ?, ?, 'recurrent', ?)`,
        )
        .run(certaUserId, `Pilot ${discordUserId.slice(-4)}`, trainingDate, now.toISO());
      this.db
        .prepare('INSERT INTO mock_redeemed_codes (code, certa_user_id, discord_user_id, redeemed_at) VALUES (?, ?, ?, ?)')
        .run(normalized, certaUserId, discordUserId, now.toISO());
    })();

    const user = this.requireUser(certaUserId);
    return { certaUserId, displayName: user.display_name };
  }

  async logFlight(certaUserId: string, flight: FlightInput): Promise<LogFlightResult> {
    this.requireUser(certaUserId);
    const valid = flightInputSchema.parse(flight);
    const flightId = `mock-flt-${randomUUID()}`;
    this.db
      .prepare(
        `INSERT INTO mock_flights
           (flight_id, certa_user_id, date, location, location_is_icao, aircraft, duration_minutes, mission_type, notes, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        flightId,
        certaUserId,
        valid.date,
        valid.location,
        valid.locationIsIcao ? 1 : 0,
        valid.aircraft,
        valid.durationMinutes,
        valid.missionType,
        valid.notes ?? null,
        this.now().toISO(),
      );
    return { flightId };
  }

  async getTotals(certaUserId: string): Promise<FlightTotals> {
    this.requireUser(certaUserId);
    const today = this.now().startOf('day');
    const since = (days: number): PeriodTotals => {
      const from = today.minus({ days: days - 1 }).toISODate();
      const row = this.db
        .prepare(
          `SELECT COUNT(*) AS flights, COALESCE(SUM(duration_minutes), 0) AS minutes
           FROM mock_flights WHERE certa_user_id = ? AND date >= ?`,
        )
        .get(certaUserId, from) as PeriodTotals;
      return { flights: row.flights, minutes: row.minutes };
    };
    const all = this.db
      .prepare(
        `SELECT COUNT(*) AS flights, COALESCE(SUM(duration_minutes), 0) AS minutes
         FROM mock_flights WHERE certa_user_id = ?`,
      )
      .get(certaUserId) as PeriodTotals;

    return {
      totalFlights: all.flights,
      totalMinutes: all.minutes,
      last30Days: since(30),
      last90Days: since(90),
      last365Days: since(365),
    };
  }

  async getCurrency(certaUserId: string): Promise<CurrencyStatus> {
    const user = this.requireUser(certaUserId);
    return {
      lastTrainingDate: user.last_training_date,
      lastTrainingKind: user.last_training_kind,
    };
  }

  async getLeaderboard(period: LeaderboardPeriod, options: LeaderboardOptions = {}): Promise<LeaderboardEntry[]> {
    const limit = options.limit ?? 10;
    const month = options.month ?? this.now().toFormat('yyyy-LL');
    const where = period === 'month' ? 'WHERE f.date LIKE ?' : '';
    const params: unknown[] = period === 'month' ? [`${month}-%`, limit] : [limit];
    const rows = this.db
      .prepare(
        `SELECT u.certa_user_id AS certaUserId, u.display_name AS displayName,
                SUM(f.duration_minutes) AS totalMinutes, COUNT(*) AS flightCount
         FROM mock_flights f JOIN mock_users u ON u.certa_user_id = f.certa_user_id
         ${where}
         GROUP BY u.certa_user_id
         ORDER BY totalMinutes DESC, flightCount DESC, u.display_name ASC
         LIMIT ?`,
      )
      .all(...params) as Omit<LeaderboardEntry, 'rank'>[];
    return rows.map((row, index) => ({ ...row, rank: index + 1 }));
  }

  /** Test/dev helper: sets a pilot's most recent training event. */
  setTraining(certaUserId: string, date: string | null, kind: 'initial' | 'recurrent' | null = 'recurrent'): void {
    this.requireUser(certaUserId);
    this.db
      .prepare('UPDATE mock_users SET last_training_date = ?, last_training_kind = ? WHERE certa_user_id = ?')
      .run(date, date ? kind : null, certaUserId);
  }

  private requireUser(certaUserId: string): {
    display_name: string;
    last_training_date: string | null;
    last_training_kind: 'initial' | 'recurrent' | null;
  } {
    const user = this.db
      .prepare('SELECT display_name, last_training_date, last_training_kind FROM mock_users WHERE certa_user_id = ?')
      .get(certaUserId) as
      | { display_name: string; last_training_date: string | null; last_training_kind: 'initial' | 'recurrent' | null }
      | undefined;
    if (!user) throw new CertaUserNotFoundError(`Mock Certa user ${certaUserId} not found`);
    return user;
  }
}
