/* Scan: type text, run it through a trained network, and see what lit up.

   The work is done by a scanner, a separate program the experiment owns. This view knows the scan contract
   (docs/scan.md) and nothing else: it draws whatever network the scanner describes and never assumes what kind it is.
   Requests go to the tracker's own server, which passes them on.

   What it shows: the network as a drawing; the text as the model split it; for the chosen step, a grid of tokens
   against that step's strongest units; one token's whole row as a strip; a unit's page; two texts set against each
   other; and the same text through several snapshots. */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, cssColour, enc, fmt, Run, sizeText, useStored } from "./lib";

type Node = { id: string; label: string; about?: string; group?: string | null; kind: string; width?: number; per?: string; lane: number; order: number;
  weights?: number; unit?: string; bend?: string; sparse?: boolean; described?: boolean };
type Graph = { title: string; groups?: { id: string; label: string }[]; nodes: Node[]; edges: { from: string; to: string; kind?: string }[] };
type Snapshot = { id: string; label: string; run?: string | null; step?: number; of?: number; available?: boolean; state?: string; file?: string };
type Top = [number, number, (string[] | null)?];
type NodeResult = { size?: number[]; on?: number[]; top?: Top[][]; grid?: { units: number[]; values: number[][]; words?: (string[] | null)[] } | number[][] };
type Result = { run: string; snapshot: string; tokens: { i: number; text: string }[]; nodes: Record<string, NodeResult>; next?: { text: string; chance: number }[] };
type Side = [number, number, (string[] | null)?][];
type Contrast = { tokens_a: { i: number; text: string }[]; tokens_b: { i: number; text: string }[]; pairs: [number, number][];
  per_pair: { same_text: boolean; distance: number; only_a: Side; only_b: Side; both: [number, number, number, (string[] | null)?][] }[]; whole: { only_a: Side; only_b: Side } };
type Health = { name: string; device?: string; max_tokens?: number; supports?: string[] };
type Problem = { code: string; message: string };

const showToken = (t: string) => t.replace(/^ +/, m => "·".repeat(m.length)).replace(/\n/g, "↵") || "∅";

/* The grid for one step: tokens down the side, units across. Blue above zero, red below, deeper the further from it. */
function Grid({ tokens, columns, values, heads, onUnit, label }:
  { tokens: string[]; columns: (number | string)[]; values: (number | null)[][]; heads?: (string[] | null)[]; onUnit?: (u: number) => void; label: string }) {
  const top = Math.max(1e-9, ...values.flat().map(v => Math.abs(v ?? 0)));
  const shade = (v: number | null) => (v == null || v === 0 ? "transparent" : `color-mix(in srgb, var(${v > 0 ? "--s1" : "--s8"}) ${Math.round(12 + 78 * Math.abs(v) / top)}%, transparent)`);
  if (!columns.length) return <p className="muted small">Nothing was on at this step for this text.</p>;
  return (
    <div className="scroll scangrid"><table aria-label={label}>
      <thead><tr><th />{columns.map((c, j) => <th key={j}>{typeof c === "number" && onUnit
        ? <button className="unit" onClick={() => onUnit(c)} data-tip="What this unit is">{heads?.[j]?.length ? <b>{heads[j]!.slice(0, 2).map(showToken).join(" ")}</b> : null}<span>{c}</span></button>
        : <span className="mono">{typeof c === "string" ? showToken(c) : c}</span>}</th>)}</tr></thead>
      <tbody>{tokens.map((t, i) => <tr key={i}><th className="mono">{showToken(t)}</th>
        {columns.map((_, j) => <td key={j} style={{ background: shade(values[i]?.[j] ?? null) }} title={values[i]?.[j] == null ? "not among this token's strongest" : fmt(values[i][j])}>{values[i]?.[j] ? fmt(+values[i][j]!.toPrecision(2)) : ""}</td>)}</tr>)}</tbody>
    </table></div>
  );
}

