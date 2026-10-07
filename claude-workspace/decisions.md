# Decisions taken while building (2026-10-06)

The spec (`run-tracker-spec.md` in the vault, under lifeblood_systems/sfresearch) left four things open.
These are the defaults that were built; none is hard to change.

- **Where copied runs live:** `~/run-tracker-data/`, outside the vault. `RUN_TRACKER_DATA` moves it.
- **Web app or static pages:** a local web app, since live runs and search need one. Export covers the
  static case: one self-contained HTML file per chart set, for the vault.
- **Other places runs come from:** a source is an ssh host or a local folder, so a second cluster or the
  laptop is one more `rt source add`.
- **How long runs are kept on Minerva:** not decided and not the tool's job. It never deletes anything.

Departures from the spec:

- `artifacts.json` is `artifacts.jsonl`, because it is appended to.
- Log lines carry `_t` (time written), which the spec's example line did not have; the time axis needs it.
- Non-finite numbers are written as strings so the files stay strict JSON.

Not built: a Slurm path that has been tried against a real Slurm cluster (the code is there, untested);
acting on the scheduler (the spec says this is a separate decision).

# W&B offline runs as a second input (2026-10-06)

Direction agreed with Anurag: training scripts may log with the W&B client in offline mode, and this
project becomes an open viewer for those run files that anyone can use, alongside its own format.

Found by trial with client 0.30.0:

- Offline mode needs no account. Everything is in `run-<id>.wandb`; `files/` held only requirements.txt.
- The client no longer ships a Python reader for the file (`wandb.sdk.internal.datastore` is gone), so
  the reader here is our own: LevelDB-style framing plus a hand decoder for the few record types needed.
- The file is written in 32 KB blocks. Measured: nothing on disk for the first ~10 s of a run, then rows
  arrive a block at a time. Live watching of a W&B run is therefore minutes behind for a slow logger.
  Not yet looked for: a client setting that flushes more often.
- The client is MIT licensed. Do not use their name or logo as if this were theirs, and do not copy their web app.

Not yet read from the file: summary records, console output, media and tables, artifacts, the Slurm
entry of the environment record, partial-history requests. Not yet tried: a GPU node, a resumed run,
a client version other than 0.30.0.

# The viewer rebuilt (2026-10-06)

Anurag wants this to be a full app, open for anyone who logs with the W&B client and cannot use its UI.
Shown name: Train Run Tracker (his choice). Repo, package and the `rt` command keep their names for now.

- The "no build step" rule is dropped for the viewer only. Stack: Vite, React, TypeScript, uPlot. Python stays dependency-free.
- An index (SQLite, standard library) sits between the run folders and the viewer.
- The server is still Python's own http.server and the pages still poll; live push has not been built.

Not built yet: pictures, tables and histograms from W&B runs; lines per group with a band; saved views kept
on the server; arranging and resizing panels; alerts; code diff between runs. Tabs and controls were
type-checked and the pages looked at in headless Chrome, but nothing was clicked through by a script.
