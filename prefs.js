import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';
import {loadHistory, computeStats, localDateStr} from './stats.js';

const MS_PER_DAY = 86_400_000;

export default class CopilotUsagePreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        this._buildAuthPage(window, settings);
        this._buildPollingPage(window, settings);
        this._buildStatsPage(window, settings);
    }

    // ── Authentication page ───────────────────────────────────────────────────

    _buildAuthPage(window, settings) {
        const page = new Adw.PreferencesPage({
            title: 'Authentication',
            icon_name: 'dialog-password-symbolic',
        });
        window.add(page);

        // Firefox auto-detection group
        const firefoxGroup = new Adw.PreferencesGroup({
            title: 'Firefox Auto-Detection',
            description:
                'The extension reads your user_session cookie automatically from ' +
                'Firefox\'s cookie database (~/.mozilla/firefox/…/cookies.sqlite). ' +
                'As long as you are logged in to GitHub in Firefox, no manual ' +
                'configuration is needed.',
        });
        page.add(firefoxGroup);

        const firefoxRow = new Adw.ActionRow({title: 'Status'});
        firefoxGroup.add(firefoxRow);

        const firefoxLabel = new Gtk.Label({
            label: 'Checking…',
            valign: Gtk.Align.CENTER,
            css_classes: ['dim-label'],
        });
        firefoxRow.add_suffix(firefoxLabel);
        this._checkFirefox(firefoxLabel);

        // Manual fallback group
        const manualGroup = new Adw.PreferencesGroup({
            title: 'Manual Cookie (Fallback)',
            description:
                'Used only when Firefox auto-detection fails (e.g. you use a ' +
                'different browser). Open github.com, press F12, go to ' +
                'Application → Cookies → https://github.com, and copy the value ' +
                'of the user_session cookie.',
        });
        page.add(manualGroup);

        const cookieRow = new Adw.PasswordEntryRow({title: 'user_session cookie'});
        manualGroup.add(cookieRow);
        settings.bind('user-session-cookie', cookieRow, 'text',
            0 /* Gio.SettingsBindFlags.DEFAULT */);

        const statusRow = new Adw.ActionRow({title: 'Fallback status'});
        manualGroup.add(statusRow);

        const statusLabel = new Gtk.Label({
            label: '',
            valign: Gtk.Align.CENTER,
            css_classes: ['dim-label'],
        });
        statusRow.add_suffix(statusLabel);

        const updateStatus = () => {
            const val = settings.get_string('user-session-cookie').trim();
            statusLabel.label = val.length > 0
                ? `Stored (${val.length} chars)`
                : 'Empty – Firefox auto-detection will be used';
        };
        updateStatus();
        settings.connect('changed::user-session-cookie', updateStatus);
    }

    // ── Polling page ──────────────────────────────────────────────────────────

    _buildPollingPage(window, settings) {
        const page = new Adw.PreferencesPage({
            title: 'Polling',
            icon_name: 'preferences-system-time-symbolic',
        });
        window.add(page);

        const group = new Adw.PreferencesGroup({
            title: 'Refresh Interval',
            description: 'How often the extension checks for updated usage data.',
        });
        page.add(group);

        const intervalRow = new Adw.SpinRow({
            title: 'Interval (minutes)',
            subtitle: 'Minimum 5, maximum 1440 (24 h)',
            adjustment: new Gtk.Adjustment({
                lower: 5, upper: 1440,
                step_increment: 5, page_increment: 30,
                value: settings.get_int('refresh-interval'),
            }),
            digits: 0,
        });
        group.add(intervalRow);
        settings.bind('refresh-interval', intervalRow, 'value',
            0 /* Gio.SettingsBindFlags.DEFAULT */);
    }

    // ── Statistics page ───────────────────────────────────────────────────────

    _buildStatsPage(window, settings) {
        const page = new Adw.PreferencesPage({
            title: 'Statistics',
            icon_name: 'office-calendar-symbolic',
        });
        window.add(page);

        // ── No-data placeholder ───────────────────────────────────────────
        const noDataGroup = new Adw.PreferencesGroup();
        page.add(noDataGroup);
        const noDataRow = new Adw.ActionRow({
            title: 'No data yet',
            subtitle:
                'Keep the extension running for a few days. ' +
                'Statistics appear once the first samples are collected.',
        });
        noDataGroup.add(noDataRow);

        // ── Summary group ─────────────────────────────────────────────────
        const summaryGroup = new Adw.PreferencesGroup({title: 'Current Period'});
        page.add(summaryGroup);

        const makeRow = title => {
            const row = new Adw.ActionRow({title});
            const lbl = new Gtk.Label({
                label: '—',
                valign: Gtk.Align.CENTER,
                css_classes: ['dim-label'],
            });
            row.add_suffix(lbl);
            summaryGroup.add(row);
            return lbl;
        };

        const todayLbl  = makeRow('Today');
        const avgLbl    = makeRow('Daily average');
        const budgetLbl = makeRow('Daily budget');
        const projLbl   = makeRow('Projected at reset');
        const statusLbl = makeRow('Status');

        // ── Chart group ───────────────────────────────────────────────────
        const chartGroup = new Adw.PreferencesGroup({
            title: 'Daily Usage',
            description: 'Credits consumed per day this period. Dashed line = daily budget.',
        });
        page.add(chartGroup);

        let currentStats = null;

        const chart = new Gtk.DrawingArea({
            content_height: 130,
            hexpand: true,
            margin_top: 8,
            margin_bottom: 8,
            margin_start: 12,
            margin_end: 12,
        });
        chartGroup.add(chart);
        chart.set_draw_func((widget, cr, width, height) => {
            this._drawChart(cr, width, height, currentStats);
        });

        // ── Day-by-Day group ──────────────────────────────────────────────
        const dailyGroup = new Adw.PreferencesGroup({title: 'Day-by-Day'});
        page.add(dailyGroup);
        let dailyRows = [];

        // ── Manage data group ─────────────────────────────────────────────
        const manageGroup = new Adw.PreferencesGroup({title: 'Manage Data'});
        page.add(manageGroup);

        const clearRow = new Adw.ButtonRow({
            title: 'Clear History',
            start_icon_name: 'edit-delete-symbolic',
        });
        clearRow.add_css_class('destructive-action');
        clearRow.connect('activated', () => settings.set_string('usage-history', '{}'));
        manageGroup.add(clearRow);

        // ── Refresh function ──────────────────────────────────────────────
        const refresh = () => {
            const history = loadHistory(settings.get_string('usage-history'));
            const stats   = computeStats(history, null);
            currentStats  = stats;

            const hasData = stats !== null;
            noDataGroup.set_visible(!hasData);
            summaryGroup.set_visible(hasData);
            chartGroup.set_visible(hasData);
            dailyGroup.set_visible(hasData);

            if (!hasData)
                return;

            // ── Summary labels ────────────────────────────────────────────
            const fmt     = n => Math.round(n).toLocaleString();
            const fmtDate = d => d.toLocaleDateString(undefined,
                {month: 'short', day: 'numeric'});

            if (stats.todayConsumption !== null) {
                todayLbl.label      = stats.todayPartial
                    ? `+${fmt(stats.todayConsumption)} credits (partial)`
                    : `+${fmt(stats.todayConsumption)} credits`;
                todayLbl.css_classes = ['dim-label'];
            } else {
                todayLbl.label      = 'collecting…';
                todayLbl.css_classes = ['dim-label'];
            }

            avgLbl.label    = `${fmt(stats.avgPerDay)} credits/day`;
            budgetLbl.label = `${fmt(stats.budgetPerDay)} credits/day`;

            const projPct   = Math.round(stats.projectedAtReset / stats.total * 100);
            projLbl.label   = `${fmt(stats.projectedAtReset)} / ${fmt(stats.total)} (${projPct}%)`;

            if (stats.onTrack) {
                statusLbl.label       = 'On track ✓';
                statusLbl.css_classes = ['success'];
            } else {
                const exStr          = stats.exhaustionDate
                    ? `Exhausts ${fmtDate(stats.exhaustionDate)}`
                    : 'Over budget';
                statusLbl.label       = exStr;
                statusLbl.css_classes = ['warning'];
            }

            // ── Redraw chart ──────────────────────────────────────────────
            chart.queue_draw();

            // ── Rebuild daily rows (newest first) ─────────────────────────
            for (const r of dailyRows)
                dailyGroup.remove(r);
            dailyRows = [];

            const sorted = [...stats.perDay].reverse();
            for (const entry of sorted) {
                const row = new Adw.ActionRow({title: entry.date});

                if (entry.partial)
                    row.set_subtitle('Partial — tracking started mid-day');
                else if (entry.gapDays > 0)
                    row.set_subtitle(
                        `Covers ${entry.gapDays} untracked day${entry.gapDays === 1 ? '' : 's'}`);

                const lbl = new Gtk.Label({
                    label: `+${Math.round(entry.consumption)}`,
                    valign: Gtk.Align.CENTER,
                });
                if (entry.consumption > stats.budgetPerDay)
                    lbl.css_classes = ['warning'];
                row.add_suffix(lbl);

                dailyGroup.add(row);
                dailyRows.push(row);
            }
        };

        refresh();
        settings.connect('changed::usage-history', refresh);
    }

    // ── Bar chart drawing ─────────────────────────────────────────────────────

    _drawChart(cr, width, height, stats) {
        if (!stats || stats.perDay.length === 0)
            return;

        const pad = {top: 4, right: 8, bottom: 4, left: 8};
        const cw  = width  - pad.left - pad.right;
        const ch  = height - pad.top  - pad.bottom;
        if (cw <= 0 || ch <= 0)
            return;

        const now     = new Date();
        const dayEnd  = now < stats.resetDate ? now : stats.resetDate;
        const nDays   = Math.max(1,
            Math.round((dayEnd.getTime() - stats.periodStart.getTime()) / MS_PER_DAY) + 1);

        const barSlot = cw / nDays;
        const barW    = Math.max(1, barSlot - 2);

        // Build lookup: dateStr → entry
        const dayMap = new Map(stats.perDay.map(d => [d.date, d]));

        // Y scale: tallest bar is max(budgetPerDay * 1.5, max consumption)
        const maxC = stats.perDay.reduce((m, d) => Math.max(m, d.consumption), 0);
        const yMax = Math.max(stats.budgetPerDay * 1.5, maxC * 1.1, 1);
        const yScale = ch / yMax;

        const todayKey = localDateStr(now);

        // ── Bars ──────────────────────────────────────────────────────────
        for (let i = 0; i < nDays; i++) {
            const date  = new Date(stats.periodStart.getTime() + i * MS_PER_DAY);
            const key   = localDateStr(date);
            const entry = dayMap.get(key);
            if (!entry || entry.consumption <= 0)
                continue;

            const x    = pad.left + i * barSlot;
            const barH = Math.max(1, entry.consumption * yScale);
            const y    = pad.top + ch - barH;

            const over    = entry.consumption > stats.budgetPerDay;
            const isToday = key === todayKey;

            if (over)
                cr.setSourceRGBA(1.0, 0.47, 0.0, isToday ? 0.55 : 0.85); // orange
            else
                cr.setSourceRGBA(0.34, 0.89, 0.54, isToday ? 0.55 : 0.85); // green

            cr.rectangle(x, y, barW, barH);
            cr.fill();
        }

        // ── Budget line (dashed) ──────────────────────────────────────────
        const budgetY = pad.top + ch - stats.budgetPerDay * yScale;
        cr.setSourceRGBA(0.65, 0.65, 0.65, 0.9);
        cr.setLineWidth(1.0);
        cr.setDash([4.0, 4.0], 0.0);
        cr.moveTo(pad.left, budgetY);
        cr.lineTo(pad.left + cw, budgetY);
        cr.stroke();
        cr.setDash([], 0.0);
    }

    // ── Firefox cookie status check ───────────────────────────────────────────

    _checkFirefox(label) {
        const script = [
            'import sqlite3, glob, os, datetime',
            "dbs = (",
            "    glob.glob(os.path.expanduser('~/.mozilla/firefox/*.default-release/cookies.sqlite'))",
            "    or glob.glob(os.path.expanduser('~/.mozilla/firefox/*.default/cookies.sqlite'))",
            ")",
            'if not dbs: raise SystemExit(1)',
            "conn = sqlite3.connect(f'file:{dbs[0]}?mode=ro&immutable=1', uri=True)",
            "row = conn.execute(\"SELECT value, expiry FROM moz_cookies WHERE host='github.com' AND name='user_session'\").fetchone()",
            'if not row: raise SystemExit(2)',
            'exp = datetime.datetime.fromtimestamp(row[1] / 1000)',
            "print(exp.strftime('%b %d, %Y'), end='')",
        ].join('\n');

        try {
            const proc = new Gio.Subprocess({
                argv: ['python3', '-c', script],
                flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE,
            });
            proc.init(null);

            proc.communicate_utf8_async(null, null, (p, res) => {
                try {
                    const [, stdout] = p.communicate_utf8_finish(res);
                    if (p.get_successful()) {
                        label.label       = `Active – cookie expires ${stdout.trim()}`;
                        label.css_classes = ['success'];
                    } else {
                        const code        = p.get_exit_status();
                        label.label       = code === 2
                            ? 'Not logged in to GitHub in Firefox'
                            : 'Firefox profile not found';
                        label.css_classes = ['warning'];
                    }
                } catch (_e) {
                    label.label       = 'Check failed';
                    label.css_classes = ['dim-label'];
                }
            });
        } catch (_e) {
            label.label       = 'Check unavailable';
            label.css_classes = ['dim-label'];
        }
    }
}
