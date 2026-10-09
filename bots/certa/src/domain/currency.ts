import { DateTime } from 'luxon';
import type { CurrencyStatus } from '../certa/types.js';

/** Part 107 recurrent training is due every 24 calendar months (14 CFR 107.65). */
export const RECURRENT_INTERVAL_MONTHS = 24;

/** "Due soon" window used for the /currency status color. */
export const DUE_SOON_DAYS = 60;

export type CurrencyState = 'current' | 'due-soon' | 'lapsed' | 'unknown';

export interface CurrencySummary {
  state: CurrencyState;
  lastTrainingDate: string | null;
  lastTrainingKind: CurrencyStatus['lastTrainingKind'];
  /** Last day the pilot is current (inclusive), `YYYY-MM-DD`. */
  dueDate: string | null;
  /** Days from today until the due date; 0 on the due date, negative once lapsed. */
  daysRemaining: number | null;
}

/**
 * Calendar-month rule: training completed any day in a month keeps the pilot
 * current through the last day of the 24th following month. For example,
 * training on 2024-01-15 is current through 2026-01-31.
 */
export function recurrentDueDate(lastTrainingDate: string): string {
  const completed = DateTime.fromISO(lastTrainingDate, { zone: 'utc' });
  if (!completed.isValid) throw new Error(`Invalid training date "${lastTrainingDate}"`);
  return completed.plus({ months: RECURRENT_INTERVAL_MONTHS }).endOf('month').toISODate()!;
}

/** Whole calendar days from `today` to `dueDate` (both `YYYY-MM-DD`). */
export function daysUntil(dueDate: string, today: string): number {
  const due = DateTime.fromISO(dueDate, { zone: 'utc' });
  const now = DateTime.fromISO(today, { zone: 'utc' });
  return Math.round(due.diff(now, 'days').days);
}

/** `today` must be the pilot-facing local date (`YYYY-MM-DD`). */
export function summarizeCurrency(status: CurrencyStatus, today: string): CurrencySummary {
  if (!status.lastTrainingDate) {
    return {
      state: 'unknown',
      lastTrainingDate: null,
      lastTrainingKind: status.lastTrainingKind,
      dueDate: null,
      daysRemaining: null,
    };
  }
  const dueDate = recurrentDueDate(status.lastTrainingDate);
  const daysRemaining = daysUntil(dueDate, today);
  const state: CurrencyState = daysRemaining < 0 ? 'lapsed' : daysRemaining <= DUE_SOON_DAYS ? 'due-soon' : 'current';
  return {
    state,
    lastTrainingDate: status.lastTrainingDate,
    lastTrainingKind: status.lastTrainingKind,
    dueDate,
    daysRemaining,
  };
}
