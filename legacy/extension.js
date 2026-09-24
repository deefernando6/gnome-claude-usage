/* Legacy build for GNOME Shell 3.36 – 44 (Ubuntu 20.04, 22.04).
 *
 * GNOME 45+ requires ES modules, which older shells cannot load, so this is a
 * port of ../extension.js to the old imports.* API. Keep the two in sync.
 *
 * Written for GJS 1.64 (SpiderMonkey 68): no optional chaining (?.), no
 * nullish coalescing (??), no class fields, no TextDecoder.
 */
'use strict';

const {St, Gio, GLib, GObject, Clutter, Soup} = imports.gi;
const ByteArray = imports.byteArray;

const Main = imports.ui.main;
const PanelMenu = imports.ui.panelMenu;
const PopupMenu = imports.ui.popupMenu;
const ExtensionUtils = imports.misc.extensionUtils;

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const OAUTH_BETA = 'oauth-2025-04-20';
const CREDS_PATH = GLib.build_filenamev([GLib.get_home_dir(), '.claude', '.credentials.json']);

// How often to poll, in seconds. The numbers move slowly; don't hammer the API.
const REFRESH_SECONDS = 300;
// If the menu is opened and the data is older than this, refresh on open.
const STALE_SECONDS = 60;
const BAR_WIDTH = 240;

// GNOME 3.36 – 42 ship libsoup 2.4; GNOME 43 – 44 ship libsoup 3.
const SOUP3 = Soup.MAJOR_VERSION >= 3;

function get(obj, ...path) {
    for (const key of path) {
        if (obj === null || obj === undefined)
            return undefined;
        obj = obj[key];
    }
    return obj;
}

function num(v) {
    return v === null || v === undefined ? 0 : v;
}

function severityClass(severity, percent) {
    if (severity === 'critical' || severity === 'warning' || severity === 'normal')
        return severity;
    if (percent >= 90) return 'critical';
    if (percent >= 70) return 'warning';
    return 'normal';
}

// "weekly_scoped" + {model:{display_name:"Opus"}} -> "Weekly (Opus)"
function limitTitle(limit) {
    const scopeBits = [];
    const model = get(limit, 'scope', 'model', 'display_name');
    const surface = get(limit, 'scope', 'surface');
    if (model)
        scopeBits.push(model);
    if (surface)
        scopeBits.push(surface);
    const scope = scopeBits.length ? ` (${scopeBits.join(', ')})` : '';

    switch (limit.kind) {
    case 'session':      return `Session · 5 hours${scope}`;
    case 'weekly_all':   return `Weekly · all models${scope}`;
    case 'weekly_scoped': return `Weekly${scope || ' · scoped'}`;
    default:             return `${limit.kind}${scope}`;
    }
}

function formatReset(iso) {
    if (!iso) return '';
    const then = GLib.DateTime.new_from_iso8601(iso, null);
    if (!then) return '';
    const secs = then.to_unix() - GLib.DateTime.new_now_utc().to_unix();
    if (secs <= 0) return 'resets now';

    const d = Math.floor(secs / 86400);
    const h = Math.floor((secs % 86400) / 3600);
    const m = Math.floor((secs % 3600) / 60);
    if (d > 0) return `resets in ${d}d ${h}h`;
    if (h > 0) return `resets in ${h}h ${m}m`;
    return `resets in ${m}m`;
}