/* The network, drawn from what the scanner says: columns by order, rows by lane, a box round each group. */
function Drawing({ graph, picked, pick, recorded }: { graph: Graph; picked: string; pick: (id: string) => void; recorded: Set<string> }) {
  const orders = [...new Set(graph.nodes.map(n => n.order))].sort((a, b) => a - b);
  const lanes = [...new Set(graph.nodes.map(n => n.lane))].sort((a, b) => b - a);          // higher lanes are drawn above
  const CW = 106, RH = 78, BW = 92, PX = 26, PY = 30;
  const at = (n: Node) => ({ x: PX + orders.indexOf(n.order) * CW, y: PY + lanes.indexOf(n.lane) * RH });
  const tall = (n: Node) => 30 + 5 * Math.log10(Math.max(1, n.width ?? 1));               // wider steps are taller, on a compressed scale
  const byId = new Map(graph.nodes.map(n => [n.id, n]));
  const W = PX * 2 + orders.length * CW - (CW - BW) + 70, H = PY * 2 + lanes.length * RH - 14;      // room at the right for the last label
  return (
    <div className="scroll drawing"><svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="group" aria-label={graph.title}>
      {(graph.groups ?? []).map(g => {
        const mine = graph.nodes.filter(n => n.group === g.id);
        if (!mine.length) return null;
        const xs = mine.map(n => at(n).x), ys = mine.map(n => at(n).y);
        return <g key={g.id}><rect className="group" x={Math.min(...xs) - 10} y={Math.min(...ys) - 22} width={Math.max(...xs) - Math.min(...xs) + BW + 20} height={Math.max(...ys) - Math.min(...ys) + 72} rx={10} />
          <text className="grouplabel" x={Math.min(...xs) - 2} y={Math.min(...ys) - 8}>{g.label}</text></g>;
      })}
      {graph.edges.map((e, i) => {
        const a = byId.get(e.from), b = byId.get(e.to);
        if (!a || !b) return null;
        const p = at(a), q = at(b), y1 = p.y + tall(a) / 2, y2 = q.y + tall(b) / 2, x1 = p.x + BW, x2 = q.x, mid = (x1 + x2) / 2;
        return <path key={i} className={"edge " + (e.kind ?? "flow")} d={x2 > x1 ? `M${x1} ${y1} C${mid} ${y1} ${mid} ${y2} ${x2} ${y2}` : `M${p.x + BW / 2} ${p.y + tall(a)} L${q.x + BW / 2} ${q.y}`} />;
      })}
      {graph.nodes.map(n => {
        const p = at(n), h = tall(n);
        return <g key={n.id} className={"node" + (n.id === picked ? " picked" : "") + (recorded.has(n.id) ? " recorded" : "")} tabIndex={0} role="button" aria-pressed={n.id === picked}
          aria-label={`${n.label}${n.width ? `, ${fmt(n.width)} ${n.unit ?? "unit"}s` : ""}`} onClick={() => pick(n.id)} onKeyDown={e => (e.key === "Enter" || e.key === " ") && pick(n.id)}>
          <title>{[n.about, n.weights ? `${fmt(n.weights)} weights` : ""].filter(Boolean).join(" ")}</title>
          <rect x={p.x} y={p.y} width={BW} height={h} rx={7} className={n.kind === "collapsed" ? "folded" : ""} />
          {/* a step folded away stands for many: its box says so and its label goes underneath, where there is room */}
          <text className="nodelabel" x={p.x + BW / 2} y={p.y + h / 2 + 4} textAnchor="middle">{n.kind === "collapsed" ? "· · ·" : n.label.length > 14 ? n.label.slice(0, 13) + "…" : n.label}</text>
          <text className="nodekind" x={p.x + BW / 2} y={p.y + h + 14} textAnchor="middle">{n.kind === "collapsed" ? (n.label.length > 22 ? n.label.slice(0, 21) + "…" : n.label)
            : [n.kind === "linear+bend" ? `linear, ${n.bend ?? "bent"}` : n.kind === "other" ? "" : n.kind.replace(/-/g, " "), n.width ? fmt(n.width) : ""].filter(Boolean).join(" · ")}</text>
        </g>;
      })}
    </svg></div>
  );
}

