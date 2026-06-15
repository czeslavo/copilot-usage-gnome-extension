import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Soup from 'gi://Soup';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

// Promisify so we can await subprocess output
Gio._promisify(Gio.Subprocess.prototype, 'communicate_utf8_async');

const ENTITLEMENT_URL = 'https://github.com/github-copilot/chat/entitlement';

// Python script that reads user_session from Firefox's SQLite cookie store.
// Outputs the cookie value to stdout (no trailing newline).
// Exit codes: 0 = success, 1 = no Firefox profile found, 2 = cookie not found.
const FIREFOX_COOKIE_SCRIPT = [
    'import sqlite3, glob, os',
    "dbs = (",
    "    glob.glob(os.path.expanduser('~/.mozilla/firefox/*.default-release/cookies.sqlite'))",
    "    or glob.glob(os.path.expanduser('~/.mozilla/firefox/*.default/cookies.sqlite'))",
    ")",
    'if not dbs: raise SystemExit(1)',
    "conn = sqlite3.connect(f'file:{dbs[0]}?mode=ro&immutable=1', uri=True)",
    "row = conn.execute(\"SELECT value FROM moz_cookies WHERE host='github.com' AND name='user_session'\").fetchone()",
    "if row: print(row[0], end='')",
    'else: raise SystemExit(2)',
].join('\n');

// Style class thresholds (based on % used, not % remaining)
const THRESHOLD_MEDIUM = 50;
const THRESHOLD_HIGH   = 80;

const CopilotIndicator = GObject.registerClass(
class CopilotIndicator extends PanelMenu.Button {
    _init(extension) {
        super._init(0.0, 'Copilot Usage');
        this._ext = extension;

        // Panel label
        this._label = new St.Label({
            text: 'CP: …',
            y_align: 2, // Clutter.ActorAlign.CENTER
            style_class: 'copilot-usage-label',
        });
        this.add_child(this._label);

        // --- Popup menu items ---
        this._usageItem = new PopupMenu.PopupMenuItem('', {reactive: false});
        this._usageItem.label.style_class = 'copilot-usage-detail';
        this.menu.addMenuItem(this._usageItem);

        this._creditsItem = new PopupMenu.PopupMenuItem('', {reactive: false});
        this._creditsItem.label.style_class = 'copilot-usage-detail';
        this.menu.addMenuItem(this._creditsItem);

        this._chatItem = new PopupMenu.PopupMenuItem('', {reactive: false});
        this._chatItem.label.style_class = 'copilot-usage-detail';
        this.menu.addMenuItem(this._chatItem);

        this._completionsItem = new PopupMenu.PopupMenuItem('', {reactive: false});
        this._completionsItem.label.style_class = 'copilot-usage-detail';
        this.menu.addMenuItem(this._completionsItem);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._resetItem = new PopupMenu.PopupMenuItem('', {reactive: false});
        this._resetItem.label.style_class = 'copilot-usage-detail';
        this.menu.addMenuItem(this._resetItem);

        this._sourceItem = new PopupMenu.PopupMenuItem('', {reactive: false});
        this._sourceItem.label.style_class = 'copilot-usage-detail';
        this.menu.addMenuItem(this._sourceItem);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        const refreshItem = new PopupMenu.PopupMenuItem('Refresh now');
        refreshItem.connect('activate', () => {
            this._label.text = 'CP: …';
            this._ext.fetchUsage();
        });
        this.menu.addMenuItem(refreshItem);

        const prefsItem = new PopupMenu.PopupMenuItem('Preferences…');
        prefsItem.connect('activate', () => this._ext.openPreferences().catch(logError));
        this.menu.addMenuItem(prefsItem);

        this._setError('No data');
    }

    updateUsage(data, cookieSource) {
        const q = data.quotas;
        const pq = q.premiumInteractionsQuota;

        const pctUsed = Math.round(100 - pq.percentRemaining);
        const used    = Math.round(pq.used);
        const total   = pq.total;

        // Panel label
        this._label.text = `CP: ${pctUsed}%`;

        // Remove old colour class, add new one
        this._label.remove_style_class_name('copilot-usage-low');
        this._label.remove_style_class_name('copilot-usage-medium');
        this._label.remove_style_class_name('copilot-usage-high');
        if (pctUsed >= THRESHOLD_HIGH)
            this._label.add_style_class_name('copilot-usage-high');
        else if (pctUsed >= THRESHOLD_MEDIUM)
            this._label.add_style_class_name('copilot-usage-medium');
        else
            this._label.add_style_class_name('copilot-usage-low');

        // Detail rows
        this._usageItem.label.text =
            `Credits: ${used.toLocaleString()} / ${total.toLocaleString()} (${pctUsed}% used)`;

        const pctPremRemaining = pq.percentRemaining.toFixed(1);
        this._creditsItem.label.text =
            `Remaining: ${Math.round(pq.percentRemaining * total / 100).toLocaleString()} credits (${pctPremRemaining}%)`;

        this._chatItem.label.text = q.chatQuota?.unlimited
            ? 'Chat: unlimited'
            : `Chat: ${Math.round(q.chatQuota.used)} / ${q.chatQuota.total} used`;

        this._completionsItem.label.text = q.completionsQuota?.unlimited
            ? 'Completions: unlimited'
            : `Completions: ${Math.round(q.completionsQuota.used)} / ${q.completionsQuota.total} used`;

        // Reset date
        const resetDate = new Date(q.resetDateUtc);
        const now = new Date();
        const msPerDay = 86_400_000;
        const daysLeft = Math.ceil((resetDate - now) / msPerDay);
        const resetStr = resetDate.toLocaleDateString(undefined, {month: 'short', day: 'numeric', year: 'numeric'});
        this._resetItem.label.text =
            `Resets: ${resetStr} (${daysLeft} day${daysLeft !== 1 ? 's' : ''})`;

        this._sourceItem.label.text = `Auth: ${cookieSource}`;
    }

    _setError(msg) {
        this._label.text = 'CP: ?';
        this._label.remove_style_class_name('copilot-usage-low');
        this._label.remove_style_class_name('copilot-usage-medium');
        this._label.remove_style_class_name('copilot-usage-high');

        this._usageItem.label.text       = msg;
        this._creditsItem.label.text     = '';
        this._chatItem.label.text        = '';
        this._completionsItem.label.text = '';
        this._resetItem.label.text       = '';
        this._sourceItem.label.text      = '';
    }

    setError(msg) {
        this._setError(msg);
    }
});


