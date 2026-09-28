import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPeriods, findPeriodIndex, inPeriod, nextOccurrence, addDays, isISODate } from '../js/periods.js';
import { toCSV } from '../js/export.js';

test('calendar months when no pay periods are defined', () => {
  const p = buildPeriods([], { earliest: '2026-01-15', latest: '2026-03-02', today: '2026-03-10' });
  assert.deepEqual(p.map(x => [x.start, x.end]), [
    ['2026-01-01', '2026-01-31'], ['2026-02-01', '2026-02-28'], ['2026-03-01', '2026-03-31'],
  ]);
  assert.equal(p[1].title, 'February 2026');
});

test('manual periods end the day before the next start; last is open', () => {
  const p = buildPeriods(['2026-04-24', '2026-03-25', '2026-05-22'], { today: '2026-05-30' });
  assert.deepEqual(p.map(x => [x.start, x.end]), [
    ['2026-03-25', '2026-04-23'], ['2026-04-24', '2026-05-21'], ['2026-05-22', null],
  ]);
  assert.equal(p[0].title, 'April 2026'); // paid 25 Mar => April's money
  assert.equal(p[2].range, '22 May – ongoing');
  assert.ok(inPeriod(p[2], '2027-01-01'));
});

test('calendar months fill the time before the first pay period', () => {
  const p = buildPeriods(['2026-03-25'], { earliest: '2026-02-10', latest: '2026-04-01', today: '2026-04-02' });
  assert.deepEqual(p.map(x => [x.start, x.end, x.manual]), [
    ['2026-02-01', '2026-02-28', false], ['2026-03-01', '2026-03-24', false], ['2026-03-25', null, true],
  ]);
  assert.equal(findPeriodIndex(p, '2026-03-24'), 1);
  assert.equal(findPeriodIndex(p, '2026-03-25'), 2);
  assert.equal(findPeriodIndex(p, '2026-01-01'), -1);
});

test('periods are contiguous with no gaps or overlaps', () => {
  const p = buildPeriods(['2026-06-28', '2026-07-30', '2026-08-27'], { earliest: '2026-05-03', today: '2026-09-01' });
  for (let i = 1; i < p.length; i++) assert.equal(addDays(p[i - 1].end, 1), p[i].start);
});

test('monthly recurrence keeps day and clamps to short months', () => {
  let r = { frequency: 'monthly', day: 31, nextDate: '2026-01-31' };
  r.nextDate = nextOccurrence(r); assert.equal(r.nextDate, '2026-02-28');
  r.nextDate = nextOccurrence(r); assert.equal(r.nextDate, '2026-03-31');
  assert.equal(nextOccurrence({ frequency: 'monthly', day: 15, nextDate: '2026-12-15' }), '2027-01-15');
  assert.equal(nextOccurrence({ frequency: 'weekly', nextDate: '2026-12-29' }), '2027-01-05');
});

test('date validation', () => {
  assert.ok(isISODate('2028-02-29'));
  assert.ok(!isISODate('2026-02-30'));
  assert.ok(!isISODate(''));
});

test('CSV escaping and formula protection', () => {
  const csv = toCSV([['Date', 'Note', 'Amount'], ['2026-01-01', 'Lunch, "cafe"', 12.5], ['2026-01-02', '=HYPERLINK()', 3]]);
  const lines = csv.replace('\ufeff', '').split('\r\n');
  assert.equal(lines[1], '2026-01-01,"Lunch, ""cafe""",12.5');
  assert.equal(lines[2], "2026-01-02,'=HYPERLINK(),3");
});
