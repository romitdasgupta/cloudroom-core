# Build Cloudroom from source

You need macOS on Apple Silicon, Git, Node.js 22.19+, pnpm 9.15.9, Python 3.11+, and Xcode Command Line Tools. Building needs no Cloudroom account.

Run these from this folder:

```sh
pnpm install --frozen-lockfile
pnpm exec turbo run build typecheck --filter=@cloudroom/app --filter=@cloudroom/server --filter=@cloudroom/desktop --concurrency=2
```

Keep dependency install scripts on. SQLite, file watching, and terminals use native modules. If your pnpm version differs, use `npx --yes pnpm@9.15.9`.

## Run in dev mode

Start the backend and browser UI, then Electron in a second terminal:

```sh
pnpm dev
pnpm exec turbo run dev --filter=@cloudroom/desktop
```

Dev mode uses its own ports and profile. Local agents need their own installed, signed-in CLIs. To use your own core for Cloud threads, see [connect the desktop app](../core/docs/setup.md#connect-the-desktop-app).

## Checks

```sh
pnpm exec turbo run test --filter=@cloudroom/scripts --filter=@cloudroom/config --concurrency=2
```

Desktop integration tests open real apps, so run them only in a test environment. The sync and preview helpers in `apps/server/src/assets/` are copies from the core, so change them there.

The build makes runnable bundles, not a signed installer.

## Build a local Mac installer

On an Apple Silicon Mac with the prerequisites above, run from the repository
root:

```sh
bash gui/scripts/build-macos-local.sh
```

The script installs the pinned pnpm dependencies, builds and typechecks the
app, runs the self-hosted connection regression tests and configuration tests,
and packages macOS arm64 DMG/ZIP artifacts under
`gui/apps/desktop/release.noindex/`. It also checks the packaged npm runtime.
It never publishes a release or replaces your installed app automatically.
Open the resulting DMG when you are ready to install it. Local builds use an
available keychain signing identity; without one, the app is unsigned and
macOS may block opening it. See [desktop packaging](apps/desktop/README.md#packaging).

macOS packaging must run on an Apple Silicon Mac: the packaging hook runs the
bundled Electron executable to verify native dependencies. A successful Linux
source build cannot produce a verified Mac installer.

This checkout exposes **Or connect your own Core** directly on the sign-in
screen. Enter the Core HTTPS URL and API token there; successful pairing opens
the app without a hosted Cloudroom account. It is also available under
**Settings → Account** when signed out. Older desktop builds may hide Settings
behind onboarding and need this fix before that route is usable.
