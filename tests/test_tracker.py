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


class WandbFile(unittest.TestCase):
    """Reading the run file the W&B client writes offline. The fixture was written by client 0.30.0."""
    FIXTURE = ROOT / "tests" / "fixtures" / "run-offline-0.30.0.wandb"

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        os.environ["RUN_TRACKER_DATA"] = str(Path(self.tmp.name) / "data")
        from runtracker import store, sync, wandbfile
        self.store, self.sync, self.wb = store, sync, wandbfile

    def tearDown(self):
        self.tmp.cleanup()

    def test_the_whole_run_comes_back(self):
        r = self.wb.load(self.FIXTURE)
        self.assertEqual(len(r["log"]), 40)
        self.assertEqual([l["step"] for l in r["log"]][:3], [0, 10, 20])
        self.assertEqual(r["log"][-1]["sky"]["responds_to"], [" sky", " skies", " heavens"])
        self.assertIn("_t", r["log"][0]); self.assertNotIn("_runtime", r["log"][0])
        self.assertEqual(r["config"], {"lam": 0.2, "features": 8192, "nested": {"lr": 0.0002}})
        self.assertEqual((r["meta"]["name"], r["meta"]["wandb"]["project"], r["meta"]["host"]), ("trial_lam0.2", "sae-trial", "example-host"))
        self.assertEqual(r["status"]["state"], "finished")
        self.assertGreaterEqual(len(r["system"]), 1)

    def test_a_file_copied_part_way_reads_up_to_its_last_whole_record_and_then_continues(self):
        whole = self.FIXTURE.read_bytes()
        part = Path(self.tmp.name) / "run-part.wandb"
        seen = []
        for cut in (5, 7, 3000, 9999, 20001, len(whole)):       # including cuts in the middle of a record
            part.write_bytes(whole[:cut])
            try:
                r = self.wb.load(part)
            except ValueError:
                seen.append(-1); continue                        # five bytes are not yet a file of this kind
            seen.append(len(r["log"]))
            self.assertEqual(r["status"]["state"], "finished" if cut == len(whole) else "running")
        self.assertEqual(seen[-1], 40); self.assertEqual(seen, sorted(seen)); self.assertLess(seen[3], 40)
        self.assertEqual(r["log"], self.wb.load(self.FIXTURE)["log"])    # read in pieces, it is the same run

    def test_histograms_pictures_tables_and_what_the_script_said_about_its_metrics(self):
        import shutil
        from runtracker import index
        here = self.store.runs_dir() / "wb" / "rich"
        shutil.copytree(ROOT / "tests" / "fixtures" / "rich", here)
        run = index.refresh()[0]
        said = {m["name"]: m for m in run["metrics"]}
        self.assertEqual((said["val/*"]["step"], said["val/loss"]["summary"], said["val/accuracy"]["summary"]), ("epoch", ["min"], ["max"]))
        kinds = {k["key"]: k["kind"] for k in index.keys_of(["wb/rich"])["wb/rich"]}
        self.assertEqual((kinds["weights/encoder"], kinds["samples/pair"], kinds["top_tokens"], kinds["train/loss"]), ("histogram", "image", "table", "number"))
        self.assertFalse([k for k in kinds if k.endswith(("._type", ".bins", ".sha256", ".path"))])     # the parts of a picture are not charts
        h = index.media_of("wb/rich", "weights/encoder")["items"]
        self.assertEqual((len(h), len(h[0]["bins"]) - len(h[0]["values"]), sum(h[0]["values"])), (6, 1, 2000))
        shots = index.media_of("wb/rich", "samples/pair")["items"][0]
        self.assertEqual(([f["caption"] for f in shots["files"]], shots["step"]), (["a", "b"], 9.0))
        tables = index.media_of("wb/rich", "top_tokens")["items"]
        self.assertEqual((tables[-1]["columns"], tables[-1]["rows"][0], tables[0]["missing"]), (["token", "fires", "kind"], [" sky", 3.95, "word"], True))
        with self.assertRaises(KeyError):
            self.store.media_file("wb/rich", "../../../config.json")

    def test_a_folder_of_offline_runs_syncs_and_shows_like_any_other(self):
        far = Path(self.tmp.name) / "far" / "wandb" / "offline-run-20261006_212449-eyv8dqyf"
        (far / "logs").mkdir(parents=True); (far / "files").mkdir()
        (far / "run-eyv8dqyf.wandb").write_bytes(self.FIXTURE.read_bytes())
        (far / "logs" / "debug.log").write_text("noise"); (far / "files" / "requirements.txt").write_text("wandb")
        self.store.save_config({"sources": {"wb": {"root": str(far.parent)}}})
        self.sync.sync_all(say=lambda *_: None)
        run_id = "wb/offline-run-20261006_212449-eyv8dqyf"
        here = self.store.runs_dir() / run_id
        self.assertTrue((here / "run-eyv8dqyf.wandb").is_file()); self.assertFalse((here / "logs").exists())
        s = self.store.summary(run_id, here)
        self.assertEqual((s["name"], s["state"], s["step"], s["format"], s["project"]), ("trial_lam0.2", "finished", 390, "wandb", "sae-trial"))
        self.assertEqual(self.store.summary("x/plain", self.store.runs_dir() / "nowhere")["project"], "x")     # no project named: the source stands in
        self.store.save_config({"sources": {"wb": {"root": str(far.parent), "prefix": "dummy-", "paused": True}}})
        self.assertEqual(self.store.summary(run_id, here)["project"], "dummy-sae-trial")
        self.sync.sync_all(say=lambda *_: None)                                         # a paused source is passed over, not an error
        self.assertEqual(s["settings"], {"lam": 0.2, "features": 8192, "nested.lr": 0.0002})
        self.assertEqual(self.store.search("heavens")[0]["fields"][0]["field"], "sky.responds_to")


