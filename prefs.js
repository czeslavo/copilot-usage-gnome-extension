import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class CopilotUsagePreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        // ── Authentication page ─────────────────────────────────────────────
        const authPage = new Adw.PreferencesPage({
            title: 'Authentication',
            icon_name: 'dialog-password-symbolic',
        });
        window.add(authPage);

        // Firefox auto-detection group
        const firefoxGroup = new Adw.PreferencesGroup({
            title: 'Firefox Auto-Detection',
            description:
                'The extension reads your user_session cookie automatically from ' +
                'Firefox\'s cookie database (~/.mozilla/firefox/…/cookies.sqlite). ' +
                'As long as you are logged in to GitHub in Firefox, no manual ' +
                'configuration is needed.',
        });
        authPage.add(firefoxGroup);

        const firefoxRow = new Adw.ActionRow({
            title: 'Status',
        });
        firefoxGroup.add(firefoxRow);

        const firefoxLabel = new Gtk.Label({
            label: 'Checking…',
            valign: Gtk.Align.CENTER,
            css_classes: ['dim-label'],
        });
        firefoxRow.add_suffix(firefoxLabel);

        // Run the same Python snippet to show live status
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
        authPage.add(manualGroup);

        const cookieRow = new Adw.PasswordEntryRow({
            title: 'user_session cookie',
        });
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

        // ── Polling page ────────────────────────────────────────────────────
        const pollPage = new Adw.PreferencesPage({
            title: 'Polling',
            icon_name: 'preferences-system-time-symbolic',
        });
        window.add(pollPage);

        const pollGroup = new Adw.PreferencesGroup({
            title: 'Refresh Interval',
            description: 'How often the extension checks for updated usage data.',
        });
        pollPage.add(pollGroup);

        const intervalRow = new Adw.SpinRow({
            title: 'Interval (minutes)',
            subtitle: 'Minimum 5, maximum 1440 (24 h)',
            adjustment: new Gtk.Adjustment({
                lower: 5,
                upper: 1440,
                step_increment: 5,
                page_increment: 30,
                value: settings.get_int('refresh-interval'),
            }),
            digits: 0,
        });
        pollGroup.add(intervalRow);

        settings.bind('refresh-interval', intervalRow, 'value',
            0 /* Gio.SettingsBindFlags.DEFAULT */);
    }

    // Run the Firefox cookie check script and update the status label.
    _checkFirefox(label) {
        // expiry field in moz_cookies is milliseconds since Unix epoch
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

            // Use callback-based API directly (no promisify needed in prefs)
            proc.communicate_utf8_async(null, null, (p, res) => {
                try {
                    const [, stdout] = p.communicate_utf8_finish(res);
                    if (p.get_successful()) {
                        label.label = `Active – cookie expires ${stdout.trim()}`;
                        label.css_classes = ['success'];
                    } else {
                        const code = p.get_exit_status();
                        label.label = code === 2
                            ? 'Not logged in to GitHub in Firefox'
                            : 'Firefox profile not found';
                        label.css_classes = ['warning'];
                    }
                } catch (_e) {
                    label.label = 'Check failed';
                    label.css_classes = ['dim-label'];
                }
            });
        } catch (_e) {
            label.label = 'Check unavailable';
            label.css_classes = ['dim-label'];
        }
    }
}
