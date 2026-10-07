/* The workspace: the runs down the left, and what they logged on the right. Ticking a run draws it on every chart. */
import { useMemo, useState } from "react";
import { asDrawn, Panel, View } from "./Chart";
import { api, differing, dur, enc, fmt, isNum, KeyInfo, Run, runHref, slotVar, tick, usePoll, useSlots, useStored, when } from "./lib";

export const Badge = ({ run }: { run: Pick<Run, "state" | "why"> }) => <span className={"state " + run.state} title={run.why || ""}><i />{run.state}</span>;

type Shared = { runs: Run[]; theme: string; say: (text: string) => void };

export function Workspace({ runs, theme, say }: Shared) {
  const [filter, setFilter] = useStored("filter", "");
  const [groupBy, setGroupBy] = useStored("groupBy", "");
  const [sortBy, setSortBy] = useStored("sortBy", "newest");
  const [picked, setPicked] = useStored<string[] | null>("picked", null);
  const [tab, setTab] = useStored("tab", "charts");
  const [x, setX] = useStored("x", "step");
  const [smooth, setSmooth] = useStored("smooth", 0);
  const [logs, setLogs] = useStored<Record<string, boolean>>("logs", {});
  const [hidden, setHidden] = useStored<string[]>("hiddenPanels", []);
  const [narrow, setNarrow] = useStored("listNarrow", false);

  const diff = useMemo(() => differing(runs), [runs]);
  const value = (r: Run, key: string): unknown => key === "source" ? r.source : key === "project" ? r.project ?? "(none)" : key === "state" ? r.state : r.settings[key];
  const shown = useMemo(() => {
    const words = filter.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const hay = (r: Run) => [r.id, r.name, r.state, r.note, r.project ?? "", ...r.tags, ...Object.entries(r.settings).map(([k, v]) => `${k}=${v}`)].join(" ").toLowerCase();
    const order = (r: Run): unknown => sortBy === "newest" ? -(r.started ?? 0) : sortBy === "name" ? r.name : sortBy === "step" ? -(r.step ?? 0) : r.settings[sortBy.slice(4)];
    return runs.filter(r => words.every(w => hay(r).includes(w))).sort((a, b) => {
      const p = order(a) as any, q = order(b) as any;
      return (p == null ? 1 : 0) - (q == null ? 1 : 0) || (p < q ? -1 : p > q ? 1 : 0) || a.name.localeCompare(b.name);
    });
  }, [runs, filter, sortBy]);
  // Until the reader chooses, the first eight are drawn: that is how many colours can be told apart.
  const drawnRuns = useMemo(() => (picked ? shown.filter(r => picked.includes(r.id)) : shown.slice(0, 8)), [shown, picked]);
  const slots = useSlots(drawnRuns.map(r => r.id));
  const drawn = useMemo(() => asDrawn(drawnRuns, slots), [drawnRuns, slots]);
  const isOn = (id: string) => drawnRuns.some(r => r.id === id);
  const toggle = (ids: string[], on: boolean) => {
    const now = new Set(drawnRuns.map(r => r.id));
    ids.forEach(id => (on ? now.add(id) : now.delete(id)));
    setPicked([...now]);
  };

  const ids = drawnRuns.map(r => r.id).join(",");
  const grown = drawnRuns.reduce((n, r) => n + r.lines, 0);
  const { data: keyMap } = usePoll<Record<string, KeyInfo[]>>(() => (ids ? api(`/api/v2/keys?runs=${enc(ids)}`) : Promise.resolve({})), 0, [ids, grown]);
  const keys = useMemo(() => {
    const all = new Map<string, { clock: boolean; kind: string }>();
    for (const list of Object.values(keyMap ?? {})) for (const k of list) {
      const old = all.get(k.key);
      all.set(k.key, { kind: k.kind, clock: (old ? old.clock : true) && k.mono && k.kind === "number" && (k.hi ?? 0) > (k.lo ?? 0) });
    }
    return all;
  }, [keyMap]);
  const numbers = [...keys].filter(([, v]) => v.kind === "number").map(([k]) => k);
  const clocks = numbers.filter(k => keys.get(k)!.clock && !k.includes(".") && !k.startsWith("sys/"));
  const xChoices: [string, string][] = [["step", "step"], ...clocks.map(k => [k, k] as [string, string]), ["_t", "time (minutes)"]];
  const xNow = xChoices.some(c => c[0] === x) ? x : "step";
  const view: View = {
    x: xNow, xLabel: xChoices.find(c => c[0] === xNow)![1].replace("time (minutes)", "minutes"), smooth, logs, theme, tickN: grown,
    setLog: (key, on) => setLogs(old => ({ ...old, [key]: on })),
  };
  const plain = numbers.filter(k => !k.startsWith("sys/") && !k.includes(".") && !clocks.includes(k));
  const nested = new Map<string, string[]>();
  for (const k of numbers) if (!k.startsWith("sys/") && k.includes(".")) { const g = k.split(".")[0]; nested.set(g, [...(nested.get(g) ?? []), k]); }
  const machine = numbers.filter(k => k.startsWith("sys/"));
  const visible = (list: string[]) => list.filter(k => !hidden.includes(k));

  const groups = useMemo(() => {
    if (!groupBy) return [["", shown] as [string, Run[]]];
    const m = new Map<string, Run[]>();
    for (const r of shown) { const g = fmt(value(r, groupBy)) || "(not set)"; m.set(g, [...(m.get(g) ?? []), r]); }
    return [...m].sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true }));
  }, [shown, groupBy]);

  async function exportPage() {
    const title = prompt("Title for the page", `Comparing ${drawnRuns.length} runs`);
    if (!title) return;
    try {
      const r = await api("/api/export", { title, file: title, runs: drawnRuns.map(r => r.id), x: xNow === "_t" ? "_t" : xNow, charts: visible(plain).map(f => ({ field: f, logY: logs[f] })) });
      say("Saved to " + r.path);
    } catch (e: any) { say(e.message); }
  }

  return (
    <div className={"workspace" + (narrow ? " narrow" : "")}>
      <aside className="runs" aria-label="Runs">
        <div className="row">
          <input type="search" className="grow" placeholder="Filter: name, tag, lam=0.2" value={filter} aria-label="Filter the runs" onChange={e => setFilter(e.target.value)} />
          <button className="small" title={narrow ? "widen the list" : "narrow the list"} onClick={() => setNarrow(!narrow)}>{narrow ? "»" : "«"}</button>
        </div>
        <div className="row">
          <label className="inline">group<select value={groupBy} onChange={e => setGroupBy(e.target.value)}>
            <option value="">none</option><option value="source">source</option><option value="project">project</option><option value="state">state</option>
            {diff.map(k => <option key={k} value={k}>{k}</option>)}</select></label>
          <label className="inline">sort<select value={sortBy} onChange={e => setSortBy(e.target.value)}>
            <option value="newest">newest</option><option value="name">name</option><option value="step">furthest</option>
            {diff.map(k => <option key={k} value={"set:" + k}>{k}</option>)}</select></label>
        </div>
        <div className="row muted small">
          <span>{drawnRuns.length} drawn of {shown.length}{shown.length !== runs.length ? ` (${runs.length} in all)` : ""}</span><span className="grow" />
          <button className="small" onClick={() => setPicked(shown.slice(0, 8).map(r => r.id))}>first 8</button>
          <button className="small" onClick={() => setPicked([])}>none</button>
        </div>
        {drawnRuns.length > 8 && <p className="note-warn small">More than eight runs are drawn. There are eight colours that can be told apart, so the rest are grey; hover a chart to read which is which.</p>}
        <div className="runlist">
          {groups.map(([label, list]) => (
            <div key={label}>
              {groupBy && <div className="grouphead"><input type="checkbox" aria-label={`draw all of ${label}`} checked={list.every(r => isOn(r.id))}
                onChange={e => toggle(list.map(r => r.id), e.target.checked)} /><b>{groupBy} {label}</b><span className="muted">{list.length}</span></div>}
              {list.map(r => (
                <div key={r.id} className={"runrow" + (isOn(r.id) ? " on" : "")}>
                  <input type="checkbox" checked={isOn(r.id)} aria-label={`draw ${r.name}`} onChange={e => toggle([r.id], e.target.checked)} />
                  <i className="swatch" style={{ background: isOn(r.id) ? slotVar(slots[r.id]) : "transparent" }} />
                  <a href={runHref(r.id)} title={r.id}>{r.name}</a>
                  <Badge run={r} />
                  <span className="num muted">{r.step == null ? "" : tick(r.step)}</span>
                </div>
              ))}
            </div>
          ))}
          {!runs.length && <div className="muted small" style={{ padding: 10 }}>No runs yet. Add a source and sync:<pre>rt source add NAME --root /path/to/runs --ssh HOST{"\n"}rt sync</pre></div>}
        </div>
      </aside>

      <section className="main">
        <div className="row toolbar">
          <div className="tabs" role="tablist">
            {[["charts", "Charts"], ["table", "Table"], ["settings", "Settings"], ["sweep", "One number against a setting"]].map(([k, label]) =>
              <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)}>{label}</button>)}
          </div>
          <span className="grow" />
          {tab === "charts" && <>
            <label className="inline">against<select value={xNow} onChange={e => setX(e.target.value)}>{xChoices.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
            <label className="inline" title="a running average; the line as logged stays behind it, faint">smoothing
              <input type="range" min={0} max={0.99} step={0.01} value={smooth} onChange={e => setSmooth(+e.target.value)} /><span className="mono">{smooth.toFixed(2)}</span></label>
            <button onClick={exportPage}>Export as a page</button>
          </>}
        </div>

        {tab === "charts" && (drawn.length === 0 ? <p className="muted">Tick runs on the left to draw them.</p> : <>
          <div className="grid">{visible(plain).map(k => <Panel key={k} name={k} runs={drawn} view={view} sync="ws" onHide={() => setHidden([...hidden, k])} />)}</div>
          {[...nested].map(([g, list]) => (
            <details key={g} className="section" open={list.length <= 6}>
              <summary><b className="mono">{g}</b> <span className="muted">{list.length} numbers</span></summary>
              <div className="grid">{visible(list).map(k => <Panel key={k} name={k} title={k.slice(g.length + 1)} runs={drawn} view={view} sync="ws" onHide={() => setHidden([...hidden, k])} />)}</div>
            </details>
          ))}
          {machine.length > 0 && (
            <details className="section">
              <summary><b>The machine</b> <span className="muted">{machine.length} numbers, against minutes since the run began</span></summary>
              <div className="grid">{visible(machine).map(k => <Panel key={k} name={k} title={k.slice(4)} runs={drawn} view={view} sync="ws-sys" onHide={() => setHidden([...hidden, k])} />)}</div>
            </details>
          )}
          {hidden.length > 0 && <p className="muted small">{hidden.length} hidden: {hidden.map(k => <button key={k} className="small" onClick={() => setHidden(hidden.filter(h => h !== k))}>{k} ＋</button>)}</p>}
          {!numbers.length && keyMap && <p className="muted">These runs have logged no numbers yet.</p>}
        </>)}

        {tab === "table" && <RunTable runs={shown} diff={diff} metrics={plain} slots={slots} isOn={isOn} toggle={toggle} />}
        {tab === "settings" && <SettingsDiff runs={drawnRuns} slots={slots} />}
        {tab === "sweep" && <Sweep runs={drawnRuns} slots={slots} metrics={[...plain, ...[...nested.values()].flat()]} />}
      </section>
    </div>
  );
}

