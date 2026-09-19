import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

// Alphabetical sort for dropdown list
export function sortAlpha(strings) {
    return [...strings].sort((a, b) => a.localeCompare(b));
}

// List of theme names that have the marker subdirectory e.g. gtk-4.0     
export function listThemes(markerSubdir) {
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

    return sortAlpha([...found]);
}

// Scan the common plugin install paths across distros/Qt5/Qt6.
function buildQtPluginDirs() {
    const libBases = [
        '/usr/lib', '/usr/lib64', '/usr/local/lib',
        '/usr/lib/x86_64-linux-gnu', '/usr/lib/aarch64-linux-gnu',
    ];
    const qtSubdirs = ['qt5/plugins/styles', 'qt6/plugins/styles', 'qt/plugins/styles'];

    const dirs = [];
    for (const base of libBases) {
        for (const sub of qtSubdirs)
            dirs.push(GLib.build_filenamev([base, sub]));
    }
    return dirs;
}

// Read CBOR (RFC 8949) major type 3 (text string) and major type 4 (array) to get the themes names
function readCborUint(bytes, pos, headerByte, base) {
    const info = headerByte - base;
    if (info <= 23)
        return [info, pos];
    if (info === 24)
        return [bytes[pos], pos + 1];
    if (info === 25)
        return [(bytes[pos] << 8) | bytes[pos + 1], pos + 2];
    return [null, pos]; // longer forms not expected for a short style-name list
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

// Fallback for older, pre-CBOR Qt5 builds that embedded metadata as literal JSON text instead.
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

export function listQtStyles() {
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
                    // Metadata scan found nothing — fall back to a filename guess 
                    const m = /^(?:lib)?(.+)\.so$/.exec(name);
                    if (m)
                        found.add(m[1]);
                }
            }
        } catch (e) {
            // unreadable directory, skip it
        }
    }

    return sortAlpha([...found]);
}
