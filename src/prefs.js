import Gtk from 'gi://Gtk';
import Adw from 'gi://Adw';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import { ExtensionPreferences, gettext as _ } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

// A theme "counts" for a given purpose if its directory contains the
// matching subfolder: gtk-3.0/ for legacy GTK themes, gnome-shell/ for
// Shell themes. Scans ~/.themes and the system theme dirs.
function listThemes(markerSubdir) {
    const dirs = [
        GLib.build_filenamev([GLib.get_home_dir(), '.themes']),
        '/usr/share/themes',
        '/usr/local/share/themes',
    ];
    const found = new Set();

    for (const dir of dirs) {
        const dirFile = Gio.File.new_for_path(dir);
        if (!dirFile.query_exists(null))
            continue;
        try {
            const it = dirFile.enumerate_children('standard::name,standard::type', Gio.FileQueryInfoFlags.NONE, null);
            let info;
            while ((info = it.next_file(null)) !== null) {
                if (info.get_file_type() !== Gio.FileType.DIRECTORY)
                    continue;
                const name = info.get_name();
                const markerPath = GLib.build_filenamev([dir, name, markerSubdir]);
                if (Gio.File.new_for_path(markerPath).query_exists(null))
                    found.add(name);
            }
        } catch (e) {
            // unreadable directory, skip it
        }
    }

    return [...found].sort((a, b) => a.localeCompare(b));
}

// Scans the common plugin install paths across distros/Qt5/Qt6.
function buildQtPluginDirs() {
    const libBases = [
        '/usr/lib', '/usr/lib64', '/usr/local/lib',
        '/usr/lib/x86_64-linux-gnu', '/usr/lib/aarch64-linux-gnu', '/usr/lib/i386-linux-gnu',
    ];
    const qtSubdirs = ['qt5/plugins/styles', 'qt6/plugins/styles', 'qt/plugins/styles'];

    const dirs = [];
    for (const base of libBases) {
        for (const sub of qtSubdirs)
            dirs.push(GLib.build_filenamev([base, sub]));
    }
    return dirs;
}

// This reads CBOR (RFC 8949) major type 3 (text string) and major type 4 (array) to get the themes names.
function readCborUint(bytes, pos, headerByte, base) {
    const info = headerByte - base;
    if (info <= 23)
        return [info, pos];
    if (info === 24)
        return [bytes[pos], pos + 1];
    if (info === 25)
        return [(bytes[pos] << 8) | bytes[pos + 1], pos + 2];
    return [null, pos]; // longer forms aren't expected for a short style-name list
}

function readCborTextString(bytes, pos) {
    const header = bytes[pos];
    if (header < 0x60 || header > 0x7b)
        return [null, pos];
    const [len, afterLen] = readCborUint(bytes, pos + 1, header, 0x60);
    if (len === null)
        return [null, pos];
    const strBytes = bytes.slice(afterLen, afterLen + len);
    return [new TextDecoder('utf-8', { fatal: false }).decode(strBytes), afterLen + len];
}

// Byte sequence for the CBOR-encoded text string "Keys": header 0x64
// (short string, length 4) followed by the literal bytes K e y s.
const CBOR_KEYS_MARKER = [0x64, 0x4b, 0x65, 0x79, 0x73];

function readCborStyleKeys(bytes) {
    let keysPos = -1;
    outer:
    for (let i = 0; i <= bytes.length - CBOR_KEYS_MARKER.length; i++) {
        for (let j = 0; j < CBOR_KEYS_MARKER.length; j++) {
            if (bytes[i + j] !== CBOR_KEYS_MARKER[j])
                continue outer;
        }
        keysPos = i + CBOR_KEYS_MARKER.length;
        break;
    }
    if (keysPos === -1)
        return [];

    const header = bytes[keysPos];
    if (header < 0x80 || header > 0x9b)
        return []; // not immediately followed by an array — not the layout we expect
    const [count, afterHeader] = readCborUint(bytes, keysPos + 1, header, 0x80);
    if (count === null)
        return [];

    const keys = [];
    let pos = afterHeader;
    for (let i = 0; i < count && i < 20; i++) {
        const [text, next] = readCborTextString(bytes, pos);
        if (text === null)
            break;
        keys.push(text);
        pos = next;
    }
    return keys;
}

// Fallback for older, pre-CBOR Qt5 builds that embedded metadata as literal
// JSON text instead.
function readJsonStyleKeys(bytes) {
    const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    const m = /"Keys"\s*:\s*\[([^\]]*)\]/.exec(text);
    if (!m)
        return [];
    const keys = [];
    const keyRe = /"([^"]+)"/g;
    let km;
    while ((km = keyRe.exec(m[1])) !== null)
        keys.push(km[1]);
    return keys;
}

