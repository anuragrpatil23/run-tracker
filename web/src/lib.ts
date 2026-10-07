/* Small things every page uses: the server, formatting, and state that survives a reload. */
import { useCallback, useEffect, useRef, useState } from "react";

export type Run = {
  id: string; name: string; source: string; format: string; project: string; group: string | null; apart: boolean;
  state: string; why: string; step: number | null; total: number | null; lines: number;
  started: number | null; ended: number | null; seconds: number | null;
  settings: Record<string, unknown>; latest: Record<string, number>;
  tags: string[]; note: string; prediction: string; synced: number | null; commit: string | null; metrics: Metric[];
  job: { id: string; state: string; raw: string; exit_code: string | null } | null;
};
export type Metric = { name: string; step?: string; summary?: string[]; hidden?: boolean };
/* What a script said about a metric with define_metric. A name may hold a * to cover several; a later, more exact
   entry adds to an earlier, wider one. */
export function ruleFor(defined: Metric[], name: string): Metric {
  const out: Metric = { name };
  for (const m of defined) {
    const hit = m.name.includes("*") ? new RegExp("^" + m.name.split("*").map(p => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$").test(name) : m.name === name;
    if (hit) { if (m.step) out.step = m.step; if (m.summary?.length) out.summary = m.summary; if (m.hidden) out.hidden = true; }
  }
  return out;
}
/* Whether a logged number is something to plot the others against, not a result: a count of steps, examples or time.
   It has to only ever go up, and either the script named it as a step metric or it has one of the usual names. Going
   up alone is not enough: an accuracy that improved at every line also only went up, and it is a result. */
const COUNTERS = /(^|[/_.])(epochs?|steps?|global_step|iter(ation)?s?|rows|samples|examples|tokens|batch(es)?|minutes|seconds|hours|time)$/i;
export function isAxis(k: { key: string; kind: string; mono: boolean; lo: number | null; hi: number | null }, defined: Metric[]): boolean {
  return k.kind === "number" && k.mono && (k.hi ?? 0) > (k.lo ?? 0) && !k.key.startsWith("sys/")
    && (COUNTERS.test(k.key) || defined.some(m => m.step === k.key));
}
export type KeyInfo = { key: string; kind: "number" | "words" | "histogram" | "image" | "table"; n: number; last: number | null; lo: number | null; hi: number | null; mono: boolean; formula?: string };
export type Series = { x: number[]; y: number[]; n: number };
export type SyncState = { busy: boolean; last: number | null; error: string | null; lines: string[]; watch: number | null };

export async function api<T = any>(path: string, body?: unknown): Promise<T> {
  const r = await fetch(path, body === undefined ? undefined
    : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j as T;
}
export const enc = encodeURIComponent;
export const runHref = (id: string, tab = "") => "#/run/" + encodeURI(id) + (tab ? "?tab=" + tab : "");

export const isNum = (v: unknown): v is number => typeof v === "number" && isFinite(v);
/* the number itself, for tables and readouts */
export function fmt(v: unknown): string {
  if (!isNum(v)) return v == null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
  if (Number.isInteger(v)) return Math.abs(v) >= 1e15 ? v.toExponential(3) : v.toLocaleString("en-US");
  const a = Math.abs(v);
  if (a >= 1e4) return v.toLocaleString("en-US", { maximumFractionDigits: 1 });
  if (a >= 1e-4) return String(+v.toPrecision(5));
  return v.toExponential(3);
}
/* the short form, for an axis */
export function tick(v: number): string {
  const a = Math.abs(v), t = (x: number, d: number) => String(+x.toFixed(d));
  if (a === 0) return "0";
  if (a >= 1e9) return t(v / 1e9, 2) + "B";
  if (a >= 1e6) return t(v / 1e6, 2) + "M";
  if (a >= 1e4) return t(v / 1e3, 1) + "k";
  if (a >= 1e-3) return String(+v.toPrecision(4));
  return v.toExponential(1);
}
export function dur(sec: number | null | undefined): string {
  if (!isNum(sec)) return "";
  if (sec < 90) return Math.round(sec) + " s";
  if (sec < 5400) return Math.round(sec / 60) + " min";
  if (sec < 172800) return (sec / 3600).toFixed(1) + " h";
  return (sec / 86400).toFixed(1) + " d";
}
export const when = (t: number | null | undefined) =>
  isNum(t) ? new Date(t * 1000).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : "";
export function sizeText(n: number | null | undefined): string {
  if (!isNum(n)) return "";
  const u = ["B", "KB", "MB", "GB"]; let i = 0;
  while (n >= 1024 && i < 3) { n /= 1024; i++; }
  return (i ? n.toFixed(1) : String(n)) + " " + u[i];
}
export const going = (r: Run) => ["running", "pending", "stalled"].includes(r.state);

/* The settings in which a set of runs differ, leaving out those that only repeat the run's own name or folder. */
export function differing(runs: Run[]): string[] {
  const has = (k: string) => runs.filter(r => r.settings[k] !== undefined);
  return [...new Set(runs.flatMap(r => Object.keys(r.settings)))]
    .filter(k => runs.length === 1 || new Set(has(k).map(r => JSON.stringify(r.settings[k]))).size > 1)
    .filter(k => runs.length === 1 || !has(k).every(r => typeof r.settings[k] === "string" && (r.settings[k] as string).includes(r.name)));
}

/* Which project the page is showing. What a reader sets up (runs chosen, charts pinned, sections open) belongs to the
   project it was set up in, so it is remembered under the project's name. */
let scope = "";
export const setScope = (project: string) => { scope = project; };

/* State kept in the browser under a name, so a reload brings the page back as it was. It is kept per project unless
   `everywhere` is set, as for the theme. A component that uses it is made afresh when the project changes. */
export function useStored<T>(key: string, initial: T, everywhere = false): [T, (v: T | ((old: T) => T)) => void] {
  const [at] = useState(() => "trt." + (everywhere ? "" : scope + "/") + key);
  const [value, setValue] = useState<T>(() => {
    try { const s = localStorage.getItem(at); return s == null ? initial : (JSON.parse(s) as T); } catch { return initial; }
  });
  const set = useCallback((v: T | ((old: T) => T)) => {
    setValue(old => {
      const next = typeof v === "function" ? (v as (o: T) => T)(old) : v;
      try { localStorage.setItem(at, JSON.stringify(next)); } catch { /* private window: keep it in memory only */ }
      return next;
    });
  }, [at]);
  return [value, set];
}

export function useHash(): string {
  const [hash, setHash] = useState(location.hash);
  useEffect(() => {
    const on = () => setHash(location.hash);
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return hash;
}

/* Ask the server now and again every `ms`. The last good answer stays on screen while the next is fetched or if it fails. */
export function usePoll<T>(fn: () => Promise<T>, ms: number, deps: unknown[]): { data: T | null; error: string | null; reload: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [n, setN] = useState(0);
  const latest = useRef(fn);
  latest.current = fn;
  useEffect(() => {
    let alive = true;
    const go = () => latest.current().then(d => { if (alive) { setData(d); setError(null); } }, e => { if (alive) setError(String(e.message || e)); });
    go();
    const timer = ms ? setInterval(() => { if (!document.hidden) go(); }, ms) : undefined;
    return () => { alive = false; clearInterval(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ms, n, ...deps]);
  return { data, error, reload: () => setN(x => x + 1) };
}

/* Whether an element has come into view; charts below the fold are not fetched until it has. */
export function useSeen<T extends Element>(): [React.RefObject<T>, boolean] {
  const ref = useRef<T>(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    if (seen || !ref.current) return;
    const io = new IntersectionObserver(es => { if (es.some(e => e.isIntersecting)) setSeen(true); }, { rootMargin: "300px" });
    io.observe(ref.current);
    return () => io.disconnect();
  }, [seen]);
  return [ref, seen];
}

/* Eight colours that can be told apart, given out in a fixed order. A run keeps its colour while it stays drawn;
   a ninth run gets none (0) and is drawn grey, since a ninth colour could not be told from the others. */
export function useSlots(ids: string[]): Record<string, number> {
  const held = useRef<Record<string, number>>({});
  const next: Record<string, number> = {};
  for (const id of ids) if (held.current[id]) next[id] = held.current[id];
  for (const id of ids) {
    if (next[id]) continue;
    const used = new Set(Object.values(next));
    let s = 1;
    while (used.has(s)) s++;
    next[id] = s <= 8 ? s : 0;
  }
  held.current = next;
  return next;
}
export const slotVar = (slot: number) => (slot >= 1 && slot <= 8 ? `var(--s${slot})` : "var(--muted)");
export function cssColour(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || "#888";
}
