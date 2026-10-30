#!/bin/bash
# Bootstrap a fresh Ubuntu host with Core, Codex, and Claude Code.
# Copy this file alone to another host; no repository checkout is required.
set -euo pipefail
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

usage() {
  cat <<'EOF'
Usage: sudo bash lab-setup.sh --codex-model MODEL [options]

  --codex-model MODEL       Required default model supported by your account
  --core-version X.Y.Z      Pin Core (default: newest released Core)
  --codex-version X.Y.Z     Default: 0.154.0 (repository-tested version)
  --claude-version X.Y.Z    Default: 2.1.280 (repository-tested version)
  --allow-untested-ubuntu   Permit Ubuntu releases other than 24.04
  --existing-core          Add missing agents to an installed, stopped Core
  -h, --help               Show this help

Ubuntu hosts with systemd and cgroup v2; x86_64 or aarch64.
Installs packages and system accounts, then starts a persistent service.
Existing Core requires --existing-core and a stopped service; no Core upgrade.
Login and private HTTPS connectivity are completed after installation.
Existing agent executables and model settings are preserved, not upgraded.
EOF
}
fail() { printf 'Setup failed: %s\n' "$*" >&2; exit 1; }
model=''
core_version=''
codex_version=0.154.0
claude_version=2.1.280
allow_untested=0
existing_core=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --codex-model|--core-version|--codex-version|--claude-version)
      [ "$#" -ge 2 ] && [ -n "$2" ] || fail "$1 requires a value"
      case "$1" in
        --codex-model) model=$2 ;;
        --core-version) core_version=$2 ;;
        --codex-version) codex_version=$2 ;;
        --claude-version) claude_version=$2 ;;
      esac
      shift 2 ;;
    --allow-untested-ubuntu) allow_untested=1; shift ;;
    --existing-core) existing_core=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) fail "unknown option: $1" ;;
  esac
