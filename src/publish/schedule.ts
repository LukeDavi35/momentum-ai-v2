import type { AppConfig, Platform } from "../config/index.js";
import type { Weights } from "../ideate/weights.js";

const fmt = (tz: string) =>
  new Intl.DateTimeFormat("en-GB", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });

export function localParts(d: Date, tz: string): { ymd: string; hour: number; minute: number } {
  const p = Object.fromEntries(fmt(tz).formatToParts(d).map((x) => [x.type, x.value]));
  return { ymd: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour), minute: Number(p.minute) };
}

function offsetMs(d: Date, tz: string): number {
  const p = Object.fromEntries(fmt(tz).formatToParts(d).map((x) => [x.type, Number(x.value)]));
  return Date.UTC(p.year!, p.month! - 1, p.day!, p.hour!, p.minute!, p.second!) - Math.floor(d.getTime() / 1000) * 1000;
}

/** Wall-clock time in `tz` -> the real UTC instant (handles DST by correcting once). */
export function zonedToUtc(ymd: string, hhmm: string, tz: string): Date {
  const [y, mo, d] = ymd.split("-").map(Number);
  const [h, mi] = hhmm.split(":").map(Number);
  const guess = Date.UTC(y!, mo! - 1, d!, h!, mi!);
  let utc = guess - offsetMs(new Date(guess), tz);
  const off2 = offsetMs(new Date(utc), tz);
  utc = guess - off2;
  return new Date(utc);
}

const addDays = (ymd: string, n: number): string => {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

export interface SlotInput {
  cfg: AppConfig;
  platform: Platform;
  now: Date;
  /** Times already taken on this platform (scheduled or published within the horizon). */
  taken: Date[];
  hourWeights: Weights["hours"];
  rng?: () => number;
  minGapMs?: number;
  horizonHours?: number;
  /** Fraction of picks that explore a non-peak hour so the learning loop can discover better times. */
  explore?: number;
}

const MIN_LEAD_MS = 10 * 60_000;

/**
 * Chooses when to post next on a platform: configured peak times, re-weighted by what the weekly
 * learning loop found works (hour multipliers), with a little exploration, respecting the
 * per-day cap and a minimum gap, plus random jitter so posting isn't robotic.
 */
export function pickSlot(i: SlotInput): Date | null {
  const rng = i.rng ?? Math.random;
  const p = i.cfg.schedule.platforms[i.platform];
  const tz = i.cfg.schedule.timezone;
  const gap = i.minGapMs ?? 90 * 60_000;
  const horizon = (i.horizonHours ?? 48) * 3600_000;
  const earliest = i.now.getTime() + MIN_LEAD_MS;
  const today = localParts(i.now, tz).ymd;

  const peakHours = new Set(p.peakTimes.map((t) => Number(t.slice(0, 2))));
  type Cand = { at: Date; score: number; peak: boolean };
  const cands: Cand[] = [];
  for (let day = 0; day <= 2; day++) {
    const ymd = addDays(today, day);
    for (let h = 7; h <= 22; h++) {
      const hh = String(h).padStart(2, "0");
      const exactPeak = p.peakTimes.find((t) => t.startsWith(`${hh}:`));
      const at = zonedToUtc(ymd, exactPeak ?? `${hh}:00`, tz);
      if (at.getTime() < earliest || at.getTime() > i.now.getTime() + horizon) continue;
      const peak = peakHours.has(h);
      cands.push({ at, score: (peak ? 1 : 0.25) * (i.hourWeights[hh] ?? 1), peak });
    }
  }

  const perDay = (ymd: string) => i.taken.filter((t) => localParts(t, tz).ymd === ymd).length;
  const valid = cands.filter((c) => perDay(localParts(c.at, tz).ymd) < p.postsPerDay && i.taken.every((t) => Math.abs(t.getTime() - c.at.getTime()) >= gap));
  if (valid.length === 0) return null;

  let chosen: Cand;
  const explorers = valid.filter((c) => !c.peak);
  if (explorers.length > 0 && rng() < (i.explore ?? 0.1)) chosen = explorers[Math.floor(rng() * explorers.length)]!;
  else chosen = [...valid].sort((a, b) => b.score - a.score || a.at.getTime() - b.at.getTime())[0]!;

  const jitter = (rng() * 2 - 1) * p.jitterMinutes * 60_000;
  let at = chosen.at.getTime() + jitter;
  at = Math.max(at, earliest);
  // jitter must not break the gap rule or the daily bucket we just validated
  if (i.taken.some((t) => Math.abs(t.getTime() - at) < gap) || localParts(new Date(at), tz).ymd !== localParts(chosen.at, tz).ymd) at = chosen.at.getTime();
  return new Date(at);
}
