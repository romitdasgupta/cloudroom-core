// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { sdk } from "@/lib/sdk";
import { useCloudLocked } from "@/hooks/useCloudLocked";
import { cloudEntries, cloudFeatureSupported, cloudReasoningLevels, cloudroomStatusSchema, cloudStatusFor, pickedCloudMachine, useCloudroomThreadWorkspace } from "./cloudroom-queries";

vi.mock("@/lib/sdk", () => ({ sdk: { cloudroom: { threadWorkspace: vi.fn(), status: vi.fn() } } }));
const clients: QueryClient[] = [];
afterEach(() => { cleanup(); clients.forEach(client => client.clear()); clients.length = 0; vi.resetAllMocks(); });
function mount(enabled = false) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } }); clients.push(client);
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  return renderHook(({ enabled }) => useCloudroomThreadWorkspace("thread", enabled), { wrapper, initialProps: { enabled } });
}

it("uses the cloud model's reasoning levels rather than the local model catalog", () => {
  const status = cloudroomStatusSchema.parse({ ready: true, projectId: null, repository: "/code/test", model: "sol", error: null, harnesses: [
    { id: "codex", reasoning_levels: ["high"], models: [{ model: "sol", reasoning_levels: ["high", "xhigh", "max"] }, { model: "basic", reasoning_levels: ["high"] }] },
    { id: "pi", provider: "openrouter", reasoning_levels: ["none", "high"] },
  ] });
  expect(cloudReasoningLevels(status, "codex", "sol")).toEqual(["high", "xhigh", "max"]);
  expect(cloudReasoningLevels(status, "codex", "basic")).toEqual(["high"]);
  expect(cloudReasoningLevels(status, "codex", "unknown")).toEqual([]);
  expect(cloudReasoningLevels(status, "pi", "openrouter/model")).toEqual(["none", "high"]);
  expect(cloudReasoningLevels(undefined, "codex", "sol")).toEqual([]);
});

it("reads a thread's own Core for readiness, catalog and features, and never queues it", () => {
  const status = cloudroomStatusSchema.parse({ ready: false, projectId: null, repository: null, model: null, error: "Sign in", steer: false, rewind: true, cloudQueue: { position: 3, total: 9, regionBlocked: false }, harnesses: [{ id: "codex", reasoning_levels: ["high"] }], machines: [
    { id: "m_0123456789ab", name: "Home", url: "https://home.example.ts.net", default: true, ready: true, error: null, harnesses: [{ id: "pi", reasoning_levels: ["low"] }], threads: 0, steer: true, queue_reorder: true },
  ] });
  const home = cloudStatusFor(status, "m_0123456789ab");
  expect(home).toMatchObject({ ready: true, error: null, cloudQueue: null, steer: true, rewind: false, queue_reorder: true });
  expect(cloudFeatureSupported(home, "pi", "steer")).toBe(true);
  expect(cloudFeatureSupported(home, "pi", "rewind")).toBe(false);
  expect(home.harnesses?.map(item => item.id)).toEqual(["pi"]);
  expect(cloudStatusFor(status, "m_ba9876543210")).toBe(status);
  expect(cloudStatusFor(status, null)).toBe(status);
  expect(cloudStatusFor(undefined, "m_0123456789ab")).toBeUndefined();
});

it("sends a new Cloud thread to the picked Core, else the default Core, else Cloud", () => {
  const machines = [{ id: "m_0123456789ab", default: false }, { id: "m_ba9876543210", default: true }];
  expect(pickedCloudMachine("m_0123456789ab", machines, true)).toBe("m_0123456789ab");
  expect(pickedCloudMachine(null, machines, true)).toBe("m_ba9876543210");
  expect(pickedCloudMachine("m_removed00000", machines, true)).toBe("m_ba9876543210");
  expect(pickedCloudMachine("cloud", machines, true)).toBeNull();
  // Signed out with no Account-page Core: there is no Cloud to pick, so the default Core stands.
  expect(pickedCloudMachine("cloud", machines, false)).toBe("m_ba9876543210");
  // The Cloud entry is hidden then, so even without a marked default a stale "cloud" pick lands on a Core.
  expect(pickedCloudMachine("cloud", [{ id: "m_0123456789ab", default: false }], false)).toBe("m_0123456789ab");
  expect(pickedCloudMachine("cloud", [], false)).toBeNull();
  expect(pickedCloudMachine(null, [{ id: "m_0123456789ab", default: false }], true)).toBeNull();
  expect(pickedCloudMachine("m_0123456789ab", [], true)).toBeNull();
});

