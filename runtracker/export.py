"""Export: a chart, or a set of runs, as one HTML file that needs nothing else to open.

The file carries its own data, styles and drawing code, in the same look as the diagram pages in
the vault, so it can sit beside them and be linked from a note. What goes in is described by a
small dict, the same one the viewer sends when its Export button is pressed:

  {"title": "...", "lede": "...", "runs": ["sae/f8192_lam0.2", ...], "x": "step",
   "charts": [{"field": "not_rebuilt", "logY": true}, ...],
   "timelines": [{"run": "sae/f8192_lam0.2", "key": "sky"}],
   "against": {"setting": "lam", "metric": "not_rebuilt", "logX": true}}
"""
import json, re, time
from pathlib import Path

from . import store

STATIC = Path(__file__).parent / "static"


def export_dir():
    cfg = store.load_config()
    return Path(cfg.get("export_dir") or (store.data_dir() / "exports")).expanduser()


def _pick(rec, keep):
    """Only the fields of a log line the page will draw, so the file stays small."""
    out = {}
    for k, v in rec.items():
        if k in ("step", "_t") or k in keep:
            out[k] = v
        elif isinstance(v, dict):
            inner = {a: b for a, b in store.flatten(v, k + ".").items() if a in keep}
            for a, b in inner.items():
                node = out
                parts = a.split(".")
                for p in parts[:-1]:
                    node = node.setdefault(p, {})
                node[parts[-1]] = b
    return out


def build(spec):
    runs = []
    charts = spec.get("charts") or []
    x = spec.get("x") or "step"
    keep = {c["field"] for c in charts} | {x}
    if spec.get("against"):
        keep.add(spec["against"]["metric"])
    whole = {(t["run"], t["key"]) for t in spec.get("timelines") or []}
    for run_id in spec.get("runs") or []:
        path = store.run_path(run_id)
        s = store.summary(run_id, path)
        records = []
        for rec in store.read_jsonl(path / "log.jsonl"):
            slim = _pick(rec, keep)
            for (r, key) in whole:
                if r == run_id and key in rec:
                    slim[key] = rec[key]
            records.append(slim)
        meta = store.read_json(path / "meta.json", {}) or {}
        runs.append({"id": run_id, "name": s["name"], "state": s["state"], "step": s["step"], "settings": s["settings"],
                     "prediction": s["prediction"], "outcome": (store.read_json(path / "_local.json", {}) or {}).get("outcome", ""),
                     "commit": s["commit"], "commit_url": store.commit_url(meta.get("git")), "records": records})
    data = {"title": spec.get("title") or "Runs", "lede": spec.get("lede") or "", "x": x, "charts": charts,
            "timelines": spec.get("timelines") or [], "against": spec.get("against"), "runs": runs,
            "made": time.strftime("%Y-%m-%d")}
    css = (STATIC / "style.css").read_text(encoding="utf-8")
    js = (STATIC / "charts.js").read_text(encoding="utf-8") + "\n" + (STATIC / "export.js").read_text(encoding="utf-8")
    blob = json.dumps(data, ensure_ascii=False, allow_nan=False).replace("</", "<\\/")
    title = data["title"].replace("&", "&amp;").replace("<", "&lt;")
    return ("<!doctype html>\n<html lang=\"en\">\n<head>\n<meta charset=\"utf-8\">\n"
            "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">\n<title>%s</title>\n"
            "<link rel=\"stylesheet\" href=\"https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500;600&display=swap\">\n"
            "<style>\n%s\n</style>\n</head>\n<body>\n<div class=\"wrap\" id=\"page\"></div>\n"
            "<script type=\"application/json\" id=\"data\">%s</script>\n<script>\n%s\n</script>\n</body>\n</html>\n"
            % (title, css, blob, js.replace("</script", "<\\/script")))


def write(html, name):
    """Save the page. A bare name goes into the export folder; a path is used as given."""
    p = Path(name).expanduser()
    if not p.is_absolute():
        slug = re.sub(r"[^a-z0-9]+", "-", p.stem.lower() if p.suffix == ".html" else str(name).lower()).strip("-") or "runs"
        p = export_dir() / (slug + ".html")
    elif p.suffix != ".html":
        raise ValueError("an export is an .html file; got %s" % p)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(html, encoding="utf-8")
    return p
