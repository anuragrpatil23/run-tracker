/* The viewer. Four pages, chosen by the part of the address after the #:
     #/                      the list of runs
     #/run/<id>              one run
     #/compare/<id>,<id>     several runs together
     #/search/<text>         a search of the words logged in every run
   Each page asks the server again every few seconds, so a run that is still being copied grows on screen. */
(() => {
  const {h, fmt, flat, get, isNum, points, lineChart, dotChart, timeline, schema, xChoices, colour, differing} = RT;
  const view = document.getElementById("view");
  const keep = {
    get(k, d) { try { const v = localStorage.getItem("rt." + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem("rt." + k, JSON.stringify(v)); } catch {} },
  };
  async function api(path, body) {
    const r = await fetch(path, body ? {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify(body)} : undefined);
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || r.statusText);
    return j;
  }
  const enc = encodeURIComponent;
  /* put(el, ...) replaces what an element holds; lists may be nested and empty places are skipped */
  const put = (el, ...kids) => el.replaceChildren(...kids.flat(Infinity).filter(k => k != null && k !== false));
  let timer = null, visit = 0;                             // visit goes up on every change of page, so late answers for an old page are dropped
  const every = (ms, fn) => { clearInterval(timer); timer = setInterval(() => fn().catch(() => {}), ms); };

  const dur = sec => { if (!isNum(sec)) return ""; if (sec < 90) return Math.round(sec) + " s"; if (sec < 5400) return Math.round(sec / 60) + " min"; if (sec < 172800) return (sec / 3600).toFixed(1) + " h"; return (sec / 86400).toFixed(1) + " d"; };
  const when = t => (isNum(t) ? new Date(t * 1000).toLocaleString([], {dateStyle: "medium", timeStyle: "short"}) : "");
  const size = n => { if (!isNum(n)) return ""; const u = ["B", "KB", "MB", "GB"]; let i = 0; while (n >= 1024 && i < 3) { n /= 1024; i++; } return (i ? n.toFixed(1) : n) + " " + u[i]; };
  const badge = r => h("span", {class: "state " + r.state, title: r.why || ""}, h("i"), r.state);
  const going = r => ["running", "pending", "stalled"].includes(r.state);
  const progress = r => (r.total ? h("div", null, `${fmt(r.step ?? 0)} / ${fmt(r.total)}`, h("div", {class: "bar"}, h("b", {style: `width:${Math.min(100, 100 * (r.step || 0) / r.total)}%`}))) : fmt(r.step));
  const runLink = (id, text, extra = "") => h("a", {href: "#/run/" + encodeURI(id) + extra}, text || id);
  const toggle = (label, on, fn, title) => h("button", {class: "small", "aria-pressed": String(!!on), title, onclick: fn}, label);
  const fail = e => put(view, h("div", {class: "panel"}, h("h2", null, "That did not work"), h("p", null, String(e.message || e)), h("p", null, h("a", {href: "#/"}, "Back to the list of runs"))));

  /* ---------- the line at the top that says how fresh the copies are ---------- */
  const syncline = document.getElementById("syncline"), syncbtn = document.getElementById("syncbtn");
  function showSync(s, now) {
    syncbtn.disabled = !!s.busy;
    syncline.textContent = s.busy ? "copying…" : s.error ? "last copy failed: " + s.error.split("\n")[0]
      : s.last ? `copied ${dur(now - s.last)} ago` + (s.watch ? `, again every ${s.watch} s while a run is going` : "") : "";
    syncline.title = (s.error || "") + "\n" + (s.lines || []).join("\n");
  }
  syncbtn.onclick = async () => {
    syncbtn.disabled = true; syncline.textContent = "copying…";
    await api("/api/sync", {});
    const poll = setInterval(async () => { const s = await api("/api/sync"); if (!s.busy) { clearInterval(poll); showSync(s, Date.now() / 1000); route(false); } }, 700);
  };
  document.getElementById("searchform").onsubmit = e => { e.preventDefault(); const q = document.getElementById("searchbox").value.trim(); if (q) location.hash = "#/search/" + enc(q); };

  /* ---------- the list of runs ---------- */
  async function listView() {
    const mine = visit;
    let runs = [], lastSig = "", filter = keep.get("filter", ""), stateFilter = "", sort = keep.get("sort", {key: "started", dir: -1});
    const selected = new Set(keep.get("selected", []));
    const tableBox = h("div", {class: "scroll"}), colsBox = h("div", {class: "row"}), count = h("span", {class: "muted"});
    /* the charts under the table: the chosen numbers, one chart each, a line per run */
    const chartsBox = h("div", {class: "grid"}), chartsHead = h("div", {class: "row"}), logsOf = new Map(), slotOf = new Map(), logs = keep.get("log", {});
    let chartSig = "";
    const compareBtn = h("button", {onclick: () => (location.hash = "#/compare/" + [...selected].map(encodeURI).join(","))}, "Compare");
    put(view, 
      h("header", null, h("h1", null, "Runs")),
      h("div", {class: "row"},
        h("input", {type: "search", placeholder: "Filter by name, tag, note or setting (lam=0.2)", value: filter, style: "width:min(100%,360px)", "aria-label": "Filter the runs",
          oninput: e => { filter = e.target.value; keep.set("filter", filter); draw(); }}),
        h("select", {"aria-label": "Show only runs in this state", onchange: e => { stateFilter = e.target.value; draw(); }},
          ["", "running", "pending", "stalled", "finished", "failed", "died", "ended"].map(s => h("option", {value: s}, s || "any state"))),
        compareBtn, count),
      h("div", {class: "panel"}, tableBox),
      h("details", null, h("summary", {class: "muted"}, "Choose the numbers shown as columns and charts"), colsBox),
      chartsHead, chartsBox);

    function draw() {
      const diff = differing(runs);
      const metrics = [...new Set(runs.flatMap(r => Object.keys(r.latest)))];
      let chosen = keep.get("metrics", null);
      if (!chosen) chosen = metrics.filter(m => !m.includes(".") && m !== "step").slice(0, 6);
      chosen = chosen.filter(m => metrics.includes(m));
      put(colsBox, metrics.map(m => h("label", {class: "inline mono"}, h("input", {type: "checkbox", checked: chosen.includes(m),
        onchange: e => { keep.set("metrics", e.target.checked ? [...chosen, m] : chosen.filter(x => x !== m)); draw(); }}), m)));
      const q = filter.trim().toLowerCase();
      const hay = r => [r.id, r.state, r.note, ...(r.tags || []), ...Object.entries(r.settings).map(([k, v]) => k + "=" + v)].join(" ").toLowerCase();
      const val = (r, k) => k.startsWith("set:") ? r.settings[k.slice(4)] : k.startsWith("m:") ? r.latest[k.slice(2)] : r[k];
      const shown = runs.filter(r => (!q || q.split(/\s+/).every(w => hay(r).includes(w))) && (!stateFilter || r.state === stateFilter))
        .sort((a, b) => { const x = val(a, sort.key), y = val(b, sort.key); return (x == null) - (y == null) || (x < y ? -1 : x > y ? 1 : 0) * sort.dir; });
      const th = (label, key, cls = "") => h("th", {class: "sort " + cls, title: "sort by " + label, onclick: () => { sort = {key, dir: sort.key === key ? -sort.dir : 1}; keep.set("sort", sort); draw(); }},
        label + (sort.key === key ? (sort.dir > 0 ? " ↑" : " ↓") : ""));
      count.textContent = runs.length ? `${shown.length} of ${runs.length} runs · ${selected.size} chosen` : "";
      compareBtn.disabled = selected.size < 1;
      /* Which runs are drawn: the ticked ones, or all that are shown, up to the eight colours there are. A run keeps
         its colour for as long as it stays drawn, whatever else is ticked or filtered. */
      const pool = selected.size ? shown.filter(r => selected.has(r.id)) : shown, charted = pool.slice(0, 8);
      for (const id of [...slotOf.keys()]) if (!charted.some(r => r.id === id)) slotOf.delete(id);
      for (const r of charted) if (!slotOf.has(r.id)) { const used = new Set(slotOf.values()); let n = 1; while (used.has(n)) n++; slotOf.set(r.id, n); }
      drawCharts(charted, pool.length, chosen).catch(() => {});
      if (!runs.length) {
        put(tableBox, h("p", null, "No runs have been copied yet."), h("p", {class: "muted"}, "Say where runs are written, then copy them:"),
          h("pre", null, "rt source add sae --ssh minerva --root /path/to/runs --scheduler lsf\nrt sync"));
        return;
      }
      put(tableBox, h("table", null,
        h("thead", null, h("tr", null, h("th"), th("run", "id"), th("state", "state"), th("step", "step", "num"), th("time", "seconds", "num"), th("started", "started"),
          diff.map(k => th(k, "set:" + k, "num set")), chosen.map(m => th(m, "m:" + m, "num set")), h("th", null, "note"))),
        h("tbody", null, shown.map(r => h("tr", {class: selected.has(r.id) ? "sel" : ""},
          h("td", null, h("input", {type: "checkbox", checked: selected.has(r.id), "aria-label": "choose " + r.name + " for comparing",
            onchange: e => { e.target.checked ? selected.add(r.id) : selected.delete(r.id); keep.set("selected", [...selected]); draw(); }})),
          h("td", null, slotOf.has(r.id) ? h("i", {class: "swatch", style: `background:${colour(slotOf.get(r.id))}`}) : null, runLink(r.id, r.name), " ", h("span", {class: "muted"}, r.source), " ", (r.tags || []).map(t => h("span", {class: "tag"}, t))),
          h("td", null, badge(r)), h("td", {class: "num"}, progress(r)), h("td", {class: "num"}, dur(r.seconds)), h("td", null, when(r.started)),
          diff.map(k => h("td", {class: "num clip", title: String(r.settings[k] ?? "")}, fmt(r.settings[k]))), chosen.map(m => h("td", {class: "num"}, fmt(r.latest[m]))),
          h("td", null, h("input", {type: "text", value: r.note || "", placeholder: "one line about this run", "aria-label": "note for " + r.name,
            onchange: e => api("/api/local", {id: r.id, note: e.target.value}).then(() => (r.note = e.target.value))})))))));
    }
    async function drawCharts(charted, outOf, chosen) {
      await Promise.all(charted.map(async r => {
        const have = logsOf.get(r.id) || [];
        if (have.length < r.lines) logsOf.set(r.id, have.concat((await api(`/api/log?id=${enc(r.id)}&since=${have.length}`)).records));
      }));
      if (mine !== visit) return;
      const sig = JSON.stringify([charted.map(r => [r.id, slotOf.get(r.id), (logsOf.get(r.id) || []).length]), chosen, logs, outOf]);
      if (sig === chartSig) return;                       // nothing new to draw
      chartSig = sig;
      /* a number that only ever goes up in every run (rows seen, minutes) is an x axis, not something to compare */
      const clocks = f => charted.length && charted.every(r => xChoices(logsOf.get(r.id) || []).some(c => c[0] === f));
      const fields = chosen.filter(f => !clocks(f));
      put(chartsHead, charted.length ? [h("h2", null, selected.size ? "The ticked runs" : "All the runs shown"),
        h("span", {class: "muted"}, (outOf > 8 ? `the first 8 of ${outOf}; tick runs to choose which · ` : "") + "against step · tick runs to draw only those · click a run's name for everything it logged")] : []);
      put(chartsBox, fields.map(f => { const b = h("div"); queueMicrotask(() => one(b, f)); return b; }));
      function one(box, f) {
        lineChart(box, {title: f, xLabel: "step", logY: logs[f], onLog: v => { logs[f] = v; keep.set("log", logs); one(box, f); },
          series: charted.map(r => ({name: r.name, slot: slotOf.get(r.id), points: points(logsOf.get(r.id) || [], "step", f)}))});
      }
    }
    async function load() {
      const d = await api("/api/runs");
      if (mine !== visit) return;
      showSync(d.sync, d.now);
      for (const id of [...selected]) if (!d.runs.some(r => r.id === id)) selected.delete(id);
      const sig = JSON.stringify(d.runs);
      const typing = tableBox.contains(document.activeElement) && document.activeElement.type === "text";
      if (sig !== lastSig && !typing) { lastSig = sig; runs = d.runs; draw(); }
    }
    await load();
    every(5000, load);
  }

  /* ---------- one run ---------- */
  async function runView(id, query) {
    const mine = visit;
    let d = await api("/api/run?id=" + enc(id));
    const records = (await api("/api/log?id=" + enc(id))).records;
    let sys = (await api("/api/system?id=" + enc(id))).records;
    if (mine !== visit) return;
    const find = query.get("find") || "", at = query.get("at");
    let x = keep.get("x", "step");
    const logs = keep.get("log", {}), onlyChanges = keep.get("onlyChanges", {});
    const head = h("div", {class: "panel"}), charts = h("div", {class: "grid"}), groups = h("div", {class: "stack"}),
      system = h("div", {class: "stack"}), details = h("div", {class: "two"}), xsel = h("select", {"aria-label": "What the charts are drawn against", onchange: e => { x = e.target.value; keep.set("x", x); drawCharts(); }});
    const msg = h("span", {class: "muted"});

    const area = (label, key, placeholder) => h("label", null, label, h("textarea", {placeholder, value: key === "prediction" ? d.prediction : d.local[key] || "",
      onchange: e => api("/api/local", {id, [key]: e.target.value}).then(() => { msg.textContent = "saved"; setTimeout(() => (msg.textContent = ""), 1500); })}));
    put(view, head,
      h("div", {class: "panel"}, h("div", {class: "two"},
        area("Before the run: what do you expect to see?", "prediction", "Written before the result is in. Shown beside it afterwards."),
        area("After: what happened, set against that?", "outcome", "Filled in once the run has ended.")),
        h("div", {class: "row end"},
          h("label", {class: "grow"}, "One-line note", h("input", {type: "text", value: d.note, onchange: e => api("/api/local", {id, note: e.target.value})})),
          h("label", null, "Tags, separated by commas", h("input", {type: "text", value: (d.tags || []).join(", "), onchange: e => api("/api/local", {id, tags: e.target.value.split(",").map(t => t.trim()).filter(Boolean)})})), msg)),
      h("div", {class: "row"}, h("h2", null, "Numbers"), h("label", {class: "inline"}, "drawn against", xsel), h("span", {class: "grow"}),
        h("button", {onclick: exportPage}, "Export as a page")),
      charts, groups, system, details);

    function drawHead() {
      const git = d.meta.git || {}, job = d.job;
      put(head, 
        h("p", {class: "eyebrow"}, `${d.source.toUpperCase()} · ${d.sync.host || "this machine"}` + (d.synced ? ` · copied ${dur(Date.now() / 1000 - d.synced)} ago` : "")),
        h("div", {class: "row"}, h("h1", null, d.name), badge(d), d.why ? h("span", {class: d.state === "stalled" || d.state === "died" ? "note-warn" : "muted"}, d.why) : null),
        h("dl", {class: "kv"},
          h("dt", null, "progress"), h("dd", null, progress(d), d.lines ? ` · ${d.lines} lines logged` : ""),
          h("dt", null, "time"), h("dd", null, [dur(d.seconds), d.started ? "started " + when(d.started) : "", d.ended ? "ended " + when(d.ended) : ""].filter(Boolean).join(" · ")),
          job ? [h("dt", null, "job"), h("dd", null, `${job.id} · the scheduler says ${job.state} (${job.raw})` + (job.exit_code ? `, exit code ${job.exit_code}` : ""))] : null,
          h("dt", null, "code"), h("dd", null, git.commit
            ? [d.commit_url ? h("a", {href: d.commit_url, target: "_blank", rel: "noopener", class: "mono"}, git.commit.slice(0, 10)) : h("span", {class: "mono"}, git.commit.slice(0, 10)),
               git.branch ? ` on ${git.branch}` : "", git.dirty ? h("span", {class: "note-warn", style: "margin-left:10px"}, `with uncommitted changes to ${(git.changed_files || []).join(", ") || "tracked files"}`) : git.dirty === false ? " · clean" : ""]
            : h("span", {class: "muted"}, "no commit recorded (the code was not in a git checkout, or the run was written before commits were recorded)")),
          d.meta.command ? [h("dt", null, "command"), h("dd", null, h("pre", null, d.meta.command))] : null,
          (d.meta.restarts || []).length ? [h("dt", null, "restarts"), h("dd", null, d.meta.restarts.map(r => when(r.time) + (r.job_id ? ` (job ${r.job_id})` : "")).join(" · "))] : null));
    }

    function drawCharts() {
      const sc = schema(records), xs = xChoices(records);
      if (!xs.some(c => c[0] === x)) x = "step";
      put(xsel, xs.map(([v, label]) => h("option", {value: v, selected: v === x}, label)));
      const xLabel = xs.find(c => c[0] === x)[1];
      const one = (box, field, title) => lineChart(box, {title: title || field, xLabel, logY: logs[field], series: [{name: field, slot: 1, points: points(records, x, field)}],
        onLog: v => { logs[field] = v; keep.set("log", logs); one(box, field, title); }});
      const top = sc.numbers.filter(n => !n.includes(".") && n !== x);
      put(charts, top.length ? top.map(f => { const b = h("div"); queueMicrotask(() => one(b, f)); return b; })
        : [h("p", {class: "muted"}, records.length ? "This run logs no plain numbers." : "Nothing has been logged yet.")]);

      const scroll = [...groups.querySelectorAll(".timeline")].map(t => t.scrollTop);
      put(groups, [...sc.groups, ...sc.words].map(key => {
        const nums = sc.numbers.filter(n => n.startsWith(key + ".")), grid = h("div", {class: "grid"}), tl = h("div"), info = h("span", {class: "muted"});
        const rowsWith = records.filter(r => get(r, key) != null).length;
        const only = key in onlyChanges ? onlyChanges[key] : rowsWith > 60;
        const drawTl = () => { const n = timeline(tl, {records, key, find, onlyChanges: only}); info.textContent = `${n.shown} of ${n.rows} logging steps`; };
        queueMicrotask(() => { nums.forEach(f => { const b = h("div"); grid.append(b); one(b, f, f.slice(key.length + 1)); }); drawTl(); });
        return h("section", {class: "panel", "data-key": key},
          h("div", {class: "row"}, h("h2", {class: "mono"}, key), info, h("span", {class: "grow"}),
            toggle("only steps where the words changed", only, () => { onlyChanges[key] = !only; keep.set("onlyChanges", onlyChanges); drawCharts(); })),
          h("p", {class: "muted"}, "Read down to watch it form. A word in an outlined box was not in the row above; a number in colour changed from the row above."),
          tl, grid);
      }));
      queueMicrotask(() => [...groups.querySelectorAll(".timeline")].forEach((t, i) => (t.scrollTop = scroll[i] || 0)));

      /* GPU and memory underneath, on the same x: each sample is placed at the log line that was current when it was taken */
      if (sys.length) {
        const t0 = records.find(r => isNum(r._t))?._t ?? sys[0]._t;
        const timed = records.filter(r => isNum(r._t));
        const xOf = t => { if (x === "_t") return (t - t0) / 60; let lo = 0, hi = timed.length - 1; if (!timed.length || t < timed[0]._t) return null;
          while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (timed[mid]._t <= t) lo = mid; else hi = mid - 1; } return get(timed[lo], x); };
        const gpus = [...new Set(sys.flatMap(r => (r.gpu || []).map(g => g.index)))].sort();
        const of = pick => sys.map(r => [xOf(r._t), pick(r)]).filter(p => isNum(p[0])).map(p => [p[0], isNum(p[1]) ? p[1] : null]);
        const gpuSeries = key => gpus.map((g, i) => ({name: "GPU " + g, slot: gpus.length > 8 ? 0 : i + 1, points: of(r => (r.gpu || []).find(q => q.index === g)?.[key])}));
        const specs = [];
        if (gpus.length) specs.push(["GPU use (%)", gpuSeries("util")], ["GPU memory (MB)", gpuSeries("mem_mb")]);
        specs.push(["memory held by the process (MB)", [{name: "cpu_mem_mb", slot: 1, points: of(r => r.cpu_mem_mb)}]]);
        const grid = h("div", {class: "grid"});
        put(system, h("h2", null, "The machine, on the same axis"), grid);
        for (const [title, series] of specs) { const b = h("div"); grid.append(b); queueMicrotask(() => lineChart(b, {title, xLabel, series})); }
      } else put(system, );
      if (at != null && find) queueMicrotask(() => setTimeout(() => { const row = groups.querySelector(`tr[data-step="${CSS.escape(at)}"]`); if (row) row.scrollIntoView({block: "center"}); }, 60));
    }

    function drawDetails() {
      const set = Object.entries(flat(d.config));
      const notes = h("textarea", {style: "min-height:160px", placeholder: "Anything about this run. Kept in notes.md in the run's folder on this machine.", value: d.notes});
      const filesMsg = h("span", {class: "muted"});
      put(details, 
        h("section", {class: "panel"}, h("h2", null, "Settings"), h("div", {class: "scroll"}, h("table", null, h("tbody", null,
          set.map(([k, v]) => h("tr", null, h("td", {class: "mono"}, k), h("td", {class: "mono wrapc"}, typeof v === "object" ? JSON.stringify(v) : String(v)))))))),
        h("section", {class: "panel"}, h("h2", null, "Files the run saved"),
          d.files.length ? h("div", {class: "scroll"}, h("table", null,
            h("thead", null, h("tr", null, h("th", null, "file"), h("th", {class: "num"}, "size"), h("th", {class: "num"}, "step"), h("th", null, "checksum"), h("th", null, "on this machine"))),
            h("tbody", null, d.files.map(f => h("tr", null, h("td", {class: "mono"}, f.path), h("td", {class: "num"}, size(f.size)), h("td", {class: "num"}, fmt(f.step)),
              h("td", {class: "mono", title: f.sha256 || ""}, f.sha256 ? f.sha256.slice(0, 10) : h("span", {class: "muted"}, "none recorded")),
              h("td", null, f.here ? "yes" : h("button", {class: "small", onclick: async e => { e.target.disabled = true; filesMsg.textContent = `fetching ${f.path} (${size(f.size)})…`;
                try { const r = await api("/api/fetch", {id, path: f.path}); filesMsg.textContent = "saved to " + r.path; d = await api("/api/run?id=" + enc(id)); drawDetails(); }
                catch (err) { filesMsg.textContent = String(err.message); e.target.disabled = false; } }}, "Fetch")))))))
            : h("p", {class: "muted"}, "None listed."),
          h("p", {class: "muted"}, "Large files stay where the run wrote them. Only the list is copied; Fetch brings one here."), filesMsg,
          h("dl", {class: "kv"}, h("dt", null, "there"), h("dd", {class: "mono"}, d.sync.remote_path || ""), h("dt", null, "here"), h("dd", {class: "mono"}, d.folder))),
        h("section", {class: "panel"}, h("h2", null, "Notes"), notes,
          h("div", {class: "row"}, h("button", {onclick: async e => { await api("/api/notes", {id, text: notes.value}); e.target.textContent = "Saved"; setTimeout(() => (e.target.textContent = "Save notes"), 1500); }}, "Save notes"))));
    }

    async function exportPage() {
      const sc = schema(records);
      const file = prompt("Save the page as (a bare name goes into the export folder; or give a full path ending in .html)", d.name);
      if (!file) return;
      try {
        const r = await api("/api/export", {title: d.name, file, runs: [id], x, lede: d.note || "",
          charts: sc.numbers.filter(n => !n.includes(".") && n !== x).map(f => ({field: f, logY: logs[f]})), timelines: [...sc.groups, ...sc.words].map(key => ({run: id, key}))});
        alert("Saved to " + r.path);
      } catch (e) { alert(e.message); }
    }

    drawHead(); drawCharts(); drawDetails();
    every(5000, async () => {
      const [nd, more, ns] = await Promise.all([api("/api/run?id=" + enc(id)), api("/api/log?id=" + enc(id) + "&since=" + records.length), api("/api/system?id=" + enc(id))]);
      if (mine !== visit) return;
      const grew = more.records.length || ns.records.length !== sys.length;
      const filesChanged = JSON.stringify(nd.files) !== JSON.stringify(d.files);
      d = nd; records.push(...more.records); sys = ns.records;
      drawHead();
      if (grew) drawCharts();
      if (filesChanged && !details.contains(document.activeElement)) drawDetails();
    });
  }

  /* ---------- several runs together ---------- */
  async function compareView(ids) {
    const mine = visit;
    const all = (await api("/api/runs")).runs;
    const runs = ids.map(id => all.find(r => r.id === id)).filter(Boolean);
    if (!runs.length) return fail(new Error("None of those runs are here. Choose some in the list first."));
    const logsOf = await Promise.all(runs.map(r => api("/api/log?id=" + enc(r.id)).then(j => j.records)));
    if (mine !== visit) return;
    runs.forEach((r, i) => { r.records = logsOf[i]; r.slot = runs.length > 8 ? 0 : i + 1; });
    let x = keep.get("x", "step");
    const logs = keep.get("log", {}), ag = keep.get("against", {});
    const diff = differing(runs);
    const chartsBox = h("div", {class: "grid"}), againstBox = h("div"), againstCtl = h("div", {class: "row end"}), xsel = h("select", {"aria-label": "What the charts are drawn against", onchange: e => { x = e.target.value; keep.set("x", x); draw(); }});
    const dropped = id => "#/compare/" + runs.filter(r => r.id !== id).map(r => encodeURI(r.id)).join(",");

    put(view, 
      h("header", null, h("p", {class: "eyebrow"}, `${runs.length} RUNS TOGETHER`), h("h1", null, "Compare")),
      runs.length > 8 ? h("p", {class: "note-warn"}, "More than eight runs: there are not eight more colours that can be told apart, so every line is grey. Hover a chart to read which is which, or compare fewer.") : null,
      h("section", {class: "panel"}, h("h2", null, "Where the settings differ"), h("div", {class: "scroll"}, h("table", null,
        h("thead", null, h("tr", null, h("th", null, "run"), h("th", null, "state"), h("th", {class: "num"}, "step"), diff.map(k => h("th", {class: "num set"}, k)), h("th"))),
        h("tbody", null, runs.map(r => h("tr", null, h("td", null, h("i", {class: "swatch", style: `background:${colour(r.slot)}`}), runLink(r.id, r.name)),
          h("td", null, badge(r)), h("td", {class: "num"}, fmt(r.step)), diff.map(k => h("td", {class: "num"}, fmt(r.settings[k]))),
          h("td", null, runs.length > 1 ? h("a", {href: dropped(r.id), title: "take this run out of the comparison", "aria-label": "remove " + r.name}, "remove") : null))))),
        diff.length ? null : h("p", {class: "muted"}, "These runs were started with the same settings."))),
      h("section", {class: "panel"}, h("h2", null, "A final number against a setting"),
        h("p", {class: "muted"}, "For runs that vary one setting: one dot per run. This is the picture for choosing a value."), againstCtl, againstBox),
      h("div", {class: "row"}, h("h2", null, "The same number from each run"), h("label", {class: "inline"}, "drawn against", xsel), h("span", {class: "grow"}), h("button", {onclick: exportPage}, "Export as a page")),
      chartsBox);

    const fields = () => [...new Set(runs.flatMap(r => schema(r.records).numbers))];
    const pickValue = (r, metric, how) => { const vs = r.records.map(rec => get(rec, metric)).filter(isNum); if (!vs.length) return undefined; return how === "lowest" ? Math.min(...vs) : how === "highest" ? Math.max(...vs) : vs[vs.length - 1]; };

    function draw() {
      const xs = xChoices(runs[0].records).filter(c => runs.every(r => xChoices(r.records).some(d => d[0] === c[0])));
      if (!xs.some(c => c[0] === x)) x = "step";
      put(xsel, xs.map(([v, label]) => h("option", {value: v, selected: v === x}, label)));
      const xLabel = xs.find(c => c[0] === x)[1], fs = fields().filter(f => f !== x);
      put(chartsBox, fs.map(f => { const b = h("div"); queueMicrotask(() => one(b, f, xLabel)); return b; }));

      const numeric = [...new Set(runs.flatMap(r => Object.keys(r.settings)))].filter(k => runs.some(r => isNum(r.settings[k])));
      const varied = numeric.filter(k => diff.includes(k));
      const setting = varied.includes(ag.setting) || numeric.includes(ag.setting) ? ag.setting : (varied[0] || numeric[0]);
      const metric = fs.includes(ag.metric) ? ag.metric : (fs.find(f => !xs.some(c => c[0] === f)) || fs[0]);    // not rows or minutes by default
      const how = ag.how || "final";
      const change = (k, v) => { ag[k] = v; keep.set("against", ag); draw(); };
      const sel = (label, key, options, value) => h("label", null, label, h("select", {onchange: e => change(key, e.target.value)}, options.map(o => h("option", {value: o, selected: o === value}, o))));
      put(againstCtl, sel("setting", "setting", [...varied, ...numeric.filter(k => !varied.includes(k))], setting), sel("number", "metric", fs, metric),
        sel("which value", "how", ["final", "lowest", "highest"], how),
        toggle("log x", ag.logX, () => change("logX", !ag.logX), "log scale for the setting"), toggle("log y", ag.logY, () => change("logY", !ag.logY), "log scale for the number"));
      if (setting && metric) dotChart(againstBox, {title: `${how} ${metric} against ${setting}`, xLabel: setting, yLabel: metric, logX: ag.logX, logY: ag.logY,
        points: runs.map(r => ({x: r.settings[setting], y: pickValue(r, metric, how), name: r.name, slot: r.slot}))});
      else put(againstBox, h("p", {class: "muted"}, "These runs have no setting that is a number, or log no numbers."));
      draw.state = {setting, metric, how};
    }
    function one(box, f, xLabel) {
      lineChart(box, {title: f, xLabel, logY: logs[f], series: runs.map(r => ({name: r.name, slot: r.slot, points: points(r.records, x, f)})),
        onLog: v => { logs[f] = v; keep.set("log", logs); one(box, f, xLabel); }});
    }
    async function exportPage() {
      const file = prompt("Save the page as (a bare name goes into the export folder; or give a full path ending in .html)", "compare-" + runs.map(r => r.name).join("-").slice(0, 60));
      if (!file) return;
      const title = prompt("Title for the page", "Comparing " + runs.length + " runs") || "Runs";
      try {
        const st = draw.state;
        const r = await api("/api/export", {title, file, runs: runs.map(r => r.id), x, charts: fields().filter(f => f !== x).map(f => ({field: f, logY: logs[f]})),
          against: st.setting && st.metric ? {setting: st.setting, metric: st.metric, logX: !!ag.logX, logY: !!ag.logY} : null});
        alert("Saved to " + r.path);
      } catch (e) { alert(e.message); }
    }
    draw();
    every(8000, async () => {
      let grew = false;
      for (const r of runs) { const more = await api("/api/log?id=" + enc(r.id) + "&since=" + r.records.length); if (more.records.length) { r.records.push(...more.records); grew = true; } }
      if (mine === visit && grew) draw();
    });
  }

  /* ---------- search of the words in every run ---------- */
  async function searchView(q) {
    const mine = visit;
    document.getElementById("searchbox").value = q;
    put(view, h("p", {class: "muted"}, "Searching…"));
    const {results} = await api("/api/search?q=" + enc(q));
    if (mine !== visit) return;
    const lower = q.toLowerCase();
    const chip = w => { const lead = w.length - w.trimStart().length; return h("span", {class: "w" + (w.toLowerCase().includes(lower) ? " hit" : "")}, lead ? h("span", {class: "sp"}, "·".repeat(lead)) : null, w.slice(lead)); };
    put(view, 
      h("header", null, h("p", {class: "eyebrow"}, "SEARCH OF THE WORDS LOGGED IN EVERY RUN"), h("h1", null, `“${q}”`),
        h("p", {class: "lede"}, results.length ? "For each run and field: the first step at which it appears, then the steps around it." : "No run has logged that anywhere in a field of words.")),
      results.map(res => h("section", {class: "panel"}, h("h2", null, runLink(res.run)),
        res.fields.map(f => h("div", null,
          h("p", null, h("span", {class: "mono"}, f.field), " first at step ", h("b", null, runLink(res.run, fmt(f.first_step), `?find=${enc(q)}&at=${f.first_step}`)), h("span", {class: "muted"}, ` · in ${f.count} logging step${f.count === 1 ? "" : "s"}`)),
          h("div", {class: "timeline", style: "max-height:190px"}, h("table", null, h("tbody", null, f.hits.slice(0, 40).map(hit =>
            h("tr", null, h("td", {class: "num"}, runLink(res.run, fmt(hit.step), `?find=${enc(q)}&at=${hit.step}`)), h("td", {class: "words"}, (Array.isArray(hit.value) ? hit.value : [hit.value]).map(chip))))))))))));
  }

  function route(reset = true) {
    visit++; clearInterval(timer);
    const [path, qs] = decodeURI(location.hash.replace(/^#\/?/, "")).split("?");
    const [kind, ...rest] = path.split("/"), arg = rest.join("/");
    if (reset) window.scrollTo(0, 0);
    const go = kind === "run" && arg ? runView(arg, new URLSearchParams(qs || "")) : kind === "compare" && arg ? compareView(arg.split(",").filter(Boolean))
      : kind === "search" && arg ? searchView(decodeURIComponent(arg)) : listView();
    go.catch(fail);
  }
  window.addEventListener("hashchange", () => route());
  route();
})();
