import { buildActivity, digestActivity, renderMarkdown } from "./activity.ts";
import type { Config } from "./config.ts";
import { summarise } from "./llm.ts";
import type { Store } from "./store.ts";
import type { Scratchpad } from "./types.ts";
import { daysAgo, today } from "./util.ts";

type Summariser = typeof summarise;

/**
 * Rebuilds the team scratchpad from all daily logs.
 *
 * `trigger()` is called on every log write. Bursts are debounced, and at most one
 * rebuild runs at a time; triggers during a rebuild coalesce into one follow-up.
 * Rebuilds whose input digest matches the stored scratchpad are skipped, so the
 * periodic timer only costs an LLM call when something actually changed.
 */
export class Aggregator {
  private timer: NodeJS.Timeout | undefined;
  private interval: NodeJS.Timeout | undefined;
  private running: Promise<void> | undefined;
  private queued: Promise<void> | undefined;
  private force = false;

  private readonly store: Store;
  private readonly cfg: Config;
  private readonly log: (msg: string, extra?: Record<string, unknown>) => void;
  private readonly summariser: Summariser;

  constructor(store: Store, cfg: Config, log = defaultLog, summariser: Summariser = summarise) {
    this.store = store;
    this.cfg = cfg;
    this.log = log;
    this.summariser = summariser;
  }

  start() {
    if (this.cfg.rebuildIntervalMs > 0) {
      this.interval = setInterval(() => this.trigger(0), this.cfg.rebuildIntervalMs);
      this.interval.unref();
    }
    this.trigger(0);
  }

  stop() {
    clearTimeout(this.timer);
    clearInterval(this.interval);
  }

  trigger(delayMs = this.cfg.rebuildDebounceMs) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.run(), delayMs);
    this.timer.unref();
  }

  /** Rebuild now; resolves once the scratchpad reflects all writes made before the call. */
  async rebuildNow(force = false): Promise<Scratchpad> {
    clearTimeout(this.timer);
    await this.run(force);
    return (await this.store.getScratchpad())!;
  }

  /**
   * Coalescing queue: a call made while a rebuild is in flight joins the single
   * queued follow-up rather than starting another, and every returned promise
   * resolves only after a rebuild that started after the call.
   */
  private run(force = false): Promise<void> {
    this.force ||= force;
    if (this.queued) return this.queued;
    const prev = this.running ?? Promise.resolve();
    this.queued = prev.then(async () => {
      this.queued = undefined;
      const f = this.force;
      this.force = false;
      this.running = this.rebuild(f)
        .catch((err) => this.log("rebuild failed", { error: String(err) }))
        .finally(() => {
          this.running = undefined;
        });
      await this.running;
    });
    return this.queued;
  }

  private async rebuild(force: boolean) {
    const date = today();
    const logs = await this.store.listLogs(daysAgo(this.cfg.retentionDays - 1));
    const activity = buildActivity(logs);
    // Day rollover changes staleness wording, so it is part of the digest.
    const digest = `${date}:${digestActivity(activity)}`;

    const existing = await this.store.getScratchpad();
    if (!force && existing?.digest === digest && !existing.error) return;

    const started = Date.now();
    let scratchpad: Scratchpad;
    if (activity.length === 0 || !this.cfg.llm.apiKey) {
      scratchpad = { markdown: renderMarkdown(activity), generatedAt: new Date().toISOString(), model: null, digest };
    } else {
      try {
        const markdown = await this.summariser(this.cfg.llm, activity, date);
        scratchpad = { markdown, generatedAt: new Date().toISOString(), model: this.cfg.llm.model, digest };
      } catch (err) {
        scratchpad = {
          markdown: renderMarkdown(activity),
          generatedAt: new Date().toISOString(),
          model: null,
          digest,
          error: String(err),
        };
      }
    }
    await this.store.setScratchpad(scratchpad);
    this.log("scratchpad rebuilt", {
      users: activity.length,
      model: scratchpad.model,
      ms: Date.now() - started,
      ...(scratchpad.error ? { error: scratchpad.error } : {}),
    });
  }
}

function defaultLog(msg: string, extra: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ ts: new Date().toISOString(), msg, ...extra }));
}
