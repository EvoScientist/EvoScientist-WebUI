## Desktop app for Windows

Download `EvoScientist-Setup.exe` below. SHA-256: `{{sha256}}`

The installer is not signed yet, so Windows SmartScreen shows "Windows protected your PC". Choose **More info**, then **Run anyway**. Every new release shows this warning again, and some antivirus tools flag unsigned installers: compare the SHA-256 above first (in PowerShell: `Get-FileHash .\EvoScientist-Setup.exe`).

- The app installs for your Windows user only, without an administrator prompt, into `%LOCALAPPDATA%\Programs\EvoScientist`, with a Start menu entry.
- It needs EvoScientist `{{coreRange}}`. On its first launch it installs EvoScientist {{installVersion}} if none is installed; an older one is offered an update, and for a newer one the app asks you to update the app.
- The app updates itself from this repository's releases: when an update is out, it offers **Download**, then **Restart to update**. Upgrades keep your configuration, keys, conversations, workspaces and the installed EvoScientist.
- Uninstalling the app (Settings > Apps) removes the app only. EvoScientist itself, your settings in `%USERPROFILE%\.config\evoscientist`, your data in `%USERPROFILE%\.evoscientist` and your workspace folder stay.

To remove EvoScientist itself too, as its install guide describes under "Uninstalling", run in PowerShell (the uv the install script uses is not on PATH):

```powershell
$uv = (Get-Content -Raw -Encoding UTF8 -LiteralPath "$env:USERPROFILE\.evoscientist\tools\uv.json" | ConvertFrom-Json).path
& $uv tool uninstall EvoScientist
Remove-Item -Recurse -Force -ErrorAction SilentlyContinue -LiteralPath "$env:USERPROFILE\.evoscientist\tools", "$env:USERPROFILE\.evoscientist\envs"
```

Your settings and data stay in `.config\evoscientist` and `.evoscientist`; delete both for a full removal. Also remove `%USERPROFILE%\.local\bin` from your user PATH, unless other tools live there.

In mainland China, downloads from GitHub, for the installer and for updates, can be slow or fail.
