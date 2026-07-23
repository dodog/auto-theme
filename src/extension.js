import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';

const CSS_MARK_BEGIN = '/* --- auto-theme: custom css begin --- */';
const CSS_MARK_END = '/* --- auto-theme: custom css end --- */';

export default class GnomeThemeAutoExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._timeoutId = null;

        // Only re-check/re-arm when the schedule itself changes — not on
        // every settings write (including our own last-mode bookkeeping,
        // which would otherwise re-trigger this same handler for nothing).
        this._settingsChangedIds = [
            this._settings.connect('changed::light-time', () => this._onScheduleChanged()),
            this._settings.connect('changed::dark-time', () => this._onScheduleChanged()),
        ];

        // GLib timeouts are driven by the monotonic clock, which doesn't
        // advance during system suspend — so a laptop closed overnight
        // would otherwise fire its next switch late by however long it
        // slept. Listening for logind's wake signal catches that.
        this._sleepSignalId = null;
        try {
            this._sleepSignalId = Gio.DBus.system.signal_subscribe(
                'org.freedesktop.login1',
                'org.freedesktop.login1.Manager',
                'PrepareForSleep',
                '/org/freedesktop/login1',
                null,
                Gio.DBusSignalFlags.NONE,
                (connection, sender, path, iface, signal, params) => {
                    const [aboutToSleep] = params.deep_unpack();
                    if (!aboutToSleep)
                        this._onScheduleChanged(); // just woke up
                }
            );
        } catch (e) {
            logError(e, 'auto-theme: could not subscribe to logind sleep signal');
        }

        this._checkAndSwitch();
        this._scheduleNextSwitch();
    }

    disable() {
        if (this._timeoutId) {
            GLib.source_remove(this._timeoutId);
            this._timeoutId = null;
        }
        if (this._settingsChangedIds) {
            for (const id of this._settingsChangedIds)
                this._settings.disconnect(id);
            this._settingsChangedIds = null;
        }
        if (this._sleepSignalId) {
            Gio.DBus.system.signal_unsubscribe(this._sleepSignalId);
            this._sleepSignalId = null;
        }
        this._settings = null;
    }

    // Re-evaluate the schedule right away and re-arm the timer for the new
    // target time. Used both for manual time edits and waking from sleep.
    _onScheduleChanged() {
        this._checkAndSwitch();
        this._scheduleNextSwitch();
    }

    // Instead of polling the clock every N seconds, work out exactly how
    // many seconds remain until the next light/dark boundary and set a
    // single timer for that moment. Nothing runs in between.
    _scheduleNextSwitch() {
        if (this._timeoutId) {
            GLib.source_remove(this._timeoutId);
            this._timeoutId = null;
        }

        const seconds = this._secondsUntilNextBoundary();
        if (seconds === null)
            return;

        this._timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, seconds, () => {
            this._timeoutId = null;
            this._checkAndSwitch();
            this._scheduleNextSwitch();
            return GLib.SOURCE_REMOVE;
        });
    }

    _secondsUntilNextBoundary() {
        const lightStr = this._settings.get_string('light-time');
        const darkStr = this._settings.get_string('dark-time');
        const lightMin = this._parseTime(lightStr);
        const darkMin = this._parseTime(darkStr);

        if (lightMin === null || darkMin === null) {
            log(`auto-theme: invalid time setting light="${lightStr}" dark="${darkStr}"`);
            return null;
        }

        const now = GLib.DateTime.new_now_local();
        const nowSec = now.get_hour() * 3600 + now.get_minute() * 60 + now.get_second();
        const boundaries = [lightMin * 60, darkMin * 60];

        let next = Infinity;
        for (const b of boundaries) {
            let diff = b - nowSec;
            if (diff <= 0)
                diff += 86400; // wrap to the same boundary tomorrow
            next = Math.min(next, diff);
        }

        // +1s buffer so we land just after the boundary rather than a hair before it.
        return next + 1;
    }

    _parseTime(str) {
        const m = /^(\d{1,2}):(\d{2})$/.exec(str.trim());
        if (!m)
            return null;
        const h = parseInt(m[1], 10);
        const min = parseInt(m[2], 10);
        if (h > 23 || min > 59)
            return null;
        return h * 60 + min;
    }

    _computeMode() {
        const lightStr = this._settings.get_string('light-time');
        const darkStr = this._settings.get_string('dark-time');
        const lightMin = this._parseTime(lightStr);
        const darkMin = this._parseTime(darkStr);

        if (lightMin === null || darkMin === null) {
            log(`auto-theme: invalid time setting light="${lightStr}" dark="${darkStr}"`);
            return null;
        }

        const now = GLib.DateTime.new_now_local();
        const nowMin = now.get_hour() * 60 + now.get_minute();

        if (lightMin === darkMin)
            return 'light';

        if (lightMin < darkMin) {
            // Normal same-day window, e.g. light=07:00 dark=19:00
            return (nowMin >= lightMin && nowMin < darkMin) ? 'light' : 'dark';
        } else {
            // Dark window wraps past midnight, e.g. light=07:00 dark=23:30
            // is fine (lightMin<darkMin), but light=22:00 dark=06:00 wraps.
            return (nowMin >= lightMin || nowMin < darkMin) ? 'light' : 'dark';
        }
    }

    _checkAndSwitch() {
        const mode = this._computeMode();
        if (!mode)
            return;

        const lastMode = this._settings.get_string('last-mode');
        if (mode === lastMode)
            return;

        try {
            this._applyTheme(mode);
            this._settings.set_string('last-mode', mode);
        } catch (e) {
            logError(e, 'auto-theme: failed to apply theme');
        }
    }

    _applyTheme(mode) {
        const isDark = mode === 'dark';
        const gtkTheme = isDark
            ? this._settings.get_string('gtk-dark-theme')
            : this._settings.get_string('gtk-light-theme');
        const shellTheme = isDark
            ? this._settings.get_string('shell-dark-theme')
            : this._settings.get_string('shell-light-theme');

        // --- core gsettings switches ---
        const ifaceSettings = new Gio.Settings({ schema_id: 'org.gnome.desktop.interface' });
        ifaceSettings.set_string('color-scheme', isDark ? 'prefer-dark' : 'default');
        ifaceSettings.set_string('gtk-theme', gtkTheme);

        // Each optional step is isolated: a failure in one (e.g. a theme
        // missing its gtk-4.0/ folder) shouldn't stop the others or stop
        // last-mode from being recorded, or the next boundary won't be
        // retried until hours later at the next scheduled switch.
        this._tryStep(() => this._trySetUserTheme(shellTheme));

        // --- libadwaita (GTK4) relink + custom CSS ---
        if (this._settings.get_boolean('apply-libadwaita-fix'))
            this._tryStep(() => this._relinkLibadwaita(gtkTheme));

        // --- qt5ct / qt6ct style ---
        let qtStyle = null;
        if (this._settings.get_boolean('apply-qt-fix')) {
            qtStyle = isDark
                ? this._settings.get_string('qt-dark-style')
                : this._settings.get_string('qt-light-style');
            this._tryStep(() => this._applyQtStyle(qtStyle));
        }

        // --- restart apps that cache the old theme ---
        if (this._settings.get_boolean('restart-apps'))
            this._tryStep(() => this._restartApps());

        const qtNote = qtStyle ? `, qt=${qtStyle}` : '';
        log(`auto-theme: switched to ${mode} (gtk=${gtkTheme}, shell=${shellTheme}${qtNote})`);
    }

    _tryStep(fn) {
        try {
            fn();
        } catch (e) {
            logError(e, 'auto-theme: step failed, continuing with the rest of the switch');
        }
    }

    _trySetUserTheme(shellTheme) {
        const schemaSource = Gio.SettingsSchemaSource.get_default();
        const schema = schemaSource.lookup('org.gnome.shell.extensions.user-theme', true);
        if (!schema) {
            log('auto-theme: org.gnome.shell.extensions.user-theme schema not found (is User Themes extension installed/enabled?)');
            return;
        }
        const userThemeSettings = new Gio.Settings({ settings_schema: schema });
        userThemeSettings.set_string('name', shellTheme);
    }

    _relinkLibadwaita(gtkTheme) {
        const home = GLib.get_home_dir();
        const themeDir = GLib.build_filenamev([home, '.themes', gtkTheme, 'gtk-4.0']);
        const cfgDir = GLib.build_filenamev([home, '.config', 'gtk-4.0']);

        const cfgDirFile = Gio.File.new_for_path(cfgDir);
        if (!cfgDirFile.query_exists(null))
            cfgDirFile.make_directory_with_parents(null);

        const gtkCssPath = GLib.build_filenamev([cfgDir, 'gtk.css']);
        const gtkDarkCssPath = GLib.build_filenamev([cfgDir, 'gtk-dark.css']);

        // Re-point the symlinks fresh at the chosen variant. Track success
        // per file: if a theme has no gtk-4.0/ folder, the symlink is
        // skipped, and appending custom CSS below must be skipped too —
        // otherwise it would land on whatever unrelated file (e.g. a
        // previous theme's, via a stale leftover symlink) already sits there.
        const gtkCssOk = this._symlink(GLib.build_filenamev([themeDir, 'gtk.css']), gtkCssPath);
        const gtkDarkCssOk = this._symlink(GLib.build_filenamev([themeDir, 'gtk-dark.css']), gtkDarkCssPath);
        this._symlink(GLib.build_filenamev([themeDir, 'assets']), GLib.build_filenamev([cfgDir, 'assets']));

        if (this._settings.get_boolean('apply-custom-css')) {
            const css = this._settings.get_string('custom-css');
            if (gtkCssOk)
                this._appendCssOnce(gtkCssPath, css);
            if (gtkDarkCssOk)
                this._appendCssOnce(gtkDarkCssPath, css);
        }
    }

    // Returns true if the symlink now points at `target` (freshly created
    // or already correct), false if it was skipped (target missing) or
    // failed outright.
    _symlink(target, linkPath) {
        const targetFile = Gio.File.new_for_path(target);
        if (!targetFile.query_exists(null)) {
            log(`auto-theme: symlink target missing, skipping: ${target}`);
            return false;
        }

        const linkFile = Gio.File.new_for_path(linkPath);
        try {
            if (linkFile.query_exists(null) || this._isDanglingSymlink(linkPath))
                linkFile.delete(null);
        } catch (e) {
            // ignore, we'll try to create anyway
        }

        try {
            linkFile.make_symbolic_link(target, null);
            return true;
        } catch (e) {
            logError(e, `auto-theme: could not symlink ${linkPath} -> ${target}`);
            return false;
        }
    }

    _isDanglingSymlink(path) {
        try {
            const info = Gio.File.new_for_path(path).query_info(
                'standard::is-symlink', Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);
            return info.get_is_symlink();
        } catch (e) {
            return false; // nothing at all there, not even a symlink
        }
    }

    // Appends `css` to the file (following the symlink into the real theme
    // file, same as the original script) but only once: a marker comment
    // guards against duplicating the block on every switch.
    _appendCssOnce(path, css) {
        const file = Gio.File.new_for_path(path);
        let existing = '';
        try {
            const [ok, contents] = file.load_contents(null);
            if (ok)
                existing = new TextDecoder('utf-8').decode(contents);
        } catch (e) {
            // file may not exist yet (e.g. dangling symlink); treat as empty
        }

        if (existing.includes(CSS_MARK_BEGIN))
            return; // already applied, don't duplicate

        const block = `\n${CSS_MARK_BEGIN}\n${css}\n${CSS_MARK_END}\n`;
        try {
            const stream = file.append_to(Gio.FileCreateFlags.NONE, null);
            stream.write(block, null);
            stream.close(null);
        } catch (e) {
            logError(e, `auto-theme: could not append custom css to ${path}`);
        }
    }

    // Writes the "style" key under [Appearance] in ~/.config/qt5ct/qt5ct.conf
    // and ~/.config/qt6ct/qt6ct.conf — the same file qt5ct/qt6ct's own GUI
    // writes to. Doesn't touch anything else in the file (color scheme,
    // fonts, etc.), and doesn't itself restart any Qt app. If the session
    // has QT_QPA_PLATFORMTHEME=qt5ct (or qt6ct) set, that platform
    // integration watches this config file and applies the change live to
    // already-running apps; otherwise a relaunch is needed to pick it up.
    _applyQtStyle(styleName) {
        if (!styleName)
            return;

        for (const confName of ['qt5ct', 'qt6ct']) {
            const path = GLib.build_filenamev([GLib.get_user_config_dir(), confName, `${confName}.conf`]);
            this._setKeyFileString(path, 'Appearance', 'style', styleName);
        }
    }

    _setKeyFileString(path, group, key, value) {
        const file = Gio.File.new_for_path(path);
        if (!file.query_exists(null)) {
            log(`auto-theme: ${path} not found, skipping (is qt5ct/qt6ct installed and run at least once?)`);
            return;
        }

        const keyFile = new GLib.KeyFile();
        try {
            keyFile.load_from_file(path, GLib.KeyFileFlags.KEEP_COMMENTS | GLib.KeyFileFlags.KEEP_TRANSLATIONS);
            keyFile.set_string(group, key, value);
            keyFile.save_to_file(path);
        } catch (e) {
            logError(e, `auto-theme: could not update ${path}`);
        }
    }

    _restartApps() {
        for (const cmd of [['nautilus', '-q'], ['killall', 'gnome-control-center'], ['killall', 'gnome-extensions-app']]) {
            try {
                GLib.spawn_async(null, cmd, null, GLib.SpawnFlags.SEARCH_PATH, null);
            } catch (e) {
                // app likely wasn't running; ignore
            }
        }
    }
}
