/* One run: what it was, what it logged, what it printed, and what you expected of it. */
import { useEffect, useMemo, useRef, useState } from "react";
import { Panel, View } from "./Chart";
import { api, dur, enc, fmt, KeyInfo, Run, sizeText, usePoll, useStored, when } from "./lib";
import { Badge } from "./Workspace";

type Detail = Run & {
  meta: any; status: any; config: Record<string, unknown>; sync: any; local: { outcome?: string }; notes: string; commit_url: string | null; folder: string;
  files: { path: string; size: number; step: number | null; sha256?: string; registered: boolean; here: boolean }[];
};
type Timeline = { columns: { key: string; name: string; kind: string }[]; rows: { step: number | null; cells: unknown[] }[]; shown: number; total: number };

const flat = (o: any, p = "", out: Record<string, unknown> = {}) => {
  for (const [k, v] of Object.entries(o ?? {})) v && typeof v === "object" && !Array.isArray(v) ? flat(v, p + k + ".", out) : (out[p + k] = v);
  return out;
};

export function Word({ w, fresh, find }: { w: string; fresh?: boolean; find?: string }) {
  const lead = w.length - w.trimStart().length;
  return <span className={"w" + (fresh ? " new" : "") + (find && w.toLowerCase().includes(find) ? " hit" : "")}>
    {lead > 0 && <span className="sp">{"·".repeat(lead)}</span>}{w.slice(lead).replace(/\n/g, "↵") || (lead ? "" : "∅")}</span>;
}

function Words({ id, name, find, at, grown }: { id: string; name: string; find: string; at: string | null; grown: number }) {
  const [changes, setChanges] = useStored("changes." + name, true);
  const { data } = usePoll<Timeline>(() => api(`/api/v2/timeline?id=${enc(id)}&key=${enc(name)}&changes=${changes ? 1 : 0}`), 0, [id, name, changes, grown]);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (data && at != null) box.current?.querySelector(`tr[data-step="${CSS.escape(at)}"]`)?.scrollIntoView({ block: "center" });
  }, [data, at]);
  if (!data) return null;
  const { columns, rows } = data;
  /* A whole number that seldom changes names something (which feature), so its changes are marked; one that changes on
     most rows is a measurement, and marking it would mark everything. */
  const names = columns.map((c, i) => c.kind === "number" && rows.every(r => r.cells[i] == null || Number.isInteger(r.cells[i]))
    && rows.filter((r, j) => j > 0 && r.cells[i] !== rows[j - 1].cells[i]).length < Math.max(2, rows.length * 0.3));
  return (
    <section className="panel">
      <div className="row"><h2>{name}</h2><span className="muted">{data.shown} of {data.total} logged lines{rows.length < data.shown ? `, the first ${rows.length} shown` : ""}</span>
        <span className="grow" /><button className="small" aria-pressed={changes} onClick={() => setChanges(!changes)}>only lines where the words changed</button></div>
      <p className="muted small">Read down to watch it form. A word in an outlined box was not in the row above; a number in colour changed from the row above.</p>
      <div className="timeline" ref={box}><table>
        <thead><tr><th className="num">step</th>{columns.map(c => <th key={c.key} className={c.kind === "number" ? "num" : ""}>{c.name}</th>)}</tr></thead>
        <tbody>{rows.map((r, j) => (
          <tr key={j} data-step={r.step ?? ""} className={at != null && String(r.step) === at ? "sel" : ""}>
            <td className="num">{fmt(r.step)}</td>
            {columns.map((c, i) => {
              const v = r.cells[i], before = j ? rows[j - 1].cells[i] : undefined;
              if (c.kind === "number") return <td key={i} className={"num" + (j && names[i] && v !== before ? " changed" : "")}>{fmt(v)}</td>;
              const list = Array.isArray(v) ? (v as string[]) : v == null ? [] : [String(v)];
              const old = new Set(Array.isArray(before) ? (before as string[]) : before == null ? [] : [String(before)]);
              return <td key={i} className="words">{list.map((w, n) => <Word key={n} w={w} fresh={j > 0 && !old.has(w)} find={find} />)}</td>;
            })}
          </tr>))}</tbody>
      </table></div>
    </section>
  );
}

