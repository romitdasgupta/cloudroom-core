# Your own Cores as the cloud

Cloud threads can run on Cores you host: a Linux VM or container on your computer, a VPS, or a public-cloud VM. Register as many as you like (up to 32) in **Settings → Machines → Connect your own Core**, with or without a Cloudroom account. Each machine runs one Core that all its threads share. There is no per-thread sandbox, sleep, or wake; those still need Cloudroom's website. Install a Core with [core/docs/setup.md](../../core/docs/setup.md).

Everything here lives in `apps/server/src/services/cloudroom/` unless noted.

## Saved state

`<dataDir>/cloudroom.json` (mode 0600) keeps its old fields and adds three:

| Field | Meaning |
|---|---|
| `machines` | `[{id, name, url, token, gateToken?}]`. `id` is `m_` plus 12 hex digits. `url` is normalized, with no trailing slash, and must be `https:` or loopback `http:` (`CloudroomClient` enforces it). |
| `defaultMachine` | Optional explicit default: `primary` or an `m_` id. |
| `removedMachines` | URLs of removed machines (last 50), so their archived threads report "removed" instead of being mistaken for the retired hosted VM. |

The legacy top-level `url`/`token` still works. Without an account it is the **primary** machine (id `primary`, named after its host). With an account it is the hosted VM, as before. `connection()` strips the new keys before its strict parse, so the legacy paths see the file they always did. An older app rejects a file that contains `machines`, so a downgrade needs those keys removed.

All writes go through `changeConnection()`, one at a time. `addMachine` probes the Core outside that lock (15 s limit) and checks for duplicates again inside it.

## Which Core a thread uses

Threads still store the literal Core URL in `cloudroom_threads.core_url`. There is no migration: a self-hosted thread already stored its URL.

