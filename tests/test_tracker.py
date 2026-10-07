"""Tests for the writer, the reader and the sync, using only folders on this machine.

Run with: python3 -m unittest discover tests
"""
import json, os, subprocess, sys, tempfile, time, unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
import tracker


def lines(path):
    return [json.loads(l) for l in Path(path).read_text().splitlines()]


class Writer(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.folder = Path(self.tmp.name) / "runs" / "a"

    def tearDown(self):
        self.tmp.cleanup()

    def start(self, **kw):
        kw.setdefault("system_every", 0.05)
        return tracker.start(str(self.folder), {"lam": 0.2, "features": 8192}, **kw)

    def test_files_and_fields(self):
        run = self.start(total=10, prediction="it will work")
        run.log(0, loss=1.5, sky={"feature": 7, "responds_to": [" sky", " skies"]})
        run.log(1, loss=float("nan"), big=float("inf"))
        weights = self.folder / "w.pt"
        weights.write_bytes(b"x" * 1000)
        run.save(str(weights))
        time.sleep(0.2)
        run.finish()
        self.assertEqual(json.loads((self.folder / "config.json").read_text()), {"lam": 0.2, "features": 8192})
        meta = json.loads((self.folder / "meta.json").read_text())
        self.assertEqual(meta["prediction"], "it will work")
        self.assertIn("git", meta); self.assertIn("command", meta); self.assertIn("host", meta)
        log = lines(self.folder / "log.jsonl")
        self.assertEqual(log[0]["sky"]["responds_to"], [" sky", " skies"])
        self.assertEqual((log[1]["loss"], log[1]["big"]), ("NaN", "Infinity"))      # strict JSON, no bare NaN
        self.assertNotIn("NaN,", (self.folder / "log.jsonl").read_text().replace('"NaN"', ""))
        art = lines(self.folder / "artifacts.jsonl")[0]
        self.assertEqual((art["path"], art["size"], art["step"], len(art["sha256"])), ("w.pt", 1000, 1, 64))
        self.assertGreaterEqual(len(lines(self.folder / "system.jsonl")), 1)
        status = json.loads((self.folder / "status.json").read_text())
        self.assertEqual((status["state"], status["step"], status["total"]), ("finished", 1, 10))

    def test_restart_continues_the_same_files(self):
        run = self.start(); run.log(0, loss=1.0); run.finish()
        run = tracker.start(str(self.folder), {"lam": 0.4, "features": 8192}, system_every=0)
        run.log(1, loss=0.5); run.finish()
        meta = json.loads((self.folder / "meta.json").read_text())
        self.assertEqual(len(meta["restarts"]), 1)
        self.assertEqual(meta["restarts"][0]["config"]["lam"], 0.4)
        self.assertEqual(json.loads((self.folder / "config.json").read_text())["lam"], 0.2)   # the first start is kept
        self.assertEqual([r["step"] for r in lines(self.folder / "log.jsonl")], [0, 1])

    def test_a_write_that_fails_does_not_raise(self):
        run = self.start(system_every=0)
        os.chmod(self.folder, 0o500)                        # the folder can no longer be written to
        try:
            run.log(1, loss=1.0)
            run.save("/no/such/file")
            run.finish()
        finally:
            os.chmod(self.folder, 0o700)
        blocked = tracker.start("/dev/null/cannot/exist", {"a": 1}, system_every=0)
        blocked.log(0, loss=1.0); blocked.finish()

    def test_odd_values_are_written_somehow(self):
        class Scalar:
            def item(self): return 2.5
        run = self.start(system_every=0)
        run.log(0, a=Scalar(), b={1, 2}, c=object(), d=(1, "x"))
        run.finish()
        rec = lines(self.folder / "log.jsonl")[0]
        self.assertEqual(rec["a"], 2.5); self.assertEqual(rec["d"], [1, "x"]); self.assertIsInstance(rec["c"], str)

    def script(self, body):
        code = "import sys; sys.path.insert(0, %r)\nimport tracker\nrun = tracker.start(%r, {}, system_every=0)\nrun.log(0, loss=1.0)\n%s" % (str(ROOT), str(self.folder), body)
        return subprocess.run([sys.executable, "-c", code], capture_output=True, text=True)

    def test_how_a_script_ends_is_recorded(self):
        self.script("")
        self.assertEqual(json.loads((self.folder / "status.json").read_text())["state"], "finished")
        self.script("raise ValueError('went wrong')")
        status = json.loads((self.folder / "status.json").read_text())
        self.assertEqual(status["state"], "failed"); self.assertIn("went wrong", status["error"])
        r = self.script("import os, signal; os.kill(os.getpid(), signal.SIGTERM)")
        status = json.loads((self.folder / "status.json").read_text())
        self.assertEqual(status["state"], "failed"); self.assertIn("signal", status["error"])
        self.assertEqual(r.returncode, -15)                 # the signal still ends the script as it would have


class ReaderAndSync(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.far = Path(self.tmp.name) / "far"
        os.environ["RUN_TRACKER_DATA"] = str(Path(self.tmp.name) / "data")
        from runtracker import store, sync
        self.store, self.sync = store, sync
        store.save_config({"sources": {"here": {"root": str(self.far)}}})

    def tearDown(self):
        self.tmp.cleanup()

    def test_only_new_bytes_and_big_files_stay(self):
        run = tracker.start(str(self.far / "a"), {"lam": 0.2}, system_every=0)
        run.log(0, loss=1.0, sky={"responds_to": [" ammon"]})
        (self.far / "a" / "w.pt").write_bytes(b"\0" * (self.sync.SMALL + 10))
        run.save(str(self.far / "a" / "w.pt"))
        said = []
        self.sync.sync_all(say=said.append)
        here = self.store.runs_dir() / "here" / "a"
        self.assertTrue((here / "log.jsonl").is_file()); self.assertFalse((here / "w.pt").exists())
        self.assertEqual(self.store.summary("here/a", here)["state"], "running")
        (here / "notes.md").write_text("mine")
        (self.far / "a" / "notes.md").write_text("theirs")

        with open(self.far / "a" / "log.jsonl", "a") as f:      # half a line, as a copy made mid-write would see
            f.write('{"step": 1, "loss": 0.')
        self.sync.sync_all(say=said.append)
        self.assertEqual(len(self.store.read_jsonl(here / "log.jsonl")), 1)
        with open(self.far / "a" / "log.jsonl", "a") as f:
            f.write('5, "sky": {"responds_to": [" sky", " heavens"]}}\n')
        run.finish()
        self.sync.sync_all(say=said.append)
        self.assertEqual((here / "log.jsonl").read_bytes(), (self.far / "a" / "log.jsonl").read_bytes())
        self.assertEqual([r["step"] for r in self.store.read_jsonl(here / "log.jsonl")], [0, 1])
        self.assertEqual((here / "notes.md").read_text(), "mine")
        d = self.store.detail("here/a")
        self.assertEqual((d["state"], d["files"][0]["path"], d["files"][0]["here"]), ("finished", "w.pt", False))

        found = self.store.search("heavens")
        self.assertEqual((found[0]["run"], found[0]["fields"][0]["field"], found[0]["fields"][0]["first_step"]), ("here/a", "sky.responds_to", 1))

        self.sync.fetch_file("here/a", "w.pt", say=said.append)
        self.assertEqual((here / "w.pt").stat().st_size, self.sync.SMALL + 10)
        self.assertIn("checksum matches", said)

    def test_states(self):
        s = self.store.state_of
        now = 1000.0
        beat = lambda age: {"state": "running", "heartbeat": now - age, "heartbeat_every": 20}
        self.assertEqual(s(beat(5), {"remote_time": now}, [])[0], "running")
        self.assertEqual(s(beat(500), {"remote_time": now, "job": {"state": "running"}}, [])[0], "stalled")
        self.assertEqual(s(beat(500), {"remote_time": now}, [])[0], "died")
        self.assertEqual(s(beat(5), {"remote_time": now, "job": {"state": "killed"}}, [])[0], "died")
        self.assertEqual(s({"state": "finished"}, {}, [])[0], "finished")
        self.assertEqual(s(None, {"job": {"state": "running"}, "remote_time": now, "files": {"log.jsonl": [1, now - 5]}}, [])[0], "running")
        self.assertEqual(s(None, {}, [])[0], "ended")
        quiet = [{"step": i, "_t": now - 4000 + i} for i in range(10)]      # logged every second, then nothing for an hour
        self.assertEqual(s(beat(5), {"remote_time": now}, quiet)[0], "stalled")

    def test_old_config_shape_is_lifted(self):
        self.assertEqual(self.store.settings({"args": {"lam": 0.2}, "device": "cuda"}), {"lam": 0.2, "device": "cuda"})


if __name__ == "__main__":
    unittest.main()
