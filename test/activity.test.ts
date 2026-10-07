import assert from "node:assert/strict";
import { test } from "node:test";
import { buildActivity, extractOverlaps, renderMarkdown } from "../src/activity.ts";
import type { DailyLog } from "../src/types.ts";

const entry = (name: string, summary: string, repos: string[] = []) => ({
  slug: name.toLowerCase().replace(/\s+/g, "-"),
  name,
  summary,
  repos,
  updatedAt: "2026-10-01T00:00:00Z",
});

test("folds a user's project across days, keeping the latest summary", () => {
  const logs: DailyLog[] = [
    { user: "a@x", date: "2026-10-02", projects: [entry("Flex relay", "day two", ["r2"])] },
    { user: "a@x", date: "2026-10-01", projects: [entry("Flex relay", "day one", ["r1"])] },
    { user: "b@x", date: "2026-10-03", projects: [entry("Billing", "")] },
  ];
  const [b, a] = buildActivity(logs);
  assert.equal(b?.user, "b@x");
  assert.deepEqual(a?.projects[0], {
    slug: "flex-relay",
    name: "Flex relay",
    summary: "day two",
    repos: ["r1", "r2"],
    firstSeen: "2026-10-01",
    lastSeen: "2026-10-02",
    daysActive: 2,
  });
});

test("renders deterministic markdown", () => {
  const md = renderMarkdown(buildActivity([{ user: "a@x", date: "2026-10-01", projects: [entry("Thing", "doing it", ["repo"])] }]));
  assert.match(md, /## a@x/);
  assert.match(md, /\*\*Thing\*\* \[repo\] \(2026-10-01\) — doing it/);
  assert.match(renderMarkdown([]), /No recent activity/);
});

test("deterministic render compacts to fit the budget", () => {
  const logs: DailyLog[] = [];
  for (let u = 0; u < 12; u++)
    for (let d = 1; d <= 14; d++)
      logs.push({ user: `user${u}@x`, date: `2026-10-${String(d).padStart(2, "0")}`, projects: [entry(`proj ${u}-${d % 5}`, "z".repeat(300), ["org/repo"])] });
  const activity = buildActivity(logs);
  const full = renderMarkdown(activity);
  for (const budget of [6000, 3000, 1500]) {
    const md = renderMarkdown(activity, budget, "2026-10-14");
    assert.ok(md.length <= budget, `${md.length} > ${budget}`);
    assert.ok(md.length < full.length);
  }
  assert.match(renderMarkdown(activity, 6000, "2026-10-14"), /Earlier: /);
});

test("extracts the overlaps section wherever it sits", () => {
  const md = "# Team scratchpad\n\n## Possible overlaps\n- x and y\n\n## a@x\n- thing\n";
  assert.equal(extractOverlaps(md), "## Possible overlaps\n- x and y\n");
  assert.equal(extractOverlaps("# T\n\n## possible overlaps\n- only\n"), "## possible overlaps\n- only\n");
  assert.equal(extractOverlaps("# T\n\n## a@x\n"), null);
});
