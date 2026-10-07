"""Reading the run file the Weights & Biases client writes in offline mode (run-<id>.wandb).

A script that calls wandb.init() with WANDB_MODE=offline writes one folder per run, and everything
about the run is in a single file in it: the settings, every logged step, system statistics and
how the run ended. This module reads that file with the standard library alone, so viewing a run
does not need the wandb package installed.

The file is an append-only log, so a copy made while the run is going is valid up to its last
complete record, and reading can pick up where it left off.

  layout    7-byte header (":W&B", two magic bytes, a version), then 32 KB blocks of chunks
  chunk     checksum (4 bytes), length (2), kind (1), data; kind 1 is a whole record, 2/3/4 the
            first, middle and last part of a record that spans chunks
  record    a protocol-buffers message; the field numbers below are from wandb_internal.proto
            in the client's source (MIT licence)

This is the client's internal format, not a published one. It has been stable in shape for years
but a release could change it; tests/fixtures holds a file written by a known client version and
the tests read it, so a break shows up there. Checksums are not verified.

load(path) returns the run in the same terms the rest of the tracker uses: log lines, system
samples, config, meta and status.
"""
import json, math, os, struct, threading

BLOCK, HEADER = 32768, 7
# Record: which field holds which kind of record
HISTORY, CONFIG, STATS, OUTPUT_RAW, RUN, EXIT, ENVIRONMENT = 2, 5, 7, 13, 17, 18, 26

_lock = threading.Lock()
_cache = {}


def _varint(buf, i):
    out = shift = 0
    while True:
        b = buf[i]; i += 1
        out |= (b & 0x7F) << shift
        if not b & 0x80:
            return out, i
        shift += 7


def _fields(buf):
    """The fields of one protocol-buffers message, as (number, value). A value is an int or bytes."""
    i, n = 0, len(buf)
    while i < n:
        key, i = _varint(buf, i)
        num, wire = key >> 3, key & 7
        if wire == 0:
            v, i = _varint(buf, i)
        elif wire == 2:
            size, i = _varint(buf, i)
            v = buf[i:i + size]; i += size
        elif wire == 1:
            v = buf[i:i + 8]; i += 8
        elif wire == 5:
            v = buf[i:i + 4]; i += 4
        else:
            return                                          # a kind of field this reader does not know; stop here
        yield num, v


def _text(v):
    return v.decode("utf-8", "replace") if isinstance(v, (bytes, bytearray)) else v


def _time(buf):
    """A Timestamp message as seconds since 1970."""
    f = dict(_fields(buf))
    return f.get(1, 0) + f.get(2, 0) / 1e9


def clean(v):
    """Make a value safe to send as strict JSON: a number that is not finite becomes a string."""
    if isinstance(v, float) and not math.isfinite(v):
        return "NaN" if math.isnan(v) else ("Infinity" if v > 0 else "-Infinity")
    if isinstance(v, dict):
        return {k: clean(x) for k, x in v.items()}
    if isinstance(v, list):
        return [clean(x) for x in v]
    return v


def _item(buf):
    """A HistoryItem, ConfigItem or StatsItem: where the value goes, and the value."""
    key, nested, value = None, [], None
    for num, v in _fields(buf):
        if num == 1:
            key = _text(v)
        elif num == 2:
            nested.append(_text(v))
        elif num == 16:
            try:
                value = clean(json.loads(v))
            except Exception:
                value = _text(v)
    return (nested or [key]), value


def _put(tree, path, value):
    for part in path[:-1]:
        nxt = tree.get(part)
        if not isinstance(nxt, dict):
            nxt = tree[part] = {}
        tree = nxt
    tree[path[-1]] = value


def _git(buf):
    f = {n: _text(v) for n, v in _fields(buf)}
    return {"remote": f.get(1) or None, "commit": f.get(2) or None}


def _config(buf, into):
    for num, v in _fields(buf):
        if num == 1:
            path, value = _item(v)
            if path != ["_wandb"]:                          # the client's own bookkeeping, not a setting
                if isinstance(value, dict) and set(value) == {"value"} or isinstance(value, dict) and set(value) == {"value", "desc"}:
                    value = value["value"]
                _put(into, path, value)
        elif num == 2:
            path, _ = _item(v)
            into.pop(path[0], None)


