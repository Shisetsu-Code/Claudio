#!/usr/bin/env node
// MCP (stdio) con Playwright, orientado a VISIÓN: no depende del DOM ni del protocolo del juego.
// Claude mira capturas, decide, y actúa por coordenadas. Las herramientas están pensadas para
// minimizar viajes y tokens: acciones en lote, detección de "pantalla estable" por diferencia
// de imagen, bucle de tiradas con detección de anomalías y perfiles de coordenadas por juego.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { chromium } from "playwright";
import { PNG } from "pngjs";
import { z } from "zod";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SessionStore } from './lib/session.mjs';
import { startDashboard } from './lib/dashboard.mjs';
import { prepareSpeed, setContextSpeed } from './lib/speed.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROFILES_FILE = path.join(HERE, "profiles.json");
const dataDir = process.env.CLAUDIO_DATA_DIR || path.join(HERE, 'data');
const port = Number(process.env.CLAUDIO_DASHBOARD_PORT ?? 4317);
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('CLAUDIO_DASHBOARD_PORT inválido');
const store = new SessionStore({ dataDir });
const dashboard = await startDashboard({ store, port });
console.error(`[Claudio] Dashboard: ${dashboard.url}`);

let browser = null;
let page = null;
let context = null;
let speed = 1;
let fastMode = false;
let activeTool = null;
let stopRequested = false;
let needsSettle = false;
let pendingSpin = null;
let shuttingDown = false;
let points = {}; // nombre -> {x,y}
const netLog = [];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const text = (t) => ({ type: "text", text: typeof t === "string" ? t : JSON.stringify(t, null, 2) });
const ok = (t) => ({ content: [text(t)] });
const fail = (e) => ({ isError: true, content: [text(String(e?.message ?? e))] });
function ensure() {
  if (!page) throw new Error("No hay navegador abierto. Llama primero a launch_game.");
  return page;
}

// ---------- Capturas ----------
function addGrid(step) {
  const d = document.createElement("div");
  d.id = "__mcp_grid";
  d.style.cssText =
    "position:fixed;inset:0;z-index:2147483647;pointer-events:none;" +
    "background-image:linear-gradient(to right,rgba(255,0,0,.4) 1px,transparent 1px)," +
    "linear-gradient(to bottom,rgba(255,0,0,.4) 1px,transparent 1px);" +
    `background-size:${step}px ${step}px;`;
  for (let x = 0; x < innerWidth; x += step)
    for (let y = 0; y < innerHeight; y += step) {
      const s = document.createElement("span");
      s.textContent = x + "," + y;
      s.style.cssText = `position:absolute;left:${x + 2}px;top:${y + 1}px;font:9px monospace;color:#ff0;background:rgba(0,0,0,.6);padding:0 1px`;
      d.appendChild(s);
    }
  document.documentElement.appendChild(d);
}

async function shot({ grid = 0, quality = 60 } = {}) {
  const p = ensure();
  if (grid > 0) await p.evaluate(addGrid, grid).catch(() => {});
  try {
    const buf = await p.screenshot({ type: "jpeg", quality, timeout: 5000 });
    return { type: "image", data: buf.toString("base64"), mimeType: "image/jpeg" };
  } finally {
    if (grid > 0) await p.evaluate(() => document.getElementById("__mcp_grid")?.remove()).catch(() => {});
  }
}

// ---------- Comparación de imágenes (local, sin coste de tokens) ----------
const GX = 64, GY = 36;
async function snap(deadline = Infinity) {
  const buf = await ensure().screenshot({ type: "png", timeout: Math.max(1, Math.min(5000, deadline - Date.now())) });
  const { width: w, height: h, data } = PNG.sync.read(buf);
  const lum = new Uint8Array(GX * GY);
  let total = 0;
  for (let gy = 0; gy < GY; gy++)
    for (let gx = 0; gx < GX; gx++) {
      const cx = Math.floor(((gx + 0.5) * w) / GX), cy = Math.floor(((gy + 0.5) * h) / GY);
      let sum = 0, n = 0;
      for (let dy = -2; dy <= 2; dy += 2)
        for (let dx = -2; dx <= 2; dx += 2) {
          const x = Math.min(w - 1, Math.max(0, cx + dx)), y = Math.min(h - 1, Math.max(0, cy + dy));
          const i = (y * w + x) * 4;
          sum += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
          n++;
        }
      const v = sum / n;
      lum[gy * GX + gx] = v;
      total += v;
    }
  return { lum, mean: total / lum.length, png: buf };
}
function diff(a, b) {
  let ch = 0;
  for (let i = 0; i < a.lum.length; i++) if (Math.abs(a.lum[i] - b.lum[i]) > 25) ch++;
  return { changed: ch / a.lum.length, dLum: b.mean - a.mean };
}

