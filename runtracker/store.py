"""Reading the copied run folders on the laptop.

Everything the viewer and the command line know about a run comes through here. The folders are
laid out as <data>/runs/<source>/<run>/, where <data> is ~/run-tracker-data unless the
environment variable RUN_TRACKER_DATA says otherwise.

Two files in each copied folder are the laptop's own and are never taken from the cluster:
  _sync.json   when the folder was last copied, what is on the far side, and the scheduler's word on the job
  _local.json  tags, the one-line note, the prediction and how it turned out
"""
import json, os, threading, time
from pathlib import Path

from . import wandbfile

RUN_MARKERS = ("log.jsonl", "status.json", "meta.json")
_lock = threading.Lock()
_logs = {}          # path -> {"offset": bytes read, "records": [...], "inode": ...}


def data_dir():
    return Path(os.environ.get("RUN_TRACKER_DATA", "~/run-tracker-data")).expanduser()


def runs_dir():
    return data_dir() / "runs"


def load_config():
    cfg = read_json(data_dir() / "config.json", {}) or {}
    cfg.setdefault("sources", {})
    return cfg


def save_config(cfg):
    write_json(data_dir() / "config.json", cfg)


def read_json(path, default=None):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return default


def write_json(path, obj):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp%d" % os.getpid())
    tmp.write_text(json.dumps(obj, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    os.replace(tmp, path)


def read_jsonl(path):
    """Every complete line of an append-only file, as a list. Reads only what is new since the last call.

    A last line with no newline is a line still being written or half copied; it is left for next time.
    """
    path = str(path)
    with _lock:
        try:
            st = os.stat(path)
        except OSError:
            _logs.pop(path, None)
            return []
        c = _logs.get(path)
        if c is None or c["inode"] != st.st_ino or st.st_size < c["offset"]:
            c = _logs[path] = {"offset": 0, "records": [], "inode": st.st_ino}
        if st.st_size > c["offset"]:
            with open(path, "rb") as f:
                f.seek(c["offset"])
                chunk = f.read()
            end = chunk.rfind(b"\n") + 1
            for line in chunk[:end].split(b"\n"):
                if not line.strip():
                    continue
                try:
                    rec = json.loads(line)
                    if isinstance(rec, dict):
                        c["records"].append(wandbfile.clean(rec))    # a bare NaN some writers emit becomes the string "NaN"
                except Exception:
                    pass                                    # a damaged line is skipped, not fatal
            c["offset"] += end
        return c["records"]


# A run folder is in one of two forms: the tracker's own files, or the single run-<id>.wandb file the
# Weights & Biases client writes offline. These five are the only places that know which.
def log_of(path):
    w = wandbfile.find(path)
    return wandbfile.load(w)["log"] if w else read_jsonl(Path(path) / "log.jsonl")


def system_of(path):
    w = wandbfile.find(path)
    return wandbfile.load(w)["system"] if w else read_jsonl(Path(path) / "system.jsonl")


def meta_of(path):
    w = wandbfile.find(path)
    return wandbfile.load(w)["meta"] if w else (read_json(Path(path) / "meta.json", {}) or {})


def config_of(path):
    w = wandbfile.find(path)
    return wandbfile.load(w)["config"] if w else (read_json(Path(path) / "config.json", {}) or {})


def status_of(path):
    w = wandbfile.find(path)
    return wandbfile.load(w)["status"] if w else read_json(Path(path) / "status.json")


def output_of(path, limit=400000):
    """What the script printed, newest last: from the W&B file, or from the job's output file beside the run."""
    w = wandbfile.find(path)
    if w:
        return "".join(wandbfile.load(w)["output"])[-limit:]
    for name in ("job.out", "output.log", "stdout.log", "train.log"):
        f = Path(path) / name
        if f.is_file():
            with open(f, "rb") as fh:
                fh.seek(max(0, f.stat().st_size - limit))
                return fh.read().decode("utf-8", "replace")
    return ""


def media_file(run_id, rel):
    """A picture or table a run logged, by its path as the log names it. Kept inside the run's own folder."""
    root = run_path(run_id)
    for base in (root / "files", root):                     # the W&B client keeps them under files/
        f = (base / rel).resolve()
        if root.resolve() in f.parents and f.is_file():
            return f
    raise KeyError(rel)


def is_marker(name):
    """Whether a file of this name makes its folder a run folder."""
    return name in RUN_MARKERS or wandbfile.is_run_file(name)


def flatten(obj, prefix=""):
    """{"a": {"b": 1}} becomes {"a.b": 1}. Lists are kept whole."""
    out = {}
    for k, v in (obj or {}).items():
        key = prefix + str(k)
        if isinstance(v, dict):
            out.update(flatten(v, key + "."))
        else:
            out[key] = v
    return out


def settings(config):
    """The run's settings as one flat dict.

    The first training script wrote {"args": {...}, "device": ...}; the args are lifted to the top so
    those runs line up with later ones.
    """
    config = dict(config or {})
    if isinstance(config.get("args"), dict):
        inner = config.pop("args")
        config = {**inner, **config}
    return flatten(config)


def is_number(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def find_runs():
    """Every run folder under the data directory, as (id, path), id being source/run."""
    root = runs_dir()
    found = []
    if not root.is_dir():
        return found
    for dirpath, dirnames, filenames in os.walk(root):
        if any(is_marker(n) for n in filenames):
            found.append((str(Path(dirpath).relative_to(root)), Path(dirpath)))
            dirnames[:] = []                                # a run folder holds no further runs
    return sorted(found)


def run_path(run_id):
    """The folder for a run id, refusing anything that would step outside the data directory."""
    root = runs_dir().resolve()
    p = (root / run_id).resolve()
    if root not in p.parents or not p.is_dir():
        raise KeyError(run_id)
    return p


def state_of(status, sync, log, now=None):
    """What state a run is in, and a sentence saying why.

    The run's own word (status.json) is weighed against the scheduler's (kept in _sync.json) and
    against how fresh the heartbeat is. Freshness is measured against the far machine's clock at
    the moment of the last copy, since the copy can be no newer than that.
    """
    sync = sync or {}
    job = (sync.get("job") or {}).get("state")
    there_now = sync.get("remote_time") or now or time.time()
    last_t = next((r["_t"] for r in reversed(log) if is_number(r.get("_t"))), None)
    tail = log[-40:]
    gaps = sorted(b["_t"] - a["_t"] for a, b in zip(tail, tail[1:]) if is_number(a.get("_t")) and is_number(b.get("_t")))
    usual_gap = gaps[len(gaps) // 2] if gaps else None

    if status:
        st = status.get("state", "running")
        if st != "running":
            return st, status.get("error") or ""
        if job in ("finished", "killed", "gone"):
            return "died", "the job is over (%s) but the run never said it had ended" % job
        beat_age = there_now - (status.get("heartbeat") or 0)
        limit = max(90.0, 4.0 * (status.get("heartbeat_every") or 20.0))
        if beat_age > limit:
            if job == "running":
                return "stalled", "no heartbeat for %s while the job is still listed as running" % ago(beat_age)
            return "died", "no heartbeat for %s" % ago(beat_age)
        if last_t and usual_gap and there_now - last_t > max(180.0, 10.0 * usual_gap, status.get("lag") or 0):
            return "stalled", "heartbeat is fresh but nothing has been logged for %s" % ago(there_now - last_t)
        if job == "pending":
            return "pending", "waiting in the queue"
        return "running", ""

    # A folder with no status.json: written by hand or by a script from before the writer existed.
    if job == "pending":
        return "pending", "waiting in the queue"
    if job == "running":
        mtime = ((sync.get("files") or {}).get("log.jsonl") or [0, 0])[1]
        if mtime and there_now - mtime > 900:
            return "stalled", "log.jsonl has not grown for %s while the job is still listed as running" % ago(there_now - mtime)
        return "running", ""
    if job == "finished":
        return "finished", ""
    if job == "killed":
        return "failed", "the scheduler reports the job did not end cleanly"
    return "ended", "no status.json and the scheduler no longer lists the job"


def ago(seconds):
    seconds = max(0, float(seconds))
    for size, unit in ((86400, "d"), (3600, "h"), (60, "min")):
        if seconds >= size:
            return "%.0f %s" % (seconds / size, unit)
    return "%.0f s" % seconds


def summary(run_id, path, now=None):
    """The one-row view of a run, for the list."""
    now = now or time.time()
    meta = meta_of(path)
    status = status_of(path)
    sync = read_json(path / "_sync.json", {}) or {}
    local = read_json(path / "_local.json", {}) or {}
    log = log_of(path)
    state, why = state_of(status, sync, log, now)
    last = log[-1] if log else {}
    first = log[0] if log else {}
    started = (status or {}).get("started") or meta.get("time") or first.get("_t")
    ended = (status or {}).get("ended")
    if not ended and state not in ("running", "pending", "stalled"):
        ended = last.get("_t")
    if started:
        seconds = (ended or sync.get("remote_time") or now) - started     # a copied run is only as old as its last copy
    elif is_number(last.get("minutes")):
        seconds = last["minutes"] * 60                       # runs from before the writer carry their own clock
    else:
        seconds = None
    source, _, name = run_id.partition("/")
    wb = meta.get("wandb") or {}
    # the name the run was given (to wandb.init, or the folder's own name), not its whole path below the source
    name = meta.get("name") or name.rsplit("/", 1)[-1]
    return {
        "id": run_id, "name": name or run_id, "source": source, "format": meta.get("format") if wb else "tracker",
        # A project is the top-level grouping: the one named to wandb.init, or the source for runs that name none.
        "project": wb.get("project") or meta.get("project") or source, "group": wb.get("group") or meta.get("group"),
        "state": state, "why": why,
        "step": last.get("step", (status or {}).get("step")), "total": (status or {}).get("total"),
        "lines": len(log), "started": started, "ended": ended, "seconds": seconds,
        "settings": settings(config_of(path)),
        "latest": {k: v for k, v in flatten(last).items() if is_number(v) and not k.startswith("_")},
        "tags": local.get("tags", wb.get("tags", [])), "note": local.get("note", wb.get("notes", "")),
        "prediction": local.get("prediction", meta.get("prediction", "")),
        "synced": sync.get("time"), "job": sync.get("job"),
        "commit": (meta.get("git") or {}).get("commit"), "dirty": (meta.get("git") or {}).get("dirty"),
        "about": meta.get("about") or {}, "metrics": meta.get("metrics") or [],
    }


def all_summaries():
    now = time.time()
    return [summary(i, p, now) for i, p in find_runs()]


def commit_url(git):
    """A link to the commit on the web, where the remote is one we know how to link to."""
    git = git or {}
    remote, commit = git.get("remote") or "", git.get("commit")
    if not commit:
        return None
    if remote.startswith("git@"):
        host, _, repo = remote[4:].partition(":")
        remote = "https://%s/%s" % (host, repo)
    elif remote.startswith("ssh://git@"):
        remote = "https://" + remote[10:]
    if not remote.startswith("https://"):
        return None
    if remote.endswith(".git"):
        remote = remote[:-4]
    sub = git.get("path")
    tree = "/tree/%s/%s" % (commit, sub) if sub and sub != "." else "/commit/" + commit
    return remote + tree


def detail(run_id):
    """Everything about one run except the log lines themselves."""
    path = run_path(run_id)
    out = summary(run_id, path)
    meta = meta_of(path)
    sync = read_json(path / "_sync.json", {}) or {}
    local = read_json(path / "_local.json", {}) or {}
    artifacts = read_jsonl(path / "artifacts.jsonl")
    listed = {a.get("path") for a in artifacts}
    files = []
    for a in artifacts:
        rel = a.get("path", "")
        files.append({**a, "registered": True, "here": (path / rel).is_file() and (path / rel).stat().st_size == a.get("size")})
    for rel in sync.get("big", []):                          # large files seen on the far side that nobody registered
        if rel not in listed:
            size = (sync.get("files", {}).get(rel) or [None])[0]
            files.append({"path": rel, "size": size, "registered": False,
                          "here": (path / rel).is_file() and (path / rel).stat().st_size == size})
    try:
        notes = (path / "notes.md").read_text(encoding="utf-8")
    except Exception:
        notes = ""
    out.update({"meta": meta, "status": status_of(path), "config": config_of(path),
                "sync": {k: v for k, v in sync.items() if k != "files"}, "local": local, "files": files, "notes": notes,
                "commit_url": commit_url(meta.get("git")), "folder": str(path)})
    return out


def set_local(run_id, changes):
    """Change the laptop's own facts about a run: tags, note, prediction, outcome."""
    path = run_path(run_id)
    local = read_json(path / "_local.json", {}) or {}
    for k in ("tags", "note", "prediction", "outcome"):
        if k in changes:
            local[k] = changes[k]
    local["changed"] = time.time()
    write_json(path / "_local.json", local)
    return local


def project_dir(project):
    """Where a project's own files are kept: what its charts mean, and its formulas."""
    safe = "".join(c if c.isalnum() or c in "-_." else "_" for c in project) or "_"
    return data_dir() / "projects" / safe


def about(summaries, project):
    """What each logged name means in one project, in a sentence: {name: text}.

    Training scripts can say (run.describe in the writer, or an "about" entry in the config given to wandb.init); what
    is written in the viewer is kept in the project's about.json and wins over what a script said. A section of charts
    is described under "section:<name>". The same name can mean different things in different projects, so nothing
    here is shared between them.
    """
    out = {}
    for s in summaries:
        if s.get("project") == project:
            out.update(s.get("about") or {})
    out.update(read_json(project_dir(project) / "about.json", {}) or {})
    return out


def set_about(project, key, text):
    mine = read_json(project_dir(project) / "about.json", {}) or {}
    mine[key] = text.strip()                                # kept even when empty, so a script's text is hidden, not restored
    write_json(project_dir(project) / "about.json", mine)


def set_notes(run_id, text):
    path = run_path(run_id)
    (path / "notes.md").write_text(text, encoding="utf-8")


def search(query, limit_per_field=200):
    """Look for text in the fields that are not numbers, across every run.

    For each run and each field that matched: the first step it matched at, how many lines matched,
    and the matching lines. Case is ignored; the query matches anywhere inside a word.
    """
    q = query.strip().lower()
    results = []
    if not q:
        return results
    for run_id, path in find_runs():
        fields = {}
        for rec in log_of(path):
            for key, v in flatten(rec).items():
                if isinstance(v, str):
                    words = [v]
                elif isinstance(v, list) and v and all(isinstance(x, str) for x in v):
                    words = v
                else:
                    continue
                hit = [w for w in words if q in w.lower()]
                if not hit:
                    continue
                f = fields.setdefault(key, {"field": key, "first_step": rec.get("step"), "count": 0, "hits": []})
                f["count"] += 1
                if len(f["hits"]) < limit_per_field:
                    f["hits"].append({"step": rec.get("step"), "value": v, "matched": hit})
        if fields:
            results.append({"run": run_id, "fields": sorted(fields.values(), key=lambda f: (f["first_step"] is None, f["first_step"]))})
    return results