function readPluginStyleKeys(path) {
    try {
        const [ok, bytes] = GLib.file_get_contents(path);
        if (!ok)
            return [];
        const cborKeys = readCborStyleKeys(bytes);
        return cborKeys.length > 0 ? cborKeys : readJsonStyleKeys(bytes);
    } catch (e) {
        return [];
    }
}

function listQtStyles() {
    const found = new Set();

    for (const dir of buildQtPluginDirs()) {
        const dirFile = Gio.File.new_for_path(dir);
        if (!dirFile.query_exists(null))
            continue;
        try {
            const it = dirFile.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
            let info;
            while ((info = it.next_file(null)) !== null) {
                const name = info.get_name();
                if (!name.endsWith('.so'))
                    continue;

                const keys = readPluginStyleKeys(GLib.build_filenamev([dir, name]));
                if (keys.length > 0) {
                    for (const k of keys)
                        found.add(k);
                } else {
                    // Metadata scan found nothing — fall back to a filename
                    // guess. Handles both "libfoo.so" and "foo.so" (some
                    // packages, like adwaita-qt's, ship without the "lib" prefix).
                    const m = /^(?:lib)?(.+)\.so$/.exec(name);
                    if (m)
                        found.add(m[1]);
                }
            }
        } catch (e) {
            // unreadable directory, skip it
        }
    }

    return [...found].sort((a, b) => a.localeCompare(b));
}

function makeTimeRow(title, settings, key) {
    const row = new Adw.ActionRow({ title });

    const [h, m] = settings.get_string(key).split(':').map(n => parseInt(n, 10));

    const hourSpin = new Gtk.SpinButton({
        adjustment: new Gtk.Adjustment({ lower: 0, upper: 23, step_increment: 1 }),
        value: isNaN(h) ? 0 : h,
        numeric: true,
        valign: Gtk.Align.CENTER,
    });
    hourSpin.set_wrap(true);

    const colon = new Gtk.Label({ label: ':' });

    const minSpin = new Gtk.SpinButton({
        adjustment: new Gtk.Adjustment({ lower: 0, upper: 59, step_increment: 5 }),
        value: isNaN(m) ? 0 : m,
        numeric: true,
        valign: Gtk.Align.CENTER,
    });
    minSpin.set_wrap(true);

    const commit = () => {
        const hh = String(hourSpin.get_value_as_int()).padStart(2, '0');
        const mm = String(minSpin.get_value_as_int()).padStart(2, '0');
        settings.set_string(key, `${hh}:${mm}`);
    };
    hourSpin.connect('value-changed', commit);
    minSpin.connect('value-changed', commit);

    const box = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 4, valign: Gtk.Align.CENTER });
    box.append(hourSpin);
    box.append(colon);
    box.append(minSpin);

    row.add_suffix(box);
    return row;
}

// Dropdown populated from installed themes/styles. `alwaysInclude` adds
// choices that are valid regardless of detection (e.g. Adwaita, Fusion —
// built into GTK/Qt itself, no folder or plugin file required). `emptyLabel`
// turns an empty-string setting value into an explicit, selectable entry
// (e.g. "(System default)") instead of leaving it invisible in the list.
function makeThemeComboRow(title, settings, key, detected, opts = {}) {
    const { emptyLabel = null, alwaysInclude = [] } = opts;
    const current = settings.get_string(key);

    let choices = [...new Set([...alwaysInclude, ...detected])].sort((a, b) => a.localeCompare(b));
    if (current && !choices.includes(current))
        choices = [...choices, current].sort((a, b) => a.localeCompare(b));

    let displayChoices = choices;
    let currentDisplay = current;
    if (emptyLabel) {
        displayChoices = [emptyLabel, ...choices];
        currentDisplay = current === '' ? emptyLabel : current;
    }
    if (displayChoices.length === 0)
        displayChoices = [_('(none found)')];

    const row = new Adw.ComboRow({
        title,
        model: new Gtk.StringList({ strings: displayChoices }),
    });

    const idx = displayChoices.indexOf(currentDisplay);
    row.set_selected(idx >= 0 ? idx : 0);

    row.connect('notify::selected', () => {
        const item = row.get_selected_item();
        if (!item)
            return;
        const value = item.get_string();
        settings.set_string(key, (emptyLabel && value === emptyLabel) ? '' : value);
    });

    return row;
}

