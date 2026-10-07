"""The index: a SQLite file that holds what the viewer asks for, built from the run folders.

The run folders stay the only source of truth. The index can be deleted at any time and is rebuilt
from them; it exists so that a list of thousands of runs, a chart of a run with a million steps and
a search of every word logged do not each mean reading every file again.

  runs    one row per run: a signature of its files, how far it has been read, and its summary
  keys    for each run, every name it has logged: whether it is a number or words, its range, its latest value
  line    one row per logged line: its step and its time
  point   one number: run, name, line
  word    one piece of text or list of words: run, name, line

Names are dotted for nested values ("sky.fired"). What the run logged is stream 0; samples of the
machine (GPU, memory) are stream 1, with names that start "sys/".

A run is read forward from where the last read stopped, since its files only grow. If a file has
shrunk, the run was replaced: its rows are dropped and it is read again from the start.
"""
import json, math, os, sqlite3, threading, time
from pathlib import Path

from . import store, wandbfile

VERSION = 2
SCHEMA = """
CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY, sig TEXT, lines INTEGER, sys INTEGER, summary TEXT) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS keys(run TEXT, key TEXT, kind TEXT, n INTEGER, last, lo REAL, hi REAL, mono INTEGER,
                                PRIMARY KEY(run, key)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS line(run TEXT, stream INTEGER, n INTEGER, step REAL, t REAL, PRIMARY KEY(run, stream, n)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS point(run TEXT, key TEXT, n INTEGER, v REAL, PRIMARY KEY(run, key, n)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS word(run TEXT, key TEXT, n INTEGER, v TEXT, PRIMARY KEY(run, key, n)) WITHOUT ROWID;
"""
WATCHED = ("log.jsonl", "system.jsonl", "status.json", "meta.json", "config.json", "_sync.json", "_local.json")
_lock = threading.RLock()
_db = None
_db_path = None


def db():
    """The open index, made afresh if it is missing or was written by an older version of this file."""
    global _db, _db_path
    path = store.data_dir() / "index.sqlite"
    if _db is not None and _db_path == path:
        return _db
    path.parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(str(path), check_same_thread=False)
    if con.execute("PRAGMA user_version").fetchone()[0] != VERSION:
        for (name,) in con.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall():
            con.execute("DROP TABLE IF EXISTS %s" % name)
        con.execute("PRAGMA user_version=%d" % VERSION)
    con.execute("PRAGMA journal_mode=WAL")
    con.execute("PRAGMA synchronous=NORMAL")
    con.executescript(SCHEMA)
    _db, _db_path = con, path
    return con


def _signature(path):
    """A cheap fingerprint of a run folder: the size and time of each file that matters."""
    parts = []
    names = list(WATCHED)
    w = wandbfile.find(path)
    if w:
        names.append(os.path.basename(w))
    for name in names:
        try:
            st = os.stat(os.path.join(str(path), name))
            parts.append("%s:%d:%d" % (name, st.st_size, st.st_mtime_ns))
        except OSError:
            pass
    return "|".join(parts)


def _kind(v):
    if store.is_number(v):
        return "number"
    if isinstance(v, str):
        return None if v in ("NaN", "Infinity", "-Infinity") else "words"
    if isinstance(v, list) and v and all(isinstance(x, str) for x in v):
        return "words"
    return None


def _system_names(sample):
    """A sample of the machine as flat names. The W&B client's own names are kept; the tracker's are spelled the same way."""
    if isinstance(sample.get("all"), dict):
        return sample["all"]
    out = {k: v for k, v in sample.items() if k not in ("_t", "step", "gpu")}
    for g in sample.get("gpu") or []:
        for k, v in g.items():
            if k != "index":
                out["gpu.%s.%s" % (g.get("index", 0), k)] = v
    return out


