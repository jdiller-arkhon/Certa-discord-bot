import { describe, expect, it } from 'vitest';
import type { PreflightThresholds } from '../src/config.js';
import { assessConditions } from '../src/preflight/assess.js';
import type { KpReading } from '../src/preflight/kp.js';
import type { MetarObservation } from '../src/preflight/metar.js';

const NOW = new Date('2026-10-09T22:00:00Z');

const thresholds: PreflightThresholds = {
  maxWindKt: 15,
  maxGustKt: 20,
  minVisibilitySm: 3,
  minCeilingFt: 1000,
  kpCaution: 5,
};

function metar(overrides: Partial<MetarObservation> = {}): MetarObservation {
  return {
    icao: 'KDEN',
    name: 'Denver Intl',
    observedAt: new Date('2026-10-09T21:53:00Z'),
    raw: 'METAR KDEN 092153Z 19010KT 10SM FEW110 29/M07 A2989',
    lat: 39.8,
    lon: -104.6,
    windDirection: 190,
    windSpeedKt: 10,
    gustKt: null,
    visibilitySm: 10,
    ceilingFt: null,
    temperatureC: 29,
    dewpointC: -7,
    altimeterInHg: 29.89,
    weather: null,
    flightCategory: 'VFR',
    ...overrides,
  };
}

const kp = (value: number): KpReading => ({ kp: value, observedAt: new Date('2026-10-09T18:00:00Z') });

describe('assessConditions', () => {
  it('is GO when everything is within limits', () => {
    expect(assessConditions(metar(), kp(2), thresholds, NOW)).toEqual({ level: 'GO', reasons: [] });
  });

  it('treats values exactly at the limit as GO', () => {
    const result = assessConditions(metar({ windSpeedKt: 15, gustKt: 20, visibilitySm: 3, ceilingFt: 1000 }), kp(4.67), thresholds, NOW);
    expect(result.level).toBe('GO');
  });

  it.each([
    ['wind', metar({ windSpeedKt: 17 }), /Wind 17 kt exceeds 15 kt/],
    ['gusts', metar({ windSpeedKt: 12, gustKt: 24 }), /Gusts 24 kt exceed 20 kt/],
    ['visibility', metar({ visibilitySm: 2.5 }), /Visibility 2.5 SM below 3 SM/],
    ['ceiling', metar({ ceilingFt: 800 }), /Ceiling 800 ft below 1000 ft/],
  ])('is CAUTION for %s', (_name, observation, reason) => {
    const result = assessConditions(observation, kp(1), thresholds, NOW);
    expect(result.level).toBe('CAUTION');
    expect(result.reasons).toHaveLength(1);
    expect(result.reasons[0]).toMatch(reason);
  });

  it('flags Kp at 5 or higher for GPS degradation', () => {
    expect(assessConditions(metar(), kp(4.99), thresholds, NOW).level).toBe('GO');
    const result = assessConditions(metar(), kp(5), thresholds, NOW);
    expect(result).toEqual({ level: 'CAUTION', reasons: ['Kp 5 is elevated (GPS degradation possible)'] });
  });

  it('lists every reason when several limits are exceeded', () => {
    const result = assessConditions(metar({ windSpeedKt: 22, gustKt: 31, ceilingFt: 500 }), kp(6.33), thresholds, NOW);
    expect(result.level).toBe('CAUTION');
    expect(result.reasons).toHaveLength(4);
  });

  it('is CAUTION when data is missing or stale', () => {
    expect(assessConditions(null, kp(1), thresholds, NOW).reasons).toEqual(['No current METAR available']);
    expect(assessConditions(metar(), null, thresholds, NOW).reasons).toEqual(['Kp index unavailable']);
    expect(assessConditions(metar({ visibilitySm: null }), kp(1), thresholds, NOW).reasons).toEqual(['Visibility not reported']);
    const stale = assessConditions(metar({ observedAt: new Date('2026-10-09T18:00:00Z') }), kp(1), thresholds, NOW);
    expect(stale.reasons).toEqual(['METAR is 4h old']);
  });

  it('respects configured thresholds', () => {
    const strict = { ...thresholds, maxWindKt: 8 };
    expect(assessConditions(metar({ windSpeedKt: 10 }), kp(1), strict, NOW).level).toBe('CAUTION');
  });
});