class Index(unittest.TestCase):
    """The SQLite index the viewer reads from, built from run folders and thrown away at will."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        os.environ["RUN_TRACKER_DATA"] = str(Path(self.tmp.name) / "data")
        from runtracker import index, store
        self.index, self.store = index, store
        self.folder = store.runs_dir() / "here" / "a"
        self.run = tracker.start(str(self.folder), {"lam": 0.2}, system_every=0)
        for step in range(0, 1000, 10):
            self.run.log(step, rows=step * 4, loss=1000.0 if step == 500 else 1.0 / (step + 1), bad=float("nan"),
                         sky={"feature": 7, "responds_to": [" ammon"] if step < 300 else [" sky", " heavens"]})

    def tearDown(self):
        self.tmp.cleanup()

    def test_what_was_logged_can_be_asked_for(self):
        runs = self.index.refresh()
        self.assertEqual([(r["id"], r["step"]) for r in runs], [("here/a", 990)])
        keys = {k["key"]: k for k in self.index.keys_of(["here/a"])["here/a"]}
        self.assertEqual((keys["loss"]["kind"], keys["rows"]["mono"], keys["loss"]["mono"], keys["sky.responds_to"]["kind"]), ("number", True, False, "words"))
        self.assertNotIn("bad", keys)                       # nothing but NaN was ever logged under it
        whole = self.index.series("here/a", "loss")
        self.assertEqual((whole["n"], whole["x"][:2]), (100, [0.0, 10.0]))
        thin = self.index.series("here/a", "loss", limit=20)
        self.assertLessEqual(len(thin["x"]), 22); self.assertIn(1000.0, thin["y"])     # thinned, and the spike is still there
        self.assertEqual(self.index.series("here/a", "loss", x="rows")["x"][1], 40.0)
        t = self.index.timeline("here/a", "sky")
        self.assertEqual(([c["name"] for c in t["columns"]], t["shown"], t["total"], t["rows"][1]["step"]), (["feature", "responds_to"], 2, 100, 300.0))
        found = self.index.search("heavens")
        self.assertEqual((found[0]["run"], found[0]["fields"][0]["first_step"], found[0]["fields"][0]["count"]), ("here/a", 300.0, 70))
        self.assertEqual(self.index.search("ammon\" "), [])

    def test_what_a_name_means_comes_from_the_script_and_can_be_rewritten_in_the_viewer(self):
        self.run.describe(loss="How wrong it is.", sky="The strongest feature for sky.")
        self.run.log(1000, loss=0.5)
        said = self.store.about(self.index.refresh(), "here")
        self.assertEqual((said["loss"], said["sky"]), ("How wrong it is.", "The strongest feature for sky."))
        self.store.set_about("here", "loss", "Lower is better.")
        self.store.set_about("here", "section:sky", "About the word sky.")
        said = self.store.about(self.index.refresh(), "here")
        self.assertEqual((said["loss"], said["sky"], said["section:sky"]), ("Lower is better.", "The strongest feature for sky.", "About the word sky."))
        self.assertEqual(self.store.about(self.index.refresh(), "another-project"), {})          # nothing is shared between projects

    def test_a_chart_can_be_worked_out_by_formula_from_what_was_logged(self):
        from runtracker import derived
        self.index.refresh()
        derived.save("here", "scaled", "loss * lam + 1")
        derived.save("here", "pace", "rate(rows, step)")
        derived.save("here", "needs_more", "loss + not_logged")
        derived.save("elsewhere", "other", "loss * 2")
        keys = [k["key"] for k in self.index.keys_of(["here/a"])["here/a"]]
        self.assertEqual(keys[:2], ["scaled", "pace"]); self.assertNotIn("needs_more", keys); self.assertNotIn("other", keys)
        s = self.index.series("here/a", "scaled")
        self.assertEqual((s["n"], s["x"][0]), (100, 0.0)); self.assertAlmostEqual(s["y"][0], 1.0 * 0.2 + 1)
        pace = self.index.series("here/a", "pace")
        self.assertEqual((pace["n"], pace["x"][0], pace["y"][0]), (99, 10.0, 4.0))          # four rows a step; no rate on the first line
        self.assertEqual(self.index.series("here/a", "scaled", x="rows")["x"][1], 40.0)
        for bad in ("__import__('os').system('true')", "open('x')", "loss if 1 else 2", "loss +", "rate(loss)"):
            with self.assertRaises(ValueError):
                derived.save("here", "bad", bad)
        derived.save("here", "scaled", "")
        self.assertNotIn("scaled", [k["key"] for k in self.index.keys_of(["here/a"])["here/a"]])

    def test_it_follows_a_run_that_grows_and_one_that_is_replaced(self):
        self.index.refresh()
        self.run.log(1000, loss=0.5)
        self.assertEqual(self.index.refresh()[0]["step"], 1000)
        self.assertEqual(self.index.series("here/a", "loss")["n"], 101)
        (self.folder / "log.jsonl").write_text('{"step": 0, "loss": 9.0}\n')
        self.assertEqual(self.index.refresh()[0]["step"], 0)
        self.assertEqual(self.index.series("here/a", "loss"), {"x": [0.0], "y": [9.0], "n": 1})
        import shutil; shutil.rmtree(self.folder)
        self.assertEqual(self.index.refresh(), [])


class Scan(unittest.TestCase):
    """The tracker's side of Scan, against a scanner for a toy network that is not a transformer."""

    def setUp(self):
        import threading
        self.tmp = tempfile.TemporaryDirectory()
        os.environ["RUN_TRACKER_DATA"] = str(Path(self.tmp.name) / "data")
        sys.path.insert(0, str(ROOT / "tests"))
        import toy_scanner
        from runtracker import scan
        self.scan = scan
        self.server = toy_scanner.serve()
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.url = "http://127.0.0.1:%d" % self.server.server_address[1]

    def tearDown(self):
        self.server.shutdown(); self.server.server_close(); self.tmp.cleanup()

    def ask(self, route, method="GET", query="", body=None):
        status, reply = self.scan.forward("toys", route, method, query, json.dumps(body).encode() if body is not None else b"")
        return status, json.loads(reply)

    def test_requests_are_passed_on_and_replies_and_refusals_come_back(self):
        self.assertEqual(self.ask("health")[1]["error"]["code"], "no_scanner")
        self.scan.set_address("toys", self.url)
        self.assertEqual(self.scan.all_addresses(), {"toys": self.url})
        status, health = self.ask("health")
        self.assertEqual((status, health["protocol"], health["max_tokens"]), (200, 1, 32))
        graph = self.ask("graph", query="snapshot=toy%4010")[1]
        self.assertEqual([n["id"] for n in graph["nodes"]], ["letters", "mix", "scores"])
        run = self.ask("run", "POST", body={"text": "the sky is blue", "snapshot": "toy@10", "top": 4})[1]
        self.assertEqual(([t["text"] for t in run["tokens"]], len(run["nodes"]["mix"]["grid"]["values"])), (["the", "sky", "is", "blue"], 4))
        self.assertEqual(len(self.ask("values", query="run=%s&node=letters&token=1" % run["run"])[1]["values"]), 26)
        differ = self.ask("contrast", "POST", body={"a": "the sky is blue", "b": "the sea is blue", "node": "mix"})[1]
        self.assertEqual([p["same_text"] for p in differ["per_pair"]], [True, False, True, True])
        self.assertEqual(self.ask("graph", query="snapshot=nope"), (404, {"error": {"code": "unknown_snapshot", "message": "there is no snapshot nope"}}))
        self.assertEqual(self.ask("contrast", "POST", body={"a": "one two", "b": "one"})[1]["error"]["code"], "bad_request")
        self.assertEqual(self.ask("health", "POST")[1]["error"]["code"], "bad_request")       # only the contract's routes, by its methods
        self.assertEqual(self.ask("../../etc/passwd")[1]["error"]["code"], "bad_request")

    def test_a_scanner_must_be_on_this_machine_and_answering(self):
        for bad in ("http://example.com:8790", "https://127.0.0.1:8790", "http://127.0.0.1", "http://127.0.0.1:8790/elsewhere", "http://user@127.0.0.1:8790", "file:///etc/passwd"):
            with self.assertRaises(ValueError):
                self.scan.set_address("toys", bad)
        self.scan.store.write_json(self.scan.store.project_dir("toys") / "scan.json", {"url": "http://example.com:80"})     # written by hand: still refused
        self.assertEqual(self.ask("health")[1]["error"]["code"], "no_scanner")
        self.scan.set_address("toys", "http://127.0.0.1:9")                              # nothing listens there
        self.assertEqual(self.ask("health"), (502, self.ask("health")[1])); self.assertEqual(self.ask("health")[1]["error"]["code"], "unreachable")
        self.scan.set_address("toys", "")
        self.assertEqual(self.scan.all_addresses(), {})


if __name__ == "__main__":
    unittest.main()
