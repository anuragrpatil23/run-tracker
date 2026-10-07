/* What a run logged that is neither a number nor words: histograms, pictures and tables.

   Each was logged at some steps, so each panel has a slider to move through them, starting at the latest. A panel
   shows one run at a time; with several runs drawn, a menu chooses which.
     histogram  every step at once as a strip of columns, darker where more values fell, with the chosen step outlined
     picture    the pictures logged at the chosen step, with their captions; click one to see it large
     table      the table logged at the chosen step */
import { useEffect, useMemo, useRef, useState } from "react";
import { About, Drawn, Icon, Modal, View } from "./Chart";
import { api, cssColour, enc, fmt, tick, useSeen } from "./lib";

type Hist = { step: number; bins: number[]; values: number[] };
type Shots = { step: number; files: { path: string; caption: string }[] };
type Sheet = { step: number; columns: string[]; rows: unknown[][]; missing?: boolean };
type Logged = { kind: string; items: (Hist | Shots | Sheet)[] };

/* Every step's histogram as one column. The columns share one scale of values, so a distribution that widens or
   drifts shows as the dark band widening or drifting. */
function Strip({ items, at, pick, height, theme }: { items: Hist[]; at: number; pick: (i: number) => void; height: number; theme: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [tip, setTip] = useState("");
  const ROWS = 56;
  const grid = useMemo(() => {
    const lo = Math.min(...items.map(h => h.bins[0])), hi = Math.max(...items.map(h => h.bins[h.bins.length - 1]));
    const cols = items.map(h => {
      const col = new Array(ROWS).fill(0);
      h.values.forEach((v, i) => {                          // each bin's count goes to the row its middle falls in
        const mid = (h.bins[i] + h.bins[i + 1]) / 2, r = Math.min(ROWS - 1, Math.max(0, Math.floor((mid - lo) / (hi - lo || 1) * ROWS)));
        col[r] += v;
      });
      return col;
    });
    return { lo, hi, cols, top: Math.max(1, ...cols.flat()) };
  }, [items]);
  useEffect(() => {
    const c = ref.current; if (!c) return;
    const dpr = devicePixelRatio || 1, W = c.clientWidth, H = height;
    c.width = W * dpr; c.height = H * dpr;
    const g = c.getContext("2d")!; g.scale(dpr, dpr); g.clearRect(0, 0, W, H);
    const ink = cssColour("--s1"), cw = W / items.length, rh = H / ROWS;
    grid.cols.forEach((col, i) => col.forEach((v, r) => {
      if (!v) return;
      g.globalAlpha = 0.08 + 0.92 * Math.sqrt(v / grid.top);                    // the square root keeps thin tails visible
      g.fillStyle = ink; g.fillRect(i * cw, H - (r + 1) * rh, Math.ceil(cw) - (cw > 6 ? 1 : 0), Math.ceil(rh));
    }));
    g.globalAlpha = 1; g.strokeStyle = cssColour("--fg"); g.lineWidth = 1.5;
    g.strokeRect(at * cw + 0.75, 0.75, cw - 1.5, H - 1.5);
  }, [grid, at, height, theme, items.length]);
  const where = (e: React.MouseEvent) => {
    const b = ref.current!.getBoundingClientRect();
    const i = Math.min(items.length - 1, Math.max(0, Math.floor((e.clientX - b.left) / b.width * items.length)));
    const r = Math.min(ROWS - 1, Math.max(0, Math.floor((b.bottom - e.clientY) / b.height * ROWS)));
    return { i, r };
  };
  const span = (grid.hi - grid.lo) / ROWS;
  return (
    <div className="strip">
      <div className="yscale"><span>{tick(grid.hi)}</span><span>{tick(grid.lo)}</span></div>
      <canvas ref={ref} style={{ height }} role="img" aria-label="how the values were spread at each step"
        onMouseMove={e => { const { i, r } = where(e); setTip(`step ${fmt(items[i].step)}: ${fmt(grid.cols[i][r])} values between ${tick(grid.lo + r * span)} and ${tick(grid.lo + (r + 1) * span)}`); }}
        onMouseLeave={() => setTip("")} onClick={e => pick(where(e).i)} />
      <div className="readline">{tip || `Each column is one logged step, darker where more values fell. Step ${fmt(items[at].step)} is outlined.`}</div>
    </div>
  );
}

export function MediaPanel({ name, title, kind, runs, view, height, pinned, onPin, onHide }:
  { name: string; title: string; kind: string; runs: Drawn[]; view: View; height: number; pinned: boolean; onPin: () => void; onHide: () => void }) {
  const [ref, seen] = useSeen<HTMLElement>();
  const [runId, setRunId] = useState(runs[0]?.id ?? "");
  const [data, setData] = useState<Logged | null>(null);
  const [at, setAt] = useState<number | null>(null);         // null: follow the latest
  const [large, setLarge] = useState("");
  const id = runs.some(r => r.id === runId) ? runId : runs[0]?.id ?? "";
  useEffect(() => {
    if (!seen || !id) return;
    let alive = true;
    api(`/api/v2/media?id=${enc(id)}&key=${enc(name)}`).then(d => { if (alive) setData(d); }, () => {});
    return () => { alive = false; };
  }, [seen, id, name, view.tickN]);
  const items = data?.items ?? [];
  const i = at == null ? items.length - 1 : Math.min(at, items.length - 1);
  const now = items[i];
  const src = (path: string) => `/api/v2/file?id=${enc(id)}&path=${enc(path)}`;
  return (
    <figure className="chart media" ref={ref} data-chart={name}>
      <figcaption>
        <span className="t" title={name}>{title}</span>
        <span className="now">{kind}</span>
        <span className="tools">
          {runs.length > 1 && <select className="runpick" value={id} aria-label={`which run's ${name}`} onChange={e => { setRunId(e.target.value); setAt(null); }}>{runs.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}</select>}
          <button aria-pressed={pinned} aria-label={pinned ? `unpin ${name}` : `pin ${name}`} data-tip={pinned ? "Pinned. Click to unpin." : "Pin to the top"} onClick={onPin}><Icon name="pin" /></button>
          <button aria-label={`hide ${name}`} data-tip="Hide this" onClick={onHide}><Icon name="hide" /></button>
        </span>
      </figcaption>
      <About name={name} view={view} />
      {!data ? <div className="empty" style={{ height }} /> : !now ? <div className="empty" style={{ height }}>this run logged nothing under this name</div> : <>
        {kind === "histogram" && <Strip items={items as Hist[]} at={i} pick={setAt} height={height - 40} theme={view.theme} />}
        {kind === "image" && <div className="shots" style={{ minHeight: height - 40 }}>{(now as Shots).files.map(f =>
          <button key={f.path} className="shot" onClick={() => setLarge(f.path)} aria-label={`see ${f.caption || "this picture"} large`}>
            <img src={src(f.path)} alt={f.caption || `${name} at step ${now.step}`} style={{ maxHeight: height - 64 }} />{f.caption && <span>{f.caption}</span>}</button>)}</div>}
        {kind === "table" && ((now as Sheet).missing ? <div className="empty" style={{ height: height - 40 }}>the table's file has not been copied here</div>
          : <div className="sheet" style={{ maxHeight: height - 40 }}><table>
            <thead><tr>{(now as Sheet).columns.map(c => <th key={c} className={(now as Sheet).rows.every(r => typeof r[(now as Sheet).columns.indexOf(c)] === "number") ? "num" : ""}>{c}</th>)}</tr></thead>
            <tbody>{(now as Sheet).rows.map((r, j) => <tr key={j}>{r.map((v, k) => <td key={k} className={typeof v === "number" ? "num" : "mono"}>{typeof v === "string" ? v.replace(/^ +/, m => "·".repeat(m.length)) : fmt(v)}</td>)}</tr>)}</tbody>
          </table></div>)}
        <div className="stepper">
          {items.length > 1 ? <>
            <input type="range" min={0} max={items.length - 1} value={i} aria-label={`which logged step of ${name}`} onChange={e => setAt(+e.target.value === items.length - 1 ? null : +e.target.value)} />
            <span>step {fmt(now.step)} <span className="muted">{at == null ? `the latest of ${items.length} logged` : `number ${i + 1} of ${items.length} logged`}</span></span>
          </> : <span>step {fmt(now.step)}</span>}
        </div>
      </>}
      {large && <Modal close={() => setLarge("")}><div className="modal-box shotbox" onClick={e => e.stopPropagation()}>
        <div className="row"><h2>{name}</h2><span className="muted small">step {fmt(now?.step)}</span><span className="grow" /><button className="small" onClick={() => setLarge("")}>Close</button></div>
        <img src={src(large)} alt={name} /></div></Modal>}
    </figure>
  );
}
