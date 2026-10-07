"""The sync: copy run folders from where they are written to the laptop, bringing only what is new.

A source is a folder of run folders, either on a machine reached with ssh or on this one. For an
ssh source the connection already set up in ~/.ssh/config is used as it is; ssh is run in batch
mode, so it can never ask for a password. If the shared connection is not open, the sync says so
and stops.

One sync of one source is two round trips: one to list every file with its size (and ask the
scheduler about jobs), one to fetch the missing bytes of everything that changed.

  log files (.jsonl, .out, .err, .log)   only the bytes past what is already here
  small files                            whole, when their size or time has changed
  large files (weights)                  left where they are, and listed; `rt fetch` brings one
"""
import hashlib, os, shlex, subprocess, sys, time
from pathlib import Path

from . import store

APPEND = (".jsonl", ".out", ".err", ".log")
SMALL = 2 * 1024 * 1024                 # anything larger that is not a log is left on the far side
MARK = "=====run-tracker====="
LSF_STATES = {"PEND": "pending", "PROV": "pending", "WAIT": "pending", "RUN": "running", "DONE": "finished",
              "EXIT": "killed", "PSUSP": "suspended", "USUSP": "suspended", "SSUSP": "suspended",
              "UNKWN": "unknown", "ZOMBI": "unknown"}
SLURM_STATES = {"PENDING": "pending", "CONFIGURING": "pending", "RUNNING": "running", "COMPLETING": "running",
                "COMPLETED": "finished", "SUSPENDED": "suspended"}


class SyncError(Exception):
    pass


class Source:
    """A place runs come from. With ssh set, commands run there; without, they run here."""

    def __init__(self, name, spec):
        self.name, self.root = name, spec["root"].rstrip("/")
        self.ssh, self.scheduler = spec.get("ssh"), spec.get("scheduler")

    def run(self, script, stdout=subprocess.PIPE):
        """Run a shell script on the source and return what it printed, as bytes."""
        if self.ssh:
            cmd = ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=15", self.ssh, "bash -s"]
        else:
            cmd = ["bash", "-s"]
        try:
            r = subprocess.run(cmd, input=script.encode(), stdout=stdout, stderr=subprocess.PIPE, timeout=3600)
        except subprocess.TimeoutExpired:
            raise SyncError("%s: timed out" % self.name)
        if r.returncode == 255 and self.ssh:
            raise SyncError("%s: cannot reach it without asking for a password. Open the connection first with: ssh %s\n  (%s)"
                            % (self.name, self.ssh, (r.stderr.decode("utf-8", "replace").strip().splitlines() or [""])[-1]))
        return r.stdout if stdout == subprocess.PIPE else b""

    def listing(self):
        """The far clock, every file under the root as {path: (size, mtime)}, and the scheduler's jobs."""
        root = shlex.quote(self.root)
        # GNU find prints sizes itself; where find is not GNU (a Mac), stat does the same job.
        script = ("date +%%s\ncd %s 2>/dev/null || { echo NOROOT; exit 0; }\n"
                  "if find . -maxdepth 0 -printf '' 2>/dev/null; then find . -type f -printf '%%s\\t%%T@\\t%%P\\n'\n"
                  "else find . -type f -exec stat -f '%%z\t%%m\t%%N' {} +; fi\n"
                  "echo '%s'\n" % (root, MARK))
        if self.scheduler == "lsf":
            script += "bjobs -a -noheader -o \"jobid stat exit_code job_name output_file delimiter='|'\" 2>/dev/null\n"
        elif self.scheduler == "slurm":
            script += "squeue -u \"$USER\" -h -o '%i|%T||%j|%o' 2>/dev/null\n"
        text = self.run(script).decode("utf-8", "replace")
        head, _, tail = text.partition(MARK)
        lines = head.splitlines()
        if not lines or not lines[0].strip().isdigit():
            raise SyncError("%s: unexpected reply: %r" % (self.name, text[:200]))
        if len(lines) > 1 and lines[1].strip() == "NOROOT":
            raise SyncError("%s: no such folder: %s" % (self.name, self.root))
        files = {}
        for line in lines[1:]:
            parts = line.split("\t", 2)
            if len(parts) == 3:
                rel = parts[2][2:] if parts[2].startswith("./") else parts[2]
                try:
                    files[rel] = (int(parts[0]), float(parts[1]))
                except ValueError:
                    pass
        jobs = []
        table = LSF_STATES if self.scheduler == "lsf" else SLURM_STATES
        for line in tail.splitlines():
            c = [x.strip() for x in line.split("|")]
            if len(c) >= 5 and c[0].split("_")[0].isdigit():
                jobs.append({"id": c[0], "raw": c[1], "state": table.get(c[1], "killed" if self.scheduler == "slurm" else "unknown"),
                             "exit_code": None if c[2] in ("", "-") else c[2], "name": c[3], "output": c[4]})
        return int(lines[0]), files, jobs

    def fetch(self, ranges):
        """ranges: [(path under the root, offset, length)]. Returns the bytes of each, in order."""
        out = []
        for i in range(0, len(ranges), 200):
            part = ranges[i:i + 200]
            script = "cd %s || exit 1\n" % shlex.quote(self.root)
            for rel, off, length in part:
                script += "tail -c +%d %s | head -c %d\n" % (off + 1, shlex.quote(rel), length)
            blob = self.run(script)
            if len(blob) != sum(r[2] for r in part):
                # A file changed size between the listing and now. Take them one at a time and keep what fits.
                blob = b""
                for rel, off, length in part:
                    one = self.run("cd %s && tail -c +%d %s | head -c %d\n" % (shlex.quote(self.root), off + 1, shlex.quote(rel), length))
                    out.append(one if len(one) == length else None)
                continue
            pos = 0
            for _, _, length in part:
                out.append(blob[pos:pos + length]); pos += length
        return out