/* One token's whole row at a step, every unit as a thin band: where its strong units are, at a glance. */
function Strip({ project, run, node, token, theme, width }: { project: string; run: string; node: string; token: number; theme: string; width: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [n, setN] = useState(0);
  useEffect(() => {
    let alive = true;
    // the scanner hands over at most 4,096 units at a time; a wide step is asked for in pieces
    const pieces = Array.from({ length: Math.min(16, Math.max(1, Math.ceil(width / 4096))) }, (_, i) =>
      fetch(`/api/v2/scan/${enc(project)}/values?run=${enc(run)}&node=${enc(node)}&token=${token}&from=${i * 4096}&count=4096`).then(r => r.json()));
    Promise.all(pieces).then(parts => {
      const c = ref.current;
      if (!alive || !c || !parts[0].values) return;
      const d = { values: parts.flatMap(p => p.values ?? []), usual: parts.every(p => p.usual) ? parts.flatMap(p => p.usual) : null, count: 0 };
      d.count = d.values.length;
      const v: number[] = d.values.map((x: number, i: number) => x - (d.usual?.[i] ?? 0));
      const W = c.clientWidth, dpr = devicePixelRatio || 1, top = Math.max(1e-9, ...v.map(Math.abs));
      c.width = W * dpr; c.height = 30 * dpr;
      const g = c.getContext("2d")!; g.scale(dpr, dpr);
      const up = cssColour("--s1"), down = cssColour("--s8"), w = W / v.length;
      v.forEach((x, i) => { if (!x) return; g.globalAlpha = Math.min(1, 0.1 + Math.abs(x) / top); g.fillStyle = x > 0 ? up : down; g.fillRect(i * w, 0, Math.max(1, w), 30); });
      setN(d.count ?? v.length);
    }).catch(() => {});
    return () => { alive = false; };
  }, [project, run, node, token, theme, width]);
  return <div className="scanstrip"><canvas ref={ref} role="img" aria-label="this token's whole row at this step" /><span className="muted small">{n ? `${n < width ? "Its first" : "All"} ${fmt(n)} units in order, one band each: blue above the usual level, red below.` : ""}</span></div>;
}

type Away = { run: string; name: string; path: string; size: number };

export function Scan({ project, theme, runs }: { project: string; theme: string; runs: Run[] }) {
  const [glob, setGlob] = useState("");
  const [away, setAway] = useState<Away[]>([]);
  const [fetching, setFetching] = useState("");
  const [health, setHealth] = useState<Health | null>(null);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
  const [chosen, setChosen] = useStored<string[]>("scan.snapshots", []);
  const [graph, setGraph] = useState<Graph | null>(null);
  const [text, setText] = useStored("scan.text", "the sky is blue");
  const [other, setOther] = useStored("scan.other", "the sea is blue");
  const [contrasting, setContrasting] = useStored("scan.contrast", false);
  const [results, setResults] = useState<Record<string, Result>>({});
  const [differ, setDiffer] = useState<Contrast | null>(null);
  const [node, setNode] = useState("");
  const [token, setToken] = useState(0);
  const [unit, setUnit] = useState<{ node: string; unit: number } | null>(null);
  const [page, setPage] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState("");

  const ask = useCallback(async (route: string, query = "", body?: unknown) => {
    const r = await fetch(`/api/v2/scan/${enc(project)}/${route}${query ? "?" + query : ""}`, body === undefined ? undefined
      : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const j = await r.json();
    if (j.error) throw Object.assign(new Error(j.error.message ?? String(j.error)), { code: j.error.code ?? "internal" });
    return j;
  }, [project]);

  const usable = (s: Snapshot) => s.available !== false && (s.state ?? "ready") !== "missing";
  const listSnapshots = useCallback(async () => { const s = await ask("snapshots"); setSnapshots(s.snapshots); setGlob(s.files ?? ""); return s; }, [ask]);
  // Saved weights that are still where the run wrote them: the scanner cannot see those, but the tracker knows each
  // run's files, and which match the scanner's pattern. They are offered for fetching.
  const runIds = runs.map(r => r.id).join(",");
  useEffect(() => {
    if (!glob || !runIds) { setAway([]); return; }
    let alive = true;
    const match = new RegExp("^" + glob.split("*").map(p => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$");
    Promise.all(runs.slice(0, 40).map(r => api(`/api/run?id=${enc(r.id)}`).then(d => (d.files as any[]).filter(f => !f.here && match.test(f.path.split("/").pop())).map(f => ({ run: r.id, name: r.name, path: f.path, size: f.size })), () => [])))
      .then(lists => alive && setAway(lists.flat()));
    return () => { alive = false; };
  }, [glob, runIds, fetching]);
  const bring = async (a: Away) => {
    setFetching(a.run + "/" + a.path); setSaid("");
    try { await api("/api/fetch", { id: a.run, path: a.path }); await listSnapshots(); } catch (e: any) { setSaid(e.message); }
    setFetching("");
  };
  /* Weights are loaded by the scanner the first time they are asked for, which can take a while. Ask, then wait. */
  const makeReady = async (ids: string[]) => {
    let list = snapshots;
    const cold = () => ids.filter(id => (list.find(s => s.id === id)?.state ?? "ready") !== "ready");
    if (!cold().length) return;
    setSaid("Loading the weights. The first time takes a little while.");
    await Promise.all(cold().map(id => ask("load", "", { snapshot: id }).catch(() => {})));
    for (let i = 0; i < 120 && cold().length; i++) { await new Promise(r => setTimeout(r, 1000)); list = (await listSnapshots()).snapshots; }
    setSaid(cold().length ? "The weights are still loading; try again in a moment." : "");
    if (cold().length) throw Object.assign(new Error("The weights are still loading; try again in a moment."), { code: "not_loaded" });
  };
  const primary = chosen.find(id => snapshots.some(s => s.id === id && usable(s))) ?? "";
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const h = await ask("health"); if (!alive) return;
        setHealth(h); setProblem(null);
        const s = await listSnapshots(); if (!alive) return;
        setChosen(old => (old.some(id => s.snapshots.some((x: Snapshot) => x.id === id && usable(x))) ? old : [s.default ?? s.snapshots.find(usable)?.id].filter(Boolean)));
      } catch (e: any) { if (alive) setProblem({ code: e.code ?? "unreachable", message: e.message }); }
    })();
    return () => { alive = false; };
  }, [ask]);
  // The drawing is of the chosen weights' network, so they have to be loaded first. Opening Scan loads them.
  const primaryState = snapshots.find(x => x.id === primary)?.state ?? "ready";
  useEffect(() => {
    if (!primary) return;
    if (primaryState !== "ready") { if (primaryState === "cold") makeReady([primary]).catch(() => {}); return; }
    let alive = true;
    ask("graph", "snapshot=" + enc(primary)).then(g => { if (alive) { setGraph(g); setNode(old => (g.nodes.some((n: Node) => n.id === old) ? old : (g.nodes.find((n: Node) => n.sparse) ?? g.nodes[g.nodes.length - 1])?.id ?? "")); } },
      e => alive && setSaid(e.message));
    return () => { alive = false; };
  }, [primary, primaryState, ask]);
  useEffect(() => {
    if (!unit || !primary) { setPage(null); return; }
    let alive = true;
    setPage(null);
    ask("unit", `snapshot=${enc(primary)}&node=${enc(unit.node)}&unit=${unit.unit}`).then(p => alive && setPage(p), e => alive && setPage({ error: e.message }));
    return () => { alive = false; };
  }, [unit, primary, ask]);

  const can = (what: string) => !health?.supports || health.supports.includes(what);
  const run = async () => {
    setBusy(true); setSaid("");
    try {
      if (contrasting) {
        await makeReady([primary]);
        setDiffer(await ask("contrast", "", { a: text, b: other, snapshot: primary, node, top: 12 }));
        setResults({});
      } else {
        const ids = chosen.filter(id => snapshots.some(s => s.id === id && usable(s)));
        await makeReady(ids);
        const got = await Promise.all(ids.map(id => ask("run", "", { text, snapshot: id, top: 12 })));
        setResults(Object.fromEntries(ids.map((id, i) => [id, got[i]])));
        setDiffer(null); setToken(0);
      }
    } catch (e: any) { setSaid(e.message); }
    setBusy(false);
  };

  const result = results[primary];
  const picked = graph?.nodes.find(n => n.id === node);
  const recorded = useMemo(() => new Set(Object.keys(result?.nodes ?? {})), [result]);
  const label = (id: string) => snapshots.find(s => s.id === id)?.label ?? id;

  /* What to put in the grid for a result at the chosen step: the scanner's own grid, or one pieced together from each
     token's strongest units where it sent none (cells outside a token's own strongest are then left empty). */
  const gridOf = (r: Result) => {
    const n = r.nodes[node];
    const tokens = r.tokens.map(t => t.text);
    if (!n) return null;
    if (Array.isArray(n.grid)) return { tokens, columns: tokens as (number | string)[], values: n.grid as (number | null)[][], heads: undefined as (string[] | null)[] | undefined, units: false };
    if (n.grid) return { tokens, columns: n.grid.units as (number | string)[], values: n.grid.values as (number | null)[][], heads: n.grid.words, units: true };
    const cols: number[] = [], heads: (string[] | null)[] = [];
    (n.top ?? []).forEach(list => list.forEach(([u, , w]) => { if (!cols.includes(u) && cols.length < 48) { cols.push(u); heads.push(w ?? null); } }));
    return { tokens, columns: cols as (number | string)[], values: (n.top ?? []).map(list => cols.map(u => list.find(x => x[0] === u)?.[1] ?? null)), heads, units: true };
  };

  if (problem) return (
    <div className="panel scanoff">
      <h2>{problem.code === "no_scanner" ? "No scanner is set for this project" : problem.code === "unreachable" ? "The scanner is not answering" : "The scanner cannot be used"}</h2>
      <p className="muted">Scan runs text through a trained network and shows what lit up. The running is done by a scanner: a small program that belongs to the experiment and has the model. The tracker only shows what it answers.</p>
      <p>{problem.message}</p>
      <p className="muted small">Start the experiment's scanner, then tell the tracker where it is:</p>
      <pre>{`python scan_server.py --runs ~/run-tracker-data/runs --port 8790\nrt scan add ${project} --url http://127.0.0.1:8790`}</pre>
    </div>
  );
  if (!health) return <p className="muted">Asking the scanner…</p>;
  const firstDiff = differ ? (differ as any).first_difference ?? differ.per_pair.findIndex(p => !p.same_text) : -1;
  const sideList = (list: Side) => list.length ? list.map(([u, v, w]) => <button key={u} className="unitchip" onClick={() => setUnit({ node, unit: u })}>{w?.length ? <b>{w.slice(0, 2).map(showToken).join(" ")}</b> : null}<span>{u}</span><i>{fmt(+v.toPrecision(3))}</i></button>) : <span className="muted small">none</span>;

  return (
    <div className="scan">
      <p className="muted small">{health.name}{health.device ? `, on ${health.device}` : ""}. A unit lighting up shows it is related to the text, not that it causes anything.</p>
      {graph && <><h2>{graph.title}</h2><Drawing graph={graph} picked={node} pick={setNode} recorded={recorded} />
        {picked && <p className="small"><b>{picked.label}.</b> <span className="muted">{picked.about ?? ""} {picked.width ? `${fmt(picked.width)} ${picked.unit ?? "unit"}s${picked.per === "token-pair" ? ", one for each pair of tokens" : " for each token"}.` : ""}</span></p>}</>}

      <div className="scanrun">
        <label>{contrasting ? "First text" : "Text"}<textarea value={text} onChange={e => setText(e.target.value)} rows={2} /></label>
        {contrasting && <label>Second text, to set against it<textarea value={other} onChange={e => setOther(e.target.value)} rows={2} /></label>}
        <div className="row">
          <button aria-pressed="true" disabled={busy || !primary} onClick={run}>{busy ? "Running…" : contrasting ? "Run both and compare" : chosen.length > 1 ? `Run through ${chosen.length} snapshots` : "Run"}</button>
          {can("contrast") && <button className="small" aria-pressed={contrasting} data-tip="Run two texts and see only what differs between them" onClick={() => setContrasting(!contrasting)}>Two texts</button>}
          {health.max_tokens ? <span className="muted small">up to {health.max_tokens} tokens</span> : null}
          {said && <span className="note-warn small">{said}</span>}
        </div>
        <div className="row snaps" role="group" aria-label="Which saved weights to run it through">
          <span className="muted small">Weights</span>
          {snapshots.map(s => <label key={s.id} className={"inline snap" + (usable(s) ? "" : " off")} data-tip={usable(s) ? (s.run ? `From the run ${s.run}` : undefined) : `Not on this machine. Fetch ${s.file ?? "it"} from the run's Files tab first.`}>
            <input type="checkbox" disabled={!usable(s) || (contrasting && !chosen.includes(s.id) && chosen.length >= 1)} checked={chosen.includes(s.id)}
              onChange={e => setChosen(e.target.checked ? (contrasting ? [s.id] : [...chosen, s.id]) : chosen.filter(id => id !== s.id))} />{s.label}{s.state && s.state !== "ready" ? <span className="muted"> ({s.state === "loading" ? "loading" : "not loaded yet"})</span> : null}</label>)}
        </div>
        {away.length > 0 && <details className="away"><summary className="muted small">{away.length} more saved weights are still where their runs wrote them</summary>
          <p className="muted small">The scanner can only load weights that are on this machine. Fetching copies one here; they are large.</p>
          <div className="chiprow">{away.map(a => <button key={a.run + a.path} className="small" disabled={!!fetching} onClick={() => bring(a)}>
            {fetching === a.run + "/" + a.path ? "Fetching…" : <>{a.name} <span className="mono">{a.path}</span> <span className="muted">{sizeText(a.size)}</span></>}</button>)}</div>
        </details>}
      </div>

      {!contrasting && result && <>
        <div className="row tokens" role="group" aria-label="The text as the model split it">
          {result.tokens.map(t => <button key={t.i} className="tok mono" aria-pressed={t.i === token} onClick={() => setToken(t.i)}>{showToken(t.text)}</button>)}
          {result.next?.length ? <span className="muted small">would write next: {result.next.slice(0, 3).map(n => `“${showToken(n.text)}” ${Math.round(n.chance * 100)}%`).join(", ")}</span> : null}
        </div>
        {Object.entries(results).map(([id, r]) => {
          const g = gridOf(r);
          return <section key={id} className="panel">
            <div className="row"><h2>{picked?.label ?? node}</h2>{Object.keys(results).length > 1 && <span className="muted small">{label(id)}</span>}</div>
            {!g ? <p className="muted small">The scanner recorded nothing at this step. Choose another in the drawing.</p>
              : <Grid tokens={g.tokens} columns={g.columns} values={g.values} heads={g.heads} label={`${picked?.label ?? node}: tokens against its strongest units`} onUnit={g.units ? u => setUnit({ node, unit: u }) : undefined} />}
            {g?.units && can("values") && id === primary && picked?.per !== "token-pair" && <>
              <p className="small"><span className="muted">The whole row for</span> <span className="mono">{showToken(r.tokens[token]?.text ?? "")}</span></p>
              <Strip project={project} run={r.run} node={node} token={token} theme={theme} width={picked?.width ?? 4096} /></>}
          </section>;
        })}
      </>}

      {contrasting && differ && <section className="panel">
        <h2>What differs at {picked?.label ?? node}</h2>
        <p className="muted small">The two texts are lined up token by token. A later token's row depends on the earlier ones, so everything after the first difference can differ because of it.</p>
        <div className="scroll"><table className="pairs">
          <thead><tr><th>first text</th><th>second text</th><th className="num">how far apart</th><th>only in the first</th><th>only in the second</th></tr></thead>
          <tbody>{differ.pairs.map(([a, b], i) => { const p = differ.per_pair[i]; return (
            <tr key={i} className={p.same_text ? "" : "sel"}>
              <td className="mono">{showToken(differ.tokens_a[a].text)}</td><td className="mono">{showToken(differ.tokens_b[b].text)}{i === firstDiff && <span className="tag">first difference</span>}</td>
              <td className="num">{fmt(+p.distance.toPrecision(3))}</td><td className="wrapc">{sideList(p.only_a)}</td><td className="wrapc">{sideList(p.only_b)}</td></tr>); })}</tbody>
        </table></div>
        <div className="two"><div><h3>Only in the first, over the whole text</h3><div className="chiprow">{sideList(differ.whole.only_a)}</div></div>
          <div><h3>Only in the second, over the whole text</h3><div className="chiprow">{sideList(differ.whole.only_b)}</div></div></div>
      </section>}

      {unit && <aside className="panel unitpage" aria-label="One unit">
        <div className="row"><h2>{graph?.nodes.find(n => n.id === unit.node)?.unit ?? "unit"} {fmt(unit.unit)}</h2><span className="muted small">of {graph?.nodes.find(n => n.id === unit.node)?.label ?? unit.node}</span><span className="grow" />
          <button className="small" onClick={() => setUnit(null)}>Close</button></div>
        {!page ? <p className="muted small">Asking…</p> : page.error ? <p className="note-warn small">{page.error}</p> : <>
          {page.words && <div><h3>What it responds to</h3><div className="chiprow">{page.words.map(([w, v]: [string, number]) => <span key={w} className="w">{showToken(w)} <i>{fmt(+v.toPrecision(3))}</i></span>)}</div>
            <p className="muted small">Found by one test: {page.words_test ?? "not stated"}. This is evidence about the unit, not a name for it.</p></div>}
          {page.fires_on != null && <p className="small">On for {fmt(+(page.fires_on * 100).toPrecision(2))}% of tokens.</p>}
          {page.agreement != null && <p className="small">What it listens to and what it is made of agree by {fmt(+page.agreement.toPrecision(2))} <span className="muted">(1 would be the same pattern, 0 unrelated).</span></p>}
          {(["made_of", "listens_to", "used_by"] as const).filter(k => page[k]).map(k => <div key={k}>
            <h3>{{ made_of: "What it is made of", listens_to: "What it listens to", used_by: "What leans on it" }[k]} <span className="muted small">({graph?.nodes.find(n => n.id === page[k].node)?.label ?? page[k].node})</span></h3>
            <div className="chiprow">{page[k].top.map(([u, v, w]: Top) => <button key={u} className="unitchip" onClick={() => setUnit({ node: page[k].node, unit: u })}>{w?.length ? <b>{w.slice(0, 2).map(showToken).join(" ")}</b> : null}<span>{u}</span><i>{fmt(+v.toPrecision(3))}</i></button>)}</div>
            {page[k].half != null && <p className="muted small">{fmt(page[k].half)} of them carry half of it, {fmt(page[k].ninety)} carry ninety percent.</p>}
            {page[k].count != null && <p className="muted small">{fmt(page[k].count)} in all{page[k].threshold != null ? `, counting those that give it at least ${fmt(page[k].threshold)} of their pattern` : ""}.</p>}
          </div>)}
        </>}
      </aside>}
    </div>
  );
}
