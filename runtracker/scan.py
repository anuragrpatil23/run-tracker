"""Scan: the tracker's side of running text through a trained network.

The work is done by a scanner, a separate program the experiment owns, which has the model and whatever library it
needs. The tracker knows one thing about it: the address it answers on, kept per project. The browser never talks to a
scanner; the tracker's server passes each request on and hands the reply back, so there is one origin and the tracker
still imports nothing but the standard library.

A scanner must be on this machine. An address anywhere else is refused when it is set and again when it is used, and a
reply that tries to send the request elsewhere is not followed. Only the routes named in the contract (docs/scan.md)
are passed on.
"""
import json, urllib.error, urllib.parse, urllib.request

from . import store

PROTOCOL = 1
ROUTES = {"health": "GET", "snapshots": "GET", "graph": "GET", "values": "GET", "unit": "GET",
          "run": "POST", "contrast": "POST", "load": "POST", "steer": "POST"}
LOCAL = ("127.0.0.1", "localhost", "::1")


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k):
        return None


_opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), _NoRedirect)    # no proxy, no following


def check(url):
    """The address as it will be used, or ValueError saying why it will not be."""
    u = urllib.parse.urlparse(url.strip())
    if u.scheme != "http" or u.hostname not in LOCAL or not u.port or u.path not in ("", "/") or u.query or u.username:
        raise ValueError("a scanner's address is http://127.0.0.1:<port>, on this machine; got %s" % url)
    return "http://%s:%d" % ("[::1]" if u.hostname == "::1" else u.hostname, u.port)


def address(project):
    return (store.read_json(store.project_dir(project) / "scan.json", {}) or {}).get("url")


def set_address(project, url):
    """Say where a project's scanner answers, or pass an empty address to forget it."""
    path = store.project_dir(project) / "scan.json"
    if url:
        store.write_json(path, {"url": check(url)})
    elif path.exists():
        path.unlink()


def all_addresses():
    root = store.data_dir() / "projects"
    out = {}
    for f in sorted(root.glob("*/scan.json")) if root.is_dir() else []:
        out[f.parent.name] = (store.read_json(f, {}) or {}).get("url")
    return out


def _problem(code, message, status):
    return status, json.dumps({"error": {"code": code, "message": message}}).encode()


def forward(project, route, method, query="", body=b""):
    """Pass one request on to the project's scanner. Returns (HTTP status, reply as bytes), whatever happened."""
    if ROUTES.get(route) != method:
        return _problem("bad_request", "there is no %s %s in the scan contract" % (method, route), 404)
    url = address(project)
    if not url:
        return _problem("no_scanner", "no scanner is set for the project %s. Start one, then: rt scan add %s --url http://127.0.0.1:<port>" % (project, project), 404)
    try:
        url = check(url)
    except ValueError as e:
        return _problem("no_scanner", str(e), 404)
    req = urllib.request.Request("%s/scan/v%d/%s%s" % (url, PROTOCOL, route, "?" + query if query else ""),
                                 data=body if method == "POST" else None, method=method, headers={"Content-Type": "application/json"})
    try:
        with _opener.open(req, timeout=120) as r:
            status, reply = r.status, r.read()
    except urllib.error.HTTPError as e:                     # the scanner's own refusals come back as they are
        reply = e.read()
        if 300 <= e.code < 400 or not reply.strip().startswith(b"{"):
            return _problem("unreachable", "the scanner at %s answered %d, which is not a reply in the contract" % (url, e.code), 502)
        return e.code, reply
    except Exception as e:
        return _problem("unreachable", "the scanner at %s did not answer (%s)" % (url, getattr(e, "reason", e)), 502)
    if route == "health":
        try:
            said = json.loads(reply).get("protocol")
        except Exception:
            said = None
        if said != PROTOCOL:
            return _problem("bad_protocol", "the scanner speaks protocol %r and this tracker speaks %d" % (said, PROTOCOL), 502)
    return status, reply