def _ingest(con, run_id, records, start, stream, keys):
    lines, points, words = [], [], []
    for n in range(start, len(records)):
        rec = records[n]
        step, t = rec.get("step"), rec.get("_t")
        lines.append((run_id, stream, n, step if store.is_number(step) else None, t if store.is_number(t) else None))
        flat = store.flatten({k: v for k, v in rec.items() if k not in ("step", "_t", "all")}) if stream == 0 else _system_names(rec)
        for key, v in flat.items():
            if key.startswith("_"):
                continue
            kind = _kind(v)
            if kind is None:
                continue
            name = key if stream == 0 else "sys/" + key
            k = keys.get(name)
            if k is None:
                k = keys[name] = {"kind": kind, "n": 0, "last": None, "lo": None, "hi": None, "mono": 1}
            if kind == "number" and k["kind"] == "number":
                v = float(v)
                if not math.isfinite(v):
                    continue
                points.append((run_id, name, n, v))
                if k["n"] and isinstance(k["last"], (int, float)) and v < k["last"]:
                    k["mono"] = 0
                k["lo"] = v if k["lo"] is None else min(k["lo"], v)
                k["hi"] = v if k["hi"] is None else max(k["hi"], v)
                k["last"] = v
            else:
                k["kind"], k["mono"] = "words", 0
                text = json.dumps(v, ensure_ascii=False)
                words.append((run_id, name, n, text))
                k["last"] = text
            k["n"] += 1
    con.executemany("INSERT OR REPLACE INTO line VALUES(?,?,?,?,?)", lines)
    con.executemany("INSERT OR REPLACE INTO point VALUES(?,?,?,?)", points)
    con.executemany("INSERT OR REPLACE INTO word VALUES(?,?,?,?)", words)


def _forget(con, run_id):
    for table, col in (("runs", "id"), ("keys", "run"), ("line", "run"), ("point", "run"), ("word", "run")):
        con.execute("DELETE FROM %s WHERE %s=?" % (table, col), (run_id,))


def refresh(run_id=None):
    """Bring the index up to date with the folders: all runs, or one. Returns the summaries."""
    with _lock:
        con = db()
        known = {r[0]: r[1:] for r in con.execute("SELECT id, sig, lines, sys, summary FROM runs")}
        found = store.find_runs()
        if run_id is not None:
            found = [(i, p) for i, p in found if i == run_id]
        else:
            for gone in set(known) - {i for i, _ in found}:
                _forget(con, gone)
        out = []
        for rid, path in found:
            sig = _signature(path)
            old = known.get(rid)
            if old and old[0] == sig:
                out.append(json.loads(old[3]))
                continue
            log, system = store.log_of(path), store.system_of(path)
            done_log, done_sys = (old[1], old[2]) if old else (0, 0)
            if len(log) < done_log or len(system) < done_sys:
                _forget(con, rid)
                done_log = done_sys = 0
            keys = {r[0]: {"kind": r[1], "n": r[2], "last": r[3], "lo": r[4], "hi": r[5], "mono": r[6]}
                    for r in con.execute("SELECT key, kind, n, last, lo, hi, mono FROM keys WHERE run=?", (rid,))}
            _ingest(con, rid, log, done_log, 0, keys)
            _ingest(con, rid, system, done_sys, 1, keys)
            con.executemany("INSERT OR REPLACE INTO keys VALUES(?,?,?,?,?,?,?,?)",
                            [(rid, name, k["kind"], k["n"], k["last"], k["lo"], k["hi"], k["mono"]) for name, k in keys.items()])
            summary = store.summary(rid, path)
            con.execute("INSERT OR REPLACE INTO runs VALUES(?,?,?,?,?)", (rid, sig, len(log), len(system), json.dumps(summary)))
            out.append(summary)
        con.commit()
        return out


def keys_of(run_ids):
    """For each run, what it has logged: [{key, kind, n, last, lo, hi, mono}]."""
    with _lock:
        con = db()
        out = {}
        for rid in run_ids:
            out[rid] = [{"key": r[0], "kind": r[1], "n": r[2], "last": r[3] if r[1] == "number" else None, "lo": r[4], "hi": r[5], "mono": bool(r[6])}
                        for r in con.execute("SELECT key, kind, n, last, lo, hi, mono FROM keys WHERE run=? ORDER BY key", (rid,))]
        return out


def _thin(xs, ys, limit):
    """At most about `limit` points, keeping the lowest and highest of each stretch so that spikes survive."""
    n = len(xs)
    if n <= limit:
        return xs, ys
    size = n / (limit / 2.0)
    ox, oy, i = [], [], 0.0
    while int(i) < n:
        a, b = int(i), min(n, max(int(i) + 1, int(i + size)))
        lo = min(range(a, b), key=ys.__getitem__)
        hi = max(range(a, b), key=ys.__getitem__)
        for j in sorted({lo, hi}):
            ox.append(xs[j]); oy.append(ys[j])
        i += size
    return ox, oy


