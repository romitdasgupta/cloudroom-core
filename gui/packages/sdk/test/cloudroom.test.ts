import { expect, it } from "vitest";
import { createBbSdk } from "../src/core.js";
import { createHttpTransport } from "../src/transport-http.js";

it("exposes account status, sign-in, cancellation and local logout over the same API", async () => {
  const calls: { path: string; method: string; body: unknown }[] = [];
  const sdk = createBbSdk({ transport: createHttpTransport({ runtime: "node", baseUrl: "http://localhost:1234", fetch: async (input, init) => {
    calls.push({ path: new URL(String(input)).pathname, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : null });
    return Response.json(calls.length === 1 ? { account: null, ready: false } : calls.length === 2 ? { url: "https://www.cloudroom.dev/desktop" } : { ok: true });
  } }) });
  expect(await sdk.cloudroom.status()).toEqual({ account: null, ready: false });
  expect(await sdk.cloudroom.signIn()).toEqual({ url: "https://www.cloudroom.dev/desktop" });
  await sdk.cloudroom.cancel(); await sdk.cloudroom.logout();
  await sdk.cloudroom.retryStart("thread");
  await sdk.cloudroom.threadWorkspace("thread");
  await sdk.cloudroom.cursorAuth();
  await sdk.cloudroom.cursorLogin("cursor-login");
  await sdk.cloudroom.cancelCursorLogin("cursor-login");
  await sdk.cloudroom.cursorApiKey("cursor-key", "synthetic-key");
  expect(calls).toEqual([
    { path: "/api/v1/cloudroom/account", method: "GET", body: null },
    { path: "/api/v1/cloudroom/account/sign-in", method: "POST", body: {} },
    { path: "/api/v1/cloudroom/account/cancel", method: "POST", body: {} },
    { path: "/api/v1/cloudroom/account/logout", method: "POST", body: {} },
    { path: "/api/v1/cloudroom/threads/thread/retry-start", method: "POST", body: {} },
    { path: "/api/v1/cloudroom/threads/thread/workspace", method: "GET", body: null },
    { path: "/api/v1/cloudroom/account/cursor", method: "GET", body: null },
    { path: "/api/v1/cloudroom/account/cursor/login", method: "POST", body: { requestId: "cursor-login" } },
    { path: "/api/v1/cloudroom/account/cursor/cancel", method: "POST", body: { requestId: "cursor-login" } },
    { path: "/api/v1/cloudroom/account/cursor/key", method: "POST", body: { requestId: "cursor-key", apiKey: "synthetic-key" } },
  ]);
});

it("lists, adds, updates and removes self-hosted Cores", async () => {
  const calls: { path: string; method: string; body: unknown; contentType: string | null }[] = [];
  const sdk = createBbSdk({ transport: createHttpTransport({ runtime: "node", baseUrl: "http://localhost:1234", fetch: async (input, init) => {
    calls.push({ path: new URL(String(input)).pathname, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : null, contentType: new Headers(init?.headers).get("content-type") });
    return Response.json(calls.at(-1)!.path.endsWith("/teleport") ? { phase: "checking" } : { machines: [] });
  } }) });
  expect(await sdk.cloudroom.machines.list()).toEqual([]);
  expect(await sdk.cloudroom.machines.add({ name: "Home", url: "https://core.example", token: "t".repeat(40) })).toEqual([]);
  expect(await sdk.cloudroom.machines.update("m_aaaaaaaaaaaa", { default: true })).toEqual([]);
  expect(await sdk.cloudroom.machines.remove("m_aaaaaaaaaaaa")).toEqual([]);
  await sdk.cloudroom.teleport("t", "start", undefined, "m_aaaaaaaaaaaa");
  expect(calls).toEqual([
    { path: "/api/v1/cloudroom/machines", method: "GET", body: null, contentType: "application/json" },
    { path: "/api/v1/cloudroom/machines", method: "POST", body: { name: "Home", url: "https://core.example", token: "t".repeat(40) }, contentType: "application/json" },
    { path: "/api/v1/cloudroom/machines/m_aaaaaaaaaaaa", method: "PATCH", body: { default: true }, contentType: "application/json" },
    { path: "/api/v1/cloudroom/machines/m_aaaaaaaaaaaa", method: "DELETE", body: {}, contentType: "application/json" },
    { path: "/api/v1/cloudroom/threads/t/teleport", method: "POST", body: { action: "start", machine: "m_aaaaaaaaaaaa" }, contentType: "application/json" },
  ]);
});

it("sends Claude sign-in to a thread's own Core only when a thread is given", async () => {
  const calls: { url: string; method: string; body: unknown }[] = [];
  const sdk = createBbSdk({ transport: createHttpTransport({ runtime: "node", baseUrl: "http://localhost:1234", fetch: async (input, init) => {
    const url = new URL(String(input));
    calls.push({ url: url.pathname + url.search, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : null });
    return Response.json({ state: "missing" });
  } }) });
  await sdk.cloudroom.claudeAuth();
  await sdk.cloudroom.claudeAuth({ threadId: "t 1" });
  await sdk.cloudroom.claudeAuth({ action: "setup-token", requestId: "r" });
  await sdk.cloudroom.claudeAuth({ action: "setup-token", requestId: "r", threadId: "t1" });
  await sdk.cloudroom.claudeAuth({ action: "key", requestId: "r", apiKey: "sk-ant-x", threadId: "t1" });
  await sdk.cloudroom.claudeAuth({ action: "token", requestId: "r", token: "sk-ant-oat-x", threadId: "t1" });
  expect(calls).toEqual([
    { url: "/api/v1/cloudroom/account/claude", method: "GET", body: null },
    { url: "/api/v1/cloudroom/account/claude?thread=t%201", method: "GET", body: null },
    { url: "/api/v1/cloudroom/account/claude/setup-token", method: "POST", body: { requestId: "r" } },
    { url: "/api/v1/cloudroom/account/claude/setup-token", method: "POST", body: { requestId: "r", threadId: "t1" } },
    { url: "/api/v1/cloudroom/account/claude/key", method: "POST", body: { requestId: "r", apiKey: "sk-ant-x", threadId: "t1" } },
    { url: "/api/v1/cloudroom/account/claude/token", method: "POST", body: { requestId: "r", token: "sk-ant-oat-x" } },
  ]);
});
