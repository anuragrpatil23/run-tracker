// Drive headless Chrome over its debugging protocol: open a page, run steps, report errors, save screenshots.
// usage: node cdp.mjs <url> <out-prefix> [width height] then steps read from stdin as JS (async body with page helpers)
import { spawn } from "node:child_process";
import { writeFileSync, readFileSync } from "node:fs";
const [url, prefix, W = "1700", H = "1050"] = process.argv.slice(2);
const chrome = spawn("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ["--headless=new", "--disable-gpu", "--remote-debugging-port=9333", `--window-size=${W},${H}`, "--user-data-dir=/tmp/cdp-profile-" + process.pid, "about:blank"], { stdio: "ignore" });
const sleep = ms => new Promise(r => setTimeout(r, ms));
let target;
for (let i = 0; i < 40 && !target; i++) { await sleep(250); try { target = (await (await fetch("http://127.0.0.1:9333/json")).json()).find(t => t.type === "page"); } catch {} }
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise(r => (ws.onopen = r));
let id = 0; const waiting = new Map(); const errors = [];
ws.onmessage = m => { const d = JSON.parse(m.data);
  if (d.id && waiting.has(d.id)) { waiting.get(d.id)(d.result ?? d.error); waiting.delete(d.id); }
  if (d.method === "Runtime.exceptionThrown") errors.push(d.params.exceptionDetails.exception?.description ?? d.params.exceptionDetails.text);
  if (d.method === "Runtime.consoleAPICalled" && d.params.type === "error") errors.push("console.error: " + d.params.args.map(a => a.value ?? a.description).join(" ")); };
const send = (method, params = {}) => new Promise(r => { waiting.set(++id, r); ws.send(JSON.stringify({ id, method, params })); });
await send("Runtime.enable"); await send("Page.enable");
const page = {
  sleep,
  goto: async u => { await send("Page.navigate", { url: u }); await sleep(2500); },
  js: async expr => (await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true })).result?.value,
  shot: async name => writeFileSync(`${prefix}-${name}.png`, Buffer.from((await send("Page.captureScreenshot", { format: "png" })).data, "base64")),
  mouse: (type, x, y, extra = {}) => send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1, ...extra }),
  click: async (x, y, extra) => { await page.mouse("mousePressed", x, y, extra); await page.mouse("mouseReleased", x, y, extra); await sleep(400); },
  drag: async (x1, y, x2) => { await page.mouse("mouseMoved", x1, y); await page.mouse("mousePressed", x1, y); for (let x = x1; x <= x2; x += 20) await page.mouse("mouseMoved", x, y); await page.mouse("mouseReleased", x2, y); await sleep(600); },
  box: sel => page.js(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const r = e.getBoundingClientRect(); return {x: r.x, y: r.y, w: r.width, h: r.height}; })()`),
  clickText: async (text, sel = "button") => { const b = await page.js(`(() => { const e = [...document.querySelectorAll(${JSON.stringify(sel)})].find(e => e.textContent.trim().startsWith(${JSON.stringify(text)})); if (!e) return null; const r = e.getBoundingClientRect(); return {x: r.x + r.width/2, y: r.y + r.height/2}; })()`); if (!b) { console.log("NOT FOUND:", text); return false; } await page.click(b.x, b.y); return true; },
};
try { await page.goto(url); await (new (Object.getPrototypeOf(async function () {}).constructor)("page", readFileSync(0, "utf8")))(page); }
catch (e) { console.log("STEP FAILED:", e.message); }
console.log(errors.length ? "PAGE ERRORS:\n" + [...new Set(errors)].join("\n").slice(0, 1500) : "no page errors");
ws.close(); chrome.kill();
