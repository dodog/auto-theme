import Gtk from 'gi://Gtk';
import Adw from 'gi://Adw';
import GLib from 'gi://GLib';
import GDesktopEnums from 'gi://GDesktopEnums';

import { gettext as _ } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

// Converts between 24h and 12h
function hour24ToHour12(hour24) {
    const isPm = hour24 >= 12;
    let hour12 = hour24 % 12;
    if (hour12 === 0)
        hour12 = 12;
    return { hour12, isPm };
}

function hour12ToHour24(hour12, isPm) {
    let hour24 = hour12 % 12;
    if (isPm)
        hour24 += 12;
    return hour24;
}

const pad2 = n => String(n).padStart(2, '0');

// Pads a Gtk.SpinButton's text to two digits
function padTwoDigits(spin) {
    const format = () => spin.set_text(pad2(Math.round(spin.get_value())));
    spin.connect('output', () => {
        format();
        return true;
    });
    format(); // also pad the very first render
}

// Creates a time picker row that follows the system's 12h/24h clock format
export function makeTimeRow(title, settings, key, interfaceSettings) {
    const row = new Adw.ActionRow({ title });

    const [initH, initM] = settings.get_string(key).split(':').map(n => parseInt(n, 10));
    const initHour = isNaN(initH) ? 0 : initH;
    const initMinute = isNaN(initM) ? 0 : initM;

    // --- 24-hour widgets ---
    const hourSpin24 = new Gtk.SpinButton({
        adjustment: new Gtk.Adjustment({ lower: 0, upper: 23, step_increment: 1 }),
        value: initHour, numeric: true, valign: Gtk.Align.CENTER,
    });
    hourSpin24.set_wrap(true);
    const minSpin24 = new Gtk.SpinButton({
        adjustment: new Gtk.Adjustment({ lower: 0, upper: 59, step_increment: 5 }),
        value: initMinute, numeric: true, valign: Gtk.Align.CENTER,
    });
    minSpin24.set_wrap(true);
    padTwoDigits(hourSpin24);
    padTwoDigits(minSpin24);
    const box24 = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 4, valign: Gtk.Align.CENTER });
    box24.append(hourSpin24);
    box24.append(new Gtk.Label({ label: ':' }));
    box24.append(minSpin24);

    // 12-hour widgets
    const { hour12: initHour12, isPm: initIsPm } = hour24ToHour12(initHour);
    const hourSpin12 = new Gtk.SpinButton({
        adjustment: new Gtk.Adjustment({ lower: 1, upper: 12, step_increment: 1 }),
        value: initHour12, numeric: true, valign: Gtk.Align.CENTER,
    });
    hourSpin12.set_wrap(true);
    const minSpin12 = new Gtk.SpinButton({
        adjustment: new Gtk.Adjustment({ lower: 0, upper: 59, step_increment: 5 }),
        value: initMinute, numeric: true, valign: Gtk.Align.CENTER,
    });
    minSpin12.set_wrap(true);
    padTwoDigits(minSpin12);
    const amButton = new Gtk.ToggleButton({ label: _('AM'), active: !initIsPm, valign: Gtk.Align.CENTER });
    const pmButton = new Gtk.ToggleButton({ label: _('PM'), active: initIsPm, valign: Gtk.Align.CENTER, group: amButton });
    const box12 = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 4, valign: Gtk.Align.CENTER });
    box12.append(hourSpin12);
    box12.append(new Gtk.Label({ label: ':' }));
    box12.append(minSpin12);
    box12.append(amButton);
    box12.append(pmButton);

    const stack = new Gtk.Stack({ valign: Gtk.Align.CENTER });
    stack.add_named(box24, '24h');
    stack.add_named(box12, '12h');

    // Syncs the widgets to the settings, and vice versa. 
    let syncing = false;

    const refreshFromSettings = () => {
        syncing = true;
        const [hh, mm] = settings.get_string(key).split(':').map(n => parseInt(n, 10));
        const hour = isNaN(hh) ? 0 : hh;
        const minute = isNaN(mm) ? 0 : mm;

        hourSpin24.set_value(hour);
        minSpin24.set_value(minute);

        const { hour12, isPm } = hour24ToHour12(hour);
        hourSpin12.set_value(hour12);
        minSpin12.set_value(minute);
        (isPm ? pmButton : amButton).set_active(true);
        syncing = false;
    };

    // Schedule a refresh of the widgets on the next idle loop, to avoid multiple rapid updates
    let refreshIdleId = 0;
    const scheduleRefresh = () => {
        if (refreshIdleId)
            return;
        refreshIdleId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            refreshIdleId = 0;
            refreshFromSettings();
            return GLib.SOURCE_REMOVE;
        });
    };

    const commit24 = () => {
        if (syncing)
            return;
        const hh = pad2(hourSpin24.get_value_as_int());
        const mm = pad2(minSpin24.get_value_as_int());
        settings.set_string(key, `${hh}:${mm}`);
        scheduleRefresh();
    };
    const commit12 = () => {
        if (syncing)
            return;
        const hour24 = hour12ToHour24(hourSpin12.get_value_as_int(), pmButton.get_active());
        const hh = pad2(hour24);
        const mm = pad2(minSpin12.get_value_as_int());
        settings.set_string(key, `${hh}:${mm}`);
        scheduleRefresh();
    };

    hourSpin24.connect('value-changed', commit24);
    minSpin24.connect('value-changed', commit24);
    hourSpin12.connect('value-changed', commit12);
    minSpin12.connect('value-changed', commit12);
    pmButton.connect('toggled', commit12);

    const applyClockFormat = () => {
        const is12h = interfaceSettings.get_enum('clock-format') === GDesktopEnums.ClockFormat['12H'];
        stack.set_visible_child_name(is12h ? '12h' : '24h');
        refreshFromSettings();
    };
    applyClockFormat();
    interfaceSettings.connect('changed::clock-format', applyClockFormat);

    row.add_suffix(stack);
    return row;
}
