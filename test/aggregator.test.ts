import assert from "node:assert/strict";
import { test } from "node:test";
import { Aggregator } from "../src/aggregator.ts";
import { loadConfig } from "../src/config.ts";
import { MemoryStore } from "../src/store.ts";
import { today } from "../src/util.ts";

const cfg = { ...loadConfig(), rebuildDebounceMs: 1, rebuildIntervalMs: 0, llm: { ...loadConfig().llm, apiKey: "k" } };
const quiet = () => {};
const entry = (name: string) => ({ slug: name, name, summary: "", repos: [], updatedAt: new Date().toISOString() });

test("skips the LLM when inputs are unchanged and falls back on failure", async () => {
  const store = new MemoryStore();
  let calls = 0;
  let fail = false;
  const agg = new Aggregator(store, cfg, quiet, async () => {
    calls++;
    if (fail) throw new Error("boom");
    return "# from llm\n";
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
  const agg = new Aggregator(store, cfg, quiet, async (_c, activity) => {
    calls++;
    if (calls === 1) await gate;
    return activity.flatMap((u) => u.projects.map((p) => p.name)).sort().join(",");
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
