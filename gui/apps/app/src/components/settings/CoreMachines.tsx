import { useState, type FormEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { COMPUTER } from "@cloudroom/domain";
import type { CloudroomMachineStatus } from "@cloudroom/sdk/browser";
import { Button } from "@cloudroom/shared-ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@cloudroom/shared-ui/dialog";
import { Icon } from "@cloudroom/shared-ui/icon";
import { Input } from "@cloudroom/shared-ui/input";
import { Switch } from "@cloudroom/shared-ui/switch";
import { cn } from "@cloudroom/shared-ui/lib/utils";
import { MachineStatusDot } from "@/components/machines/MachineStatusDot";
import { OsTile } from "@/components/machines/OsTile";
import { SETTINGS_CARD_CLASS, SETTINGS_CARD_ROW_CLASS, SettingsBadge } from "@/components/ui/settings-section";
import { useCloudroomAccount, useCoreMachines, useSetCopyLogins } from "@/hooks/queries/cloudroom-queries";
import { getMutationErrorMessage } from "@/lib/mutation-errors";
import { sdk } from "@/lib/sdk";

const MACHINES_KEY = ["cloudroom-machines"];

function hostOf(url: string): string {
  try { return new URL(url).host; } catch { return url; }
}

/** Every machine call answers the new list; status and account polls read machines too. */
function useMachineChange<T>(change: (input: T) => Promise<CloudroomMachineStatus[]>, onDone?: () => void) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: change,
    onSuccess: (machines) => {
      queryClient.setQueryData(MACHINES_KEY, machines);
      void queryClient.invalidateQueries({ queryKey: MACHINES_KEY });
      void queryClient.invalidateQueries({ queryKey: ["cloudroom-connection"] });
      void queryClient.invalidateQueries({ queryKey: ["cloudroom-account"] });
      onDone?.();
    },
  });
}

/** Self-hosted Cores (core docs/setup.md), one row each, on the Machines page. */
export function CoreMachineRows() {
  const list = useCoreMachines();
  const account = useCloudroomAccount();
  const machines = list.data ?? [];
  const [openId, setOpenId] = useState<string | null>(null);
  const open = machines.find((machine) => machine.id === openId) ?? null;
  return <>
    {/* The first list waits up to ~5 s for a Core that doesn't answer. */}
    {list.isPending ? <p role="status" className={cn(SETTINGS_CARD_ROW_CLASS, "text-xs text-subtle-foreground/75")}>Checking your Cores…</p> : null}
    {list.isError && !list.data ? <p role="alert" className={cn(SETTINGS_CARD_ROW_CLASS, "text-xs text-warning-text")}>Couldn't list your Cores. Retrying…</p> : null}
    {machines.map((machine) => <CoreMachineRow key={machine.id} machine={machine} onOpen={() => setOpenId(machine.id)} />)}
    {machines.length && account.data && !account.data.account ? <CopyLoginsRow /> : null}
    <Dialog open={open !== null} onOpenChange={(next) => { if (!next) setOpenId(null); }} modal={false}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto">
        {open ? <CoreMachineBody key={open.id} machine={open} /> : null}
      </DialogContent>
    </Dialog>
  </>;
}

/** With an account this switch is on the Cloud page, which needs the website; without one, it lives with the Cores (ADR 0130). */
function CopyLoginsRow() {
  const account = useCloudroomAccount();
  const setCopyLogins = useSetCopyLogins();
  const enabled = setCopyLogins.isPending ? setCopyLogins.variables : account.data?.copyLogins === true;
  return (
    <div className={SETTINGS_CARD_ROW_CLASS}>
      <div className="min-w-0 flex-1">
        <p className="text-foreground">Auth my agents on my Cores automatically</p>
        <p className="text-xs text-subtle-foreground/75">Copies this {COMPUTER}'s Codex and Pi logins to every Core.</p>
        {setCopyLogins.isError ? <p role="alert" className="text-xs text-destructive-text">{getMutationErrorMessage({ error: setCopyLogins.error, fallbackMessage: "Couldn't save." })}</p> : null}
      </div>
      <Switch aria-label="Auth my agents on my Cores automatically" checked={enabled} disabled={setCopyLogins.isPending} onCheckedChange={(on) => setCopyLogins.mutate(on)} />
    </div>
  );
}

function CoreMachineRow({ machine, onOpen }: { machine: CloudroomMachineStatus; onOpen: () => void }) {
  const { name, ready, error, threads } = machine;
  return (
    <button type="button" onClick={onOpen} className={cn(SETTINGS_CARD_ROW_CLASS, "w-full text-left transition-colors hover:bg-state-hover")}>
      <OsTile os="linux" />
      <div className="min-w-0 flex-1 space-y-0.5">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="min-w-0 truncate text-sm text-foreground">{name}</span>
          <SettingsBadge>Core</SettingsBadge>
          {machine.default ? <SettingsBadge>Default</SettingsBadge> : null}
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-subtle-foreground/75">
          <span className="inline-flex min-w-0 items-center gap-1.5">
            <MachineStatusDot connected={ready} />
            <span className={cn("min-w-0 truncate", !ready && "text-warning-text")}>{ready ? "Online" : error ?? "Offline"}</span>
          </span>
          <span className="truncate">{hostOf(machine.url)}</span>
          <span className="shrink-0">{threads} {threads === 1 ? "thread" : "threads"}</span>
        </div>
      </div>
      <Icon name="ChevronRight" className="size-4 shrink-0 text-muted-foreground" aria-hidden />
    </button>
  );
}

function CoreMachineBody({ machine }: { machine: CloudroomMachineStatus }) {
  const account = useCloudroomAccount();
  const [name, setName] = useState(machine.name);
  const change = useMachineChange((input: { name?: string; default?: boolean } | "remove") => input === "remove" ? sdk.cloudroom.machines.remove(machine.id) : sdk.cloudroom.machines.update(machine.id, input));
  // With no account and no Account-page Core, new Cloud threads always land on some Core: switching the default off can't take effect.
  const pinned = machine.default && !account.data?.account && !account.data?.selfHosted;
  const rename = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (name.trim() && name.trim() !== machine.name) change.mutate({ name: name.trim() });
  };
  return <>
    <DialogHeader>
      <DialogTitle>{machine.name}</DialogTitle>
      <DialogDescription>{machine.url}</DialogDescription>
    </DialogHeader>
    <div className="flex flex-col gap-3">
      <div className={SETTINGS_CARD_CLASS}>
        {machine.id === "primary" ? null : (
          <form className={SETTINGS_CARD_ROW_CLASS} onSubmit={rename}>
            <Input aria-label="Core name" value={name} maxLength={64} onChange={(event) => setName(event.target.value)} autoComplete="off" />
            <Button type="submit" variant="outline" size="sm" disabled={change.isPending || !name.trim() || name.trim() === machine.name}>Save</Button>
          </form>
        )}
        <div className={SETTINGS_CARD_ROW_CLASS}>
          <div className="min-w-0 flex-1">
            <p className="text-foreground">Use for new Cloud threads</p>
            <p className="text-xs text-subtle-foreground/75">{pinned ? "New Cloud threads go here until you pick another Core." : "New threads pick this Core by default. Others stay one click away."}</p>
          </div>
          <Switch aria-label="Use for new Cloud threads" checked={machine.default} disabled={change.isPending || pinned} onCheckedChange={(on) => change.mutate({ default: on })} />
        </div>
        <div className={SETTINGS_CARD_ROW_CLASS}>
          <div className="min-w-0 flex-1">
            <p className="text-foreground">Remove</p>
            <p className="text-xs text-subtle-foreground/75">The Core keeps running. Archive its threads first.</p>
          </div>
          <Button variant="outline" size="sm" className="text-destructive-text" disabled={change.isPending} onClick={() => change.mutate("remove")}>Remove</Button>
        </div>
      </div>
      {change.isError ? <p role="alert" className="text-sm text-destructive-text">{getMutationErrorMessage({ error: change.error, fallbackMessage: "Couldn't save." })}</p> : null}
    </div>
  </>;
}

