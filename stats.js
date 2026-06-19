/**
 * stats.js — pure JS, no gi:// imports.
 *
 * Shared by extension.js (gnome-shell process) and prefs.js (prefs process).
 * Contains all history storage helpers and derived-statistics maths.
 *
 * Data model
 * ----------
 * History is a JSON object stored as a GSettings string:
 *
 *   {
 *     "v": 1,
 *     "periods": {
 *       "<resetDateUtc ISO string>": {        // one entry per billing period
 *         "total": 300,                        // quota for this period
 *         "days": {
 *           "YYYY-MM-DD": {
 *             "first": <cumulative used at first sample of the day>,
 *             "last":  <cumulative used at last sample of the day>,
 *             "n":     <number of samples recorded>,
 *             "tsLast": <unix seconds of last sample>
 *           }
 *         }
 *       }
 *     }
 *   }
 *
 * Key design decisions
 * --------------------
 * - Period key = resetDateUtc from the API.  When the reset date changes, a new
 *   period bucket is created automatically; old ones are kept up to MAX_DAYS.
 * - Daily consumption = delta of cumulative `used` between consecutive days.
 *   The first tracked day of a period is flagged "partial" because we don't
 *   have the start-of-day baseline.
 * - Average per day uses CUMULATIVE maths (currentUsed / daysElapsed since
 *   period start), making it gap-robust when the machine is off for a day.
 * - Period start is inferred by subtracting one calendar month from resetDateUtc.
 */

export const HISTORY_VERSION = 1;
export const MAX_DAYS        = 90;

const MS_PER_DAY = 86_400_000;

// ─────────────────────────────────────────────────────────────────────────────
// Public helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Return a local YYYY-MM-DD string for `date` (default: now). */
export function localDateStr(date = new Date()) {
    const y  = date.getFullYear();
    const mo = String(date.getMonth() + 1).padStart(2, '0');
    const d  = String(date.getDate()).padStart(2, '0');
    return `${y}-${mo}-${d}`;
}

/**
 * Parse a history JSON string, tolerating corruption or missing data.
 * Always returns a structurally valid history object.
 */
export function loadHistory(str) {
    try {
        const h = JSON.parse(str || '{}');
        if (h?.v === HISTORY_VERSION && h?.periods && typeof h.periods === 'object')
            return h;
    } catch (_) {}
    return {v: HISTORY_VERSION, periods: {}};
}

/**
 * Record one usage sample into history and prune old entries.
 * Mutates `history` in place and returns it.
 *
 * @param {object} history              - parsed history object from loadHistory()
 * @param {number} sample.used          - cumulative credits used this period (API value)
 * @param {number} sample.total         - period quota total
 * @param {string} sample.resetDateUtc  - ISO string of next reset (used as period ID)
 * @param {Date}   [sample.now]         - sample timestamp (default: new Date())
 */
export function recordSample(history, {used, total, resetDateUtc, now = new Date()}) {
    const periodId = resetDateUtc;

    if (!history.periods[periodId])
        history.periods[periodId] = {total, days: {}};

    // Keep total current; it can change mid-period on plan changes.
    history.periods[periodId].total = total;

    const period = history.periods[periodId];
    const dayKey = localDateStr(now);

    if (!period.days[dayKey]) {
        period.days[dayKey] = {
            first:  used,
            last:   used,
            n:      1,
            tsLast: Math.floor(now.getTime() / 1000),
        };
    } else {
        const day = period.days[dayKey];
        // Guard against transient API glitches returning stale (lower) values.
        if (used >= day.last) {
            day.last   = used;
            day.tsLast = Math.floor(now.getTime() / 1000);
        }
        day.n += 1;
    }

    _prune(history, now);
    return history;
}

/**
 * Compute all derived statistics from stored history and an optional live reading.
 *
 * @param {object}      history  - from loadHistory()
 * @param {object|null} live     - {used, total, resetDateUtc, now?}
 *                                 Pass null to infer values from the newest stored sample
 *                                 (used by prefs.js which doesn't have a live reading).
 * @returns {object|null}  stats object, or null when there is not enough data yet.
 *
 * Returned stats object:
 *   currentUsed        {number}   cumulative credits used this period
 *   total              {number}   period quota
 *   todayConsumption   {number|null}  credits consumed today (null = no baseline yet)
 *   todayPartial       {boolean}  true when today's figure covers only part of the day
 *   avgPerDay          {number}   average credits/day since period start (gap-robust)
 *   budgetPerDay       {number}   total / periodLength
 *   projectedAtReset   {number}   credits expected to be used by reset at current rate
 *   onTrack            {boolean}  projectedAtReset <= total
 *   exhaustionDate     {Date|null} estimated date of exhaustion, or null when after reset
 *   daysLeft           {number}   calendar days until reset
 *   periodId           {string}   resetDateUtc used as period key
 *   periodStart        {Date}     inferred period start date
 *   resetDate          {Date}     next reset date
 *   perDay             {Array}    [{date, consumption, partial, gapDays, n}]
 */
