/* The network in three dimensions, fed by the text that was just run.

   Every step is a bar: a slab of tiles with the tokens down its side and the step's units across. A tile is taller and
   brighter the further its number is from zero, blue above and red below. A bar shows only a step's first units, in
   their own order (a sparse step shows its strongest instead, and says so), because a step can be thousands wide; the
   sheet a row opens into has all of them.

   Steps are placed where the scanner put them: `order` runs left to right and `lane` up and down. Groups are framed.
   Drag to turn the drawing, scroll to move in, right-drag to slide it. Click a tile: its row opens as a sheet, and the
   unit it belongs to opens beside it.

   three.js is loaded only when this drawing is shown, so the rest of the app is no heavier for it. */
import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { cssColour, fmt } from "./lib";

export type BarNode = { id: string; label: string; group?: string | null; kind: string; width?: number | null; unit?: string; per?: string; lane: number; order: number; sparse?: boolean };
export type BarGraph = { groups?: { id: string; label: string }[]; nodes: BarNode[]; edges: { from: string; to: string; kind?: string }[] };
/* What a bar is made of: its rows, which unit each column is, and how the columns were chosen. */
export type BarData = { rows: (number | null)[][]; units: number[] | null; how: "first" | "strongest" | "tokens" };

const TILE = 1, GAP = 0.18, STEP = TILE + GAP;

