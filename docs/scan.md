# Scan: running text through a network inside the tracker

A second spec for the Train Run Tracker, written 2026-10-07 and revised the same day after the session building the tracker half read it. The first, [run-tracker-spec](run-tracker-spec.md), covered watching training runs. This one adds a view where you type text, run it through a trained network, and see what lit up, in the way a person in a scanner is shown things while their brain is imaged.

It has two halves that are built separately and meet at one written contract.

- **The scanner** belongs to the experiment. It is a small program that has PyTorch, loads the model and any networks trained on it, and answers questions about them. The first one lives in `Learn-AI/train-sparse-autoencoder/` and serves GPT-2 small with the sparse autoencoders trained on its first block.
- **The Scan view** belongs to the tracker. It knows the contract and nothing else. It never imports PyTorch and never assumes GPT-2, a transformer, or a sparse autoencoder.

This split is what keeps the tracker's two standing rules intact: no Python dependencies, and no assumption about the kind of model.

## What the reader can do in version 1

1. **See the network.** A drawing of the model as the scanner describes it: its steps in order, how wide each is, where a branch leaves the main path and where it rejoins, and where a trained network such as a sparse autoencoder is attached.
2. **Run text.** Type any text, press run, and every step in the drawing shows what it produced for each word.
3. **See what lit up.** Under each word, the units that responded most at the chosen step, each with a short description of what it responds to where the scanner can supply one.
4. **Open a unit.** Click a feature and see which neurons make it up. Click a neuron and see which features lean on it.
5. **Contrast two texts.** Run two texts, such as "the sky is blue" and "the sea is blue", and see only what differs between them.
6. **Change the snapshot.** Choose which saved point of which training run is loaded, so the same text can be run through a network at the start of training, partway, and at the end.

Switching a unit on or off by hand and watching what the model then writes is the natural next thing. The contract reserves a place for it and version 1 does not build it.

## How the two halves find each other

- The scanner is started by the person, from the experiment's own Python: `python scan_server.py --runs <folder of copied runs> --port 8790`. It listens on 127.0.0.1 only.
- The tracker is told where it is, per project: `rt scan add <project> --url http://127.0.0.1:8790`, kept in the data folder beside the other per-project settings.
- The browser never talks to the scanner directly. The tracker's server forwards `/api/v2/scan/<project>/...` to the scanner's `/scan/v1/...` with the standard library, and refuses any scanner address that is not on 127.0.0.1. This keeps one origin and needs no cross-origin setup.
- If no scanner is configured or it does not answer, the Scan view says so and shows the command to start one. Nothing else in the tracker changes.

The tracker does not start the scanner in version 1. Doing so would mean the tool launches a program that can use the GPU, which should be its own decision later.

## The contract

All requests and replies are JSON over HTTP. Every reply either has the fields below or is `{"error": {"code": "...", "message": "..."}}` with a matching HTTP status. Codes a scanner uses: `bad_request`, `unknown_snapshot`, `unknown_node`, `unknown_unit`, `unknown_run`, `too_long`, `not_loaded`, `internal`. Three more are reserved for the tracker's forwarder and a scanner never sends them: `no_scanner` (none configured for the project), `unreachable` (configured, not answering) and `bad_protocol`. A scanner's own errors pass through the forwarder unchanged, with their status. The forwarder waits at most 120 seconds on any call.

Words used below. A **node** is one step of the network that produces numbers: a layer, an attention grid, a sparse autoencoder's features. A **unit** is one column of a node: a neuron, a channel, a feature. A **snapshot** is one saved set of trained weights that can be loaded. A **token** is one piece of text as the model splits it.

### `GET /scan/v1/health`

```json
{"ok": true, "protocol": 1, "name": "GPT-2 small with sparse autoencoders", "device": "cpu",
 "max_tokens": 64, "supports": ["run", "values", "unit", "contrast", "load"]}
```

The tracker checks `protocol` and refuses a number it does not know. `supports` lists the routes this scanner answers beyond `health`, `snapshots` and `graph`, which every scanner must. The view greys out what a scanner lacks, which is what lets a very simple scanner be a valid one.

### `GET /scan/v1/snapshots`

What can be loaded. The scanner lists only weights that are on this machine, and looks again each time it is asked.

```json
{"snapshots": [
  {"id": "sae/f32768_lam0.2@48828", "label": "32,768 features, step 48,828", "run": "sae/f32768_lam0.2",
   "step": 48828, "bytes": 402798991, "state": "ready"},
  {"id": "openai-mlp0", "label": "OpenAI, 32,768 features", "run": null, "step": null, "bytes": 805713996, "state": "cold"}
 ], "default": "sae/f32768_lam0.2@48828", "files": "step_*.pt"}
```

