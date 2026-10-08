/* The sheet: the units a sparse autoencoder reads, drawn as the thing being scanned.

   Every unit has one fixed cell, in the order of its number, on a sheet as near square as the count allows. Where a
   cell sits means nothing; what matters is that it never moves, so the pattern for one token can be seen against the
   pattern for another without reading a number. A cell glows by how far its unit is from its usual level: one colour
   above, another below.

   Beside the sheet is the reading: the features that pattern decodes to, strongest first, with their words. Choosing a
   feature draws its own pattern on the sheet as an outline round the cells it uses most, over the glow. Choosing two
   draws both, and marks the cells they share.

   Nothing here knows what kind of network it is. Which step is the sheet comes from the drawing: the step a "reads"
   edge leaves. The features are the step marked sparse, and the rebuild is the step that follows it at the sheet's
   width. A scanner that does not send whole patterns still gets the sheet and the reading. */
import { useEffect, useMemo, useRef, useState } from "react";
import { cssColour, enc, fmt } from "./lib";

export type SheetGraph = { nodes: { id: string; label: string; width?: number | null; unit?: string; sparse?: boolean }[]; edges: { from: string; to: string; kind?: string }[] };
type Row = { values: number[]; usual: number[] | null };
type Mark = { cells: Set<number>; colour: string; label: string };

/* Which steps play which part, read off the drawing. Null if no step is read by another: then there is no sheet. */
export function sheetParts(graph: SheetGraph | null) {
  const reads = graph?.edges.find(e => e.kind === "reads");
  const sheet = graph?.nodes.find(n => n.id === reads?.from);
  const features = graph?.nodes.find(n => n.sparse);
  if (!graph || !sheet || !features || !sheet.width) return null;
  const after = graph.edges.filter(e => e.from === features.id).map(e => graph.nodes.find(n => n.id === e.to));
  return { sheet, features, rebuild: after.find(n => n && n.width === sheet.width) ?? null };
}

/* One token's whole row at a step, asked for in pieces of 4,096, which is the most a scanner hands over at once. */
export async function rowOf(project: string, run: string, node: string, token: number, width: number): Promise<Row> {
  // one piece after another, not all at once: a scanner is a small server and should not be sent a burst
  const parts: any[] = [];
  for (let i = 0; i < Math.max(1, Math.ceil(width / 4096)); i++)
    parts.push(await fetch(`/api/v2/scan/${enc(project)}/values?run=${enc(run)}&node=${enc(node)}&token=${token}&from=${i * 4096}&count=4096`).then(r => r.json()));
  if (parts.some(p => p.error)) throw new Error(parts.find(p => p.error).error.message);
  return { values: parts.flatMap(p => p.values ?? []), usual: parts.every(p => p.usual) ? parts.flatMap(p => p.usual) : null };
}

const shape = (n: number) => { const cols = Math.ceil(Math.sqrt(n * 4 / 3)); return { cols, rows: Math.ceil(n / cols) }; };