function RunTable({ runs, diff, metrics, slots, isOn, toggle }:
  { runs: Run[]; diff: string[]; metrics: string[]; slots: Record<string, number>; isOn: (id: string) => boolean; toggle: (ids: string[], on: boolean) => void }) {
  const [sort, setSort] = useState<{ key: string; dir: number }>({ key: "", dir: 1 });
  const val = (r: Run, k: string): any => k.startsWith("set:") ? r.settings[k.slice(4)] : k.startsWith("m:") ? r.latest[k.slice(2)] : (r as any)[k];
  const rows = sort.key ? [...runs].sort((a, b) => { const p = val(a, sort.key), q = val(b, sort.key); return (p == null ? 1 : 0) - (q == null ? 1 : 0) || (p < q ? -1 : p > q ? 1 : 0) * sort.dir; }) : runs;
  const Th = ({ k, label, num }: { k: string; label: string; num?: boolean }) =>
    <th className={"sort" + (num ? " num set" : "")} onClick={() => setSort({ key: k, dir: sort.key === k ? -sort.dir : 1 })}>{label}{sort.key === k ? (sort.dir > 0 ? " ↑" : " ↓") : ""}</th>;
  return (
    <div className="panel"><div className="scroll"><table>
      <thead><tr><th /><Th k="name" label="run" /><Th k="state" label="state" /><Th k="step" label="step" num /><Th k="seconds" label="time" num /><Th k="started" label="started" />
        {diff.map(k => <Th key={k} k={"set:" + k} label={k} num />)}{metrics.map(k => <Th key={k} k={"m:" + k} label={k} num />)}<th>note</th></tr></thead>
      <tbody>{rows.map(r => (
        <tr key={r.id} className={isOn(r.id) ? "sel" : ""}>
          <td><input type="checkbox" checked={isOn(r.id)} aria-label={`draw ${r.name}`} onChange={e => toggle([r.id], e.target.checked)} /></td>
          <td>{isOn(r.id) && <i className="swatch" style={{ background: slotVar(slots[r.id]) }} />}<a href={runHref(r.id)}>{r.name}</a> <span className="muted">{r.source}</span> {r.tags.map(t => <span key={t} className="tag">{t}</span>)}</td>
          <td><Badge run={r} /></td>
          <td className="num">{r.total ? `${fmt(r.step ?? 0)} / ${fmt(r.total)}` : fmt(r.step)}</td>
          <td className="num">{dur(r.seconds)}</td><td>{when(r.started)}</td>
          {diff.map(k => <td key={k} className="num clip" title={String(r.settings[k] ?? "")}>{fmt(r.settings[k])}</td>)}
          {metrics.map(k => <td key={k} className="num">{fmt(r.latest[k])}</td>)}
          <td><input type="text" defaultValue={r.note} placeholder="one line about this run" aria-label={`note for ${r.name}`}
            onBlur={e => { if (e.target.value !== r.note) api("/api/local", { id: r.id, note: e.target.value }); }} /></td>
        </tr>))}</tbody>
    </table></div></div>
  );
}

