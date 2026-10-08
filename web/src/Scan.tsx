/* Scan: type text, run it through a trained network, and see what lit up.

   The work is done by a scanner, a separate program the experiment owns. This view knows the scan contract
   (docs/scan.md) and nothing else: it draws whatever network the scanner describes and never assumes what kind it is.
   Requests go to the tracker's own server, which passes them on.

   What it shows: the network as a drawing; the text as the model split it; for the chosen step, a grid of tokens
   against that step's strongest units; one token's whole row as a strip; a unit's page; two texts set against each
   other; and the same text through several snapshots. */
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { BarData } from "./Bars3D";
import { api, cssColour, enc, fmt, Run, sizeText, useStored } from "./lib";
import { ContrastSheets, sheetParts, SheetView, StepSheet } from "./Sheet";

/* three.js comes with the 3D drawing, and only when it is shown. If that piece cannot be fetched (the app was updated
   while this page stayed open, and the piece it knew about is gone), the drawing reports failure and the flat one is
   used; the page must not go down with it. */
function Gone(p: { onFail: () => void }) { useEffect(() => p.onFail(), []); return null; }
const Bars3D = lazy<typeof import("./Bars3D").default>(() => import("./Bars3D").catch(() => ({ default: Gone as any })));

type Node = { id: string; label: string; about?: string; group?: string | null; kind: string; width?: number; each?: number; per?: string; lane: number; order: number;
  weights?: number; unit?: string; bend?: string; sparse?: boolean; described?: boolean };
