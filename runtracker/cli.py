"""The command line: rt.

  rt source add NAME --root DIR [--ssh HOST] [--scheduler lsf]   say where runs are written
  rt sync [NAME] [--watch [SECONDS]]                             copy what is new
  rt view [--watch [SECONDS]]                                    open the viewer
  rt ls                                                          the list of runs, in the terminal
  rt fetch RUN FILE                                              bring one large file to the laptop
  rt export --runs A B --fields x y -o page.html                 a self-contained page of charts
"""
import argparse, sys, time

from . import export, store, sync


def main(argv=None):
    p = argparse.ArgumentParser(prog="rt", description="Watch, compare and keep training runs that are written to files.")
    sub = p.add_subparsers(dest="cmd")

    s = sub.add_parser("source", help="list, add or remove the places runs come from")
    s.add_argument("action", nargs="?", default="list", choices=["list", "add", "remove"])
    s.add_argument("name", nargs="?")
    s.add_argument("--root", help="the folder that holds the run folders")
    s.add_argument("--ssh", help="the ssh host it is on, as named in ~/.ssh/config; leave out for this machine")
    s.add_argument("--scheduler", choices=["lsf", "slurm"], help="ask this scheduler for the state of each run's job")
    s.add_argument("--prefix", help="put this in front of the source's project names, such as dummy- for made-up runs")
    s.add_argument("--paused", action="store_true", help="keep the copied runs but stop copying from this source")

    s = sub.add_parser("sync", help="copy what is new from the sources")
    s.add_argument("name", nargs="?")
    s.add_argument("--watch", nargs="?", type=int, const=30, metavar="SECONDS", help="repeat while any run is still going")
    s.add_argument("--forever", action="store_true", help="with --watch, keep going when nothing is running")

    s = sub.add_parser("view", help="open the viewer in the browser")
    s.add_argument("--port", type=int, default=8787)
    s.add_argument("--watch", nargs="?", type=int, const=30, metavar="SECONDS", help="also sync on this interval")
    s.add_argument("--no-open", action="store_true", help="do not open a browser window")

    sub.add_parser("ls", help="list the runs")

    s = sub.add_parser("fetch", help="bring one large file of a run to the laptop")
    s.add_argument("run"); s.add_argument("file")

    s = sub.add_parser("export", help="write a self-contained HTML page of charts")
    s.add_argument("--runs", nargs="+", required=True)
    s.add_argument("--fields", nargs="*", default=[], help="numbers to chart, one chart each")
    s.add_argument("--log", nargs="*", default=[], help="which of those to draw on a log scale")
    s.add_argument("--x", default="step")
    s.add_argument("--timeline", nargs="*", default=[], metavar="KEY", help="nested fields to show as timelines, for the first run")
    s.add_argument("--against", nargs=2, metavar=("SETTING", "METRIC"), help="chart a final number against a setting")
    s.add_argument("--title", default="Runs")
    s.add_argument("-o", "--out", help="file to write; a bare name goes into the export folder")

    a = p.parse_args(argv)
    try:
        if a.cmd == "source":
            cfg = store.load_config()
            if a.action == "add":
                if not a.name or not a.root:
                    p.error("source add needs a NAME and --root")
                cfg["sources"][a.name] = {k: v for k, v in (("root", a.root), ("ssh", a.ssh), ("scheduler", a.scheduler), ("prefix", a.prefix), ("paused", a.paused)) if v}
                store.save_config(cfg)
            elif a.action == "remove":
                cfg["sources"].pop(a.name, None)
                store.save_config(cfg)          # the copied runs stay in place; delete the folder by hand if they should go
            for name, spec in cfg["sources"].items():
                print("%-16s %s%s%s%s%s" % (name, spec["ssh"] + ":" if spec.get("ssh") else "", spec["root"],
                                            "   scheduler: " + spec["scheduler"] if spec.get("scheduler") else "",
                                            "   projects prefixed " + spec["prefix"] if spec.get("prefix") else "", "   paused" if spec.get("paused") else ""))
            if not cfg["sources"]:
                print("no sources yet")
        elif a.cmd == "sync":
            if a.watch:
                sync.watch(a.name, a.watch, a.forever)
            else:
                sync.sync_all(a.name)
        elif a.cmd == "view":
            from . import server
            server.serve(a.port, a.watch, not a.no_open)
        elif a.cmd == "ls":
            rows = store.all_summaries()
            print("%-44s %-9s %10s %9s  %s" % ("run", "state", "step", "time", "copied"))
            for r in rows:
                step = "-" if r["step"] is None else ("%s/%s" % (r["step"], r["total"]) if r["total"] else str(r["step"]))
                print("%-44s %-9s %10s %9s  %s" % (r["id"], r["state"], step,
                                                   store.ago(r["seconds"]) if r["seconds"] is not None else "-",
                                                   store.ago(time.time() - r["synced"]) + " ago" if r["synced"] else "-"))
        elif a.cmd == "fetch":
            sync.fetch_file(a.run, a.file)
        elif a.cmd == "export":
            spec = {"title": a.title, "runs": a.runs, "x": a.x,
                    "charts": [{"field": f, "logY": f in a.log} for f in a.fields],
                    "timelines": [{"run": a.runs[0], "key": k} for k in a.timeline]}
            if a.against:
                spec["against"] = {"setting": a.against[0], "metric": a.against[1]}
            print(export.write(export.build(spec), a.out or a.title))
        else:
            p.print_help()
    except (sync.SyncError, KeyError, ValueError) as e:
        sys.exit("rt: %s" % e)
    except KeyboardInterrupt:
        print()


if __name__ == "__main__":
    main()
