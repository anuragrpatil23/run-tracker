/* The charts, in sections, so that a run with a hundred numbers is not one long scroll.

   A number's section is the part of its name before the first "/" or "." ("train/loss" and "sky.fired" go under
   "train" and "sky"); names with neither go under Main; samples of the machine go last. Any chart can be pinned, which
   puts it in a section of its own at the top. A bar that stays in view lists the sections: click one to open it and
   go there. Only Pinned and Main start open. */
import { useMemo, useRef, useState } from "react";
import { Drawn, Panel, View } from "./Chart";
import { useStored } from "./lib";

type Section = { id: string; title: string; keys: string[] };
const SIZES = { s: { min: 250, height: 140 }, m: { min: 360, height: 200 }, l: { min: 560, height: 300 } };

function sectionOf(key: string): string {
  if (key.startsWith("sys/")) return "sys";
  const cut = key.search(/[/.]/);
  return cut > 0 ? key.slice(0, cut) : "main";
}
const shortName = (key: string, section: string) =>
  section === "sys" ? key.slice(4) : section !== "main" && section !== "pinned" && key.startsWith(section) ? key.slice(section.length + 1) : key;

export function ChartSections({ numbers, clocks, runs, view, sync, legend }:
  { numbers: string[]; clocks: string[]; runs: Drawn[]; view: View; sync: string; legend?: boolean }) {
  const [pinned, setPinned] = useStored<string[]>("pinned", []);
  const [hidden, setHidden] = useStored<string[]>("hiddenPanels", []);
  const [open, setOpen] = useStored<Record<string, boolean>>("sectionsOpen", {});
  const [size, setSize] = useStored<keyof typeof SIZES>("chartSize", "m");
  const [find, setFind] = useState("");
  const box = useRef<HTMLDivElement>(null);

  const sections = useMemo(() => {
    const charts = numbers.filter(k => !clocks.includes(k) && !hidden.includes(k));       // rows seen and minutes are axes, not charts
    const by = new Map<string, string[]>();
    for (const k of charts) { const s = sectionOf(k); by.set(s, [...(by.get(s) ?? []), k]); }
    const rest = [...by.keys()].filter(s => s !== "main" && s !== "sys").sort();
    const out: Section[] = [];
    const pins = pinned.filter(k => charts.includes(k));
    if (pins.length) out.push({ id: "pinned", title: "Pinned", keys: pins });
    if (by.has("main")) out.push({ id: "main", title: "Main", keys: by.get("main")! });
    for (const s of rest) out.push({ id: s, title: s, keys: by.get(s)! });
    if (by.has("sys")) out.push({ id: "sys", title: "The machine", keys: by.get("sys")! });
    return out;
  }, [numbers, clocks, hidden, pinned]);

  const q = find.trim().toLowerCase();
  const matching = (s: Section) => (q ? s.keys.filter(k => k.toLowerCase().includes(q)) : s.keys);
  const firstId = sections[0]?.id;
  const isOpen = (s: Section) => (q ? matching(s).length > 0 : open[s.id] ?? (s.id === "pinned" || s.id === "main" || (s.id === firstId && sections.length === 1)));
  const set = (id: string, on: boolean) => setOpen(old => ({ ...old, [id]: on }));
  const goTo = (s: Section) => {
    const was = isOpen(s);
    set(s.id, !was);
    if (!was) setTimeout(() => box.current?.querySelector(`[data-section="${CSS.escape(s.id)}"]`)?.scrollIntoView({ block: "start" }), 30);
  };
  const pin = (k: string) => setPinned(pinned.includes(k) ? pinned.filter(p => p !== k) : [...pinned, k]);
  const total = sections.filter(s => s.id !== "pinned").reduce((n, s) => n + s.keys.length, 0);

  if (!runs.length) return <p className="muted">Choose runs to draw: click the dot beside a run's name.</p>;
  if (!total) return <p className="muted">These runs have logged no numbers yet.</p>;
  return (
    <div className="sections" ref={box}>
      <div className="secnav">
        <div className="chips" role="toolbar" aria-label="Sections of charts">
          {sections.map(s => <button key={s.id} className="small" aria-pressed={isOpen(s)} title={isOpen(s) ? "Close this section" : "Open this section and go to it"}
            onClick={() => goTo(s)}>{s.title} <span className="count">{matching(s).length}</span></button>)}
        </div>
        <span className="grow" />
        <input type="search" value={find} onChange={e => setFind(e.target.value)} placeholder={`Find among ${total} charts`} aria-label="Find a chart by name" />
        <div className="seg" role="group" aria-label="Size of the charts">
          {(["s", "m", "l"] as const).map(k => <button key={k} className="small" aria-pressed={size === k} title={{ s: "Small charts, more to a row", m: "Medium charts", l: "Large charts" }[k]}
            onClick={() => setSize(k)}>{k.toUpperCase()}</button>)}
        </div>
        <button className="small ghost" onClick={() => setOpen(Object.fromEntries(sections.map(s => [s.id, !sections.every(isOpen)])))}>{sections.every(isOpen) ? "Close all" : "Open all"}</button>
      </div>
      {legend && runs.length > 1 && <div className="legend">{[...new Map(runs.map(r => [r.group ?? r.id, r])).values()].map(r =>
        <span key={r.id}><i className="swatch" style={{ background: r.slot ? `var(--s${r.slot})` : "var(--faint)" }} />{r.group ?? r.name}</span>)}</div>}

      {sections.map(s => {
        const keys = matching(s);
        if (q && !keys.length) return null;
        return (
          <section key={s.id} data-section={s.id} className={"sec" + (isOpen(s) ? " open" : "")}>
            <button className="sechead" aria-expanded={isOpen(s)} onClick={() => set(s.id, !isOpen(s))}>
              <span className="mark" aria-hidden>{isOpen(s) ? "–" : "+"}</span>{s.title}
              <span className="muted">{keys.length} chart{keys.length === 1 ? "" : "s"}{s.id === "sys" ? ", against minutes since the run began" : ""}</span>
            </button>
            {isOpen(s) && <div className="grid" style={{ gridTemplateColumns: `repeat(auto-fill,minmax(min(100%,${SIZES[size].min}px),1fr))` }}>
              {keys.map(k => <Panel key={k} name={k} title={shortName(k, s.id)} runs={runs} view={view} sync={s.id === "sys" ? sync + "-sys" : sync} height={SIZES[size].height}
                pinned={pinned.includes(k)} onPin={() => pin(k)} onHide={() => setHidden([...hidden, k])} />)}
            </div>}
          </section>
        );
      })}
      {q && !sections.some(s => matching(s).length) && <p className="muted">No chart has “{find}” in its name.</p>}
      {hidden.length > 0 && <p className="muted small row">Hidden charts, click one to bring it back: {hidden.map(k => <button key={k} className="small" onClick={() => setHidden(hidden.filter(h => h !== k))}>{k}</button>)}</p>}
    </div>
  );
}
