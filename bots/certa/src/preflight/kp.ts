import { z } from 'zod';

// NOAA SWPC `products/noaa-planetary-k-index.json`. The current format is an
// array of objects; older deployments served an array of string arrays with a
// header row. Both are accepted.

const objectRowSchema = z.object({
  time_tag: z.string(),
  Kp: z.union([z.number(), z.string()]),
});
const objectFormatSchema = z.array(objectRowSchema);
const tableFormatSchema = z.array(z.array(z.union([z.string(), z.number(), z.null()])));

export interface KpReading {
  kp: number;
  /** Start of the 3-hour interval the value covers. */
  observedAt: Date;
}

function parseTimeTag(tag: string): Date {
  // SWPC time tags are UTC without a zone suffix ("2026-10-09T18:00:00" or "2026-10-09 18:00:00.000").
  const iso = tag.trim().replace(' ', 'T');
  return new Date(/Z|[+-]\d{2}:?\d{2}$/.test(iso) ? iso : `${iso}Z`);
}

function toReading(timeTag: unknown, kp: unknown): KpReading | null {
  if (typeof timeTag !== 'string') return null;
  const value = typeof kp === 'number' ? kp : Number(kp);
  const observedAt = parseTimeTag(timeTag);
  if (!Number.isFinite(value) || Number.isNaN(observedAt.getTime())) return null;
  return { kp: value, observedAt };
}

/** Returns all readings in chronological order. Throws if the format is unrecognized. */
export function parseKpResponse(raw: unknown): KpReading[] {
  const objects = objectFormatSchema.safeParse(raw);
  let readings: (KpReading | null)[];
  if (objects.success) {
    readings = objects.data.map((row) => toReading(row.time_tag, row.Kp));
  } else {
    const table = tableFormatSchema.parse(raw);
    const [header, ...rows] = table;
    const timeIndex = header?.indexOf('time_tag') ?? -1;
    const kpIndex = header?.indexOf('Kp') ?? -1;
    if (timeIndex < 0 || kpIndex < 0) throw new Error('Kp table is missing time_tag/Kp columns');
    readings = rows.map((row) => toReading(row[timeIndex], row[kpIndex]));
  }
  return readings
    .filter((reading): reading is KpReading => reading !== null)
    .sort((a, b) => a.observedAt.getTime() - b.observedAt.getTime());
}

/** Most recent reading, or null if the feed is empty. */
export function latestKp(raw: unknown): KpReading | null {
  const readings = parseKpResponse(raw);
  return readings.at(-1) ?? null;
}
