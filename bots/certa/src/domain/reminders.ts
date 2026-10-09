/** Days before the recurrent due date at which pilots are DM'd. */
export const REMINDER_THRESHOLDS = [60, 30, 14, 3] as const;

export interface ReminderDecision {
  /** Threshold the reminder message should reference. */
  threshold: number;
  /**
   * Thresholds to record as sent. Includes larger thresholds that were missed
   * (bot offline, user linked late) so they are never sent out of order later.
   */
  markSent: number[];
}

/**
 * Decides whether to send a reminder today. Only the most urgent threshold
 * that has been reached is sent, and only if it has not been sent already for
 * this due date. Nothing is sent once training has lapsed.
 */
export function selectReminder(
  daysRemaining: number,
  alreadySent: readonly number[],
  thresholds: readonly number[] = REMINDER_THRESHOLDS,
): ReminderDecision | null {
  if (daysRemaining < 0) return null;
  const reached = thresholds.filter((threshold) => daysRemaining <= threshold);
  if (reached.length === 0) return null;
  const threshold = Math.min(...reached);
  if (alreadySent.includes(threshold)) return null;
  return { threshold, markSent: reached.filter((t) => !alreadySent.includes(t)) };
}
