import { describe, expect, it } from 'vitest';
import { daysUntil, recurrentDueDate, summarizeCurrency } from '../src/domain/currency.js';

describe('recurrentDueDate (24 calendar months)', () => {
  it('runs to the end of the 24th month after completion', () => {
    expect(recurrentDueDate('2024-01-15')).toBe('2026-01-31');
    expect(recurrentDueDate('2024-01-01')).toBe('2026-01-31');
    expect(recurrentDueDate('2024-01-31')).toBe('2026-01-31');
  });

  it('handles short months and leap years', () => {
    expect(recurrentDueDate('2024-02-29')).toBe('2026-02-28');
    expect(recurrentDueDate('2026-02-10')).toBe('2028-02-29');
    expect(recurrentDueDate('2024-04-30')).toBe('2026-04-30');
    expect(recurrentDueDate('2024-12-31')).toBe('2026-12-31');
  });

  it('rejects invalid dates', () => {
    expect(() => recurrentDueDate('2024-13-01')).toThrow(/Invalid training date/);
  });
});

describe('daysUntil', () => {
  it('counts whole calendar days', () => {
    expect(daysUntil('2026-01-31', '2026-01-31')).toBe(0);
    expect(daysUntil('2026-01-31', '2026-01-30')).toBe(1);
    expect(daysUntil('2026-01-31', '2026-02-01')).toBe(-1);
    expect(daysUntil('2026-12-31', '2026-01-01')).toBe(364);
  });

  it('is unaffected by DST transitions', () => {
    expect(daysUntil('2026-03-09', '2026-03-07')).toBe(2);
    expect(daysUntil('2026-11-02', '2026-10-31')).toBe(2);
  });
});

describe('summarizeCurrency', () => {
  it('is current with more than 60 days remaining', () => {
    const summary = summarizeCurrency({ lastTrainingDate: '2025-06-10', lastTrainingKind: 'recurrent' }, '2026-10-09');
    expect(summary).toMatchObject({ state: 'current', dueDate: '2027-06-30', daysRemaining: 264 });
  });

  it('is due soon within 60 days, including the due date itself', () => {
    expect(summarizeCurrency({ lastTrainingDate: '2024-11-20', lastTrainingKind: 'initial' }, '2026-10-09')).toMatchObject({
      state: 'due-soon',
      dueDate: '2026-11-30',
      daysRemaining: 52,
    });
    expect(summarizeCurrency({ lastTrainingDate: '2024-10-01', lastTrainingKind: 'recurrent' }, '2026-10-31')).toMatchObject({
      state: 'due-soon',
      daysRemaining: 0,
    });
  });

  it('is lapsed after the due date', () => {
    expect(summarizeCurrency({ lastTrainingDate: '2024-09-05', lastTrainingKind: 'recurrent' }, '2026-10-09')).toMatchObject({
      state: 'lapsed',
      dueDate: '2026-09-30',
      daysRemaining: -9,
    });
  });

  it('is unknown with no training on file', () => {
    expect(summarizeCurrency({ lastTrainingDate: null, lastTrainingKind: null }, '2026-10-09')).toMatchObject({
      state: 'unknown',
      dueDate: null,
      daysRemaining: null,
    });
  });
});
