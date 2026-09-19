import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

const CSS_MARK_BEGIN = '/* --- auto-theme: custom css begin --- */';
const CSS_MARK_END = '/* --- auto-theme: custom css end --- */';

// 
Gio._promisify(Gio.File.prototype, 'load_contents_async', 'load_contents_finish');
Gio._promisify(Gio.File.prototype, 'append_to_async', 'append_to_finish');
Gio._promisify(Gio.OutputStream.prototype, 'write_bytes_async', 'write_bytes_finish');
Gio._promisify(Gio.OutputStream.prototype, 'close_async', 'close_finish');

// Applies the gtk/shell/libadwaita/qt theme for `mode` ('light' or 'dark'),
// reading all the relevant choices from `settings`.
export function applyTheme(settings, mode) {
    const isDark = mode === 'dark';
    const gtkTheme = isDark
        ? settings.get_string('gtk-dark-theme')
        : settings.get_string('gtk-light-theme');
    const shellTheme = isDark
        ? settings.get_string('shell-dark-theme')
        : settings.get_string('shell-light-theme');

    // Core gsettings switches
    const ifaceSettings = new Gio.Settings({ schema_id: 'org.gnome.desktop.interface' });
    ifaceSettings.set_string('color-scheme', isDark ? 'prefer-dark' : 'default');
    ifaceSettings.set_string('gtk-theme', gtkTheme);

    // Shell theme switch
    tryStep(() => trySetUserTheme(shellTheme));

    // libadwaita GTK4 relink + custom CSS
    if (settings.get_boolean('apply-libadwaita-fix'))
        tryStep(() => relinkLibadwaita(settings, gtkTheme));

    // qt5ct and qt6ct style
    let qtStyle = null;
    if (settings.get_boolean('apply-qt-fix')) {
        qtStyle = isDark
            ? settings.get_string('qt-dark-style')
            : settings.get_string('qt-light-style');
        tryStep(() => applyQtStyle(qtStyle));
    }

    const qtNote = qtStyle ? `, qt=${qtStyle}` : '';
    console.log(`auto-theme: switched to ${mode} (gtk=${gtkTheme}, shell=${shellTheme}${qtNote})`);
}

function tryStep(fn) {
    try {
        fn();
    } catch (e) {
        console.error('auto-theme: step failed, continuing with the rest of the switch', e);
    }
}

function trySetUserTheme(shellTheme) {
    const schemaSource = Gio.SettingsSchemaSource.get_default();
    const schema = schemaSource.lookup('org.gnome.shell.extensions.user-theme', true);
    if (!schema) {
        console.log('auto-theme: org.gnome.shell.extensions.user-theme schema not found (is User Themes extension installed/enabled?)');
        return;
    }
    const userThemeSettings = new Gio.Settings({ settings_schema: schema });
    userThemeSettings.set_string('name', shellTheme);
}

// List of base directories where themes are installed
function themeBaseDirs() {
    return [
        GLib.build_filenamev([GLib.get_home_dir(), '.themes']),
        '/usr/share/themes',
        '/usr/local/share/themes',
    ];
}

// Find actual gtk-4.0 folder for gtkTheme
function findGtk4ThemeDir(gtkTheme) {
    for (const base of themeBaseDirs()) {
        const dir = GLib.build_filenamev([base, gtkTheme, 'gtk-4.0']);
        if (Gio.File.new_for_path(dir).query_exists(null))
            return dir;
    }
    return null;
}