export default function Bars3D({ graph, bars, tokens, token, picked, onTile, theme, onFail }:
  { graph: BarGraph; bars: Record<string, BarData>; tokens: string[]; token: number; picked: string;
    onTile: (node: string, token: number, unit: number | null) => void; theme: string; onFail: () => void }) {
  const host = useRef<HTMLDivElement>(null);
  const labels = useRef<HTMLDivElement>(null);
  const [tip, setTip] = useState<{ x: number; y: number; text: string[] } | null>(null);
  const live = useRef({ onTile, token, picked, onFail });
  live.current = { onTile, token, picked, onFail };
  const mark = useRef<(token: number, picked: string) => void>(() => {});

  useEffect(() => {
    const el = host.current, over = labels.current;
    if (!el || !over) return;
    const W = el.clientWidth, H = el.clientHeight;
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(32, W / H, 1, 6000);
    // A browser with no 3D drawing (some remote desktops, some locked-down machines) gets the flat drawing instead.
    let renderer: THREE.WebGLRenderer;
    try { renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true }); }
    catch { live.current.onFail(); return; }
    renderer.setPixelRatio(Math.min(2, devicePixelRatio || 1)); renderer.setSize(W, H);
    el.appendChild(renderer.domElement);
    scene.add(new THREE.AmbientLight(0xffffff, 1.5));
    const sun = new THREE.DirectionalLight(0xffffff, 1.6); sun.position.set(-40, 80, 120); scene.add(sun);

    // where each step goes: its column by order, its row by lane, every bar the size of the largest
    const T = Math.max(1, tokens.length);
    const colsOf = (n: BarNode) => bars[n.id]?.rows[0]?.length ?? 8;
    const widest = Math.max(8, ...graph.nodes.map(colsOf));
    const orders = [...new Set(graph.nodes.map(n => n.order))].sort((a, b) => a - b);
    const lanes = [...new Set(graph.nodes.map(n => n.lane))].sort((a, b) => b - a);
    const DX = widest * STEP + 9, DY = T * STEP + 9;
    const at = (n: BarNode) => new THREE.Vector3(orders.indexOf(n.order) * DX, -lanes.indexOf(n.lane) * DY, 0);
    const sizeOf = (n: BarNode) => ({ w: colsOf(n) * STEP - GAP, h: T * STEP - GAP });

    const ink = new THREE.Color(cssColour("--fg")), quiet = new THREE.Color(cssColour("--faint")), rule = new THREE.Color(cssColour("--rule"));
    const up = new THREE.Color(cssColour("--s1")), down = new THREE.Color(cssColour("--s8")), rest = new THREE.Color(cssColour("--wash"));

    // every tile of every bar is one instance of one box
    const total = graph.nodes.reduce((n, node) => n + (bars[node.id] ? bars[node.id].rows.length * colsOf(node) : 0), 0);
    const tiles = new THREE.InstancedMesh(new THREE.BoxGeometry(TILE, TILE, 1), new THREE.MeshLambertMaterial(), Math.max(1, total));
    const where: { node: BarNode; token: number; col: number; v: number | null }[] = [];
    const m = new THREE.Matrix4(), c = new THREE.Color();
    let k = 0;
    for (const node of graph.nodes) {
      const bar = bars[node.id]; if (!bar) continue;
      const sizes = bar.rows.flat().map(v => Math.abs(v ?? 0)).filter(v => v > 0).sort((a, b) => a - b);
      const top = sizes.length ? sizes[Math.min(sizes.length - 1, Math.floor(sizes.length * 0.98))] : 1;      // a few very large tiles do not flatten the rest
      const p = at(node);
      bar.rows.forEach((row, t) => row.forEach((v, j) => {
        const s = Math.min(1, Math.abs(v ?? 0) / top), tall = 0.25 + 2.6 * s;
        m.makeScale(1, 1, tall); m.setPosition(p.x + j * STEP + TILE / 2, p.y - t * STEP - TILE / 2, tall / 2);
        tiles.setMatrixAt(k, m);
        tiles.setColorAt(k, c.copy(rest).lerp((v ?? 0) >= 0 ? up : down, v == null ? 0 : 0.08 + 0.92 * s ** 1.5));     // the far-from-zero stand out
        where[k++] = { node, token: t, col: j, v };
      }));
    }
    tiles.count = k; tiles.instanceMatrix.needsUpdate = true; if (tiles.instanceColor) tiles.instanceColor.needsUpdate = true;
    scene.add(tiles);

    // a step with nothing recorded (one folded away) is an empty frame, so the path through the network stays whole
    const frame = (x: number, y: number, w: number, h: number, colour: THREE.Color, z = -0.05) => {
      const g = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(x, y, z), new THREE.Vector3(x + w, y, z), new THREE.Vector3(x + w, y - h, z), new THREE.Vector3(x, y - h, z), new THREE.Vector3(x, y, z)]);
      const line = new THREE.Line(g, new THREE.LineBasicMaterial({ color: colour })); scene.add(line); return line;
    };
    graph.nodes.filter(n => !bars[n.id]).forEach(n => { const p = at(n), s = sizeOf(n); frame(p.x, p.y, s.w, s.h, quiet); });
    for (const g of graph.groups ?? []) {
      const mine = graph.nodes.filter(n => n.group === g.id); if (!mine.length) continue;
      const x0 = Math.min(...mine.map(n => at(n).x)) - 3, x1 = Math.max(...mine.map(n => at(n).x + sizeOf(n).w)) + 3;
      const y0 = Math.max(...mine.map(n => at(n).y)) + 5.2, y1 = Math.min(...mine.map(n => at(n).y - sizeOf(n).h)) - 2.2;
      frame(x0, y0, x1 - x0, y0 - y1, rule, -0.4);
    }
    // the lines between steps: solid where numbers flow, dashed where the stream is carried past, dotted where a step is only read
    for (const e of graph.edges) {
      const a = graph.nodes.find(n => n.id === e.from), b = graph.nodes.find(n => n.id === e.to); if (!a || !b) continue;
      const p = at(a), q = at(b), sa = sizeOf(a), sb = sizeOf(b);
      const from = new THREE.Vector3(p.x + sa.w + 0.4, p.y - sa.h / 2, 0.2), to = new THREE.Vector3(q.x - 0.4, q.y - sb.h / 2, 0.2);
      const mid = (from.x + to.x) / 2;
      const curve = new THREE.CubicBezierCurve3(from, new THREE.Vector3(mid, from.y, 0.2), new THREE.Vector3(mid, to.y, 0.2), to);
      const geo = new THREE.BufferGeometry().setFromPoints(curve.getPoints(40));
      const mat = e.kind === "carried" ? new THREE.LineDashedMaterial({ color: quiet, dashSize: 1.6, gapSize: 1.2 }) : e.kind === "reads" ? new THREE.LineDashedMaterial({ color: quiet, dashSize: 0.4, gapSize: 0.9 }) : new THREE.LineBasicMaterial({ color: quiet });
      const line = new THREE.Line(geo, mat); line.computeLineDistances(); scene.add(line);
    }

    // marks that move without rebuilding: the token being looked at, outlined in every bar, and the chosen step
    const marks = new THREE.Group(); scene.add(marks);
    mark.current = (tok, pick) => {
      marks.clear();
      for (const n of graph.nodes) {
        if (!bars[n.id]) continue;
        const p = at(n), s = sizeOf(n);
        const row = frame(p.x - 0.25, p.y - tok * STEP + 0.12, s.w + 0.5, TILE + 0.24, ink, 3.1); scene.remove(row); marks.add(row);
        if (n.id === pick) { const all = frame(p.x - 0.9, p.y + 0.9, s.w + 1.8, s.h + 1.8, ink, -0.02); scene.remove(all); marks.add(all); }
      }
      draw();
    };

    // the words: each step's name above its bar, and the tokens beside the chosen one. Drawn as page text over the picture.
    const names = graph.nodes.map(n => {
      const d = document.createElement("div"); d.className = "barlabel";
      const b = bars[n.id];
      const title = document.createElement("b"); title.textContent = n.kind === "collapsed" ? n.label.split(",")[0] : n.label;
      const sub = document.createElement("span");
      sub.textContent = !b ? (n.kind === "collapsed" ? n.label.split(",").slice(1).join(",").trim() : "not recorded")
        : b.how === "tokens" ? "token against token" : `${b.how === "first" ? "first" : "strongest"} ${b.rows[0]?.length ?? 0} of ${fmt(n.width ?? 0)}${b.how === "strongest" ? ", not in order" : ""}`;
      d.append(title, sub); over.appendChild(d);
      return { d, n, sub };
    });
    const groupNames = (graph.groups ?? []).map(g => {
      const mine = graph.nodes.filter(n => n.group === g.id); if (!mine.length) return null;
      const d = document.createElement("div"); d.className = "barlabel group"; d.textContent = g.label; over.appendChild(d);
      return { d, x: Math.min(...mine.map(n => at(n).x)) - 2, y: Math.max(...mine.map(n => at(n).y)) + 5 };
    }).filter((g): g is { d: HTMLDivElement; x: number; y: number } => !!g);
    const tokenNames = tokens.map(t => { const d = document.createElement("div"); d.className = "barlabel tok"; d.textContent = t.replace(/^ +/, s => "·".repeat(s.length)).replace(/\n/g, "↵"); over.appendChild(d); return d; });
    const place = (d: HTMLElement, v: THREE.Vector3, anchor: string) => {
      const s = v.clone().project(camera);
      d.style.display = s.z > 1 ? "none" : "";
      d.style.transform = `translate(${(s.x + 1) / 2 * el.clientWidth}px, ${(1 - s.y) / 2 * el.clientHeight}px) translate(${anchor})`;
    };
    const draw = () => {
      renderer.render(scene, camera);
      names.forEach(({ d, n, sub }) => {
        const p = at(n), s = sizeOf(n);
        place(d, new THREE.Vector3(p.x, p.y + 1.1, 0), "0, -100%");
        // the second line is shown only where the bar is wide enough on screen to carry it, or names run into each other
        const a = new THREE.Vector3(p.x, p.y, 0).project(camera), b = new THREE.Vector3(p.x + s.w, p.y, 0).project(camera);
        const wide = Math.abs(b.x - a.x) / 2 * el.clientWidth;
        sub.style.display = wide > 120 ? "" : "none"; d.style.maxWidth = Math.max(60, wide + 30) + "px";
      });
      groupNames.forEach(g => place(g.d, new THREE.Vector3(g.x, g.y, 0), "0, -100%"));
      const chosen = graph.nodes.find(n => n.id === live.current.picked && bars[n.id]) ?? graph.nodes.find(n => bars[n.id]);
      tokenNames.forEach((d, t) => { if (!chosen) { d.style.display = "none"; return; } const p = at(chosen);
        d.classList.toggle("now", t === live.current.token); place(d, new THREE.Vector3(p.x - 0.9, p.y - t * STEP - TILE / 2, 0), "-100%, -50%"); });
    };

    // the view: all of it, seen a little from the left and above, and free to turn
    const box = new THREE.Box3();
    graph.nodes.forEach(n => { const p = at(n), s = sizeOf(n); box.expandByPoint(new THREE.Vector3(p.x - 6, p.y + 7, 0)); box.expandByPoint(new THREE.Vector3(p.x + s.w + 2, p.y - s.h - 2, 3)); });
    const centre = box.getCenter(new THREE.Vector3()), span = box.getSize(new THREE.Vector3());
    // The picture is as tall as the network needs at this width, within limits: a long chain of steps is wide and low,
    // and a fixed height would leave half the box empty.
    const tall = Math.round(Math.max(300, Math.min(640, W * span.y / span.x * 1.25 + 40)));
    (el.parentElement as HTMLElement).style.height = tall + "px";
    renderer.setSize(W, tall); camera.aspect = W / tall; camera.updateProjectionMatrix();
    const far = Math.max(span.x / (2 * Math.tan(Math.PI * 32 / 360) * camera.aspect), span.y / (2 * Math.tan(Math.PI * 32 / 360))) * 1.1;
    const controls = new OrbitControls(camera, renderer.domElement);
    const home = () => { camera.position.set(centre.x - far * 0.07, centre.y + far * 0.16, far * 0.99); controls.target.copy(centre); controls.update(); };
    controls.enableDamping = false; controls.zoomToCursor = true; controls.minDistance = 12; controls.maxDistance = far * 2.5;
    controls.addEventListener("change", draw);
    home();
    (el as any).resetView = home;

    const ray = new THREE.Raycaster(), ptr = new THREE.Vector2();
    const hit = (e: PointerEvent | MouseEvent) => {
      const b = renderer.domElement.getBoundingClientRect();
      ptr.set((e.clientX - b.left) / b.width * 2 - 1, -(e.clientY - b.top) / b.height * 2 + 1);
      ray.setFromCamera(ptr, camera);
      const found = ray.intersectObject(tiles)[0];
      return found?.instanceId != null ? { ...where[found.instanceId], x: e.clientX - b.left, y: e.clientY - b.top } : null;
    };
    const unitOf = (h: { node: BarNode; col: number }) => { const b = bars[h.node.id]; return b.how === "tokens" ? null : b.units ? b.units[h.col] : h.col; };
    const move = (e: PointerEvent) => {
      const h = hit(e);
      renderer.domElement.style.cursor = h ? "pointer" : "grab";
      if (!h) { setTip(null); return; }
      const u = unitOf(h);
      setTip({ x: h.x, y: h.y, text: [h.node.label, `token ${tokens[h.token]?.trim() || "(space)"}`, u == null ? `against ${tokens[h.col]?.trim() || "(space)"}` : `${h.node.unit ?? "unit"} ${fmt(u)}`, h.v == null ? "no value" : fmt(+h.v.toPrecision(4))] });
    };
    let downAt = [0, 0];
    const press = (e: PointerEvent) => { downAt = [e.clientX, e.clientY]; };
    const click = (e: MouseEvent) => {                                   // a click, not the end of a drag
      if (Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 4) return;
      const h = hit(e); if (h) live.current.onTile(h.node.id, h.token, unitOf(h));
    };
    renderer.domElement.addEventListener("pointermove", move);
    renderer.domElement.addEventListener("pointerleave", () => setTip(null));
    renderer.domElement.addEventListener("pointerdown", press);
    renderer.domElement.addEventListener("click", click);
    const ro = new ResizeObserver(() => { const w = el.clientWidth, h = el.clientHeight; if (!w || !h) return; camera.aspect = w / h; camera.updateProjectionMatrix(); renderer.setSize(w, h); draw(); });
    ro.observe(el);
    mark.current(live.current.token, live.current.picked);
    return () => { ro.disconnect(); controls.dispose(); renderer.dispose(); tiles.geometry.dispose(); (tiles.material as THREE.Material).dispose(); el.removeChild(renderer.domElement); over.replaceChildren(); };
  }, [graph, bars, tokens, theme]);

  useEffect(() => { mark.current(token, picked); }, [token, picked]);

  return (
    <div className="bars3d">
      <div ref={host} className="stage" role="img" aria-label="The network as bars, one per step, for the text that was run" />
      <div ref={labels} className="over" aria-hidden />
      <button className="small reset" onClick={() => (host.current as any)?.resetView?.()}>Reset view</button>
      {tip && <div className="tip" style={{ left: tip.x + 14, top: tip.y + 14 }}><div className="x">{tip.text[0]}</div><div>{tip.text[1]}, {tip.text[2]}</div><div><b>{tip.text[3]}</b></div></div>}
    </div>
  );
}
