"""A scanner for a tiny made-up network that is not a transformer, in the standard library alone.

It exists to hold the Scan view to its rule: nothing in the tracker may assume one kind of model. The network here
counts the letters of each word (26 numbers), mixes them into 12 units with fixed weights and bends them, and reads
3 scores off that. It answers the same contract (docs/scan.md) a real scanner does, so the tracker's tests and the
view can be run against it with no PyTorch anywhere.

    python3 tests/toy_scanner.py --port 8799
"""
import argparse, json, math, random
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

LETTERS, MIX, OUT, MAX_TOKENS = 26, 12, 3, 32
SNAPSHOTS = {"toy@0": 0, "toy@10": 10}                       # two "trainings" of the same network: different weights
RUNS = {}


def weights(snapshot):
    rng = random.Random(SNAPSHOTS[snapshot])
    return ([[rng.uniform(-1, 1) for _ in range(LETTERS)] for _ in range(MIX)], [[rng.uniform(-1, 1) for _ in range(MIX)] for _ in range(OUT)])


def through(text, snapshot):
    w1, w2 = weights(snapshot)
    tokens = text.split()
    rows = {"letters": [], "mix": [], "scores": []}
    for word in tokens:
        counts = [float(word.lower().count(chr(97 + i))) for i in range(LETTERS)]
        mix = [max(0.0, sum(a * b for a, b in zip(w, counts))) for w in w1]
        rows["letters"].append(counts); rows["mix"].append(mix); rows["scores"].append([sum(a * b for a, b in zip(w, mix)) for w in w2])
    return tokens, rows