function relinkLibadwaita(settings, gtkTheme) {
    const themeDir = findGtk4ThemeDir(gtkTheme);
    if (!themeDir) {
        console.log(`auto-theme: no gtk-4.0 folder found for theme "${gtkTheme}" in ~/.themes, /usr/share/themes, or /usr/local/share/themes`);
        return;
    }

    const home = GLib.get_home_dir();
    const cfgDir = GLib.build_filenamev([home, '.config', 'gtk-4.0']);

    const cfgDirFile = Gio.File.new_for_path(cfgDir);
    if (!cfgDirFile.query_exists(null))
        cfgDirFile.make_directory_with_parents(null);

    const gtkCssPath = GLib.build_filenamev([cfgDir, 'gtk.css']);
    const gtkDarkCssPath = GLib.build_filenamev([cfgDir, 'gtk-dark.css']);

    // Re-point the symlinks fresh at the chosen variant. Track success
    // per file, onyl append custom CSS, when it exist.
    const gtkCssOk = symlink(GLib.build_filenamev([themeDir, 'gtk.css']), gtkCssPath);
    const gtkDarkCssOk = symlink(GLib.build_filenamev([themeDir, 'gtk-dark.css']), gtkDarkCssPath);
    symlink(GLib.build_filenamev([themeDir, 'assets']), GLib.build_filenamev([cfgDir, 'assets']));

    if (settings.get_boolean('apply-custom-css')) {
        const css = settings.get_string('custom-css');
        if (gtkCssOk)
            appendCssOnce(gtkCssPath, css);
        if (gtkDarkCssOk)
            appendCssOnce(gtkDarkCssPath, css);
    }
}

// Create a symbolic link from target to linkPath, return true if successful
function symlink(target, linkPath) {
    const targetFile = Gio.File.new_for_path(target);
    if (!targetFile.query_exists(null)) {
        console.log(`auto-theme: symlink target missing, skipping: ${target}`);
        return false;
    }

    const linkFile = Gio.File.new_for_path(linkPath);
    try {
        if (linkFile.query_exists(null) || isDanglingSymlink(linkPath))
            linkFile.delete(null);
    } catch {
        // ignore, we'll try to create anyway
    }

    try {
        linkFile.make_symbolic_link(target, null);
        return true;
    } catch (e) {
        console.error(`auto-theme: could not symlink ${linkPath} -> ${target}`, e);
        return false;
    }
}

function isDanglingSymlink(path) {
    try {
        const info = Gio.File.new_for_path(path).query_info(
            'standard::is-symlink', Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);
        return info.get_is_symlink();
    } catch {
        return false; // nothing at all there, not even a symlink
    }
}

// Append css to the file
async function appendCssOnce(path, css) {
    const file = Gio.File.new_for_path(path);
    let existing = '';
    try {
        const [ok, contents] = await file.load_contents_async(null);
        if (ok)
            existing = new TextDecoder('utf-8').decode(contents);
    } catch {
        // file may not exist yet - treat as empty
    }

    if (existing.includes(CSS_MARK_BEGIN))
        return; // already applied, don't duplicate

    const block = `\n${CSS_MARK_BEGIN}\n${css}\n${CSS_MARK_END}\n`;
    try {
        const stream = await file.append_to_async(Gio.FileCreateFlags.NONE, GLib.PRIORITY_DEFAULT, null);
        await stream.write_bytes_async(new GLib.Bytes(new TextEncoder().encode(block)), GLib.PRIORITY_DEFAULT, null);
        await stream.close_async(GLib.PRIORITY_DEFAULT, null);
    } catch (e) {
        console.error(`auto-theme: could not append custom css to ${path}`, e);
    }
}

// Writes the style key under Appearance in qt5ct.conf and qt6ct.conf
function applyQtStyle(styleName) {
    if (!styleName)
        return;

    for (const confName of ['qt5ct', 'qt6ct']) {
        const path = GLib.build_filenamev([GLib.get_user_config_dir(), confName, `${confName}.conf`]);
        setKeyFileString(path, 'Appearance', 'style', styleName);
    }
}

function setKeyFileString(path, group, key, value) {
    const file = Gio.File.new_for_path(path);
    if (!file.query_exists(null)) {
        console.log(`auto-theme: ${path} not found, skipping (is qt5ct/qt6ct installed and run at least once?)`);
        return;
    }

    const keyFile = new GLib.KeyFile();
    try {
        keyFile.load_from_file(path, GLib.KeyFileFlags.KEEP_COMMENTS | GLib.KeyFileFlags.KEEP_TRANSLATIONS);
        keyFile.set_string(group, key, value);
        keyFile.save_to_file(path);
    } catch (e) {
        console.error(`auto-theme: could not update ${path}`, e);
    }
}
