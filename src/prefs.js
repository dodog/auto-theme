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

    return [...found].sort();
}

// Qt styles aren't folders like GTK/Shell themes — they're compiled plugin
// files, plus two built-ins (Fusion, Windows) that ship inside Qt itself
// and need no plugin at all. Scans the common plugin install paths for
// installed style plugins across distros/Qt5/Qt6.
function listQtStyles() {
    const pluginDirs = [
        '/usr/lib/qt5/plugins/styles',
        '/usr/lib/qt6/plugins/styles',
        '/usr/lib64/qt5/plugins/styles',
        '/usr/lib64/qt6/plugins/styles',
        '/usr/lib/x86_64-linux-gnu/qt5/plugins/styles',
        '/usr/lib/x86_64-linux-gnu/qt6/plugins/styles',
    ];
    const found = new Set(['Fusion', 'Windows']);

    for (const dir of pluginDirs) {
        const dirFile = Gio.File.new_for_path(dir);
        if (!dirFile.query_exists(null))
            continue;
        try {
            const it = dirFile.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
            let info;
            while ((info = it.next_file(null)) !== null) {
                const m = /^lib(.+)\.so$/.exec(info.get_name());
                if (m)
                    found.add(m[1]);
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

// Dropdown populated from installed themes. If the currently-configured
// name isn't among the detected ones (custom install path, typo, etc.)
// it's kept in the list anyway so the row doesn't silently change your setting.
function makeThemeComboRow(title, settings, key, detected) {
    const current = settings.get_string(key);
    let choices = detected;
    if (current && !choices.includes(current))
        choices = [...choices, current].sort();
    if (choices.length === 0)
        choices = current ? [current] : [_('(none found)')];

    const row = new Adw.ComboRow({
        title,
        model: new Gtk.StringList({ strings: choices }),
    });

    const idx = choices.indexOf(current);
    row.set_selected(idx >= 0 ? idx : 0);

    row.connect('notify::selected', () => {
        const item = row.get_selected_item();
        if (item)
            settings.set_string(key, item.get_string());
    });

    return row;
}

function makeSwitchRow(title, subtitle, settings, key) {
    const row = new Adw.SwitchRow({ title, subtitle });
    settings.bind(key, row, 'active', 0);
    return row;
}

// A small (?) button that opens a popover with a longer explanation.
// Used as a PreferencesGroup header-suffix so the short description stays
// short but more detail is one click away.
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
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const gtkThemes = listThemes('gtk-3.0');
        const shellThemes = listThemes('gnome-shell');
        const qtStyles = listQtStyles();

        // Everything lives on a single page now — no tabs to accidentally click.
        const page = new Adw.PreferencesPage();
        window.add(page);

        const introGroup = new Adw.PreferencesGroup({
            title: _('How this works'),
            description:
                _('GNOME theming is split across a few independent layers, each with its ' +
                'own setting below. Tap the (?) next to a section for details.\n\n' +
                '• GTK3 / legacy — older-style apps (Firefox, GIMP, many utilities).\n' +
                '• GTK4 / libadwaita — Files, Settings, Extensions, Tweaks and newer apps; ' +
                'only follows light/dark automatically, styled via a CSS override.\n' +
                '• Shell — the top bar and overview, separate from all app windows.\n' +
                '• Qt5/Qt6 apps — separate settings system entirely; optional support ' +
                'via qt5ct/qt6ct further down.'),
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
            title: _('GTK / legacy theme'),
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
        gtkGroup.add(makeThemeComboRow(_('Light theme'), settings, 'gtk-light-theme', gtkThemes));
        gtkGroup.add(makeThemeComboRow(_('Dark theme'), settings, 'gtk-dark-theme', gtkThemes));

        const shellGroup = new Adw.PreferencesGroup({
            title: _('Shell theme'),
            description: _('Detected folders containing gnome-shell/. Requires the User Themes extension.'),
            header_suffix: makeHelpButton(
                _('Applies only to the GNOME Shell top bar, overview, and quick settings — ' +
                'not to any application window. Set via the User Themes extension’s ' +
                '"name" setting, which loads ~/.themes/<name>/gnome-shell/gnome-shell.css.\n\n' +
                'If the User Themes extension isn’t installed/enabled, this setting is ' +
                'silently skipped (check the journal for a message about it).')
            ),
        });
        page.add(shellGroup);
        shellGroup.add(makeThemeComboRow(_('Light shell theme'), settings, 'shell-light-theme', shellThemes));
        shellGroup.add(makeThemeComboRow(_('Dark shell theme'), settings, 'shell-dark-theme', shellThemes));

        const qtGroup = new Adw.PreferencesGroup({
            title: _('Qt5 / Qt6 style'),
            description: _('Detected style plugins, plus the built-in Fusion/Windows. Requires qt5ct/qt6ct already configured.'),
            header_suffix: makeHelpButton(
                _('GNOME settings and gsettings mean nothing to Qt apps — this is a ' +
                'completely separate settings system. qt5ct/qt6ct are the standard way ' +
                'to bridge that: they store the current Qt style in qt5ct.conf/qt6ct.conf, ' +
                'which this writes directly, the same file qt5ct’s own GUI edits.\n\n' +
                'The list is built from installed style plugins under /usr/lib*/qt{5,6}/' +
                'plugins/styles, plus Fusion and Windows which are always available. If a ' +
                'style you use (e.g. kvantum) isn’t detected, the currently-set value is ' +
                'kept in the list regardless.\n\n' +
                'If your session has QT_QPA_PLATFORMTHEME=qt5ct (or qt6ct) set, its ' +
                'platform integration watches this config file and applies the change ' +
                'live to already-running Qt apps — no restart needed. Without that ' +
                'integration active, an app just keeps its old style until relaunched.\n\n' +
                'Flatpak GTK4/libadwaita apps already follow light/dark automatically via ' +
                'the desktop portal. Flatpak GTK3 apps need either a matching Flatpak theme ' +
                'extension or "flatpak override --filesystem=~/.themes" to pick up your ' +
                'legacy theme — neither is handled here, both are one-time setup.')
            ),
        });
        page.add(qtGroup);
        qtGroup.add(makeSwitchRow(_('Also switch Qt5/Qt6 style'), null, settings, 'apply-qt-fix'));
        qtGroup.add(makeThemeComboRow(_('Light style'), settings, 'qt-light-style', qtStyles));
        qtGroup.add(makeThemeComboRow(_('Dark style'), settings, 'qt-dark-style', qtStyles));

        const fixGroup = new Adw.PreferencesGroup({
            title: _('libadwaita (GTK4) fix'),
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
