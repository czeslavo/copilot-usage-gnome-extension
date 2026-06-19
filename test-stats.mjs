// test-stats.mjs — run with: node test-stats.mjs
import {localDateStr, loadHistory, recordSample, computeStats} from './stats.js';

let pass = 0, fail = 0;

function assert(cond, msg) {
    if (cond) { console.log(`  ✓ ${msg}`); pass++; }
    else       { console.error(`  ✗ FAIL: ${msg}`); fail++; }
}
function approx(a, b, eps = 0.5) { return Math.abs(a - b) < eps; }

const RESET = '2026-07-01T00:00:00.000Z';

// ── localDateStr ─────────────────────────────────────────────────────────────
console.log('\nlocalDateStr');
assert(localDateStr(new Date('2026-06-19T12:00:00')) === '2026-06-19', 'basic date');
assert(localDateStr(new Date('2026-01-01T00:00:00')) === '2026-01-01', 'jan 1');

// ── loadHistory ──────────────────────────────────────────────────────────────
console.log('\nloadHistory');
assert(loadHistory('').v === 1,                       'empty string → v1');
assert(loadHistory('not-json').v === 1,               'corrupt → empty history');
assert(loadHistory('{"v":1,"periods":{}}').v === 1,   'valid parses ok');
assert(Object.keys(loadHistory('').periods).length === 0, 'empty has no periods');

// ── recordSample ─────────────────────────────────────────────────────────────
console.log('\nrecordSample');
let h = loadHistory('');

recordSample(h, {used: 50, total: 300, resetDateUtc: RESET, now: new Date('2026-06-01T10:00:00Z')});
assert(h.periods[RESET] !== undefined,                    'creates period');
assert(h.periods[RESET].days['2026-06-01'] !== undefined, 'creates day');
const d1 = h.periods[RESET].days['2026-06-01'];
assert(d1.first === 50 && d1.last === 50 && d1.n === 1,  'first sample sets first/last/n');

// Second sample same day — higher value
recordSample(h, {used: 80, total: 300, resetDateUtc: RESET, now: new Date('2026-06-01T18:00:00Z')});
const d1b = h.periods[RESET].days['2026-06-01'];
assert(d1b.first === 50, 'first unchanged after update');
assert(d1b.last  === 80, 'last updated to higher value');
assert(d1b.n     === 2,  'n incremented');

// Stale sample (lower value) must not overwrite last
recordSample(h, {used: 70, total: 300, resetDateUtc: RESET, now: new Date('2026-06-01T18:30:00Z')});
assert(h.periods[RESET].days['2026-06-01'].last === 80, 'stale sample rejected');

// New day
recordSample(h, {used: 110, total: 300, resetDateUtc: RESET, now: new Date('2026-06-02T10:00:00Z')});
assert(h.periods[RESET].days['2026-06-02'] !== undefined, 'new day created');

// ── computeStats ─────────────────────────────────────────────────────────────
console.log('\ncomputeStats');

h = loadHistory('');
// Day 1: used 30→50 (first tracking starts mid-way)
recordSample(h, {used: 30, total: 300, resetDateUtc: RESET, now: new Date('2026-06-01T09:00:00Z')});
recordSample(h, {used: 50, total: 300, resetDateUtc: RESET, now: new Date('2026-06-01T17:00:00Z')});
// Day 2
recordSample(h, {used: 80, total: 300, resetDateUtc: RESET, now: new Date('2026-06-02T10:00:00Z')});
// Day 3 (current)
recordSample(h, {used: 110, total: 300, resetDateUtc: RESET, now: new Date('2026-06-03T10:00:00Z')});

const now3 = new Date('2026-06-03T12:00:00Z');
const s = computeStats(h, {used: 115, total: 300, resetDateUtc: RESET, now: now3});

assert(s !== null,          'returns stats object');
assert(s.currentUsed === 115, 'currentUsed = live.used');
assert(s.total === 300,     'total = 300');
assert(s.perDay.length === 3, '3 perDay entries');

// Day 0 (2026-06-01): partial, consumption = last − first = 50 − 30 = 20
assert(s.perDay[0].partial === true,     'day 0 is partial');
assert(s.perDay[0].consumption === 20,   'day 0 consumption = 20');

// Day 1 (2026-06-02): consumption = 80 − 50 = 30
assert(s.perDay[1].consumption === 30,   'day 1 consumption = 30');
assert(s.perDay[1].gapDays === 0,        'no gap day 1→2');

// Day 2 (2026-06-03): consumption = 110 − 80 = 30
assert(s.perDay[2].consumption === 30,   'day 2 consumption = 30');

// Today entry
assert(s.todayConsumption === 30,        'todayConsumption = 30');