def sources(only=None):
    cfg = store.load_config()
    if only and only not in cfg["sources"]:
        raise SyncError("no source called %s; there are: %s" % (only, ", ".join(cfg["sources"]) or "none"))
    return [Source(n, s) for n, s in cfg["sources"].items() if not only or n == only]


def run_folders(files):
    """The run folders in a listing: the shallowest folders that hold one of the files a run always has."""
    dirs = sorted({os.path.dirname(f) for f in files if os.path.basename(f) in store.RUN_MARKERS}, key=len)
    keep = []
    for d in dirs:
        if not any(k == "" or d == k or d.startswith(k + "/") for k in keep):
            keep.append(d)
    return keep


def job_for(run_rel, source, meta, jobs, previous, now):
    """The scheduler's word on the job behind a run, matched by job number or by where the job writes its output."""
    want = str((meta or {}).get("job_id") or "")
    for entry in (meta or {}).get("restarts", []):
        want = str(entry.get("job_id") or want)
    folder = source.root + "/" + run_rel if run_rel else source.root
    mine = [j for j in jobs if (want and j["id"] == want) or j["output"].startswith(folder + "/")]
    if mine:
        j = dict(max(mine, key=lambda j: int(j["id"].split("_")[0])))
        j.pop("output", None)
        j["seen"] = now
        return j
    if previous:
        if previous.get("state") in ("pending", "running", "suspended", "unknown"):
            return {**previous, "state": "gone", "raw": "no longer listed"}    # it ended while we were not looking
        return previous
    return None


def sync_source(source, say=print):
    """Bring one source up to date. Returns the ids of the runs it holds."""
    there_now, files, jobs = source.listing()
    now = time.time()
    plans, ranges = [], []
    for run_rel in run_folders(files):
        prefix = run_rel + "/" if run_rel else ""
        local = store.runs_dir() / source.name / run_rel
        old = store.read_json(local / "_sync.json", {}) or {}
        mine = {f[len(prefix):]: v for f, v in files.items() if f.startswith(prefix)}
        big, todo = [], []
        for rel, (size, mtime) in sorted(mine.items()):
            base = os.path.basename(rel)
            if base.startswith("_") or ".tmp" in base:
                continue
            target = local / rel
            have = target.stat().st_size if target.is_file() else None
            if rel.endswith(".jsonl") or (rel.endswith(APPEND) and size <= 50 * SMALL):
                if have is None or have > size:
                    todo.append((rel, 0, size, "whole"))
                elif have < size:
                    todo.append((rel, have, size - have, "append"))
            elif size > SMALL:
                big.append(rel)
            elif rel == "notes.md" and have is not None:
                continue                                    # notes edited on the laptop are not overwritten
            elif have is None or (old.get("files", {}).get(rel) or [None, None]) != [size, mtime]:
                todo.append((rel, 0, size, "whole"))
        for rel, off, length, how in todo:
            ranges.append((prefix + rel, off, length))
        plans.append((run_rel, local, old, mine, big, todo))

    blobs = iter(source.fetch(ranges)) if ranges else iter(())
    ids = []
    for run_rel, local, old, mine, big, todo in plans:
        local.mkdir(parents=True, exist_ok=True)
        got, done = 0, {}
        for rel, off, length, how in todo:
            blob = next(blobs)
            if blob is None:
                continue                                    # it changed under us; next sync picks it up
            target = local / rel
            target.parent.mkdir(parents=True, exist_ok=True)
            if how == "append":
                with open(target, "ab") as f:
                    f.write(blob)
            else:
                tmp = target.with_name(target.name + ".part")
                tmp.write_bytes(blob)
                os.replace(tmp, target)
            got += length
            done[rel] = True
        # Remember each file's far size and time only once it is here, so a missed one is tried again.
        seen = dict(old.get("files", {}))
        failed = {t[0] for t in todo} - set(done)
        for rel, (size, mtime) in mine.items():
            if rel not in failed:
                seen[rel] = [size, mtime]
        meta = store.read_json(local / "meta.json", {})
        job = job_for(run_rel, source, meta, jobs, old.get("job"), now) if source.scheduler else None
        store.write_json(local / "_sync.json", {
            "source": source.name, "host": source.ssh or "this machine", "remote_path": source.root + ("/" + run_rel if run_rel else ""),
            "time": now, "remote_time": there_now, "files": seen, "big": big, "job": job})
        run_id = source.name + ("/" + run_rel if run_rel else "")
        ids.append(run_id)
        if got:
            say("  %-40s +%s" % (run_id, size_text(got)))
    return ids


