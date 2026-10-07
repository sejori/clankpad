import assert from "node:assert/strict";
import { test } from "node:test";
import { Aggregator } from "../src/aggregator.ts";
import { loadConfig } from "../src/config.ts";
import { MemoryStore } from "../src/store.ts";
import { Service } from "../src/service.ts";
import { today } from "../src/util.ts";

const cfg = { ...loadConfig(), rebuildDebounceMs: 1, rebuildIntervalMs: 0, llm: { ...loadConfig().llm, apiKey: "k" } };
const quiet = () => {};
const entry = (name: string) => ({ slug: name, name, summary: "", repos: [], updatedAt: new Date().toISOString() });

test("skips the LLM when inputs are unchanged and falls back on failure", async () => {
  const store = new MemoryStore();
  let calls = 0;
  let fail = false;
  const agg = new Aggregator(store, cfg, {
    log: quiet,
    summariser: async () => {
      calls++;
      if (fail) throw new Error("boom");
      return "# from llm\n";
    },
  });

  await store.upsertProject("a@x", today(), entry("one"));
  assert.equal((await agg.rebuildNow()).markdown, "# from llm\n");
  await agg.rebuildNow();
  assert.equal(calls, 1, "unchanged digest should not call the LLM again");

  fail = true;
  await store.upsertProject("a@x", today(), entry("two"));
  const s = await agg.rebuildNow();
  assert.equal(s.model, null);
  assert.match(s.error ?? "", /boom/);
  assert.match(s.markdown, /\*\*two\*\*/);

  fail = false;
  assert.equal((await agg.rebuildNow()).markdown, "# from llm\n", "an errored scratchpad is retried even if the digest matches");
});

test("concurrent rebuild requests coalesce and observe prior writes", async () => {
  const store = new MemoryStore();
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const agg = new Aggregator(store, cfg, {
    log: quiet,
    summariser: async (_c, { activity }) => {
      calls++;
      if (calls === 1) await gate;
      return activity.flatMap((u) => u.projects.map((p) => p.name)).sort().join(",");
    },
  });

  await store.upsertProject("a@x", today(), entry("one"));
  const first = agg.rebuildNow();
  await new Promise((r) => setTimeout(r, 5));
  await store.upsertProject("a@x", today(), entry("two"));
  const second = agg.rebuildNow();
  const third = agg.rebuildNow();
  release();
  await Promise.all([first, second, third]);

  assert.equal(calls, 2, "two waiters during an in-flight rebuild share one follow-up");
  assert.equal((await store.getScratchpad())?.markdown, "one,two");
});

test("over-budget LLM output gets one shortening retry, then a budgeted fallback", async () => {
  const store = new MemoryStore();
  const small = { ...cfg, scratchpadMaxChars: 400 };
  const drafts: (string | undefined)[] = [];
  let reply = "x".repeat(1000);
  const agg = new Aggregator(store, small, {
    log: quiet,
    summariser: async (_c, req) => {
      drafts.push(req.overBudgetDraft);
      return reply;
    },
  });
  for (let i = 0; i < 20; i++) await store.upsertProject(`u${i}@x`, today(), { ...entry(`project ${i}`), summary: "s".repeat(200) });

  const s = await agg.rebuildNow();
  assert.deepEqual(drafts.map((d) => d?.length), [undefined, 1000]);
  assert.equal(s.mode, "deterministic");
  assert.ok(s.chars <= 400 && s.markdown.length === s.chars, `fallback ${s.chars} chars`);
  assert.match(s.markdown, /truncated/);

  reply = "# short\n";
  const ok = await agg.rebuildNow(true);
  assert.equal(ok.markdown, "# short\n");
});

test("a failed LLM call is retried once before falling back", async () => {
  const store = new MemoryStore();
  let calls = 0;
  const agg = new Aggregator(store, cfg, {
    log: quiet,
    summariser: async () => {
      if (++calls === 1) throw new Error("finish_reason=length");
      return "# ok\n";
    },
  });
  await store.upsertProject("a@x", today(), entry("one"));
  const s = await agg.rebuildNow();
  assert.equal(calls, 2);
  assert.equal(s.markdown, "# ok\n");
  assert.equal(s.error, undefined);
});

test("cold-start read serves the deterministic render without waiting on the LLM", async () => {
  const store = new MemoryStore();
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const agg = new Aggregator(store, cfg, {
    log: quiet,
    summariser: async () => {
      await gate;
      return "# llm\n";
    },
  });
  await store.upsertProject("a@x", today(), entry("one"));
  const s = await new Service(store, agg, cfg).scratchpad();
  assert.equal(s.model, null);
  assert.match(s.markdown, /\*\*one\*\*/);
  release();
  assert.equal((await agg.rebuildNow()).markdown, "# llm\n");
});

test("over-budget output keeps the model's overlaps section over a deterministic body", async () => {
  const store = new MemoryStore();
  const small = { ...cfg, scratchpadMaxChars: 600 };
  const overlaps = "## Possible overlaps\n- a@x and b@x: same thing\n";
  const agg = new Aggregator(store, small, {
    log: quiet,
    summariser: async () => `# Team scratchpad\n\n${overlaps}\n## a@x\n${"- long line\n".repeat(100)}`,
  });
  for (const u of ["a@x", "b@x"]) await store.upsertProject(u, today(), { ...entry("thing"), summary: "s".repeat(100) });
  const s = await agg.rebuildNow();
  assert.equal(s.mode, "hybrid");
  assert.ok(s.chars <= 600, `${s.chars}`);
  assert.ok(s.markdown.startsWith(`# Team scratchpad\n\n${overlaps}\n## `), s.markdown);
  assert.match(s.markdown, /## b@x/);
});
