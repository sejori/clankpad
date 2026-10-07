import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { Aggregator } from "../src/aggregator.ts";
import { loadConfig } from "../src/config.ts";
import { createHttpServer } from "../src/http.ts";
import { Service } from "../src/service.ts";
import { MemoryStore } from "../src/store.ts";

const cfg = { ...loadConfig(), identityMode: "tailscale" as const, rebuildDebounceMs: 1, rebuildIntervalMs: 0, llm: { ...loadConfig().llm, apiKey: undefined } };
const store = new MemoryStore();
const agg = new Aggregator(store, cfg, () => {});
const server = createHttpServer(cfg, store, new Service(store, agg, cfg));
let base = "";

before(async () => {
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => {
  agg.stop();
  server.close();
});

const as = (user: string | null, init: RequestInit = {}) => ({
  ...init,
  headers: { "content-type": "application/json", ...(user ? { "tailscale-user-login": user } : {}), ...init.headers },
});

test("rejects callers without a tailscale identity", async () => {
  assert.equal((await fetch(`${base}/v1/whoami`, as(null))).status, 401);
  assert.equal((await fetch(`${base}/healthz`)).status, 200);
});

test("log, read, scratchpad, remove", async () => {
  const who = await (await fetch(`${base}/v1/whoami`, as("Seb@Doubleword.ai"))).json();
  assert.deepEqual(who, { user: "seb@doubleword.ai" });

  const bad = await fetch(`${base}/v1/logs/me/projects`, as("seb@doubleword.ai", { method: "POST", body: JSON.stringify({ summary: "x" }) }));
  assert.equal(bad.status, 400);

  const post = await fetch(
    `${base}/v1/logs/me/projects`,
    as("seb@doubleword.ai", { method: "POST", body: JSON.stringify({ name: "Clankpad MVP", summary: "building it", repos: ["sejori/clankpad"] }) }),
  );
  assert.equal(post.status, 200);
  const log = await post.json();
  assert.equal(log.projects[0].slug, "clankpad-mvp");

  await fetch(`${base}/v1/logs/me/projects`, as("fergus@doubleword.ai", { method: "POST", body: JSON.stringify({ name: "everything" }) }));

  const rebuilt = await (await fetch(`${base}/v1/scratchpad/rebuild`, as("seb@doubleword.ai", { method: "POST" }))).json();
  assert.equal(rebuilt.model, null);
  const md = await (await fetch(`${base}/v1/scratchpad?format=md`, as("rushil@doubleword.ai"))).text();
  assert.match(md, /## fergus@doubleword\.ai/);
  assert.match(md, /Clankpad MVP/);

  const activity = await (await fetch(`${base}/v1/activity?days=1`, as("seb@doubleword.ai"))).json();
  assert.equal(activity.length, 2);

  const del = await fetch(`${base}/v1/logs/me/projects/Clankpad%20MVP`, as("seb@doubleword.ai", { method: "DELETE" }));
  assert.equal(del.status, 200);
  assert.equal((await del.json()).log.projects.length, 0);
  assert.equal((await fetch(`${base}/v1/logs/me/projects/nope`, as("seb@doubleword.ai", { method: "DELETE" }))).status, 404);
});

test("MCP endpoint lists and calls tools as the tailscale user", async () => {
  const rpc = async (method: string, params: unknown, id = 1) => {
    const res = await fetch(
      `${base}/mcp`,
      as("rushil@doubleword.ai", {
        method: "POST",
        headers: { accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
      }),
    );
    assert.equal(res.status, 200, await res.clone().text());
    return res.json();
  };

  const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } });
  assert.equal(init.result.serverInfo.name, "clankpad");

  const tools = await rpc("tools/list", {}, 2);
  assert.deepEqual(
    tools.result.tools.map((t: { name: string }) => t.name).sort(),
    ["get_scratchpad", "get_team_activity", "list_my_projects", "log_project", "remove_project"],
  );

  const logged = await rpc("tools/call", { name: "log_project", arguments: { name: "routing", summary: "x" } }, 3);
  assert.match(logged.result.content[0].text, /"user": "rushil@doubleword.ai"/);
});
