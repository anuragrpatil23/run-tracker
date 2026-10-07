/* The charts, in sections, so that a run with a hundred numbers is not one long scroll.

   A number's section is the part of its name before the first "/" or "." ("train/loss" and "sky.fired" go under
   "train" and "sky"); names with neither go under Main; samples of the machine go last. Any chart can be pinned, which
   puts it in a section of its own at the top. Down the left is a table of contents that stays in view: the sections,
   and under each open one its charts. Click an entry to go there; the one being read is marked. Only Pinned and Main
   start open. */
import { useEffect, useMemo, useRef, useState } from "react";
import { About, Drawn, FormulaForm, Icon, Panel, View } from "./Chart";
import { useStored } from "./lib";

type Section = { id: string; title: string; about: string; keys: string[] };
const SIZES = { s: { min: 250, height: 140 }, m: { min: 360, height: 200 }, l: { min: 560, height: 300 } };

function sectionOf(key: string): string {
  if (key.startsWith("sys/")) return "sys";
  const cut = key.search(/[/.]/);
  return cut > 0 ? key.slice(0, cut) : "main";
}
const shortName = (key: string, section: string) =>
  section === "sys" ? key.slice(4) : section !== "main" && section !== "pinned" && key.startsWith(section) ? key.slice(section.length + 1) : key;

