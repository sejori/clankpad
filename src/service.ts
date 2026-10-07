import { z } from "zod";
import type { Aggregator } from "./aggregator.ts";
import { buildActivity, renderMarkdown } from "./activity.ts";
import type { Config } from "./config.ts";
import type { Store } from "./store.ts";
import type { DailyLog, Scratchpad, UserActivity } from "./types.ts";
import { DATE_RE, daysAgo, slugify, today } from "./util.ts";

export const MAX_PROJECTS_PER_DAY = 50;

export const ProjectInput = z.object({
  name: z.string().trim().min(1).max(120).describe("Short project name, e.g. 'flex cancel-on-disconnect'"),
  summary: z
    .string()
    .trim()
    .max(1000)
    .default("")
    .describe("One or two sentences on what you're doing and why; mention tickets/PRs if known"),
  repos: z
    .array(z.string().trim().min(1).max(200))
    .max(10)
    .default([])
    .describe("Repositories touched, e.g. ['acme/gateway']"),
});
export type ProjectInput = z.input<typeof ProjectInput>;

export class ValidationError extends Error {}

/** Operations shared by the REST API and the MCP endpoint. */
export class Service {
  private readonly store: Store;
  private readonly aggregator: Aggregator;
  private readonly cfg: Config;

  constructor(store: Store, aggregator: Aggregator, cfg: Config) {
    this.store = store;
    this.aggregator = aggregator;
    this.cfg = cfg;
  }

  async scratchpad(): Promise<Scratchpad> {
    const stored = await this.store.getScratchpad();
    if (stored) return stored;
    // Cold start: don't make the caller wait on the LLM. Serve the deterministic
    // render now; the background rebuild will replace it.
    this.aggregator.trigger(0);
    const now = this.now();
    const markdown = renderMarkdown(await this.activity(), this.cfg.scratchpadMaxChars, today(now));
    return { markdown, generatedAt: now.toISOString(), model: null, mode: "deterministic", digest: "", chars: markdown.length };
  }

  async rebuild(): Promise<Scratchpad> {
    return this.aggregator.rebuildNow(true);
  }

  private now() {
    return this.aggregator.clock();
  }

  async activity(days = this.cfg.retentionDays): Promise<UserActivity[]> {
    const d = Math.min(Math.max(1, Math.floor(days)), this.cfg.retentionDays);
    return buildActivity(await this.store.listLogs(daysAgo(d - 1, this.now())));
  }

  async myLog(user: string, date = today(this.now())): Promise<DailyLog> {
    if (!DATE_RE.test(date)) throw new ValidationError("date must be YYYY-MM-DD");
    return this.store.getLog(user, date);
  }

  async logProject(user: string, input: unknown): Promise<DailyLog> {
    const parsed = ProjectInput.safeParse(input);
    if (!parsed.success) throw new ValidationError(z.prettifyError(parsed.error));
    const p = parsed.data;
    const now = this.now();
    const date = today(now);
    const slug = slugify(p.name);
    const current = await this.store.getLog(user, date);
    if (!current.projects.some((e) => e.slug === slug) && current.projects.length >= MAX_PROJECTS_PER_DAY) {
      throw new ValidationError(`at most ${MAX_PROJECTS_PER_DAY} projects per day`);
    }
    await this.store.upsertProject(user, date, {
      slug,
      name: p.name,
      summary: p.summary,
      repos: [...new Set(p.repos)],
      updatedAt: now.toISOString(),
    });
    this.aggregator.trigger();
    return this.store.getLog(user, date);
  }

  async removeProject(user: string, nameOrSlug: string): Promise<{ removed: boolean; log: DailyLog }> {
    const date = today(this.now());
    const removed = await this.store.removeProject(user, date, slugify(nameOrSlug));
    if (removed) this.aggregator.trigger();
    return { removed, log: await this.store.getLog(user, date) };
  }
}
