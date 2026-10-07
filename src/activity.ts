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

/** Deterministic scratchpad used when no LLM is configured or the call fails. */
export function renderMarkdown(activity: UserActivity[]): string {
  if (activity.length === 0) return "# Team scratchpad\n\n_No recent activity logged._\n";
  const lines = ["# Team scratchpad", ""];
  for (const u of activity) {
    lines.push(`## ${u.user}`, "");
    for (const p of u.projects) {
      const span = p.firstSeen === p.lastSeen ? p.lastSeen : `${p.firstSeen} → ${p.lastSeen}`;
      const repos = p.repos.length ? ` [${p.repos.join(", ")}]` : "";
      const summary = p.summary ? ` — ${p.summary}` : "";
      lines.push(`- **${p.name}**${repos} (${span})${summary}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}
