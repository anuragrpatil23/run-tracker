# The run folder

One folder per run. This is the contract between the writer, the sync and the viewer. Anything
that writes a folder like this can be synced and viewed, whether or not it used `tracker.py`.

A folder counts as a run if it holds `log.jsonl`, `status.json` or `meta.json`.

| file | what it holds | written |
|---|---|---|
| `config.json` | every setting the run was started with | once, at the first start |
| `meta.json` | the code's commit and whether there were uncommitted changes, the command, the machine, the GPUs, the scheduler's job number, the start time, an optional prediction, and a list of restarts | at each start |
| `log.jsonl` | one line per logging step | appended |
| `system.jsonl` | GPU use, GPU memory, memory held by the process, every few seconds | appended |
| `status.json` | running, finished or failed; the last step; the total if known; a heartbeat time | overwritten |
| `artifacts.jsonl` | one line per file the run saved: path, size, sha256, step | appended |
| `notes.md` | free text about the run | by hand, or from the viewer |

The spec called the list of saved files `artifacts.json`. It is appended to, so it is one JSON
object per line like the logs, and is named `.jsonl` to say so.

## Rules

- **Append only.** A line of a `.jsonl` file is never changed once written, and each is written
  with a single write. A half-copied file is valid up to its last newline; readers ignore a last
  line that has no newline yet.
- **Strict JSON.** A number that is not finite is written as the string `"NaN"`, `"Infinity"` or
  `"-Infinity"`, so every line can be read by any JSON reader. The viewer leaves a gap there.
- **Any fields.** A field of a log line can be a number, a short string, a list or a nested
  object. The viewer draws each by its type: numbers as charts, lists of words as timelines, a
  nested object as its own panel.
- **Reserved names.** `step` is the logging step. Names starting with `_` belong to the tracker:
  `_t` is the time the line was written, in seconds since 1970.
- **Restarts.** A run started again in the same folder continues the same files. `config.json`
  and the first start in `meta.json` are kept; the new start is added to `meta.json` under
  `restarts`, with the settings if they changed.
- **Overwritten files are replaced in one move**, so a reader sees the old version or the new
  one, never half of each.

## log.jsonl

```json
{"step": 200, "_t": 1791336985.7, "rows": 819200, "not_rebuilt": 0.099, "features_on": 3184.9,
 "sky": {"feature": 1649, "fired": 0.42, "responds_to": [" sky", " skies", " heavens"]}}
```

## status.json

```json
{"state": "running", "step": 4200, "total": 48828, "heartbeat": 1791337000.1, "heartbeat_every": 20.0,
 "last_log": 1791336990.5, "started": 1791336000.0, "restarts": 0}
```

`state` is the run's own word. It is `running` until the script ends: `finished` if it ended
normally, `failed` (with `error`) if it ended on an exception or was stopped by a signal. A run
that is killed outright never gets to say so, which is what the heartbeat is for.

## What the viewer makes of it

| shown as | when |
|---|---|
| running | `state` is running and the heartbeat is fresh |
| pending | the scheduler lists the job as waiting |
| stalled | the heartbeat is old while the scheduler still lists the job as running, or the heartbeat is fresh but nothing has been logged for ten times the usual gap |
| died | `state` is running but the scheduler says the job is over, or the heartbeat is old and no job is listed |
| finished, failed | the run said so |
| ended | a folder with no `status.json` whose job is no longer listed |

Freshness is measured against the far machine's clock at the last copy, not the laptop's clock
now, since a copy is only as new as the moment it was made.

## Files that exist only on the laptop

Two files sit in each copied folder and are never taken from, or sent to, the place the run was
written. Their names start with `_`, and the sync skips any far file named that way.

- `_sync.json`: when the folder was last copied, the far path, the size and time of every far
  file, which large files were left behind, and the scheduler's last word on the job.
- `_local.json`: tags, the one-line note, the prediction and how it turned out.

`notes.md` is copied from the far side only if there is none on the laptop yet.

## Folders written before the writer existed

A folder with only `log.jsonl` and `config.json` works. Its lines have no `_t`, so there is no
time axis unless the script logged one of its own (a field that only ever goes up, such as
`minutes`, is offered as an x axis). A config of the shape `{"args": {...}, "device": ...}` has
its `args` lifted to the top so the settings line up with later runs. Large files nobody
registered are still listed, from the sync's own record of what is on the far side.