it("hides the generic Cloud entry only for a Cores-only user", () => {
  const core = (id: string, isDefault: boolean) => ({ id, name: id, url: `https://${id}.example.ts.net`, default: isDefault, ready: true, error: null, harnesses: null, threads: 0 });
  const status = (extra: object) => cloudroomStatusSchema.parse({ ready: true, projectId: null, repository: null, model: null, error: null, machines: [core("m_0123456789ab", true)], ...extra });
  // Signed out with Cores: no Cloudroom Cloud row, and a stale "cloud" pick lands on the default Core.
  const signedOut = cloudEntries(status({}), false);
  expect(signedOut).toMatchObject({ hostedCloud: false, hidden: true });
  expect(signedOut.cores.map(item => item.id)).toEqual(["m_0123456789ab"]);
  expect(pickedCloudMachine("cloud", signedOut.cores, signedOut.hostedCloud)).toBe("m_0123456789ab");
  // Signed in: Cloudroom Cloud stays, beside the Cores.
  const signedIn = cloudEntries(status({ account: { id: "acct", email: "a@example.com" } }), false);
  expect(signedIn).toMatchObject({ hostedCloud: true, hidden: false });
  expect(pickedCloudMachine("cloud", signedIn.cores, signedIn.hostedCloud)).toBeNull();
  // A legacy Account-page Core without an account is the generic Cloud entry, so it stays and isn't listed again.
  const legacy = cloudEntries(status({ selfHosted: true, machines: [core("primary", false), core("m_0123456789ab", false)] }), false);
  expect(legacy).toMatchObject({ hostedCloud: true, hidden: false });
  expect(legacy.cores.map(item => item.id)).toEqual(["m_0123456789ab"]);
  expect(pickedCloudMachine("cloud", legacy.cores, legacy.hostedCloud)).toBeNull();
  expect(cloudEntries(status({}), true)).toMatchObject({ cores: [], hidden: false });
  expect(cloudEntries(undefined, false)).toMatchObject({ cores: [], hostedCloud: false, hidden: false });
});

it("unlocks Cloud for a user with only their own Cores", async () => {
  const signedOut = { ready: false, account: null, selfHosted: false, projectId: null, repository: null, model: null, error: null, signingIn: false, signInError: null };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } }); clients.push(client);
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  vi.mocked(sdk.cloudroom.status).mockResolvedValue(signedOut);
  const locked = renderHook(() => useCloudLocked(), { wrapper });
  await waitFor(() => expect(locked.result.current).toBe(true));
  vi.mocked(sdk.cloudroom.status).mockResolvedValue({ ...signedOut, machines: [{ id: "m_0123456789ab", name: "Home", url: "https://home.example.ts.net", default: true, ready: true, error: null, harnesses: null, threads: 0 }] });
  await act(() => client.invalidateQueries({ queryKey: ["cloudroom-account"] }));
  await waitFor(() => expect(locked.result.current).toBe(false));
});

it("reads an empty cloud folder and later Git metadata without preparing or copying it", async () => {
  const empty = { path: "/code/project", branch: null, head: null };
  vi.mocked(sdk.cloudroom.threadWorkspace).mockResolvedValue(empty);
  const hook = mount();
  expect(sdk.cloudroom.threadWorkspace).not.toHaveBeenCalled();
  hook.rerender({ enabled: true });
  await waitFor(() => expect(hook.result.current.data).toEqual(empty));
  expect(sdk.cloudroom.threadWorkspace).toHaveBeenCalledWith("thread", expect.any(AbortSignal));
  const cloned = { ...empty, branch: "main", head: "a".repeat(40) };
  vi.mocked(sdk.cloudroom.threadWorkspace).mockResolvedValue(cloned);
  await act(() => hook.result.current.refetch());
  await waitFor(() => expect(hook.result.current.data).toEqual(cloned));
});

it("keeps an unavailable core distinct from an empty folder", async () => {
  vi.mocked(sdk.cloudroom.threadWorkspace).mockRejectedValue(new Error("Core offline"));
  const hook = mount(true);
  await waitFor(() => expect(hook.result.current.isError).toBe(true));
  expect(hook.result.current.data).toBeUndefined();
  vi.mocked(sdk.cloudroom.threadWorkspace).mockResolvedValue({ path: "/code/project", branch: null, head: null });
  await act(() => hook.result.current.refetch());
  await waitFor(() => expect(hook.result.current.isError).toBe(false));
});
