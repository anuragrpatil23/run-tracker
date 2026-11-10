# Labbook: the design

Written 2026-11-09, before any of it was built. This is the page later sessions build from; change it here first when the plan changes, and mark what is done.

Labbook is what run-tracker becomes once the lab notebook is folded into it. The name says what the app is for: keeping the record of experiments, of which tracking runs is one part.

## Where this came from

In a physical lab, each experiment's page holds a diagram of the setup next to the result. You can always tell which arrangement produced which number, and taking the apparatus apart afterwards loses nothing. Code is different: the apparatus keeps growing from one experiment to the next, so a result from last month was produced by code that no longer exists in that form. Git keeps the old code, but nothing on the page says which version made the result, and nothing shows what the setup looked like.

Two tools grew up to answer this, separately:

- **run-tracker** (this repo): a writer that puts a run's settings, steps, machine and heartbeat into a folder; a sync that copies run folders from the cluster; a viewer that draws them.
- **labbook** (a small separate repo, built 2026-11-09 for the introspection project): a page per experiment (question, prediction, a picture of the setup, what changed, analysis), a stamp on each run (commit, refusing uncommitted code, fingerprints of the input files, the model's exact revision), and one real example traced through every stage of the pipeline.

Used side by side they do not connect, and run-tracker on its own has pains Anurag named:

- **Where does a run show up?** A run appears only if someone registered a source pointing at exactly the folder that holds it, then synced. It lands under the source's name, not the experiment it belongs to.
- **Which runs get picked up?** A source must be "a folder of run folders" at exactly the right depth. One level off and it quietly picks up the wrong things: `sae-local` points one level too high and shows two "runs" called `files` and `wandb`. `toy-superposition` has runs on disk but no source, so nothing says where they came from. Four trial sources pointing at `/tmp` are still configured.
- **Naming.** Runs are named after whatever folder they were found in. Runs written through the W&B client are called `offline-run-20261006_225642-pmmm95lv`, which says nothing.
- **Logs.** The job's printed output comes across only if the scheduler writes it inside the run folder. By default it does not: jobs write to a scratch logs folder named by job number, which appears only when the job ends.
- **Which is old and which never ran** is hard to tell. There is no place where an experiment exists before its first run.

Most of this comes from one choice: run-tracker finds runs by where they sit on disk, through sources configured by hand, and names them after the folder it found. Labbook turns that around. **The experiment comes first, and a run is made by an experiment, under it, named for what is different about it.** Then the location, the name and the grouping all follow from the experiment, and there is nothing to register.

## The shape of a project

A project is a git repo. Its experiments are folders in it; its runs are folders under each experiment:

```
introspection/                                   the project: a repo
  experiments/
    _map.md                                      optional: the order to show experiments in
    01-guo-reproduction/
      README.md                                  the experiment's page
      runs/
        2026-11-09_1755-rank128-1epoch/          one run: <date>_<time>-<label>
          meta.json  config.json  status.json  log.jsonl  system.jsonl  artifacts.jsonl
          trace.md   output.log
```

- **The project is the repo**, the experiment is the folder, and the run is the date and time plus a short label the script gives. Nobody chooses a path.
- **The date comes first** so runs sort by age in any file listing, and the label says what differs (`rank128-1epoch`, `short-test`, `lam0.05`).
- **An experiment with a page and no runs is a real thing**: it shows as "never run". Ideas written up but not started stay visible.
- **Large files stay outside the run folder** (adapters, checkpoints, activations), on the cluster's work disk. The run lists each one with its path, size and checksum in `artifacts.jsonl`, as now.

`_map.md` orders experiments the way it orders pages in the vault: bullets with wikilinks, one line each on why it sits where it does. Without one, experiments sort by their number.

## The run folder

Everything in [format.md](format.md) stays as it is: append-only, tolerant, old folders still valid. Labbook adds:

| file or field | what it holds | why |
|---|---|---|
| `meta.json` → `experiment`, `label` | which experiment made the run, and its label | the run knows where it belongs, even when copied elsewhere |
| `meta.json` → `inputs` | path, size and sha256 of each input file the script declared | a later run can tell whether an input changed, e.g. labels made by another experiment |
| `meta.json` → `models` | each Hugging Face model or dataset used, with the revision from the local cache | the weights can change upstream under the same name |
| `meta.json` → `code.strict` | whether the run refused uncommitted code | a strict run's commit is guaranteed to be the code that ran |
| `trace.md` | one real example at each stage, the first time each stage is reached; rewritten as stages are added | the bugs that ruin a result live in what flows through: the exact prompt, the label, what the model said |
| `output.log` | everything the job printed, stdout and stderr | logs live with their run, under its name |
| `results.json` | the run's final results, written by `finish()` | the numbers the experiment page shows, without reading the whole log |

`output.log` gets there because the job script asks the writer for the run's folder before starting Python, and points the scheduler's output at it. The writer offers `labbook path <experiment> <label>` for that: it makes the folder and prints its path.

## The writer

One import for every script. It is today's `tracker.py` with labbook's parts added: one file, standard library only, Python 3.8, and never able to stop a run (every write is wrapped and only warns).

```python
from labbook import Run

run = Run("01-guo-reproduction", label="rank128-1epoch", config=settings, total=steps,
          strict=True)                            # refuse to start with uncommitted tracked files
run.model("Qwen/Qwen3.5-9B")                      # the revision, from the local cache
run.input("results/qwen3.5-9b/00_hint_flips_train.jsonl", "the Orig labels, from experiment 00")
for step in ...:
    run.log(step, nll=..., kl=...)                # a line in log.jsonl, drawn as a chart
    run.trace("training: the prompt", prompt)     # kept the first time only
run.save(adapter_path)                            # listed with size and checksum, not copied
run.finish({"orig": 0.869, "self": 0.925})        # results.json, and status finished
```

- `Run("<experiment>", ...)` finds the repo root from the working directory and writes under `experiments/<experiment>/runs/`. Passing a full folder still works, so `tracker.start("runs/f8192_lam0.2")` keeps working unchanged: it is the same writer under its old name.
- `strict=True` is labbook's refusal: tracked files with uncommitted changes stop the run before anything is written. Without it, the commit and the uncommitted diff are recorded, as now.
- The prediction is read from the experiment page's Prediction section at the run's start and copied into `meta.json`, so it is fixed at the moment of the run even if the page changes later.
- W&B runs keep working exactly as now. They are shown by their name and project, never by the `offline-run-...` folder name.

**Nothing lasting stays on the cluster.** Anurag's rules (2026-11-09): no downloaded model is kept on Minerva once the runs that need it are done, and logs are kept on the laptop, not the cluster. `labbook clean <project>` does both, after a yes, and refuses while any of the project's runs is still running:
- **Models:** `run.model()` records which models a run used, so it lists those still in the cluster's cache and deletes each one's `models--...` folder and the blobs it links to, which is where the space actually is.
- **Logs:** it checks that the sync has brought each finished run's `log.jsonl`, `system.jsonl` and `output.log` to the laptop with matching checksums, then deletes the cluster's copies. Run records (`meta.json`, `results.json`, `trace.md` and the rest) stay, as they are what the repo commits.
- Trained adapters are the run's own output and are not touched.

The copy of `tracker.py` vendored in `Learn-AI/train-sparse-autoencoder/` is replaced by the new file, and its runs keep syncing as before.

## Finding runs

A source is now one of three kinds:

| kind | what it points at | what it picks up |
|---|---|---|
| **project** (new, the default) | a repo root, on the cluster or on this machine | every `experiments/*/README.md` (experiments, run or not) and every `experiments/*/runs/*` |
| folder (today's sources) | a folder of run folders | each run folder in it |
| W&B | a `wandb` folder | each offline run |

So one source per project, set once: `labbook source add introspection --ssh minerva --root /sc/arion/work/patila06/introspection`. A new experiment, or a new run of an old one, shows up at the next sync with nothing to register.

A source that finds nothing says so, as does one where a "run" holds none of the run files. The sync reports what it found per source, instead of quietly showing the wrong things. The four paused `/tmp` trial sources and `sae-local` are removed once Anurag agrees.

The sync still only reads on the cluster (only `labbook clean` deletes there, after a yes), still uses the existing `ssh minerva` connection in batch mode, and still leaves files over 2 MB behind except logs.

## The viewer

The app keeps its look: the stylesheet, the charts, the colours and Instrument Sans. What changes is how you get to a run.

**A tree down the left**, as in Thinking Space's explorer:

```
introspection
  00-does-qwen3.5-follow-the-hint     2 runs, last Nov 9
  01-guo-reproduction                 running    rank128-1epoch, 1h48m
    2026-11-09_1755-rank128-1epoch    running
    2026-11-09_1736-short-test        finished
  02-addition-paths-in-qwen3-8b       never run with labbook
  03-toy-text-and-image               never run
Learn-AI
  sae                                 (a folder source: its runs, no experiment page)
```

- Each experiment line shows its latest run's state, so what is live, stalled or never run is seen without opening anything. Runs are newest first, each with its date.
- **Clicking an experiment** opens its page, rendered from its `README.md` (Markdown, LaTeX, images), and under it a table of its runs: label, date, state, the settings that differ between them, and each run's `results.json`. The prediction sits beside the result.
- **Clicking a run** opens today's run page: charts, settings, the command, the commit linked to GitHub, the machine, saved files. Added: the trace, the output log, the inputs and models.
- **Ticking several runs** in the tree draws them together, which is what today's home page does. The strip of run chips stays as the legend.

This replaces the home page's choice of having no sidebar. The tree is the sidebar, and it can fold away.

## Extending it

A project adds views of its own, the way `personal_extension/` adds to Thinking Space and the way dont-blame-me's viewer is built: a small function that reads files and answers with JSON, and a component that draws that JSON.

**The app's own code is laid out the way Thinking Space's is:**

```
web/src/
  lego_blocks/units/      small reusable parts: RunTree, Chart, Table, ExampleList, TextWithHighlights,
                          Diff, Tabs, Markdown, StatePill, ...
  lego_blocks/hooks/      useRuns, useExperiment, useStored, ...
  orchestrators/          ProjectOrch, ExperimentOrch, RunOrch, CompareOrch: parts wired into a view
  pages/                  route-level wrappers
```

**A project's views mirror that layout**, in its own repo:

```
introspection/labbook_views/
  views.json              which views exist and where each appears
  explanations.py         reads a run folder, returns JSON
  ExplanationsOrch.tsx    draws it, built from the app's lego blocks
```

```json
{"views": [{"name": "Explanations", "on": "run", "experiments": ["01-guo-reproduction"],
            "data": "explanations.py", "component": "ExplanationsOrch.tsx"}]}
```

- A view appears as a tab: on a run, on an experiment, or on the project.
- **The data side** is a Python function `data(run_dir, query) -> dict`, run by the server from the project's folder. It may use only the standard library, like the rest of the app, so the app never needs a project's packages to start. Anything heavier is written into the run folder by the run itself and only read here.
- **The drawing side** is built by the project into one file, `labbook_views/dist/views.js`, with `labbook views build`. The app loads it at start-up and shares its own React and lego blocks with it, so a view is mostly assembling existing parts. Run-tracker's Scan already works this way in spirit: an outside program the app talks to through a fixed contract.
- The first real view is introspection's **Explanations**: every test question with what the model said beside its Orig and Self labels, filterable to the questions where the two differ. The lego blocks are designed against it, not in the abstract.

## What is borrowed from Thinking Space

- The layout: `lego_blocks`, `orchestrators` and `pages`, and an extension folder that mirrors the core.
- The explorer tree, and `_map.md` for order.
- Markdown with LaTeX, and the image, HTML and PDF viewers, for experiment pages and the plots a run saves.
- Tabs.

Labbook stays its own app rather than a page inside Thinking Space. It has to open for collaborators with `pip install labbook` and `labbook view`, and Thinking Space is Anurag's personal desk. Blocks are copied across where they fit, not shared as a dependency.

## What goes into git

Run folders sit inside the project repo, so this needs a rule. Suggested, not yet agreed:

- **Committed:** `meta.json`, `config.json`, `status.json`, `results.json`, `trace.md`, `artifacts.jsonl`. Small, and enough for GitHub to show what ran and what came of it.
- **Not committed:** `log.jsonl`, `system.jsonl`, `output.log`. They can be long; the app's sync brings them to the laptop.

`labbook init` writes the `.gitignore` lines for a project. On the cluster the run folders are untracked until committed from the laptop after a sync, as the introspection repo's `jobs/pull_runs.sh` does now; that script goes away once the sync does it.

## The order of work

Each step leaves everything working.

1. **One repo, one name.**
   - Fold the small labbook repo into this one with its history, as circuit-awareness was folded into introspection.
   - Delete the small labbook repo (Anurag confirms), then rename this repo `labbook` on GitHub. The old name redirects.
   - Rename the app's name and command (`rt` becomes `labbook`, `rt` kept as an alias for a while) and the data folder (`~/run-tracker-data` becomes `~/labbook-data`, moved on first start).
2. **The writer.** `Run` with experiment and label, `trace`, `input`, `model`, `strict`, `results.json`, `labbook path`, and `labbook clean`. Tests for each. Copy it into Learn-AI and check the SAE runs still sync.
3. **Finding runs by shape.** Project sources, the per-source report, and the clean-up of old sources. Move introspection onto the new writer, its job script onto `output.log`, and its existing runs into the new layout.
4. **The tree and the experiment page** in the viewer, with the web code moved into `lego_blocks` / `orchestrators` / `pages` as it is touched.
5. **Views.** The contract, `labbook views build`, the shared blocks, and Explanations as the first view.

## Open questions

- What goes into git: the rule above is a suggestion.
- Whether a view's data function should be allowed packages beyond the standard library, for projects whose files need them to read (for example `.pt` tensors). The current answer is no: the run writes what the view needs.
- Where W&B runs and folder-source runs sit in the tree: under their project with no experiment page, as drawn above, or under an "unsorted" experiment.
