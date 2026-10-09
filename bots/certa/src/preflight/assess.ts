import type { PreflightThresholds } from '../config.js';
import type { KpReading } from './kp.js';
import type { MetarObservation } from './metar.js';

export type PreflightLevel = 'GO' | 'CAUTION';

export interface PreflightAssessment {
  level: PreflightLevel;
  /** Why the level is CAUTION; empty for GO. */
  reasons: string[];
}

/** METARs older than this are treated as stale. */
export const STALE_METAR_MINUTES = 90;

/**
 * Advisory go/caution summary from surface wind, gusts, visibility, ceiling,
 * and Kp. Missing inputs are cautions, never silent GOs.
 */
export function assessConditions(
  metar: MetarObservation | null,
  kp: KpReading | null,
  thresholds: PreflightThresholds,
  now: Date = new Date(),
): PreflightAssessment {
  const reasons: string[] = [];

  if (!metar) {
    reasons.push('No current METAR available');
  } else {
    const ageMinutes = (now.getTime() - metar.observedAt.getTime()) / 60_000;
    if (ageMinutes > STALE_METAR_MINUTES) reasons.push(`METAR is ${Math.round(ageMinutes / 60)}h old`);

    if (metar.windSpeedKt === null) reasons.push('Wind speed not reported');
    else if (metar.windSpeedKt > thresholds.maxWindKt) {
      reasons.push(`Wind ${metar.windSpeedKt} kt exceeds ${thresholds.maxWindKt} kt`);
    }

    if (metar.gustKt !== null && metar.gustKt > thresholds.maxGustKt) {
      reasons.push(`Gusts ${metar.gustKt} kt exceed ${thresholds.maxGustKt} kt`);
    }

    if (metar.visibilitySm === null) reasons.push('Visibility not reported');
    else if (metar.visibilitySm < thresholds.minVisibilitySm) {
      reasons.push(`Visibility ${metar.visibilitySm} SM below ${thresholds.minVisibilitySm} SM`);
    }

    if (metar.ceilingFt !== null && metar.ceilingFt < thresholds.minCeilingFt) {
      reasons.push(`Ceiling ${metar.ceilingFt} ft below ${thresholds.minCeilingFt} ft`);
    }
  }

  if (!kp) reasons.push('Kp index unavailable');
  else if (kp.kp >= thresholds.kpCaution) {
    reasons.push(`Kp ${formatKp(kp.kp)} is elevated (GPS degradation possible)`);
  }

  return { level: reasons.length === 0 ? 'GO' : 'CAUTION', reasons };
}

export function formatKp(kp: number): string {
  return kp.toFixed(2).replace(/\.?0+$/, '');
}
