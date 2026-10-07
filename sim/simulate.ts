/**
 * Simulates two weeks of team activity against Redis + a real LLM and validates
 * the scratchpad after every rebuild.
 *
 *   docker run -d --name cp-redis -p 6379:6379 redis:7-alpine
 *   LLM_API_KEY=... node --experimental-strip-types sim/simulate.ts
 *
 * Writes go through Service.logProject (the same path as the HTTP API) with a
 * fake clock stepped from 13 days ago to now. Results land in sim/out/.
 */
import { mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { Aggregator } from "../src/aggregator.ts";
import { compactActivity } from "../src/llm.ts";
import { loadConfig } from "../src/config.ts";
import { Service } from "../src/service.ts";
import { RedisStore } from "../src/store.ts";
import { buildActivity } from "../src/activity.ts";
import { daysAgo } from "../src/util.ts";
import { Redis } from "ioredis";

const DAYS = Number(process.env.SIM_DAYS ?? 14);
const BURSTS_PER_DAY = Number(process.env.SIM_BURSTS ?? 2);
const PREFIX = process.env.CLANKPAD_KEY_PREFIX ?? "clankpad-sim";

// Deterministic PRNG so runs are comparable.
let seed = Number(process.env.SIM_SEED ?? 42);
const rand = () => ((seed = (seed * 1664525 + 1013904223) % 2 ** 32) / 2 ** 32);
const pick = <T>(xs: T[]): T => xs[Math.floor(rand() * xs.length)]!;

interface Proj {
  user: string;
  name: string;
  repos: string[];
  start: number; // day offset from sim start (0..DAYS-1)
  end: number;
  updates: string[];
}

const u = (n: string) => `${n}@example.com`;
const P = (user: string, name: string, repos: string[], start: number, end: number, ...updates: string[]): Proj => ({
  user: u(user), name, repos, start, end, updates,
});

// Planted overlaps (validated below): alice+bob on gateway retry/failover,
// carol+dan on cluster ingress for a new service, erin(old)+frank(new) on the archive sweep.
const PROJECTS: Proj[] = [
  P("alice", "gateway retry backoff", ["acme/gateway"], 6, 13,
    "Adding jittered backoff to the gateway retry loop", "Retry loop now respects Retry-After; writing tests", "PR open for retry backoff, addressing review"),
  P("bob", "first-token failover", ["acme/gateway"], 8, 13,
    "Failing over to next upstream when first token takes >30s", "Failover wired into gateway fallback chain", "Load testing failover against staging upstreams"),
  P("carol", "scratchpad cluster deploy", ["acme/platform"], 11, 13,
    "Writing Argo app + chart for the scratchpad service", "VPN ingress + network policy for the scratchpad service"),
  P("dan", "cluster VPN ingress", ["acme/platform"], 12, 13,
    "Adding a VPN ingress class for internal cluster services"),
  P("erin", "batch archive sweep timeout", ["acme/gateway"], 0, 4,
    "Archive sweep times out at 180s on big batches", "Chunking archive sweep into 10k-row deletes", "Merged chunked sweep, watching WAL"),
  P("frank", "archive sweep WAL spike", ["acme/gateway"], 12, 13,
    "WAL spiking again during archive sweep, replication slot lag"),
  P("alice", "AIMD robustness", ["acme/gateway"], 0, 5,
    "AIMD window collapsing to 1 on 503 loops", "Floor for AIMD window + tests", "aimd robustness PR merged"),
  P("bob", "vision model capacity", ["acme/platform"], 0, 3,
    "Replicas missing for the vision model", "Re-provisioned replicas, capacity back"),
  P("carol", "auth tenant parity", ["acme/infra"], 0, 9,
    "Diffing EU vs US auth tenant actions", "Terraform for US login pages", "US tenant actions in parity, cleaning up"),
  P("dan", "billing recompute verify", ["acme/gateway"], 2, 10,
    "Recompute verify degrades on fixed tariffs", "Fix tariff parse in recompute", "Backfilling recompute for September"),
  P("erin", "batch worker OOM ratchet", ["acme/batch"], 5, 13,
    "Batch worker memory ratchets up until OOM", "Allocator tuning had no effect; profiling with heaptrack", "Found leak in request buffer pooling"),
  P("frank", "analytics warehouse migration", ["acme/infra", "acme/gateway"], 0, 11,
    "Dual-writing request analytics to the warehouse", "Backfill of request analytics complete", "Switching dashboards to the warehouse"),
  P("grace", "docs site redesign", ["acme/docs"], 0, 13,
    "New nav for docs", "Migrating API reference pages", "Search index for docs", "Polishing code samples"),
  P("grace", "SDK streaming helpers", ["acme/sdk"], 7, 10,
    "Adding stream helpers to python SDK", "Released sdk 0.9 with streaming"),
  P("heidi", "tool-call usage null", ["acme/gateway"], 3, 8,
    "usage:null on tool calls breaks billing", "Patched usage fallback for tool-call streams"),
  P("heidi", "large model GPU scaling", ["acme/platform"], 9, 13,
    "Only one GPU worker for the large model, adding second", "Second worker up, TTFT back under 2s"),
  P("ivan", "demand forecast", ["acme/forecaster"], 0, 13,
    "Forecast truncated at 5 min horizon", "Extending forecast horizon to 30 min", "Alias folding for demand", "Placement uses new forecast"),
  P("judy", "SOC2 patch evidence", ["acme/platform"], 1, 6,
    "Collecting patch-management evidence", "Exported patch log for auditors"),
  P("judy", "join-request notifications", ["acme/web", "acme/gateway"], 7, 13,
    "Email org admins on join requests", "Notification preferences UI", "Join request emails live on staging"),
];

// SIM_TEAM_MULTIPLIER=N clones the team N times (alice2@…, alice3@…) to stress the size budget.
const MULT = Number(process.env.SIM_TEAM_MULTIPLIER ?? 1);
for (const base of PROJECTS.slice()) {
  for (let i = 2; i <= MULT; i++) {
    const shift = Math.floor(rand() * 4) - 2;
    PROJECTS.push({
      ...base,
      user: base.user.replace("@", `${i}@`),
      name: `${base.name} ${["v2", "followup", "spike", "prep"][i % 4]}`,
      start: Math.max(0, base.start + shift),
      end: Math.min(DAYS - 1, base.end + shift),
    });
  }
}
const USERS = [...new Set(PROJECTS.map((p) => p.user))];
const OVERLAPS: { users: string[]; from: number }[] = [
  { users: [u("alice"), u("bob")], from: 8 },
  { users: [u("carol"), u("dan")], from: 12 },
  { users: [u("erin"), u("frank")], from: 12 },
];

function isWeekend(d: Date) {
  const day = d.getUTCDay();
  return day === 0 || day === 6;
}

const cfg = { ...loadConfig(), keyPrefix: PREFIX, rebuildDebounceMs: 0, rebuildIntervalMs: 0 };
if (!cfg.llm.apiKey) throw new Error("LLM_API_KEY required");

const redis = new Redis(cfg.redisUrl);
const stale = await redis.keys(`${PREFIX}:*`);
if (stale.length) await redis.del(...stale);
await redis.quit();

let clock = new Date();
const store = new RedisStore(cfg.redisUrl, PREFIX, cfg.retentionDays);
const logs: string[] = [];
const aggregator = new Aggregator(store, cfg, { clock: () => clock, log: (msg, extra) => logs.push(JSON.stringify({ msg, ...extra })) });
const service = new Service(store, aggregator, cfg);

const OUT = process.env.SIM_OUT ?? "sim/out";
mkdirSync(OUT, { recursive: true });
const resultsPath = `${OUT}/results.jsonl`;
writeFileSync(resultsPath, "");

const realNow = new Date();
const startMs = Date.UTC(realNow.getUTCFullYear(), realNow.getUTCMonth(), realNow.getUTCDate()) - (DAYS - 1) * 86_400_000;
const rows: Record<string, unknown>[] = [];
let failures = 0;

console.log(`simulating ${DAYS} days × ${BURSTS_PER_DAY} bursts, ${USERS.length} users, model=${cfg.llm.model}, budget=${cfg.scratchpadMaxChars} chars`);

for (let day = 0; day < DAYS; day++) {
  for (let burst = 0; burst < BURSTS_PER_DAY; burst++) {
    // Bursts at 09:00 / 14:00 (… / 17:00) UTC, but never in the real future.
    const hour = [9, 14, 17][burst] ?? 12;
    clock = new Date(Math.min(startMs + day * 86_400_000 + hour * 3_600_000, realNow.getTime()));
    const weekend = isWeekend(clock);

    let writes = 0;
    for (const p of PROJECTS) {
      if (day < p.start || day > p.end) continue;
      // Weekends are quiet; otherwise most active projects get logged once a day,
      // and sometimes re-logged with an update in a later burst.
      const chance = weekend ? 0.1 : burst === 0 ? 0.85 : 0.35;
      if (rand() > chance) continue;
      const progress = Math.min(p.updates.length - 1, Math.floor(((day - p.start) / Math.max(1, p.end - p.start + 1)) * p.updates.length));
      await service.logProject(p.user, { name: p.name, summary: p.updates[progress], repos: p.repos });
      writes++;
    }
    // Occasional one-off noise entries.
    if (!weekend && rand() < 0.4) {
      await service.logProject(pick(USERS), { name: pick(["review PRs", "on-call triage", "dependabot bumps", "1:1 prep"]), summary: "" });
      writes++;
    }
    if (writes === 0) continue;

    const t0 = Date.now();
    const logCount = logs.length;
    const s = await aggregator.rebuildNow();
    const attempts = logs.length > logCount ? (JSON.parse(logs.at(-1)!).attempts as number) : 0;
    const ms = Date.now() - t0;
    const date = clock.toISOString().slice(0, 10);

    // ---- validation
    const activity = buildActivity(await store.listLogs(daysAgo(cfg.retentionDays - 1, clock)));
    const promptChars = JSON.stringify(compactActivity(activity)).length;
    const recentUsers = activity.filter((a) => a.lastSeen >= daysAgo(2, clock)).map((a) => a.user);
    const missing = recentUsers.filter((x) => !s.markdown.includes(x));
    const unknown = [...new Set(s.markdown.match(/[\w.+-]+@[\w.-]+\.\w+/g) ?? [])].filter((x) => !USERS.includes(x));
    const overlapSection = s.markdown.split(/^## /m).find((sec) => /^possible overlaps/i.test(sec)) ?? "";
    const due = OVERLAPS.filter((o) => day >= o.from);
    const found = due.filter((o) => o.users.every((x) => overlapSection.includes(x)));

    const problems: string[] = [];
    if (s.chars > cfg.scratchpadMaxChars) problems.push(`over budget ${s.chars}`);
    if (missing.length) problems.push(`missing recent users: ${missing.join(",")}`);
    if (unknown.length) problems.push(`unknown identities: ${unknown.join(",")}`);
    if (s.mode === "deterministic") problems.push(`fallback: ${s.error?.slice(0, 120)}`);
    if (problems.length) failures++;

    const row = {
      date, burst, writes, users: activity.length,
      projects: activity.reduce((n, a) => n + a.projects.length, 0),
      promptChars, chars: s.chars, approxTokens: Math.round(s.chars / 4),
      mode: s.mode, ms, attempts,
      overlaps: `${found.length}/${due.length}`, problems,
    };
    rows.push(row);
    appendFileSync(resultsPath, JSON.stringify({ ...row, markdown: s.markdown }) + "\n");
    console.log(
      `${date} b${burst} writes=${String(writes).padStart(2)} users=${String(activity.length).padStart(2)} projects=${String(row.projects).padStart(2)} ` +
        `prompt=${String(promptChars).padStart(5)}c out=${String(s.chars).padStart(5)}c (~${row.approxTokens} tok) ` +
        `${row.mode} try=${attempts} ${(ms / 1000).toFixed(1)}s overlaps=${row.overlaps}${problems.length ? "  ✖ " + problems.join("; ") : "  ✔"}`,
    );
  }
}

const final = await store.getScratchpad();
writeFileSync(`${OUT}/final.md`, final?.markdown ?? "");
writeFileSync(`${OUT}/aggregator.log`, logs.join("\n") + "\n");
const modes = rows.reduce<Record<string, number>>((m, r) => ({ ...m, [r.mode as string]: (m[r.mode as string] ?? 0) + 1 }), {});
const totalOverlaps = rows.reduce((n, r) => n + Number(String(r.overlaps).split("/")[1]), 0);
const foundOverlaps = rows.reduce((n, r) => n + Number(String(r.overlaps).split("/")[0]), 0);
console.log(`modes ${JSON.stringify(modes)}; planted overlaps found ${foundOverlaps}/${totalOverlaps}`);
const maxOut = Math.max(...rows.map((r) => r.chars as number));
const maxPrompt = Math.max(...rows.map((r) => r.promptChars as number));
console.log(`\n${rows.length} rebuilds, ${failures} with problems; max scratchpad ${maxOut} chars (~${Math.round(maxOut / 4)} tok), max prompt ${maxPrompt} chars`);
await store.close();
process.exit(failures ? 1 : 0);
