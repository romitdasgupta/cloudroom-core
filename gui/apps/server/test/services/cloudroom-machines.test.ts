import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import * as sync from "../../src/services/cloudroom/sync.js";
import { cloudroom, copyKey } from "../../src/services/cloudroom/commands.js";
import { SandboxDirectory } from "../../src/services/cloudroom/sandboxes.js";
import { authRequiredMessages } from "../../src/services/cloudroom/client.js";
import { createTestAppHarness } from "../helpers/test-app.js";
import { seedHostSession, seedProjectWithSource } from "../helpers/seed.js";
import { archiveThread, cloudroomThreads, createThread, unarchiveThread } from "@cloudroom/db";

const TOKEN = "core-token-" + "x".repeat(40);
const UUID_A = "11111111-1111-4111-8111-111111111111", UUID_B = "22222222-2222-4222-8222-222222222222";
const WEBSITE = "http://127.0.0.1:9";
type FakeCore = { url: string; starts: string[]; requests: string[]; server: Server };

afterEach(() => { vi.restoreAllMocks(); });

/** A Core that answers health, readiness, capabilities, and session starts. `mode` makes it refuse or hang. */
async function fakeCore(name: string, options: { mode?: "ok" | "unauthorized" | "hang"; sync?: boolean; claude?: "connected" } = {}): Promise<FakeCore> {
  const starts: string[] = [], requests: string[] = [];
  const server = createServer(async (req, res) => {
    requests.push(`${req.method} ${req.url}`);
    if (options.mode === "hang") return;
    const json = (body: unknown, status = 200) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
    if (options.mode === "unauthorized") return json({ error: "unauthorized" }, 401);
    if (req.url === "/v1/health") return json({});
    if (req.url === "/v1/ready") return json({ ready: true });
    if (req.url === "/v1/accounts/codex" || req.url === "/v1/accounts/claude") return json({ state: req.url === "/v1/accounts/claude" && options.claude ? options.claude : "missing", email: null, plan: null, message: null, login_id: null, verification_url: null, user_code: null });
    if (req.url === "/v1/capabilities") return json({ version: 1, repository: `/code/${name}`, stop: true, resume: true, launch_settings: true, direct_workspaces: true, root_workspace: true, codex_auth: true, claude_auth: true, sync: options.sync ?? false, harnesses: [{ id: "codex", model: "test-model", models: [{ model: "test-model", reasoning_levels: ["medium", "high"] }] }] });
    if (req.url?.includes("/stream?")) { res.writeHead(200, { "Content-Type": "text/event-stream" }); res.end(); return; }
    if (req.method !== "POST") return json({}, 404);
    let text = ""; for await (const chunk of req) text += chunk;
    const body = text ? JSON.parse(text) : {};
    if (req.url === "/v1/sessions") { starts.push(body.request_id); return json({ session_id: `cr_${name}`, receipt: { request_id: body.request_id, command: "start", state: "accepted", input: {} }, saving: {} }, 202); }
    json({ session_id: `cr_${name}`, receipt: { request_id: body.request_id ?? "r", command: "prompt", state: "accepted", input: {} }, saving: {} }, 202);
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); if (!address || typeof address === "string") throw new Error("fixture did not listen");
  return { url: `http://127.0.0.1:${address.port}`, starts, requests, server };
}

async function deadUrl(): Promise<string> {
  const server = createServer(); server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); if (!address || typeof address === "string") throw new Error("fixture did not listen");
  await new Promise<void>(resolve => server.close(() => resolve()));
  return `http://127.0.0.1:${address.port}`;
}

