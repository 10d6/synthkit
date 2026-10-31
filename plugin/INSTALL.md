# Installing

This folder has the synth as a plugin (VST3, plus AU on a Mac) and as a
standalone app you can run without a DAW.

## Windows (Ableton Live 11 and other VST3 hosts)

1. Copy the whole `.vst3` folder into
   `C:\Program Files\Common Files\VST3\`
   (Windows asks for administrator permission; that's normal).
2. In Live: **Options → Preferences → Plug-Ins**, turn on
   **Use VST3 Plug-In System Folders**, then click **Rescan**.
3. The synth appears in Live's browser under **Plug-Ins → VST3**, by its
   vendor name.

To update, close Live, replace the `.vst3` folder, and open Live again.

The plugin window uses Microsoft Edge WebView2, which comes with Windows 10
and 11. If the window stays blank, install the "Evergreen" WebView2 runtime
from Microsoft.

## Mac (GarageBand, Logic, Live and others)

1. Copy the `.component` (AU, for GarageBand and Logic) to
   `~/Library/Audio/Plug-Ins/Components/`
   and the `.vst3` (for Live, Reaper and others) to
   `~/Library/Audio/Plug-Ins/VST3/`.
   (In Finder, use **Go → Go to Folder…** and paste the path.)
2. These builds aren't notarised by Apple, so macOS blocks them at first.
   Open **Terminal** and run:

   ```
   xattr -dr com.apple.quarantine ~/Library/Audio/Plug-Ins/Components/*.component ~/Library/Audio/Plug-Ins/VST3/*.vst3
   killall -9 AudioComponentRegistrar
   ```

3. Open GarageBand. The synth is in a software instrument track's
   **Plug-ins → Audio Units Instruments** menu, under its vendor name.

## Linux

Copy the `.vst3` folder to `~/.vst3/`.

## What the plugin keeps where

- **The sound** (every setting, the modulation matrix and shapes) is saved in
  your DAW project, as the same JSON the browser version saves.
- **Your presets**, theme and keyboard settings are shared by every copy of
  the synth on this computer, in
  `%APPDATA%\synthkit\` (Windows) or
  `~/Library/Application Support/synthkit/` (Mac).
- Use **More → Export / Import** to move presets between the browser
  version and the plugin.