/** Connects one more Core the user hosts, by URL and token. The server checks it before saving. */
export function AddCoreDialog({ open, onOpenChange, onAdded }: { open: boolean; onOpenChange: (open: boolean) => void; onAdded?: () => void }) {
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const add = useMachineChange(() => sdk.cloudroom.machines.add({ name: name.trim(), url: url.trim(), token: token.trim() }), () => {
    setName(""); setUrl(""); setToken("");
    onOpenChange(false);
    onAdded?.();
  });
  const resetAdd = add.reset;
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) { setToken(""); resetAdd(); } onOpenChange(next); }} modal={false}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Connect your own Core</DialogTitle>
          <DialogDescription>Use its HTTPS address and the token from /etc/cloudroom/core.env. No account needed.</DialogDescription>
        </DialogHeader>
        <form className="flex flex-col gap-2" onSubmit={(event) => { event.preventDefault(); add.mutate(undefined); }}>
          <Input aria-label="Core name" placeholder="Home server" value={name} maxLength={64} onChange={(event) => setName(event.target.value)} autoComplete="off" />
          <Input aria-label="Core URL" placeholder="https://my-core.example.ts.net" value={url} onChange={(event) => setUrl(event.target.value)} autoComplete="off" spellCheck={false} />
          <Input aria-label="Core API token" type="password" placeholder="API token" value={token} onChange={(event) => setToken(event.target.value)} autoComplete="off" />
          <p className="text-xs text-muted-foreground">Its agents get the same {COMPUTER} access as Cloud. Connect only Cores you control.</p>
          {add.isError ? <p role="alert" className="text-sm text-destructive-text">{getMutationErrorMessage({ error: add.error, fallbackMessage: "Couldn't connect this Core." })}</p> : null}
          <Button type="submit" className="self-end" disabled={add.isPending || !name.trim() || !url.trim() || !token.trim()}>{add.isPending ? "Connecting…" : "Connect"}</Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
