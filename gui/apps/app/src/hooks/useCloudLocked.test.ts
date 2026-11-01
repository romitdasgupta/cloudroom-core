// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { useCloudLocked } from "./useCloudLocked";

const status = vi.hoisted(() => ({ current: {} as { account?: { id: string } | null; selfHosted?: boolean; machines?: { id: string }[] } }));
vi.mock("@/hooks/queries/cloudroom-queries", () => ({ useCloudroomAccount: () => ({ isSuccess: true, data: status.current }) }));
vi.mock("@/lib/sdk", () => ({ sdk: { cloudroom: { signIn: vi.fn() } } }));
vi.mock("@/lib/url-open-routing", () => ({ openUrlInExternalBrowser: vi.fn() }));

it("own Cores unlock Cloud while signed out, but not for a fork, which only Cloudroom Cloud runs", () => {
  status.current = { account: null, machines: [] };
  expect(renderHook(() => useCloudLocked()).result.current).toBe(true);
  status.current = { account: null, machines: [{ id: "m_000000000001" }] };
  expect(renderHook(() => useCloudLocked()).result.current).toBe(false);
  expect(renderHook(() => useCloudLocked(true)).result.current).toBe(true);
  status.current = { account: { id: "member" }, machines: [{ id: "m_000000000001" }] };
  expect(renderHook(() => useCloudLocked(true)).result.current).toBe(false);
});
