/* Line charts, drawn with uPlot.

   In the grid: a line per run (or per group, with a band from its lowest to its highest member), a dot where each line
   has got to, the line as logged kept faint behind a smoothed one, and a readout that follows the pointer on every
   chart at once while the line nearest the pointer stays bright. Dragging across one chart zooms all of them to the
   same stretch; double-click puts them back.

   Opened large, a chart becomes an inspector: a table of the runs with the value under the pointer and each run's
   latest, lowest and highest; click a run to hide it, alt-click to see it alone; the numbers as CSV or the picture as PNG. */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import { api, cssColour, enc, fmt, Run, Series, tick, useSeen } from "./lib";

export type Line = { label: string; slot: number; x: number[]; y: number[]; lo?: number[]; hi?: number[]; members?: number };
type Range = [number, number] | null;
type Col = { label: string; colour: string; role: "line" | "logged" | "edge"; line: number };

/* Smoothing as a running average that leans on the past by `a` (0 none, towards 1 heavy), corrected so the
   start of the line is not dragged towards zero. */
function smoothed(y: number[], a: number): number[] {
  if (!a) return y;
  let s = 0, w = 0;
  return y.map(v => { s = a * s + (1 - a) * v; w = a * w + (1 - a); return s / w; });
}
/* A number that stays above zero and spans a hundredfold is one spike and a flat line on a plain scale. */
export function wantsLog(lines: Line[]): boolean {
  let lo = Infinity, hi = -Infinity;
  for (const l of lines) for (const v of l.y) { if (v < lo) lo = v; if (v > hi) hi = v; }
  return lo > 0 && hi / lo >= 100;
}
const tint = (hex: string, alpha: number) => {
  const n = parseInt(hex.replace("#", "").padEnd(6, "0").slice(0, 6), 16);
  return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${alpha})`;
};
/* Several runs as one line: at each x, the mean of the members that have a value there, with their lowest and highest.
   Runs logged at the same steps line up exactly; a very long run is thinned before it gets here, and then the mean at
   an x is over the members that kept a point there. */
export function bundle(label: string, slot: number, members: Line[]): Line {
  const at = new Map<number, number[]>();
  for (const l of members) l.x.forEach((x, i) => { const a = at.get(x); a ? a.push(l.y[i]) : at.set(x, [l.y[i]]); });
  const x = [...at.keys()].sort((a, b) => a - b);
  const of = (f: (v: number[]) => number) => x.map(v => f(at.get(v)!));
  return { label, slot, x, y: of(v => v.reduce((a, b) => a + b, 0) / v.length), lo: of(v => Math.min(...v)), hi: of(v => Math.max(...v)), members: members.length };
}

function readout(cols: Col[], xLabel: string, onHover?: (x: number | null, values: (number | null)[]) => void): uPlot.Plugin {
  let tip: HTMLDivElement, near = -1;
  const show = (u: uPlot) => {
    const { left, idx } = u.cursor;
    if (idx == null || left == null || left < 0) { tip.hidden = true; onHover?.(null, []); return; }
    const rows: { label: string; colour: string; v: number; i: number }[] = [];
    const values: (number | null)[] = [];
    cols.forEach((c, i) => {
      if (c.role !== "line") return;
      const col = u.data[i + 1] as (number | null)[];
      let v = col[idx];
      for (let d = 1; v == null && d < 40; d++) v = col[idx - d] ?? col[idx + d];       // a run with no point exactly here: its nearest
      values[c.line] = v ?? null;
      if (v != null) rows.push({ label: c.label, colour: c.colour, v, i: i + 1 });
    });
    onHover?.(u.data[0][idx], values);
    tip.replaceChildren();
    const head = document.createElement("div"); head.className = "x"; head.textContent = `${xLabel} ${fmt(u.data[0][idx])}`;
    tip.append(head);
    for (const r of rows.sort((a, b) => b.v - a.v).slice(0, 14)) {
      const row = document.createElement("div"); row.className = "r" + (near > 0 && rows.length > 1 ? (r.i === near ? " near" : " far") : "");
      const key = document.createElement("i"); key.style.background = r.colour;
      const val = document.createElement("b"); val.textContent = fmt(r.v);
      const name = document.createElement("span"); name.textContent = r.label;
      row.append(key, val, name); tip.append(row);
    }
    tip.hidden = !!onHover;                                 // the inspector shows these in its table instead
    const over = u.over, w = tip.offsetWidth, x = over.offsetLeft + left;
    tip.style.left = (x + 16 + w > u.root.clientWidth ? Math.max(0, x - w - 16) : x + 16) + "px";
    tip.style.top = over.offsetTop + 2 + "px";
  };
  return {
    hooks: {
      init: u => { tip = document.createElement("div"); tip.className = "tip"; tip.hidden = true; u.root.appendChild(tip); },
      setCursor: show,
      setSeries: (u, i) => { near = i ?? -1; show(u); },
    },
  };
}

/* A dot where each line ends, ringed in the page colour so it reads where lines cross: where the run has got to. */
function endDots(cols: Col[], ring: string): uPlot.Plugin {
  return {
    hooks: {
      draw: u => {
        const ctx = u.ctx, dpr = devicePixelRatio || 1;
        cols.forEach((c, i) => {
          if (c.role !== "line") return;
          const col = u.data[i + 1] as (number | null)[];
          let j = col.length - 1;
          while (j >= 0 && col[j] == null) j--;
          if (j < 0) return;
          const x = u.valToPos(u.data[0][j], "x", true), y = u.valToPos(col[j] as number, "y", true);
          if (!isFinite(x) || !isFinite(y) || x < u.bbox.left - 1 || x > u.bbox.left + u.bbox.width + 1) return;
          ctx.save();
          ctx.globalAlpha = u.series[i + 1].alpha ?? 1;
          ctx.beginPath(); ctx.arc(x, y, 3.5 * dpr, 0, 2 * Math.PI);
          ctx.fillStyle = c.colour; ctx.fill();
          ctx.lineWidth = 1.5 * dpr; ctx.strokeStyle = ring; ctx.stroke();
          ctx.restore();
        });
      },
    },
  };
}

/* On a log scale, a level line at each whole power of ten and nowhere else; within one decade, at 1, 2 and 5. */
function decades(_u: uPlot, _axis: number, lo: number, hi: number): number[] {
  const out: number[] = [];
  for (let e = Math.ceil(Math.log10(lo) - 1e-9); e <= Math.floor(Math.log10(hi) + 1e-9); e++) out.push(10 ** e);
  if (out.length >= 2) return out;
  const fine: number[] = [];
  for (let e = Math.floor(Math.log10(lo)); e <= Math.ceil(Math.log10(hi)); e++) for (const k of [1, 2, 5]) { const v = k * 10 ** e; if (v >= lo && v <= hi) fine.push(v); }
  return fine.length >= 2 ? fine : [lo, hi];
}

type ChartProps = {
  lines: Line[]; xLabel: string; logY: boolean; smooth: number; syncKey?: string; height: number; theme: string;
  range?: Range; onRange?: (r: Range) => void; trim?: boolean; onHover?: (x: number | null, values: (number | null)[]) => void;
};

export function Chart({ lines, xLabel, logY, smooth, syncKey, height, theme, range, onRange, trim, onHover }: ChartProps) {
  const host = useRef<HTMLDivElement>(null);
  const plot = useRef<uPlot | null>(null);
  const live = useRef({ onRange, onHover, range });
  live.current = { onRange, onHover, range };
  useEffect(() => {
    const el = host.current;
    if (!el || !lines.some(l => l.x.length)) return;
    const cols: Col[] = [];
    const tables: uPlot.AlignedData[] = [];
    const bands: uPlot.Band[] = [];
    const clip = (y: number[]) => (logY ? y.map(v => (v > 0 ? v : null)) : y) as (number | null)[];
    lines.forEach((l, line) => {
      if (!l.x.length) return;
      const colour = cssColour(l.slot >= 1 && l.slot <= 8 ? `--s${l.slot}` : "--faint");
      tables.push([l.x, clip(smoothed(l.y, smooth))]); cols.push({ label: l.label, colour, role: "line", line });
      if (smooth) { tables.push([l.x, clip(l.y)]); cols.push({ label: l.label, colour, role: "logged", line }); }
      if (l.lo && l.hi && (l.members ?? 0) > 1) {
        tables.push([l.x, clip(l.hi)], [l.x, clip(l.lo)]);
        cols.push({ label: l.label, colour, role: "edge", line }, { label: l.label, colour, role: "edge", line });
        bands.push({ series: [cols.length - 1, cols.length], fill: tint(colour, 0.16) });
      }
    });
    const data = tables.length === 1 ? tables[0] : uPlot.join(tables);
    // With "ignore outliers", the y axis fits the middle 96% of what was logged, so one spike does not flatten the rest.
    let fit: [number, number] | null = null;
    if (trim && !logY) {
      const all = lines.flatMap(l => l.y).filter(isFinite).sort((a, b) => a - b);
      if (all.length > 20) { const a = all[Math.floor(all.length * 0.02)], b = all[Math.ceil(all.length * 0.98) - 1], pad = (b - a) * 0.1 || 1; fit = [a - pad, b + pad]; }
    }
    const ink = cssColour("--muted"), level = cssColour("--grid"), base = cssColour("--rule"), page = cssColour(el.closest(".modal-box") ? "--panel" : "--bg");
    const font = '11px "Instrument Sans", system-ui, sans-serif';
    const labels = (_u: uPlot, vals: number[]) => vals.map(v => (v == null ? "" : tick(v)));
    const u = new uPlot({
      width: Math.max(200, el.clientWidth), height,
      padding: [8, 10, 0, 0],
      scales: {
        x: { time: false },
        // a number that never changed gets a little room round it, not uPlot's default of a hundred units
        y: logY ? { distr: 3 } : { range: (_u, lo, hi) => fit ?? (lo === hi ? (lo === 0 ? [0, 1] : [lo - Math.abs(lo) * 0.1, hi + Math.abs(hi) * 0.1]) : uPlot.rangeNum(lo, hi, 0.08, true)) },
      },
      axes: [
        { stroke: ink, font, size: 26, gap: 7, grid: { show: false }, ticks: { show: false }, border: { show: true, stroke: base, width: 1 }, values: labels, space: 70 },
        { stroke: ink, font, size: 46, gap: 8, grid: { stroke: level, width: 1 }, ticks: { show: false }, values: labels, space: 44,
          ...(logY ? { splits: decades, filter: (_u: uPlot, s: number[]) => s } : {}) },
      ],
      series: [{}, ...cols.map(c => ({
        label: c.label, stroke: c.role === "edge" ? tint(c.colour, 0) : c.colour, width: c.role === "line" ? 1.75 : c.role === "logged" ? 1 : 0,
        alpha: c.role === "logged" ? 0.28 : 1, spanGaps: true, points: { show: false },
      }))],
      bands,
      focus: { alpha: 0.22 },
      cursor: {
        sync: syncKey ? { key: syncKey } : undefined, drag: { x: true, y: false }, y: false, focus: { prox: 18 },
        points: { size: 8, width: 2, stroke: (_u: uPlot, i: number) => (cols[i - 1]?.role === "line" ? page : "transparent"),
          fill: (_u: uPlot, i: number) => (cols[i - 1]?.role === "line" ? cols[i - 1].colour : "transparent") },
      },
      legend: { show: false },
      hooks: {
        // A drag across one chart is a zoom for every chart; the others are told and follow.
        setSelect: [uu => { if (uu.select.width > 3) live.current.onRange?.([uu.posToVal(uu.select.left, "x"), uu.posToVal(uu.select.left + uu.select.width, "x")]); }],
      },
      plugins: [endDots(cols, page), readout(cols, xLabel, (x, v) => live.current.onHover?.(x, v))],
    }, data, el);
    const reset = () => live.current.onRange?.(null);
    u.over.addEventListener("dblclick", reset);
    plot.current = u;
    const r = live.current.range;
    if (r) u.setScale("x", { min: r[0], max: r[1] });
    const ro = new ResizeObserver(() => { if (Math.abs(el.clientWidth - u.width) > 4) u.setSize({ width: Math.max(200, el.clientWidth), height }); });
    ro.observe(el);
    return () => { ro.disconnect(); u.over.removeEventListener("dblclick", reset); u.destroy(); plot.current = null; };
  }, [lines, xLabel, logY, smooth, syncKey, height, theme, trim]);
  useEffect(() => {
    const u = plot.current;
    if (!u || !u.data[0].length) return;
    const xs = u.data[0];
    u.setScale("x", range ? { min: range[0], max: range[1] } : { min: xs[0], max: xs[xs.length - 1] });
  }, [range]);
  if (!lines.some(l => l.x.length)) return <div className="empty" style={{ height }}>nothing logged against {xLabel}</div>;
  return <div ref={host} className="plot" role="img" aria-label={`chart against ${xLabel}`} />;
}

export type Drawn = { id: string; name: string; slot: number; group?: string };
export type View = {
  x: string; xLabel: string; smooth: number; logs: Record<string, boolean>; setLog: (key: string, on: boolean) => void; theme: string; tickN: number;
  range?: Range; setRange?: (r: Range) => void; trim?: boolean; bundled?: boolean;
};

function download(name: string, href: string) {
  const a = document.createElement("a"); a.href = href; a.download = name; a.click();
}

/* The chart opened large, with a table that reads it. */
function Inspector({ name, lines, xLabel, logY, view, sync, close }:
  { name: string; lines: Line[]; xLabel: string; logY: boolean; view: View; sync?: string; close: () => void }) {
  const [off, setOff] = useState<Set<number>>(new Set());
  const [trim, setTrim] = useState(!!view.trim);
  const [range, setRange] = useState<Range>(view.range ?? null);
  const [at, setAt] = useState<{ x: number | null; values: (number | null)[] }>({ x: null, values: [] });
  const box = useRef<HTMLDivElement>(null);
  const shown = useMemo(() => lines.map((l, i) => (off.has(i) ? { ...l, x: [], y: [] } : l)), [lines, off]);
  const onHover = useCallback((x: number | null, values: (number | null)[]) => setAt({ x, values }), []);
  useEffect(() => { const esc = (e: KeyboardEvent) => e.key === "Escape" && close(); window.addEventListener("keydown", esc); return () => window.removeEventListener("keydown", esc); }, [close]);
  const stats = lines.map(l => {
    let lo = Infinity, hi = -Infinity, loAt = NaN, hiAt = NaN;
    l.y.forEach((v, i) => { if (v < lo) { lo = v; loAt = l.x[i]; } if (v > hi) { hi = v; hiAt = l.x[i]; } });
    return { last: l.y[l.y.length - 1], lastAt: l.x[l.x.length - 1], lo, loAt, hi, hiAt };
  });
  const pick = (i: number, alone: boolean) => setOff(old => {
    if (alone) return old.size === lines.length - 1 && !old.has(i) ? new Set() : new Set(lines.map((_, j) => j).filter(j => j !== i));
    const next = new Set(old); next.has(i) ? next.delete(i) : next.add(i); return next;
  });
  const csv = () => {
    const rows = ["run," + xLabel + "," + name, ...lines.flatMap(l => l.x.map((x, i) => `${JSON.stringify(l.label)},${x},${l.y[i]}`))];
    download(name.replace(/[^\w.-]+/g, "_") + ".csv", URL.createObjectURL(new Blob([rows.join("\n")], { type: "text/csv" })));
  };
  const png = () => {
    const src = box.current?.querySelector("canvas"); if (!src) return;
    const out = document.createElement("canvas"); out.width = src.width; out.height = src.height;
    const ctx = out.getContext("2d")!; ctx.fillStyle = cssColour("--panel"); ctx.fillRect(0, 0, out.width, out.height); ctx.drawImage(src, 0, 0);
    download(name.replace(/[^\w.-]+/g, "_") + ".png", out.toDataURL("image/png"));
  };
  return (
    <div className="modal" onClick={close}>
      <div className="modal-box" onClick={e => e.stopPropagation()} role="dialog" aria-label={name}>
        <div className="row">
          <h2>{name}</h2><span className="muted small">against {xLabel}</span><span className="grow" />
          <button className="small" aria-pressed={logY} onClick={() => view.setLog(name, !logY)}>Log scale</button>
          <button className="small" aria-pressed={trim} disabled={logY} title="fit the y axis to the middle 96% of the values" onClick={() => setTrim(!trim)}>Ignore outliers</button>
          {range && <button className="small" onClick={() => setRange(null)}>Reset zoom</button>}
          <button className="small" onClick={csv}>CSV</button><button className="small" onClick={png}>PNG</button>
          <button className="small" onClick={close}>Close</button>
        </div>
        <div ref={box}><Chart lines={shown} xLabel={xLabel} logY={logY} smooth={view.smooth} syncKey={sync ? sync + "-big" : undefined}
          height={Math.max(300, Math.min(560, window.innerHeight - 380))} theme={view.theme} range={range} onRange={setRange} trim={trim} onHover={onHover} /></div>
        <div className="scroll inspect"><table>
          <thead><tr><th>{view.bundled ? "group" : "run"}</th><th className="num">{at.x == null ? "under the pointer" : `at ${xLabel} ${fmt(at.x)}`}</th>
            <th className="num">latest</th><th className="num">lowest</th><th className="num">highest</th></tr></thead>
          <tbody>{lines.map((l, i) => (
            <tr key={i} className={off.has(i) ? "off" : ""} onClick={e => pick(i, e.altKey)} title="click to hide or show; alt-click to see it alone">
              <td><i className="swatch" style={{ background: l.slot ? `var(--s${l.slot})` : "var(--faint)" }} />{l.label}{l.members ? <span className="muted"> mean of {l.members}</span> : null}</td>
              <td className="num strong">{fmt(at.values[i])}</td>
              <td className="num">{fmt(stats[i].last)} <span className="muted">at {fmt(stats[i].lastAt)}</span></td>
              <td className="num">{fmt(isFinite(stats[i].lo) ? stats[i].lo : null)} <span className="muted">at {fmt(stats[i].loAt)}</span></td>
              <td className="num">{fmt(isFinite(stats[i].hi) ? stats[i].hi : null)} <span className="muted">at {fmt(stats[i].hiAt)}</span></td>
            </tr>))}</tbody>
        </table></div>
        <p className="muted small">Drag across the chart to zoom, double-click to reset. Click a row to hide that line, alt-click to see it alone.{view.smooth ? " Latest, lowest and highest are of the values as logged, not the smoothed line." : ""}</p>
      </div>
    </div>
  );
}

/* One chart in the grid: fetches its own numbers once it scrolls into view, and again when the runs grow. */
export function Panel({ name, title, runs, view, onHide, sync }:
  { name: string; title?: string; runs: Drawn[]; view: View; onHide?: () => void; sync?: string }) {
  const [ref, seen] = useSeen<HTMLElement>();
  const [data, setData] = useState<Record<string, Record<string, Series>> | null>(null);
  // "#/?inspect=<name>" opens that chart's inspector straight away, so a link can point at one chart
  const [big, setBig] = useState(() => new URLSearchParams(location.hash.split("?")[1] ?? "").get("inspect") === name);
  const ids = runs.map(r => r.id).join(",");
  const x = name.startsWith("sys/") ? "_t" : view.x;
  useEffect(() => {
    if (!seen || !ids) return;
    let alive = true;
    api(`/api/v2/series?runs=${enc(ids)}&keys=${enc(name)}&x=${enc(x)}&points=${big ? 6000 : 1500}`).then(d => { if (alive) setData(d); }, () => {});
    return () => { alive = false; };
  }, [seen, ids, name, x, view.tickN, big]);
  const lines: Line[] = useMemo(() => {
    const each = runs.map(r => {
      const s = data?.[r.id]?.[name];
      return { label: r.name, slot: r.slot, x: s ? (x === "_t" ? s.x.map(v => v / 60) : s.x) : [], y: s ? s.y : [], group: r.group };
    });
    if (!view.bundled) return each;
    const groups = [...new Set(each.map(l => l.group ?? ""))];
    return groups.map(g => { const members = each.filter(l => (l.group ?? "") === g && l.x.length); return bundle(g, members[0]?.slot ?? 0, members); });
  }, [data, runs, name, x, view.bundled]);
  const logY = view.logs[name] ?? wantsLog(lines);
  const xLabel = x === "_t" ? "minutes" : view.xLabel;
  const only = lines.length === 1 && lines[0].y.length ? lines[0].y[lines[0].y.length - 1] : null;
  const close = useCallback(() => setBig(false), []);
  return (
    <figure className="chart" ref={ref}>
      <figcaption>
        <span className="t" title={name}>{title ?? name}</span>
        {only != null && <span className="now" title="the latest value">{fmt(only)}</span>}
        <span className="tools">
          <button aria-pressed={logY} title="log scale on the y axis" onClick={() => view.setLog(name, !logY)}>log</button>
          <button title="open large, with a table of every run's latest, lowest and highest" aria-label={`inspect ${name}`} onClick={() => setBig(true)}>inspect</button>
          {onHide && <button title="hide this chart" aria-label={`hide ${name}`} onClick={onHide}>hide</button>}
        </span>
      </figcaption>
      {data
        ? <Chart lines={lines} xLabel={xLabel} logY={logY} smooth={view.smooth} syncKey={sync} height={200} theme={view.theme}
            range={x === "_t" ? undefined : view.range} onRange={x === "_t" ? undefined : view.setRange} trim={view.trim} />
        : <div className="empty" style={{ height: 200 }} />}
      {big && <Inspector name={name} lines={lines} xLabel={xLabel} logY={logY} view={view} sync={sync} close={close} />}
    </figure>
  );
}

export const asDrawn = (runs: Run[], slots: Record<string, number>, groupOf?: (r: Run) => string): Drawn[] =>
  runs.map(r => ({ id: r.id, name: r.name, slot: slots[groupOf ? groupOf(r) : r.id] ?? 0, group: groupOf?.(r) }));