function makeSwitchRow(title, subtitle, settings, key) {
    const row = new Adw.SwitchRow({ title, subtitle });
    settings.bind(key, row, 'active', 0);
    return row;
}

// A small (?) button that opens a popover with a longer explanation.
// Used as a PreferencesGroup header-suffix.
function makeHelpButton(text) {
    const label = new Gtk.Label({
        label: text,
        wrap: true,
        max_width_chars: 42,
        margin_top: 10, margin_bottom: 10, margin_start: 10, margin_end: 10,
        xalign: 0,
    });
    const popover = new Gtk.Popover({ child: label });
    const button = new Gtk.MenuButton({
        icon_name: 'dialog-question-symbolic',
        valign: Gtk.Align.CENTER,
        css_classes: ['flat'],
        tooltip_text: _('What does this control?'),
        popover,
    });
    return button;
}

export default class AutoThemePreferences extends ExtensionPreferences {
    constructor(metadata) {
        super(metadata);
        this.initTranslations();
    }

    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const gtkThemes = listThemes('gtk-3.0');
        const shellThemes = listThemes('gnome-shell');
        const qtStyles = listQtStyles();

        // Everything lives on a single page — no tabs to accidentally click.
        const page = new Adw.PreferencesPage();
        window.add(page);

        const introGroup = new Adw.PreferencesGroup({
            title: _('How this works'),
            description:
                _('GNOME theming is split across a few independent layers, each with its ' +
                'own setting below. Tap the (?) next to a section for details.\n\n' +
                '• GTK3 — older-style apps (Firefox, GIMP, many utilities).\n' +
                '• GTK4 / libadwaita — Files, Settings, Extensions, Tweaks and newer apps; ' +
                'only follows light/dark automatically, styled via a CSS override.\n' +
                '• Shell — the top bar and overview, separate from all app windows.\n' +
                '• Qt5/Qt6 apps — separate settings system entirely; optional support ' +
                'via qt5ct/qt6ct further down.\n' +
                '• Flatpak apps — usually follow along automatically already.'),
        });
        page.add(introGroup);

        const timeGroup = new Adw.PreferencesGroup({
            title: _('Switch times'),
            description: _('When to switch to each theme, in 24-hour time'),
        });
        page.add(timeGroup);
        timeGroup.add(makeTimeRow(_('Switch to light theme at'), settings, 'light-time'));
        timeGroup.add(makeTimeRow(_('Switch to dark theme at'), settings, 'dark-time'));

        const gtkGroup = new Adw.PreferencesGroup({
            title: _('GTK3'),
            description: _('Detected in ~/.themes and /usr/share/themes (folders containing gtk-3.0/)'),
            header_suffix: makeHelpButton(
                _('Applies to GTK3 apps: Firefox, GIMP, and most traditional apps that ' +
                'aren’t built with libadwaita. Set via the gtk-theme gsetting, which ' +
                'points GTK at ~/.themes/<name>/gtk-3.0/.\n\n' +
                'Does NOT affect Files, Settings, Extensions, Tweaks, or other GTK4/' +
                'libadwaita apps — see the libadwaita section below for those.')
            ),
        });
        page.add(gtkGroup);
        gtkGroup.add(makeThemeComboRow(_('Light theme'), settings, 'gtk-light-theme', gtkThemes, { alwaysInclude: ['Adwaita'] }));
        gtkGroup.add(makeThemeComboRow(_('Dark theme'), settings, 'gtk-dark-theme', gtkThemes, { alwaysInclude: ['Adwaita'] }));

        const shellGroup = new Adw.PreferencesGroup({
            title: _('Shell theme'),
            description: _('Detected folders containing gnome-shell/, plus a System default option. Requires the User Themes extension.'),
            header_suffix: makeHelpButton(
                _('This only changes the top bar and the overview (the screen you get by ' +
                'pressing the Super/Windows key) — not the look of your actual apps.\n\n' +
                'It works through another extension called "User Themes." Picking a name ' +
                'here just tells User Themes which theme folder to load.\n\n' +
                '"(System default)" means "don’t use a custom one, just use GNOME’s own ' +
                'built-in look." That’s also why you won’t see "Adwaita" as a pickable ' +
                'name here even though it’s the default — it’s built in, not a folder on ' +
                'disk like other themes are, so pick "(System default)" instead when you ' +
                'want it.\n\n' +
                'If nothing happens when this switches, make sure the "User Themes" ' +
                'extension is installed and turned on.')
            ),
        });
        page.add(shellGroup);
        shellGroup.add(makeThemeComboRow(_('Light shell theme'), settings, 'shell-light-theme', shellThemes, { emptyLabel: _('(System default)') }));
        shellGroup.add(makeThemeComboRow(_('Dark shell theme'), settings, 'shell-dark-theme', shellThemes, { emptyLabel: _('(System default)') }));

