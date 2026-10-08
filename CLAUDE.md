# CLAUDE.md — run-tracker

A tracker for training runs that are written to files on a cluster and looked at from the laptop.
Read `README.md` for what it does and `docs/format.md` for the run folder, which is the contract
between the three parts.

## Layout

- `tracker.py` — the writer. One file, standard library only, must run on Python 3.8+ (the cluster).
  It must never be able to stop a training run: every write is wrapped and only warns.
- `runtracker/store.py` — reads copied run folders; works out a run's state.
- `runtracker/wandbfile.py` — reads the run file the W&B client writes offline, standard library only.
  A run folder is either the tracker's own files or one `run-<id>.wandb`; `store.log_of`, `system_of`,
  `meta_of`, `config_of` and `status_of` are the only places that know which. Go through them.
- `runtracker/sync.py` — copies from sources over ssh (batch mode, never prompts) or from local folders.
- `runtracker/server.py` — the viewer's server, 127.0.0.1 only. `runtracker/export.py` — self-contained pages.
- `runtracker/index.py` — the SQLite index the viewer's `/api/v2/` routes read from. Disposable: rebuilt
  from the run folders, bump `VERSION` when its tables change.
- `runtracker/derived.py` — charts worked out by formula from what was logged (`derived.json` in the data
  folder). Formulas are parsed as arithmetic only; keep it that way.
- `web/` — the viewer (TypeScript, React, uPlot, Vite). `npm run build` writes `runtracker/static/app/`,
  which is committed so that installing needs no Node. Rebuild and commit it with any change under `web/`.
- `web/src/app.css` is the app's whole stylesheet and says what the design is: colour only for data and run
  state, charts unboxed, Instrument Sans, monospace only for real code. Charts are meant to be rich in what
  they can do (linked zoom, inspector, bands) while carrying little ink that is not data.
- `runtracker/static/` — `style.css` styles exported pages and the classic viewer. `charts.js` and `export.js`
  draw exported pages and must depend on nothing but the browser. `app.js`/`index.html` are the earlier
  plain viewer, served at `/classic`.
- The home page has no sidebar: a strip of run chips stays in view as the legend, the full list is behind
  "Choose runs", and charts sit in sections with a table of contents down the left. Each section and chart carries a sentence saying what it shows
  (from `run.describe` in the writer, or typed in the viewer and kept in `about.json` in the data folder).
- Projects are the top level. A run's project is the W&B project, the tracker's `project`, or its source.
  Descriptions and formulas live in `<data>/projects/<project>/`; what a reader sets up in the browser is
  remembered per project (`useStored` in `web/src/lib.ts`). Nothing in the code may assume one kind of
  model: test changes against the ordinary supervised runs too (train/val loss, accuracy, lr, epochs).
- Scan: `runtracker/scan.py` keeps a scanner's address per project and passes requests on; `web/src/Scan.tsx`
  is the view. The contract is `docs/scan.md`, agreed with the session that owns the scanner in Learn-AI; change
  it there first. The view must not assume a kind of model: check it against `tests/toy_scanner.py` as well as
  the real scanner.
- `scankit/` — a separate package (`run-tracker-scankit`, imported as `scankit`) that scanners are written on.
  It may use NumPy; nothing under `runtracker/` or `tracker.py` may import it or NumPy. `tests/toy_scanner.py`
  stays in the standard library so the tracker's own tests need nothing; `scankit/examples/toy.py` is the
  same network written on the kit.
- `web/src/Bars3D.tsx` is the network in three dimensions (three.js, loaded only when shown). It needs WebGL:
  `web/scripts/drive.mjs` starts Chrome with software 3D for that, and the view falls back to the flat drawing
  where there is none. Steps are placed by the scanner's `lane` and `order`; the view lays nothing out itself.
- `claude-workspace/` — working notes for this project.

## Rules

- No dependencies in Python: not in the writer, not in the sync, the index or the server. The viewer in
  `web/` may use npm packages; keep them few.
- The app is shown as "Train Run Tracker". It reads W&B's files but is not theirs: never use their name
  or logo as its own, and never copy their web app.
- The format is append-only and tolerant: a folder from before the writer existed must still sync and show.
- Minerva: read before changing anything, use the existing `ssh minerva` shared connection, and ask
  before any change on the cluster. The tool itself only ever reads there.
- Two files are vendored in `Learn-AI/train-sparse-autoencoder/`: `tracker.py`, and `scankit.py` (from
  `scankit/scankit.py`). After changing either here, copy it across; after changing the kit, also tell the session
  that owns the scanner so it can rerun its comparison against `scan_fixtures/`.
- Dialogs in the app go through `Modal` (a portal to the page). One rendered inside a sticky or positioned
  element ends up underneath its neighbours and cannot be clicked.
- Series colours in `style.css` (`--s1`..`--s8`) are a checked set in a fixed order; do not reorder or add a ninth.

## Checking a change

    python3 -m unittest discover tests
    (cd web && npm run build)          # type-checks, then builds
    rt view --port 8791 --no-open      # then look at it in a browser

To click through the app without a person: `node web/scripts/drive.mjs <url> <screenshot-prefix>` drives
headless Chrome and reads steps from stdin (`page.clickText`, `page.drag`, `page.js`, `page.shot`), then
prints any page errors. Screenshots taken with Chrome's `--screenshot` flag alone come out with blank
charts; use this instead.
