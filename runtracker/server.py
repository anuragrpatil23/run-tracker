"""The viewer's server: a small web app on this machine only, reading the copied run folders.

It listens on 127.0.0.1 and nowhere else. The pages are plain files in static/; everything they
show comes from the /api/ routes below, which read the folders afresh each time, so a run that is
still being copied shows up as it grows.
"""
import json, mimetypes, threading, time, traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from . import export, index, store, sync

STATIC = Path(__file__).parent / "static"
syncing = {"busy": False, "last": None, "error": None, "lines": [], "watch": None}
_sync_lock = threading.Lock()


def run_sync(only=None):
    """One sync, unless one is already under way. Returns how many runs are still going."""
    if not _sync_lock.acquire(blocking=False):
        return None
    lines = []
    syncing.update(busy=True, error=None)
    try:
        going = sync.sync_all(only, lines.append)
        syncing.update(last=time.time(), lines=lines)
        return going
    except Exception as e:
        syncing.update(error=str(e), lines=lines)
        return None
    finally:
        syncing["busy"] = False
        _sync_lock.release()


def watch_loop(every):
    """Copy every `every` seconds while a run is going, and look in now and then when none is."""
    syncing["watch"] = every
    while True:
        going = run_sync()
        time.sleep(every if going or going is None else max(every, 300))


class Handler(BaseHTTPRequestHandler):
    server_version = "run-tracker"

    def log_message(self, *a):
        pass

    def send(self, body, kind="application/json", code=200):
        if not isinstance(body, (bytes, bytearray)):
            body = json.dumps(body, ensure_ascii=False, allow_nan=False, default=str).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", kind + ("; charset=utf-8" if kind.startswith(("text/", "application/j")) else ""))
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def local_only(self):
        """Refuse a request that was not addressed to this machine by name, as a page elsewhere might try."""
        host = (self.headers.get("Host") or "").rsplit(":", 1)[0]
        if host not in ("127.0.0.1", "localhost", "[::1]"):
            self.send({"error": "this viewer answers only on localhost"}, code=403)
            return False
        return True

    def do_GET(self):
        if not self.local_only():
            return
        url = urlparse(self.path)
        q = {k: v[0] for k, v in parse_qs(url.query).items()}
        try:
            if url.path == "/api/runs":
                self.send({"runs": store.all_summaries(), "sync": syncing, "sources": store.load_config()["sources"],
                           "data": str(store.data_dir()), "now": time.time()})
            elif url.path == "/api/run":
                self.send(store.detail(q["id"]))
            elif url.path == "/api/log":
                records = store.log_of(store.run_path(q["id"]))
                since = int(q.get("since", 0))
                self.send({"records": records[since:], "total": len(records)})
            elif url.path == "/api/system":
                self.send({"records": store.system_of(store.run_path(q["id"]))})
            elif url.path == "/api/v2/runs":
                self.send({"runs": index.refresh(), "sync": syncing, "sources": store.load_config()["sources"],
                           "data": str(store.data_dir()), "now": time.time()})
            elif url.path == "/api/v2/keys":
                ids = [i for i in q.get("runs", "").split(",") if i]
                self.send(index.keys_of(ids))
            elif url.path == "/api/v2/series":
                # runs and keys are comma separated; the reply is {run: {key: {x, y, n}}}
                ids = [i for i in q.get("runs", "").split(",") if i]
                names = [k for k in q.get("keys", "").split(",") if k]
                limit = max(50, min(20000, int(q.get("points", 1500))))
                self.send({rid: {k: index.series(rid, k, q.get("x", "step"), limit) for k in names} for rid in ids})
            elif url.path == "/api/v2/timeline":
                index.refresh(q["id"])
                self.send(index.timeline(q["id"], q["key"], q.get("changes", "1") == "1"))
            elif url.path == "/api/v2/search":
                index.refresh()
                self.send({"query": q.get("q", ""), "results": index.search(q.get("q", ""))})
            elif url.path == "/api/v2/output":
                self.send({"text": store.output_of(store.run_path(q["id"]))})
            elif url.path == "/api/search":
                self.send({"query": q.get("q", ""), "results": store.search(q.get("q", ""))})
            elif url.path == "/api/sync":
                self.send(syncing)
            elif url.path in ("/", "/index.html"):
                built = STATIC / "app" / "index.html"       # the built frontend; the plain one stands in if it is missing
                self.send((built if built.is_file() else STATIC / "index.html").read_bytes(), "text/html")
            elif url.path == "/classic":
                self.send((STATIC / "index.html").read_bytes(), "text/html")
            elif url.path.startswith("/app/"):
                f = (STATIC / "app" / url.path[5:]).resolve()
                if (STATIC / "app").resolve() not in f.parents or not f.is_file():
                    return self.send({"error": "not found"}, code=404)
                self.send(f.read_bytes(), mimetypes.guess_type(f.name)[0] or "application/octet-stream")
            elif url.path.startswith("/static/"):
                f = (STATIC / url.path[8:]).resolve()
                if STATIC.resolve() not in f.parents or not f.is_file():
                    return self.send({"error": "not found"}, code=404)
                self.send(f.read_bytes(), mimetypes.guess_type(f.name)[0] or "application/octet-stream")
            else:
                self.send({"error": "not found"}, code=404)
        except KeyError as e:
            self.send({"error": "no such run: %s" % e}, code=404)
        except Exception as e:
            traceback.print_exc()
            self.send({"error": str(e)}, code=500)

    def do_POST(self):
        if not self.local_only():
            return
        if "application/json" not in (self.headers.get("Content-Type") or ""):
            return self.send({"error": "send JSON"}, code=415)
        try:
            body = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
            path = urlparse(self.path).path
            if path == "/api/local":
                self.send(store.set_local(body["id"], body))
            elif path == "/api/notes":
                store.set_notes(body["id"], body.get("text", ""))
                self.send({"ok": True})
            elif path == "/api/sync":
                threading.Thread(target=run_sync, daemon=True).start()
                self.send({"started": True})
            elif path == "/api/fetch":
                lines = []
                try:
                    where = sync.fetch_file(body["id"], body["path"], lines.append)
                    self.send({"ok": True, "path": where, "lines": lines})
                except sync.SyncError as e:
                    self.send({"error": str(e)}, code=502)
            elif path == "/api/export":
                html = export.build(body)
                where = export.write(html, body.get("file") or body.get("title") or "runs")
                self.send({"ok": True, "path": str(where)})
            else:
                self.send({"error": "not found"}, code=404)
        except KeyError as e:
            self.send({"error": "missing or unknown: %s" % e}, code=400)
        except Exception as e:
            traceback.print_exc()
            self.send({"error": str(e)}, code=500)


def serve(port=8787, watch=None, open_browser=True):
    httpd = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    url = "http://127.0.0.1:%d/" % port
    print("run tracker at %s   (runs are read from %s; ctrl-c to stop)" % (url, store.runs_dir()))
    if watch:
        threading.Thread(target=watch_loop, args=(watch,), daemon=True).start()
        print("copying from the sources every %d s while a run is going" % watch)
    if open_browser:
        import webbrowser
        threading.Timer(0.4, webbrowser.open, args=(url,)).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print()
