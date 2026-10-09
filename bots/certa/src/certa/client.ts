import type {
  CurrencyStatus,
  FlightInput,
  FlightTotals,
  LeaderboardEntry,
  LeaderboardOptions,
  LeaderboardPeriod,
  LinkResult,
  LogFlightResult,
} from './types.js';

/**
 * Everything the bot needs from the Certa backend. Commands depend only on
 * this interface; see HttpCertaClient (production) and MockCertaClient (local).
 */
export interface CertaClient {
  redeemLinkCode(code: string, discordUserId: string): Promise<LinkResult>;
  logFlight(certaUserId: string, flight: FlightInput): Promise<LogFlightResult>;
  getTotals(certaUserId: string): Promise<FlightTotals>;
  getCurrency(certaUserId: string): Promise<CurrencyStatus>;
  getLeaderboard(period: LeaderboardPeriod, options?: LeaderboardOptions): Promise<LeaderboardEntry[]>;
}

export class CertaError extends Error {
  override name = 'CertaError';
}

/** The link code is unknown, expired, or already used. */
export class CertaInvalidLinkCodeError extends CertaError {
  override name = 'CertaInvalidLinkCodeError';
}

/** The Certa user no longer exists (e.g. account deleted after linking). */
export class CertaUserNotFoundError extends CertaError {
  override name = 'CertaUserNotFoundError';
}

/** The backend rejected the request payload (HTTP 400/422). */
export class CertaRejectedError extends CertaError {
  override name = 'CertaRejectedError';
  constructor(
    message: string,
    readonly detail?: string,
  ) {
    super(message);
  }
}

/** The bot's API token was rejected (HTTP 401/403). */
export class CertaAuthError extends CertaError {
  override name = 'CertaAuthError';
}

/** Timeout, network error, or 5xx after all retries. */
export class CertaUnavailableError extends CertaError {
  override name = 'CertaUnavailableError';
}

/** The backend responded with a body that does not match the expected schema. */
export class CertaResponseError extends CertaError {
  override name = 'CertaResponseError';
}
