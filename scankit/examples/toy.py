"""A whole scanner in a page: a made-up network that counts the letters of each word.

It is not a transformer and has no trained weights worth the name. It is here to show what an experiment writes on top
of scankit, and to hold the Scan view to assuming no one kind of network.

    python toy.py --runs /some/folder --port 8799        (a folder holding toy_*.json files; --make writes two)
"""
import argparse, json, os, random, sys

import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
import scankit

LETTERS, MIX, OUT = 26, 12, 3


class Toy(scankit.Scanner):
    name = "A toy network that counts letters"
    max_tokens = 32
    files = "toy_*.json"                                  # its "saved weights": two small tables in a JSON file

    def load(self, path):
        with open(path) as f:
            w = json.load(f)
        return {"mix": np.array(w["mix"]), "out": np.array(w["out"])}

    def tokens(self, text):
        return [(word, word) for word in text.split()]    # a token is a word, and the word is its own id

    def graph(self, snapshot):
        node = lambda id, label, kind, width, order, **more: dict({"id": id, "label": label, "group": None, "kind": kind, "width": width, "per": "token", "lane": 0, "order": order}, **more)
        return {"title": self.name, "groups": [{"id": "body", "label": "Mixing"}],
                "nodes": [node("letters", "Letter counts", "lookup", LETTERS, 0, unit="letter", about="How many of each letter the word has."),
                          node("mix", "Mixed", "linear+bend", MIX, 1, group="body", bend="ReLU", unit="unit", weights=LETTERS * MIX, sparse=True, described=True,
                               about="Twelve weighted sums of the letter counts, with anything below zero set to zero."),
                          node("scores", "Scores", "linear", OUT, 2, unit="score", weights=MIX * OUT, about="Three weighted sums of the mixed units.")],
                "edges": [{"from": "letters", "to": "mix"}, {"from": "mix", "to": "scores"}]}

    def run(self, ids, snapshot):
        letters = np.array([[w.lower().count(chr(97 + i)) for i in range(LETTERS)] for w in ids], dtype=float)
        mix = np.maximum(letters @ snapshot.data["mix"].T, 0)
        return {"letters": letters, "mix": mix, "scores": mix @ snapshot.data["out"].T}

    def words(self, snapshot, node, units):               # what a mixed unit responds to: the letters it weighs most
        return [[chr(97 + int(i)) for i in scankit.strongest(snapshot.data["mix"][u], 3)] for u in units]

    def terms(self, snapshot, node, unit, rows):          # how a mixed unit's value was made for one word
        return {"node": "letters", "weights": snapshot.data["mix"][unit], "input": rows["letters"], "intercept": 0.0} if node == "mix" else None

    def unit(self, snapshot, node, unit):
        w = snapshot.data["mix"]
        if node == "mix":
            best = scankit.strongest(w[unit], 5)
            half, ninety = scankit.spread(w[unit])
            return {"words": [[chr(97 + int(i)), scankit.r4(w[unit][i])] for i in best], "words_test": "each letter on its own",
                    "listens_to": {"node": "letters", "top": [[int(i), scankit.r4(w[unit][i])] for i in best], "half": half, "ninety": ninety}}
        if node == "letters":
            return {"used_by": {"node": "mix", "count": MIX, "top": [[int(m), scankit.r4(w[m][unit]), None] for m in scankit.strongest(w[:, unit], 5)]}}
        return {}


def make(folder):
    """Write two sets of made-up weights, as a run called toy with two saved steps."""
    os.makedirs(os.path.join(folder, "toy"), exist_ok=True)
    for step in (0, 10):
        rng = random.Random(step)
        with open(os.path.join(folder, "toy", "toy_%d.json" % step), "w") as f:
            json.dump({"mix": [[rng.uniform(-1, 1) for _ in range(LETTERS)] for _ in range(MIX)], "out": [[rng.uniform(-1, 1) for _ in range(MIX)] for _ in range(OUT)]}, f)


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--runs", required=True); p.add_argument("--port", type=int, default=8799); p.add_argument("--make", action="store_true")
    a = p.parse_args()
    if a.make:
        make(a.runs)
    scankit.serve(Toy(), a.runs, a.port)