def _apply(run, data):
    """Fold one record into what is known about the run."""
    for kind, body in _fields(data):
        if kind == HISTORY:
            row = {}
            step = None
            for num, v in _fields(body):
                if num == 1:
                    path, value = _item(v)
                    _put(row, path, value)
                elif num == 2:
                    step = dict(_fields(v)).get(1, 0)
            line = {"step": row.pop("_step", step)}
            if "_timestamp" in row:
                line["_t"] = row.pop("_timestamp")
            row.pop("_runtime", None)
            line.update(row)
            run["log"].append(line)
            if isinstance(line.get("_t"), (int, float)):
                run["last_t"] = max(run["last_t"] or 0, line["_t"])
        elif kind == CONFIG:
            _config(body, run["config"])
        elif kind == STATS:
            t, items = None, {}
            for num, v in _fields(body):
                if num == 2:
                    t = _time(v)
                elif num == 3:
                    path, value = _item(v)
                    items[path[0]] = value
            sample = {"_t": t, "cpu_mem_mb": items.get("proc.memory.rssMB"), "cpu": items.get("cpu")}
            gpus = {}
            for key, value in items.items():
                part = key.split(".")
                if len(part) == 3 and part[0] == "gpu" and part[1].isdigit():
                    g = gpus.setdefault(int(part[1]), {"index": int(part[1])})
                    if part[2] == "gpu":
                        g["util"] = value
                    elif part[2] == "memoryAllocatedBytes" and isinstance(value, (int, float)):
                        g["mem_mb"] = round(value / 1048576.0, 1)
                    elif part[2] == "temp":
                        g["temp_c"] = value
                    elif part[2] == "powerWatts":
                        g["power_w"] = value
            if gpus:
                sample["gpu"] = [gpus[i] for i in sorted(gpus)]
            sample["all"] = items                           # everything the client sampled, under its own names
            run["system"].append(sample)
            if t:
                run["last_t"] = max(run["last_t"] or 0, t)
        elif kind == RUN:
            m, w = run["meta"], run["meta"]["wandb"]
            for num, v in _fields(body):
                if num == 1: w["run_id"] = _text(v)
                elif num == 2: w["entity"] = _text(v)
                elif num == 3: w["project"] = _text(v)
                elif num == 4: _config(v, run["config"])
                elif num == 6: w["group"] = _text(v)
                elif num == 7: w["job_type"] = _text(v)
                elif num == 8: m["name"] = _text(v)
                elif num == 9: w["notes"] = _text(v)
                elif num == 10: w.setdefault("tags", []).append(_text(v))
                elif num == 13: m["host"] = _text(v)
                elif num == 17: m["time"] = _time(v)
                elif num == 21:
                    m["git"].update({k: x for k, x in _git(v).items() if x})
            m.setdefault("name", w.get("run_id"))
        elif kind == ENVIRONMENT:
            m = run["meta"]
            args, program, gpus = [], None, []
            for num, v in _fields(body):
                if num == 2: m["python"] = _text(v)
                elif num == 5: args.append(_text(v))
                elif num == 6: program = _text(v)
                elif num == 9: m["git"].update({k: x for k, x in _git(v).items() if x})
                elif num == 11: m["cwd"] = _text(v)
                elif num == 12: m.setdefault("host", _text(v))
                elif num == 13: m["user"] = _text(v)
                elif num == 14: m["executable"] = _text(v)
                elif num == 24:
                    g = dict(_fields(v))
                    gpus.append({"name": _text(g.get(1)), "mem_total_mb": round(g.get(2, 0) / 1048576.0) or None})
            if program:
                m["command"] = " ".join([m.get("executable") or "python", program] + args)
            if gpus:
                m["gpus"] = gpus
        elif kind == EXIT:
            f = dict(_fields(body))
            code = f.get(1, 0)
            run["exit"] = code - (1 << 32) if code >= 1 << 31 else code      # a negative code arrives as a large number


def _read(path, run):
    """Read the records added to the file since last time."""
    size = os.path.getsize(path)
    if size <= run["offset"]:
        return
    with open(path, "rb") as f:
        if run["offset"] == 0:
            if f.read(4) != b":W&B":
                raise ValueError("%s is not a W&B run file" % path)
            run["offset"] = HEADER
        f.seek(run["offset"])
        blob = f.read()
    base, pos, part, done = run["offset"], 0, b"", 0
    while pos + HEADER <= len(blob):
        left = BLOCK - (base + pos) % BLOCK
        if left < HEADER:
            pos += left                                     # too little room left in the block for a chunk: padding
            continue
        length, kind = struct.unpack_from("<HB", blob, pos + 4)
        if kind == 0 or kind > 4 or pos + HEADER + length > len(blob):
            break                                           # padding, or a chunk that is not all here yet
        data = blob[pos + HEADER:pos + HEADER + length]
        pos += HEADER + length
        part = data if kind in (1, 2) else part + data
        if kind in (1, 4):
            try:
                _apply(run, part)
            except Exception:
                pass                                        # one record this reader cannot follow does not lose the rest
            done = pos
    run["offset"] = base + done


def load(path):
    """The run in a .wandb file: {"log", "system", "config", "meta", "status"}. Rereads only what is new."""
    path = str(path)
    with _lock:
        st = os.stat(path)
        run = _cache.get(path)
        if run is None or run["inode"] != st.st_ino or st.st_size < run["offset"]:
            run = _cache[path] = {"inode": st.st_ino, "offset": 0, "log": [], "system": [], "config": {}, "exit": None, "last_t": None,
                                  "meta": {"format": "wandb", "git": {"commit": None, "remote": None, "dirty": None}, "wandb": {}, "restarts": []}}
        _read(path, run)
        last = run["log"][-1] if run["log"] else {}
        status = {"step": last.get("step"), "total": None, "started": run["meta"].get("time"), "last_log": last.get("_t")}
        if run["exit"] is None:
            # No exit record yet. The time of the newest record does the job of a heartbeat, but a slow one: the
            # client writes the file a 32 KB block at a time, so on disk a run that logs little can be many
            # minutes behind itself. The limits are set wide so that such a run is not taken for dead.
            status.update(state="running", heartbeat=run["last_t"] or run["meta"].get("time") or st.st_mtime,
                          heartbeat_every=300.0, lag=1200.0)
        else:
            status.update(state="finished" if run["exit"] == 0 else "failed", ended=run["last_t"])
            if run["exit"]:
                status["error"] = "the script ended with exit code %d" % run["exit"]
        return {"log": run["log"], "system": run["system"], "config": run["config"], "meta": run["meta"], "status": status}


def find(folder):
    """The run file in a folder, if it is a W&B run folder."""
    try:
        names = sorted(n for n in os.listdir(folder) if is_run_file(n))
    except OSError:
        return None
    return os.path.join(str(folder), names[0]) if names else None


def is_run_file(name):
    return name.startswith("run-") and name.endswith(".wandb")
