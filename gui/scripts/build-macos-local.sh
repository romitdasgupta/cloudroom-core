#!/bin/bash
# Build a private macOS installer from this checkout. Never publishes a release.
set -euo pipefail

if [ "$(uname -s)" != Darwin ] || [ "$(uname -m)" != arm64 ]; then
  echo 'Run this script on an Apple Silicon Mac (in a native arm64 terminal).' >&2
  exit 1
fi
command -v node >/dev/null || { echo 'Install Node.js 24 and retry.' >&2; exit 1; }
node -e 'const [major, minor] = process.versions.node.split(".").map(Number); if (major < 22 || (major === 22 && minor < 19)) process.exit(1)' || {
  echo 'Node.js 22.19 or newer is required; Node.js 24 is recommended.' >&2
  exit 1
}
command -v python3 >/dev/null || { echo 'Install Python 3 and retry.' >&2; exit 1; }
xcode-select -p >/dev/null 2>&1 || { echo 'Run xcode-select --install, finish installation, then retry.' >&2; exit 1; }

gui_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
cd "$gui_root"
pnpm_run() { npx --yes pnpm@9.15.9 "$@"; }
pnpm_run install --frozen-lockfile
pnpm_run exec turbo run build typecheck --filter=@cloudroom/app --filter=@cloudroom/server --filter=@cloudroom/desktop --concurrency=2
pnpm_run --dir apps/app exec vitest run --config vitest.config.ts \
  src/components/Onboarding.test.tsx \
  src/components/CodexConnectionPanel.test.tsx \
  src/components/CloudroomAccountPanels.test.tsx \
  src/components/settings/CloudroomAccountSettings.test.tsx
pnpm_run exec turbo run test --filter=@cloudroom/config --concurrency=2
pnpm_run --dir apps/desktop run dist
pnpm_run --dir apps/desktop run smoke:packaged-npm

printf '\nInstaller artifacts: %s/apps/desktop/release.noindex/\n' "$gui_root"
printf 'Open the .dmg to install. This is a local build; signing depends on your Mac keychain.\n'
