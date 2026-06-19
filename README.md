# Copilot Usage — GNOME Shell Extension

Shows your GitHub Copilot **credit usage** as a live percentage in the GNOME top panel.

```
CP: 34%
```

Click the label to see a breakdown: credits used vs. total, today's consumption, daily average vs. budget, on-track status, reset date, and auth source.

## Requirements

- GNOME Shell 48 or 49
- Python 3 (standard library only — used to read the Firefox cookie)
- Firefox logged in to GitHub (recommended), **or** a manually copied session cookie

## Install

1. Clone or download this repository.

2. Copy the extension directory to the GNOME extensions folder:

   ```bash
   cp -r . ~/.local/share/gnome-shell/extensions/copilot-usage@czeslavo.github.io
   ```

3. Compile the GSettings schema:

   ```bash
   glib-compile-schemas ~/.local/share/gnome-shell/extensions/copilot-usage@czeslavo.github.io/schemas/
   ```

4. Log out and log back in. The extension loads on session start.

5. Enable the extension:

   ```bash
   gnome-extensions enable copilot-usage@czeslavo.github.io
   ```

## Authenticate

The extension needs your GitHub `user_session` cookie to query Copilot usage. It tries two sources in order:

### Firefox auto-detection (recommended)

If you are logged in to GitHub in Firefox, no configuration is needed. The extension reads the `user_session` cookie directly from Firefox's cookie database (`~/.mozilla/firefox/…/cookies.sqlite`) each time it polls. The cookie is never stored anywhere by the extension.

Open **Preferences** to see whether auto-detection is active and when the cookie expires.

### Manual cookie (fallback)

Use this if you do not use Firefox, or if auto-detection fails.

1. Open [github.com](https://github.com) in your browser.
2. Press **F12** and go to **Application → Cookies → https://github.com**.
3. Copy the value of the `user_session` cookie.
4. Open the extension **Preferences** and paste the value into the **Manual cookie** field.

The manual cookie is stored in GSettings and used automatically when Firefox auto-detection finds nothing.

> [!NOTE]
> The `user_session` cookie expires periodically. When the panel shows `CP: ?` with an auth error, either log in to GitHub in Firefox again or update the manual cookie in Preferences.

## Configure

Open **Preferences** from the popup menu or from the GNOME Extensions app.

| Setting | Default | Description |
|---|---|---|
| Refresh interval | 30 minutes | How often the extension polls for updated usage. Range: 5–1440 minutes. |
| Manual cookie | _(empty)_ | Fallback `user_session` cookie value. Leave empty if using Firefox. |

## Read the Display

**Panel label**

The label shows the percentage of your credit quota that has been used this period. The color changes with usage:

| Color | Meaning |
|---|---|
| Green | Less than 50% used |
| Yellow | 50–79% used |
| Orange | 80% or more used |

**Popup menu**

Click the label to expand the popup:

- **Credits** — absolute count and percentage used
- **Remaining** — credits left before the quota resets
- **Chat / Completions** — whether these are metered or unlimited on your plan
- **Today** — credits consumed today (marked "partial" on the first tracked day)
- **Avg / Budget** — your running daily average vs. the even-spend budget
- **Status** — `On track ✓` (green) or `Exhausts <date>` (orange) when on pace to exceed the quota before reset
- **Resets** — the reset date and how many days remain
- **Auth** — which source provided the cookie (`Firefox` or `manual`)

The popup also has a **Refresh now** item to trigger an immediate update, and a **Preferences…** item to open settings.

## Statistics

Open **Preferences → Statistics** for a deeper view of your usage history.

**Summary** shows:

| Row | What it means |
|---|---|
| Today | Credits consumed so far today |
| Daily average | Running average since the period started (gap-robust: stays accurate even when the machine is off) |
| Daily budget | Even-spend target — `total quota ÷ period length` |
| Projected at reset | Estimated total if your current average holds to the end of the period |
| Status | On track or projected overage with estimated exhaustion date |

**Daily Usage chart** — a bar chart of credits consumed per day across the current billing period. Green bars are at or under budget; orange bars are over. The dashed line marks the daily budget. Today's bar is rendered at reduced opacity to indicate it is still accumulating.

**Day-by-Day table** — one row per tracked day, newest first. Over-budget days are highlighted in orange. Rows flagged "partial" or "covers N untracked days" indicate gaps in the data (see limitations below).

**Clear History** removes all stored data.

### Limitations

Daily figures are derived from periodic snapshots taken while the extension is running. A few edge cases apply:

- **The first tracked day is always partial.** Usage before the first recorded sample is not attributable to a specific day.
- **Gaps when the machine is off.** If the extension was not running for one or more days, the next tracked day shows the aggregated delta and is flagged "covers N untracked days". This does not affect the daily average, which is computed from the cumulative API total and is always gap-robust.
- **Same dependency as the main feature.** If GitHub changes the entitlement endpoint, both the live display and history recording pause.
