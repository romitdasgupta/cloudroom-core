# Build and install your own Cloudroom

This builds the desktop app from your checkout, with your changes (such as [several own Cores](own-cores.md)), and installs it on your computers. Your Cores need no rebuild for app changes; see [your Cores](#your-cores).

Paths below are relative to `gui/`. `D` means `gui/apps/desktop`. Install pnpm 9.15.9 globally (`npm install -g pnpm@9.15.9`). With only `npx --yes pnpm@9.15.9`, run packaging through `pnpm run …` as shown below: electron-builder starts a bare `pnpm` and fails with `spawn pnpm ENOENT` if none is on your `PATH`.

## Quickest: install a release

[GitHub Actions](#build-in-github-actions) builds all three apps and publishes them under your repository's **Releases** (for example `desktop-v1003`).

- **macOS (Apple Silicon):**
  1. Quit Cloudroom.
  2. Clear any pending official update (step 2 of [Install](#install)).
  3. Open `Cloudroom-vN-arm64.dmg` and drag Cloudroom to Applications.
  4. Run `xattr -dr com.apple.quarantine /Applications/Cloudroom.app`.
- **Linux x64:** download `Cloudroom-vN-x86_64.AppImage` and see [Linux](#linux-x64).
- **Windows x64:** run `Cloudroom-vN-x64.exe` and click through SmartScreen (**More info → Run anyway**).

Each build replaces the official app and uses its data. Read [where your build keeps data](#where-your-build-keeps-data) first. The corner of the window shows your version (`v1000` plus the build number).

## What builds where

You can't cross-build. Packaging loads the native modules in the packaged Electron and stops with "Packaged npm verification requires a native target host" if the target OS or CPU differs from the build computer's.

| App | Build on | You get, in `D/release.noindex/` | Bundled |
|---|---|---|---|
| macOS 13+, Apple Silicon | an Apple Silicon Mac | `Cloudroom-vN-arm64.dmg`, `.zip`, `mac-arm64/Cloudroom.app` | Python 3.12, Git |
| Linux x64 | Linux x64 with glibc | `Cloudroom-vN-x86_64.AppImage`, `linux-unpacked/` | nothing: the computer needs `python3` 3.11+ and `git` |
| Windows 10/11 x64 | Windows x64 | `Cloudroom-vN-x64.exe` (per-user installer), `win-unpacked\Cloudroom.exe` | Python. Install Git for Windows |

There are no Intel Mac or Linux arm64 builds. Or skip local builds: [GitHub Actions](#build-in-github-actions) builds all three.

## Prerequisites

- Git, Node.js 22.19+ (`gui/.nvmrc`; CI uses 22.19.0, and Node 26.12 built the macOS app), pnpm 9.15.9, and network access. The Mac and Windows builds download pinned Python and Git and check their SHA-256.
- macOS: Xcode Command Line Tools. Any `python3` can build the app, including Xcode's 3.9.
- Linux: `sudo apt-get install -y git python3 make g++`.
- Windows: Git for Windows.

```sh
git clone -b YOUR_BRANCH https://github.com/YOUR_USER/cloudroom-core.git
cd cloudroom-core/gui
pnpm install --frozen-lockfile
```

`pnpm install` may print `Failed to create bin … ENOENT` warnings. They are harmless. On Windows, install with the [Windows steps](#windows-x64) instead.

## Point updates at your own releases

Do this for every build. If you don't, the official app replaces your build within minutes.

How updates work:
- A packaged app checks for updates every 5 minutes. When it finds one, it downloads it in the background, then installs it when you quit. On macOS it also installs while the computer is idle and no local thread is running. Nothing at runtime turns this off (`D/src/desktop-auto-update.ts`, `shouldEnableDesktopAutoUpdate`).
- The feed is `BB_DESKTOP_UPDATE_BASE_URL`. If it is unset or empty, the feed is the official releases (`D/src/desktop-update-provider.ts`). `D/scripts/build.mjs` bakes the value into the app at build time, and the app hands it to electron-updater when it starts (`D/src/desktop-auto-update.ts`). Linux, Windows, and signed macOS builds also get an `app-update.yml` with the same URL. `--ad-hoc` macOS builds get none and don't need one (`D/scripts/run-electron-builder.mjs`). The environment variable is never read while the app runs.
- If the official app replaces yours, you lose your changes. It also rejects a `cloudroom.json` that lists `machines` ([own-cores.md](own-cores.md#saved-state)).

Export the variable before the build step:

```sh
export BB_DESKTOP_UPDATE_BASE_URL=https://github.com/YOUR_USER/cloudroom-core/releases/latest/download/
```

PowerShell: `$env:BB_DESKTOP_UPDATE_BASE_URL = "https://github.com/YOUR_USER/cloudroom-core/releases/latest/download/"`.

After `pnpm run build`, check it: `grep 'CLOUDROOM_UPDATE_BASE_URL = ' D/dist/main.js` must show your URL.

Your releases contain no update feed (`latest-mac.yml`, `latest.yml`, `latest-linux.yml`, `desktop-version*.json`). The update check finds nothing and logs the error, so your build never updates itself. To update, build and install again. Self-updating from your own feed is not set up or tested. On macOS it would also need every build signed with the same Developer ID.

Versions: each local packaging run changes the ignored file `D/.cloudroom-version` from `vN` to `vN+1`. A fresh checkout builds `v1`, and the app's version is `N.0.0`. CI builds are `v1001` and up.

## macOS

### Build

On an Apple Silicon Mac, from `gui/`:

```sh
cd apps/desktop
export BB_DESKTOP_UPDATE_BASE_URL=https://github.com/YOUR_USER/cloudroom-core/releases/latest/download/
pnpm run dist --ad-hoc
grep 'CLOUDROOM_UPDATE_BASE_URL = ' dist/main.js
```

`dist` builds the runtime, bumps the version, builds the app with the version stamped in, and packages the DMG, ZIP, and `.app`. pnpm passes `--ad-hoc` to the packaging step. This takes about 3 minutes. For only the `.app`, run `pnpm run package --ad-hoc` (about 1 minute). If the grep doesn't show your URL, set the variable and build again.

Keep `--ad-hoc` unless you have a Developer ID. Without a signing identity in your keychain, the default build is unsigned. macOS tracks unsigned apps and can slow every process launch system-wide (`D/README.md`), and `install:macos` refuses unsigned apps. `--ad-hoc` signs without an Apple account and skips notarization.

Output, in `release.noindex/`: `mac-arm64/Cloudroom.app`, `Cloudroom-vN-arm64.dmg`, `Cloudroom-vN-arm64.zip`. Older `vN` files stay there, so use the newest. Unless you build with `BB_DESKTOP_RELEASE_CHANNEL=nightly`, the app is `Cloudroom.app` with bundle id `dev.cloudroom.gui`, ad-hoc signed, for macOS 13+. It bundles Python 3.12 and Git.

### Install

1. Quit Cloudroom fully (Cloudroom → Quit).
2. If an earlier build ran without your update URL, it may have already downloaded the official app. Delete what it downloaded:
   ```sh
   rm -rf ~/Library/Caches/@cloudroomdesktop-updater/pending ~/Library/Caches/dev.cloudroom.gui.ShipIt
   ```
3. Install, from `D`:
   ```sh
   node scripts/install-macos.mjs --check
   node scripts/install-macos.mjs
   ```
   It copies `release.noindex/mac-arm64/Cloudroom.app` to `/Applications/Cloudroom.app`, but only if all of these hold:
   - the bundle id is `dev.cloudroom.gui`,
   - `codesign --verify --deep --strict` passes,
   - the app isn't running,
   - the packaged database migrations match the installed app's.

   It zips the old app into `~/Library/Application Support/Cloudroom/installer-backups.noindex/` first. It never launches the app or touches your data. You can also open the `.dmg` and drag Cloudroom to Applications.

   The installer runs `codesign --verify` on the app that is already in `/Applications` as well. An older unsigned local build fails that check, for example with `code has no resources but signature indicates they must be present`. If so, move the old app out and run the installer again (with no app installed, it skips the migration check):
   ```sh
   ditto -c -k --keepParent /Applications/Cloudroom.app ~/Cloudroom-old.zip && rm -rf /Applications/Cloudroom.app
   ```

On your other Macs, copy the `.dmg`, open it, and drag Cloudroom to Applications. Quit Cloudroom there first.

Gatekeeper:
- An app built on this Mac opens normally.
- A build that arrived by browser, AirDrop, or Messages (for example, a CI release) is quarantined, and macOS calls it damaged or from an unidentified developer. After installing, run `xattr -dr com.apple.quarantine /Applications/Cloudroom.app`, or click **Open Anyway** in System Settings → Privacy & Security.
- `scp` and `rsync` don't quarantine. Another Mac needs no Node, Python, or Git.

### Sign and notarize (optional)

You need an Apple Developer ID Application certificate. Use either:
- **Keychain.** Put the certificate in your login keychain. Run `xcrun notarytool store-credentials cloudroom-notary --apple-id APPLE_ID --team-id TEAM_ID --password APP_SPECIFIC_PASSWORD` once, then `export APPLE_KEYCHAIN_PROFILE=cloudroom-notary`.
- **Environment.** Set all five of `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, and `APPLE_TEAM_ID`. If only some are set, the build fails.

Then build as above without `--ad-hoc`. `D/scripts/notarize.cjs` notarizes and staples the app, and then the DMGs. Keep these values out of the repo. This path was not tested for this guide.

## Linux x64

On a Linux x64 computer, from `gui/`, after [setting the update URL](#point-updates-at-your-own-releases):

```sh
cd apps/desktop
pnpm run dist:linux
grep 'CLOUDROOM_UPDATE_BASE_URL = ' dist/main.js
```

`dist:linux` runs the same steps as the macOS `dist`, for Linux. `pnpm run package:linux` builds only `linux-unpacked/`. These commands were not run on Linux for this guide. CI packages Linux the same way (`.github/workflows/desktop.yml`) and passes. Output, in `release.noindex/`: `Cloudroom-vN-x86_64.AppImage`, `latest-linux.yml`, and `linux-unpacked/`. The AppImage is unsigned.

Install:

```sh
mkdir -p ~/Applications
cp "$(ls -t release.noindex/*.AppImage | head -1)" ~/Applications/Cloudroom.AppImage
chmod +x ~/Applications/Cloudroom.AppImage
~/Applications/Cloudroom.AppImage
```

- AppImages need FUSE. Install `libfuse2` (`libfuse2t64` on Ubuntu 24.04), or run the AppImage with `--appimage-extract-and-run`.
- Install `git` and `python3` 3.11+ on the computer. The app runs its preview and sync helpers with the system `python3`.
- The AppImage runs only on distributions with the same or a newer glibc than the build computer. CI builds on Ubuntu 24.04.
- Unverified: Ubuntu 24.04 can block unprivileged user namespaces with AppArmor, which stops some Electron AppImages with a sandbox error.

## Windows x64

CI on `windows-2022` builds the installer; neither it nor the local steps below have been run on a Windows PC for this guide. In PowerShell on a Windows x64 PC, from `gui\`:

```powershell
pnpm install --frozen-lockfile --ignore-scripts
node apps\desktop\node_modules\electron\install.js
$env:BB_DESKTOP_UPDATE_BASE_URL = "https://github.com/YOUR_USER/cloudroom-core/releases/latest/download/"
pnpm --dir apps\desktop run desktop:build:win   # installer; package:win for win-unpacked only
```

The first two lines follow `D/README.md`. With the Visual Studio 2022 C++ build tools installed, a plain `pnpm install --frozen-lockfile` also works, as it does in CI. Visual Studio 18 doesn't: pnpm 9's node-gyp can't find it to build better-sqlite3.

Output, in `apps\desktop\release.noindex\`: `Cloudroom-vN-x64.exe`, a one-click installer into `%LOCALAPPDATA%\Programs\Cloudroom` (no admin), and `win-unpacked\Cloudroom.exe` to run without installing. Both are unsigned, so SmartScreen may warn: click **More info**, then **Run anyway**. Install Git for Windows.

The installer's hooks are in `D/build/installer.nsh`. Before installing or uninstalling, they stop the bundled preview helper's `python.exe` running from the install folder, and wait for Cloudroom from that folder to quit. They have only been compiled in CI, not run on a PC. Keep a Mac `.p12` out of `CSC_LINK` in this shell, because electron-builder would use it to sign.

## Build in GitHub Actions

`.github/workflows/desktop.yml` builds macOS (ad-hoc), Linux, and Windows on GitHub's runners. It needs no secrets. It sets the update URL to your repository's releases, and pins the version to `v1000` plus the run number.

```sh
git tag desktop-build-4 && git push origin desktop-build-4
```

Use a tag name you haven't pushed before (`desktop-build-1` to `-3` exist on your fork).

- Pushing a `desktop-build-*` tag builds that commit and publishes a release named `desktop-vN` in your repository.
- **Run workflow** in the Actions tab also works, but only once the file is on your default branch.
- The release holds the `.dmg`, `.zip`, `.AppImage`, and `.exe`. It publishes whichever platforms built, so one failing platform doesn't hold back the others. Every run also keeps its builds under **Artifacts** for 90 days: `gh run download RUN_ID -R YOUR_USER/cloudroom-core`.
- Builds from CI are quarantined on macOS. See [Gatekeeper](#install).

Status on 2026-10-31, run `desktop-build-3` (41267225505): macOS, Linux, and Windows all built, and release [`desktop-v1003`](https://github.com/romitdasgupta/cloudroom-core/releases/tag/desktop-v1003) holds `Cloudroom-v1003-arm64.dmg`, `.zip`, `Cloudroom-v1003-x86_64.AppImage`, and `Cloudroom-v1003-x64.exe`.

## Where your build keeps data

| | Data and database | Ports | macOS app profile |
|---|---|---|---|
| Official app | `~/.gui-cloudroom` | 39886, 39887 | `~/Library/Application Support/Cloudroom` |
| Your build | `~/.gui-cloudroom` | 39886, 39887 | same as official |
| Your build, nightly channel | `~/.gui-cloudroom` | 39886, 39887 | `~/Library/Application Support/Cloudroom Nightly` |
| Dev mode (`gui/README.md`) | `~/.gui-cloudroom-dev/…` | its own | — |

- Every packaged app uses `~/.gui-cloudroom` and the same ports (`packages/config/src/runtime.ts`). Your build doesn't share data with dev mode.
- Your build has the official app's name, bundle id, data, and `cloudroom://` links, so it replaces the official app. You can't have both installed by default.
- Today the database matches the official app's: this branch adds no migrations. If you go back to the official app, first remove `machines`, `defaultMachine`, and `removedMachines` from `~/.gui-cloudroom/cloudroom.json` ([own-cores.md](own-cores.md#saved-state)).

To run both side by side (unverified):
1. Export `BB_DESKTOP_RELEASE_CHANNEL=nightly` for both the build and packaging steps. You get "Cloudroom Nightly" (`dev.cloudroom.gui.nightly`), with its own icon and app profile.
2. Copy it into Applications by hand. `install:macos` accepts only `dev.cloudroom.gui`.
3. Launch it with its own data and ports:
   ```sh
   open -n -a "Cloudroom Nightly" --env ROOM_SERVER_URL=http://127.0.0.1:39986 \
     --env ROOM_HOST_DAEMON_PORT=39987 --env ROOM_DATA_DIR="$HOME/.gui-cloudroom-mine"
   ```
   A launch from the Dock or Finder ignores these. It then shares the official app's data and ports, and if the official app is running, it offers to connect to it, which runs your interface on the official server.
4. Expect preview pairing conflicts. Each Core pairs previews with one computer, and a second data folder counts as another one.

## Your Cores

- **No Core upgrade is needed.** This branch changes no Rust. Its changed helpers, `core/src/preview/client.py` and `core/src/sync/client.py`, run on your computer. The app ships copies in `apps/server/src/assets/`, and each helper reinstalls itself when its bytes change. Any Core from 0.1.14 on has every feature the app checks for. Check with `/usr/local/lib/cloudroom/cloudroom --version`.
- **Upgrade to a published release** with [setup.md](../../core/docs/setup.md#upgrade). Your Cores never update themselves.
- **Don't install this branch's core over a newer one.** This branch is core 0.1.86, and `install.sh` installs the newest published release. `update.py` refuses older versions, and records `"result": "ahead"`.

To build a Core from source anyway, build on the Core itself so glibc and CPU match. Install the tools from [setup.md step 1](../../core/docs/setup.md#1-install-tools-and-build) (Rust 1.89+), then:

```sh
git clone -b YOUR_BRANCH https://github.com/YOUR_USER/cloudroom-core.git
cd cloudroom-core/core
cargo build --locked --release --jobs 2
d=$PWD/core-local; mkdir -p "$d/install"
cp target/release/cloudroom "$d/"; cp install/{configure,agent-home,previews,update}.py "$d/install/"
python3 - "$d" <<'PY'
import hashlib, json, subprocess, sys
d = sys.argv[1]; run = lambda *a: subprocess.check_output(a, text=True)
json.dump({'commit': run('git', 'rev-parse', 'HEAD').strip(),
           'version': run(d + '/cloudroom', '--version').split()[1],
           'features': run(d + '/cloudroom', '--features').split(),
           'sha256': hashlib.sha256(open(d + '/cloudroom', 'rb').read()).hexdigest()},
          open(d + '/update-manifest.json', 'w'))
PY
sudo python3 "$d/install/update.py" upgrade "$d"
sudo cat /var/lib/cloudroom-update/state.json
```

`update.py` waits until agents are idle, backs up the old core, swaps it in, checks every session, and rolls back on failure. The manifest keys are the ones `update.py` reads. These steps were not run end to end.

## First launch

1. Open Cloudroom. In **Settings → Machines → Connect your own Core**, enter a name, the Core's HTTPS URL (`tailscale serve status` on the Core), and its token (`sudo grep ^CLOUDROOM_TOKEN= /etc/cloudroom/core.env`). Repeat for each Core.
2. Open a Core and switch on **Use for new Cloud threads** to make it the default. Otherwise, pick a Core under Cloud in the composer.
3. Sign in an agent on every Core. Start a sign-in (Connect Codex, Claude Code, or Cursor) from a thread on that Core: it goes to that thread's Core. A sign-in that isn't from a thread goes to the default Core. You can also sign in on the Core as `cloudroom-agent` ([harnesses](../../core/docs/harnesses.md)).
4. Without a Cloudroom account, switch on **copy logins** in Settings → Machines to copy this computer's Codex and Pi logins to every Core. Claude Code and Cursor logins aren't copied.
5. Start a Cloud thread on each Core.
6. Previews and Mac access are optional and need setup on each Core ([previews](../../core/docs/previews.md)). Over Tailscale, use tunnel mode: the helper refuses private SSH addresses such as `100.x`, and the app doesn't allow them. Tunnel mode through Tailscale Serve is untested.

## If something fails

| Symptom | Fix |
|---|---|
| Your changes are gone, or the version in the corner isn't yours | The build lacked `BB_DESKTOP_UPDATE_BASE_URL`, and the official app replaced it. Rebuild with it set, then [reinstall](#install). |
| `Bundled runtimes require an Apple Silicon macOS build host.` | Build macOS on an Apple Silicon Mac, and Windows on Windows x64. |
| `Packaged npm verification requires a native target host` | You tried to cross-build. Build on the target OS and CPU. |
| `spawn pnpm ENOENT` while packaging | No `pnpm` on your `PATH`. Install pnpm 9.15.9 globally, or package with `pnpm run dist --ad-hoc` (or `npx --yes pnpm@9.15.9 exec node scripts/run-electron-builder.mjs …`). |
| `install:macos` fails at `codesign` | Check which path the error names. The new build: rebuild with `--ad-hoc`. `/Applications/Cloudroom.app`: an old unsigned build is installed, so move it out ([Install](#install)) and run again. |
| `Packaged migrations differ…` | Your build and the installed app have different database schemas. Back up `~/.gui-cloudroom`, then decide. The installer won't do it for you. |
| "Damaged" or "unidentified developer" | `xattr -dr com.apple.quarantine /Applications/Cloudroom.app` |
| On launch, the app offers to connect to, quit, or replace another Cloudroom | Another app owns ports 39886/39887. Quit it. |
| Adding a Core fails with unreachable | Check `tailscale serve status`, that the URL is `https://`, and the token (32+ characters). Then see [setup.md](../../core/docs/setup.md#if-something-fails). |
| The AppImage doesn't start | Install FUSE, or run it with `--appimage-extract-and-run`. |
| Codex settings don't sync in dev mode | Install Python 3.11+ for `python3`. Packaged macOS and Windows apps bundle 3.12. |