export function RunPage({ id, query, theme, say }: { id: string; query: URLSearchParams; theme: string; say: (t: string) => void }) {
  const { data: d, error, reload } = usePoll<Detail>(() => api(`/api/run?id=${enc(id)}`), 5000, [id]);
  const grown = d?.lines ?? 0;
  const { data: keyMap } = usePoll<Record<string, KeyInfo[]>>(() => api(`/api/v2/keys?runs=${enc(id)}`), 0, [id, grown]);
  const [tab, setTab] = useState(query.get("tab") || (query.get("find") ? "words" : "charts"));
  const [x, setX] = useStored("x", "step");
  const [smooth, setSmooth] = useStored("smooth", 0);
  const [logs, setLogs] = useStored<Record<string, boolean>>("logs", {});
  const [trim, setTrim] = useStored("trim", false);
  const [range, setRange] = useState<[number, number] | null>(null);
  const keys = keyMap?.[id] ?? [];
  const numbers = keys.filter(k => k.kind === "number").map(k => k.key);
  const clocks = keys.filter(k => k.kind === "number" && k.mono && (k.hi ?? 0) > (k.lo ?? 0) && !k.key.includes(".") && !k.key.startsWith("sys/")).map(k => k.key);
  const xChoices: [string, string][] = [["step", "step"], ...clocks.map(k => [k, k] as [string, string]), ["_t", "time (minutes)"]];
  const xNow = xChoices.some(c => c[0] === x) ? x : "step";
  const view: View = { x: xNow, xLabel: xNow === "_t" ? "minutes" : xNow, smooth, logs, theme, tickN: grown, setLog: (k, on) => setLogs(o => ({ ...o, [k]: on })), range, setRange, trim };
  const drawn = useMemo(() => (d ? [{ id, name: d.name, slot: 1 }] : []), [id, d?.name]);
  const plain = numbers.filter(k => !k.includes(".") && !k.startsWith("sys/") && !clocks.includes(k));   // rows and minutes are axes, not charts
  const nested = new Map<string, string[]>();
  for (const k of numbers) if (k.includes(".") && !k.startsWith("sys/")) { const g = k.split(".")[0]; nested.set(g, [...(nested.get(g) ?? []), k]); }
  const machine = numbers.filter(k => k.startsWith("sys/"));
  const wordGroups = [...new Set(keys.filter(k => k.kind === "words").map(k => (k.key.includes(".") ? k.key.split(".").slice(0, -1).join(".") : k.key)))];
  const { data: out } = usePoll<{ text: string }>(() => (tab === "output" ? api(`/api/v2/output?id=${enc(id)}`) : Promise.resolve({ text: "" })), tab === "output" ? 8000 : 0, [id, tab]);

  if (error && !d) return <div className="panel"><h2>That did not work</h2><p>{error}</p><p><a href="#/">Back to the runs</a></p></div>;
  if (!d) return <p className="muted">Loading…</p>;
  const git = d.meta.git ?? {}, wb = d.meta.wandb;
  const save = (change: Record<string, unknown>) => api("/api/local", { id, ...change }).then(() => { say("Saved"); reload(); }, e => say(e.message));
  const tabs: [string, string][] = [["charts", "Charts"], ["words", `Words${wordGroups.length ? ` (${wordGroups.length})` : ""}`], ["machine", "The machine"],
    ["overview", "Settings and notes"], ["output", "Output"], ["files", `Files (${d.files.length})`]];
  return (
    <div className="stack">
      <div className="runhead">
        <p className="where"><a href="#/">Runs</a> / {d.source}, on {d.sync.host || "this machine"}{wb ? `, logged with the W&B client${wb.project ? ` in project ${wb.project}` : ""}` : ""}
          {d.synced ? `, copied ${dur(Date.now() / 1000 - d.synced)} ago` : ""}</p>
        <div className="row"><h1>{d.name}</h1><Badge run={d} />{d.why && <span className={["stalled", "died", "failed"].includes(d.state) ? "note-warn" : "muted"}>{d.why}</span>}
          {d.tags.map(t => <span key={t} className="tag">{t}</span>)}</div>
        <dl className="kv">
          <dt>progress</dt><dd>{d.total ? <>{fmt(d.step ?? 0)} of {fmt(d.total)}<span className="bar"><b style={{ width: `${Math.min(100, 100 * (d.step ?? 0) / d.total)}%` }} /></span></> : <>step {fmt(d.step)}</>} · {fmt(d.lines)} lines logged</dd>
          <dt>time</dt><dd>{[dur(d.seconds), d.started ? "started " + when(d.started) : "", d.ended ? "ended " + when(d.ended) : ""].filter(Boolean).join(" · ")}</dd>
          {d.job && <><dt>job</dt><dd>{d.job.id} · the scheduler says {d.job.state} ({d.job.raw}){d.job.exit_code ? `, exit code ${d.job.exit_code}` : ""}</dd></>}
          <dt>code</dt><dd>{git.commit ? <>
            {d.commit_url ? <a className="mono" href={d.commit_url} target="_blank" rel="noopener">{git.commit.slice(0, 10)}</a> : <span className="mono">{git.commit.slice(0, 10)}</span>}
            {git.branch ? ` on ${git.branch}` : ""}{git.dirty ? <span className="note-warn" style={{ marginLeft: 10 }}>with uncommitted changes to {(git.changed_files ?? []).join(", ") || "tracked files"}</span> : git.dirty === false ? " · clean" : ""}
          </> : <span className="muted">no commit recorded</span>}</dd>
          {d.meta.command && <><dt>command</dt><dd><pre>{d.meta.command}</pre></dd></>}
        </dl>
      </div>

      <div className="two">
        <label>Before the run: what do you expect to see?<textarea defaultValue={d.prediction} placeholder="Written before the result is in. Shown beside it afterwards."
          onBlur={e => e.target.value !== d.prediction && save({ prediction: e.target.value })} /></label>
        <label>After: what happened, set against that?<textarea defaultValue={d.local.outcome ?? ""} placeholder="Filled in once the run has ended."
          onBlur={e => e.target.value !== (d.local.outcome ?? "") && save({ outcome: e.target.value })} /></label>
      </div>

      <div className="row toolbar">
        <div className="tabs" role="tablist">{tabs.map(([k, label]) => <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)}>{label}</button>)}</div>
        <span className="grow" />
        {tab === "charts" && <>
          {range && <button className="small" onClick={() => setRange(null)}>Reset zoom</button>}
          <button className="small" aria-pressed={trim} title="Fit each y axis to the middle 96% of the values" onClick={() => setTrim(!trim)}>Ignore outliers</button>
          <label className="inline">Against<select value={xNow} onChange={e => { setX(e.target.value); setRange(null); }}>{xChoices.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
          <label className="inline">Smoothing<input type="range" min={0} max={0.99} step={0.01} value={smooth} onChange={e => setSmooth(+e.target.value)} /><span>{smooth.toFixed(2)}</span></label>
        </>}
      </div>

      {tab === "charts" && <>
        <div className="grid">{plain.map(k => <Panel key={k} name={k} runs={drawn} view={view} sync="run" />)}</div>
        {[...nested].map(([g, list]) => <details key={g} className="section" open><summary>{g} <span className="muted">{list.length} numbers</span></summary>
          <div className="grid">{list.map(k => <Panel key={k} name={k} title={k.slice(g.length + 1)} runs={drawn} view={view} sync="run" />)}</div></details>)}
        {!numbers.length && <p className="muted">{d.lines ? "This run logs no numbers." : "Nothing has been logged yet."}</p>}
      </>}
      {tab === "words" && (wordGroups.length ? wordGroups.map(g => <Words key={g} id={id} name={g} find={(query.get("find") || "").toLowerCase()} at={query.get("at")} grown={grown} />)
        : <p className="muted">This run has logged no words: no field that is text or a list of text.</p>)}
      {tab === "machine" && (machine.length ? <div className="grid">{machine.map(k => <Panel key={k} name={k} title={k.slice(4)} runs={drawn} view={view} sync="sys" />)}</div>
        : <p className="muted">No samples of the machine were recorded for this run.</p>)}
      {tab === "output" && <div className="panel"><p className="muted small">What the script printed, newest at the bottom.</p><pre className="output">{out?.text || "Nothing was captured."}</pre></div>}
      {tab === "overview" && (
        <div className="two">
          <section className="panel"><h2>Settings</h2><div className="scroll"><table><tbody>
            {Object.entries(flat(d.config)).map(([k, v]) => <tr key={k}><td className="mono">{k}</td><td className="mono wrapc">{typeof v === "object" ? JSON.stringify(v) : String(v)}</td></tr>)}
          </tbody></table></div></section>
          <section className="panel"><h2>Notes</h2>
            <label>One line<input type="text" defaultValue={d.note} onBlur={e => e.target.value !== d.note && save({ note: e.target.value })} /></label>
            <label>Tags, separated by commas<input type="text" defaultValue={d.tags.join(", ")}
              onBlur={e => e.target.value !== d.tags.join(", ") && save({ tags: e.target.value.split(",").map(t => t.trim()).filter(Boolean) })} /></label>
            <label>Anything else (kept in notes.md in the run's folder on this machine)
              <textarea style={{ minHeight: 180 }} defaultValue={d.notes} onBlur={e => e.target.value !== d.notes && api("/api/notes", { id, text: e.target.value }).then(() => say("Saved"), err => say(err.message))} /></label>
            <dl className="kv"><dt>there</dt><dd className="mono">{d.sync.remote_path}</dd><dt>here</dt><dd className="mono">{d.folder}</dd></dl>
          </section>
        </div>
      )}
      {tab === "files" && <Files d={d} say={say} reload={reload} />}
    </div>
  );
}