// Espera a que empiece movimiento respecto a `ref` (la tirada reaccionó)
const interruption = deadline => stopRequested ? 'cancelled' : Date.now() >= deadline ? 'time_budget' : null;
const observeInterval = normal => fastMode ? Math.max(40, Math.round(normal / Math.max(2, speed))) : normal;

async function waitMotion(ref, timeout, threshold, deadline = Infinity) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout && !interruption(deadline)) {
    await sleep(Math.min(observeInterval(120), Math.max(1, deadline - Date.now())));
    if (interruption(deadline)) return false;
    if (diff(ref, await snap(deadline)).changed > threshold) return true;
  }
  return false;
}
// Espera a que la pantalla deje de cambiar (tolera animaciones idle pequeñas)
async function waitStable({ interval = observeInterval(350), checks = 2, threshold = 0.01, timeout = 20000, deadline = Infinity } = {}) {
  const t0 = Date.now();
  let prev = await snap(deadline), good = 0, last = 1;
  while (Date.now() - t0 < timeout && !interruption(deadline)) {
    await sleep(Math.min(interval, Math.max(1, deadline - Date.now())));
    if (interruption(deadline)) break;
    const cur = await snap(deadline);
    last = diff(prev, cur).changed;
    good = last <= threshold ? good + 1 : 0;
    prev = cur;
    if (good >= checks) return { stable: true, ms: Date.now() - t0, snap: cur };
  }
  return { stable: false, ms: Date.now() - t0, snap: prev, last };
}

// ---------- Acciones ----------
function resolvePoint(a) {
  if (a.point) {
    const p = points[a.point];
    if (!p) throw new Error(`Punto '${a.point}' no definido. Usa set_point o load_profile.`);
    return p;
  }
  if (a.x == null || a.y == null) throw new Error("La acción necesita x,y o point.");
  return { x: a.x, y: a.y };
}
async function doClick(p, { x, y }) {
  await p.mouse.move(x, y);
  await p.mouse.down();
  await sleep(50);
  await p.mouse.up();
}
const ActionSchema = z.object({
  type: z.enum(["click", "key", "wait", "wait_stable"]),
  x: z.number().optional(),
  y: z.number().optional(),
  point: z.string().optional().describe("Nombre de un punto guardado (alternativa a x,y)"),
  key: z.string().optional().describe("p. ej. Space, Enter, Escape"),
  ms: z.number().int().optional(),
});
async function runAction(a) {
  const p = ensure();
  if (a.type === "click") {
    const pt = resolvePoint(a);
    await doClick(p, pt);
    return `click ${pt.x},${pt.y}`;
  }
  if (a.type === "key") {
    if (!a.key) throw new Error("key requerida");
    await p.keyboard.press(a.key);
    return `key ${a.key}`;
  }
  if (a.type === "wait") {
    await sleep(a.ms ?? 500);
    return `wait ${a.ms ?? 500}ms`;
  }
  const r = await waitStable();
  return `wait_stable → ${r.stable ? "estable" : "TIMEOUT"} (${r.ms}ms)`;
}

// ---------- Red (opcional, solo como ayuda de depuración) ----------
function attachNetwork(p) {
  p.on("response", async (res) => {
    try {
      const req = res.request();
      if (!["xhr", "fetch"].includes(req.resourceType())) return;
      let body = "";
      try { body = await res.text(); } catch {}
      netLog.push({ url: res.url(), status: res.status(), method: req.method(), post: (req.postData() || "").slice(0, 500), body: body.slice(0, 1500) });
      if (netLog.length > 500) netLog.splice(0, netLog.length - 500);
    } catch {}
  });
}

