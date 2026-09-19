import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';

import { parseTime, computeMode, secondsUntilNextBoundary, nowOfDay } from './scheduling.js';
import { applyTheme } from './themeApplier.js';

export default class AutoThemeExtension extends Extension {
    #settings = null;
    #timeoutId = null;
    #settingsChangedIds = null;
    #sleepSignalId = null;

    enable() {
        this.#settings = this.getSettings();

        // Re-check/re-arm when the schedule itself changes
        this.#settingsChangedIds = [
            this.#settings.connect('changed::light-time', () => this.#onScheduleChanged()),
            this.#settings.connect('changed::dark-time', () => this.#onScheduleChanged()),
        ];

        // Listening for logind's wake signal
        try {
            this.#sleepSignalId = Gio.DBus.system.signal_subscribe(
                'org.freedesktop.login1',
                'org.freedesktop.login1.Manager',
                'PrepareForSleep',
                '/org/freedesktop/login1',
                null,
                Gio.DBusSignalFlags.NONE,
                (connection, sender, path, iface, signal, params) => {
                    const [aboutToSleep] = params.deep_unpack();
                    if (!aboutToSleep)
                        this.#onScheduleChanged(); // just woke up
                }
            );
        } catch (e) {
            console.error('auto-theme: could not subscribe to logind sleep signal', e);
        }

        this.#checkAndSwitch();
        this.#scheduleNextSwitch();
    }

    disable() {
        if (this.#timeoutId) {
            GLib.source_remove(this.#timeoutId);
            this.#timeoutId = null;
        }
        if (this.#settingsChangedIds) {
            for (const id of this.#settingsChangedIds)
                this.#settings.disconnect(id);
            this.#settingsChangedIds = null;
        }
        if (this.#sleepSignalId) {
            Gio.DBus.system.signal_unsubscribe(this.#sleepSignalId);
            this.#sleepSignalId = null;
        }
        this.#settings = null;
    }

    // Re-evaluate the schedule and re-arm the timer for the new target time. 
    #onScheduleChanged() {
        this.#checkAndSwitch();
        this.#scheduleNextSwitch();
    }

    // Schedule the next switch   
    #scheduleNextSwitch() {
        if (this.#timeoutId) {
            GLib.source_remove(this.#timeoutId);
            this.#timeoutId = null;
        }

        const sched = this.#getScheduleMinutes();
        if (!sched)
            return;

        const { nowSec } = nowOfDay();
        const seconds = secondsUntilNextBoundary(sched.lightMin, sched.darkMin, nowSec);

        this.#timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, seconds, () => {
            this.#timeoutId = null;
            this.#checkAndSwitch();
            this.#scheduleNextSwitch();
            return GLib.SOURCE_REMOVE;
        });
    }

    // Parse the light/dark time settings 
    #getScheduleMinutes() {
        const lightStr = this.#settings.get_string('light-time');
        const darkStr = this.#settings.get_string('dark-time');
        const lightMin = parseTime(lightStr);
        const darkMin = parseTime(darkStr);

        if (lightMin === null || darkMin === null) {
            console.log(`auto-theme: invalid time setting light="${lightStr}" dark="${darkStr}"`);
            return null;
        }
        return { lightMin, darkMin };
    }

    #checkAndSwitch() {
        const sched = this.#getScheduleMinutes();
        if (!sched)
            return;

        const { nowMin } = nowOfDay();
        const mode = computeMode(sched.lightMin, sched.darkMin, nowMin);

        const lastMode = this.#settings.get_string('last-mode');
        if (mode === lastMode)
            return;

        try {
            applyTheme(this.#settings, mode);
            this.#settings.set_string('last-mode', mode);
        } catch (e) {
            console.error('auto-theme: failed to apply theme', e);
        }
    }
}