- `run` is the path of the run's folder relative to the folder the scanner was started with (`--runs`). When that folder is the tracker's own copy of the runs, this is exactly the tracker's run id, so the view can link a snapshot to its run and fetch more of its weights. `run` is `null` for a snapshot that belongs to no run.
- Snapshot files are found at any depth under `--runs`, since a run logged with the W&B client keeps them in a nested folder.
- `files` is the pattern of file names that are snapshots. The tracker uses it to find, in its own list of a run's files, the ones not yet fetched, and offers to fetch them. After a fetch it asks for `snapshots` again.
- `state` is `ready` (loaded, answers at once), `cold` (on disk, not loaded) or `loading`.

### `POST /scan/v1/load`

```json
{"snapshot": "sae/f32768_lam0.2@48828"}
```

Starts loading a snapshot and returns at once with `{"state": "loading"}` or `{"state": "ready"}`. Loading several hundred megabytes and working out what each unit responds to can take longer than a request should wait, so `run`, `unit` and `contrast` on a snapshot that is not `ready` answer `not_loaded` quickly. The view calls `load` and asks for `snapshots` until the state is `ready`.

### `GET /scan/v1/graph?snapshot=<id>`

The network, as something that can be drawn without knowing what kind it is.

```json
{"title": "GPT-2 small, first block, with a sparse autoencoder",
 "groups": [{"id": "attention", "label": "Attention"}, {"id": "mlp", "label": "MLP"},
            {"id": "sae", "label": "Sparse autoencoder", "attached": true}],
 "nodes": [
   {"id": "embed", "label": "Embedding", "group": null, "kind": "lookup", "width": 768, "per": "token",
    "lane": 0, "order": 0, "about": "Each word picks a row from the word table and one from the position table."},
   {"id": "b0.mlp.act", "label": "MLP neurons", "group": "mlp", "kind": "linear+bend", "bend": "GELU",
    "width": 3072, "per": "token", "lane": -1, "order": 12, "weights": 2362368, "unit": "neuron"},
   {"id": "sae.features", "label": "Features", "group": "sae", "kind": "linear+bend", "bend": "ReLU",
    "width": 32768, "per": "token", "lane": -2, "order": 19, "weights": 100696064, "unit": "feature",
    "sparse": true, "described": true},
   {"id": "rest", "label": "11 more blocks", "group": null, "kind": "collapsed", "lane": 0, "order": 20}
 ],
 "edges": [{"from": "b0.ln2", "to": "b0.mlp.act"}, {"from": "b0.mlp.act", "to": "sae.in", "kind": "reads"},
           {"from": "embed", "to": "b0.add1", "kind": "carried"}]}
```

Fields of a node:

| field | meaning |
|---|---|
| `id`, `label`, `about` | a stable name, what to show, and one sentence saying what the step does |
| `kind` | one of `lookup`, `norm`, `linear`, `linear+bend`, `scores`, `weights-over-positions`, `mix`, `add`, `difference`, `collapsed`, `other`; a `collapsed` node stands for steps that are not drawn or run, has no numbers, and needs only `id`, `label`, `lane` and `order`; the drawing picks a symbol from it and shows unknown kinds as a plain box |
| `width` | how many units it has; the drawing sizes the node by this, on a compressed scale |
| `each` | optional: how wide one unit is, meaning how many numbers it reads and so how many slopes it has. A step's two sizes are easy to confuse, so the drawing shows both: "3,072 neurons, each 768 wide" |
| `per` | `token` if it has one row per token, `token-pair` if it is a grid of tokens against tokens |
| `lane`, `order` | where to place it, both integers: `order` runs left to right, `lane` 0 is the main path, positive lanes are above it and negative below. Steps that happen side by side in different lanes may share an `order`; within one lane it is unique. The view lays out columns by `order` and rows by `lane` |
| `group` | which box it sits in, or `null`. A group only ever boxes real nodes |
| `weights` | how many weights the step has, if any |
| `unit` | what one column is called: `neuron`, `channel`, `feature` |
| `bend` | the name of the nonlinearity, if any |
| `sparse` | true if most units are exactly zero for any one token; the view then shows the units that are on, not a window |
| `described` | true if the scanner can say what a unit responds to |

