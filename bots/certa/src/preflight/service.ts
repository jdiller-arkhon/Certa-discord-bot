import { type FetchFn, type Logger, requestJson, TtlCache } from '@arkhon/shared';
import type { PreflightThresholds } from '../config.js';
import { assessConditions, type PreflightAssessment } from './assess.js';
import { type KpReading, latestKp } from './kp.js';
import { type MetarObservation, parseMetarResponse, parseTafResponse, type TafForecast } from './metar.js';
import { FAA_TFR_WFS_URL, type NearbyTfr, parseTfrResponse, type Tfr, tfrsNear } from './tfr.js';

export const AVIATIONWEATHER_BASE_URL = 'https://aviationweather.gov/api/data';
export const SWPC_KP_URL = 'https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json';
export const CACHE_TTL_MS = 10 * 60_000;
/** TFR section error used when the feed loaded but the airport could not be located. */
export const POSITION_UNKNOWN = 'airport position unknown';

/** Either a value or the reason it could not be fetched. */
export type Section<T> = { ok: true; value: T } | { ok: false; error: string };

export interface PreflightReport {
  icao: string;
  generatedAt: Date;
  metar: Section<MetarObservation | null>;
  taf: Section<TafForecast | null>;
  kp: Section<KpReading | null>;
  tfrs: Section<NearbyTfr[]>;
  tfrRadiusNm: number;
  assessment: PreflightAssessment;
}

export interface PreflightServiceOptions {
  thresholds: PreflightThresholds;
  tfrRadiusNm: number;
  logger: Logger;
  fetchFn?: FetchFn;
  now?: () => Date;
  cacheTtlMs?: number;
}

const USER_AGENT = 'ArkhonCertaBot/1.0 (+https://arkhonindustries.com)';

/**
 * Builds preflight reports. Each upstream (METAR, TAF, Kp, TFR) is fetched
 * independently and cached for 10 minutes; one failing source degrades its
 * own section instead of failing the report.
 */
export class PreflightService {
  private readonly metarCache: TtlCache<MetarObservation | null>;
  private readonly tafCache: TtlCache<TafForecast | null>;
  private readonly kpCache: TtlCache<KpReading | null>;
  private readonly tfrCache: TtlCache<Tfr[]>;
  private readonly now: () => Date;

  constructor(private readonly options: PreflightServiceOptions) {
    const ttl = options.cacheTtlMs ?? CACHE_TTL_MS;
    this.metarCache = new TtlCache(ttl);
    this.tafCache = new TtlCache(ttl);
    this.kpCache = new TtlCache(ttl);
    this.tfrCache = new TtlCache(ttl);
    this.now = options.now ?? (() => new Date());
  }

  async report(icaoInput: string): Promise<PreflightReport> {
    const icao = icaoInput.trim().toUpperCase();
    const [metar, taf, kp, allTfrs] = await Promise.all([
      this.section('metar', icao, () => this.metarCache.getOrLoad(icao, () => this.fetchMetar(icao))),
      this.section('taf', icao, () => this.tafCache.getOrLoad(icao, () => this.fetchTaf(icao))),
      this.section('kp', icao, () => this.kpCache.getOrLoad('kp', () => this.fetchKp())),
      this.section('tfr', icao, () => this.tfrCache.getOrLoad('tfr', () => this.fetchTfrs())),
    ]);

    let tfrs: Section<NearbyTfr[]>;
    if (!allTfrs.ok) {
      tfrs = allTfrs;
    } else if (!metar.ok || !metar.value) {
      tfrs = { ok: false, error: POSITION_UNKNOWN };
    } else {
      tfrs = { ok: true, value: tfrsNear(allTfrs.value, metar.value, this.options.tfrRadiusNm) };
    }

    const assessment = assessConditions(
      metar.ok ? metar.value : null,
      kp.ok ? kp.value : null,
      this.options.thresholds,
      this.now(),
    );

    return { icao, generatedAt: this.now(), metar, taf, kp, tfrs, tfrRadiusNm: this.options.tfrRadiusNm, assessment };
  }

  private async section<T>(source: string, icao: string, load: () => Promise<T>): Promise<Section<T>> {
    try {
      return { ok: true, value: await load() };
    } catch (error) {
      this.options.logger.warn('Preflight source failed', { source, icao, error });
      return { ok: false, error: describeError(error) };
    }
  }

  private get(url: string): Promise<unknown> {
    return requestJson(url, {
      headers: { 'user-agent': USER_AGENT },
      timeoutMs: 10_000,
      attempts: 2,
      fetchFn: this.options.fetchFn,
    });
  }

  private async fetchMetar(icao: string): Promise<MetarObservation | null> {
    const raw = await this.get(`${AVIATIONWEATHER_BASE_URL}/metar?ids=${encodeURIComponent(icao)}&format=json`);
    return parseMetarResponse(raw)[0] ?? null;
  }

  private async fetchTaf(icao: string): Promise<TafForecast | null> {
    const raw = await this.get(`${AVIATIONWEATHER_BASE_URL}/taf?ids=${encodeURIComponent(icao)}&format=json`);
    return parseTafResponse(raw)[0] ?? null;
  }

  private async fetchKp(): Promise<KpReading | null> {
    return latestKp(await this.get(SWPC_KP_URL));
  }

  private async fetchTfrs(): Promise<Tfr[]> {
    return parseTfrResponse(await this.get(FAA_TFR_WFS_URL));
  }
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === 'ZodError') return 'unexpected data format';
    if (error.name === 'HttpTimeoutError') return 'timed out';
    if (error.name === 'HttpError') return error.message.replace(/ from .*/, '');
    if (error.name === 'SyntaxError') return 'unreadable response';
    return 'unavailable';
  }
  return 'unavailable';
}