- **Existing thread** (`coreForUrl`): a `sandbox:` binding goes to the website as before. Otherwise the registered machine with that URL is used, then the primary or hosted VM. With no match, the request fails with 409 `cloudroom_connection_changed`, and the message says to reconnect the Core with the same address.
- **New thread or teleport** (`newThreadCore(place)`), where `place` comes from `CreateThreadRequest.cloudMachine` or the teleport `machine`:
  1. `primary` or an `m_` id: that machine (400 `cloudroom_machine_unknown` if it's gone).
  2. `cloud`: skip the default Core. Sandboxes when signed in, else the legacy connection.
  3. Omitted: the effective default (`effectiveDefault`), else sandboxes, else the legacy connection, else 503 `cloudroom_not_configured`.

  The effective default is `defaultMachine` when it still exists. Otherwise, when nothing else can take new threads (no legacy token and no signed-in sandboxes), it is the first machine. This fallback is computed on read and never stored, so a later sign-in sends new threads to sandboxes, not to a Core nobody picked.
- **Children, side chats, and text forks** keep their parent's `core_url`. An explicit `cloudTarget` (VPS or Cloud) also skips the default Core.
- **Work without a thread** (`targetConnection`), such as `room-cli vm run` and Claude Code version sync, uses the effective default, then the legacy connection.
- `moveToSandbox` refuses own-Core threads. Teleport them to Local, then to Cloud.
- Project-copy keys include the Core URL, so two machines can copy the same project at once.

## Capabilities and status

`coreCapabilities: Map<url, Capabilities>` replaces the single `lastCapabilities`. Sandboxes keep their separate cache. A thread's model list, reasoning levels, and steer, rewind, compact, and queue controls come from its own Core.

`machineStatuses()` probes every Core in parallel, with a 5 s limit per Core. One offline machine never delays the rest. Each `CloudroomMachineStatus` is `{id, name, url, default, ready, error, harnesses, threads, steer, rewind, compact, queue_edit, queue_cancel, queue_reorder}`. Tokens are never returned. `status().machines` carries the same list, and `selfHosted` keeps its old meaning.

## API

| Route | Body | Result / errors |
|---|---|---|
| `GET /api/v1/cloudroom/machines` | — | `{machines}` |
| `POST /api/v1/cloudroom/machines` | `{name, url, token, gateToken?}` | Probes `capabilities` and `ready`. 409 `cloudroom_machine_exists`; 503/400 `cloudroom_machine_unreachable`. |
| `PATCH /api/v1/cloudroom/machines/:id` | `{name?, default?}` | The primary can't be renamed. |
| `DELETE /api/v1/cloudroom/machines/:id` | — | 409 `cloudroom_machine_in_use` while an unarchived thread, a starting thread, or a teleport uses it. Best effort, it also tells the Core to forget this computer's preview device. |

Changes return 403 from remote (gate) sessions, because a machine gets Mac access. Only the computer itself may change the list. SDK: `sdk.cloudroom.machines.{list, add, update, remove}` (`packages/sdk/src/areas/cloudroom.ts`).

## Accounts

- **Sign-in** keeps `machines` and `defaultMachine`. It adopts a self-hosted primary as a registered machine, so its threads keep resolving, and refuses with 409 `cloudroom_machine_limit` past 32 machines. `stampBindings` skips own-Core threads, so switching accounts doesn't lock them.
- **Sign-out and disconnect** keep the machines, which stay paired.
- `cloudroom_connection_in_use` no longer applies to registered or removed machines.
- **Agent sign-in**: Codex, Cursor and Claude Code sign-in started from a thread go to that thread's Core (`authCore`); thread-less sign-in goes to the default Core. The `account/{codex,cursor,claude}` routes take `?thread=` on GET and `threadId` in POST bodies, and the SDK passes it when given. A thread-scoped Claude sign-in resumes only waiting starts on that Core. `account/claude/token` (the Accounts plugin) stays on the default login.

## App

- **First-run setup** (`apps/app/src/components/Onboarding.tsx`) can't be skipped while nothing is connected. Its sign-in step offers **Connect it instead**, which opens the same Add Core dialog. Once a Core is added, setup closes and stays unlocked.
- **Settings → Machines** (`apps/app/src/components/settings/CoreMachines.tsx`, mounted in `MachinesSettingsSection.tsx`) shows one row per Core: status dot, Default badge, host, and thread count. A row opens a dialog to rename, set **Use for new Cloud threads**, or remove the Core. Without an account, the Mac access and copy-logins switches appear here once a Core exists.
- **Composer**: Cores appear under Cloud in the environment menu (`EnvironmentPicker.tsx`). The new thread uses the stored pick, then the default Core, then Cloudroom Cloud (`pickedCloudMachine` in `hooks/queries/cloudroom-queries.ts`). `cloudStatusFor` gives a Core thread its own Core's readiness and features. Users with only Cores aren't locked out of Cloud (`useCloudLocked.ts`). Fork drafts don't offer a Core, because forks get a new sandbox.

## Helpers on the computer

The helpers read `cloudroom.json` directly, so they see `machines` with no extra file. Edit them in `core/src/`, and keep the copies in `apps/server/src/assets/` byte-identical.

- **Previews and Mac access** (`core/src/preview/client.py`): `cores()` lists the primary (only when it has a token), then every registered machine, then awake sandboxes. Machines are marked `extra`, like sandboxes: an offline one never stops the others, and each gets its own socket, log, and port name. Commands run on a machine are never sent to the website's Mac review. Sign-out revokes the device on the primary and sandboxes only.
- **Sync** (`core/src/sync/client.py`): two-way skills and settings sync still targets only the primary or account-page Core. `auth` and `pi-auth` accept `--machine m_…` to copy Codex and Pi logins to a machine. Each machine keeps its own receipts (`codex-import-<id>.json`, `pi-import-<id>.json`). With copy logins on, the server runs these when a machine is added, when copy logins is turned on, and before a Codex or Pi thread starts on that machine.

## Not yet

- Two-way skills and settings sync to every machine.
- Claude Code and Cursor login copies to machines.
- A machine picker in the Teleport screen. The server and SDK already accept `machine`.
- A Cloud fork of a Core thread.
- The machine name in the thread header.
- Per-thread sandboxes, sleep and wake, relay between sandboxes, automations, and GPU on your own machines. These need a self-hosted control plane in place of the website.

## Tests

- `apps/server/test/services/cloudroom-machines.test.ts`
- `packages/sdk/test/cloudroom.test.ts`
- `apps/app/src/components/settings/CoreMachines.test.tsx`
- `MachinesSettingsSection.test.tsx`
- `EnvironmentPicker.test.tsx`
- `cloudroom-queries.test.tsx`
- `NewThreadPromptBox.test.tsx`
- `CoresTests` in `core/tests/preview_client.py`
