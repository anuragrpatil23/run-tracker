/* Line charts, drawn with uPlot: a line per run, drag to zoom, double-click to reset, and a readout that follows
   the pointer on every chart on the page at once. */
import { useEffect, useMemo, useRef, useState } from "react";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import { api, cssColour, enc, fmt, Run, Series, tick, useSeen } from "./lib";

export type Line = { label: string; slot: number; x: number[]; y: number[] };

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

function readout(names: { label: string; colour: string; faint: boolean }[], xLabel: string): uPlot.Plugin {
  let tip: HTMLDivElement;
  return {
    hooks: {
      init: u => { tip = document.createElement("div"); tip.className = "tip"; tip.hidden = true; u.root.appendChild(tip); },
      setCursor: u => {
        const { left, idx } = u.cursor;
        if (idx == null || left == null || left < 0) { tip.hidden = true; return; }
        const rows: { label: string; colour: string; v: number }[] = [];
        names.forEach((s, i) => {
          if (s.faint) return;
          const col = u.data[i + 1] as (number | null)[];
          let v = col[idx];
          for (let d = 1; v == null && d < 40; d++) v = col[idx - d] ?? col[idx + d];       // a run with no point exactly here: its nearest
          if (v != null) rows.push({ label: s.label, colour: s.colour, v });
        });
        tip.replaceChildren();
        const head = document.createElement("div"); head.className = "x"; head.textContent = `${xLabel} ${fmt(u.data[0][idx])}`;
        tip.append(head);
        for (const r of rows.sort((a, b) => b.v - a.v).slice(0, 14)) {
          const row = document.createElement("div"); row.className = "r";
          const key = document.createElement("i"); key.className = "swatch"; key.style.background = r.colour;
          const val = document.createElement("b"); val.textContent = fmt(r.v);
          const name = document.createElement("span"); name.textContent = r.label;
          row.append(key, val, name); tip.append(row);
        }
        tip.hidden = false;
        const over = u.over, w = tip.offsetWidth, x = over.offsetLeft + left;
        tip.style.left = (x + 14 + w > u.root.clientWidth ? Math.max(0, x - w - 14) : x + 14) + "px";
        tip.style.top = over.offsetTop + 4 + "px";
      },
    },
  };
}

export function Chart({ lines, xLabel, logY, smooth, syncKey, height, theme }:
  { lines: Line[]; xLabel: string; logY: boolean; smooth: number; syncKey?: string; height: number; theme: string }) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = host.current;
    const drawn = lines.filter(l => l.x.length);
    if (!el || !drawn.length) return;
    const names: { label: string; colour: string; faint: boolean }[] = [];
    const tables: uPlot.AlignedData[] = [];
    const clip = (y: number[]) => (logY ? y.map(v => (v > 0 ? v : null)) : y) as (number | null)[];
    for (const l of drawn) {
      const colour = cssColour(l.slot >= 1 && l.slot <= 8 ? `--s${l.slot}` : "--muted");
      tables.push([l.x, clip(smoothed(l.y, smooth))]); names.push({ label: l.label, colour, faint: false });
      if (smooth) { tables.push([l.x, clip(l.y)]); names.push({ label: l.label, colour, faint: true }); }   // what was logged, faint, behind the smoothed line
    }
    const data = tables.length === 1 ? tables[0] : uPlot.join(tables);
    const muted = cssColour("--muted"), grid = cssColour("--grid"), font = '11px "IBM Plex Mono", ui-monospace, Menlo, monospace';
    const axis = (extra: Partial<uPlot.Axis>): uPlot.Axis => ({
      stroke: muted, font, grid: { stroke: grid, width: 1 }, ticks: { stroke: grid, width: 1, size: 4 },
      values: (_u, vals) => vals.map(v => (v == null ? "" : tick(v))), ...extra,
    });
    const u = new uPlot({
      width: Math.max(200, el.clientWidth), height,
      scales: {
        x: { time: false },
        // a number that never changed gets a little room round it, not uPlot's default of a hundred units
        y: logY ? { distr: 3 } : { range: (_u, lo, hi) => (lo === hi ? (lo === 0 ? [0, 1] : [lo - Math.abs(lo) * 0.1, hi + Math.abs(hi) * 0.1]) : uPlot.rangeNum(lo, hi, 0.08, true)) },
      },
      axes: [axis({ label: xLabel, labelSize: 16, labelFont: font, size: 34 }), axis({ size: 52 })],
      series: [{}, ...names.map(s => ({
        label: s.label, stroke: s.colour, width: s.faint ? 1 : 2, alpha: s.faint ? 0.3 : 1, spanGaps: true,
        points: { show: drawn.every(l => l.x.length < 2), size: 7 },
      }))],
      cursor: { sync: syncKey ? { key: syncKey } : undefined, drag: { x: true, y: false }, points: { size: 7 } },
      legend: { show: false },
      plugins: [readout(names, xLabel)],
    }, data, el);
    const ro = new ResizeObserver(() => { if (Math.abs(el.clientWidth - u.width) > 4) u.setSize({ width: Math.max(200, el.clientWidth), height }); });
    ro.observe(el);
    return () => { ro.disconnect(); u.destroy(); };
  }, [lines, xLabel, logY, smooth, syncKey, height, theme]);
  if (!lines.some(l => l.x.length)) return <div className="empty" style={{ height }}>nothing logged under this name against {xLabel}</div>;
  return <div ref={host} className="plot" role="img" aria-label={`chart against ${xLabel}`} />;
}