// ---------- Servidor ----------
const server = new McpServer({ name: "slot-vision-mcp", version: "3.0.0" }, {
  instructions: 'Usa get_dashboard para mostrar el seguimiento local. Registra lo que descubras con record_finding: el detector visual solo señala cambios, no interpreta bonus ni premios. Usa set_speed para velocidad y fast_mode. Elapsed y timeouts son tiempo real. stop_loop interrumpe un lote; consulta get_status durante la ejecución. Opera juegos demo autorizados.',
});

const concurrent = new Set(['get_status', 'get_dashboard', 'record_finding', 'set_speed', 'stop_loop', 'list_points', 'get_network_log']);
function tool(name, description, schema, callback) {
  server.tool(name, description, schema, async (...args) => {
    const exclusive = !concurrent.has(name);
    if (exclusive && activeTool) return fail(`El navegador está ocupado con ${activeTool}. Usa get_status o stop_loop.`);
    if (exclusive) activeTool = name;
    try {
      const result = await callback(...args);
      if (result?.isError && name !== 'get_status' && name !== 'get_dashboard') {
        const message = result.content?.filter(item => item.type === 'text').map(item => item.text).join('\n') || 'La herramienta falló.';
        store.error(new Error(message));
      }
      return result;
    }
    catch (error) { if (exclusive) store.error(error); return fail(error); }
    finally { if (exclusive) { activeTool = null; stopRequested = false; } }
  });
}

tool(
  "launch_game",
  "Abre Chromium y carga la URL. Opcionalmente pulsa botones DOM por texto (cookies, 'Play demo'...). Devuelve captura.",
  {
    url: z.string().url(),
    headless: z.boolean().default(false),
    width: z.number().int().default(1280),
    height: z.number().int().default(720),
    wait_ms: z.number().int().default(8000),
    auto_click_texts: z.array(z.string()).default(["accept", "aceptar", "play demo", "demo", "jugar"]).describe("Textos de botones/enlaces a pulsar si existen, en orden"),
    capture_network: z.boolean().default(false).describe('Activa el registro de red solo para diagnóstico; desactivado ahorra trabajo y memoria.'),
  },
  async ({ url, headless, width, height, wait_ms, auto_click_texts, capture_network }) => {
    try {
      if (browser) await browser.close().catch(() => {});
      browser = page = context = null;
      speed = 1; fastMode = false; needsSettle = false; pendingSpin = null;
      store.start(url);
      netLog.length = 0;
      browser = await chromium.launch({ headless, args: ['--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'] });
      const launchedBrowser = browser;
      launchedBrowser.on('disconnected', () => { if (browser === launchedBrowser && !shuttingDown) { browser = page = context = null; store.close(); } });
      context = await browser.newContext({ viewport: { width, height } });
      await prepareSpeed(context, speed);
      page = await context.newPage();
      const launchedPage = page;
      page.on('close', () => { if (page === launchedPage) { page = null; store.close(); } });
      page.on('crash', () => { store.error(new Error('El navegador del juego falló.')); store.close('error'); });
      if (capture_network) attachNetwork(page);
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
      for (const t of auto_click_texts) {
        const re = new RegExp(t, "i");
        for (const role of ["button", "link"]) {
          try {
            const el = page.getByRole(role, { name: re }).first();
            if (await el.isVisible({ timeout: 700 })) { await el.click({ timeout: 2000 }); await sleep(fastMode ? 300 : 1200); }
          } catch {}
        }
      }
      await sleep(wait_ms);
      store.update({ status: 'ready', phase: 'Listo para observar', url: page.url(), title: await page.title() || new URL(url).hostname });
      store.event('navigation', 'Juego cargado');
      return { content: [text(`Cargado: ${page.url()} (viewport ${width}x${height}; coordenadas de captura = coordenadas de clic). Dashboard: ${dashboard.url}`), await shot()] };
    } catch (e) { store.error(e); store.close('error'); if (browser) await browser.close().catch(() => {}); browser = page = context = null; return fail(e); }
  }
);

