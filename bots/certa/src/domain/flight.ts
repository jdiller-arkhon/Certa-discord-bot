import { DateTime } from 'luxon';
import { type FlightInput, flightInputSchema, type MissionType } from '../certa/types.js';

export interface RawFlightForm {
  date: string;
  location: string;
  aircraft: string;
  duration: string;
  notes: string;
  missionType: MissionType;
}

export type FlightValidation = { ok: true; flight: FlightInput } | { ok: false; errors: string[] };

const ICAO_PATTERN = /^[A-Z][A-Z0-9]{3}$/;

/** Accepts `YYYY-MM-DD`, `today`, or `yesterday`. */
function parseDate(input: string, today: DateTime): DateTime | null {
  const value = input.trim().toLowerCase();
  if (value === '' || value === 'today') return today;
  if (value === 'yesterday') return today.minus({ days: 1 });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = DateTime.fromISO(value, { zone: today.zone });
  return parsed.isValid ? parsed : null;
}

/**
 * Validates the /log modal. `today` is the bot's local date; flights cannot be
 * in the future or more than 10 years old.
 */
export function validateFlightForm(form: RawFlightForm, today: DateTime): FlightValidation {
  const errors: string[] = [];
  const todayStart = today.startOf('day');

  const date = parseDate(form.date, todayStart);
  if (!date) errors.push('Date must be YYYY-MM-DD (or "today" / "yesterday").');
  else if (date.startOf('day') > todayStart) errors.push('Date cannot be in the future.');
  else if (date < todayStart.minus({ years: 10 })) errors.push('Date is more than 10 years ago.');

  const location = form.location.trim().replace(/\s+/g, ' ');
  // Only uppercase input counts as ICAO so 4-letter places ("Reno") stay text.
  const locationIsIcao = ICAO_PATTERN.test(location);
  if (location.length === 0) errors.push('Location is required.');
  else if (location.length > 100) errors.push('Location must be 100 characters or fewer.');

  const aircraft = form.aircraft.trim();
  if (aircraft.length === 0) errors.push('Aircraft is required.');
  else if (aircraft.length > 80) errors.push('Aircraft must be 80 characters or fewer.');

  const durationText = form.duration.trim();
  const duration = Number(durationText);
  if (!/^\d+$/.test(durationText) || !Number.isInteger(duration)) {
    errors.push('Flight duration must be a whole number of minutes.');
  } else if (duration < 1 || duration > 1440) {
    errors.push('Flight duration must be between 1 and 1440 minutes.');
  }

  const notes = form.notes.trim();
  if (notes.length > 1000) errors.push('Notes must be 1000 characters or fewer.');

  if (errors.length > 0) return { ok: false, errors };

  const flight = flightInputSchema.parse({
    date: date!.toISODate(),
    location,
    locationIsIcao,
    aircraft,
    durationMinutes: duration,
    missionType: form.missionType,
    notes: notes.length > 0 ? notes : undefined,
  });
  return { ok: true, flight };
}

// Decimal lat/lon pairs ("39.7392, -104.9903"), DMS ("39°44'21\"N"), and
// plus codes ("85GCQ2XF+") are treated as precise coordinates.
const COORDINATE_PATTERNS = [
  /[-+]?\d{1,3}\.\d{2,}\s*°?\s*[NSEW]?\s*[,/\s]\s*[-+]?\d{1,3}\.\d{2,}\s*°?\s*[NSEW]?/gi,
  /\d{1,3}\s*°\s*\d{1,2}\s*['′]\s*(\d{1,2}(\.\d+)?\s*["″])?\s*[NSEW]?/gi,
  /\b[23456789CFGHJMPQRVWX]{4,8}\+[23456789CFGHJMPQRVWX]{0,3}\b/gi,
  /[-+]?\d{1,3}\.\d{3,}/g,
];

/**
 * Coarsens a location for public posts: ICAO codes are kept, coordinates are
 * removed, and street addresses are cut down to their last two parts
 * (typically "City, ST").
 */
export function publicLocation(location: string, locationIsIcao: boolean): string {
  if (locationIsIcao) return location.toUpperCase();

  let text = location;
  for (const pattern of COORDINATE_PATTERNS) text = text.replace(pattern, ' ');
  text = text.replace(/[([]\s*[)\]]/g, ' ');
  const parts = text
    .split(',')
    .map((part) => part.replace(/\s+/g, ' ').trim())
    // A leading house number marks a street address line.
    .filter((part) => part.length > 0 && !/^\d+\s+\S/.test(part) && !/^[\d\s.\-]+$/.test(part));

  if (parts.length === 0) return 'Location withheld';
  return parts.slice(-2).join(', ');
}

export function formatDuration(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  if (hours === 0) return `${mins}m`;
  return mins === 0 ? `${hours}h` : `${hours}h ${mins}m`;
}

/** Decimal hours with one decimal place, e.g. `12.5 h`. */
export function formatHours(minutes: number): string {
  return `${(minutes / 60).toFixed(1)} h`;
}