Fields of an edge: `from`, `to`, and `kind`, one of `flow` (the default), `carried` (the main path passing a branch unchanged, drawn dashed), or `reads` (a separate network reading a step without feeding anything back).

### `POST /scan/v1/run`

```json
{"text": "Q: Why is the sky blue?\nA:", "snapshot": "sae/f32768_lam0.2@48828", "top": 12}
```

Reply:

```json
{"run": "r7f3a", "snapshot": "sae/f32768_lam0.2@48828",
 "tokens": [{"i": 0, "text": "Q", "id": 48}, {"i": 1, "text": ":", "id": 25}],
 "nodes": {
   "b0.mlp.act": {"size": [16.2, 9.2], "top": [[[1572, 2.96], [2012, 2.2]], [[88, 1.4]]],
                  "grid": {"units": [1572, 2012, 88], "values": [[2.96, 2.2, 0.1], [0.3, -0.2, 1.4]], "words": null}},
   "sae.features": {"on": [116, 154], "size": [3.6, 1.9],
                    "top": [[[14925, 10.4, [" sky", " skies"]]], [[977, 6.2, [":", " :"]]]],
                    "grid": {"units": [14925, 977], "values": [[10.4, 0], [0, 6.2]], "words": [[" sky", " skies"], [":", " :"]]}},
   "b0.att": {"grid": [[1, 0], [0.4, 0.6]]}
 },
 "next": [{"text": " The", "chance": 0.21}]}
```

- `tokens[].i` runs from 0 to n-1 with no gaps.
- `size` is one number per token: the length of that token's row at that node.
- `top` is, per token, the `top` largest units by absolute value as `[unit, value]`, with a third item, a short list of words the unit responds to, where the node is `described`.
- `grid` is what the view draws for the node. For a `token` node it is the union of every token's top units, strongest first and at most 48 of them, as `units`; `values` with one row per token and one number per unit, so that a unit outside a token's own top still has its value; and `words`, one list or `null` per unit, or `null` for the whole node if it is not `described`. For a `token-pair` node `grid` is the full n by n table, row for the token looking and column for the token looked at, and the node has no `top` or `size`.
- `on` is, per token, how many units are not zero, for `sparse` nodes.
- `next` is what the model would write next, when it can say.
- `run` names this result for follow-up questions. The scanner keeps at least the last 8 results and answers `unknown_run` for older ones.
- Text longer than `max_tokens` gets `too_long` with the limit in the message.

### `GET /scan/v1/values?run=<run>&node=<id>&token=<i>&from=<n>&count=<n>`

The plain numbers for one token at one node, a slice of units at a time, for drawing a strip. `count` is at most 4096.

```json
{"from": 0, "count": 3072, "values": [0.09, -0.17, -0.17], "usual": [0.2, -0.06, -0.08]}
```

`usual` is included where the scanner knows each unit's usual level.

For a `token-pair` node, leave out `from` and `count` and the reply is that token's row over the tokens: `{"values": [0.02, 0.4, ...]}`.

### `GET /scan/v1/unit?snapshot=<id>&node=<id>&unit=<n>`

What one unit is. Fields are present only where they apply.

```json
{"node": "sae.features", "unit": 14925, "words": [[" sky", 10.4], [" skies", 9.1]],
 "words_test": "every token placed after \"Q: Why is the\"",
 "made_of": {"node": "b0.mlp.act", "top": [[1572, 0.28], [2012, 0.2]], "half": 37, "ninety": 521},
 "listens_to": {"node": "b0.mlp.act", "top": [[1572, 0.11]], "half": 347, "ninety": 1316},
 "fires_on": 0.0031}
```

- `words` and `words_test`: what the unit responds to, and the test that was used to find out, stated in words so the view can show it. A unit's description is evidence, not a name.
- `made_of`: for a feature, the units of an earlier node it adds back, with how many of them carry half and ninety percent of it.
- `listens_to`: for a feature, the units it reads from.
- `fires_on`: the share of tokens it is on for, if known.

For a neuron the reply instead has `used_by`: the features that lean on it most.

```json
{"node": "b0.mlp.act", "unit": 1572,
 "used_by": {"node": "sae.features", "count": 99, "top": [[3740, 0.94, [" motorists", " skies"]], [18872, 0.32, [" air", " Air"]]]}}
```

### `POST /scan/v1/contrast`

```json
{"a": "the sky is blue", "b": "the sea is blue", "snapshot": "sae/f32768_lam0.2@48828", "node": "sae.features", "top": 12}
```

Reply:

