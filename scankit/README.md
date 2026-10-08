# run-tracker-scankit

The part of a scanner that is the same every time.

A scanner is the program behind the [Train Run Tracker](../README.md)'s Scan view: it runs text through a
trained network and answers the questions in the [scan contract](../docs/scan.md). Most of one does not
depend on the network. `scankit` carries that part, so an experiment writes only what is its own.

```sh
pip install "git+https://github.com/anuragrpatil23/run-tracker#subdirectory=scankit"
```

or copy `scankit.py` beside the experiment. It needs NumPy and nothing else.

## What you write

```python
import scankit

class Mine(scankit.Scanner):
    name = "My network"
    files = "step_*.pt"                    # which files under the runs folder are saved weights

    def load(self, path): ...              # read one file; what you return is kept as snapshot.data
    def tokens(self, text): ...            # [(token id, its text), ...]
    def run(self, ids, snapshot): ...      # {node id: numbers, one row per token}
    def graph(self, snapshot): ...         # the steps, for the drawing

scankit.serve(Mine(), runs="~/run-tracker-data/runs", port=8790)
```

Then tell the tracker where it is: `rt scan add <project> --url http://127.0.0.1:8790`.

Numbers can be NumPy arrays, PyTorch tensors, or anything NumPy converts. A node that is a grid of tokens
against tokens (attention) is marked `"per": "token-pair"` in the graph and returned as a square array;
use NaN for a cell that has no value.

Optional, on the same class: `next(ids)` for what the model would write next, `words(snapshot, node, units)`
for what units respond to, `usual(snapshot, node)` for each unit's usual level, `unit(snapshot, node, unit)`
for a unit's page, `terms(snapshot, node, unit, rows)` to say what a unit of a weighted-sum step reads, its weights
and its intercept (the kit then splits the unit's value for one token into its largest products), `step_of(path)` if the step is not the last number in a file's name, and `others()` for
weights that belong to no run.

## What the kit does

- The server, the routes, and every refusal in the contract's shape.
- Finding saved weights at any depth under the runs folder, their cold, loading and ready states, and
  loading in the background.
- Keeping the last 16 runs for follow-up questions.
- From plain rows: each token's strongest units, the grid, the row sizes, and how many units are on.
- The contrast between two texts, with the first difference marked.
- Recorded replies for building a view against: `scankit.record(scanner, runs, folder, text, other)`.
- A check of any running scanner against the contract: `python scankit.py check http://127.0.0.1:8790`.

## Two helpers

**PyTorch layers by name.** `scankit.hooked({"mlp.act": block.mlp.act, ...}, lambda: model(ids))` returns the
outputs of those layers, caught by forward hooks, so the forward pass is not written out by hand. It returns
an ordinary dict: add any step that is not one layer's output before returning it from `run()`.

**Sparse autoencoders.** Give `scankit.SparseAutoencoder` the detector table, the pattern table, the usual
level and the id of the step it reads. It then provides the three steps (`run`), what a feature is made of
and listens to, what leans on a unit (`unit`), and, given rows to test against and what each is called,
the words a feature responds to (`words`), kept on disk once worked out.

## A whole example

[`examples/toy.py`](examples/toy.py) is a complete scanner for a made-up network that counts the letters of
each word: about sixty lines. `python examples/toy.py --runs /tmp/toy --make --port 8799` serves it.

## Limits

One lock is held round every question that touches the model, so a slow one makes the others wait. That
suits one reader at a desk. Lining up two texts of different lengths, and switching a unit on or off by
hand (`steer`), are not built.
