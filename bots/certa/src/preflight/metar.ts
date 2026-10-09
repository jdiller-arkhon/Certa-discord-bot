import { z } from 'zod';

// Shapes follow the aviationweather.gov Data API (`/api/data/metar` and
// `/api/data/taf` with `format=json`). Only the fields the bot uses are
// declared; everything else is stripped.

const numberish = z.union([z.number(), z.string()]).nullish();

const cloudSchema = z.object({
  cover: z.string(),
  base: z.number().nullish(),
});

export const metarItemSchema = z.object({
  icaoId: z.string(),
  name: z.string().nullish(),
  obsTime: z.number(),
  rawOb: z.string(),
  lat: z.number(),
  lon: z.number(),
  elev: z.number().nullish(),
  temp: z.number().nullish(),
  dewp: z.number().nullish(),
  wdir: numberish,
  wspd: z.number().nullish(),
  wgst: z.number().nullish(),
  visib: numberish,
  altim: z.number().nullish(),
  vertVis: z.number().nullish(),
  wxString: z.string().nullish(),
  clouds: z.array(cloudSchema).nullish(),
  fltCat: z.string().nullish(),
});
export const metarResponseSchema = z.array(metarItemSchema);

export const tafItemSchema = z.object({
  icaoId: z.string(),
  rawTAF: z.string(),
  issueTime: z.string().nullish(),
  validTimeFrom: z.number().nullish(),
  validTimeTo: z.number().nullish(),
});
export const tafResponseSchema = z.array(tafItemSchema);

export interface MetarObservation {
  icao: string;
  name: string | null;
  observedAt: Date;
  raw: string;
  lat: number;
  lon: number;
  /** Degrees true, `'VRB'` for variable, null if calm/missing. */
  windDirection: number | 'VRB' | null;
  windSpeedKt: number | null;
  gustKt: number | null;
  /** Statute miles. "10+" is reported as 10. */
  visibilitySm: number | null;
  /** Lowest broken/overcast layer or vertical visibility in feet AGL; null if none (unlimited). */
  ceilingFt: number | null;
  temperatureC: number | null;
  dewpointC: number | null;
  altimeterInHg: number | null;
  weather: string | null;
  flightCategory: string | null;
}

export interface TafForecast {
  icao: string;
  raw: string;
  validFrom: Date | null;
  validTo: Date | null;
}

/** Parses `"10+"`, `"6+"`, `"1/2"`, `"1 1/2"`, `"M1/4"` and numbers into statute miles. */
export function parseVisibility(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const text = value.trim().replace(/^[PM]/i, '').replace(/\+$/, '').replace(/SM$/i, '').trim();
  if (text === '') return null;
  let total = 0;
  for (const part of text.split(/\s+/)) {
    if (part.includes('/')) {
      const [num, den] = part.split('/').map(Number);
      if (num === undefined || den === undefined || !Number.isFinite(num) || !Number.isFinite(den) || den === 0) return null;
      total += num / den;
    } else {
      const n = Number(part);
      if (!Number.isFinite(n)) return null;
      total += n;
    }
  }
  return total;
}

const CEILING_COVERS = new Set(['BKN', 'OVC', 'OVX', 'VV']);

export function parseCeiling(clouds: readonly { cover: string; base?: number | null }[] | null | undefined, vertVis?: number | null): number | null {
  const bases = (clouds ?? [])
    .filter((layer) => CEILING_COVERS.has(layer.cover.toUpperCase()) && typeof layer.base === 'number')
    .map((layer) => layer.base as number);
  if (typeof vertVis === 'number') bases.push(vertVis);
  return bases.length > 0 ? Math.min(...bases) : null;
}

function parseWindDirection(value: number | string | null | undefined): number | 'VRB' | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return value;
  if (value.toUpperCase() === 'VRB') return 'VRB';
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Validates an aviationweather.gov METAR response and returns the most recent
 * observation per station, newest first. An empty/204 response yields [].
 */
export function parseMetarResponse(raw: unknown): MetarObservation[] {
  if (raw === null || raw === undefined) return [];
  const items = metarResponseSchema.parse(raw);
  const latest = new Map<string, z.infer<typeof metarItemSchema>>();
  for (const item of items) {
    const current = latest.get(item.icaoId);
    if (!current || item.obsTime > current.obsTime) latest.set(item.icaoId, item);
  }
  return [...latest.values()]
    .sort((a, b) => b.obsTime - a.obsTime)
    .map((item) => ({
      icao: item.icaoId,
      name: item.name ?? null,
      observedAt: new Date(item.obsTime * 1000),
      raw: item.rawOb,
      lat: item.lat,
      lon: item.lon,
      windDirection: parseWindDirection(item.wdir),
      windSpeedKt: item.wspd ?? null,
      gustKt: item.wgst ?? null,
      visibilitySm: parseVisibility(item.visib),
      ceilingFt: parseCeiling(item.clouds, item.vertVis),
      temperatureC: item.temp ?? null,
      dewpointC: item.dewp ?? null,
      // The API reports altimeter in hectopascals.
      altimeterInHg: typeof item.altim === 'number' ? Math.round(item.altim * 0.0295300 * 100) / 100 : null,
      weather: item.wxString ?? null,
      flightCategory: item.fltCat ?? null,
    }));
}

export function parseTafResponse(raw: unknown): TafForecast[] {
  if (raw === null || raw === undefined) return [];
  return tafResponseSchema.parse(raw).map((item) => ({
    icao: item.icaoId,
    raw: item.rawTAF,
    validFrom: typeof item.validTimeFrom === 'number' ? new Date(item.validTimeFrom * 1000) : null,
    validTo: typeof item.validTimeTo === 'number' ? new Date(item.validTimeTo * 1000) : null,
  }));
}