/* The sheet itself. `glow` is each unit's value with its usual level already taken off. */
export function SheetCanvas({ glow, marks = [], cell, theme, unit, onCell, label, raw, fold }:
  { glow: number[]; marks?: Mark[]; cell: number; theme: string; unit: string; onCell?: (i: number) => void; label: string; raw?: (i: number) => string; fold?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [tip, setTip] = useState<{ i: number; x: number; y: number } | null>(null);
  const { cols, rows } = shape(glow.length);
  const folded = useRef("");
  useEffect(() => {
    const c = ref.current; if (!c) return;
    const dpr = devicePixelRatio || 1;
    c.width = cols * cell * dpr; c.height = rows * cell * dpr;
    const g = c.getContext("2d")!; g.scale(dpr, dpr);
    // The glow is scaled to the 99th largest in a hundred, not the very largest, or a few strong units wash the rest out.
    const sizes = glow.map(Math.abs).filter(v => v > 0).sort((a, b) => a - b);
    const top = sizes.length ? sizes[Math.min(sizes.length - 1, Math.floor(sizes.length * 0.99))] : 1;
    const up = cssColour("--s1"), down = cssColour("--s8"), ground = cssColour("--wash"), ink = cssColour("--fg");
    /* The sheet with `across` cells to a line. At rest that is `cols`. While a row is folding it starts four times as
       long and wraps down to `cols`, so the same numbers are seen going from a long row to a square. */
    const paint = (across: number, final: boolean) => {
      const size = cols * cell / across, gap = size > 5 ? 1 : 0;
      g.clearRect(0, 0, cols * cell, rows * cell);
      g.globalAlpha = 1; g.fillStyle = ground; g.fillRect(0, 0, cols * cell, Math.ceil(glow.length / across) * size);
      glow.forEach((v, i) => {
        if (!v) return;
        // squared, so that the many units a little off their usual level stay dark and the few far from it stand out
        g.globalAlpha = Math.min(1, Math.abs(v) / top) ** 2;
        g.fillStyle = v > 0 ? up : down;
        g.fillRect((i % across) * size, Math.floor(i / across) * size, Math.max(0.6, size - gap), Math.max(0.6, size - gap));
      });
      g.globalAlpha = 1;
      if (!final) return;
      const shared = marks.length > 1 ? new Set([...marks[0].cells].filter(i => marks[1].cells.has(i))) : new Set<number>();
      marks.forEach(m => { g.strokeStyle = m.colour; g.lineWidth = Math.max(1.25, cell / 5);
        m.cells.forEach(i => { if (!shared.has(i)) g.strokeRect((i % cols) * cell + 0.5, Math.floor(i / cols) * cell + 0.5, cell - gap - 1, cell - gap - 1); }); });
      g.strokeStyle = ink; g.lineWidth = Math.max(1.75, cell / 4);                                      // cells both patterns use
      shared.forEach(i => g.strokeRect((i % cols) * cell - 0.5, Math.floor(i / cols) * cell - 0.5, cell - gap + 1, cell - gap + 1));
    };
    if (!fold || fold === folded.current || matchMedia("(prefers-reduced-motion: reduce)").matches) { folded.current = fold ?? ""; paint(cols, true); return; }
    folded.current = fold;
    let frame = 0; const began = performance.now();
    const step = (now: number) => {
      const t = Math.min(1, (now - began) / 650), ease = 1 - (1 - t) ** 3;
      paint(Math.max(cols, Math.round(cols * (4 - 3 * ease))), t === 1);
      if (t < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [glow, marks, cell, theme, cols, rows, fold]);
  const at = (e: React.MouseEvent) => {
    const b = ref.current!.getBoundingClientRect();
    const i = Math.floor((e.clientY - b.top) / b.height * rows) * cols + Math.floor((e.clientX - b.left) / b.width * cols);
    return i >= 0 && i < glow.length ? { i, x: e.clientX - b.left, y: e.clientY - b.top } : null;
  };
  return (
    <div className="sheet" style={{ width: cols * cell }}>
      <canvas ref={ref} style={{ width: cols * cell, height: rows * cell, cursor: onCell ? "pointer" : "default" }} role="img" aria-label={label}
        onMouseMove={e => setTip(at(e))} onMouseLeave={() => setTip(null)} onClick={e => { const p = at(e); if (p && onCell) onCell(p.i); }} />
      {tip && <div className="tip" style={{ left: Math.min(tip.x + 14, cols * cell - 150), top: tip.y + 14 }}>
        <div className="x">{unit} <b>{fmt(tip.i)}</b></div>
        <div>{raw ? raw(tip.i) : fmt(+glow[tip.i].toPrecision(3))}{marks.filter(m => m.cells.has(tip.i)).map(m => <div key={m.label} className="muted">in the pattern of {m.label}</div>)}</div></div>}
    </div>
  );
}

type Top = [number, number, (string[] | null)?];
const showToken = (t: string) => t.replace(/^ +/, m => "·".repeat(m.length)).replace(/\n/g, "↵") || "∅";

/* The sheet for one token of a run, with its reading beside it. */
export function SheetView({ project, graph, run, tokens, top, token, snapshot, openUnit, theme }:
  { project: string; graph: SheetGraph; run: string; tokens: { i: number; text: string }[]; top: Top[][] | undefined; token: number; snapshot: string;
    openUnit: (node: string, unit: number) => void; theme: string }) {
  const parts = sheetParts(graph)!;
  const [row, setRow] = useState<Row | null>(null);
  const [usual, setUsual] = useState<number[] | null>(null);
  const [rebuilt, setRebuilt] = useState(false);
  const [picked, setPicked] = useState<number[]>([]);                  // up to two features whose patterns are drawn
  const [patterns, setPatterns] = useState<Record<number, { all?: number[]; half?: number; words?: string[] | null } | null>>({});
  const [said, setSaid] = useState("");
  const source = rebuilt && parts.rebuild ? parts.rebuild : parts.sheet;
  useEffect(() => {
    let alive = true;
    rowOf(project, run, source.id, token, parts.sheet.width!).then(r => { if (!alive) return; setRow(r); if (r.usual) setUsual(r.usual); setSaid(""); }, e => alive && setSaid(e.message));
    return () => { alive = false; };
  }, [project, run, source.id, token]);
  useEffect(() => { setPicked([]); }, [run]);
  useEffect(() => {
    picked.filter(u => !(u in patterns)).forEach(u => {
      fetch(`/api/v2/scan/${enc(project)}/unit?snapshot=${enc(snapshot)}&node=${enc(parts.features.id)}&unit=${u}`).then(r => r.json())
        .then(p => setPatterns(old => ({ ...old, [u]: p.made_of ? { all: p.made_of.all, half: p.made_of.half, words: p.words?.slice(0, 3).map((w: [string, number]) => w[0]) } : null })),
          () => setPatterns(old => ({ ...old, [u]: null })));
    });
  }, [picked, snapshot]);
  const level = row?.usual ?? usual;                                   // the rebuild is set against the same usual level as what went in
  const glow = useMemo(() => (row ? row.values.map((v, i) => v - (level?.[i] ?? 0)) : []), [row, level]);
  const colours = ["--s2", "--s3"];
  const reading = top?.[token] ?? [];
  const nameOf = (u: number) => { const w = reading.find(r => r[0] === u)?.[2] ?? patterns[u]?.words; return (w?.length ? w.slice(0, 2).map(showToken).join(" ") + " " : "") + "#" + u; };
  const marks: Mark[] = picked.map((u, k) => {
    const p = patterns[u];
    if (!p?.all) return null;
    // a pattern is drawn on the cells that carry half of it: few enough to see as a shape, enough to be the feature
    const order = p.all.map((v, i) => [Math.abs(v), i]).sort((a, b) => b[0] - a[0]).slice(0, Math.max(8, Math.min(p.half ?? 40, 160)));
    return { cells: new Set(order.map(o => o[1])), colour: cssColour(colours[k]), label: nameOf(u) };
  }).filter((m): m is Mark => !!m);
  const shared = marks.length > 1 ? [...marks[0].cells].filter(i => marks[1].cells.has(i)).length : 0;
  const choose = (u: number) => setPicked(old => (old.includes(u) ? old.filter(x => x !== u) : [...old, u].slice(-2)));
  const most = Math.max(1e-9, ...reading.map(r => Math.abs(r[1])));
  return (
    <section className="panel sheetview">
      <div className="row"><h2>The {parts.sheet.label.toLowerCase()} for <span className="mono">{showToken(tokens[token]?.text ?? "")}</span></h2>
        <span className="grow" />
        {parts.rebuild && <div className="seg" role="group" aria-label="What the sheet shows">
          <button className="small" aria-pressed={!rebuilt} onClick={() => setRebuilt(false)}>What went in</button>
          <button className="small" aria-pressed={rebuilt} data-tip="What the sparse autoencoder makes of it from its features alone. The closer to what went in, the better it has learnt." onClick={() => setRebuilt(true)}>The rebuild</button></div>}
      </div>
      <p className="muted small">Each cell is one {parts.sheet.unit ?? "unit"}, always in the same place, in order of its number. Where a cell sits means nothing; the pattern is what to look at.
        Blue is above that {parts.sheet.unit ?? "unit"}'s usual level, red below.{said ? " " + said : ""}</p>
      <div className="sheetrow">
        {row ? <SheetCanvas glow={glow} marks={marks} cell={glow.length > 6000 ? 5 : 9} theme={theme} unit={parts.sheet.unit ?? "unit"} label={`${parts.sheet.label} for this token`}
          onCell={i => openUnit(parts.sheet.id, i)} raw={i => `${fmt(+row.values[i].toPrecision(3))}${level ? `, usually ${fmt(+level[i].toPrecision(3))}` : ""}`} />
          : <div className="sheet empty" style={{ width: 576, height: 432 }} />}
        <div className="reading">
          <h3>The reading: what this pattern decodes to</h3>
          {reading.length ? <ol>{reading.map(([u, v, w]) => {
            const k = picked.indexOf(u);
            return <li key={u}><button className={"feat" + (k >= 0 ? " on" : "")} aria-pressed={k >= 0} onClick={() => choose(u)} style={k >= 0 ? { borderColor: `var(${colours[k]})` } : undefined}
              data-tip={k >= 0 ? "Drawn on the sheet. Click to take it off." : "Draw this feature's own pattern on the sheet"}>
              <span className="bar"><b style={{ width: `${100 * Math.abs(v) / most}%` }} /></span>
              <span className="mono words">{w?.length ? w.slice(0, 3).map(showToken).join(" ") : <span className="muted">no words</span>}</span>
              <span className="muted num">{fmt(+v.toPrecision(3))}</span><span className="muted num">#{u}</span></button>
              <button className="small ghost" aria-label={`open feature ${u}`} data-tip="This feature's page" onClick={() => openUnit(parts.features.id, u)}>›</button></li>;
          })}</ol> : <p className="muted small">No feature is on for this token.</p>}
          {picked.length > 0 && <div className="legend">{picked.map((u, k) => <span key={u}><i className="swatch box" style={{ borderColor: `var(${colours[k]})` }} />{nameOf(u)}
            {patterns[u] === null || (patterns[u] && !patterns[u]!.all) ? <span className="muted"> (this scanner does not send whole patterns)</span> : ""}</span>)}
            {marks.length > 1 && <span><i className="swatch box" style={{ borderColor: "var(--fg)" }} />{shared} cell{shared === 1 ? "" : "s"} in both</span>}</div>}
          <p className="muted small">Click a feature to draw its pattern on the sheet: an outline round the cells that carry half of it. Click a second to set the two against each other. A feature lighting up shows it is related to the text, not that it causes anything.</p>
        </div>
      </div>
    </section>
  );
}

/* Any step's row for one token, opened out as a sheet. When the row changes, it is shown folding: the long row a bar
   draws part of, wrapping down into the square that holds all of it. */
export function StepSheet({ project, run, node, token, tokenText, drawn, how, theme, onCell }:
  { project: string; run: string; node: { id: string; label: string; width?: number | null; unit?: string }; token: number; tokenText: string;
    drawn: number; how: string; theme: string; onCell: (unit: number) => void }) {
  const [row, setRow] = useState<Row | null>(null);
  const [said, setSaid] = useState("");
  const width = node.width ?? 0;
  useEffect(() => {
    let alive = true;
    setRow(null);
    rowOf(project, run, node.id, token, width).then(r => { if (alive) { setRow(r); setSaid(""); } }, e => alive && setSaid(e.message));
    return () => { alive = false; };
  }, [project, run, node.id, token]);
  const glow = useMemo(() => (row ? row.values.map((v, i) => v - (row.usual?.[i] ?? 0)) : []), [row]);
  const unit = node.unit ?? "unit";
  return (
    <section className="panel stepsheet">
      <div className="row"><h2>{node.label}, the row for <span className="mono">{showToken(tokenText)}</span>, as a sheet</h2></div>
      <p className="muted small">The same numbers as that row of the bar, folded from one long row into a square. The bar drew {how === "strongest" ? `its ${fmt(drawn)} strongest` : `the first ${fmt(drawn)}`} of {fmt(width)} {unit}s; the sheet has all {fmt(width)}.
        {row?.usual ? ` Each is shown against that ${unit}'s usual level.` : ""} Click a square for its {unit}.{said ? " " + said : ""}</p>
      {row ? <SheetCanvas glow={glow} cell={glow.length > 6000 ? 4 : 9} theme={theme} unit={unit} label={`${node.label} for this token, every ${unit}`} fold={`${run}/${node.id}/${token}`}
        onCell={onCell} raw={i => `${fmt(+row.values[i].toPrecision(3))}${row.usual ? `, usually ${fmt(+row.usual[i].toPrecision(3))}` : ""}`} />
        : <div className="sheet empty" style={{ width: 576, height: 200 }} />}
    </section>
  );
}

/* Two texts: a sheet for each of a pair of tokens, and a third for what differs between them. */
export function ContrastSheets({ project, graph, runA, runB, a, b, texts, theme, openUnit }:
  { project: string; graph: SheetGraph; runA: string; runB: string; a: number; b: number; texts: [string, string]; theme: string; openUnit: (node: string, unit: number) => void }) {
  const parts = sheetParts(graph)!;
  const [rows, setRows] = useState<[Row, Row] | null>(null);
  useEffect(() => {
    let alive = true;
    Promise.all([rowOf(project, runA, parts.sheet.id, a, parts.sheet.width!), rowOf(project, runB, parts.sheet.id, b, parts.sheet.width!)]).then(r => alive && setRows(r as [Row, Row]), () => {});
    return () => { alive = false; };
  }, [project, runA, runB, a, b]);
  if (!rows) return null;
  const usual = rows[0].usual;
  const glowOf = (r: Row) => r.values.map((v, i) => v - (usual?.[i] ?? 0));
  const gap = rows[0].values.map((v, i) => v - rows[1].values[i]);
  const cell = rows[0].values.length > 6000 ? 3 : 6, unit = parts.sheet.unit ?? "unit";
  return (
    <div className="threesheets">
      <figure><figcaption>First text, <span className="mono">{showToken(texts[0])}</span></figcaption>
        <SheetCanvas glow={glowOf(rows[0])} cell={cell} theme={theme} unit={unit} label="the first text's sheet" onCell={i => openUnit(parts.sheet.id, i)} /></figure>
      <figure><figcaption>Second text, <span className="mono">{showToken(texts[1])}</span></figcaption>
        <SheetCanvas glow={glowOf(rows[1])} cell={cell} theme={theme} unit={unit} label="the second text's sheet" onCell={i => openUnit(parts.sheet.id, i)} /></figure>
      <figure><figcaption>The difference: blue where the first is higher, red where the second is</figcaption>
        <SheetCanvas glow={gap} cell={cell} theme={theme} unit={unit} label="the difference between the two sheets" onCell={i => openUnit(parts.sheet.id, i)} /></figure>
    </div>
  );
}