def sync_all(only=None, say=print):
    """Sync every source (or one). Returns how many runs are still going."""
    going = 0
    srcs = sources(only)
    if not srcs:
        raise SyncError("no sources yet. Add one with: rt source add NAME --root /path/to/runs [--ssh HOST] [--scheduler lsf]")
    for source in srcs:
        say("%s (%s)" % (source.name, (source.ssh + ":" if source.ssh else "") + source.root))
        ids = sync_source(source, say)
        for run_id in ids:
            s = store.summary(run_id, store.runs_dir() / run_id)
            if s["state"] in ("running", "pending", "stalled"):
                going += 1
        say("  %d runs" % len(ids))
    return going


def watch(only=None, every=30, forever=False, say=print):
    """Sync again and again while any run is still going."""
    while True:
        try:
            going = sync_all(only, say)
        except SyncError as e:
            say(str(e)); going = 1
        if not going and not forever:
            say("nothing is running; stopping")
            return
        say("%d still going; next copy in %d s" % (going, every))
        time.sleep(every)


def fetch_file(run_id, rel, say=print):
    """Bring one large file of one run to the laptop, picking up where an earlier try left off."""
    path = store.run_path(run_id)
    sync = store.read_json(path / "_sync.json", {}) or {}
    source = next((s for s in sources() if s.name == sync.get("source")), None)
    if source is None:
        raise SyncError("%s was not copied from a source that is still configured" % run_id)
    run_rel = run_id[len(source.name) + 1:]
    far = (run_rel + "/" if run_rel else "") + rel
    entry = next((a for a in store.read_jsonl(path / "artifacts.jsonl") if a.get("path") == rel), {})
    size = (sync.get("files", {}).get(rel) or [entry.get("size")])[0]
    if size is None:
        raise SyncError("%s has no file called %s on the far side (sync first)" % (run_id, rel))
    target = path / rel
    target.parent.mkdir(parents=True, exist_ok=True)
    have = target.stat().st_size if target.is_file() else 0
    if have > size:
        have = 0; target.unlink()
    if have < size:
        say("fetching %s: %s of %s to go" % (rel, size_text(size - have), size_text(size)))
        with open(target, "ab") as f:
            source.run("cd %s && tail -c +%d %s | head -c %d\n" % (shlex.quote(source.root), have + 1, shlex.quote(far), size - have), stdout=f)
    if target.stat().st_size != size:
        raise SyncError("got %d of %d bytes; run the same command again to continue" % (target.stat().st_size, size))
    if entry.get("sha256"):
        h = hashlib.sha256()
        with open(target, "rb") as f:
            for block in iter(lambda: f.read(1 << 22), b""):
                h.update(block)
        if h.hexdigest() != entry["sha256"]:
            raise SyncError("%s arrived but its checksum does not match the one the run recorded" % rel)
        say("checksum matches")
    say("%s" % target)
    return str(target)


def size_text(n):
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024 or unit == "GB":
            return ("%d %s" if unit == "B" else "%.1f %s") % (n, unit)
        n /= 1024.0
