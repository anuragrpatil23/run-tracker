/* The whole of an exported page: reads the data written into the file and draws it with charts.js. */
(() => {
  const {h, fmt, points, lineChart, dotChart, timeline, get, isNum} = RT;
  const D = JSON.parse(document.getElementById("data").textContent);
  const page = document.getElementById("page");
  const xLabel = D.x === "_t" ? "minutes" : D.x;
  const slot = i => (D.runs.length > 8 ? 0 : i + 1);

  page.append(h("header", null,
    h("p", {class: "eyebrow"}, `RUN TRACKER · ${D.made} · ${D.runs.length} run${D.runs.length === 1 ? "" : "s"}`),
    h("h1", null, D.title), D.lede ? h("p", {class: "lede"}, D.lede) : null));

  /* the runs, and the settings in which they differ */
  const keys = RT.differing(D.runs);
  page.append(h("section", {class: "panel"}, h("h2", null, D.runs.length === 1 ? "The run" : "The runs, and where their settings differ"),
    h("div", {class: "scroll"}, h("table", null,
      h("thead", null, h("tr", null, h("th", null, "run"), h("th", null, "state"), h("th", {class: "num"}, "last step"), h("th", null, "code"), keys.map(k => h("th", {class: "num set"}, k)))),
      h("tbody", null, D.runs.map((r, i) => h("tr", null,
        h("td", null, h("i", {class: "swatch", style: `background:${RT.colour(slot(i))}`}), r.name),
        h("td", null, r.state), h("td", {class: "num"}, fmt(r.step)),
        h("td", {class: "mono"}, r.commit ? (r.commit_url ? h("a", {href: r.commit_url}, r.commit.slice(0, 7)) : r.commit.slice(0, 7)) : ""),
        keys.map(k => h("td", {class: "num"}, fmt(r.settings[k]))))))))));

  for (const r of D.runs) {
    if (!r.prediction && !r.outcome) continue;
    page.append(h("section", {class: "panel"}, h("h2", null, D.runs.length === 1 ? "Expected, and what happened" : r.name + ": expected, and what happened"),
      h("div", {class: "two"}, h("div", null, h("h3", null, "Before the run"), h("p", null, r.prediction || "nothing written")),
        h("div", null, h("h3", null, "After"), h("p", null, r.outcome || "nothing written yet")))));
  }

  if (D.against) {
    const box = h("div");
    page.append(box);
    const last = r => { for (let i = r.records.length - 1; i >= 0; i--) { const v = get(r.records[i], D.against.metric); if (isNum(v)) return v; } };
    dotChart(box, {title: `final ${D.against.metric} against ${D.against.setting}`, xLabel: D.against.setting, yLabel: D.against.metric,
      logX: D.against.logX, logY: D.against.logY, points: D.runs.map((r, i) => ({x: r.settings[D.against.setting], y: last(r), name: r.name, slot: slot(i)}))});
  }

  if (D.charts.length) {
    const grid = h("div", {class: "grid"});
    page.append(grid);
    for (const c of D.charts) {
      const box = h("div"); grid.append(box);
      const draw = () => lineChart(box, {title: c.field, xLabel, logY: c.logY, onLog: v => { c.logY = v; draw(); },
        series: D.runs.map((r, i) => ({name: r.name, slot: slot(i), points: points(r.records, D.x, c.field)}))});
      draw();
    }
  }

  for (const t of D.timelines) {
    const r = D.runs.find(r => r.id === t.run);
    if (!r) continue;
    const box = h("div");
    page.append(h("section", {class: "panel"}, h("h2", null, `${t.key}, step by step` + (D.runs.length > 1 ? ` (${r.name})` : "")),
      h("p", {class: "muted"}, "One row per logging step where something changed. A word in an outlined box was not in the row above."), box));
    timeline(box, {records: r.records, key: t.key, onlyChanges: true});
  }
})();
