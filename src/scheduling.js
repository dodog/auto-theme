import GLib from 'gi://GLib';

// Parses a "HH:MM" string into minutes since midnight
export function parseTime(str) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(str.trim());
    if (!m)
        return null;
    const h = parseInt(m[1], 10);
    const min = parseInt(m[2], 10);
    if (h > 23 || min > 59)
        return null;
    return h * 60 + min;
}

// Returns 'light' or 'dark' for the given schedule and current minute-of-day.
export function computeMode(lightMin, darkMin, nowMin) {
    if (lightMin === darkMin)
        return 'light';

    if (lightMin < darkMin) {
        // Normal same-day window, e.g. light=07:00 dark=19:00
        return (nowMin >= lightMin && nowMin < darkMin) ? 'light' : 'dark';
    } else {
        // Dark window wraps past midnight
        return (nowMin >= lightMin || nowMin < darkMin) ? 'light' : 'dark';
    }
}

// Seconds from now until the next light/dark boundary is crossed.
// nowSec (seconds-of-day)
export function secondsUntilNextBoundary(lightMin, darkMin, nowSec) {
    const boundaries = [lightMin * 60, darkMin * 60];

    let next = Infinity;
    for (const b of boundaries) {
        let diff = b - nowSec;
        if (diff <= 0)
            diff += 86400; // wrap to the same boundary tomorrow
        next = Math.min(next, diff);
    }

    // +1s buffer
    return next + 1;
}

// Current local time as minute-of-day and second-of-day
export function nowOfDay() {
    const now = GLib.DateTime.new_now_local();
    const nowSec = now.get_hour() * 3600 + now.get_minute() * 60 + now.get_second();
    const nowMin = now.get_hour() * 60 + now.get_minute();
    return { nowMin, nowSec };
}