tool(
  "screenshot",
  "Captura JPEG del viewport. Con grid>0 (p. ej. 100) dibuja una cuadrícula etiquetada con coordenadas para localizar botones con precisión.",
  { grid: z.number().int().min(0).max(400).default(0), quality: z.number().int().min(20).max(90).default(60) },
  async ({ grid, quality }) => { try { return { content: [await shot({ grid, quality })] }; } catch (e) { return fail(e); } }
);

tool(
  "act",
  "Ejecuta varias acciones seguidas en UNA llamada (click/key/wait/wait_stable) y devuelve una sola captura final. Úsala para encadenar pasos y ahorrar viajes.",
  { actions: z.array(ActionSchema).min(1).max(30), grid: z.number().int().min(0).max(400).default(0) },
  async ({ actions, grid }) => {
    try {
      const log = [];
      store.update({ phase: 'Ejecutando acciones' });
      for (const a of actions) log.push(await runAction(a));
      store.update({ status: 'ready', phase: 'Listo para observar', lastError: null });
      store.event('action', `${actions.length} acciones ejecutadas`, log);
      return { content: [text(log.join("\n")), await shot({ grid })] };
    } catch (e) { return fail(e); }
  }
);

tool(
  "wait_stable",
  "Espera a que la pantalla deje de cambiar (animaciones terminadas), comparando imágenes localmente. Devuelve captura.",
  {
    timeout_ms: z.number().int().default(20000),
    threshold: z.number().default(0.01).describe("Fracción de celdas cambiadas tolerada (0-1)"),
  },
  async ({ timeout_ms, threshold }) => {
    try {
      const r = await waitStable({ timeout: timeout_ms, threshold });
      return { content: [text(`${r.stable ? "estable" : "TIMEOUT sin estabilizar"} en ${r.ms}ms`), await shot()] };
    } catch (e) { return fail(e); }
  }
);