def series(run_id, key, x="step", limit=1500):
    """One number of one run against the chosen x: {"x": [...], "y": [...], "n": points before thinning}.

    x is "step", "_t" (seconds since the run's first line) or the name of another number the run logged.
    """
    with _lock:
        con = db()
        stream = 1 if key.startswith("sys/") else 0
        if x == "step" and stream == 0:
            rows = con.execute("SELECT l.step, p.v FROM point p JOIN line l ON l.run=p.run AND l.stream=0 AND l.n=p.n "
                               "WHERE p.run=? AND p.key=? AND l.step IS NOT NULL ORDER BY p.n", (run_id, key)).fetchall()
        elif x in ("_t", "step"):                           # the machine's samples have only a time
            t0 = con.execute("SELECT MIN(t) FROM line WHERE run=?", (run_id,)).fetchone()[0] or 0
            rows = con.execute("SELECT l.t - ?, p.v FROM point p JOIN line l ON l.run=p.run AND l.stream=? AND l.n=p.n "
                               "WHERE p.run=? AND p.key=? AND l.t IS NOT NULL ORDER BY p.n", (t0, stream, run_id, key)).fetchall()
        else:
            rows = con.execute("SELECT px.v, p.v FROM point p JOIN point px ON px.run=p.run AND px.key=? AND px.n=p.n "
                               "WHERE p.run=? AND p.key=? ORDER BY p.n", (x, run_id, key)).fetchall()
    xs, ys = [r[0] for r in rows], [r[1] for r in rows]
    tx, ty = _thin(xs, ys, limit)
    return {"x": tx, "y": ty, "n": len(xs)}


def timeline(run_id, key, only_changes=True, limit=3000):
    """A field that is not a number, one row per logged line: {"columns": [...], "rows": [{"step", "cells"}], "total"}.

    `key` is the name of the field ("sky.responds_to") or of the object that holds it ("sky"), in which case the
    object's numbers ride along as columns. With only_changes, rows whose words equal the row above are left out.
    """
    with _lock:
        con = db()
        like = key.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + ".%"
        cols = con.execute("SELECT key, kind FROM keys WHERE run=? AND (key=? OR key LIKE ? ESCAPE '\\') ORDER BY kind, key", (run_id, key, like)).fetchall()
        steps = dict(con.execute("SELECT n, step FROM line WHERE run=? AND stream=0", (run_id,)).fetchall())
        rows = {}
        for i, (name, kind) in enumerate(cols):
            table = "point" if kind == "number" else "word"
            for n, v in con.execute("SELECT n, v FROM %s WHERE run=? AND key=? ORDER BY n" % table, (run_id, name)):
                rows.setdefault(n, [None] * len(cols))[i] = v if kind == "number" else json.loads(v)
    word_cols = [i for i, c in enumerate(cols) if c[1] == "words"]
    out, last = [], object()
    for n in sorted(rows):
        sig = [rows[n][i] for i in word_cols]
        if only_changes and sig == last:
            continue
        last = sig
        out.append({"step": steps.get(n), "cells": rows[n]})
    short = lambda name: name[len(key) + 1:] if name.startswith(key + ".") else name.split(".")[-1]
    return {"columns": [{"key": c[0], "name": short(c[0]), "kind": c[1]} for c in cols], "rows": out[:limit], "shown": len(out), "total": len(rows)}


def search(query, per_field=40):
    """Text anywhere in the words runs have logged: for each run and field, the first step, a count and the first matches."""
    q = query.strip()
    if not q:
        return []
    like = "%" + q.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
    with _lock:
        rows = db().execute("SELECT w.run, w.key, l.step, w.v FROM word w JOIN line l ON l.run=w.run AND l.stream=0 AND l.n=w.n "
                            "WHERE w.v LIKE ? ESCAPE '\\' ORDER BY w.run, w.key, w.n", (like,)).fetchall()
    found, low = {}, q.lower()
    for run, key, step, text in rows:
        value = json.loads(text)
        if not any(low in w.lower() for w in (value if isinstance(value, list) else [value])):
            continue                                        # the text matched across the quoting, not inside a word
        f = found.setdefault(run, {}).setdefault(key, {"field": key, "first_step": step, "count": 0, "hits": []})
        f["count"] += 1
        if len(f["hits"]) < per_field:
            f["hits"].append({"step": step, "value": value})
    return [{"run": run, "fields": sorted(fields.values(), key=lambda f: (f["first_step"] is None, f["first_step"]))}
            for run, fields in sorted(found.items())]
