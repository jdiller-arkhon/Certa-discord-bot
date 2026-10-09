import { z } from 'zod';

/**
 * FAA TFR data comes from the GeoServer WFS behind tfr.faa.gov (layer
 * `TFR:V_TFR_LOC`), which returns every published TFR as GeoJSON. Verified
 * October 2026; tfr.faa.gov/tfrapi/getTfrList has the same TFRs but no
 * geometry, so it cannot be filtered by distance.
 */
export const FAA_TFR_WFS_URL =
  'https://tfr.faa.gov/geoserver/TFR/ows?service=WFS&version=1.1.0&request=GetFeature' +
  '&typeName=TFR:V_TFR_LOC&outputFormat=application/json&srsname=EPSG:4326';

const position = z.tuple([z.number(), z.number()]).rest(z.number());
const ring = z.array(position);

const geometrySchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('Polygon'), coordinates: z.array(ring) }),
  z.object({ type: z.literal('MultiPolygon'), coordinates: z.array(z.array(ring)) }),
  z.object({ type: z.literal('Point'), coordinates: position }),
]);

const featureSchema = z.object({
  id: z.union([z.string(), z.number()]).nullish(),
  geometry: geometrySchema.nullable(),
  properties: z.object({
    NOTAM_KEY: z.string().nullish(),
    TITLE: z.string().nullish(),
    LEGAL: z.string().nullish(),
    STATE: z.string().nullish(),
  }),
});

export const tfrCollectionSchema = z.object({
  type: z.literal('FeatureCollection'),
  features: z.array(z.unknown()),
});

export interface Tfr {
  notamId: string;
  title: string;
  type: string;
  state: string | null;
  /** Polygons as [lon, lat] rings (outer ring first). */
  polygons: [number, number][][][];
}

export interface NearbyTfr extends Omit<Tfr, 'polygons'> {
  /** 0 when the point is inside the TFR. */
  distanceNm: number;
}

/**
 * Parses the WFS response. Throws if the top-level shape is not a GeoJSON
 * FeatureCollection; individual malformed features are skipped.
 */
export function parseTfrResponse(raw: unknown): Tfr[] {
  const collection = tfrCollectionSchema.parse(raw);
  const tfrs: Tfr[] = [];
  for (const candidate of collection.features) {
    const parsed = featureSchema.safeParse(candidate);
    if (!parsed.success || !parsed.data.geometry) continue;
    const { geometry, properties, id } = parsed.data;
    const toRing = (r: number[][]) => r.map((p) => [p[0], p[1]] as [number, number]);
    const polygons =
      geometry.type === 'Polygon'
        ? [geometry.coordinates.map(toRing)]
        : geometry.type === 'MultiPolygon'
          ? geometry.coordinates.map((poly) => poly.map(toRing))
          : [[[[geometry.coordinates[0], geometry.coordinates[1]] as [number, number]]]];
    const notamId = (properties.NOTAM_KEY?.split('-')[0] ?? String(id ?? '').replace(/^V_TFR_LOC\./, '')) || 'unknown';
    tfrs.push({
      notamId,
      title: properties.TITLE?.trim() || notamId,
      type: properties.LEGAL?.trim() || 'TFR',
      state: properties.STATE ?? null,
      polygons,
    });
  }
  return tfrs;
}

const EARTH_RADIUS_NM = 3440.065;
const toRad = (deg: number) => (deg * Math.PI) / 180;

/** Projects lon/lat to nautical miles on a plane centered at the origin (accurate within a few hundred NM). */
function project(lon: number, lat: number, origin: { lat: number; lon: number }): [number, number] {
  const x = toRad(lon - origin.lon) * Math.cos(toRad(origin.lat)) * EARTH_RADIUS_NM;
  const y = toRad(lat - origin.lat) * EARTH_RADIUS_NM;
  return [x, y];
}

function distanceToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSq = dx * dx + dy * dy;
  const t = lengthSq === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSq));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function insideRing(points: [number, number][]): boolean {
  // Ray cast from the origin (the airport) along +x.
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [xi, yi] = points[i]!;
    const [xj, yj] = points[j]!;
    if (yi > 0 !== yj > 0 && 0 < ((xj - xi) * (0 - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Distance in NM from a point to the nearest edge of a TFR, or 0 if inside. */
export function distanceToTfrNm(tfr: Tfr, point: { lat: number; lon: number }): number {
  let best = Number.POSITIVE_INFINITY;
  for (const polygon of tfr.polygons) {
    const rings = polygon.map((r) => r.map(([lon, lat]) => project(lon, lat, point)));
    const [outer, ...holes] = rings;
    if (!outer || outer.length === 0) continue;
    if (outer.length >= 3 && insideRing(outer) && !holes.some((hole) => hole.length >= 3 && insideRing(hole))) return 0;
    for (const r of rings) {
      if (r.length === 1) best = Math.min(best, Math.hypot(r[0]![0], r[0]![1]));
      for (let i = 0; i + 1 < r.length; i++) {
        const [ax, ay] = r[i]!;
        const [bx, by] = r[i + 1]!;
        best = Math.min(best, distanceToSegment(0, 0, ax, ay, bx, by));
      }
    }
  }
  return best;
}

/** TFRs within `radiusNm` of the point, nearest first. */
export function tfrsNear(tfrs: readonly Tfr[], point: { lat: number; lon: number }, radiusNm: number): NearbyTfr[] {
  return tfrs
    .map((tfr) => ({
      notamId: tfr.notamId,
      title: tfr.title,
      type: tfr.type,
      state: tfr.state,
      distanceNm: distanceToTfrNm(tfr, point),
    }))
    .filter((tfr) => tfr.distanceNm <= radiusNm)
    .sort((a, b) => a.distanceNm - b.distanceNm);
}