def node_reply(rows, top):
    union = []
    for row in rows:
        for u in sorted(range(len(row)), key=lambda u: -abs(row[u]))[:top]:
            if row[u] and u not in union:
                union.append(u)
    union = union[:48]
    return {"size": [round(math.sqrt(sum(v * v for v in r)), 3) for r in rows],
            "on": [sum(1 for v in r if v) for r in rows],
            "top": [[[u, round(r[u], 3)] for u in sorted(range(len(r)), key=lambda u: -abs(r[u]))[:top] if r[u]] for r in rows],
            "grid": {"units": union, "values": [[round(r[u], 3) for u in union] for r in rows]}}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def reply(self, obj, status=200):
        body = json.dumps(obj).encode()
        self.send_response(status); self.send_header("Content-Type", "application/json"); self.send_header("Content-Length", str(len(body))); self.end_headers()
        self.wfile.write(body)

    def problem(self, code, message, status=400):
        self.reply({"error": {"code": code, "message": message}}, status)

    def do_GET(self):
        url = urlparse(self.path); q = {k: v[0] for k, v in parse_qs(url.query).items()}
        route = url.path.replace("/scan/v1/", "")
        if route == "health":
            self.reply({"ok": True, "protocol": 1, "name": "A toy network that counts letters", "device": "cpu", "max_tokens": MAX_TOKENS, "supports": ["run", "values", "unit", "contrast"]})
        elif route == "snapshots":
            self.reply({"snapshots": [{"id": s, "label": "toy weights, seed %d" % n, "run": None, "step": n, "of": 10, "state": "ready"} for s, n in SNAPSHOTS.items()], "default": "toy@10"})
        elif route == "graph":
            if q.get("snapshot") not in SNAPSHOTS:
                return self.problem("unknown_snapshot", "there is no snapshot %s" % q.get("snapshot"), 404)
            self.reply({"title": "A toy network that counts letters", "groups": [{"id": "body", "label": "Mixing"}],
                        "nodes": [{"id": "letters", "label": "Letter counts", "group": None, "kind": "lookup", "width": LETTERS, "per": "token", "lane": 0, "order": 0, "unit": "letter", "about": "How many of each letter the word has."},
                                  {"id": "mix", "label": "Mixed", "group": "body", "kind": "linear+bend", "bend": "ReLU", "width": MIX, "per": "token", "lane": 0, "order": 1, "weights": LETTERS * MIX, "unit": "unit", "sparse": True},
                                  {"id": "scores", "label": "Scores", "group": None, "kind": "linear", "width": OUT, "per": "token", "lane": 0, "order": 2, "weights": MIX * OUT, "unit": "score"}],
                        "edges": [{"from": "letters", "to": "mix"}, {"from": "mix", "to": "scores"}]})
        elif route == "values":
            run = RUNS.get(q.get("run"))
            if not run:
                return self.problem("unknown_run", "that result is no longer kept", 404)
            if q.get("node") not in run["rows"]:
                return self.problem("unknown_node", "there is no node %s" % q.get("node"), 404)
            row = run["rows"][q["node"]][int(q.get("token", 0))]
            a, n = int(q.get("from", 0)), min(4096, int(q.get("count", 4096)))
            self.reply({"from": a, "count": len(row[a:a + n]), "values": row[a:a + n]})
        elif route == "unit":
            if q.get("snapshot") not in SNAPSHOTS:
                return self.problem("unknown_snapshot", "there is no snapshot %s" % q.get("snapshot"), 404)
            w1, w2 = weights(q["snapshot"]); u = int(q.get("unit", -1))
            if q.get("node") == "mix" and 0 <= u < MIX:
                order = sorted(range(LETTERS), key=lambda i: -abs(w1[u][i]))
                self.reply({"node": "mix", "unit": u, "words": [[chr(97 + i), round(w1[u][i], 3)] for i in order[:5]], "words_test": "each letter on its own",
                            "listens_to": {"node": "letters", "top": [[i, round(w1[u][i], 3)] for i in order[:5]], "half": 6, "ninety": 20}})
            elif q.get("node") == "letters" and 0 <= u < LETTERS:
                self.reply({"node": "letters", "unit": u, "used_by": {"node": "mix", "count": MIX, "top": [[m, round(w1[m][u], 3), None] for m in sorted(range(MIX), key=lambda m: -abs(w1[m][u]))[:5]]}})
            else:
                self.problem("unknown_unit", "there is no unit %s at %s" % (q.get("unit"), q.get("node")), 404)
        else:
            self.problem("bad_request", "no such route", 404)

    def do_POST(self):
        route = urlparse(self.path).path.replace("/scan/v1/", "")
        try:
            body = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
        except ValueError:
            return self.problem("bad_request", "the request is not JSON")
        snapshot = body.get("snapshot") or "toy@10"
        if snapshot not in SNAPSHOTS:
            return self.problem("unknown_snapshot", "there is no snapshot %s" % snapshot, 404)
        top = int(body.get("top", 6))

        def run(text):
            tokens, rows = through(text, snapshot)
            if len(tokens) > MAX_TOKENS:
                raise ValueError("the text is %d words and the limit is %d" % (len(tokens), MAX_TOKENS))
            name = "r%04x" % (len(RUNS) + 1)
            RUNS[name] = {"rows": rows, "tokens": tokens}
            return name, tokens, rows

        try:
            if route == "run":
                name, tokens, rows = run(body.get("text", ""))
                self.reply({"run": name, "snapshot": snapshot, "tokens": [{"i": i, "text": t} for i, t in enumerate(tokens)], "nodes": {k: node_reply(v, top) for k, v in rows.items()}})
            elif route == "contrast":
                node = body.get("node", "mix")
                (ra, ta, rows_a), (rb, tb, rows_b) = run(body.get("a", "")), run(body.get("b", ""))
                if len(ta) != len(tb):
                    return self.problem("bad_request", "the two texts must have the same number of words: %d and %d" % (len(ta), len(tb)))
                if node not in rows_a:
                    return self.problem("unknown_node", "there is no node %s" % node, 404)
                def differ(x, y):
                    only_a = [[u, round(x[u], 3), None] for u in range(len(x)) if x[u] and not y[u]]
                    only_b = [[u, round(y[u], 3), None] for u in range(len(x)) if y[u] and not x[u]]
                    both = [[u, round(x[u], 3), round(y[u], 3), None] for u in range(len(x)) if x[u] and y[u]]
                    return {"only_a": only_a[:top], "only_b": only_b[:top], "both": both[:top]}
                pairs = [[i, i] for i in range(len(ta))]
                per = [{"same_text": ta[i] == tb[i], "distance": round(math.dist(rows_a[node][i], rows_b[node][i]), 3), **differ(rows_a[node][i], rows_b[node][i])} for i in range(len(ta))]
                whole = differ([sum(c) for c in zip(*rows_a[node])] or [0], [sum(c) for c in zip(*rows_b[node])] or [0])
                self.reply({"run_a": ra, "run_b": rb, "tokens_a": [{"i": i, "text": t} for i, t in enumerate(ta)], "tokens_b": [{"i": i, "text": t} for i, t in enumerate(tb)],
                            "pairs": pairs, "per_pair": per, "whole": {"only_a": whole["only_a"], "only_b": whole["only_b"]}})
            elif route == "load":
                self.reply({"snapshot": snapshot, "state": "ready"})
            elif route == "steer":
                self.problem("not_loaded", "this scanner cannot switch units on and off", 501)
            else:
                self.problem("bad_request", "no such route", 404)
        except ValueError as e:
            self.problem("too_long", str(e), 413)


def serve(port=0):
    """Start the toy scanner on 127.0.0.1. Port 0 lets the system choose one; the server it returns says which."""
    class Server(ThreadingHTTPServer):
        request_queue_size = 128
        daemon_threads = True
    return Server(("127.0.0.1", port), Handler)


if __name__ == "__main__":
    p = argparse.ArgumentParser(); p.add_argument("--port", type=int, default=8799)
    server = serve(p.parse_args().port)
    print("toy scanner at http://127.0.0.1:%d" % server.server_address[1])
    server.serve_forever()
