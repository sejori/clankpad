import { createHash } from "node:crypto";
import type { DailyLog, ProjectActivity, UserActivity } from "./types.ts";

/** Fold daily logs into one record per (user, project) across the window. */
export function buildActivity(logs: DailyLog[]): UserActivity[] {
  const byUser = new Map<string, Map<string, ProjectActivity>>();

  // Oldest first so later days overwrite name/summary with the freshest wording.
  const sorted = [...logs].sort((a, b) => a.date.localeCompare(b.date));
  for (const log of sorted) {
    const projects = byUser.get(log.user) ?? new Map<string, ProjectActivity>();
    byUser.set(log.user, projects);
    for (const p of log.projects) {
      const prev = projects.get(p.slug);
      projects.set(p.slug, {
        slug: p.slug,
        name: p.name,
        summary: p.summary || prev?.summary || "",
        repos: [...new Set([...(prev?.repos ?? []), ...p.repos])].sort(),
        firstSeen: prev?.firstSeen ?? log.date,
        lastSeen: log.date,
        daysActive: (prev?.daysActive ?? 0) + 1,
      });
    }
  }

  return [...byUser]
    .map(([user, projects]) => {
      const list = [...projects.values()].sort(
        (a, b) => b.lastSeen.localeCompare(a.lastSeen) || a.name.localeCompare(b.name),
      );
      return { user, lastSeen: list[0]?.lastSeen ?? "", projects: list };
    })
    .sort((a, b) => b.lastSeen.localeCompare(a.lastSeen) || a.user.localeCompare(b.user));
}

export function digestActivity(activity: UserActivity[]): string {
  return createHash("sha256").update(JSON.stringify(activity)).digest("hex").slice(0, 16);
}

interface RenderLevel {
  summaryChars: number;
  collapseStale: boolean;
  maxRecentPerUser: number;
}

const LEVELS: RenderLevel[] = [
  { summaryChars: 160, collapseStale: false, maxRecentPerUser: Infinity },
  { summaryChars: 160, collapseStale: true, maxRecentPerUser: Infinity },
  { summaryChars: 60, collapseStale: true, maxRecentPerUser: 4 },
  { summaryChars: 0, collapseStale: true, maxRecentPerUser: 2 },
];

const STALE_DAYS = 3;

function clip(s: string, n: number) {
  return s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s;
}

function renderAt(activity: UserActivity[], level: RenderLevel, staleBefore: string): string {
  const lines = ["# Team scratchpad", ""];
  for (const u of activity) {
    lines.push(`## ${u.user}`);
    const recent = level.collapseStale ? u.projects.filter((p) => p.lastSeen >= staleBefore) : u.projects;
    const shown = recent.slice(0, level.maxRecentPerUser);
    const earlier = u.projects.filter((p) => !shown.includes(p));
    for (const p of shown) {
      const span = p.firstSeen === p.lastSeen ? p.lastSeen : `${p.firstSeen}→${p.lastSeen}`;
      const repos = p.repos.length ? ` [${p.repos.join(", ")}]` : "";
      const summary = p.summary && level.summaryChars ? ` — ${clip(p.summary, level.summaryChars)}` : "";
      lines.push(`- **${p.name}**${repos} (${span})${summary}`);
    }
    if (earlier.length) {
      const names = earlier.map((p) => p.name);
      const last = earlier.reduce((m, p) => (p.lastSeen > m ? p.lastSeen : m), "");
      lines.push(`- Earlier: ${clip(names.join(", "), 120)} (last ${last})`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

/**
 * Deterministic scratchpad, used when no LLM is configured or its output is
 * unusable. Progressively compacts until it fits within maxChars.
 */
export function renderMarkdown(activity: UserActivity[], maxChars = Infinity, today = new Date().toISOString().slice(0, 10)): string {
  if (activity.length === 0) return "# Team scratchpad\n\n_No recent activity logged._\n";
  const staleBefore = new Date(Date.parse(today) - STALE_DAYS * 86_400_000).toISOString().slice(0, 10);
  let md = "";
  for (const level of LEVELS) {
    md = renderAt(activity, level, staleBefore);
    if (md.length <= maxChars) return md;
  }
  const note = "\n_…truncated to fit; see GET /v1/activity for everything._\n";
  return md.slice(0, Math.max(0, maxChars - note.length)).replace(/\n[^\n]*$/, "") + note;
}

/** Extract the "## Possible overlaps" section (heading included) from model output. */
export function extractOverlaps(markdown: string): string | null {
  const m = markdown.match(/^## Possible overlaps[^\n]*\n[\s\S]*?(?=^## |(?![\s\S]))/im);
  return m ? m[0].trim() + "\n" : null;
}

/**
 * Deterministic body with the model's overlaps section spliced in after the
 * title. The overlaps get at most 40% of the budget.
 */
export function renderHybrid(activity: UserActivity[], overlaps: string, maxChars: number, today?: string): string {
  const cap = Math.floor(maxChars * 0.4);
  const section = overlaps.length <= cap ? overlaps : overlaps.slice(0, cap).replace(/\n[^\n]*$/, "") + "\n";
  const body = renderMarkdown(activity, maxChars - section.length - 1, today);
  const title = "# Team scratchpad\n\n";
  return body.startsWith(title) ? `${title}${section}\n${body.slice(title.length)}` : `${section}\n${body}`;
}
