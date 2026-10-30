// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Provider } from "jotai";
import { afterEach, expect, it, vi } from "vitest";
import { sdk } from "@/lib/sdk";
import { Onboarding } from "./Onboarding";

vi.mock("@/lib/sdk", () => ({ sdk: { cloudroom: { status: vi.fn(), connect: vi.fn(), signIn: vi.fn(), cancel: vi.fn() } } }));
vi.mock("@/lib/app-surface", () => ({ fetchWithAppSurface: vi.fn(async () => new Response("{}")) }));
vi.mock("@/components/ClaudeConnection", () => ({ useClaudeConnection: () => ({ data: null }) }));
vi.mock("@/components/layout/DesktopUpdateBanner", () => ({ GitForWindowsBanner: () => null }));
vi.mock("@/components/settings/ImportChats", () => ({ ImportChats: () => null }));
vi.mock("@/components/promptbox/NewThreadComposer", () => ({ selectCloudForNewThreads: vi.fn() }));
vi.mock("@/hooks/queries/sidebar-navigation-query", () => ({ useSidebarNavigation: () => ({ data: { projects: [] } }) }));
vi.mock("@/hooks/queries/system-queries", () => ({
  useSystemConfig: () => ({ data: { generalSettings: { defaultProviderId: "codex" } } }),
  useSystemProviders: () => ({ data: [] }),
}));
vi.mock("@/hooks/mutations/settings-mutations", () => ({ useUpdateGeneralSettings: () => ({ mutate: vi.fn() }) }));
vi.mock("@/hooks/thread-creation-options/persisted-selection-fields", () => ({ usePromptBoxProviderPreference: () => ({ setValue: vi.fn() }) }));
vi.mock("@/lib/bb-desktop", () => ({ getBbDesktopInfo: () => ({}), MACOS_APP_REGION_NO_DRAG_CLASS: "", MACOS_WINDOW_DRAG_CLASS: "" }));

const signedOut = { ready: false, account: null, projectId: null, repository: null, model: null, error: null, signingIn: false, signInError: null, selfHosted: false };
const clients: QueryClient[] = [];
afterEach(() => {
  cleanup();
  clients.forEach(client => client.clear());
  clients.length = 0;
  localStorage.clear();
  vi.clearAllMocks();
});
function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  clients.push(client);
  render(<Provider><QueryClientProvider client={client}><Onboarding /></QueryClientProvider></Provider>);
  return client;
}
it("connects a self-hosted Core from locked onboarding and dismisses the gate", async () => {
  vi.mocked(sdk.cloudroom.status).mockResolvedValue(signedOut);
  vi.mocked(sdk.cloudroom.connect).mockImplementation(async () => {
    vi.mocked(sdk.cloudroom.status).mockResolvedValue({ ...signedOut, selfHosted: true, ready: true });
  });
  mount();
  await screen.findByRole("dialog", { name: "Set up Cloudroom" });
  expect(screen.queryByRole("button", { name: "Skip setup" })).toBeNull();
  const token = screen.getByLabelText("Core API token") as HTMLInputElement;
  expect(token.type).toBe("password");
  fireEvent.change(screen.getByLabelText("Core URL"), { target: { value: "https://lab.example.ts.net" } });
  fireEvent.change(token, { target: { value: "private-test-token" } });
  fireEvent.click(screen.getByRole("button", { name: "Connect" }));
  await waitFor(() => expect(sdk.cloudroom.connect).toHaveBeenCalledExactlyOnceWith({ url: "https://lab.example.ts.net", token: "private-test-token" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(sdk.cloudroom.signIn).not.toHaveBeenCalled();
});
it("keeps a failed pairing editable without dismissing onboarding", async () => {
  vi.mocked(sdk.cloudroom.status).mockResolvedValue(signedOut);
  vi.mocked(sdk.cloudroom.connect).mockRejectedValue(new Error("Core is not reachable"));
  mount();
  fireEvent.change(await screen.findByLabelText("Core URL"), { target: { value: "https://lab.example.ts.net" } });
  fireEvent.change(screen.getByLabelText("Core API token"), { target: { value: "private-test-token" } });
  fireEvent.click(screen.getByRole("button", { name: "Connect" }));
  expect((await screen.findByRole("alert")).textContent).toBe("Core is not reachable");
  expect(screen.getByRole("dialog", { name: "Set up Cloudroom" })).toBeDefined();
});
it("does not reopen hosted onboarding for an existing offline self-hosted Core", async () => {
  vi.mocked(sdk.cloudroom.status).mockResolvedValue({ ...signedOut, selfHosted: true, error: "Core offline" });
  const client = mount();
  await waitFor(() => expect(client.getQueryState(["cloudroom-account"])?.status).toBe("success"));
  expect(screen.queryByRole("dialog")).toBeNull();
});