done
[[ $model =~ ^[A-Za-z0-9][A-Za-z0-9._:/-]*$ ]] || fail 'supply --codex-model MODEL (no whitespace)'
for version in "$codex_version" "$claude_version"; do
  [[ $version =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail 'agent versions must be X.Y.Z'
done
[[ -z $core_version || $core_version =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail 'Core version must be X.Y.Z'
[ "$(id -u)" = 0 ] || fail 'run with sudo bash lab-setup.sh ...'
[ -f /etc/os-release ] || fail 'Ubuntu is required'
# shellcheck disable=SC1091
. /etc/os-release
[ "${ID:-}" = ubuntu ] || fail 'this script supports Ubuntu only'
if [ "${VERSION_ID:-}" != 24.04 ]; then
  [ "$allow_untested" = 1 ] || fail 'only Ubuntu 24.04 is tested; use --allow-untested-ubuntu to proceed on this Ubuntu release'
  printf 'Warning: %s is outside the tested Ubuntu 24.04 setup.\n' "$PRETTY_NAME" >&2
fi
case $(uname -m) in x86_64|aarch64) ;; *) fail 'x86_64 or aarch64 is required' ;; esac
[ -d /run/systemd/system ] || fail 'systemd must be running'
[ -f /sys/fs/cgroup/cgroup.controllers ] || fail 'cgroup v2 is required'
if [ "$existing_core" = 1 ]; then
  [ -z "$core_version" ] || fail '--core-version cannot be combined with --existing-core'
  [ -f /etc/cloudroom/core.env ] && [ -x /usr/local/lib/cloudroom/cloudroom ] && [ -f /etc/cloudroom/storage.json ] || fail 'existing Core installation is incomplete; finish Core provisioning using docs/setup.md first'
  [ "$(systemctl show cloudroom.service --property=LoadState --value)" = loaded ] || fail 'cloudroom.service is not installed'
  service_state=$(systemctl show cloudroom.service --property=ActiveState --value)
  [[ $service_state = inactive || $service_state = failed ]] || fail 'finish running tasks, then run sudo systemctl stop cloudroom.service before --existing-core'
  command -v python3 >/dev/null || fail 'python3 is required'
  command -v node >/dev/null || fail 'install system-wide Node.js 24+ first'
  command -v npm >/dev/null || fail 'install system-wide npm first'
  agent_home=$(getent passwd cloudroom-agent | cut -d: -f6)
  [ -n "$agent_home" ] || fail 'cloudroom-agent account is missing'
  # Parse the protected file as data, never execute it or print its values.
  python3 - /etc/cloudroom/core.env "$agent_home" <<'PY'
import pathlib, sys
path, home = sys.argv[1:]
values = {}
for line in pathlib.Path(path).read_text().splitlines():
    key, sep, value = line.partition('=')
    if sep:
        values[key] = value
expected = {'CLOUDROOM_ACCOUNT_HOME': home,
            'CLOUDROOM_CODEX_BINARY': '/usr/local/bin/codex',
            'CLOUDROOM_CODEX_HOME': home + '/.codex',
            'CLOUDROOM_LISTEN': '127.0.0.1:9840'}
for key, value in expected.items():
    if (key == 'CLOUDROOM_ACCOUNT_HOME' or key in values) and values.get(key) != value:
        sys.exit('Custom ' + key + ': use manual harness setup; configuration was not changed.')
PY
else
  [ ! -e /etc/cloudroom/core.env ] || fail 'Core already exists. To add missing agents, stop Core after tasks finish and rerun with --existing-core. Do not delete core.env.'
fi
if command -v node >/dev/null; then
  node_major=$(node -p 'process.versions.node.split(".")[0]')
  [ "$node_major" -ge 24 ] || fail 'upgrade system-wide Node.js to 24+ before setup (the Core installer preserves existing Node)'
  command -v npm >/dev/null || fail 'install system-wide npm before setup'
fi

stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT
trap 'printf "Setup stopped at line %s. Changes already made remain in place. See core/docs/setup.md for recovery; no credentials were printed.\n" "$LINENO" >&2' ERR
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y curl ca-certificates sudo
fetch() { curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 --retry 3 "$@"; }

# Use the checkout's installer when available; the copied standalone script
# fetches the published installer. Core itself verifies the release checksum.
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
cd /
# Core monitors one filesystem, including /tmp and /var/tmp. Some Ubuntu
# hosts mount /tmp as tmpfs. Bind disk-backed directories only into this
# service's namespace; never unmount or reconfigure the host's /tmp.
work_root=/code
[ -d "$work_root" ] || work_root=/
work_device=$(stat -c %d "$work_root")
temp_bindings=''
for destination in /tmp /var/tmp; do
  if [ "$(stat -c %d "$destination")" != "$work_device" ]; then
    [ "$(stat -c %d /var/cache)" = "$work_device" ] || fail '/var/cache and /code must share a filesystem for service-local temporary directories; configure storage manually'
    temp_name=tmp
    [ "$destination" != /var/tmp ] || temp_name=var-tmp
    source_dir="/var/cache/cloudroom-tmp/$temp_name"
    [ ! -L /var/cache/cloudroom-tmp ] && [ ! -L "$source_dir" ] || fail 'temporary directory paths must not be symlinks'
    install -d -m 755 -o root -g root /var/cache/cloudroom-tmp
    install -d -m 1777 -o root -g root "$source_dir"
    temp_bindings+="BindPaths=$source_dir:$destination"$'\n'
  fi
done
if [ -n "$temp_bindings" ]; then
  dropin_dir=/etc/systemd/system/cloudroom.service.d
  dropin="$dropin_dir/30-lab-temporary-directories.conf"
  printf '[Service]\n%s' "$temp_bindings" > "$stage/temp-directories.conf"
  if [ -e "$dropin" ]; then
    cmp -s "$stage/temp-directories.conf" "$dropin" || fail 'existing temporary-directory override differs; review it manually'
  else
    install -d -m 755 -o root -g root "$dropin_dir"
    install -m 644 -o root -g root "$stage/temp-directories.conf" "$dropin"
  fi
  systemctl daemon-reload
  printf 'Configured disk-backed temporary directories for Cloudroom only.\n'
fi
if [ "$existing_core" = 0 ]; then
  if [ -f "$script_dir/install.sh" ]; then
    cp "$script_dir/install.sh" "$stage/core-install.sh"
  else
    fetch https://cloudroom.dev/install.sh -o "$stage/core-install.sh"
  fi
  core_args=()
  [ -z "$core_version" ] || core_args=(--version "$core_version")
  # Self-hosted history stays local even if the caller exported a managed API URL.
  env -u CLOUDROOM_API_URL bash "$stage/core-install.sh" "${core_args[@]}"
fi

# Never use an administrator's nvm installation or credentials.
node_major=$(node -p 'process.versions.node.split(".")[0]')
[ "$node_major" -ge 24 ] || fail 'system-wide Node.js 24+ is required; update Node, then complete harness setup manually'
command -v npm >/dev/null || fail 'system-wide npm is required'
agent_home=$(getent passwd cloudroom-agent | cut -d: -f6)
[ -n "$agent_home" ] || fail 'cloudroom-agent account is missing'
install -d -m 700 -o cloudroom-agent -g cloudroom-agent "$agent_home/.codex" "$agent_home/.claude"
if [ ! -x /usr/local/bin/codex ]; then
  npm install --global --prefix /usr/local "@openai/codex@$codex_version"
fi
claude_binary="$agent_home/.local/bin/claude"
if [ ! -x "$claude_binary" ] && [ -x /usr/local/bin/claude ]; then
  claude_binary=/usr/local/bin/claude
fi
if [ ! -x "$claude_binary" ]; then
  fetch https://claude.ai/install.sh -o "$stage/claude-install.sh"
# Feed the downloaded script over stdin: the agent cannot read root's temp dir.
# The invoking root shell intentionally opens the file before dropping privileges.
# shellcheck disable=SC2024
sudo -u cloudroom-agent -H bash -s -- "$claude_version" < "$stage/claude-install.sh"
fi
sudo -u cloudroom-agent -H /usr/local/bin/codex --version
sudo -u cloudroom-agent -H "$claude_binary" --version

# Add only missing settings, preserving credentials and existing model choices.
python3 - /etc/cloudroom/core.env "$agent_home" "$model" <<'PY'
import os, pathlib, sys, tempfile
path = pathlib.Path(sys.argv[1])
original = path.read_text()
keys = {line.partition('=')[0] for line in original.splitlines() if '=' in line}
settings = {'CLOUDROOM_CODEX_BINARY': '/usr/local/bin/codex',
            'CLOUDROOM_CODEX_HOME': sys.argv[2] + '/.codex',
            'CLOUDROOM_CODEX_MODEL': sys.argv[3]}
added = ''.join(f'{key}={value}\n' for key, value in settings.items() if key not in keys)
if added:
    metadata = path.stat()
    fd, temp = tempfile.mkstemp(dir=path.parent)
    try:
        with os.fdopen(fd, 'w') as output:
            os.fchown(output.fileno(), metadata.st_uid, metadata.st_gid)
            os.fchmod(output.fileno(), 0o600)
            output.write(original + ('' if original.endswith('\n') else '\n') + added)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temp, path)
    finally:
        if os.path.exists(temp):
            os.unlink(temp)
PY
systemctl restart cloudroom.service

ready=0
for ((attempt=0; attempt<30; attempt++)); do
  if awk -F= '/^CLOUDROOM_TOKEN=/{print "header = \"Authorization: Bearer " $2 "\""}' /etc/cloudroom/core.env |
    curl --config - --silent --fail --connect-timeout 2 --max-time 5 http://127.0.0.1:9840/v1/ready > "$stage/ready.json"; then
    if python3 -c 'import json,sys; sys.exit(json.load(open(sys.argv[1])).get("ready") is not True)' "$stage/ready.json"; then
      ready=1
      break
    fi
  fi
  sleep 1
done
[ "$ready" = 1 ] || fail 'Core is not ready; inspect sudo journalctl -u cloudroom.service -n 50 --no-pager'
cat <<'EOF'

Core is ready at http://127.0.0.1:9840. Codex and Claude Code are installed.
No agent login or inference task has been performed yet.

Next, on each host:
  1. Install Tailscale and sign in on this host and your desktop.
     https://tailscale.com/download/linux
  2. Enable MagicDNS and HTTPS certificates in your Tailscale admin console.
  3. Run: sudo tailscale serve --bg 9840
     Then: tailscale serve status
  4. In Cloudroom: Settings -> Account -> Or connect your own Core.
     This form appears when signed out of the hosted Cloudroom account.
     Enter this host's Tailscale HTTPS URL and its token. Read the token locally:
       sudo sed -n 's/^CLOUDROOM_TOKEN=//p' /etc/cloudroom/core.env
     Keep the token private. Each host has its own token.
  5. Select Cloud and use Connect Codex / Connect Claude to sign in.
     Submit a small task with each agent to verify real execution.

Keep port 9840 private. Do not use tailscale funnel.
Back up /var/lib/cloudroom/history and your workspaces under /code.
Each host is independent; this script does not create a shared worker pool.
EOF
