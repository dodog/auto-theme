# Auto Theme Switcher

A GNOME Shell extension that switches your GTK, Shell, and (optionally) Qt
theme between a light and dark variant on a schedule you set — light in the
morning, dark in the evening, no manual toggling.

It replaces the usual combo of a cron job / shell script plus one or two
theme-switcher extensions with a single, self-contained extension: pick your
times and themes in a normal Settings-style preferences window, and it
handles the rest — including the GTK4/libadwaita quirks that most simple
"switch gsettings" scripts miss.

## Why this exists

GNOME theming is split across several independent systems that don't talk to
each other (see [How theming works](#how-theming-works-on-gnome) below), so
"switch to dark mode" in practice means touching four or five different
settings, re-linking a config directory, and restarting a couple of apps.
This extension does all of that in one place, on a timer, so you don't have
to.

## Features

- **Exact scheduling, no polling loop.** You pick a light-time and a
  dark-time (HH:MM); the extension computes exactly how many seconds until
  the next boundary and sets a single timer for that moment - nothing runs
  in the background in between.
- **GTK3 / legacy theme switching** - sets `gtk-theme` and `color-scheme` via
  gsettings, with the theme name picked from a dropdown of what's actually
  installed under `~/.themes` and `/usr/share/themes`.
- **GNOME Shell theme switching** - sets the Shell theme via the
  [User Themes](https://extensions.gnome.org/extension/19/user-themes/)
  extension, same dropdown-detection approach.
- **GTK4 / libadwaita fix.** Files, Settings, the Extensions app, Tweaks, and
  most newer apps only follow light/dark automatically and ignore
  `gtk-theme` entirely. This extension re-links
  `~/.config/gtk-4.0/{gtk.css,gtk-dark.css,assets}` to your chosen theme's
  own `gtk-4.0/` output on every switch, so those apps pick up your actual
  theme instead of falling back to stock Adwaita.
- **Custom CSS injection, done idempotently.** Append your own CSS (e.g. a
  Nautilus sidebar spacing fix) to the libadwaita theme files. A marker
  comment prevents it from being duplicated on every single switch - a
  common bug in simple switcher scripts, where the block silently grows the
  underlying theme file forever.
- **Optional Qt5/Qt6 style switching.** If you use `qt5ct`/`qt6ct`, the
  extension can write the `style=` value straight into `qt5ct.conf` /
  `qt6ct.conf` on each switch (dropdown populated from detected style
  plugins, plus the always-available `Fusion`/`Windows`). If your session
  has `QT_QPA_PLATFORMTHEME=qt5ct` (or `qt6ct`) set, its platform
  integration watches that config file and applies the change live to
  already-running Qt apps — no restart needed. Without that integration
  active, an app just keeps its old style until relaunched.
- **Optional app restart.** Nautilus, `gnome-control-center`, and the
  Extensions app all cache the old theme; the extension can quit them after
  a switch so the change is visible immediately instead of on next launch.
- **Built-in explanations.** Every section in the preferences window has a
  `(?)` button with a plain-language explanation of what it controls and
  what it doesn't - useful since "GTK3 vs GTK4/libadwaita vs Shell vs Qt" is
  genuinely confusing the first time around.

## How theming works on GNOME

If you're new to this, here's the short version of why GNOME theming needs
four different settings instead of one:

| Layer | Covers | Set via |
|---|---|---|
| **GTK3 / legacy** | Firefox, GIMP, most traditional apps | `gtk-theme` gsetting \u2192 `~/.themes/<name>/gtk-3.0/` |
| **GTK4 / libadwaita** | Files, Settings, Extensions app, Tweaks, most newer apps | Only follows light/dark + accent color automatically. The one override hook is `~/.config/gtk-4.0/gtk.css` / `gtk-dark.css` |
| **GNOME Shell** | Top bar, overview, quick settings - not app windows | User Themes extension's `name` setting \u2192 `~/.themes/<name>/gnome-shell/` |
| **Qt5 / Qt6** | Qt apps (e.g. Double Commander) | Entirely separate from GNOME; needs `qt5ct`/`qt6ct` as a bridge |
| **Flatpak** | Sandboxed apps | GTK4 apps follow the desktop portal automatically; GTK3 apps need `flatpak override --filesystem=~/.themes` or a Flatpak theme extension |

libadwaita apps deliberately dropped support for full re-theming - they only
expose light/dark + an accent color - which is why "my theme doesn't apply
to Settings/Files" is such a common complaint. The `gtk-4.0/gtk.css` override
hook is the one door left open, and it's what the libadwaita fix in this
extension uses.

## Requirements

- GNOME Shell 45 or newer (uses the ESM extension format introduced in 45).
  If you're on a version not listed in `metadata.json`'s `shell-version`,
  add it there - the code itself doesn't use anything version-specific
  beyond that format.
- A GTK theme with both a `gtk-3.0/` and (ideally) `gtk-4.0/` folder under
  `~/.themes/<name>/` or `/usr/share/themes/<name>/`.
- For Shell theme switching: the
  [User Themes](https://extensions.gnome.org/extension/19/user-themes/)
  extension, installed and enabled.
- For Qt style switching (optional): `qt5ct` and/or `qt6ct`, already set up
  and run at least once.

If you have other automatic theme switchers installed (Night Theme Switcher,
legacy-theme-auto-switcher, etc.), disable them first - multiple extensions
writing the same gsettings keys on independent timers will fight each other.

## Installation

### From a release archive

```bash
mkdir -p ~/.local/share/gnome-shell/extensions
cd ~/.local/share/gnome-shell/extensions
unzip auto-theme@dodog.github.com.zip
glib-compile-schemas auto-theme@dodog.github.com/schemas/
```

### From source

```bash
git clone https://github.com/dodog/auto-theme.git
mkdir -p ~/.local/share/gnome-shell/extensions
cp -r auto-theme/auto-theme@dodog.github.com ~/.local/share/gnome-shell/extensions/
glib-compile-schemas ~/.local/share/gnome-shell/extensions/auto-theme@dodog.github.com/schemas/
```

Then reload GNOME Shell - log out/in on Wayland (required for loading a new
extension), or on X11, `Alt`+`F2` \u2192 `r` \u2192 `Enter`. Finally:

```bash
gnome-extensions enable auto-theme@dodog.github.com
gnome-extensions prefs auto-theme@dodog.github.com
```

## Configuration

Everything is in one preferences window, no tabs:

1. **Switch times** - pick light/dark times with the hour/minute spinners.
2. **GTK / legacy theme** - pick your GTK3 theme for each mode from the
   detected list.
3. **Shell theme** - pick your Shell theme for each mode (requires User
   Themes).
4. **Qt5 / Qt6 style** - optional; turn on and pick a style per mode if you
   use qt5ct/qt6ct.
5. **libadwaita (GTK4) fix** - toggle the config re-link and/or the custom
   CSS append.
6. **Custom CSS** - edit the CSS block that gets appended to the GTK4 theme
   files (defaults to a Nautilus sidebar spacing fix; clear it if your theme
   doesn't need it).
7. **App restart** - toggle whether Nautilus/Settings/Extensions app get
   quit after a switch.

Every `(?)` button opens a short explanation of exactly what that section
touches.

## Troubleshooting

Watch the log while testing:

```bash
journalctl --user -f -o cat /usr/bin/gnome-shell | grep auto-theme
```

A successful switch logs a line like:

```
auto-theme: switched to dark (gtk=Orchis-Dark, shell=Orchis-Dark)
```

Other messages worth knowing:

- `org.gnome.shell.extensions.user-theme schema not found` - the User
  Themes extension isn't installed/enabled; Shell theme switching is
  skipped.
- `symlink target missing, skipping: ...` - the chosen GTK theme doesn't
  ship a `gtk-4.0/` folder; the libadwaita fix is skipped for it, apps fall
  back to stock Adwaita light/dark.
- `<path> not found, skipping` (Qt) - qt5ct/qt6ct hasn't been run yet, so
  its config file doesn't exist.

If prefs won't open after a GNOME upgrade with an `ImportError` mentioning
`prefs.js`, GNOME may have moved the internal resource path again - check
that `resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js` still
exists for your version and adjust the import in `prefs.js` if not.

## Known limitations

- Qt style switching applies live to running apps if your session has
  `QT_QPA_PLATFORMTHEME=qt5ct`/`qt6ct` set (that platform integration watches
  its own config file). Without it active, an app keeps its old style until
  relaunched.
- Qt style plugin detection is a best-effort scan of common plugin
  directories; if your style isn't auto-detected, whatever you already have
  set stays selectable regardless.
- Flatpak sandboxing and Qt/GNOME bridging (`qt5ct`, `flatpak override`)
  are one-time system setup, not something this extension manages.

## Contributing

Issues and PRs welcome. This started as a personal shell script
(`auto-theme.sh`) rebuilt as a proper extension after two existing
switcher extensions - [Night Theme
Switcher](https://gitlab.com/rmnvgr/nightthemeswitcher-gnome-shell-extension)
and
[legacy-theme-auto-switcher](https://github.com/mukul29/legacy-theme-auto-switcher-gnome-extension)
- didn't reliably cover the GTK4/libadwaita + Qt side of things together.

## License

MIT - see `LICENSE`.
