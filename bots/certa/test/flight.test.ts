import { DateTime } from 'luxon';
import { describe, expect, it } from 'vitest';
import { formatDuration, publicLocation, validateFlightForm } from '../src/domain/flight.js';

const today = DateTime.fromISO('2026-10-09T15:00', { zone: 'America/Denver' });
const form = {
  date: '2026-10-08',
  location: 'KBJC',
  aircraft: 'DJI Mavic 3E',
  duration: '25',
  notes: '',
  missionType: 'Inspection' as const,
};

describe('validateFlightForm', () => {
  it('accepts a valid ICAO flight', () => {
    expect(validateFlightForm(form, today)).toEqual({
      ok: true,
      flight: {
        date: '2026-10-08',
        location: 'KBJC',
        locationIsIcao: true,
        aircraft: 'DJI Mavic 3E',
        durationMinutes: 25,
        missionType: 'Inspection',
        notes: undefined,
      },
    });
  });

  it('treats lowercase 4-letter places as text, not ICAO', () => {
    const result = validateFlightForm({ ...form, location: 'Reno' }, today);
    expect(result.ok && result.flight.locationIsIcao).toBe(false);
  });

  it('accepts today/yesterday shortcuts', () => {
    const result = validateFlightForm({ ...form, date: 'yesterday' }, today);
    expect(result.ok && result.flight.date).toBe('2026-10-08');
  });

  it('collects every validation error', () => {
    const result = validateFlightForm({ ...form, date: '2026-10-10', duration: '1.5', aircraft: ' ', location: '' }, today);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors).toHaveLength(4);
  });

  it('bounds duration', () => {
    expect(validateFlightForm({ ...form, duration: '0' }, today).ok).toBe(false);
    expect(validateFlightForm({ ...form, duration: '1441' }, today).ok).toBe(false);
    expect(validateFlightForm({ ...form, duration: '1440' }, today).ok).toBe(true);
  });

  it('rejects malformed dates', () => {
    expect(validateFlightForm({ ...form, date: '10/08/2026' }, today).ok).toBe(false);
    expect(validateFlightForm({ ...form, date: '2026-02-30' }, today).ok).toBe(false);
  });
});

describe('publicLocation', () => {
  it('keeps ICAO codes', () => {
    expect(publicLocation('KBJC', true)).toBe('KBJC');
  });

  it('removes coordinates', () => {
    expect(publicLocation('39.9083, -105.1172', false)).toBe('Location withheld');
    expect(publicLocation('Boulder, CO (40.01499, -105.27055)', false)).toBe('Boulder, CO');
    expect(publicLocation(`39°54'30"N 105°07'02"W`, false)).toBe('Location withheld');
  });

  it('cuts street addresses down to city and state', () => {
    expect(publicLocation('1234 Main St, Boulder, CO', false)).toBe('Boulder, CO');
    expect(publicLocation('North pasture, Smith Ranch, Longmont, CO', false)).toBe('Longmont, CO');
  });

  it('keeps plain city names', () => {
    expect(publicLocation('Golden, CO', false)).toBe('Golden, CO');
  });
});

describe('formatDuration', () => {
  it('formats minutes', () => {
    expect(formatDuration(25)).toBe('25m');
    expect(formatDuration(60)).toBe('1h');
    expect(formatDuration(95)).toBe('1h 35m');
  });
});
