/**
 * Minimal 5-field cron matcher: minute hour day-of-month month day-of-week.
 *
 * Supports `*`, `a,b`, `a-b`, and `* /n` step syntax. Deliberately small -- the platform
 * provides the execution primitive and the consuming service owns domain scheduling
 * (§18.2), so campaign windows and retry cadence do not belong here. If an expression
 * needs more than this, it is business scheduling wearing a cron costume.
 */
export function matchesCron(expression: string, at: Date): boolean {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error(`Cron needs 5 fields, got ${fields.length}`);

  const dow = at.getUTCDay();
  const values = [
    at.getUTCMinutes(),
    at.getUTCHours(),
    at.getUTCDate(),
    at.getUTCMonth() + 1,
    dow,
  ];
  const bounds: [number, number][] = [
    [0, 59], [0, 23], [1, 31], [1, 12], [0, 6],
  ];

  return fields.every((field, i) => matchField(field, values[i]!, bounds[i]!));
}

function matchField(field: string, value: number, [lo, hi]: [number, number]): boolean {
  return field.split(',').some((part) => {
    const [range, rawStep] = part.split('/');
    const step = rawStep ? Number(rawStep) : 1;
    if (!Number.isInteger(step) || step < 1) throw new Error(`Bad cron step in "${part}"`);

    let start = lo;
    let end = hi;
    if (range && range !== '*') {
      const [a, b] = range.split('-');
      start = Number(a);
      end = b === undefined ? Number(a) : Number(b);
      if (!Number.isInteger(start) || !Number.isInteger(end)) {
        throw new Error(`Bad cron range in "${part}"`);
      }
      // Sunday is both 0 and 7 in common usage; normalise so "7" does not silently never match.
      if (hi === 6 && start === 7) start = 0;
      if (hi === 6 && end === 7) end = 0;
    }
    if (value < start || value > end) return false;
    return (value - start) % step === 0;
  });
}
