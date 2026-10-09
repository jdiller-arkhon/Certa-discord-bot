import { DateTime } from 'luxon';
import { describe, expect, it } from 'vitest';
import {
  CertaAuthError,
  CertaInvalidLinkCodeError,
  CertaResponseError,
  CertaUnavailableError,
  CertaUserNotFoundError,
} from '../src/certa/client.js';
import { HttpCertaClient } from '../src/certa/http-client.js';
import { MockCertaClient } from '../src/certa/mock-client.js';
import type { FlightInput } from '../src/certa/types.js';
import { openCertaDatabase } from '../src/db.js';

type Call = { url: string; init: RequestInit };

function fakeFetch(responses: (() => Response | Promise<Response>)[]) {
  const calls: Call[] = [];
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = responses.shift();
    if (!next) throw new Error('unexpected request');
    return next();
  }) as typeof fetch;
  return { fn, calls };
}

const json = (status: number, body: unknown) => () =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function client(responses: (() => Response | Promise<Response>)[]) {
  const fake = fakeFetch(responses);
  const sleeps: number[] = [];
  const certa = new HttpCertaClient({
    baseUrl: 'https://certa.example.com/api/',
    token: 'secret-token',
    fetchFn: fake.fn,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  return { certa, calls: fake.calls, sleeps };
}

const flight: FlightInput = {
  date: '2026-10-09',
  location: 'KBJC',
  locationIsIcao: true,
  aircraft: 'DJI Mavic 3E',
  durationMinutes: 25,
  missionType: 'Inspection',
};

describe('HttpCertaClient', () => {
  it('sends a bearer token and validates the response', async () => {
    const { certa, calls } = client([json(200, { certaUserId: 'u1', displayName: 'Ava', faaCertificateNumber: '4321' })]);
    const result = await certa.redeemLinkCode('ABC123', '123456789012345678');
    expect(result).toEqual({ certaUserId: 'u1', displayName: 'Ava' });
    expect(result).not.toHaveProperty('faaCertificateNumber');
    expect(calls[0]?.url).toBe('https://certa.example.com/api/v1/discord/link-codes/redeem');
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer secret-token');
    expect(headers['idempotency-key']).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ code: 'ABC123', discordUserId: '123456789012345678' });
  });

  it('retries 5xx with exponential backoff and reuses the idempotency key', async () => {
    const { certa, calls, sleeps } = client([json(503, {}), json(502, {}), json(201, { flightId: 'f1' })]);
    expect(await certa.logFlight('u1', flight)).toEqual({ flightId: 'f1' });
    expect(calls).toHaveLength(3);
    expect(sleeps).toEqual([500, 1000]);
    const keys = calls.map((c) => (c.init.headers as Record<string, string>)['idempotency-key']);
    expect(new Set(keys).size).toBe(1);
  });

  it('gives up after 3 attempts', async () => {
    const { certa, calls } = client([json(500, {}), json(500, {}), json(500, {})]);
    await expect(certa.getTotals('u1')).rejects.toBeInstanceOf(CertaUnavailableError);
    expect(calls).toHaveLength(3);
  });

  it('does not retry 4xx and maps them to typed errors', async () => {
    await expect(client([json(404, { message: 'expired' })]).certa.redeemLinkCode('ABC123', '1')).rejects.toBeInstanceOf(
      CertaInvalidLinkCodeError,
    );
    await expect(client([json(404, {})]).certa.getCurrency('u1')).rejects.toBeInstanceOf(CertaUserNotFoundError);
    const auth = client([json(401, {})]);
    await expect(auth.certa.getTotals('u1')).rejects.toBeInstanceOf(CertaAuthError);
    expect(auth.calls).toHaveLength(1);
  });

  it('rejects responses that do not match the schema', async () => {
    await expect(client([json(200, { totalFlights: 'many' })]).certa.getTotals('u1')).rejects.toBeInstanceOf(CertaResponseError);
  });

  it('times out slow requests', async () => {
    const slow = () =>
      new Promise<Response>(() => {
        /* never resolves; aborted by timeout */
      });
    const fake = fakeFetch([slow, slow, slow]);
    // Make the fake honour the abort signal like real fetch.
    const fetchFn = (async (url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        void fake.fn(url, init);
      })) as typeof fetch;
    const certa = new HttpCertaClient({ baseUrl: 'https://x', token: 't', fetchFn, timeoutMs: 20, sleep: async () => {} });
    await expect(certa.getCurrency('u1')).rejects.toBeInstanceOf(CertaUnavailableError);
    expect(fake.calls).toHaveLength(3);
  });

  it('passes leaderboard period and month', async () => {
    const entry = { rank: 1, certaUserId: 'u1', displayName: 'Ava', totalMinutes: 90, flightCount: 2 };
    const { certa, calls } = client([json(200, { entries: [entry] })]);
    expect(await certa.getLeaderboard('month', { month: '2026-09' })).toEqual([entry]);
    expect(calls[0]?.url).toBe('https://certa.example.com/api/v1/leaderboard?period=month&limit=10&month=2026-09');
  });
});