export type Drawn = { id: string; name: string; slot: number };
export type View = { x: string; xLabel: string; smooth: number; logs: Record<string, boolean>; setLog: (key: string, on: boolean) => void; theme: string; tickN: number };

/* One chart in a box: fetches its own numbers once it scrolls into view, and again when the runs grow. */
export function Panel({ name, title, runs, view, onHide, sync }:
  { name: string; title?: string; runs: Drawn[]; view: View; onHide?: () => void; sync?: string }) {
  const [ref, seen] = useSeen<HTMLElement>();
  const [data, setData] = useState<Record<string, Record<string, Series>> | null>(null);
  const [big, setBig] = useState(false);
  const ids = runs.map(r => r.id).join(",");
  const x = name.startsWith("sys/") ? "_t" : view.x;
  useEffect(() => {
    if (!seen || !ids) return;
    let alive = true;
    api(`/api/v2/series?runs=${enc(ids)}&keys=${enc(name)}&x=${enc(x)}&points=${big ? 6000 : 1500}`).then(d => { if (alive) setData(d); }, () => {});
    return () => { alive = false; };
  }, [seen, ids, name, x, view.tickN, big]);
  const lines: Line[] = useMemo(() => runs.map(r => {
    const s = data?.[r.id]?.[name];
    const xs = s ? (x === "_t" ? s.x.map(v => v / 60) : s.x) : [];
    return { label: r.name, slot: r.slot, x: xs, y: s ? s.y : [] };
  }), [data, runs, name, x]);
  const logY = view.logs[name] ?? wantsLog(lines);
  const xLabel = x === "_t" ? "minutes" : view.xLabel;
  const body = (height: number) => data
    ? <Chart lines={lines} xLabel={xLabel} logY={logY} smooth={view.smooth} syncKey={sync} height={height} theme={view.theme} />
    : <div className="empty" style={{ height }}>…</div>;
  return (
    <figure className="panel chart" ref={ref}>
      <figcaption>
        <span className="t" title={name}>{title ?? name}</span>
        <button className="small" aria-pressed={logY} title="log scale on the y axis" onClick={() => view.setLog(name, !logY)}>log</button>
        <button className="small" title="open this chart large" onClick={() => setBig(true)}>⤢</button>
        {onHide && <button className="small" title="hide this chart" aria-label={`hide ${name}`} onClick={onHide}>×</button>}
      </figcaption>
      {body(200)}
      {big && (
        <div className="modal" onClick={() => setBig(false)}>
          <div className="modal-box" onClick={e => e.stopPropagation()}>
            <div className="row"><h2 className="mono">{name}</h2><span className="grow" />
              <span className="muted">drag to zoom · double-click to reset</span><button onClick={() => setBig(false)}>Close</button></div>
            {body(Math.max(320, Math.min(640, window.innerHeight - 260)))}
            <div className="legend">{runs.map(r => <span key={r.id}><i className="swatch" style={{ background: r.slot ? `var(--s${r.slot})` : "var(--muted)" }} />{r.name}</span>)}</div>
          </div>
        </div>
      )}
    </figure>
  );
}

export const asDrawn = (runs: Run[], slots: Record<string, number>): Drawn[] => runs.map(r => ({ id: r.id, name: r.name, slot: slots[r.id] ?? 0 }));