// periodStart = 2026-06-01 (July 1 − 1 month)
// daysElapsed from June 1 00:00 UTC to June 3 12:00 UTC ≈ 2.5
// avgPerDay = 115 / 2.5 = 46
assert(approx(s.avgPerDay, 46, 2),       `avgPerDay ≈ 46 (got ${s.avgPerDay.toFixed(1)})`);

// budgetPerDay = 300 / 30 = 10
assert(approx(s.budgetPerDay, 10, 0.5), `budgetPerDay ≈ 10 (got ${s.budgetPerDay.toFixed(1)})`);

// At 46/day for ~27.5 remaining days, projection >> 300 → not on track
assert(!s.onTrack,                       'not on track (high usage)');
assert(s.exhaustionDate !== null,        'exhaustionDate set');
assert(s.exhaustionDate < s.resetDate,   'exhausts before reset');

// ── On-track case ─────────────────────────────────────────────────────────
console.log('\nOn-track case');
h = loadHistory('');
recordSample(h, {used:  5, total: 300, resetDateUtc: RESET, now: new Date('2026-06-01T09:00:00Z')});
recordSample(h, {used: 10, total: 300, resetDateUtc: RESET, now: new Date('2026-06-02T09:00:00Z')});
recordSample(h, {used: 15, total: 300, resetDateUtc: RESET, now: new Date('2026-06-03T09:00:00Z')});
const sLow = computeStats(h, {used: 15, total: 300, resetDateUtc: RESET, now: now3});
// avgPerDay ≈ 15/2.5 = 6; projected ≈ 15 + 6*27.5 = 180 ≤ 300
assert(sLow.onTrack,              'on track with low usage');
assert(sLow.exhaustionDate === null, 'no exhaustionDate when on track');

// ── Gap days ──────────────────────────────────────────────────────────────
console.log('\nGap days');
h = loadHistory('');
recordSample(h, {used: 20, total: 300, resetDateUtc: RESET, now: new Date('2026-06-01T10:00:00Z')});
recordSample(h, {used: 50, total: 300, resetDateUtc: RESET, now: new Date('2026-06-01T18:00:00Z')});
// Skip days 2 and 3 (machine off)
recordSample(h, {used: 80, total: 300, resetDateUtc: RESET, now: new Date('2026-06-04T10:00:00Z')});
const sGap = computeStats(h, {used: 80, total: 300, resetDateUtc: RESET,
    now: new Date('2026-06-04T12:00:00Z')});
assert(sGap.perDay.length === 2,           '2 tracked days despite gap');
assert(sGap.perDay[1].gapDays === 2,       'gap of 2 days flagged');
assert(sGap.perDay[1].consumption === 30,  'gap-day consumption = 80−50 = 30');

// ── null when no data ────────────────────────────────────────────────────
console.log('\nEmpty history');
assert(computeStats(loadHistory('')) === null, 'null with empty history');

// ── Pruning ───────────────────────────────────────────────────────────────
console.log('\nPruning');
h = loadHistory('');
const futureReset = '2026-10-01T00:00:00.000Z';
const veryOld = new Date('2026-03-01T10:00:00Z'); // > 90 days before July 1
const recent  = new Date('2026-07-01T10:00:00Z');
recordSample(h, {used: 10, total: 300, resetDateUtc: futureReset, now: veryOld});
recordSample(h, {used: 20, total: 300, resetDateUtc: futureReset, now: recent});
assert(h.periods[futureReset].days['2026-03-01'] === undefined, 'old day pruned');
assert(h.periods[futureReset].days['2026-07-01'] !== undefined, 'recent day kept');

// ── Period transition ────────────────────────────────────────────────────
console.log('\nPeriod transition');
h = loadHistory('');
const RESET_A = '2026-06-01T00:00:00.000Z';
const RESET_B = '2026-07-01T00:00:00.000Z';
recordSample(h, {used: 200, total: 300, resetDateUtc: RESET_A, now: new Date('2026-05-28T10:00:00Z')});
recordSample(h, {used:  10, total: 300, resetDateUtc: RESET_B, now: new Date('2026-06-02T10:00:00Z')});
assert(Object.keys(h.periods).length === 2, 'two periods stored');
const sNew = computeStats(h, {used: 10, total: 300, resetDateUtc: RESET_B,
    now: new Date('2026-06-02T12:00:00Z')});
assert(sNew.periodId === RESET_B, 'live period takes precedence');

// ── Summary ───────────────────────────────────────────────────────────────
console.log(`\n${pass + fail} tests: ${pass} passed, ${fail} failed\n`);
if (fail > 0) process.exit(1);
