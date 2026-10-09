import { randomUUID } from 'node:crypto';
import { type FetchFn, HttpError, HttpNetworkError, HttpTimeoutError, requestJson } from '@arkhon/shared';
import type { z } from 'zod';
import {
  type CertaClient,
  CertaAuthError,
  CertaError,
  CertaInvalidLinkCodeError,
  CertaRejectedError,
  CertaResponseError,
  CertaUnavailableError,
  CertaUserNotFoundError,
} from './client.js';
import {
  type CurrencyStatus,
  currencyStatusSchema,
  type FlightInput,
  type FlightTotals,
  flightTotalsSchema,
  type LeaderboardEntry,
  type LeaderboardOptions,
  type LeaderboardPeriod,
  leaderboardResponseSchema,
  type LinkResult,
  linkResultSchema,
  type LogFlightResult,
  logFlightResultSchema,
} from './types.js';

export interface HttpCertaClientOptions {
  baseUrl: string;
  token: string;
  timeoutMs?: number;
  attempts?: number;
  backoffMs?: number;
  fetchFn?: FetchFn;
  sleep?: (ms: number) => Promise<void>;
}

type NotFoundMeaning = 'user' | 'link-code';

/**
 * Certa REST client. Every request uses a bearer token, a 10s per-attempt
 * timeout, and up to 3 attempts with exponential backoff on 5xx/timeouts.
 * POSTs carry an `Idempotency-Key` so retries cannot create duplicates.
 */
export class HttpCertaClient implements CertaClient {
  private readonly baseUrl: string;

  constructor(private readonly options: HttpCertaClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
  }

  async redeemLinkCode(code: string, discordUserId: string): Promise<LinkResult> {
    return this.call(linkResultSchema, 'POST', '/v1/discord/link-codes/redeem', {
      body: { code, discordUserId },
      notFound: 'link-code',
    });
  }

  async logFlight(certaUserId: string, flight: FlightInput): Promise<LogFlightResult> {
    return this.call(logFlightResultSchema, 'POST', `/v1/users/${encodeURIComponent(certaUserId)}/flights`, {
      body: flight,
      notFound: 'user',
    });
  }

  async getTotals(certaUserId: string): Promise<FlightTotals> {
    return this.call(flightTotalsSchema, 'GET', `/v1/users/${encodeURIComponent(certaUserId)}/flight-totals`, {
      notFound: 'user',
    });
  }

  async getCurrency(certaUserId: string): Promise<CurrencyStatus> {
    return this.call(currencyStatusSchema, 'GET', `/v1/users/${encodeURIComponent(certaUserId)}/currency`, {
      notFound: 'user',
    });
  }

  async getLeaderboard(period: LeaderboardPeriod, options: LeaderboardOptions = {}): Promise<LeaderboardEntry[]> {
    const params = new URLSearchParams({ period, limit: String(options.limit ?? 10) });
    if (options.month) params.set('month', options.month);
    const response = await this.call(leaderboardResponseSchema, 'GET', `/v1/leaderboard?${params}`, {});
    return response.entries;
  }

  private async call<S extends z.ZodTypeAny>(
    schema: S,
    method: 'GET' | 'POST',
    path: string,
    opts: { body?: unknown; notFound?: NotFoundMeaning },
  ): Promise<z.infer<S>> {
    const headers: Record<string, string> = { authorization: `Bearer ${this.options.token}` };
    if (method === 'POST') headers['idempotency-key'] = randomUUID();

    let raw: unknown;
    try {
      raw = await requestJson(`${this.baseUrl}${path}`, {
        method,
        headers,
        json: opts.body,
        timeoutMs: this.options.timeoutMs ?? 10_000,
        attempts: this.options.attempts ?? 3,
        backoffMs: this.options.backoffMs ?? 500,
        fetchFn: this.options.fetchFn,
        sleep: this.options.sleep,
      });
    } catch (error) {
      throw translateError(error, opts.notFound);
    }

    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      throw new CertaResponseError(`Unexpected response from Certa ${method} ${path.split('?')[0]}: ${parsed.error.message}`);
    }
    return parsed.data;
  }
}

function extractMessage(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body) as { message?: unknown; error?: unknown };
    if (typeof parsed.message === 'string') return parsed.message;
    if (typeof parsed.error === 'string') return parsed.error;
  } catch {
    // Not JSON; fall through.
  }
  return undefined;
}

function translateError(error: unknown, notFound: NotFoundMeaning | undefined): CertaError {
  if (error instanceof HttpError) {
    const detail = extractMessage(error.body);
    if (error.status === 401 || error.status === 403) return new CertaAuthError('Certa rejected the bot API token');
    if ((error.status === 404 || error.status === 410) && notFound === 'link-code') {
      return new CertaInvalidLinkCodeError(detail ?? 'Link code is invalid, expired, or already used');
    }
    if (error.status === 404 && notFound === 'user') return new CertaUserNotFoundError(detail ?? 'Certa user not found');
    if (error.status === 400 || error.status === 409 || error.status === 422) {
      return new CertaRejectedError('Certa rejected the request', detail);
    }
    if (error.status >= 500) return new CertaUnavailableError(`Certa returned HTTP ${error.status} after retries`);
    return new CertaError(`Certa returned HTTP ${error.status}`);
  }
  if (error instanceof HttpTimeoutError || error instanceof HttpNetworkError) {
    return new CertaUnavailableError(error.message);
  }
  if (error instanceof SyntaxError) return new CertaResponseError('Certa returned a non-JSON response');
  return new CertaError(error instanceof Error ? error.message : String(error));
}