export function ChartSections({ numbers, clocks, runs, view, sync }:
  { numbers: string[]; clocks: string[]; runs: Drawn[]; view: View; sync: string }) {
  const [pinned, setPinned] = useStored<string[]>("pinned", []);
  const [hidden, setHidden] = useStored<string[]>("hiddenPanels", []);
  const [open, setOpen] = useStored<Record<string, boolean>>("sectionsOpen", {});
  const [size, setSize] = useStored<keyof typeof SIZES>("chartSize", "m");
  const [find, setFind] = useState("");
  const [adding, setAdding] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  const sections = useMemo(() => {
    // Rows seen and minutes are axes, not charts. The loss comes first, then other charts worked out by formula,
    // then the rest in the order the runs logged them: the chart most people look for should not need finding.
    const rank = (k: string) => (/(^|[_./])loss($|[_./])/i.test(k) ? 0 : view.formulas[k] ? 1 : 2);
    const charts = numbers.filter(k => !clocks.includes(k) && !hidden.includes(k)).map((k, i) => ({ k, i })).sort((a, b) => rank(a.k) - rank(b.k) || a.i - b.i).map(e => e.k);
    const by = new Map<string, string[]>();
    for (const k of charts) { const s = sectionOf(k); by.set(s, [...(by.get(s) ?? []), k]); }
    const rest = [...by.keys()].filter(s => s !== "main" && s !== "sys").sort();
    const out: Section[] = [];
    const pins = pinned.filter(k => charts.includes(k));
    if (pins.length) out.push({ id: "pinned", title: "Pinned", about: "The charts you chose to keep at the top", keys: pins });
    if (by.has("main")) out.push({ id: "main", title: "Main", about: "The numbers the run logged at each step", keys: by.get("main")! });
    for (const s of rest) out.push({ id: s, title: s, about: `Everything the run logged under “${s}”`, keys: by.get(s)! });
    if (by.has("sys")) out.push({ id: "sys", title: "The machine", about: "GPU, memory and processor, against minutes since the run began", keys: by.get("sys")! });
    return out;
  }, [numbers, clocks, hidden, pinned, view.formulas]);

  const q = find.trim().toLowerCase();
  const matching = (s: Section) => (q ? s.keys.filter(k => k.toLowerCase().includes(q)) : s.keys);
  const firstId = sections[0]?.id;
  const isOpen = (s: Section) => (q ? matching(s).length > 0 : open[s.id] ?? (s.id === "pinned" || s.id === "main" || (s.id === firstId && sections.length === 1)));
  const set = (id: string, on: boolean) => setOpen(old => ({ ...old, [id]: on }));
  const [reading, setReading] = useState("");
  const goTo = (s: Section, chart?: string) => {
    set(s.id, true);
    setTimeout(() => {
      const sec = box.current?.querySelector(`[data-section="${CSS.escape(s.id)}"]`);
      const el = chart ? sec?.querySelector(`[data-chart="${CSS.escape(chart)}"]`) : sec;
      el?.scrollIntoView({ block: chart ? "center" : "start" });
      if (chart && el) { el.classList.add("found"); setTimeout(() => el.classList.remove("found"), 1400); }
    }, 40);
  };
  // Which section is being read: the last one whose heading has passed the top of the window.
  useEffect(() => {
    const on = () => {
      let now = "";
      // at the foot of the page the last sections can never reach the top, so there the line is drawn lower down
      const line = innerHeight + scrollY >= document.documentElement.scrollHeight - 4 ? innerHeight * 0.7 : 220;
      box.current?.querySelectorAll<HTMLElement>("section.sec").forEach(e => { if (e.getBoundingClientRect().top < line) now = e.dataset.section ?? ""; });
      setReading(now || sections[0]?.id || "");
    };
    on();
    window.addEventListener("scroll", on, { passive: true });
    return () => window.removeEventListener("scroll", on);
  }, [sections]);
  const pin = (k: string) => setPinned(pinned.includes(k) ? pinned.filter(p => p !== k) : [...pinned, k]);
  const total = sections.filter(s => s.id !== "pinned").reduce((n, s) => n + s.keys.length, 0);

  if (!runs.length) return <p className="muted">Choose runs to draw: click the dot beside a run's name.</p>;
  if (!total) return <p className="muted">These runs have logged no numbers yet.</p>;
  return (
    <div className="sections" ref={box}>
      <nav className="toc" aria-label="Contents">
        <input type="search" value={find} onChange={e => setFind(e.target.value)} placeholder={`Find among ${total} charts`} aria-label="Find a chart by name" />
        <ol>
          {sections.map(s => {
            const keys = matching(s);
            if (q && !keys.length) return null;
            return (
              <li key={s.id} className={reading === s.id ? "here" : ""}>
                <button className="entry" aria-current={reading === s.id ? "true" : undefined} onClick={() => goTo(s)}>
                  <span className="name">{s.title}</span><span className="count">{keys.length}</span></button>
                {isOpen(s) && <ol>{keys.map(k => <li key={k}><button className="entry sub" title={view.about[k] || undefined} onClick={() => goTo(s, k)}>{shortName(k, s.id)}</button></li>)}</ol>}
              </li>
            );
          })}
        </ol>
        <div className="row foot">
          <div className="seg" role="group" aria-label="Size of the charts">
            {(["s", "m", "l"] as const).map(k => <button key={k} className="small" aria-pressed={size === k} data-tip={{ s: "Small charts, more to a row", m: "Medium charts", l: "Large charts, one or two to a row" }[k]}
              onClick={() => setSize(k)}>{k.toUpperCase()}</button>)}
          </div>
          <button className="small ghost" onClick={() => setOpen(Object.fromEntries(sections.map(s => [s.id, !sections.every(isOpen)])))}>{sections.every(isOpen) ? "Close all" : "Open all"}</button>
        </div>
        <button className="small" data-tip="For a number the script did not log but that follows from ones it did, such as a loss that is the sum of two terms" onClick={() => setAdding(true)}>New chart from a formula</button>
        {adding && <FormulaForm view={view} names={numbers.filter(k => !k.startsWith("sys/") && !view.formulas[k])} close={() => setAdding(false)} />}
      </nav>
      <div className="secbody">
      {sections.map(s => {
        const keys = matching(s);
        if (q && !keys.length) return null;
        return (
          <section key={s.id} data-section={s.id} className={"sec" + (isOpen(s) ? " open" : "")}>
            <div className="sechead">
              <button className="toggle" aria-expanded={isOpen(s)} onClick={() => set(s.id, !isOpen(s))}>
                <span className="chev"><Icon name="chevron" /></span><span className="title">{s.title}</span>
              </button>
              <span className="count">{keys.length} chart{keys.length === 1 ? "" : "s"}</span>
              <About name={"section:" + s.id} fallback={s.about} view={view} />
            </div>
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
    </div>
  );
}