export function computeStats(history, live = null) {
    const periodIds = Object.keys(history.periods).sort();
    if (periodIds.length === 0)
        return null;

    const now      = live?.now ?? new Date();
    const periodId = live?.resetDateUtc ?? periodIds[periodIds.length - 1];
    const period   = history.periods[periodId];
    if (!period)
        return null;

    const total       = live?.total ?? period.total ?? 300;
    const currentUsed = live?.used  ?? _lastUsed(period);

    const dayKeys = Object.keys(period.days).sort();
    if (dayKeys.length === 0)
        return null;

    // ── Period boundaries ─────────────────────────────────────────────────
    const resetDate   = new Date(periodId);
    // Approximate period start: subtract one calendar month from reset date.
    const periodStart = new Date(resetDate);
    periodStart.setMonth(periodStart.getMonth() - 1);

    const periodLength = Math.max(1,
        (resetDate.getTime() - periodStart.getTime()) / MS_PER_DAY);

    // ── Average & projection (gap-robust cumulative maths) ────────────────
    // daysElapsed is measured from the inferred period start, not from the
    // first tracked day — so it stays accurate even when the machine was off.
    const daysElapsed = Math.max(1,
        (now.getTime() - periodStart.getTime()) / MS_PER_DAY);

    const avgPerDay    = currentUsed / daysElapsed;
    const budgetPerDay = total / periodLength;

    const daysLeft         = Math.max(0, (resetDate.getTime() - now.getTime()) / MS_PER_DAY);
    const projectedAtReset = Math.round(currentUsed + avgPerDay * daysLeft);
    const onTrack          = projectedAtReset <= total;

    // ── Exhaustion date ───────────────────────────────────────────────────
    const remaining = total - currentUsed;
    let exhaustionDate = null;
    if (remaining <= 0) {
        exhaustionDate = now;           // already exhausted
    } else if (avgPerDay > 0) {
        const candidate = new Date(now.getTime() + (remaining / avgPerDay) * MS_PER_DAY);
        if (candidate < resetDate)
            exhaustionDate = candidate; // exhausts before reset
    }

    // ── Per-day breakdown ─────────────────────────────────────────────────
    const perDay = _computePerDay(period, dayKeys);

    const todayKey         = localDateStr(now);
    const todayEntry       = perDay.find(d => d.date === todayKey);
    const todayConsumption = todayEntry?.consumption ?? null;
    // todayPartial = true when it's genuinely the first tracked day, OR when
    // we simply don't have a baseline yet (no entry for today at all).
    const todayPartial     = todayEntry?.partial ?? (todayEntry == null);

    return {
        currentUsed,
        total,
        todayConsumption,
        todayPartial,
        avgPerDay,
        budgetPerDay,
        projectedAtReset,
        onTrack,
        exhaustionDate,
        daysLeft,
        periodId,
        periodStart,
        resetDate,
        perDay,
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// Private helpers
// ─────────────────────────────────────────────────────────────────────────────

function _prune(history, now) {
    const cutoff = localDateStr(new Date(now.getTime() - MAX_DAYS * MS_PER_DAY));
    for (const periodId of Object.keys(history.periods)) {
        const period = history.periods[periodId];
        for (const dayKey of Object.keys(period.days)) {
            if (dayKey < cutoff)
                delete period.days[dayKey];
        }
        if (Object.keys(period.days).length === 0)
            delete history.periods[periodId];
    }
}

function _lastUsed(period) {
    const dayKeys = Object.keys(period.days).sort();
    return dayKeys.length === 0 ? 0 : period.days[dayKeys[dayKeys.length - 1]].last;
}

/**
 * Build per-day consumption array from a period's day map.
 *
 * Consumption for day N = day[N].last − day[N-1].last
 * Day 0 (first tracked day) is flagged partial: consumption = last − first.
 * A gap between two consecutive tracked days is flagged with gapDays > 0;
 * the consumption figure then covers that entire gap.
 */
function _computePerDay(period, dayKeys) {
    return dayKeys.map((dayKey, i) => {
        const day = period.days[dayKey];
        let consumption = 0;
        let partial     = false;
        let gapDays     = 0;

        if (i === 0) {
            consumption = Math.max(0, day.last - day.first);
            partial     = true;
        } else {
            const prevKey  = dayKeys[i - 1];
            const prevDay  = period.days[prevKey];
            const daysBetween = Math.round(
                (new Date(dayKey  + 'T00:00:00').getTime() -
                 new Date(prevKey + 'T00:00:00').getTime()) / MS_PER_DAY
            );
            consumption = Math.max(0, day.last - prevDay.last);
            if (daysBetween > 1)
                gapDays = daysBetween - 1;
        }

        return {date: dayKey, consumption, partial, gapDays, n: day.n};
    });
}