        const qtGroup = new Adw.PreferencesGroup({
            title: _('Qt5 / Qt6 style'),
            description: _('For apps built with Qt instead of GTK (e.g. Double Commander). Needs qt5ct/qt6ct installed and set up first.'),
            header_suffix: makeHelpButton(
                _('Some apps are built with a different toolkit called Qt instead of ' +
                'GTK (the one GNOME itself uses), and GNOME’s theme settings can’t reach ' +
                'them at all. To make those switch too, you need a small helper app ' +
                'called qt5ct (for older Qt apps) or qt6ct (for newer ones) installed ' +
                'and already set up — this just tells it which style to use for light ' +
                'and dark mode.\n\n' +
                'Not sure what to pick? "Fusion" always works, since it comes built ' +
                'into Qt itself and needs nothing extra installed.\n\n' +
                'Depending on how qt6ct is set up, already-open apps may switch ' +
                'instantly or may need to be closed and reopened to pick up the change.')
            ),
        });
        page.add(qtGroup);
        qtGroup.add(makeSwitchRow(_('Also switch Qt5/Qt6 style'), null, settings, 'apply-qt-fix'));
        qtGroup.add(makeThemeComboRow(_('Light style'), settings, 'qt-light-style', qtStyles, { alwaysInclude: ['Fusion', 'Windows'] }));
        qtGroup.add(makeThemeComboRow(_('Dark style'), settings, 'qt-dark-style', qtStyles, { alwaysInclude: ['Fusion', 'Windows'] }));

        const fixGroup = new Adw.PreferencesGroup({
            title: _('GTK4 (libadwaita) fix'),
            description: _('Files, Settings, Extensions and Tweaks read theme via ~/.config/gtk-4.0, ' +
                'which most themes only symlink once at install time. This re-links it on every switch.'),
            header_suffix: makeHelpButton(
                _('GTK4/libadwaita apps (Files, Settings, Extensions app, Tweaks, and most ' +
                'newer apps) deliberately don’t support full re-theming — they only ' +
                'follow light/dark mode and an accent color. The one override hook they ' +
                'still read is ~/.config/gtk-4.0/gtk.css and gtk-dark.css.\n\n' +
                'This option re-links those files to your chosen GTK theme’s own gtk-4.0/ ' +
                'output on every switch, and can append custom CSS to them (below) — ' +
                'that’s how libadwaita apps end up looking like your legacy theme instead ' +
                'of stock Adwaita. Some themes don’t ship a gtk-4.0/ folder at all; if so ' +
                'this is skipped harmlessly and apps fall back to stock Adwaita light/dark.')
            ),
        });
        page.add(fixGroup);
        fixGroup.add(makeSwitchRow(_('Re-link GTK4 theme files'), null, settings, 'apply-libadwaita-fix'));
        fixGroup.add(makeSwitchRow(_('Append custom CSS below'), null, settings, 'apply-custom-css'));

        const cssGroup = new Adw.PreferencesGroup({
            title: _('Custom CSS'),
            description: _('Appended once (not duplicated on repeat switches) to gtk.css and gtk-dark.css'),
        });
        page.add(cssGroup);

        const cssBuffer = new Gtk.TextBuffer({ text: settings.get_string('custom-css') });
        const cssView = new Gtk.TextView({
            buffer: cssBuffer,
            monospace: true,
            top_margin: 8, bottom_margin: 8, left_margin: 8, right_margin: 8,
        });
        cssBuffer.connect('changed', () => {
            const [start, end] = cssBuffer.get_bounds();
            settings.set_string('custom-css', cssBuffer.get_text(start, end, true));
        });
        const cssScroll = new Gtk.ScrolledWindow({
            child: cssView,
            min_content_height: 180,
            hscrollbar_policy: Gtk.PolicyType.AUTOMATIC,
            vscrollbar_policy: Gtk.PolicyType.AUTOMATIC,
        });
        const cssRow = new Adw.PreferencesRow({ child: cssScroll, activatable: false });
        cssGroup.add(cssRow);

        const restartGroup = new Adw.PreferencesGroup({
            title: _('App restart'),
            description: _('Some apps cache the old theme/CSS and need restarting to pick up changes'),
        });
        page.add(restartGroup);
        restartGroup.add(makeSwitchRow(_('Restart Nautilus / Settings / Extensions app after switching'), null, settings, 'restart-apps'));
    }
}