tool(
  "spin_loop",
  "Hace tiradas repetidas con la misma acción (tecla o clic) SIN que tengas que mirar cada una. Tras cada tirada espera a que empiece el movimiento y luego a que se estabilice. Se detiene y te devuelve captura si detecta una anomalía (sin reacción, no se estabiliza, oscurecimiento/popup, cambio de escena como bonus/free spins) o al agotar el presupuesto de tiempo. No toca la apuesta.",
  {
    count: z.number().int().min(1).max(10000).default(10),
    action: ActionSchema.refine(a => a.type === 'click' || a.type === 'key', { message: 'spin_loop solo admite click o key.' }).default({ type: "key", key: "Space" }),
    max_seconds: z.number().int().min(5).max(600).default(50).describe("Presupuesto por llamada; si se agota devuelve 'time_budget' y puedes volver a llamar"),
    start_timeout_ms: z.number().int().default(3000),
    spin_timeout_ms: z.number().int().default(45000),
    stable_threshold: z.number().default(0.01),
    motion_threshold: z.number().default(0.01),
    lum_threshold: z.number().default(15).describe("Cambio de luminosidad media que se considera popup/oscurecimiento"),
    scene_threshold: z.number().default(0.55).describe("Fracción de celdas cambiadas que se considera cambio de escena"),
    stop_on_anomaly: z.boolean().default(true),
    snapshot_every: z.number().int().min(0).default(0).describe("Si >0 adjunta una miniatura cada N tiradas (máx. 5)"),
    save_dir: z.string().optional().describe("Si se indica, guarda cada captura post-tirada como PNG en esa carpeta"),
  },
  async (o) => {
    let rows = [], anomalies = [], images = [];
    let deadline = Infinity;
    try {
      ensure();
      stopRequested = false;
      if (o.save_dir) fs.mkdirSync(o.save_dir, { recursive: true });
      const t0 = Date.now();
      deadline = t0 + o.max_seconds * 1000;
      let status = "completed";
      if (needsSettle) {
        store.update({ phase: 'Esperando que termine la tirada anterior' });
        const settled = await waitStable({ threshold: o.stable_threshold, timeout: o.spin_timeout_ms, deadline });
        if (!settled.stable) {
          status = interruption(deadline) || 'anomalia';
          store.finishBatch(status);
          return { content: [text({ status, tiradas_hechas: 0, pendientes: o.count, nota: 'La tirada anterior todavía no está estable.' }), await shot()] };
        }
        if (pendingSpin) store.resolvePending({ moved: pendingSpin.moved, ms: Date.now() - pendingSpin.startedAt });
        pendingSpin = null;
        needsSettle = false;
      }
      store.beginBatch(o.count);
      let prev = await snap(deadline);
      for (let i = 1; i <= o.count; i++) {
        if (interruption(deadline)) { status = interruption(deadline); break; }
        const before = prev;
        needsSettle = true;
        store.update({ phase: `Tirada ${i} de ${o.count}: esperando movimiento` });
        await runAction(o.action);
        const ts = Date.now();
        pendingSpin = { startedAt: ts, moved: false };
        store.attempt();
        const moved = await waitMotion(before, o.start_timeout_ms, o.motion_threshold, deadline);
        pendingSpin.moved = moved;
        if (interruption(deadline)) { status = interruption(deadline); break; }
        store.update({ phase: `Tirada ${i} de ${o.count}: esperando estabilidad` });
        const st = await waitStable({ timeout: o.spin_timeout_ms, threshold: o.stable_threshold, deadline });
        if (interruption(deadline)) { status = interruption(deadline); break; }
        const d = diff(before, st.snap);
        const row = { i, moved, ms: Date.now() - ts, changed: +d.changed.toFixed(3), dLum: +d.dLum.toFixed(1) };
        const reasons = [];
        if (!moved) reasons.push("sin_reaccion");
        if (!st.stable) reasons.push("no_se_estabiliza");
        if (Math.abs(d.dLum) > o.lum_threshold) reasons.push("cambio_luminosidad");
        if (d.changed > o.scene_threshold) reasons.push("cambio_escena");
        if (reasons.length) { row.anomalia = reasons; anomalies.push({ i, reasons }); }
        rows.push(row);
        needsSettle = !st.stable;
        store.spin(row);
        pendingSpin = null;
        if (o.save_dir) fs.writeFileSync(path.join(o.save_dir, `spin_${String(i).padStart(5, "0")}.png`), st.snap.png);
        if (o.snapshot_every > 0 && i % o.snapshot_every === 0 && images.length < 5) images.push(await shot({ quality: 40 }));
        prev = st.snap;
        if (reasons.length && o.stop_on_anomaly) { status = "anomalia"; break; }
      }
      store.finishBatch(status);
      const summary = {
        status,
        tiradas_hechas: rows.length,
        pendientes: o.count - rows.length,
        segundos: +((Date.now() - t0) / 1000).toFixed(1),
        anomalias: anomalies,
        ultimas: rows.slice(-8),
        tirada_en_curso: needsSettle,
        dashboard: dashboard.url,
      };
      return { content: [text(summary), ...images, await shot()] };
    } catch (e) {
      if (interruption(deadline)) {
        const status = interruption(deadline);
        store.finishBatch(status);
        return ok({ status, tiradas_hechas: rows.length, pendientes: o.count - rows.length, tirada_en_curso: needsSettle, dashboard: dashboard.url });
      }
      store.finishBatch('error'); store.error(e); return fail(e);
    }
  }
);

tool(
  "set_point",
  "Guarda un punto con nombre (p. ej. spin, bet_plus, buy_bonus, ante_bet, close_popup) para usarlo luego en act/spin_loop con {point:'spin'}.",
  { name: z.string(), x: z.number(), y: z.number() },
  async ({ name, x, y }) => { points[name] = { x, y }; store.event('point', `Punto guardado: ${name}`, { x, y }); return ok(points); }
);
tool("list_points", "Lista los puntos guardados.", {}, async () => ok(points));

