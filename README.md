# Train Run Tracker

Watch, compare and keep training runs, for runs that happen on a cluster, are written to files,
and are looked at from a laptop. It reads its own simple run folders and the run files the
Weights & Biases client writes in offline mode, so a script that already calls `wandb.log` can be
viewed with no account, no server and nothing leaving the machine.

The training job only writes files. It opens no network connection and sends nothing anywhere.
Everything else happens later, on the laptop, by reading those files.

Three parts, each usable without the next:

1. **A writer** (`tracker.py`). One file, standard library only. The training script imports it
   and a run folder appears.
2. **A sync** (`rt sync`). Copies run folders over the ssh connection you already have, bringing
   only the bytes that are new, and leaves large files such as weights where they are.
3. **A viewer** (`rt view`). A web app on the laptop only: the list of runs, one run, several
   runs together, and a search of the words runs have logged.

Nothing needs installing beyond Python 3.8 on the cluster and Python 3.9 on the laptop.

## Runs logged with the Weights & Biases client

A script that already calls `wandb.log` needs no change beyond running offline:

```sh
export WANDB_MODE=offline        # nothing is sent anywhere; no account or key is needed
python train.py                  # writes ./wandb/offline-run-<date>_<time>-<id>/run-<id>.wandb
```

Point a source at the `wandb` folder and the runs sync and show beside the others:

```sh
rt source add myproject --ssh minerva --root /path/to/project/wandb --scheduler lsf
rt sync
```

The run file is read directly, with the standard library alone (`runtracker/wandbfile.py`); the
`wandb` package is not needed on the laptop. Settings, every logged step (nested values and lists
of words included), system statistics, the run's name, project, tags and notes, the command and
how the run ended all come across.

Two things to know:

- **A run still going is behind itself on disk.** The client writes its file a 32 KB block at a
  time, so steps reach the disk in batches. A run that logs a line every few seconds may be a few
  minutes behind; one that logs rarely, longer. The tracker's own writer puts each line on disk as
  it is logged, and is the better choice where watching live matters.
- **The file is the client's internal format.** It is read here from the record definitions in
  the client's source (MIT licence), checked against a file written by client 0.30.0 that is kept
  in `tests/fixtures`. Pin the client version on the cluster, and run the tests after changing it.

This project is not affiliated with or endorsed by Weights & Biases.

## The writer

Copy `tracker.py` next to the training script.

```python
import tracker

run = tracker.start("runs/f8192_lam0.2", config=vars(args), total=steps,
                    prediction="Higher lam: fewer features on, more left not rebuilt.")
for step in range(steps + 1):
    ...
    run.log(step, not_rebuilt=0.099, features_on=3184.9,
            sky={"feature": 1649, "fired": 0.42, "responds_to": [" sky", " skies", " heavens"]})
    if step in saves:
        torch.save(weights, path)
        run.save(path, step=step)
```

Without being asked it records the code's commit and whether anything was uncommitted, the
command, the machine, the GPUs and the scheduler's job number; samples GPU use and memory in a
background thread; and keeps a heartbeat, so a run that died without saying so can be told from
one that is still going. When the script ends it marks the run finished, or failed with the
error. If a write fails (a full disk, a folder that cannot be written) it warns once on stderr
and the training carries on.

`run.describe(not_rebuilt="The share of the input the network failed to rebuild.")` says in a
sentence what a logged name means; the viewer shows it under that chart. The same sentence can be
written or rewritten in the viewer by clicking it.

The folder it writes is described in [docs/format.md](docs/format.md).

## The sync

```sh
pip install -e .          # once, on the laptop; gives the rt command (or use: python3 -m runtracker.cli)

rt source add sae --ssh minerva --root /sc/arion/work/patila06/Learn-AI/train-sparse-autoencoder/runs --scheduler lsf
rt sync                   # copy what is new
rt sync --watch           # and again every 30 s while any run is still going
rt ls
rt fetch sae/f8192_lam0.2 step_0048828.pt     # bring one large file; resumes, and checks the checksum
```

- A source is a folder of run folders: on an ssh host, or on this machine if `--ssh` is left out.
- It uses the ssh setup in `~/.ssh/config` as it is, in batch mode, so it can never ask for a
  password or store one. If the shared connection is closed it says so; open it with `ssh minerva`.
- One sync is two round trips however many runs there are: one to list files and ask the
  scheduler about jobs, one to fetch the new bytes.
- Files over 2 MB that are not logs stay on the cluster. Their names and sizes come across.
- With `--scheduler lsf` (or `slurm`) it records each run's job state beside the run. A job is
  matched to a run by the job number the writer recorded, or by the job's output file being
  inside the run folder. It only reads the scheduler; it never starts or stops anything.

Copied runs live in `~/run-tracker-data/runs/<source>/<run>/`. Set `RUN_TRACKER_DATA` to keep
them somewhere else.

## The viewer

```sh
rt view                   # http://127.0.0.1:8787
rt view --watch           # the same, syncing in the background while a run is going
```

- **Workspace.** The runs down the left, what they logged on the right. Tick runs to draw them:
  every number becomes a chart with a line per run. Drag across a chart to zoom, double-click to
  reset; the readout follows the pointer on every chart at once. Smoothing, a log scale per chart
  (chosen for you when a number spans a hundredfold), and any number that only goes up (rows seen,
  minutes) as the x axis. Filter, sort and group the runs by any setting.
- **Table, Settings, One number against a setting.** The other tabs of the workspace: every run
  with its settings and latest numbers; the settings of the drawn runs side by side; and one dot
  per run of a number against a setting, the picture for choosing a value such as a penalty.
- **One run.** Its charts, the machine (GPU, memory) against time, settings, the command, the
  commit linked to GitHub, what the script printed, the files it saved, and a box for what you
  expected before the run beside what happened after.
- **Words.** A field that is a list of words is a timeline, one row per logged line, with the
  words that are new in each row outlined. The search box looks through these fields across every
  run and answers with the first step at which the text appears.
- **A run still going.** Pages refresh every few seconds. A run whose heartbeat is old while its
  job is still listed as running is marked stalled.
- **Export.** "Export as a page" writes one HTML file that carries its own data and drawing code.
  `rt export` does the same from the command line. Pages go to `~/run-tracker-data/exports/`
  unless a full path is given or `export_dir` is set in `~/run-tracker-data/config.json`.

Behind the viewer is an index, `~/run-tracker-data/index.sqlite`, built from the run folders so
that long runs and many runs stay quick. It holds nothing that is not in the folders and can be
deleted at any time.

The viewer listens on 127.0.0.1 only and has no accounts.

## What it does not do

It does not store weights, start or stop jobs, or run sweeps. It lists the weights and where
they are, reads the scheduler's state, and shows the results of a sweep.

## Working on it

```sh
python3 -m unittest discover tests      # the writer, the sync, the W&B file reader, the index

cd web && npm install                   # the viewer: TypeScript, React, uPlot, built with Vite
npm run dev                             # the app with live reload, talking to a running `rt view`
npm run build                           # writes runtracker/static/app/, which `rt view` serves
```

The built viewer is kept in the repository, so `pip install` and `rt view` need no Node. The
Python side has no dependencies. The earlier plain-JavaScript viewer is still at `/classic`.
