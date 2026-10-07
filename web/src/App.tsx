/* The shell: the bar across the top, and which page is shown for the address after the #.
     #/                 the workspace
     #/run/<id>         one run
     #/search/<text>    the words logged in every run */
import { useCallback, useEffect, useState } from "react";
import { api, dur, enc, fmt, Run, runHref, SyncState, useHash, usePoll, useStored } from "./lib";
import { RunPage, Word } from "./RunPage";
import { Workspace } from "./Workspace";

type Listing = { runs: Run[]; sync: SyncState; now: number };
type Found = { run: string; fields: { field: string; first_step: number | null; count: number; hits: { step: number | null; value: unknown }[] }[] }[];

function Search({ q, runs }: { q: string; runs: Run[] }) {
  const { data } = usePoll<{ results: Found }>(() => api(`/api/v2/search?q=${enc(q)}`), 0, [q]);
  const name = (id: string) => runs.find(r => r.id === id)?.name ?? id;
  const low = q.toLowerCase();
  if (!data) return <p className="muted">Searching…</p>;
  return (
    <div className="stack">
      <header className="runhead"><h1>“{q}” in the words runs logged</h1>
        <p className="lede">{data.results.length ? "For each run and field: the first step at which it appears, then the lines that hold it." : "No run has logged that in a field of words."}</p></header>
      {data.results.map(res => (
        <section key={res.run} className="panel"><h2><a href={runHref(res.run)}>{name(res.run)}</a> <span className="muted small">{res.run}</span></h2>
          {res.fields.map(f => (
            <div key={f.field}>
              <p><span className="mono">{f.field}</span> first at step <b><a href={`${runHref(res.run)}?find=${enc(q)}&at=${f.first_step}`}>{fmt(f.first_step)}</a></b>
                <span className="muted"> · in {fmt(f.count)} logged line{f.count === 1 ? "" : "s"}</span></p>
              <div className="timeline" style={{ maxHeight: 190 }}><table><tbody>{f.hits.map((h, i) => (
                <tr key={i}><td className="num"><a href={`${runHref(res.run)}?find=${enc(q)}&at=${h.step}`}>{fmt(h.step)}</a></td>
                  <td className="words">{(Array.isArray(h.value) ? (h.value as string[]) : [String(h.value)]).map((w, n) => <Word key={n} w={w} find={low} />)}</td></tr>))}</tbody></table></div>
            </div>))}
        </section>))}
    </div>
  );
}

export function App() {
  const hash = useHash();
  const [theme, setTheme] = useStored<"" | "light" | "dark">("theme", "");
  const [toast, setToast] = useState("");
  const [q, setQ] = useState("");
  const { data, reload } = usePoll<Listing>(() => api("/api/v2/runs"), 5000, []);
  useEffect(() => { theme ? document.documentElement.setAttribute("data-theme", theme) : document.documentElement.removeAttribute("data-theme"); }, [theme]);
  const say = useCallback((text: string) => { setToast(text); setTimeout(() => setToast(t => (t === text ? "" : t)), 5000); }, []);
  const shownTheme = theme || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");

  const [path, qs] = decodeURI(hash.replace(/^#\/?/, "")).split("?");
  const [kind, ...rest] = path.split("/");
  const arg = rest.join("/");
  useEffect(() => { window.scrollTo(0, 0); }, [path]);

  const sync = data?.sync;
  const syncNow = async () => { await api("/api/sync", {}); say("Copying from the sources…"); setTimeout(reload, 1500); };
  const runs = data?.runs ?? [];
  return (
    <div className="app">
      <nav className="top">
        <a className="brand" href="#/">Train Run Tracker</a>
        <span className="grow" />
        {sync && (sync.busy || sync.error || sync.last) && (
          <span className={"sync" + (sync.busy ? " busy" : sync.error ? " bad" : "")} title={sync.error ? sync.error : (sync.lines ?? []).join("\n")}>
            <i />{sync.busy ? "Copying" : sync.error ? "A source could not be reached" : `Copied ${dur((data?.now ?? 0) - (sync.last ?? 0))} ago`}</span>)}
        <button className="small" disabled={sync?.busy} title={sync?.error ?? "Copy what is new from the sources"} onClick={syncNow}>{sync?.error ? "Try again" : "Sync"}</button>
        <form role="search" onSubmit={e => { e.preventDefault(); if (q.trim()) location.hash = "#/search/" + enc(q.trim()); }}>
          <input type="search" value={q} onChange={e => setQ(e.target.value)} placeholder="Search the words runs logged" aria-label="Search the words logged in every run" />
        </form>
        <button className="small ghost" title="Switch between light and dark" onClick={() => setTheme(shownTheme === "dark" ? "light" : "dark")}>{shownTheme === "dark" ? "Light" : "Dark"}</button>
      </nav>
      <main>
        {!data ? <p className="muted">Loading…</p>
          : kind === "run" && arg ? <RunPage key={arg} id={arg} query={new URLSearchParams(qs ?? "")} theme={shownTheme} say={say} />
          : kind === "search" && arg ? <Search q={decodeURIComponent(arg)} runs={runs} />
          : <Workspace runs={runs} theme={shownTheme} say={say} />}
      </main>
      {toast && <div className="toast" role="status">{toast}</div>}
    </div>
  );
}
