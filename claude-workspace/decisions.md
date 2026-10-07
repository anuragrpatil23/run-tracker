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