```json
{"run_a": "r7f3b", "run_b": "r7f3c",
 "tokens_a": [{"i": 0, "text": "the"}], "tokens_b": [{"i": 0, "text": "the"}],
 "pairs": [[0, 0], [1, 1], [2, 2], [3, 3]],
 "per_pair": [{"same_text": false, "distance": 11.2,
               "only_a": [[14925, 10.4, [" sky", " skies"]]], "only_b": [[9310, 9.8, [" sea", " seas"]]],
               "both": [[412, 0.6, 0.5, null]]}],
 "whole": {"only_a": [[14925, 10.4, [" sky"]]], "only_b": [[9310, 9.8, [" sea"]]]}}
```

- `pairs` lines the two texts up token by token. Version 1 pairs by position and requires the same number of tokens, returning `bad_request` with a plain message otherwise. Lining up texts of different lengths is left for later.
- `only_a` and `only_b` are units that are on for one text and off or much weaker for the other, as `[unit, value, words]`. `both` gives `[unit, value in a, value in b, words]`.
- `distance` is how far apart the two rows are at that node.
- `whole` is the same comparison with every token of each text taken together.
- Because a later word's row depends on the earlier words, a difference at one position shows up at later positions too. The view should make that visible, not hide it.

### Reserved: `POST /scan/v1/steer`

For switching a unit on, off or to a set value and running the text again. Not in version 1. A scanner that does not support it answers `not_loaded`.

## What the Scan view shows

- **The network across the top,** drawn from `graph`: nodes placed by `order` and `lane`, sized by `width`, boxed by `group`, with `carried` edges dashed and a `reads` edge shown leaving the main path and not returning. A collapsed group is one box. Clicking a node selects it.
- **The text and its tokens** under the drawing, with the run button, the snapshot chooser, and what the model would write next.
- **For the selected node,** a grid of tokens down the side and that node's strongest units across, each cell shaded by its value. For a `sparse` node the columns are the union of each token's top units, which is what makes each word's own feature stand out. A unit's words are shown as its heading where it has them.
- **A strip for one token:** every unit of the selected node as one thin band, with `usual` taken off where it is given, so the reader sees the whole row at once and where its strong units are.
- **A unit's page** in a side panel: its words and the test behind them, what it is made of, what it listens to, or what uses it. Each unit named there can be clicked to move to it.
- **Contrast mode:** two text boxes. The two token rows are lined up, each pair marked as the same or different, and the units only in one or the other listed between them. The first place the texts differ is marked, since everything after it can differ because of it.
- **The same text across snapshots:** choosing several snapshots runs the text through each and puts the results side by side.

What the view must say plainly: that a unit lighting up shows it is related to the text and not that it causes anything, and that a unit's words come from one stated test.

## What the first scanner does

`Learn-AI/train-sparse-autoencoder/scan_server.py`, built with PyTorch and the standard library's HTTP server.

- Loads GPT-2 small once. Finds snapshots as `step_*.pt` files at any depth under the runs folder it is given, and loads one when asked to through `load`.
- `graph` describes the seventeen steps of the existing drawing, with the eleven later blocks as one collapsed node, and the sparse autoencoder's three steps attached to the first block's MLP neurons.
- `run` returns every node of the first block, the sparse autoencoder's nodes, and the model's next token.
- `unit` computes a feature's words by the test already in use: every token placed after "Q: Why is the". It is worked out once per snapshot and kept on disk beside the weights.
- It also serves the sparse autoencoder OpenAI published for the same neurons as one more snapshot, for comparison with ours.

## Order to build in

1. The contract's `health`, `snapshots`, `load`, `graph` and `run`, in the scanner, with a test file of recorded replies. The tracker side can be built against those recorded replies before the scanner is finished.
2. The Scan view: the drawing, the text box, and the grid for the selected node.
3. `unit` and the side panel.
4. `contrast` and contrast mode.
5. `values` and the strip.
6. Several snapshots side by side.

## The sheet: the neurons as the thing being scanned

Decided 2026-10-07. The grid of numbers is hard to take in because nothing in it has a place. A brain picture works because every part has a fixed spot, so what lit up is seen without reading. This view gives the network that.

**What has a place.** The units of the step a sparse autoencoder reads: for GPT-2, the 3,072 MLP neurons of the first block. They are the model's real units. Each gets one fixed cell on a sheet, in the order of its number, as close to square as the count allows (64 across by 48 down for 3,072). Where a unit sits means nothing, and the view says so in one line. This is the honest match to a scan: a pattern of activity, in which no single spot means anything alone.