async function setup(...names: (string | [string, Parameters<typeof fakeCore>[1]])[]) {
  vi.spyOn(sync, "setupSync").mockResolvedValue();
  vi.spyOn(sync, "stopSync").mockResolvedValue();
  const harness = await createTestAppHarness();
  const { host } = seedHostSession(harness.deps);
  const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });
  const service = cloudroom(harness.deps);
  const cores = await Promise.all(names.map(entry => typeof entry === "string" ? fakeCore(entry) : fakeCore(entry[0], entry[1])));
  const path = join(harness.deps.config.dataDir, "cloudroom.json");
  const request = (url: string, body?: unknown, method = body === undefined ? "GET" : "POST", headers: Record<string, string> = {}) =>
    harness.app.request(`/api/v1${url}`, { method, headers: { "Content-Type": "application/json", ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const machines = async () => (await (await request("/cloudroom/machines")).json()).machines as { id: string; name: string; url: string; default: boolean; ready: boolean; error: string | null; harnesses: unknown; threads: number }[];
  const add = async (name: string, url: string) => {
    const response = await request("/cloudroom/machines", { name, url, token: TOKEN });
    expect(response.status).toBe(200);
    return (await machines()).find(m => m.url === url)!;
  };
  const input = { executionTarget: "cloud", projectId: project.id, providerId: "codex", origin: "app", model: "test-model", reasoningLevel: "high", environment: { type: "project-default" }, input: [{ type: "text", text: "Hello", mentions: [] }] };
  const createCloud = (extra: Record<string, unknown> = {}) => request("/threads", { ...input, ...extra });
  const coreUrlOf = (threadId: string) => harness.db.select().from(cloudroomThreads).where(eq(cloudroomThreads.threadId, threadId)).get()?.coreUrl;
  const created = async (extra: Record<string, unknown> = {}) => {
    const response = await createCloud(extra);
    expect(response.status, await response.clone().text()).toBe(201);
    const thread = await response.json() as { id: string };
    return { id: thread.id, coreUrl: coreUrlOf(thread.id) };
  };
  /** A Cloud thread row bound to `coreUrl`, as an older app or another source left it. */
  const seeded = (coreUrl: string) => {
    const thread = createThread(harness.db, harness.hub, { projectId: project.id, executionTarget: "cloud", providerId: "codex", status: "idle" });
    harness.db.insert(cloudroomThreads).values({ threadId: thread.id, coreUrl, sessionId: `cr_${thread.id}`, startRequestId: thread.id, model: "test-model", reasoning: "high" }).run();
    return thread;
  };
  const saved = async () => JSON.parse(await readFile(path, "utf8"));
  const cleanup = async () => {
    service.stop();
    for (const core of cores) { core.server.closeAllConnections(); await new Promise<void>(resolve => core.server.close(() => resolve())); }
    await harness.cleanup();
  };
  return { harness, service, project, cores, path, request, machines, add, input, createCloud, created, coreUrlOf, seeded, saved, cleanup };
}

it("adds, lists, and validates Cores without returning tokens", async () => {
  const t = await setup("a", ["bad", { mode: "unauthorized" }]);
  const [a, bad] = t.cores as [FakeCore, FakeCore];
  try {
    const response = await t.request("/cloudroom/machines", { name: "A", url: a.url, token: TOKEN });
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).not.toContain(TOKEN);
    expect(JSON.parse(text).machines).toEqual([{ id: expect.stringMatching(/^m_[0-9a-f]{12}$/), name: "A", url: a.url, default: true, ready: true, error: null, harnesses: [expect.objectContaining({ id: "codex" })], threads: 0,
      steer: false, rewind: false, compact: false, queue_edit: false, queue_cancel: false, queue_reorder: false }]);
    expect((await stat(t.path)).mode & 0o777).toBe(0o600);
    expect((await t.saved()).machines[0].token).toBe(TOKEN);
    expect((await t.saved()).defaultMachine).toBeUndefined();
    const duplicate = await t.request("/cloudroom/machines", { name: "Again", url: `${a.url}/`, token: TOKEN });
    expect(duplicate.status).toBe(409);
    expect(await duplicate.json()).toMatchObject({ code: "cloudroom_machine_exists" });
    const short = await t.request("/cloudroom/machines", { name: "Short", url: "https://core.example.invalid", token: "short" });
    expect(short.status).toBe(400);
    expect(await short.json()).toMatchObject({ code: "invalid_request" });
    const http = await t.request("/cloudroom/machines", { name: "Plain", url: "http://example.invalid", token: TOKEN });
    expect(http.status).toBe(400);
    expect(await http.json()).toMatchObject({ code: "cloudroom_machine_unreachable" });
    const dead = await t.request("/cloudroom/machines", { name: "Dead", url: await deadUrl(), token: TOKEN });
    expect(dead.status).toBe(503);
    expect(await dead.json()).toMatchObject({ code: "cloudroom_machine_unreachable" });
    const refused = await t.request("/cloudroom/machines", { name: "Refused", url: bad.url, token: TOKEN });
    expect(refused.status).toBe(400);
    const remote = await t.request("/cloudroom/machines", { name: "Remote", url: bad.url, token: TOKEN }, "POST", { "x-bb-gate-auth": "session" });
    expect(remote.status).toBe(403);
    expect(await t.machines()).toHaveLength(1);
    expect((await t.request("/cloudroom/machines/m_000000000000", { name: "x" }, "PATCH")).status).toBe(404);
    expect((await t.request("/cloudroom/machines/m_000000000000", {}, "DELETE")).status).toBe(404);
    expect((await t.request("/cloudroom/machines/nope", {}, "DELETE")).status).toBe(404);
  } finally { await t.cleanup(); }
}, 20_000);

it("places new threads on the picked Core, the default, or nowhere when Cloud is picked", async () => {
  const t = await setup("a", "b");
  const [a, b] = t.cores as [FakeCore, FakeCore];
  try {
    const machineA = await t.add("A", a.url), machineB = await t.add("B", b.url);
    expect(machineA.default).toBe(true);
    expect(machineB.default).toBe(false);
    const onB = await t.created({ cloudMachine: machineB.id });
    expect(onB.coreUrl).toBe(b.url);
    await expect.poll(() => b.starts.length).toBe(1);
    expect(a.starts).toHaveLength(0);
    expect((await t.created()).coreUrl).toBe(a.url);
    expect((await t.request(`/cloudroom/machines/${machineB.id}`, { default: true }, "PATCH")).status).toBe(200);
    expect((await t.machines()).map(m => [m.id, m.default])).toEqual([[machineA.id, false], [machineB.id, true]]);
    expect((await t.saved()).defaultMachine).toBe(machineB.id);
    expect((await t.created()).coreUrl).toBe(b.url);
    const unknown = await t.createCloud({ cloudMachine: "m_000000000000" });
    expect(unknown.status).toBe(400);
    expect(await unknown.json()).toMatchObject({ code: "cloudroom_machine_unknown" });
    for (const pick of [{ cloudTarget: "cloud" }, { cloudMachine: "cloud" }]) {
      const cloud = await t.createCloud(pick);
      expect(cloud.status).toBe(503);
      expect(await cloud.json()).toMatchObject({ code: "cloudroom_not_configured" });
    }
    // Teleports pick the same way.
    await t.service.teleportClient("teleport-a", machineA.id);
    expect(t.service.teleportUrl("teleport-a")).toBe(a.url);
    await t.service.teleportClient("teleport-default");
    expect(t.service.teleportUrl("teleport-default")).toBe(b.url);
    // A child of a thread on a Core stays there, even with another default.
    expect((await t.request(`/cloudroom/machines/${machineA.id}`, { default: true }, "PATCH")).status).toBe(200);
    const child = await t.service.create({ ...t.input, parentThreadId: onB.id } as never);
    expect(t.coreUrlOf(child.id)).toBe(b.url);
  } finally { await t.cleanup(); }
}, 20_000);

it("keeps the self-hosted primary working next to machines", async () => {
  const t = await setup("p", "b");
  const [p, b] = t.cores as [FakeCore, FakeCore];
  try {
    await t.service.configure({ url: p.url, token: TOKEN });
    const machineB = await t.add("B", b.url);
    expect((await t.machines()).map(m => ({ id: m.id, name: m.name, default: m.default, ready: m.ready }))).toEqual([
      { id: "primary", name: "127.0.0.1", default: false, ready: true },
      { id: machineB.id, name: "B", default: false, ready: true },
    ]);
    // connection() must not choke on the new fields (critic C1).
    expect(await (await t.request("/cloudroom")).json()).toMatchObject({ ready: true, selfHosted: true, machines: expect.any(Array) });
    expect((await t.created()).coreUrl).toBe(p.url);
    await expect.poll(() => p.starts.length).toBe(1);
    expect((await t.created({ cloudMachine: "primary" })).coreUrl).toBe(p.url);
    expect((await t.created({ cloudMachine: machineB.id })).coreUrl).toBe(b.url);
    const rename = await t.request("/cloudroom/machines/primary", { name: "x" }, "PATCH");
    expect(rename.status).toBe(400);
    expect(await rename.json()).toMatchObject({ code: "cloudroom_machine_primary" });
    expect((await t.request("/cloudroom/machines/primary", { default: true }, "PATCH")).status).toBe(200);
    expect((await t.machines()).find(m => m.id === "primary")?.default).toBe(true);
  } finally { await t.cleanup(); }
}, 20_000);

it("refuses to remove a Core in use, and names a removed Core on its threads", async () => {
  const t = await setup("p", "b");
  const [p, b] = t.cores as [FakeCore, FakeCore];
  try {
    const machineB = await t.add("B", b.url);
    const thread = await t.created({ cloudMachine: machineB.id });
    expect((await t.machines())[0]?.threads).toBe(1);
    const inUse = await t.request(`/cloudroom/machines/${machineB.id}`, {}, "DELETE");
    expect(inUse.status).toBe(409);
    expect(await inUse.json()).toMatchObject({ code: "cloudroom_machine_in_use", message: expect.stringContaining("1 thread still runs") });
    expect(await t.machines()).toHaveLength(1);
    archiveThread(t.harness.db, t.harness.hub, thread.id);
    await mkdir(join(t.harness.deps.config.dataDir, "cloudroom-preview"), { recursive: true });
    await writeFile(join(t.harness.deps.config.dataDir, "cloudroom-preview", "config.json"), JSON.stringify({ device: "mac-1" }));
    expect((await t.request(`/cloudroom/machines/${machineB.id}`, {}, "DELETE")).status).toBe(200);
    expect(await t.machines()).toEqual([]);
    // The removed Core forgets this computer's preview device, as sign-out does.
    await expect.poll(() => b.requests).toContain("DELETE /v1/previews/device/mac-1");
    expect((await t.saved()).removedMachines).toEqual([b.url]);
    unarchiveThread(t.harness.db, t.harness.hub, thread.id);
    // Its status says so before any action, not only when one is tried.
    expect(t.service.threadStatus(thread.id)).toMatchObject({ error: expect.stringMatching(/Core was removed/), machine: null });
    await expect(t.service.threadClient(thread.id)).rejects.toMatchObject({ body: { code: "cloudroom_connection_changed", message: expect.stringMatching(/removed/) } });
    await t.add("B again", b.url);
    expect((await t.saved()).removedMachines).toBeUndefined();
    expect(t.service.threadStatus(thread.id)).toMatchObject({ error: null, machine: { name: "B again" } });
    await expect(t.service.threadClient(thread.id)).resolves.toBeDefined();
    await t.service.configure({ url: p.url, token: TOKEN });
    const stranger = t.seeded("http://127.0.0.1:1");
    await expect(t.service.threadClient(stranger.id)).rejects.toMatchObject({ body: { code: "cloudroom_connection_changed" } });
  } finally { await t.cleanup(); }
}, 20_000);

it("no longer refuses a primary while threads run on registered Cores", async () => {
  const t = await setup("p", "b", "q");
  const [p, b, q] = t.cores as [FakeCore, FakeCore, FakeCore];
  try {
    const machineB = await t.add("B", b.url);
    await t.created({ cloudMachine: machineB.id });
    await expect(t.service.configure({ url: p.url, token: TOKEN })).resolves.toBeUndefined();
    await expect(t.service.configure({ url: b.url, token: TOKEN })).rejects.toMatchObject({ body: { code: "cloudroom_machine_exists" } });
    t.seeded("http://127.0.0.1:1");
    await expect(t.service.configure({ url: q.url, token: TOKEN })).rejects.toMatchObject({ body: { code: "cloudroom_connection_in_use" } });
  } finally { await t.cleanup(); }
}, 20_000);

it("keeps machines through sign-in, account switch, and sign-out, adopting the self-hosted primary", async () => {
  const t = await setup("p", "b");
  const [p, b] = t.cores as [FakeCore, FakeCore];
  vi.spyOn(SandboxDirectory.prototype, "forNewThreads").mockResolvedValue(true);
  try {
    await t.service.configure({ url: p.url, token: TOKEN });
    const pThread = await t.created();
    expect(pThread.coreUrl).toBe(p.url);
    const machineB = await t.add("B", b.url);
    expect((await t.request(`/cloudroom/machines/${machineB.id}`, { default: true }, "PATCH")).status).toBe(200);
    const bThread = await t.created();
    expect(bThread.coreUrl).toBe(b.url);
    await t.service.configure(null, { id: UUID_A, email: "a@example.com" }, undefined, WEBSITE, "a".repeat(64));
    const signedIn = await t.saved();
    expect(signedIn).toMatchObject({ account: { id: UUID_A }, sandboxToken: "a".repeat(64), defaultMachine: machineB.id });
    expect(signedIn.url).toBeUndefined();
    expect(signedIn.machines).toEqual([expect.objectContaining({ id: machineB.id, url: b.url }), expect.objectContaining({ id: expect.stringMatching(/^m_/), url: p.url, name: "127.0.0.1", token: TOKEN })]);
    await expect(t.service.threadClient(pThread.id)).resolves.toBeDefined();
    expect((await t.created()).coreUrl).toBe(b.url);
    await t.service.configure(null, { id: UUID_B, email: "b@example.com" }, undefined, WEBSITE, "b".repeat(64));
    for (const id of [pThread.id, bThread.id]) expect(t.harness.db.select().from(cloudroomThreads).where(eq(cloudroomThreads.threadId, id)).get()?.accountId).toBeNull();
    await expect(t.service.threadClient(bThread.id)).resolves.toBeDefined();
    await t.service.disconnect();
    const signedOut = await t.saved();
    expect(signedOut.sandboxToken).toBeUndefined();
    expect(signedOut.defaultMachine).toBe(machineB.id);
    expect(signedOut.machines).toHaveLength(2);
  } finally { await t.cleanup(); }
}, 20_000);

it("reports each Core's status, and one down or slow Core doesn't hold status up", async () => {
  const t = await setup("a", ["slow", { mode: "hang" }]);
  const [a, slow] = t.cores as [FakeCore, FakeCore];
  try {
    await t.add("A", a.url);
    const file = await t.saved();
    file.machines.push({ id: "m_dddddddddddd", name: "Dead", url: await deadUrl(), token: "x".repeat(40) }, { id: "m_eeeeeeeeeeee", name: "Slow", url: slow.url, token: "x".repeat(40) });
    await writeFile(t.path, JSON.stringify(file), { mode: 0o600 });
    const started = Date.now();
    const response = await t.request("/cloudroom");
    expect(Date.now() - started).toBeLessThan(7000);
    const text = await response.text();
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain("x".repeat(40));
    const status = JSON.parse(text);
    expect(status).toMatchObject({ ready: true, machines: [
      { name: "A", ready: true, error: null, default: true },
      { name: "Dead", ready: false, harnesses: null, error: expect.any(String) },
      { name: "Slow", ready: false, harnesses: null, error: expect.stringMatching(/5 seconds|timed out/i) },
    ] });
    expect((await (await t.request("/cloudroom/account")).json()).machines).toHaveLength(3);
  } finally { await t.cleanup(); }
}, 20_000);

it("sends children of sandbox threads to sandboxes, and keeps no stored fallback default", async () => {
  const t = await setup("a");
  const [a] = t.cores as [FakeCore];
  vi.spyOn(SandboxDirectory.prototype, "forNewThreads").mockResolvedValue(true);
  try {
    const machineA = await t.add("A", a.url);
    expect((await t.saved()).defaultMachine).toBeUndefined();
    await t.service.configure(null, { id: UUID_A, email: "a@example.com" }, undefined, WEBSITE, "a".repeat(64));
    expect((await t.machines())[0]?.default).toBe(false);
    expect((await t.created()).coreUrl).toMatch(/^sandbox:/);
    expect((await t.request(`/cloudroom/machines/${machineA.id}`, { default: true }, "PATCH")).status).toBe(200);
    const parent = createThread(t.harness.db, t.harness.hub, { projectId: t.project.id, executionTarget: "cloud", providerId: "codex", status: "idle" });
    t.harness.db.insert(cloudroomThreads).values({ threadId: parent.id, coreUrl: `sandbox:${parent.id}`, sessionId: "cr_parent", startRequestId: parent.id, model: "test-model", reasoning: "high" }).run();
    const child = await t.service.create({ ...t.input, parentThreadId: parent.id } as never);
    expect(t.coreUrlOf(child.id)).toBe(`sandbox:${child.id}`);
    const picked = await t.service.create({ ...t.input, parentThreadId: parent.id, cloudMachine: machineA.id } as never);
    expect(t.coreUrlOf(picked.id)).toBe(a.url);
    expect((await t.created()).coreUrl).toBe(a.url);
  } finally { await t.cleanup(); }
}, 20_000);

it("keeps sync on the primary when another Core is the default", async () => {
  const t = await setup(["p", { sync: true }], "b");
  const [p, b] = t.cores as [FakeCore, FakeCore];
  vi.spyOn(sync, "syncStatus").mockResolvedValue({ state: "synced", conflicts: 0 });
  try {
    await t.service.configure({ url: p.url, token: TOKEN });
    const machineB = await t.add("B", b.url);
    await t.service.status();
    expect((await t.request(`/cloudroom/machines/${machineB.id}`, { default: true }, "PATCH")).status).toBe(200);
    expect(await t.service.status()).toMatchObject({ ready: true, sync: { state: "synced" } });
  } finally { await t.cleanup(); }
}, 20_000);

it("keys project copies by Core", () => {
  expect(copyKey(null, "w", "https://a.example")).not.toBe(copyKey(null, "w", "https://b.example"));
  expect(copyKey("t1", "w", "sandbox:t1")).toBe("t1:w");
});

it("refuses to remove a Core while a new thread is starting on it", async () => {
  const t = await setup("b");
  const [b] = t.cores as [FakeCore];
  try {
    const machineB = await t.add("B", b.url);
    const service = t.service as unknown as { capabilities: (...args: unknown[]) => Promise<unknown> };
    const real = service.capabilities.bind(t.service);
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(service, "capabilities").mockImplementation(async (...args) => { await held; return real(...args); });
    const creating = t.created({ cloudMachine: machineB.id });
    await expect.poll(() => (t.service as unknown as { placements: Map<string, number> }).placements.has(b.url)).toBe(true);
    const removing = await t.request(`/cloudroom/machines/${machineB.id}`, {}, "DELETE");
    expect(removing.status).toBe(409);
    expect(await removing.json()).toMatchObject({ code: "cloudroom_machine_in_use", message: expect.stringContaining("starting") });
    release();
    expect((await creating).coreUrl).toBe(b.url);
  } finally { await t.cleanup(); }
}, 20_000);

it("signs in without writing a file it can't read back", async () => {
  const t = await setup();
  try {
    const long = `https://${"a".repeat(60)}.example.invalid`;
    await writeFile(t.path, JSON.stringify({ url: long, token: TOKEN }), { mode: 0o600 });
    await t.service.configure(null, { id: UUID_A, email: "a@example.com" }, undefined, WEBSITE, "a".repeat(64));
    expect((await t.saved()).machines).toEqual([expect.objectContaining({ url: long, name: "a".repeat(60) + ".exa" })]);
    await expect(t.service.isMachineUrl(long)).resolves.toBe(true);
    const full = Array.from({ length: 32 }, (_, n) => ({ id: `m_${n.toString(16).padStart(12, "0")}`, name: `M${n}`, url: `https://m${n}.example.invalid`, token: TOKEN }));
    await writeFile(t.path, JSON.stringify({ url: "https://p.example.invalid", token: TOKEN, machines: full }), { mode: 0o600 });
    await expect(t.service.configure(null, { id: UUID_A, email: "a@example.com" }, undefined, WEBSITE, "a".repeat(64))).rejects.toMatchObject({ body: { code: "cloudroom_machine_limit" } });
    expect((await t.saved()).machines).toHaveLength(32);
    await expect(t.service.isMachineUrl("https://m0.example.invalid")).resolves.toBe(true);
  } finally { await t.cleanup(); }
}, 20_000);

it("signs Codex in on the thread's own Core, not the default one", async () => {
  const t = await setup("a", "b");
  const [a, b] = t.cores as [FakeCore, FakeCore];
  try {
    await t.add("A", a.url); await t.add("B", b.url);
    const thread = t.seeded(b.url);
    const onThread = await t.request(`/cloudroom/account/codex?thread=${thread.id}`);
    expect(onThread.status, await onThread.clone().text()).toBe(200);
    expect(await onThread.json()).toMatchObject({ state: "missing" });
    expect(b.requests).toContain("GET /v1/accounts/codex");
    expect(a.requests).not.toContain("GET /v1/accounts/codex");
    expect((await t.request("/cloudroom/account/codex")).status).toBe(200);
    expect(a.requests).toContain("GET /v1/accounts/codex");
  } finally { await t.cleanup(); }
}, 20_000);

it("signs Claude Code in on the thread's own Core, not the default one", async () => {
  const t = await setup("a", "b");
  const [a, b] = t.cores as [FakeCore, FakeCore];
  try {
    await t.add("A", a.url); await t.add("B", b.url);
    const thread = t.seeded(b.url);
    const onThread = await t.request(`/cloudroom/account/claude?thread=${thread.id}`);
    expect(onThread.status, await onThread.clone().text()).toBe(200);
    expect(await onThread.json()).toMatchObject({ state: "missing" });
    expect(b.requests).toContain("GET /v1/accounts/claude");
    expect(a.requests).not.toContain("GET /v1/accounts/claude");
    expect((await t.request("/cloudroom/account/claude")).status).toBe(200);
    expect(a.requests).toContain("GET /v1/accounts/claude");
  } finally { await t.cleanup(); }
}, 20_000);

it("resumes Claude starts only on the Core a sign-in reached, including one first seen connected", async () => {
  const t = await setup(["a", { claude: "connected" }], ["b", { claude: "connected" }]);
  const [a, b] = t.cores as [FakeCore, FakeCore];
  try {
    await t.add("A", a.url); await t.add("B", b.url);
    const signInNeeded = [...authRequiredMessages].find(message => message.includes("Claude"))!;
    const waiting = (coreUrl: string) => {
      const thread = createThread(t.harness.db, t.harness.hub, { projectId: t.project.id, executionTarget: "cloud", providerId: "claude-code", status: "idle" });
      t.harness.db.insert(cloudroomThreads).values({ threadId: thread.id, coreUrl, startRequestId: thread.id, model: "test-model", reasoning: "high", error: signInNeeded }).run();
      return thread.id;
    };
    const [onA, onB] = [waiting(a.url), waiting(b.url)];
    const retried = vi.spyOn(t.service as unknown as { retryStart: (threadId: string) => Promise<void> }, "retryStart").mockResolvedValue();
    // The default sign-in (Settings) reached Core A only.
    expect(await (await t.request("/cloudroom/account/claude")).json()).toMatchObject({ state: "connected" });
    await vi.waitFor(() => expect(retried).toHaveBeenCalledWith(onA));
    expect(retried).not.toHaveBeenCalledWith(onB);
    // Core B's login finished in the background: the first status check that sees it connected resumes B's starts.
    expect(await (await t.request(`/cloudroom/account/claude?thread=${onB}`)).json()).toMatchObject({ state: "connected" });
    await vi.waitFor(() => expect(retried).toHaveBeenCalledWith(onB));
  } finally { await t.cleanup(); }
}, 20_000);
