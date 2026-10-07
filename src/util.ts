export function today(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export function daysAgo(n: number, now: Date = new Date()): string {
  return today(new Date(now.getTime() - n * 86_400_000));
}

export function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return slug || "untitled";
}

export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