**What the features are.** The reading of the scan. Beside the sheet, the features that the pattern decodes to for the chosen token, strongest first, each with its words.

**What the reader does.**

- Runs text. The sheet glows for the chosen token: each cell shaded by its value with the unit's usual level taken off, one colour above and another below. Clicking a token, or stepping with the arrow keys, moves through the text, and the sheet changes with it.
- Clicks a feature in the list. Its pattern is drawn on the sheet, so the feature is seen as a constellation of neurons. The reading and the activity can be shown together: the activity as the fill of each cell, the feature's pattern as an outline on the cells it uses most.
- Chooses two features. Both patterns are drawn, in two colours, with the cells they share marked. This is how "sky" and "sea" are seen to use some of the same neurons.
- Clicks a cell. The neuron's page opens, with the features that lean on it.
- Contrasts two texts. Two sheets side by side for the paired tokens, and a third showing the difference.
- Switches the sheet between what went in and the sparse autoencoder's rebuild of it, to see how close the rebuild is.

**What it needs from the scanner.** Nothing new as a route. The sheet for a token is `values` for the node the sparse autoencoder reads, with `usual`. The reading is that token's `top` at the features node. A feature's pattern is one addition to the `unit` reply: `made_of.all` and `listens_to.all`, each a list with one number per unit of the node read, scaled so that the squares add to 1. Both are optional; a scanner that leaves them out gets the sheet and the reading without the constellations. Which node is the sheet: the one named by `made_of.node`, or, before any feature is opened, the node that a `reads` edge leaves from in the graph.

**A flat map of the features was tried and set aside.** Placing all 32,768 features so that alike patterns sit together keeps about one in five of each feature's nearest neighbours, with our own layout and with UMAP alike, on the first block and on block 7. Small clumps are real (near sky: oceans, shore, valley, beach) and there are no regions that could be named. The features point in nearly unrelated directions, which is what lets so many fit, and that cannot be laid flat. `Learn-AI/train-sparse-autoencoder/layout.py` holds the layout and the measure. If it is ever shown, it should carry that figure on it.

## The scanner kit: `run-tracker-scankit`

Decided 2026-10-07, to be built after the Scan view works. Most of a scanner is the same every time, and a package should carry that part so an experiment writes only what is its own.

**What the kit does:** the server, the routes and the error replies; finding snapshot files, their cold, loading and ready states, and loading in the background; keeping the last few runs for follow-up questions; turning a step's numbers into each token's strongest units, the grid, the row sizes and the count of units that are on; the contrast between two runs; taking a feature apart into the units it is made of and listens to, and finding what leans on a unit; writing recorded replies; and a command that checks any scanner against this contract.

**What an experiment writes:**

```python
import scankit

class GPT2Scanner(scankit.Scanner):
    name = "GPT-2 small with sparse autoencoders"
    def graph(self, snapshot): ...       # the steps, for the drawing
    def tokens(self, text): ...          # text -> token ids and their text
    def run(self, ids, snapshot): ...    # {node id: numbers, one row per token}
    def load(self, path): ...            # read one snapshot file

scankit.serve(GPT2Scanner(), runs="~/run-tracker-data/runs", port=8790)
```

Two helpers on top of that. One for PyTorch models, so the forward pass need not be written by hand: name the layers wanted and it collects their outputs through hooks. One for sparse autoencoders: say which tables are the detector and the pattern and which step they read, and the features node, a unit's breakdown and the lists of what uses a unit come without further code.

**Where it lives and what it needs.** In the run-tracker repo, since that repo owns the contract, but apart from the tracker itself, whose Python stays free of dependencies. The kit needs NumPy and nothing else, and accepts arrays from PyTorch or anything that converts to NumPy. It is published as `run-tracker-scankit` and imported as `scankit`. It can be installed with pip from the repo or copied beside the experiment.

**How to know it works.** The small made-up scanner in the tracker's tests becomes the kit's worked example. The GPT-2 scanner in `Learn-AI` is rewritten on the kit and must give the same recorded replies as before, in about a third of the code.

## Not decided

- Whether the logging the training script does has any part in this. It should not need to: the scanner reads saved weights from a run's folder, whichever client wrote the log. The one place they meet is that the tracker must be able to list a run's saved weight files and fetch them, which it already does.
- How the tracker's "nothing assumes one kind of model" rule is checked for this view. One way is a second, trivial scanner for a small ordinary network, kept in the tracker's tests.
- Whether recorded replies should be exportable as a self-contained page, the way charts are.