type Graph = { title: string; groups?: { id: string; label: string }[]; nodes: Node[]; edges: { from: string; to: string; kind?: string }[] };
type Snapshot = { id: string; label: string; run?: string | null; step?: number; of?: number; available?: boolean; state?: string; file?: string };
type Top = [number, number, (string[] | null)?];
type NodeResult = { size?: number[]; on?: number[]; top?: Top[][]; head?: number[][]; grid?: { units: number[]; values: number[][]; words?: (string[] | null)[] } | number[][] };
type Result = { run: string; snapshot: string; tokens: { i: number; text: string }[]; nodes: Record<string, NodeResult>; next?: { text: string; chance: number }[] };
type Side = [number, number, (string[] | null)?][];
type Contrast = { run_a: string; run_b: string; tokens_a: { i: number; text: string }[]; tokens_b: { i: number; text: string }[]; pairs: [number, number][];
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

/* The network, drawn from what the scanner says: columns by order, rows by lane, a box round each group.
   Once text has been run, every step lights up: a strip of cells in its box, one per token, brighter where that
   token's row at that step is larger. The token being looked at is outlined in every step at once. */
function Drawing({ graph, picked, pick, heat, token }: { graph: Graph; picked: string; pick: (id: string) => void; heat: Record<string, number[]>; token: number }) {
  const orders = [...new Set(graph.nodes.map(n => n.order))].sort((a, b) => a - b);
  const lanes = [...new Set(graph.nodes.map(n => n.lane))].sort((a, b) => b - a);          // higher lanes are drawn above
  const CW = 112, RH = 90, BW = 100, BH = 64, PX = 22, PY = 26;
  const at = (n: Node) => ({ x: PX + orders.indexOf(n.order) * CW, y: PY + lanes.indexOf(n.lane) * RH });
  const byId = new Map(graph.nodes.map(n => [n.id, n]));
  const W = PX * 2 + orders.length * CW - (CW - BW), H = PY + lanes.length * RH - (RH - BH) + 12;
  const short = (t: string, n: number) => (t.length > n ? t.slice(0, n - 1) + "…" : t);
  return (
    <div className="scroll drawing"><svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="group" aria-label={graph.title}>
      {(graph.groups ?? []).map(g => {
        const mine = graph.nodes.filter(n => n.group === g.id);
        if (!mine.length) return null;
        const xs = mine.map(n => at(n).x), ys = mine.map(n => at(n).y);
        return <g key={g.id}><rect className="group" x={Math.min(...xs) - 7} y={Math.min(...ys) - 19} width={Math.max(...xs) - Math.min(...xs) + BW + 14} height={Math.max(...ys) - Math.min(...ys) + BH + 26} rx={10} />
          <text className="grouplabel" x={Math.min(...xs)} y={Math.min(...ys) - 6}>{g.label}</text></g>;
      })}
      {graph.edges.map((e, i) => {
        const a = byId.get(e.from), b = byId.get(e.to);
        if (!a || !b) return null;
        const p = at(a), q = at(b), y1 = p.y + BH / 2, y2 = q.y + BH / 2, x1 = p.x + BW, x2 = q.x, mid = (x1 + x2) / 2;
        return <path key={i} className={"edge " + (e.kind ?? "flow")} d={x2 > x1 ? `M${x1} ${y1} C${mid} ${y1} ${mid} ${y2} ${x2} ${y2}` : `M${p.x + BW / 2} ${p.y + BH} L${q.x + BW / 2} ${q.y}`} />;
      })}
      {graph.nodes.map(n => {
        const p = at(n), lit = heat[n.id], folded = n.kind === "collapsed";
        // Two sizes that are easy to mix up, said apart: how many units the step has, and how many numbers each one reads.
        const kind = n.kind === "linear+bend" ? `linear, ${n.bend ?? "bent"}` : n.kind === "other" ? "" : n.kind.replace(/-/g, " ").replace("weights over positions", "shares");
        const many = n.width ? `${fmt(n.width)} ${n.unit ?? "unit"}s` : kind;
        const wide = n.each ? `each ${fmt(n.each)} wide` : n.width ? kind : "";
        const cw = lit ? (BW - 12) / lit.length : 0;
        return <g key={n.id} className={"node" + (n.id === picked ? " picked" : "") + (lit ? " recorded" : "")} tabIndex={0} role="button" aria-pressed={n.id === picked}
          aria-label={`${n.label}${n.width ? `, ${fmt(n.width)} ${n.unit ?? "unit"}s` : ""}`} onClick={() => pick(n.id)} onKeyDown={e => (e.key === "Enter" || e.key === " ") && pick(n.id)}>
          <title>{[n.label + ".", n.about, n.width && n.each ? `${fmt(n.width)} ${n.unit ?? "unit"}s, each reading ${fmt(n.each)} numbers.` : "", n.weights ? `${fmt(n.weights)} weights.` : ""].filter(Boolean).join(" ")}</title>
          <rect x={p.x} y={p.y} width={BW} height={BH} rx={8} className={folded ? "folded" : ""} />
          <text className="nodelabel" x={p.x + BW / 2} y={p.y + (folded ? 24 : 18)} textAnchor="middle">{short(folded ? n.label.split(",")[0] : n.label, 15)}</text>
          <text className="nodekind" x={p.x + BW / 2} y={p.y + (folded ? 38 : 31)} textAnchor="middle">{folded ? short(n.label.split(",").slice(1).join(",").trim(), 20) : many}</text>
          {!folded && <text className="nodekind" x={p.x + BW / 2} y={p.y + 43} textAnchor="middle">{wide}</text>}
          {lit && lit.map((v, i) => <rect key={i} className={"lit" + (i === token ? " now" : "")} x={p.x + 6 + i * cw} y={p.y + 50} width={Math.max(1, cw - 1)} height={8} rx={1.5} style={{ fillOpacity: 0.12 + 0.88 * v }} />)}
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

type Term = { unit: number; weight: number; input: number; product: number };
type Terms = { node: string; sum: number; intercept: number; count: number; top: Term[]; bottom: Term[]; rest: number; weights?: number[]; inputs?: number[] };

/* How one unit's value was made for one token: its weights times what it read, the largest products each way, the rest
   and the intercept, adding up to the sum. The weights say what the unit listens to for any text; the products say what
   happened for this token, and the two are kept apart. */
function Made({ terms, label, unitName, token, bend, open, theme }: { terms: Terms; label: (id: string) => string; unitName: string; token: string; bend?: string; open: (u: number) => void; theme: string }) {
  const most = Math.max(1e-9, ...[...terms.top, ...terms.bottom].map(t => Math.abs(t.product)));
  const line = (t: Term) => <tr key={t.unit}><td><button className="small ghost" onClick={() => open(t.unit)}>{unitName} {fmt(t.unit)}</button></td>
    <td className="num">{fmt(t.weight)}</td><td className="num">{fmt(t.input)}</td>
    <td className="num"><span className="pbar"><b className={t.product < 0 ? "neg" : ""} style={{ width: `${100 * Math.abs(t.product) / most}%` }} /></span>{fmt(t.product)}</td></tr>;
  const strip = (v: number[] | undefined, what: string) => v && <StripRow values={v} what={what} theme={theme} />;
  return (
    <div className="made">
      <h3>How this value was made for <span className="mono">{token}</span></h3>
      <p className="small">{fmt(terms.count)} {unitName}s of {label(terms.node)}, each times its weight, plus an intercept of {fmt(terms.intercept)}, add up to <b>{fmt(terms.sum)}</b>.
        {bend ? ` ${bend} is then applied to that whole sum, so the output is not divided among the inputs.` : ""}</p>
      {strip(terms.weights, "Its weights: what it listens to, whatever the text")}
      {strip(terms.inputs, "What it read for this token")}
      {terms.weights && terms.inputs && strip(terms.weights.map((w, i) => w * terms.inputs![i]), "The products of the two: what happened for this token")}
      <div className="scroll"><table className="terms">
        <thead><tr><th>{unitName}</th><th className="num">weight</th><th className="num">read</th><th className="num">product</th></tr></thead>
        <tbody>
          <tr className="sub"><td colSpan={4}>Pushing it up most</td></tr>{terms.top.map(line)}
          {terms.bottom.length > 0 && <tr className="sub"><td colSpan={4}>Pushing it down most</td></tr>}{terms.bottom.map(line)}
          <tr className="sub"><td colSpan={3}>All {fmt(terms.count - terms.top.length - terms.bottom.length)} others together</td><td className="num">{fmt(terms.rest)}</td></tr>
          <tr className="sub"><td colSpan={3}>The intercept</td><td className="num">{fmt(terms.intercept)}</td></tr>
          <tr className="sub total"><td colSpan={3}>The sum</td><td className="num">{fmt(terms.sum)}</td></tr>
        </tbody></table></div>
    </div>
  );
}
/* A whole row of numbers as one thin band, blue above zero and red below. */
function StripRow({ values, what, theme }: { values: number[]; what: string; theme: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current; if (!c) return;
    const W = c.clientWidth, dpr = devicePixelRatio || 1, sizes = values.map(Math.abs).sort((a, b) => a - b), top = Math.max(1e-9, sizes[Math.floor(sizes.length * 0.99)] ?? 1);
    c.width = W * dpr; c.height = 16 * dpr;
    const g = c.getContext("2d")!; g.scale(dpr, dpr);
    const up = cssColour("--s1"), down = cssColour("--s8"), w = W / values.length;
    values.forEach((v, i) => { if (!v) return; g.globalAlpha = Math.min(1, Math.abs(v) / top) ** 1.5; g.fillStyle = v > 0 ? up : down; g.fillRect(i * w, 0, Math.max(1, w), 16); });
  }, [values, theme]);
  return <div className="striprow"><span className="muted small">{what}</span><canvas ref={ref} role="img" aria-label={what} /></div>;
}

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
  const [pair, setPair] = useState<number | null>(null);
  const [wantSolid, setSolid] = useStored("scan.bars", true);          // the drawing as bars in three dimensions, or flat
  const [flatOnly, setFlatOnly] = useState(false);                      // set when the 3D drawing failed on this page; the choice itself is kept
  const solid = wantSolid && !flatOnly;
  const [opened, setOpened] = useState<{ node: string; token: number } | null>(null);   // the row of a bar that is open as a sheet
  const [heads, setHeads] = useState<Record<string, number[][]>>({});               // which pair of tokens the two sheets show
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
  // A scanner lists the weights of every run it can see. Only those of this project's runs are offered here, with
  // any that belong to no run at all (a published network to compare with).
  const mine = useRef(new Set<string>());
  mine.current = new Set(runs.map(r => r.id));
  const listSnapshots = useCallback(async () => {
    const s = await ask("snapshots");
    s.snapshots = (s.snapshots as Snapshot[]).filter(x => x.run == null || mine.current.has(x.run));
    if (!s.snapshots.some((x: Snapshot) => x.id === s.default)) s.default = [...s.snapshots].filter((x: Snapshot) => x.run != null).sort((x: Snapshot, y: Snapshot) => (y.step ?? 0) - (x.step ?? 0))[0]?.id ?? s.snapshots[0]?.id;   // the furthest-trained
    setSnapshots(s.snapshots); setGlob(s.files ?? "");
    return s;
  }, [ask]);
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
    ask("unit", `snapshot=${enc(primary)}&node=${enc(unit.node)}&unit=${unit.unit}` + (results[primary] && !contrasting ? `&run=${enc(results[primary].run)}&token=${token}&all=1` : "")).then(p => alive && setPage(p), e => alive && setPage({ error: e.message }));
    return () => { alive = false; };
  }, [unit, primary, ask, results, token, contrasting]);

  const can = (what: string) => !health?.supports || health.supports.includes(what);
  const run = async () => {
    setBusy(true); setSaid("");
    try {
      if (contrasting) {
        await makeReady([primary]);
        setDiffer(await ask("contrast", "", { a: text, b: other, snapshot: primary, node, top: 12 }));
        setPair(null);
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
  /* What each bar of the 3D drawing is made of. A step's first units in order come with the run ("head"); a sparse step
     draws its strongest instead; a grid of tokens draws itself. A scanner that sends no head is asked for the first 32
     of each row, a token at a time. */
  const HEAD = 32;
  useEffect(() => {
    setHeads({}); setOpened(null);
    if (!result || !graph) return;
    let alive = true;
    for (const n of graph.nodes) {
      const r = result.nodes[n.id];
      if (!r || r.head || n.sparse || Array.isArray(r.grid) || n.per === "token-pair") continue;
      Promise.all(result.tokens.map(t => fetch(`/api/v2/scan/${enc(project)}/values?run=${enc(result.run)}&node=${enc(n.id)}&token=${t.i}&from=0&count=${HEAD}`).then(x => x.json()).then(x => x.values ?? [])))
        .then(rows => alive && setHeads(old => ({ ...old, [n.id]: rows })), () => {});
    }
    return () => { alive = false; };
  }, [result, graph, project]);
  const bars = useMemo(() => {
    const out: Record<string, BarData> = {};
    for (const n of graph?.nodes ?? []) {
      const r = result?.nodes[n.id]; if (!r) continue;
      if (Array.isArray(r.grid)) out[n.id] = { rows: r.grid as (number | null)[][], units: null, how: "tokens" };
      else if (n.sparse && r.grid) out[n.id] = { rows: r.grid.values.map(row => row.slice(0, HEAD)), units: r.grid.units.slice(0, HEAD), how: "strongest" };
      else if (r.head ?? heads[n.id]) out[n.id] = { rows: (r.head ?? heads[n.id]) as number[][], units: null, how: "first" };
    }
    return out;
  }, [graph, result, heads]);
  const tokenTexts = useMemo(() => (result?.tokens ?? []).map(t => t.text), [result]);
  // how brightly each step lights for each token: the size of the token's row there, against the largest at that step
  const heat = useMemo(() => {
    const out: Record<string, number[]> = {};
    for (const [id, n] of Object.entries(result?.nodes ?? {})) {
      const sizes = n.size ?? (Array.isArray(n.grid) ? (n.grid as (number | null)[][]).map(row => Math.max(0, ...row.map(v => Math.abs(v ?? 0)))) : null);
      if (sizes?.length) { const top = Math.max(1e-9, ...sizes); out[id] = sizes.map(v => v / top); }
    }
    return out;
  }, [result]);
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
        <div className="row tokens" role="group" aria-label="The text as the model split it. The arrow keys step through it."
          onKeyDown={e => { const d = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0; if (!d) return; e.preventDefault();
            const next = Math.max(0, Math.min(result.tokens.length - 1, token + d)); setToken(next); (e.currentTarget.querySelectorAll("button.tok")[next] as HTMLElement | undefined)?.focus(); }}>
          {result.tokens.map(t => <button key={t.i} className="tok mono" aria-pressed={t.i === token} onClick={() => setToken(t.i)}>{showToken(t.text)}</button>)}
          {result.next?.length ? <span className="muted small">would write next: {result.next.slice(0, 3).map(n => `“${showToken(n.text)}” ${Math.round(n.chance * 100)}%`).join(", ")}</span> : null}
        </div>
        {graph && sheetParts(graph) && <SheetView project={project} graph={graph} run={result.run} tokens={result.tokens} top={result.nodes[sheetParts(graph)!.features.id]?.top as any}
          token={token} snapshot={primary} openUnit={(n, u) => setUnit({ node: n, unit: u })} theme={theme} />}
      </>}
      {graph && <><div className="row"><h2>{graph.title}</h2><span className="muted small">{result && !contrasting ? (solid ? "Each bar is a step: tokens down, the step's units across, a tile taller and brighter the further from zero. Drag to turn it. Click a tile to open its row as a sheet and its unit beside it."
          : "Each step's strip has one cell per token, brighter where that token's row is larger. Click a step to look inside it.") : "Click a step to look inside it. Run some text and every step lights up."}</span>
        <span className="grow" />{result && !contrasting && <div className="seg" role="group" aria-label="How the network is drawn">
          <button className="small" aria-pressed={solid} onClick={() => setSolid(true)}>Bars</button><button className="small" aria-pressed={!solid} onClick={() => setSolid(false)}>Flat</button></div>}</div>{solid && result && !contrasting
        ? <Suspense fallback={<div className="bars3d"><div className="stage" /></div>}><Bars3D graph={graph} bars={bars} tokens={tokenTexts} token={token} picked={node} theme={theme}
            onFail={() => { setFlatOnly(true); setSaid("The three-dimensional drawing could not be shown here, so the network is drawn flat. If the app has been updated, reloading the page brings it back."); }}
            onTile={(id, t, u) => { setNode(id); setToken(t); setOpened(graph.nodes.find(n => n.id === id)?.per === "token-pair" ? null : { node: id, token: t }); if (u != null) setUnit({ node: id, unit: u }); }} /></Suspense>
        : <Drawing graph={graph} picked={node} pick={setNode} heat={contrasting ? {} : heat} token={token} />}
        {solid && result && !contrasting && opened && graph.nodes.find(n => n.id === opened.node)?.width
          ? <StepSheet project={project} run={result.run} node={graph.nodes.find(n => n.id === opened.node)!} token={opened.token} tokenText={result.tokens[opened.token]?.text ?? ""}
              drawn={bars[opened.node]?.rows[0]?.length ?? 0} how={bars[opened.node]?.how ?? "first"} theme={theme} onCell={u => setUnit({ node: opened.node, unit: u })} /> : null}
        {picked && <p className="small"><b>{picked.label}.</b> <span className="muted">{picked.about ?? ""} {picked.width
          ? `${fmt(picked.width)} ${picked.unit ?? "unit"}s${picked.each ? `, each ${fmt(picked.each)} wide (that many numbers go into one ${picked.unit ?? "unit"})` : ""}${picked.per === "token-pair" ? ", one for each pair of tokens" : ", worked out for each token"}.` : ""}</span></p>}</>}

      {!contrasting && result && <>
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
        {graph && sheetParts(graph) && differ.run_a && (() => { const i = pair ?? (firstDiff >= 0 ? firstDiff : 0), [a, b] = differ.pairs[i] ?? [0, 0];
          return <ContrastSheets project={project} graph={graph} runA={differ.run_a} runB={differ.run_b} a={a} b={b} texts={[differ.tokens_a[a]?.text ?? "", differ.tokens_b[b]?.text ?? ""]} theme={theme}
            openUnit={(n, u) => setUnit({ node: n, unit: u })} />; })()}
        <p className="muted small">The sheets show one pair of tokens. Click a row below to show another.</p>
        <div className="scroll"><table className="pairs">
          <thead><tr><th>first text</th><th>second text</th><th className="num">how far apart</th><th>only in the first</th><th>only in the second</th></tr></thead>
          <tbody>{differ.pairs.map(([a, b], i) => { const p = differ.per_pair[i]; return (
            <tr key={i} className={(p.same_text ? "" : "sel") + (i === (pair ?? (firstDiff >= 0 ? firstDiff : 0)) ? " shown" : "")} onClick={() => setPair(i)} style={{ cursor: "pointer" }}>
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
          {page.terms && <Made terms={page.terms} label={l => graph?.nodes.find(n => n.id === l)?.label ?? l} unitName={graph?.nodes.find(n => n.id === page.terms.node)?.unit ?? "unit"}
            token={showToken(result?.tokens[token]?.text ?? "")} bend={graph?.nodes.find(n => n.id === unit.node)?.bend} theme={theme} open={u => setUnit({ node: page.terms.node, unit: u })} />}
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
