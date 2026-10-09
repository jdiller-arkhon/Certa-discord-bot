import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { latestKp, parseKpResponse } from '../src/preflight/kp.js';
import { parseCeiling, parseMetarResponse, parseTafResponse, parseVisibility } from '../src/preflight/metar.js';
import { distanceToTfrNm, parseTfrResponse, tfrsNear } from '../src/preflight/tfr.js';

// Fixtures are responses recorded from the live APIs on 2026-10-09.
const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')) as unknown;

describe('METAR parsing (aviationweather.gov)', () => {
  it('parses a recorded KDEN observation', () => {
    const [metar] = parseMetarResponse(fixture('metar-kden.json'));
    expect(metar).toMatchObject({
      icao: 'KDEN',
      name: 'Denver Intl, CO, US',
      windDirection: 190,
      windSpeedKt: 17,
      gustKt: null,
      visibilitySm: 10,
      ceilingFt: null,
      temperatureC: 29.4,
      dewpointC: -6.7,
      altimeterInHg: 29.89,
      flightCategory: 'VFR',
      lat: 39.8466,
      lon: -104.6562,
    });
    expect(metar?.observedAt.toISOString()).toBe('2026-10-09T21:53:00.000Z');
    expect(metar?.raw).toMatch(/^METAR KDEN 092153Z 19017KT/);
  });

  it('keeps the newest observation per station from a multi-station response', () => {
    const metars = parseMetarResponse(fixture('metar-multi.json'));
    const byIcao = new Map(metars.map((m) => [m.icao, m]));
    expect(byIcao.size).toBe(10);
    expect(byIcao.get('KPDX')).toMatchObject({ windSpeedKt: 7, gustKt: 17, ceilingFt: 4200 });
    expect(byIcao.get('KBOS')).toMatchObject({ windSpeedKt: 14, gustKt: 23, ceilingFt: null });
    expect(byIcao.get('KBTV')).toMatchObject({ ceilingFt: 6000, weather: '-RA' });
    expect(byIcao.get('KDTW')).toMatchObject({ windSpeedKt: 0, ceilingFt: 8500 });
  });

  it('treats an empty (HTTP 204) response as no data', () => {
    expect(parseMetarResponse(null)).toEqual([]);
    expect(parseMetarResponse([])).toEqual([]);
  });

  it('rejects an unexpected shape', () => {
    expect(() => parseMetarResponse({ error: 'bad' })).toThrow();
    expect(() => parseMetarResponse([{ icaoId: 'KDEN' }])).toThrow();
  });

  it('parses visibility strings', () => {
    expect(parseVisibility('10+')).toBe(10);
    expect(parseVisibility('6+')).toBe(6);
    expect(parseVisibility('1/2')).toBe(0.5);
    expect(parseVisibility('1 1/2')).toBe(1.5);
    expect(parseVisibility('M1/4')).toBe(0.25);
    expect(parseVisibility(3)).toBe(3);
    expect(parseVisibility(null)).toBeNull();
    expect(parseVisibility('abc')).toBeNull();
  });

  it('derives ceiling from the lowest broken/overcast layer or vertical visibility', () => {
    expect(parseCeiling([{ cover: 'FEW', base: 800 }, { cover: 'SCT', base: 2000 }])).toBeNull();
    expect(parseCeiling([{ cover: 'SCT', base: 900 }, { cover: 'BKN', base: 2500 }, { cover: 'OVC', base: 1200 }])).toBe(1200);
    expect(parseCeiling([], 300)).toBe(300);
    expect(parseCeiling(null)).toBeNull();
  });
});

describe('TAF parsing', () => {
  it('parses a recorded KDEN TAF', () => {
    const [taf] = parseTafResponse(fixture('taf-kden.json'));
    expect(taf?.icao).toBe('KDEN');
    expect(taf?.raw).toMatch(/^TAF KDEN 092030Z 0920\/1024/);
    expect(taf?.validFrom?.toISOString()).toBe('2026-10-09T20:00:00.000Z');
  });

  it('returns nothing for an unknown station', () => {
    expect(parseTafResponse(fixture('taf-unknown.json'))).toEqual([]);
  });
});

describe('Kp parsing (NOAA SWPC)', () => {
  it('parses the recorded object-format feed and returns the latest value', () => {
    const readings = parseKpResponse(fixture('kp-index.json'));
    expect(readings.length).toBeGreaterThan(50);
    expect(readings[0]?.observedAt.toISOString()).toBe('2026-10-02T00:00:00.000Z');
    expect(latestKp(fixture('kp-index.json'))).toEqual({ kp: 1.33, observedAt: new Date('2026-10-09T18:00:00Z') });
  });

  it('finds the elevated reading in the recorded week', () => {
    const peak = Math.max(...parseKpResponse(fixture('kp-index.json')).map((r) => r.kp));
    expect(peak).toBeGreaterThanOrEqual(4);
  });

  it('accepts the legacy table format with a header row', () => {
    const legacy = [
      ['time_tag', 'Kp', 'a_running', 'station_count'],
      ['2026-10-09 15:00:00.000', '5.33', '56', '8'],
      ['2026-10-09 18:00:00.000', '6.00', '80', '8'],
    ];
    expect(latestKp(legacy)).toEqual({ kp: 6, observedAt: new Date('2026-10-09T18:00:00Z') });
  });

  it('throws on an unrecognized format and returns null for an empty feed', () => {
    expect(() => parseKpResponse({ message: 'maintenance' })).toThrow();
    expect(() => parseKpResponse([['time', 'value']])).toThrow(/missing/);
    expect(latestKp([])).toBeNull();
  });
});

describe('TFR parsing (FAA WFS)', () => {
  const tfrs = parseTfrResponse(fixture('tfr-wfs.json'));

  it('parses recorded features', () => {
    expect(tfrs).toHaveLength(8);
    expect(tfrs[1]).toMatchObject({ notamId: '6/6656', type: 'SECURITY', state: 'MN' });
    expect(tfrs[1]?.title).toMatch(/^ANOKA, MN/);
  });

  it('measures distance from an airport and filters by radius', () => {
    const anoka = tfrs[1]!;
    // Inside the TFR at its center.
    expect(distanceToTfrNm(anoka, { lat: 45.2014, lon: -93.3702 })).toBe(0);
    // Anoka County-Blaine (KANE) is ~5 NM from the TFR edge.
    const kane = { lat: 45.145, lon: -93.2114 };
    const near = tfrsNear(tfrs, kane, 30);
    expect(near.map((t) => t.notamId)).toEqual(['6/6656']);
    expect(near[0]!.distanceNm).toBeGreaterThan(2);
    expect(near[0]!.distanceNm).toBeLessThan(10);
    // Denver has none of these nearby.
    expect(tfrsNear(tfrs, { lat: 39.8466, lon: -104.6562 }, 30)).toEqual([]);
  });

  it('rejects a non-GeoJSON response', () => {
    expect(() => parseTfrResponse('<html>Service unavailable</html>')).toThrow();
    expect(() => parseTfrResponse([{ notam_id: '6/8722' }])).toThrow();
  });

  it('skips malformed features instead of failing', () => {
    const parsed = parseTfrResponse({
      type: 'FeatureCollection',
      features: [{ type: 'Feature', geometry: { type: 'Circle' }, properties: {} }, { nonsense: true }],
    });
    expect(parsed).toEqual([]);
  });
});
