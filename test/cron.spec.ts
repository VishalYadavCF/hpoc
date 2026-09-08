import { describe, expect, it } from 'vitest';
import { matchesCron } from '../src/domain/trigger/cron.js';

const at = (iso: string) => new Date(iso);

describe('cron matcher (§18.2)', () => {
  it('matches every minute', () => {
    expect(matchesCron('* * * * *', at('2026-09-06T15:04:00Z'))).toBe(true);
  });

  it('matches a specific minute and hour', () => {
    expect(matchesCron('30 9 * * *', at('2026-09-06T09:30:00Z'))).toBe(true);
    expect(matchesCron('30 9 * * *', at('2026-09-06T09:31:00Z'))).toBe(false);
    expect(matchesCron('30 9 * * *', at('2026-09-06T10:30:00Z'))).toBe(false);
  });

  it('handles step syntax', () => {
    expect(matchesCron('*/15 * * * *', at('2026-09-06T10:00:00Z'))).toBe(true);
    expect(matchesCron('*/15 * * * *', at('2026-09-06T10:15:00Z'))).toBe(true);
    expect(matchesCron('*/15 * * * *', at('2026-09-06T10:16:00Z'))).toBe(false);
  });

  it('handles ranges and lists', () => {
    expect(matchesCron('0 9-17 * * *', at('2026-09-06T12:00:00Z'))).toBe(true);
    expect(matchesCron('0 9-17 * * *', at('2026-09-06T18:00:00Z'))).toBe(false);
    expect(matchesCron('0 0 * * 1,3,5', at('2026-09-04T00:00:00Z'))).toBe(true); // Friday
    expect(matchesCron('0 0 * * 1,3,5', at('2026-09-05T00:00:00Z'))).toBe(false); // Saturday
  });

  it('treats 7 as Sunday', () => {
    // A common convention; without normalising it, "0 0 * * 7" would never fire and the
    // failure would be a schedule that silently does nothing.
    const sunday = at('2026-09-06T00:00:00Z');
    expect(sunday.getUTCDay()).toBe(0);
    expect(matchesCron('0 0 * * 7', sunday)).toBe(true);
    expect(matchesCron('0 0 * * 0', sunday)).toBe(true);
  });

  it('rejects a malformed expression rather than never firing', () => {
    expect(() => matchesCron('* * *', at('2026-09-06T00:00:00Z'))).toThrow();
    expect(() => matchesCron('* * * * abc', at('2026-09-06T00:00:00Z'))).toThrow();
  });
});
