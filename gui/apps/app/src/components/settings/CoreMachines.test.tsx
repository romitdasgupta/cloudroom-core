// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { CloudroomMachineStatus } from "@cloudroom/sdk/browser";
import { afterEach, expect, it, vi } from "vitest";
import { sdk } from "@/lib/sdk";
import { AddCoreDialog, CoreMachineRows } from "./CoreMachines";

vi.mock("@/lib/sdk", () => ({ sdk: { cloudroom: { status: vi.fn(), setCopyLogins: vi.fn(), machines: { list: vi.fn(), add: vi.fn(), update: vi.fn(), remove: vi.fn() } } } }));
vi.mock("@/lib/app-surface", () => ({ fetchWithAppSurface: vi.fn().mockResolvedValue(new Response("{}")) }));
const clients: QueryClient[] = [];
afterEach(() => { cleanup(); clients.forEach(client => client.clear()); clients.length = 0; vi.resetAllMocks(); });
const signedOut = { ready: false, account: null, projectId: null, repository: null, model: null, error: null, signingIn: false, signInError: null };
const home: CloudroomMachineStatus = { id: "m_0123456789ab", name: "Home server", url: "https://home.example.ts.net", default: true, ready: true, error: null, harnesses: null, threads: 2 };
const vps: CloudroomMachineStatus = { id: "m_ba9876543210", name: "VPS", url: "https://vps.example.com", default: false, ready: false, error: "Core is not reachable", harnesses: null, threads: 1 };
function mount(ui: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  clients.push(client);
  render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

it("lists each Core with its status, default badge, and thread count", async () => {
  vi.mocked(sdk.cloudroom.status).mockResolvedValue(signedOut);
  vi.mocked(sdk.cloudroom.machines.list).mockResolvedValue([home, vps]);
  mount(<CoreMachineRows />);
  const row = (await screen.findByText("Home server")).closest("button")!;
  expect(row.textContent).toContain("Default");
  expect(row.textContent).toContain("Online");
  expect(row.textContent).toContain("home.example.ts.net");
  expect(row.textContent).toContain("2 threads");
  const other = screen.getByText("VPS").closest("button")!;
  expect(other.textContent).not.toContain("Default");
  expect(other.textContent).toContain("Core is not reachable");
  expect(other.textContent).toContain("1 thread");
});

it("connects a Core with trimmed values", async () => {
  vi.mocked(sdk.cloudroom.machines.add).mockResolvedValue([home]);
  const onOpenChange = vi.fn();
  mount(<AddCoreDialog open onOpenChange={onOpenChange} />);
  const connect = screen.getByRole("button", { name: "Connect" }) as HTMLButtonElement;
  expect(connect.disabled).toBe(true);
  fireEvent.change(screen.getByLabelText("Core name"), { target: { value: " Home server " } });
  fireEvent.change(screen.getByLabelText("Core URL"), { target: { value: " https://home.example.ts.net/ " } });
  fireEvent.change(screen.getByLabelText("Core API token"), { target: { value: ` ${"t".repeat(40)} ` } });
  fireEvent.click(connect);
  await waitFor(() => expect(sdk.cloudroom.machines.add).toHaveBeenCalledWith({ name: "Home server", url: "https://home.example.ts.net/", token: "t".repeat(40) }));
  await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
});

it("shows why a Core can't be removed", async () => {
  vi.mocked(sdk.cloudroom.status).mockResolvedValue(signedOut);
  vi.mocked(sdk.cloudroom.machines.list).mockResolvedValue([home]);
  vi.mocked(sdk.cloudroom.machines.remove).mockRejectedValue(new Error("2 threads still run on this Core. Archive them first, then remove it."));
  mount(<CoreMachineRows />);
  fireEvent.click(await screen.findByText("Home server"));
  fireEvent.click(await screen.findByRole("button", { name: "Remove" }));
  expect((await screen.findByRole("alert")).textContent).toContain("2 threads still run on this Core");
  expect(sdk.cloudroom.machines.remove).toHaveBeenCalledWith(home.id);
});

it("keeps the only place for Cloud threads as the default until another is picked", async () => {
  vi.mocked(sdk.cloudroom.status).mockResolvedValue(signedOut);
  vi.mocked(sdk.cloudroom.machines.list).mockResolvedValue([home, vps]);
  vi.mocked(sdk.cloudroom.machines.update).mockResolvedValue([{ ...home, default: false }, { ...vps, default: true }]);
  mount(<CoreMachineRows />);
  fireEvent.click(await screen.findByText("Home server"));
  const pinned = await screen.findByRole("switch", { name: "Use for new Cloud threads" });
  await waitFor(() => expect((pinned as HTMLButtonElement).disabled).toBe(true));
  expect(screen.getByText("New Cloud threads go here until you pick another Core.")).toBeDefined();
  fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
  fireEvent.click(screen.getByText("VPS"));
  await waitFor(() => expect(screen.getByRole("heading", { name: "VPS" })).toBeDefined());
  const other = screen.getByRole("switch", { name: "Use for new Cloud threads" }) as HTMLButtonElement;
  expect(other.disabled).toBe(false);
  fireEvent.click(other);
  await waitFor(() => expect(sdk.cloudroom.machines.update).toHaveBeenCalledWith(vps.id, { default: true }));
});

it("says it is checking the Cores until the first list arrives, and when it fails", async () => {
  vi.mocked(sdk.cloudroom.status).mockResolvedValue(signedOut);
  vi.mocked(sdk.cloudroom.machines.list).mockReturnValue(new Promise(() => {}));
  mount(<CoreMachineRows />);
  expect(screen.getByRole("status").textContent).toContain("Checking your Cores");
  cleanup();
  vi.mocked(sdk.cloudroom.machines.list).mockRejectedValue(new Error("down"));
  mount(<CoreMachineRows />);
  expect((await screen.findByRole("alert")).textContent).toContain("Couldn't list your Cores");
});

it("offers copying logins to the Cores without an account", async () => {
  vi.mocked(sdk.cloudroom.status).mockResolvedValue({ ...signedOut, copyLogins: false, machines: [home] } as never);
  vi.mocked(sdk.cloudroom.machines.list).mockResolvedValue([home]);
  vi.mocked(sdk.cloudroom.setCopyLogins).mockResolvedValue(undefined as never);
  mount(<CoreMachineRows />);
  fireEvent.click(await screen.findByRole("switch", { name: "Auth my agents on my Cores automatically" }));
  await waitFor(() => expect(sdk.cloudroom.setCopyLogins).toHaveBeenCalledWith(true));
});