function Files({ d, say, reload }: { d: Detail; say: (t: string) => void; reload: () => void }) {
  const [busy, setBusy] = useState("");
  const fetchOne = async (path: string) => {
    setBusy(path);
    try { const r = await api("/api/fetch", { id: d.id, path }); say("Saved to " + r.path); reload(); } catch (e: any) { say(e.message); }
    setBusy("");
  };
  return (
    <section className="panel"><h2>Files the run saved</h2>
      <p className="muted small">Large files stay where the run wrote them. Only the list is copied; Fetch brings one here and checks it against the recorded checksum.</p>
      {d.files.length ? <div className="scroll"><table>
        <thead><tr><th>file</th><th className="num">size</th><th className="num">step</th><th>checksum</th><th>on this machine</th></tr></thead>
        <tbody>{d.files.map(f => <tr key={f.path}><td className="mono">{f.path}</td><td className="num">{sizeText(f.size)}</td><td className="num">{fmt(f.step)}</td>
          <td className="mono" title={f.sha256 ?? ""}>{f.sha256 ? f.sha256.slice(0, 10) : <span className="muted">none recorded</span>}</td>
          <td>{f.here ? "yes" : <button className="small" disabled={!!busy} onClick={() => fetchOne(f.path)}>{busy === f.path ? "Fetching…" : "Fetch"}</button>}</td></tr>)}</tbody>
      </table></div> : <p className="muted">None listed.</p>}
    </section>
  );
}
