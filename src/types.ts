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
  /** Hash of the activity the scratchpad was built from. */
  digest: string;
  error?: string;
}
