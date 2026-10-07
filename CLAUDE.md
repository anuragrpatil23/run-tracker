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
- `runtracker/static/` — the viewer. Plain JS, no build step. `charts.js` is shared with exported pages,
  so it must depend on nothing but the browser.
- `claude-workspace/` — working notes for this project.

## Rules

- No dependencies. Not in the writer, not on the laptop side, not in the browser.
- The format is append-only and tolerant: a folder from before the writer existed must still sync and show.
- Minerva: read before changing anything, use the existing `ssh minerva` shared connection, and ask
  before any change on the cluster. The tool itself only ever reads there.
- A copy of `tracker.py` is vendored in `Learn-AI/train-sparse-autoencoder/`. After changing the writer, copy it across.
- Series colours in `style.css` (`--s1`..`--s8`) are a checked set in a fixed order; do not reorder or add a ninth.

## Checking a change

    python3 -m unittest discover tests
    rt view --port 8791 --no-open      # then look at it in a browser