tool(
  "save_profile",
  "Guarda los puntos actuales bajo el nombre de un juego, para reutilizarlos en futuras sesiones.",
  { game: z.string() },
  async ({ game }) => {
    const all = fs.existsSync(PROFILES_FILE) ? JSON.parse(fs.readFileSync(PROFILES_FILE, "utf8")) : {};
    all[game] = { points, viewport: page ? page.viewportSize() : null };
    fs.writeFileSync(PROFILES_FILE, JSON.stringify(all, null, 2));
    return ok(`Perfil '${game}' guardado (${Object.keys(points).length} puntos).`);
  }
);
tool(
  "load_profile",
  "Carga los puntos guardados de un juego. Verifica con una captura que el viewport coincide.",
  { game: z.string() },
  async ({ game }) => {
    const all = fs.existsSync(PROFILES_FILE) ? JSON.parse(fs.readFileSync(PROFILES_FILE, "utf8")) : {};
    if (!all[game]) return fail(`No hay perfil '${game}'. Disponibles: ${Object.keys(all).join(", ") || "ninguno"}`);
    points = all[game].points || {};
    return ok({ points, viewport_guardado: all[game].viewport });
  }
);

tool("list_frames", "URLs de los frames de la página (diagnóstico).", {}, async () => {
  try { return ok(ensure().frames().map((f) => f.url())); } catch (e) { return fail(e); }
});
tool(
  "get_network_log",
  "Opcional/diagnóstico: últimas peticiones XHR/fetch capturadas. No es necesario para operar el juego.",
  { last_n: z.number().int().default(10), filter: z.string().optional() },
  async ({ last_n, filter }) => ok((filter ? netLog.filter((e) => (e.url + e.post + e.body).includes(filter)) : netLog).slice(-last_n))
);
tool("close_game", "Cierra el navegador.", {}, async () => {
  try { if (browser) await browser.close(); } catch {}
  browser = page = context = null;
  store.close();
  return ok("Navegador cerrado.");
});

tool('set_speed', 'Ajusta velocidad del reloj del juego (1–8×) y observación rápida del MCP. No acelera red ni reloj del dashboard; compatibilidad depende del motor.', {
  rate: z.number().min(1).max(8).default(1), fast_mode: z.boolean().default(true),
}, async ({ rate, fast_mode }) => {
  ensure();
  if (!context) throw new Error('No hay contexto de navegador.');
  const applied = await setContextSpeed(context, rate);
  speed = rate; fastMode = fast_mode;
  store.update({ speed, fastMode });
  store.event('speed', `Velocidad ${speed}× · observación ${fastMode ? 'rápida' : 'normal'}`, applied);
  return ok({ ...applied, fast_mode: fastMode, note: 'Acelera relojes y animaciones compatibles, no respuestas del servidor del juego.' });
});
tool('get_status', 'Estado y progreso actual, duración real, lotes, anomalías y descubrimientos. Se puede consultar durante spin_loop.', {}, async () => ok(store.snapshot()));
tool('get_dashboard', 'Devuelve la URL del dashboard local con seguimiento en vivo e historial. Ábrela en tu navegador.', {}, async () => ok({ url: dashboard.url, local_only: true }));
tool('record_finding', 'Registra un descubrimiento observado por Claude en el dashboard. Describe evidencia; no conviertas un cambio visual automático en un bonus confirmado.', {
  title: z.string().trim().min(1).max(160), detail: z.string().trim().min(1).max(4000),
  category: z.enum(['observation', 'mechanic', 'bonus', 'issue', 'strategy']).default('observation'),
}, async finding => ok(store.finding(finding)));
tool('stop_loop', 'Solicita detener spin_loop y conserva su progreso. Si hay una tirada en curso, el próximo lote esperará a que termine.', {}, async () => {
  if (activeTool === 'spin_loop') { stopRequested = true; store.event('control', 'Detención solicitada'); return ok({ stopping: true }); }
  return ok({ stopping: false, note: 'No hay un lote activo.' });
});

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true; stopRequested = true;
  store.close('interrupted');
  try { if (browser) await browser.close(); } catch {}
  store.flush();
  await dashboard.close();
}
process.on('SIGINT', () => { void shutdown().then(() => process.exit(0)); });
process.on('SIGTERM', () => { void shutdown().then(() => process.exit(0)); });
process.stdin.on('end', () => { void shutdown(); });
await server.connect(new StdioServerTransport());
