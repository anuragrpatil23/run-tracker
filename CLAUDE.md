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
- `web/` — the viewer (TypeScript, React, uPlot, Vite). `npm run build` writes `runtracker/static/app/`,
  which is committed so that installing needs no Node. Rebuild and commit it with any change under `web/`.
- `runtracker/static/` — `style.css` is shared by the app and exported pages. `charts.js` and `export.js`
  draw exported pages and must depend on nothing but the browser. `app.js`/`index.html` are the earlier
  plain viewer, served at `/classic`.
- `claude-workspace/` — working notes for this project.

## Rules

- No dependencies in Python: not in the writer, not in the sync, the index or the server. The viewer in
  `web/` may use npm packages; keep them few.
- The app is shown as "Train Run Tracker". It reads W&B's files but is not theirs: never use their name
  or logo as its own, and never copy their web app.
- The format is append-only and tolerant: a folder from before the writer existed must still sync and show.
- Minerva: read before changing anything, use the existing `ssh minerva` shared connection, and ask
  before any change on the cluster. The tool itself only ever reads there.
- A copy of `tracker.py` is vendored in `Learn-AI/train-sparse-autoencoder/`. After changing the writer, copy it across.
- Series colours in `style.css` (`--s1`..`--s8`) are a checked set in a fixed order; do not reorder or add a ninth.

## Checking a change

    python3 -m unittest discover tests
    (cd web && npm run build)          # type-checks, then builds
    rt view --port 8791 --no-open      # then look at it in a browser