export default class CopilotUsageExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._session  = new Soup.Session();
        this._pollId   = null;

        this._indicator = new CopilotIndicator(this);
        Main.panel.addToStatusArea(this.uuid, this._indicator);

        // Initial fetch + start polling
        this.fetchUsage();
        this._startPolling();

        // Re-start polling when refresh interval changes
        this._settingsId = this._settings.connect('changed::refresh-interval',
            () => this._startPolling());
    }

    disable() {
        this._stopPolling();

        if (this._settingsId) {
            this._settings.disconnect(this._settingsId);
            this._settingsId = null;
        }

        this._indicator?.destroy();
        this._indicator = null;

        this._session = null;
        this._settings = null;
    }

    _startPolling() {
        this._stopPolling();
        const intervalMin = this._settings.get_int('refresh-interval');
        const intervalSec = intervalMin * 60;
        this._pollId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT,
            intervalSec,
            () => {
                this.fetchUsage(); // fire-and-forget; SOURCE_CONTINUE returned synchronously
                return GLib.SOURCE_CONTINUE;
            }
        );
    }

    _stopPolling() {
        if (this._pollId !== null) {
            GLib.source_remove(this._pollId);
            this._pollId = null;
        }
    }

    // Reads user_session from Firefox's SQLite cookie database.
    // Returns the cookie string on success, throws on failure.
    async _readFirefoxCookie() {
        const proc = new Gio.Subprocess({
            argv: ['python3', '-c', FIREFOX_COOKIE_SCRIPT],
            flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE,
        });
        proc.init(null);

        const [stdout] = await proc.communicate_utf8_async(null, null);

        if (!proc.get_successful()) {
            const code = proc.get_exit_status();
            throw new Error(code === 2
                ? 'not logged in to GitHub in Firefox'
                : 'Firefox profile not found');
        }

        const value = stdout.trim();
        if (!value)
            throw new Error('empty cookie value from Firefox');

        return value;
    }

    async fetchUsage() {
        // 1. Try Firefox auto-detection
        let cookie = null;
        let cookieSource = 'manual';

        try {
            cookie = await this._readFirefoxCookie();
            cookieSource = 'Firefox';
        } catch (e) {
            // Not an error worth logging every poll; fall through to manual
        }

        // 2. Fall back to manually configured cookie
        if (!cookie)
            cookie = this._settings?.get_string('user-session-cookie')?.trim() ?? '';

        if (!cookie) {
            this._indicator?.setError('Log in to GitHub in Firefox, or set cookie in Preferences');
            return;
        }

        // 3. Fetch entitlement data
        const msg = Soup.Message.new('GET', ENTITLEMENT_URL);
        msg.request_headers.append('Accept', 'application/json');
        msg.request_headers.append('GitHub-Verified-Fetch', 'true');
        msg.request_headers.append('X-Requested-With', 'XMLHttpRequest');
        msg.request_headers.append('Cookie', `user_session=${cookie}`);

        this._session?.send_and_read_async(
            msg,
            GLib.PRIORITY_DEFAULT,
            null,
            (session, result) => {
                try {
                    const bytes = session.send_and_read_finish(result);
                    const status = msg.get_status();

                    if (status === Soup.Status.OK) {
                        const text = new TextDecoder().decode(bytes.get_data());
                        const data = JSON.parse(text);
                        this._indicator?.updateUsage(data, cookieSource);
                    } else if (status === Soup.Status.NOT_MODIFIED) {
                        // 304: data unchanged — nothing to update
                    } else if (status === Soup.Status.UNAUTHORIZED ||
                               status === Soup.Status.FORBIDDEN) {
                        this._indicator?.setError('Cookie expired – log in to GitHub in Firefox');
                    } else {
                        this._indicator?.setError(`HTTP ${status}`);
                    }
                } catch (e) {
                    logError(e, 'CopilotUsage: fetch failed');
                    this._indicator?.setError('Fetch error – see logs');
                }
            }
        );
    }
}
