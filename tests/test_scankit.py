"""Tests for scankit, the kit scanners are built on. They need NumPy, which the tracker itself does not, so they are
skipped where it is missing.

Run with: python3 -m unittest discover tests
"""
import json, os, sys, tempfile, threading, unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scankit")); sys.path.insert(0, str(ROOT / "scankit" / "examples"))
try:
    import numpy as np
    import scankit, toy
except ImportError:
    np = None


@unittest.skipIf(np is None, "NumPy is not installed")
class Kit(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        toy.make(self.tmp.name)
        self.server = scankit.server(toy.Toy(), self.tmp.name, port=0)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.url = "http://127.0.0.1:%d" % self.server.server_address[1]

    def tearDown(self):
        self.server.shutdown(); self.server.server_close(); self.tmp.cleanup()

    def test_a_scanner_written_on_the_kit_keeps_to_the_contract(self):
        said = []
        self.assertTrue(scankit.check(self.url, say=said.append), "\n".join(said))
        self.assertGreaterEqual(len([l for l in said if l.startswith("  ok")]), 16)

    def test_what_the_view_draws_is_worked_out_from_plain_rows(self):
        kit = self.server.kit
        self.assertEqual([s["id"] for s in kit.list()["snapshots"]], ["toy@0", "toy@10"])
        self.assertIn(kit.list()["default"], ("toy@0", "toy@10"))           # the largest file, then the latest step
        snap = kit.snapshot("toy@10", ready=False)
        with self.assertRaises(scankit.Problem):
            kit.snapshot("toy@10")                                      # not loaded yet
        kit.load_now(snap)
        r = kit.run("the sky is blue", snap, top=4)
        mix = r["nodes"]["mix"]
        self.assertEqual([t["text"] for t in r["tokens"]], ["the", "sky", "is", "blue"])
        self.assertEqual(len(mix["grid"]["values"]), 4); self.assertEqual(len(mix["grid"]["values"][0]), len(mix["grid"]["units"]))
        self.assertTrue(all(len(row) <= 4 and all(v != 0 for _, v, _ in row) for row in mix["top"]))        # strongest only, and none that are off
        peaks = [max(abs(row[j]) for row in mix["grid"]["values"]) for j in range(len(mix["grid"]["units"]))]
        self.assertEqual(peaks, sorted(peaks, reverse=True))                                              # the strongest anywhere comes first
        self.assertEqual(len(mix["grid"]["words"][0]), 3); self.assertEqual(len(mix["on"]), 4)
        self.assertEqual(len(kit.values(r["run"], "letters", 1, 0, 4096)["values"]), 26)
        c = kit.contrast("the sky is blue", "the sea is blue", snap, "mix")
        self.assertEqual((c["first_difference"], [p["same_text"] for p in c["per_pair"]]), (1, [True, False, True, True]))
        self.assertEqual(c["per_pair"][0]["distance"], 0.0)
        self.assertEqual(kit.unit(snap, "mix", 0)["words_test"], "each letter on its own")
        self.assertNotIn("terms", kit.unit(snap, "mix", 0))                                               # only when a run and token are named
        u = mix["top"][1][0][0]                                                                           # the strongest unit for "sky"
        t = kit.unit(snap, "mix", u, r["run"], 1)["terms"]
        self.assertEqual((t["node"], t["count"]), ("letters", 26))
        self.assertTrue(all(p["product"] > 0 for p in t["top"]) and all(p["product"] < 0 for p in t["bottom"]))
        self.assertAlmostEqual(sum(p["product"] for p in t["top"] + t["bottom"]) + t["rest"] + t["intercept"], t["sum"], places=3)
        self.assertAlmostEqual(t["sum"], mix["top"][1][0][1], places=3)                                  # the sum is the value shown, since it is above zero
        full = kit.unit(snap, "mix", u, r["run"], 1, whole=True)["terms"]
        self.assertEqual((len(full["weights"]), len(full["inputs"]), "weights" in t), (26, 26, False))
        self.assertEqual(len(r["nodes"]["letters"]["head"][0]), 26); self.assertNotIn("head", mix)        # first units in order; not for a sparse step
        self.assertNotIn("terms", kit.unit(snap, "letters", 0, r["run"], 1))                              # not a weighted sum: nothing to split
        for bad, code in ((lambda: kit.unit(snap, "mix", 99), "unknown_unit"), (lambda: kit.values("nope", "mix", 0, 0, 1), "unknown_run"),
                          (lambda: kit.contrast("a b", "a", snap, "mix"), "bad_request"), (lambda: kit.run(" ".join(["w"] * 99), snap), "too_long")):
            with self.assertRaises(scankit.Problem) as e:
                bad()
            self.assertEqual(e.exception.code, code)

    def test_a_sparse_autoencoder_from_three_tables(self):
        rng = np.random.default_rng(0)
        detector, pattern, usual, bias = rng.normal(size=(40, 8)), rng.normal(size=(8, 40)), rng.normal(size=8), rng.normal(size=40) - 1
        probe, names = rng.normal(size=(30, 8)), ["w%d" % i for i in range(30)]
        cache = os.path.join(self.tmp.name, "weights.words.json")
        made = []
        sae = scankit.SparseAutoencoder(detector, bias, pattern, usual, reads="neurons", probe=lambda: made.append(1) or probe, probe_words=names, test="thirty made-up rows", cache=cache)
        x = rng.normal(size=(5, 8))
        out = sae.run(x)
        feats = np.maximum((x - usual) @ detector.T + bias, 0)
        np.testing.assert_allclose(out["sae.features"], feats, rtol=1e-5); np.testing.assert_allclose(out["sae.rebuild"], feats @ pattern.T + usual, rtol=1e-4, atol=1e-4)
        u = int(np.argmax(np.maximum((probe - usual) @ detector.T + bias, 0).max(0)))
        page = sae.unit("sae.features", u)
        self.assertEqual(page["made_of"]["node"], "neurons"); self.assertEqual(len(page["made_of"]["top"]), 8)
        self.assertLessEqual(page["made_of"]["half"], page["made_of"]["ninety"])
        self.assertAlmostEqual(page["agreement"], float(pattern[:, u] / np.linalg.norm(pattern[:, u]) @ (detector[u] / np.linalg.norm(detector[u]))), places=3)
        best = names[int(np.argmax(np.maximum((probe - usual) @ detector[u] + bias[u], 0)))]
        self.assertEqual((page["words"][0][0], page["words_test"]), (best, "thirty made-up rows"))
        self.assertEqual(sae.unit("neurons", 3)["used_by"]["node"], "sae.features")
        again = scankit.SparseAutoencoder(detector, bias, pattern, usual, reads="neurons", probe=lambda: self.fail("worked out again"), probe_words=names, test="thirty made-up rows", cache=cache)
        self.assertEqual(again.words([u]), sae.words([u])); self.assertEqual(len(made), 1)                # kept on disk, not worked out twice

    def test_outputs_of_named_layers_are_collected(self):
        class Layer:                                                    # stands in for a PyTorch module
            def __init__(self): self.hooks = []
            def register_forward_hook(self, f):
                self.hooks.append(f)
                return type("Handle", (), {"remove": lambda h: self.hooks.remove(f)})()
            def __call__(self, x):
                out = x + 1
                for f in list(self.hooks): f(self, (x,), out)
                return out
        a, b = Layer(), Layer()
        got = scankit.hooked({"first": a, "second": b}, lambda: b(a(np.zeros(3))))
        self.assertEqual((got["first"].tolist(), got["second"].tolist()), ([1, 1, 1], [2, 2, 2])); self.assertEqual(a.hooks + b.hooks, [])


if __name__ == "__main__":
    unittest.main()
