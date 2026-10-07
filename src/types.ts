export interface ProjectEntry {
  /** Stable key derived from name. */
  slug: string;
  name: string;
  summary: string;
  repos: string[];
  updatedAt: string;
}

export interface DailyLog {
  user: string;
  date: string; // YYYY-MM-DD (UTC)
  projects: ProjectEntry[];
}

/** One project as seen across a user's daily logs in the retention window. */
export interface ProjectActivity {
  slug: string;
  name: string;
  summary: string;
  repos: string[];
  firstSeen: string;
  lastSeen: string;
  daysActive: number;
}

export interface UserActivity {
  user: string;
  lastSeen: string;
  projects: ProjectActivity[];
}

export interface Scratchpad {
  markdown: string;
  generatedAt: string;
  /** Model that wrote the summary, or null when the deterministic fallback was used. */
  model: string | null;
  /**
   * llm: written by the model. hybrid: the model's overlaps section over a
   * deterministic body (model output was over budget). deterministic: no model.
   */
  mode: "llm" | "hybrid" | "deterministic";
  /** Hash of the activity the scratchpad was built from. */
  digest: string;
  chars: number;
  error?: string;
}