function SettingsDiff({ runs, slots }: { runs: Run[]; slots: Record<string, number> }) {
  const [all, setAll] = useState(false);
  const diff = differing(runs);
  const keys = all ? [...new Set(runs.flatMap(r => Object.keys(r.settings)))].sort() : diff;
  if (!runs.length) return <p className="muted">Tick runs on the left to set their settings side by side.</p>;
  return (
    <div className="panel">
      <div className="row"><h2>{all ? "Every setting" : "Where the settings differ"}</h2><span className="grow" />
        <button className="small" aria-pressed={all} onClick={() => setAll(!all)}>show every setting</button></div>
      <div className="scroll"><table>
        <thead><tr><th className="set">setting</th>{runs.map(r => <th key={r.id} className="num"><i className="swatch" style={{ background: slotVar(slots[r.id]) }} /><a href={runHref(r.id)}>{r.name}</a></th>)}</tr></thead>
        <tbody>{keys.map(k => <tr key={k} className={diff.includes(k) && all ? "sel" : ""}><td className="mono">{k}</td>
          {runs.map(r => <td key={r.id} className="num clip" title={String(r.settings[k] ?? "")}>{fmt(r.settings[k])}</td>)}</tr>)}</tbody>
      </table></div>
      {!keys.length && <p className="muted">These runs were started with the same settings.</p>}
    </div>
  );
}

