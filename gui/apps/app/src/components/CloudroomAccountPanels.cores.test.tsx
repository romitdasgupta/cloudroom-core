// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { CloudroomAccountPanels } from "./CloudroomAccountPanels";

const status = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));
vi.mock("@/hooks/queries/cloudroom-queries", () => ({ useCloudroomAccount: () => ({ data: status.current }) }));
vi.mock("@/lib/bb-desktop", () => ({ getBbDesktopInfo: () => null }));
vi.mock("./CodexConnectionPanel", () => ({ CodexConnectionPanel: () => <div>codex panel</div>, CursorConnectionPanel: () => <div>cursor panel</div> }));
afterEach(() => { cleanup(); });

it("mounts the agent sign-in panels for an account, a self-hosted Core, or registered Cores, and not with nothing connected", () => {
  for (const [data, shown] of [
    [{ account: { id: "member" } }, true],
    [{ account: null, selfHosted: true }, true],
    [{ account: null, machines: [{ id: "m_000000000001" }] }, true],
    [{ account: null, machines: [] }, false],
  ] as const) {
    status.current = data;
    render(<CloudroomAccountPanels />);
    expect(screen.queryByText("codex panel") !== null).toBe(shown);
    cleanup();
  }
});
