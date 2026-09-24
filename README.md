# Claude Usage — GNOME Shell extension

Top-bar indicator showing your Claude **session (5h)** and **weekly** usage limits.

Panel shows two figures, colour-coded by severity:

    [icon] 22% · 99%
            │     └── weekly, all models
            └──────── current 5-hour session

Click it for a breakdown: every limit the API reports (including
per-model weekly limits and extra-usage credits), each with a
progress bar and a "resets in …" countdown.

## Where the numbers come from

`GET https://api.anthropic.com/api/oauth/usage` — the same endpoint the
`/usage` command in Claude Code uses.

The OAuth token is read fresh from `~/.claude/.credentials.json` on every
poll, so whenever Claude Code refreshes the token the extension picks it
up automatically. The extension never refreshes or writes the token itself.

Polls every 5 minutes, plus on menu open if the data is older than 60s,
plus on demand via "Refresh now".

## Requirements

- Claude Code installed and logged in with a Claude subscription (`claude` → `/login`).
- GNOME Shell 3.36 or newer. Check with `gnome-shell --version`.

| GNOME Shell | Ubuntu | Build |
|---|---|---|
| 45 – 50 | 24.04 and newer | repo root |
| 3.36 – 44 | 20.04, 22.04 | `legacy/` |

GNOME 45 switched extensions to ES modules, which older shells cannot load,
so `legacy/extension.js` is a port of `extension.js` to the old `imports.*`
API. Change both when changing behaviour.

## Install

Clone once, then link the build that matches your GNOME version:

    git clone https://github.com/deefernando6/gnome-claude-usage.git \
        ~/.local/share/gnome-claude-usage

    # GNOME 45 – 50 (Ubuntu 24.04+)
    ln -sfn ~/.local/share/gnome-claude-usage \
        ~/.local/share/gnome-shell/extensions/claude-usage@orangehrm.com

    # GNOME 3.36 – 44 (Ubuntu 20.04 / 22.04)
    ln -sfn ~/.local/share/gnome-claude-usage/legacy \
        ~/.local/share/gnome-shell/extensions/claude-usage@orangehrm.com

Restart GNOME Shell so it discovers the extension:

- **Wayland:** log out and back in.
- **X11** (default on Ubuntu 20.04): press `Alt+F2`, type `r`, press Enter.

Then:

    gnome-extensions enable claude-usage@orangehrm.com

Update later with `git -C ~/.local/share/gnome-claude-usage pull`, then
restart the shell as above.

## Tuning

Constants at the top of `extension.js`:

| Constant | Default | Meaning |
|---|---|---|
| `REFRESH_SECONDS` | `300` | poll interval |
| `STALE_SECONDS` | `60` | re-poll on menu open if older than this |
| `BAR_WIDTH` | `240` | progress bar width in px |

Colour thresholds live in `severityClass()`; the API's own `severity`
field is preferred, with a percent-based fallback (<70 normal,
70–89 warning, ≥90 critical).

## Debugging

    journalctl -f -o cat /usr/bin/gnome-shell | grep -i claude

## Uninstall

    gnome-extensions disable claude-usage@orangehrm.com
    rm ~/.local/share/gnome-shell/extensions/claude-usage@orangehrm.com
    rm -rf ~/.local/share/gnome-claude-usage

## Note

The extension reads your Claude OAuth token from disk and sends it to
api.anthropic.com only. It is the same file and the same destination
Claude Code itself uses. Nothing is written, logged, or sent elsewhere.