const ClaudeUsageIndicator = GObject.registerClass(
class ClaudeUsageIndicator extends PanelMenu.Button {
    _init() {
        super._init(0.5, 'Claude Usage');

        this._session = new Soup.Session({timeout: 15});
        this._cancellable = new Gio.Cancellable();
        this._timeoutId = 0;
        this._fetchedAt = 0;
        this._inFlight = false;

        this._buildPanel();
        this._buildMenu();

        this.menu.connect('open-state-changed', (_menu, open) => {
            const age = GLib.get_monotonic_time() / 1e6 - this._fetchedAt;
            if (open && age > STALE_SECONDS)
                this.refresh();
        });
    }

    _buildPanel() {
        const box = new St.BoxLayout({
            style_class: 'panel-status-menu-box ccu-panel-box',
        });

        this._icon = new St.Icon({
            icon_name: 'utilities-system-monitor-symbolic',
            style_class: 'system-status-icon',
        });

        this._sessionLabel = new St.Label({
            text: '–',
            style_class: 'ccu-panel-label ccu-unknown',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._sepLabel = new St.Label({
            text: '·',
            style_class: 'ccu-panel-label ccu-sep-label',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._weeklyLabel = new St.Label({
            text: '–',
            style_class: 'ccu-panel-label ccu-unknown',
            y_align: Clutter.ActorAlign.CENTER,
        });

        box.add_child(this._icon);
        box.add_child(this._sessionLabel);
        box.add_child(this._sepLabel);
        box.add_child(this._weeklyLabel);
        this.add_child(box);
    }

    _buildMenu() {
        this._rowsSection = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._rowsSection);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._footer = new PopupMenu.PopupMenuItem('Loading…', {
            reactive: false,
            style_class: 'ccu-footer',
        });
        this.menu.addMenuItem(this._footer);

        const refreshItem = new PopupMenu.PopupMenuItem('Refresh now');
        refreshItem.connect('activate', () => this.refresh());
        this.menu.addMenuItem(refreshItem);
    }

    // --- one usage row: title, percent, reset time, progress bar ---
    _addRow(limit) {
        const item = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            can_focus: false,
            style_class: 'ccu-row',
        });

        const col = new St.BoxLayout({
            vertical: true,
            x_expand: true,
        });

        const head = new St.BoxLayout({
            x_expand: true,
        });

        const percent = Math.round(num(limit.percent));
        const sev = severityClass(limit.severity, percent);

        const title = new St.Label({
            text: limitTitle(limit),
            style_class: 'ccu-row-title',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        const value = new St.Label({
            text: `${percent}%`,
            style_class: `ccu-row-title ccu-${sev}`,
            y_align: Clutter.ActorAlign.CENTER,
        });
        head.add_child(title);
        head.add_child(value);

        const track = new St.BoxLayout({
            style_class: 'ccu-bar-track',
        });
        const fill = new St.Widget({style_class: `ccu-bar-fill ccu-fill-${sev}`});
        const px = Math.max(2, Math.round(BAR_WIDTH * Math.min(100, percent) / 100));
        fill.set_style(`width: ${px}px;`);
        track.add_child(fill);

        const sub = new St.Label({
            text: formatReset(limit.resets_at),
            style_class: 'ccu-row-sub',
        });

        col.add_child(head);
        col.add_child(track);
        col.add_child(sub);
        item.add_child(col);
        this._rowsSection.addMenuItem(item);
    }

    _addNote(text, styleClass = 'ccu-footer') {
        this._rowsSection.addMenuItem(new PopupMenu.PopupMenuItem(text, {
            reactive: false,
            style_class: styleClass,
        }));
    }

    // --- rendering ---
    _render(data) {
        this._rowsSection.removeAll();

        const limits = Array.isArray(data.limits) ? data.limits : [];
        // Show the two headline limits always; scoped ones only once they are in use.
        const shown = limits.filter(l =>
            l.kind === 'session' || l.kind === 'weekly_all' || num(l.percent) > 0);

        if (shown.length === 0) {
            this._addNote('No usage limits reported.');
        } else {
            for (const l of shown)
                this._addRow(l);
        }

        const extra = data.extra_usage;
        if (extra && extra.is_enabled && extra.utilization !== null) {
            this._addRow({
                kind: 'extra',
                percent: extra.utilization,
                severity: null,
                resets_at: null,
            });
        }

        const sessionLimit = limits.find(l => l.kind === 'session');
        const weeklyLimit = limits.find(l => l.kind === 'weekly_all');
        this._setPanel(this._sessionLabel, sessionLimit);
        this._setPanel(this._weeklyLabel, weeklyLimit);

        const now = GLib.DateTime.new_now_local();
        this._footer.label.text = `Updated ${now.format('%H:%M')}`;
    }

    _setPanel(label, limit) {
        if (!limit) {
            label.text = '–';
            label.style_class = 'ccu-panel-label ccu-unknown';
            return;
        }
        const percent = Math.round(num(limit.percent));
        label.text = `${percent}%`;
        label.style_class =
            `ccu-panel-label ccu-${severityClass(limit.severity, percent)}`;
    }

    _renderError(message) {
        this._rowsSection.removeAll();
        this._addNote(message, 'ccu-error');
        for (const label of [this._sessionLabel, this._weeklyLabel]) {
            label.text = '!';
            label.style_class = 'ccu-panel-label ccu-unknown';
        }
        this._footer.label.text = 'Last attempt failed';
    }

    // --- data ---
    refresh() {
        if (this._inFlight)
            return;
        this._inFlight = true;

        const file = Gio.File.new_for_path(CREDS_PATH);
        file.load_contents_async(this._cancellable, (f, res) => {
            let token;
            try {
                const [, contents] = f.load_contents_finish(res);
                const creds = JSON.parse(ByteArray.toString(contents));
                token = get(creds, 'claudeAiOauth', 'accessToken');
            } catch (e) {
                this._inFlight = false;
                this._renderError('Could not read ~/.claude/.credentials.json');
                return;
            }

            if (!token) {
                this._inFlight = false;
                this._renderError('No OAuth token found. Log in with `claude`.');
                return;
            }
            this._fetchUsage(token);
        });
    }

    _fetchUsage(token) {
        const msg = Soup.Message.new('GET', USAGE_URL);
        msg.request_headers.append('Authorization', `Bearer ${token}`);
        msg.request_headers.append('anthropic-beta', OAUTH_BETA);

        if (SOUP3) {
            this._session.send_and_read_async(
                msg, GLib.PRIORITY_DEFAULT, this._cancellable, (sess, res) => {
                    let text;
                    try {
                        text = ByteArray.toString(sess.send_and_read_finish(res).get_data());
                    } catch (e) {
                        this._done();
                        if (!(e.matches && e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)))
                            this._renderError(`Network error: ${e.message}`);
                        return;
                    }
                    this._handleResponse(msg.get_status(), text);
                });
        } else {
            this._session.queue_message(msg, (_sess, m) => {
                // 1 = SOUP_STATUS_CANCELLED (session aborted on disable)
                if (m.status_code === Soup.Status.CANCELLED) {
                    this._done();
                    return;
                }
                if (m.status_code < 100) {
                    this._done();
                    this._renderError(`Network error: ${Soup.Status.get_phrase(m.status_code)}`);
                    return;
                }
                this._handleResponse(m.status_code, m.response_body.data);
            });
        }
    }

    _done() {
        this._inFlight = false;
        this._fetchedAt = GLib.get_monotonic_time() / 1e6;
    }

    _handleResponse(status, text) {
        this._done();
        if (status === 401 || status === 403) {
            this._renderError('Token rejected. Run `claude` to re-authenticate.');
            return;
        }
        if (status !== 200) {
            this._renderError(`HTTP ${status} from the usage API`);
            return;
        }
        try {
            this._render(JSON.parse(text));
        } catch (e) {
            this._renderError(`Bad response: ${e.message}`);
        }
    }

    start() {
        this.refresh();
        this._timeoutId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT, REFRESH_SECONDS, () => {
                this.refresh();
                return GLib.SOURCE_CONTINUE;
            });
    }

    destroy() {
        if (this._timeoutId) {
            GLib.Source.remove(this._timeoutId);
            this._timeoutId = 0;
        }
        this._cancellable.cancel();
        this._session.abort();
        super.destroy();
    }
});

class ClaudeUsageExtension {
    constructor(uuid) {
        this._uuid = uuid;
        this._indicator = null;
    }

    enable() {
        this._indicator = new ClaudeUsageIndicator();
        Main.panel.addToStatusArea(this._uuid, this._indicator);
        this._indicator.start();
    }

    disable() {
        if (this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }
    }
}

function init() {
    return new ClaudeUsageExtension(ExtensionUtils.getCurrentExtension().metadata.uuid);
}