/* One dot per run: a number the runs logged, against a setting they were started with. The picture for choosing a value. */
function Sweep({ runs, slots, metrics }: { runs: Run[]; slots: Record<string, number>; metrics: string[] }) {
  const [pick, setPick] = useStored<{ setting?: string; metric?: string; logX?: boolean; logY?: boolean }>("sweep", {});
  const numeric = [...new Set(runs.flatMap(r => Object.keys(r.settings)))].filter(k => runs.some(r => isNum(r.settings[k])));
  const varied = differing(runs).filter(k => numeric.includes(k));
  const setting = pick.setting && numeric.includes(pick.setting) ? pick.setting : varied[0] ?? numeric[0];
  const metric = pick.metric && metrics.includes(pick.metric) ? pick.metric : metrics[0];
  if (!setting || !metric) return <p className="muted">Tick runs that have a setting that is a number, and that have logged numbers.</p>;
  const pts = runs.map(r => ({ x: r.settings[setting] as number, y: r.latest[metric], name: r.name, slot: slots[r.id] ?? 0 }))
    .filter(p => isNum(p.x) && isNum(p.y) && (!pick.logX || p.x > 0) && (!pick.logY || p.y > 0)).sort((a, b) => a.x - b.x);
  const W = 900, H = 380, m = { l: 70, r: 170, t: 16, b: 46 };
  const span = (vs: number[], log?: boolean): [number, number] => {
    let lo = Math.min(...vs), hi = Math.max(...vs);
    if (log) return lo === hi ? [lo / 2, hi * 2] : [lo / 1.3, hi * 1.3];
    const pad = (hi - lo) * 0.08 || Math.abs(hi) * 0.1 || 1;
    return [lo - pad, hi + pad];
  };
  const scale = ([lo, hi]: [number, number], a: number, b: number, log?: boolean) => (v: number) =>
    log ? a + (Math.log10(v) - Math.log10(lo)) / (Math.log10(hi) - Math.log10(lo)) * (b - a) : a + (v - lo) / (hi - lo) * (b - a);
  const ticks = ([lo, hi]: [number, number], log?: boolean) => {
    if (log) { const out = []; for (let e = Math.floor(Math.log10(lo)); e <= Math.ceil(Math.log10(hi)); e++) for (const k of [1, 2, 5]) { const v = k * 10 ** e; if (v >= lo && v <= hi) out.push(v); } return out; }
    const raw = (hi - lo) / 5, mag = 10 ** Math.floor(Math.log10(raw)), step = [1, 2, 2.5, 5, 10].map(k => k * mag).find(k => k >= raw)!;
    const out = []; for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) out.push(+v.toPrecision(12)); return out;
  };
  const xs = pts.length ? span(pts.map(p => p.x), pick.logX) : [0, 1] as [number, number], ys = pts.length ? span(pts.map(p => p.y), pick.logY) : [0, 1] as [number, number];
  const px = scale(xs, m.l, W - m.r, pick.logX), py = scale(ys, H - m.b, m.t, pick.logY);
  let lastY = -99;
  return (
    <div className="panel">
      <div className="row end">
        <label>setting<select value={setting} onChange={e => setPick({ ...pick, setting: e.target.value })}>{[...varied, ...numeric.filter(k => !varied.includes(k))].map(k => <option key={k}>{k}</option>)}</select></label>
        <label>number (its latest value)<select value={metric} onChange={e => setPick({ ...pick, metric: e.target.value })}>{metrics.map(k => <option key={k}>{k}</option>)}</select></label>
        <button className="small" aria-pressed={!!pick.logX} onClick={() => setPick({ ...pick, logX: !pick.logX })}>log x</button>
        <button className="small" aria-pressed={!!pick.logY} onClick={() => setPick({ ...pick, logY: !pick.logY })}>log y</button>
      </div>
      {pts.length === 0 ? <p className="muted">No drawn run has both {setting} and {metric} as numbers{pick.logX || pick.logY ? " above zero" : ""}.</p> : (
        <svg viewBox={`0 0 ${W} ${H}`} className="dots" role="img" aria-label={`${metric} against ${setting}`}>
          {ticks(ys, pick.logY).map(v => <g key={v}><line className="gridline" x1={m.l} x2={W - m.r} y1={py(v)} y2={py(v)} /><text className="axt" x={m.l - 8} y={py(v) + 4} textAnchor="end">{tick(v)}</text></g>)}
          {ticks(xs, pick.logX).map(v => <text key={v} className="axt" x={px(v)} y={H - m.b + 18} textAnchor="middle">{tick(v)}</text>)}
          <line className="base" x1={m.l} x2={W - m.r} y1={H - m.b} y2={H - m.b} />
          <text className="axt" x={(m.l + W - m.r) / 2} y={H - 6} textAnchor="middle">{setting}</text>
          <text className="axt" x={14} y={(m.t + H - m.b) / 2} textAnchor="middle" transform={`rotate(-90 14 ${(m.t + H - m.b) / 2})`}>{metric}</text>
          <path d={pts.map((p, i) => (i ? "L" : "M") + px(p.x).toFixed(1) + " " + py(p.y).toFixed(1)).join("")} fill="none" stroke="var(--rule)" strokeWidth={1.5} />
          {pts.map(p => {
            const ly = Math.abs(py(p.y) - lastY) < 13 ? lastY + 13 : py(p.y); lastY = ly;
            return <g key={p.name}><circle cx={px(p.x)} cy={py(p.y)} r={6} fill={slotVar(p.slot)} stroke="var(--panel)" strokeWidth={2}><title>{`${p.name}\n${setting} ${fmt(p.x)}\n${metric} ${fmt(p.y)}`}</title></circle>
              <text className="axt name" x={px(p.x) + 11} y={ly + 4}>{p.name.length > 24 ? p.name.slice(0, 23) + "…" : p.name}</text></g>;
          })}
        </svg>
      )}
      <div className="scroll"><table><thead><tr><th>run</th><th className="num set">{setting}</th><th className="num set">{metric}</th></tr></thead>
        <tbody>{pts.map(p => <tr key={p.name}><td><i className="swatch" style={{ background: slotVar(p.slot) }} />{p.name}</td><td className="num">{fmt(p.x)}</td><td className="num">{fmt(p.y)}</td></tr>)}</tbody></table></div>
    </div>
  );
}
