# Copilot Usage — GNOME Shell Extension

Shows your GitHub Copilot **credit usage** as a live percentage in the GNOME top panel.

```
CP: 34%
```

Click the label to see a breakdown: requests used vs. total, chat and completions quotas, the reset date, and which authentication source is active.

## Requirements

- GNOME Shell 48
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
- **Remaining** — requests left before the quota resets
- **Chat / Completions** — whether these are metered or unlimited on your plan
- **Resets** — the reset date and how many days remain
- **Auth** — which source provided the cookie (`Firefox` or `manual`)

The popup also has a **Refresh now** item to trigger an immediate update, and a **Preferences…** item to open settings.
