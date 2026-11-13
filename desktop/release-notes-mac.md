## Desktop app for macOS

Download `EvoScientist-arm64.dmg` below. SHA-256: `{{sha256}}`

For Macs with Apple silicon, on macOS 13 or later. It does not run on Intel Macs.

Open the dmg, drag EvoScientist into Applications and open it from there. The app is signed and notarized.

- It needs EvoScientist `{{coreRange}}`. On its first launch it installs EvoScientist {{installVersion}} if none is installed, and the install adds a PATH line to your shell profile; an older one is offered an update, and for a newer one the app asks you to update the app.
- Closing the window leaves the app and EvoScientist running, with the icon in the Dock; Quit stops them.
- The app updates itself from this repository's releases: when an update is out, it offers **Download**, then **Restart to update**. Upgrades keep your configuration, keys, conversations, workspaces and the installed EvoScientist.
- The app can't update itself while it runs from the dmg or sits in a folder your account can't change. Move it into Applications, or download the new dmg from [the latest release](https://github.com/EvoScientist/EvoScientist-WebUI/releases/latest) and replace the app.
- Moving the app to the Trash removes the app only. EvoScientist itself, your settings in `~/.config/evoscientist`, your data in `~/.evoscientist` and your workspace folder stay, and so do the app's own folders: `~/Library/Application Support/EvoScientist` (the app's records and the window's browser storage) and `~/Library/Caches/evoscientist-updater` (update downloads).

To remove EvoScientist itself too, follow "Uninstalling" in its [installation guide](https://github.com/EvoScientist/EvoScientist/blob/main/docs/guides/install.md#uninstalling).

In mainland China, downloads from GitHub, for the dmg and for updates, can be slow or fail.
