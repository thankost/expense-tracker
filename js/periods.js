// Date helpers work on 'YYYY-MM-DD' strings (UTC math) to avoid timezone/DST drift.

export const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export const MONTHS_SHORT = MONTHS.map(m => m.slice(0, 3));
export const WEEKDAYS_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export const pad = n => String(n).padStart(2, '0');
export const toISO = d => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
export const parseISO = s => {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
};
export const isISODate = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && toISO(parseISO(s)) === s;

export const todayISO = (now = new Date()) =>
  `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;

export const addDays = (s, n) => {
  const d = parseISO(s);
  d.setUTCDate(d.getUTCDate() + n);
  return toISO(d);
};

export const daysInMonth = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate(); // m is 1-based

const monthStart = s => s.slice(0, 8) + '01';
const monthEnd = s => {
  const [y, m] = s.split('-').map(Number);
  return `${y}-${pad(m)}-${pad(daysInMonth(y, m))}`;
};
const nextMonthStart = s => addDays(monthEnd(s), 1);

export const fmtDay = s => {
  const d = parseISO(s);
  return `${d.getUTCDate()} ${MONTHS_SHORT[d.getUTCMonth()]}`;
};
export const fmtDayLong = s => {
  const d = parseISO(s);
  return `${WEEKDAYS_SHORT[d.getUTCDay()]}, ${d.getUTCDate()} ${MONTHS_SHORT[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
};

function makePeriod(start, end, manual) {
  // Manual periods are named after the month they mostly cover (payday on 25 Mar => "April").
  const ref = parseISO(manual ? addDays(start, 14) : start);
  const title = `${MONTHS[ref.getUTCMonth()]} ${ref.getUTCFullYear()}`;
  const range = `${fmtDay(start)} – ${end ? fmtDay(end) : 'ongoing'}`;
  return { start, end, manual, title, short: MONTHS_SHORT[ref.getUTCMonth()], range };
}

/**
 * Builds a contiguous, chronological list of periods.
 * - Each manual start date begins a period that ends the day before the next start; the last one is open.
 * - Dates before the first manual start (or all dates, when none are defined) fall into calendar months.
 */
export function buildPeriods(starts, { earliest, latest, today }) {
  const sorted = [...new Set(starts.filter(isISODate))].sort();
  const first = sorted[0];
  const periods = [];

  const calFrom = [earliest, today].filter(Boolean).sort()[0];
  const calTo = first ? addDays(first, -1) : monthEnd([latest, today].filter(Boolean).sort().at(-1));

  if (calFrom && calFrom <= calTo) {
    for (let m = monthStart(calFrom); m <= calTo; m = nextMonthStart(m)) {
      const end = monthEnd(m) < calTo ? monthEnd(m) : calTo;
      periods.push(makePeriod(m, end, false));
    }
  }
  sorted.forEach((start, i) => {
    const end = i < sorted.length - 1 ? addDays(sorted[i + 1], -1) : null;
    periods.push(makePeriod(start, end, true));
  });
  return periods;
}

export const inPeriod = (p, date) => date >= p.start && (p.end === null || date <= p.end);

export function findPeriodIndex(periods, date) {
  for (let i = periods.length - 1; i >= 0; i--) if (periods[i].start <= date) return inPeriod(periods[i], date) ? i : -1;
  return -1;
}

/** Next date for a recurring template; monthly keeps the original day, clamped to short months. */
export function nextOccurrence(r) {
  if (r.frequency === 'weekly') return addDays(r.nextDate, 7);
  const d = parseISO(r.nextDate);
  let y = d.getUTCFullYear();
  let m = d.getUTCMonth() + 2;
  if (m > 12) { m = 1; y++; }
  const day = Math.min(r.day || d.getUTCDate(), daysInMonth(y, m));
  return `${y}-${pad(m)}-${pad(day)}`;
}
