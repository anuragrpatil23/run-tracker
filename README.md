# run-tracker

Watch, compare and keep training runs, for runs that happen on a cluster, are written to files,
and are looked at from a laptop.

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

- **Runs.** One row per run: state, how far along, how long, the settings that differ between
  runs, the latest value of chosen numbers, tags and a one-line note. Sort by any column; filter
  by name, tag, note or `setting=value`.
- **One run.** A chart for every number, against step, rows seen or time, with a log scale where
  wanted. A box for what you expected before the run and what happened after. The commit, linked
  to GitHub, and the command. GPU use underneath on the same axis. Notes.
- **Things that are not numbers.** A field that is a list of words is a timeline, one row per
  logging step, with the words that are new in each row outlined. A nested object gets its own
  panel. The search box at the top looks through these fields across every run and answers with
  the first step at which the text appears.
- **Several runs together.** Tick runs in the list and press Compare: the same number from each
  run on one chart, a table of where their settings differ, and a chart of a final number against
  a setting.
- **A run still going.** The pages reread the copied files every few seconds. A run whose
  heartbeat is old while its job is still listed as running is marked stalled.
- **Export.** "Export as a page" on a run or a comparison writes one HTML file that carries its
  own data and drawing code. `rt export` does the same from the command line. Pages go to
  `~/run-tracker-data/exports/` unless a full path is given or `export_dir` is set in
  `~/run-tracker-data/config.json`.

The viewer listens on 127.0.0.1 only and has no accounts.

## What it does not do

It does not store weights, start or stop jobs, or run sweeps. It lists the weights and where
they are, reads the scheduler's state, and shows the results of a sweep.

## Tests

```sh
python3 -m unittest discover tests
```
