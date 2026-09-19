import Gtk from 'gi://Gtk';
import Adw from 'gi://Adw';
import Gio from 'gi://Gio';

import { ExtensionPreferences, gettext as _ } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import { listThemes, listQtStyles, sortAlpha } from './themeDetection.js';
import { makeTimeRow } from './timeRow.js';

// Dropdown from installed themes/styles. 
function makeThemeComboRow(title, settings, key, detected, opts = {}) {
    const { emptyLabel = null, alwaysInclude = [] } = opts;
    const current = settings.get_string(key);

    const choiceSet = new Set([...alwaysInclude, ...detected]);
    if (current)
        choiceSet.add(current);
    const choices = sortAlpha([...choiceSet]);

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

// Popup button with long explanation
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
        const interfaceSettings = new Gio.Settings({ schema_id: 'org.gnome.desktop.interface' });
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
                'own setting below.\n\n' +
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
            description: _('When to switch to each theme'),
        });
        page.add(timeGroup);
        timeGroup.add(makeTimeRow(_('Switch to light theme at'), settings, 'light-time', interfaceSettings));
        timeGroup.add(makeTimeRow(_('Switch to dark theme at'), settings, 'dark-time', interfaceSettings));

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
            description: _('Appended to gtk.css and gtk-dark.css'),
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
    }
}
