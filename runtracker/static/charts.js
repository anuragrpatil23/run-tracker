/* Drawing: line charts, a dot chart, and the timeline of words. Used by the viewer and, pasted in
   whole, by exported pages, so it depends on nothing but the browser.

   A log line is a nested object. flat() turns it into dotted names ("sky.fired"); a field is then
   drawn by its type: numbers as lines against the chosen x, lists of words as a timeline. */
const RT = (() => {
  const NS = "http://www.w3.org/2000/svg";
  const isNum = v => typeof v === "number" && isFinite(v);
  const isWords = v => Array.isArray(v) && v.length > 0 && v.every(x => typeof x === "string");

  /* h("div", {class: "a", onclick: f}, child, "text") - text always goes in as text, never as markup */
  function h(tag, props, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v == null || v === false) continue;
      if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
      else if (k === "class") e.className = v;
      else if (k === "value") e.value = v;
      else if (k === "checked" || k === "disabled" || k === "selected") e[k] = !!v;
      else e.setAttribute(k, v === true ? "" : v);
    }
    for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false) e.append(kid.nodeType ? kid : String(kid));
    return e;
  }
  function s(tag, attrs, text) {
    const e = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs || {})) e.setAttribute(k, v);
    if (text != null) e.textContent = text;
    return e;
  }

  function flat(obj, prefix = "", out = {}) {
    for (const [k, v] of Object.entries(obj || {})) {
      if (v && typeof v === "object" && !Array.isArray(v)) flat(v, prefix + k + ".", out);
      else out[prefix + k] = v;
    }
    return out;
  }
  const get = (rec, path) => path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), rec);

  /* tick() is the short form for an axis (48.8k); fmt() is the number itself, for tables and readouts. */
  function tick(v) {
    if (!isNum(v)) return v == null ? "" : String(v);
    const a = Math.abs(v);
    if (a === 0) return "0";
    if (a >= 1e9) return trim(v / 1e9, 2) + "B";
    if (a >= 1e6) return trim(v / 1e6, 2) + "M";
    if (a >= 1e4) return trim(v / 1e3, 1) + "k";
    if (a >= 1e-4) return String(+v.toPrecision(3));
    return v.toExponential(1);
  }
  function fmt(v) {
    if (!isNum(v)) return v == null ? "" : String(v);
    if (Number.isInteger(v)) return Math.abs(v) >= 1e15 ? v.toExponential(3) : v.toLocaleString("en-US");
    const a = Math.abs(v);
    if (a >= 1e4) return v.toLocaleString("en-US", {maximumFractionDigits: 1});
    if (a >= 1e-4) return String(+v.toPrecision(5));
    return v.toExponential(3);
  }
  const trim = (v, d) => String(+v.toFixed(d));
  const colour = slot => (slot >= 1 && slot <= 8 ? `var(--s${slot})` : "var(--muted)");

  /* [x, y] pairs for one field of a run. x "_t" is minutes since the first line. y is null where the
     line has no number there, which breaks the drawn line instead of bridging the gap. */
  function points(records, xKey, yKey) {
    const t0 = records.length ? records.find(r => isNum(r._t))?._t : 0;
    const out = [];
    for (const r of records) {
      let x = xKey === "_t" ? (isNum(r._t) ? (r._t - t0) / 60 : null) : get(r, xKey);
      if (!isNum(x)) continue;
      const y = get(r, yKey);
      out.push([x, isNum(y) ? y : null]);
    }
    return out;
  }

  function niceTicks(lo, hi, n) {
    if (!(hi > lo)) { const pad = Math.abs(lo) * 0.1 || 1; lo -= pad; hi += pad; }
    const raw = (hi - lo) / Math.max(1, n), mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(m => m >= raw);
    const out = [];
    for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) out.push(+v.toPrecision(12));
    return out;
  }
  function logTicks(lo, hi) {
    const out = [], a = Math.floor(Math.log10(lo)), b = Math.ceil(Math.log10(hi));
    const subs = b - a <= 2 ? [1, 2, 5] : [1];
    for (let e = a; e <= b; e++) for (const m of subs) { const v = m * Math.pow(10, e); if (v >= lo * 0.999 && v <= hi * 1.001) out.push(v); }
    return out.length >= 2 ? out : [lo, hi];
  }
  function scale(lo, hi, a, b, log) {
    if (log) { const l0 = Math.log10(lo), l1 = Math.log10(hi) - l0 || 1; return v => a + (Math.log10(v) - l0) / l1 * (b - a); }
    const d = hi - lo || 1;
    return v => a + (v - lo) / d * (b - a);
  }
  /* Keep the lowest and highest point of each pixel column, so a long run draws quickly and keeps its spikes. */
  function thin(pts, px, width) {
    if (pts.length <= width * 3) return pts;
    const out = []; let col = null, lo = null, hi = null;
    const flush = () => { if (lo) { if (lo === hi) out.push(lo); else out.push(...(lo[0] <= hi[0] ? [lo, hi] : [hi, lo])); } };
    for (const p of pts) {
      if (p[1] == null) { flush(); out.push(p); col = lo = hi = null; continue; }
      const c = Math.round(px(p[0]));
      if (c !== col) { flush(); col = c; lo = hi = p; }
      else { if (p[1] < lo[1]) lo = p; if (p[1] > hi[1]) hi = p; }
    }
    flush();
    return out;
  }

  function frame(host, opt) {
    host.replaceChildren();
    const fig = h("figure", {class: "chart"});
    const cap = h("figcaption", null, h("span", {class: "t", title: opt.title || ""}, opt.title || ""));
    fig.append(cap);
    host.append(fig);
    return {fig, cap};
  }
  function legend(fig, items) {
    if (items.length < 2) return;                         // one series is named by the title
    fig.append(h("div", {class: "legend"}, items.map(it =>
      h("span", null, h("i", {class: "swatch", style: `background:${colour(it.slot)}`}), it.name))));
  }
  function tipAt(fig, tip, px, py) {
    tip.hidden = false;
    const w = tip.offsetWidth, W = fig.clientWidth;
    tip.style.left = Math.max(4, Math.min(W - w - 4, px + 14 + w > W ? px - w - 14 : px + 14)) + "px";
    tip.style.top = Math.max(4, py) + "px";
  }

  /* A number that is always above zero and falls or climbs a hundredfold is a flat line with one spike on a
     plain scale, which is what a loss looks like from step 0. Such a number starts on a log scale. */
  function wantsLog(series) {
    let lo = Infinity, hi = -Infinity;
    for (const sr of series) for (const p of sr.points) if (p[1] != null) { if (p[1] < lo) lo = p[1]; if (p[1] > hi) hi = p[1]; }
    return lo > 0 && hi / lo >= 100;
  }

  /* opt: {title, series: [{name, slot, points}], xLabel, logY, logX, height, onLog(bool)} */
  function lineChart(host, opt) {
    if (opt.logY == null) opt.logY = wantsLog(opt.series);   // unless the reader has chosen, pick the scale that shows the shape
    const {fig, cap} = frame(host, opt);
    let showTable = false;
    if (opt.onLog) cap.append(h("button", {class: "small", "aria-pressed": String(!!opt.logY), title: "log scale on the y axis",
      onclick: () => opt.onLog(!opt.logY)}, "log"));
    const tableBtn = h("button", {class: "small", "aria-pressed": "false", title: "show the numbers as a table",
      onclick: () => { showTable = !showTable; tableBtn.setAttribute("aria-pressed", String(showTable)); draw(); }}, "table");
    cap.append(tableBtn);
    const body = h("div"), tip = h("div", {class: "tip", hidden: true});
    fig.append(body, tip);
    legend(fig, opt.series);

    function draw() {
      body.replaceChildren(); tip.hidden = true;
      const series = opt.series.map(sr => ({...sr, pts: sr.points.filter(p => !opt.logX || p[0] > 0)
        .map(p => (opt.logY && p[1] != null && p[1] <= 0 ? [p[0], null] : p))}));
      const all = series.flatMap(sr => sr.pts.filter(p => p[1] != null));
      if (!all.length) { body.append(h("div", {class: "empty"}, opt.logY ? "nothing above zero to draw on a log scale" : "no numbers yet")); return; }
      if (showTable) return table(series);
      const W = Math.max(260, body.clientWidth || host.clientWidth || 520), H = opt.height || 210;
      const labelled = series.length >= 2 && series.length <= 4;
      const short = n => (n.length > 22 ? n.slice(0, 21) + "…" : n);
      const m = {l: 50, r: labelled ? Math.min(150, 12 + 6.2 * Math.max(...series.map(sr => short(sr.name).length))) : 12, t: 8, b: opt.xLabel ? 36 : 22};
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      for (const [x, y] of all) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
      if (!opt.logY) { const pad = (y1 - y0) * 0.06 || Math.abs(y1) * 0.1 || 1; y1 += pad; y0 = y0 >= 0 && y0 - pad < 0 ? 0 : y0 - pad; }
      else if (y0 === y1) { y0 /= 2; y1 *= 2; }
      if (x0 === x1) { x0 -= 1; x1 += 1; }
      const yt = opt.logY ? logTicks(y0, y1) : niceTicks(y0, y1, 4), xt = opt.logX ? logTicks(x0, x1) : niceTicks(x0, x1, Math.max(2, Math.floor((W - m.l - m.r) / 90)));
      if (opt.logY) { y0 = Math.min(y0, yt[0]); y1 = Math.max(y1, yt[yt.length - 1]); }
      const px = scale(x0, x1, m.l, W - m.r, opt.logX), py = scale(y0, y1, H - m.b, m.t, opt.logY);
      const svg = s("svg", {viewBox: `0 0 ${W} ${H}`, height: H, role: "img", "aria-label": (opt.title || "chart") + " against " + (opt.xLabel || "x")});
      const axis = s("g", {class: "axis"});
      for (const v of yt) {
        if (v < y0 || v > y1) continue;
        axis.append(s("line", {class: "gridline", x1: m.l, x2: W - m.r, y1: py(v), y2: py(v)}));
        axis.append(s("text", {x: m.l - 6, y: py(v) + 3.5, "text-anchor": "end"}, tick(v)));
      }
      for (const v of xt) if (v >= x0 && v <= x1) axis.append(s("text", {x: px(v), y: H - m.b + 14, "text-anchor": "middle"}, tick(v)));
      axis.append(s("line", {class: "base", x1: m.l, x2: W - m.r, y1: H - m.b, y2: H - m.b}));
      if (opt.xLabel) axis.append(s("text", {x: (m.l + W - m.r) / 2, y: H - 4, "text-anchor": "middle"}, opt.xLabel));
      svg.append(axis);
      const ends = [];
      for (const sr of series) {
        let d = "", pen = false, last = null;
        for (const [x, y] of thin(sr.pts, px, W)) {
          if (y == null) { pen = false; continue; }
          d += (pen ? "L" : "M") + px(x).toFixed(1) + " " + py(y).toFixed(1); pen = true; last = [x, y];
        }
        svg.append(s("path", {class: "line", d, stroke: colour(sr.slot)}));
        if (sr.pts.filter(p => p[1] != null).length === 1 && last) svg.append(s("circle", {class: "dot", cx: px(last[0]), cy: py(last[1]), r: 4, fill: colour(sr.slot)}));
        if (last) ends.push({name: sr.name, y: py(last[1])});
      }
      if (labelled) {                                      // name each line at its end, nudged apart where they meet
        ends.sort((a, b) => a.y - b.y);
        for (let i = 1; i < ends.length; i++) if (ends[i].y - ends[i - 1].y < 12) ends[i].y = ends[i - 1].y + 12;
        const over = ends.length ? ends[ends.length - 1].y - (H - m.b) : 0;
        if (over > 0) for (const e of ends) e.y -= over;            // keep the stack of names above the axis
        for (const e of ends) svg.append(s("text", {class: "endlabel", x: W - m.r + 6, y: e.y + 3.5}, short(e.name)));
      }
      const hair = s("line", {class: "hair", y1: m.t, y2: H - m.b, visibility: "hidden"}), dots = s("g");
      svg.append(hair, dots);
      body.append(svg);

      const xs = [...new Set(all.map(p => p[0]))].sort((a, b) => a - b);
      function show(clientX) {
        const box = svg.getBoundingClientRect(), mx = (clientX - box.left) * (W / box.width);
        let lo = 0, hi = xs.length - 1;
        while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (px(xs[mid]) < mx) lo = mid; else hi = mid; }
        const x = Math.abs(px(xs[lo]) - mx) <= Math.abs(px(xs[hi]) - mx) ? xs[lo] : xs[hi];
        hair.setAttribute("x1", px(x)); hair.setAttribute("x2", px(x)); hair.setAttribute("visibility", "visible");
        dots.replaceChildren();
        const rows = [];
        for (const sr of series) {
          let best = null;
          for (const p of sr.pts) if (p[1] != null && (best == null || Math.abs(p[0] - x) < Math.abs(best[0] - x))) best = p;
          if (!best || Math.abs(px(best[0]) - px(x)) > 12) continue;
          dots.append(s("circle", {class: "dot", cx: px(best[0]), cy: py(best[1]), r: 4, fill: colour(sr.slot)}));
          rows.push(h("div", {class: "r"}, h("i", {class: "swatch", style: `background:${colour(sr.slot)}`}), h("b", null, fmt(best[1])), h("span", null, sr.name)));
        }
        tip.replaceChildren(h("div", {class: "x"}, (opt.xLabel || "x") + " " + fmt(x)), ...rows);
        tipAt(fig, tip, px(x) * (box.width / W) + svg.offsetLeft, svg.offsetTop + m.t);
      }
      svg.addEventListener("pointermove", e => show(e.clientX));
      svg.addEventListener("pointerdown", e => show(e.clientX));
      svg.addEventListener("pointerleave", () => { hair.setAttribute("visibility", "hidden"); dots.replaceChildren(); tip.hidden = true; });
    }
    function table(series) {
      const xs = [...new Set(series.flatMap(sr => sr.pts.map(p => p[0])))].sort((a, b) => a - b);
      const stepBy = Math.ceil(xs.length / 200), maps = series.map(sr => new Map(sr.pts));
      const t = h("table", null, h("thead", null, h("tr", null, h("th", {class: "num"}, opt.xLabel || "x"), series.map(sr => h("th", {class: "num"}, sr.name)))));
      const tb = h("tbody");
      xs.forEach((x, i) => { if (i % stepBy === 0 || i === xs.length - 1) tb.append(h("tr", null, h("td", {class: "num"}, fmt(x)), maps.map(mp => h("td", {class: "num"}, fmt(mp.get(x)))))); });
      t.append(tb);
      body.append(h("div", {class: "datatable"}, t));
    }
    draw();
    if (typeof ResizeObserver !== "undefined") {
      let w = host.clientWidth;
      new ResizeObserver(() => { if (Math.abs(host.clientWidth - w) > 8) { w = host.clientWidth; draw(); } }).observe(host);
    }
  }

  /* One dot per run: a final number against a setting. opt: {title, points: [{x, y, name, slot}], xLabel, yLabel, logX, logY, height} */
  function dotChart(host, opt) {
    const {fig} = frame(host, opt);
    const pts = opt.points.filter(p => isNum(p.x) && isNum(p.y) && (!opt.logX || p.x > 0) && (!opt.logY || p.y > 0)).sort((a, b) => a.x - b.x);
    if (!pts.length) { fig.append(h("div", {class: "empty"}, "no run has both a number for the setting and a number for the result")); return; }
    const short = n => (n.length > 24 ? n.slice(0, 23) + "…" : n);
    const W = Math.max(300, host.clientWidth || 640), H = opt.height || 300, m = {l: 58, r: Math.min(180, 24 + 6.2 * Math.max(...pts.map(p => short(p.name).length))), t: 12, b: 38};
    let x0 = Math.min(...pts.map(p => p.x)), x1 = Math.max(...pts.map(p => p.x)), y0 = Math.min(...pts.map(p => p.y)), y1 = Math.max(...pts.map(p => p.y));
    if (x0 === x1) { if (opt.logX) { x0 /= 2; x1 *= 2; } else { x0 -= 1; x1 += 1; } }
    if (opt.logY) { if (y0 === y1) { y0 /= 2; y1 *= 2; } } else { const pad = (y1 - y0) * 0.1 || Math.abs(y1) * 0.1 || 1; y0 -= pad; y1 += pad; }
    if (opt.logX) { x0 /= 1.25; x1 *= 1.25; } else { const pad = (x1 - x0) * 0.06; x0 -= pad; x1 += pad; }
    const xt = opt.logX ? logTicks(x0, x1) : niceTicks(x0, x1, 5), yt = opt.logY ? logTicks(y0, y1) : niceTicks(y0, y1, 5);
    const px = scale(x0, x1, m.l, W - m.r, opt.logX), py = scale(y0, y1, H - m.b, m.t, opt.logY);
    const svg = s("svg", {viewBox: `0 0 ${W} ${H}`, height: H, role: "img", "aria-label": opt.title || "chart"});
    const axis = s("g", {class: "axis"});
    for (const v of yt) if (v >= y0 && v <= y1) { axis.append(s("line", {class: "gridline", x1: m.l, x2: W - m.r, y1: py(v), y2: py(v)})); axis.append(s("text", {x: m.l - 6, y: py(v) + 3.5, "text-anchor": "end"}, tick(v))); }
    for (const v of xt) if (v >= x0 && v <= x1) axis.append(s("text", {x: px(v), y: H - m.b + 14, "text-anchor": "middle"}, tick(v)));
    axis.append(s("line", {class: "base", x1: m.l, x2: W - m.r, y1: H - m.b, y2: H - m.b}));
    axis.append(s("text", {x: (m.l + W - m.r) / 2, y: H - 5, "text-anchor": "middle"}, opt.xLabel || ""));
    axis.append(s("text", {x: 12, y: (m.t + H - m.b) / 2, "text-anchor": "middle", transform: `rotate(-90 12 ${(m.t + H - m.b) / 2})`}, opt.yLabel || ""));
    svg.append(axis);
    svg.append(s("path", {d: pts.map((p, i) => (i ? "L" : "M") + px(p.x).toFixed(1) + " " + py(p.y).toFixed(1)).join(""), fill: "none", stroke: "var(--rule)", "stroke-width": 1.5}));
    const tip = h("div", {class: "tip", hidden: true});
    let lastY = -99;
    for (const p of pts) {
      const c = s("circle", {class: "dot", cx: px(p.x), cy: py(p.y), r: 5.5, fill: colour(p.slot), tabindex: 0});
      const hit = s("circle", {cx: px(p.x), cy: py(p.y), r: 14, fill: "transparent"});
      const on = () => { tip.replaceChildren(h("div", {class: "x"}, p.name), h("div", {class: "r"}, h("b", null, fmt(p.y)), h("span", null, opt.yLabel || "")), h("div", {class: "r"}, h("b", null, fmt(p.x)), h("span", null, opt.xLabel || ""))); tipAt(fig, tip, px(p.x) * (svg.getBoundingClientRect().width / W), svg.offsetTop + py(p.y) - 10); };
      for (const e of [c, hit]) { e.addEventListener("pointerenter", on); e.addEventListener("focus", on); e.addEventListener("pointerleave", () => (tip.hidden = true)); e.addEventListener("blur", () => (tip.hidden = true)); }
      svg.append(c, hit);
      if (pts.length <= 8) {
        const ly = Math.abs(py(p.y) - lastY) < 12 ? lastY + 12 : py(p.y); lastY = ly;
        svg.append(s("text", {class: "endlabel", x: px(p.x) + 9, y: ly + 3.5}, short(p.name)));
      }
    }
    fig.append(svg, tip);
    legend(fig, pts.map(p => ({name: `${p.name}  (${opt.xLabel} ${fmt(p.x)} → ${fmt(p.y)})`, slot: p.slot})));
  }

  function word(w, isNew, find) {
    const lead = w.length - w.trimStart().length;
    const e = h("span", {class: "w" + (isNew ? " new" : "") + (find && w.toLowerCase().includes(find) ? " hit" : "")});
    if (lead) e.append(h("span", {class: "sp"}, "·".repeat(lead)));
    e.append(w.slice(lead).replace(/\n/g, "↵") || (lead ? "" : "∅"));
    return e;
  }

  /* One row per logging step for a field that is not a number. If the field is an object, its numbers and
     short strings become columns beside its lists of words. A word in an outlined box was not in the
     row above; a value in the accent colour changed from the row above.
     opt: {records, key, find, onlyChanges} */
  function timeline(host, opt) {
    const rows = [];
    for (const r of opt.records) {
      const v = get(r, opt.key);
      if (v == null) continue;
      rows.push({step: r.step, cells: v && typeof v === "object" && !Array.isArray(v) ? flat(v) : {[opt.key.split(".").pop()]: v}});
    }
    const cols = [...new Set(rows.flatMap(r => Object.keys(r.cells)))];
    const wordCols = cols.filter(c => rows.some(r => isWords(r.cells[c]) || typeof r.cells[c] === "string"));
    /* A whole number that seldom changes is a name for something (which feature), so its changes are worth marking;
       one that changes on most rows is a measurement, and marking it would mark everything. */
    const names = new Set(cols.filter(c => !wordCols.includes(c) && rows.every(r => r.cells[c] == null || Number.isInteger(r.cells[c]))
      && rows.filter((r, i) => i && r.cells[c] !== rows[i - 1].cells[c]).length < Math.max(2, rows.length * 0.3)));
    const find = (opt.find || "").toLowerCase();
    const sig = r => JSON.stringify(wordCols.map(c => r.cells[c]));
    let shown = rows.map((r, i) => ({...r, prev: rows[i - 1]}));
    if (opt.onlyChanges) shown = shown.filter(r => !r.prev || sig(r) !== sig(r.prev));
    const tb = h("tbody");
    for (const r of shown) {
      const tr = h("tr", {"data-step": r.step}, h("td", {class: "num"}, fmt(r.step)));
      for (const c of cols) {
        const v = r.cells[c], before = r.prev ? r.prev.cells[c] : undefined;
        if (isWords(v) || (typeof v === "string" && wordCols.includes(c))) {
          const list = isWords(v) ? v : [v], old = new Set(isWords(before) ? before : before == null ? [] : [before]);
          tr.append(h("td", {class: "words"}, list.map(w => word(w, r.prev && !old.has(w), find))));
        } else {
          const changed = r.prev && names.has(c) && before !== v;
          tr.append(h("td", {class: "num" + (changed ? " changed" : "")}, Array.isArray(v) ? JSON.stringify(v) : fmt(v)));
        }
      }
      tb.append(tr);
    }
    host.replaceChildren(h("div", {class: "timeline"}, h("table", null,
      h("thead", null, h("tr", null, h("th", {class: "num"}, "step"), cols.map(c => h("th", {class: wordCols.includes(c) ? "" : "num"}, c)))), tb)));
    return {rows: rows.length, shown: shown.length};
  }

  /* What kinds of field a run's log holds: which names are numbers, which are nested objects or words. */
  function schema(records) {
    const numbers = new Set(), groups = new Set(), words = new Set();
    const sample = records.length > 400 ? records.filter((_, i) => i % Math.ceil(records.length / 400) === 0).concat(records.slice(-1)) : records;
    for (const r of sample) {
      for (const [k, v] of Object.entries(r)) {
        if (k.startsWith("_") || k === "step") continue;
        if (isNum(v)) numbers.add(k);
        else if (v && typeof v === "object" && !Array.isArray(v)) { groups.add(k); for (const [kk, vv] of Object.entries(flat(v, k + "."))) if (isNum(vv)) numbers.add(kk); }
        else if (isWords(v) || (typeof v === "string" && !["NaN", "Infinity", "-Infinity"].includes(v))) words.add(k);
      }
    }
    return {numbers: [...numbers], groups: [...groups], words: [...words]};
  }
  /* Fields that only ever go up can serve as the x axis: step, rows seen, minutes. */
  function xChoices(records) {
    const out = [["step", "step"]];
    if (!records.length) return out;
    for (const k of Object.keys(records[0])) {
      if (k === "step" || k.startsWith("_") || !isNum(records[0][k])) continue;
      let ok = true, prev = -Infinity;
      for (const r of records) { const v = r[k]; if (!isNum(v) || v < prev) { ok = false; break; } prev = v; }
      if (ok && records.length > 1 && records[records.length - 1][k] > records[0][k]) out.push([k, k]);
    }
    if (records.some(r => isNum(r._t))) out.push(["_t", "time (minutes)"]);
    return out;
  }

  /* The settings in which a set of runs differ, leaving out those that only repeat the run's own name (its output folder). */
  function differing(runs) {
    const has = k => runs.filter(r => r.settings && r.settings[k] !== undefined);
    return [...new Set(runs.flatMap(r => Object.keys(r.settings || {})))]
      .filter(k => runs.length === 1 || new Set(has(k).map(r => JSON.stringify(r.settings[k]))).size > 1)
      .filter(k => runs.length === 1 || !has(k).every(r => typeof r.settings[k] === "string" && r.settings[k].includes(r.name)));
  }

  return {h, flat, get, fmt, isNum, isWords, colour, points, lineChart, dotChart, timeline, schema, xChoices, differing};
})();