describe('MockCertaClient', () => {
  function setup() {
    let now = DateTime.fromISO('2026-10-09T12:00', { zone: 'America/Denver' });
    const db = openCertaDatabase(':memory:');
    const certa = new MockCertaClient(db, { timezone: 'America/Denver', now: () => now });
    return { certa, setNow: (iso: string) => (now = DateTime.fromISO(iso, { zone: 'America/Denver' })) };
  }

  it('redeems a code once and keeps a stable user per Discord account', async () => {
    const { certa } = setup();
    const first = await certa.redeemLinkCode('abc123', '111111111111111111');
    expect(first.certaUserId).toBe('mock-111111111111111111');
    await expect(certa.redeemLinkCode('ABC123', '111111111111111111')).rejects.toBeInstanceOf(CertaInvalidLinkCodeError);
    expect((await certa.redeemLinkCode('XYZ789', '111111111111111111')).certaUserId).toBe(first.certaUserId);
  });

  it('seeds training inside the reminder window', async () => {
    const { certa } = setup();
    const { certaUserId } = await certa.redeemLinkCode('ABC123', '111111111111111111');
    expect(await certa.getCurrency(certaUserId)).toEqual({ lastTrainingDate: '2024-11-09', lastTrainingKind: 'recurrent' });
  });

  it('computes totals over rolling windows', async () => {
    const { certa } = setup();
    const { certaUserId } = await certa.redeemLinkCode('ABC123', '111111111111111111');
    await certa.logFlight(certaUserId, { ...flight, date: '2026-10-09', durationMinutes: 30 });
    await certa.logFlight(certaUserId, { ...flight, date: '2026-09-10', durationMinutes: 20 }); // day 30
    await certa.logFlight(certaUserId, { ...flight, date: '2026-09-09', durationMinutes: 10 }); // day 31
    await certa.logFlight(certaUserId, { ...flight, date: '2025-01-01', durationMinutes: 60 });
    expect(await certa.getTotals(certaUserId)).toEqual({
      totalFlights: 4,
      totalMinutes: 120,
      last30Days: { flights: 2, minutes: 50 },
      last90Days: { flights: 3, minutes: 60 },
      last365Days: { flights: 3, minutes: 60 },
    });
  });

  it('ranks the monthly leaderboard and supports a past month', async () => {
    const { certa } = setup();
    const a = await certa.redeemLinkCode('CODE-A1', '111111111111111111');
    const b = await certa.redeemLinkCode('CODE-B1', '222222222222222222');
    await certa.logFlight(a.certaUserId, { ...flight, date: '2026-10-02', durationMinutes: 30 });
    await certa.logFlight(b.certaUserId, { ...flight, date: '2026-10-03', durationMinutes: 45 });
    await certa.logFlight(a.certaUserId, { ...flight, date: '2026-09-30', durationMinutes: 200 });

    const october = await certa.getLeaderboard('month');
    expect(october.map((e) => [e.rank, e.certaUserId, e.totalMinutes])).toEqual([
      [1, b.certaUserId, 45],
      [2, a.certaUserId, 30],
    ]);
    const september = await certa.getLeaderboard('month', { month: '2026-09' });
    expect(september.map((e) => e.certaUserId)).toEqual([a.certaUserId]);
    expect((await certa.getLeaderboard('all'))[0]).toMatchObject({ certaUserId: a.certaUserId, totalMinutes: 230, flightCount: 2 });
  });

  it('rejects unknown users', async () => {
    const { certa } = setup();
    await expect(certa.getTotals('nobody')).rejects.toBeInstanceOf(CertaUserNotFoundError);
  });
});
