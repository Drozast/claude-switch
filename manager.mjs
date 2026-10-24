#!/usr/bin/env node
// claude-switch manager: plano de control para proxies por-ventana.
// Cada ventana de VSCode (vía la extensión) adquiere un puerto con un owner
// estable; el manager spunea una instancia de server.mjs por puerto y la
// mantiene viva. El modo se cambia por puerto => cada ventana es independiente.
//
// API:
//   POST /__ports/acquire  {"owner":"..."}        -> {"port":8791}
//   POST /__ports/release  {"owner":"..."}
//   GET  /__ports/list                                -> [{owner,port,mode,alive}]
//   GET  /                                           -> UI global (todas las ventanas)

import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync, openSync, closeSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(__dirname, 'config.json');
const STATES_DIR = join(__dirname, 'states');
const MANAGER_STATE = join(__dirname, 'manager-state.json');

function loadConfig() {
  try { return JSON.parse(readFileSync(CONFIG_PATH, 'utf8')); } catch { return {}; }
}
const cfg = loadConfig();
const MANAGER_PORT = cfg.managerPort || 8790;
const PORT_MIN = (cfg.managerPort || 8790) + 1;
const PORT_MAX = PORT_MIN + 120;

mkdirSync(STATES_DIR, { recursive: true });

// owner -> {port, pid, child, label, acquiredAt}
let assignments = new Map();
try {
  const saved = JSON.parse(readFileSync(MANAGER_STATE, 'utf8'));
  for (const a of saved) {
    assignments.set(a.owner, { port: a.port, pid: null, child: null, label: a.label || a.owner, acquiredAt: Date.now() });
  }
} catch {}

function saveManagerState() {
  const arr = [...assignments.values()].map(a => ({ owner: a.owner, port: a.port, label: a.label }));
  try { writeFileSync(MANAGER_STATE, JSON.stringify(arr, null, 2)); } catch {}
}

function isAlive(a) {
  // hijo vivo: sin exitCode Y sin signalCode (pkill externo deja exitCode===null)
  if (a.child && a.child.exitCode === null && !a.child.killed && !a.child.signalCode) return true;
  if (a.pid) {
    try { process.kill(a.pid, 0); return true; } catch {}
  }
  return false;
}

function spawnProxy(port) {
  const out = openSync(join(__dirname, `proxy-${port}.log`), 'a');
  const err = openSync(join(__dirname, `proxy-${port}.err.log`), 'a');
  const child = spawn(process.execPath, [join(__dirname, 'server.mjs'), '--port', String(port), '--state-file', join(STATES_DIR, `state-${port}.json`)], {
    stdio: ['ignore', out, err],
  });
  closeSync(out); closeSync(err); // el hijo conserva su copia heredada
  child.on('error', () => {});
  child.unref();
  return child;
}

// re-spawn lo que quedó asignado pero sin proceso (tras reinicio del manager)
for (const a of assignments.values()) {
  if (!isAlive(a)) a.child = spawnProxy(a.port);
}

function freePort() {
  const used = new Set(assignments.values().map(a => a.port));
  used.add(DEFAULT_PORT); // reservado para el proxy default (terminal)
  for (let p = PORT_MIN; p <= PORT_MAX; p++) if (!used.has(p)) return p;
  return null;
}

async function proxyMode(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/__switch/status`, { signal: AbortSignal.timeout(1500) });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

function labelOf(owner) {
  // owner formato: vscode-window:<carpeta>:<rand>  -> mostrar carpeta
  const parts = String(owner).split(':');
  return parts.length >= 2 ? parts[1] : owner;
}

// proxy "default" para terminal (el CLI fuera de VSCode apunta al puerto del manager)
const DEFAULT_PORT = PORT_MIN;
let defaultChild = spawnProxy(DEFAULT_PORT);
setInterval(() => {
  if (!isAlive({ child: defaultChild })) defaultChild = spawnProxy(DEFAULT_PORT);
}, 15000).unref();

// reap: cada 30s revive proxies de ventanas que murieron
setInterval(() => {
  for (const a of assignments.values()) {
    if (!isAlive(a)) a.child = spawnProxy(a.port); // reintento automático
  }
}, 30000).unref();

// reenvío transparente al proxy default (para /v1/* del CLI de terminal)
async function forwardToDefault(req, res) {
  const body = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readBody(req) : undefined;
  const upstream = await fetch(`http://127.0.0.1:${DEFAULT_PORT}${req.url}`, {
    method: req.method,
    headers: { ...req.headers, host: `127.0.0.1:${DEFAULT_PORT}` },
    body,
  });
  res.statusCode = upstream.status;
  for (const [k, v] of upstream.headers) {
    if (['transfer-encoding', 'connection', 'content-encoding'].includes(k.toLowerCase())) continue;
    res.setHeader(k, v);
  }
  if (upstream.body) {
    const reader = upstream.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(value);
      }
    } catch {} finally { res.end(); }
  } else res.end();
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', () => resolve(''));
  });
}

const UI = `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>claude-switch · todas las ventanas</title>
<style>
  :root{color-scheme:dark} *{box-sizing:border-box;margin:0}
  body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;background:#14161a;color:#e8eaed;padding:24px;max-width:760px;margin:0 auto}
  h1{font-size:15px;letter-spacing:.08em;text-transform:uppercase;color:#9aa0a8;margin-bottom:16px}
  .row{display:flex;align-items:center;gap:12px;background:#1d2025;border:1px solid #2c3038;border-radius:12px;padding:14px 16px;margin-bottom:10px}
  .win{flex:1;font-weight:600;font-size:14px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .win small{display:block;color:#6b7078;font-weight:400;font-size:11px}
  .dot{width:10px;height:10px;border-radius:50%;flex:none}
  .dot.claude{background:#c96442}.dot.qwen{background:#7aa2f7}.dot.dead{background:#555}
  button{font-size:13px;font-weight:600;padding:8px 12px;border-radius:8px;border:1.5px solid transparent;cursor:pointer;background:#262a31;color:#e8eaed}
  button.active.claude{border-color:#c96442;background:#c9644222;color:#ffb59d}
  button.active.qwen{border-color:#7aa2f7;background:#7aa2f722;color:#a8c5ff}
  .hint{margin-top:14px;font-size:12px;color:#6b7078;line-height:1.5}
</style></head><body>
<h1>claude-switch · ventanas activas</h1>
<div id="list"><span style="color:#6b7078">cargando…</span></div>
<div class="hint">La fila <b>Terminal / global</b> es el proxy del CLI fuera de VSCode (puerto 8790). Cada ventana de VSCode tiene su propio proxy (puerto propio): cambiar el modo aquí equivale a hacer clic en la barra de estado de esa ventana. Los modos se conservan entre reinicios.</div>
<script>
async function refresh(){
  const r = await fetch('/__ports/list'); const data = await r.json();
  const el = document.getElementById('list');
  if (!data.length) { el.innerHTML = '<span style="color:#6b7078">sin ventanas conectadas</span>'; return; }
  el.innerHTML = '';
  for (const w of data) {
    const d = document.createElement('div'); d.className='row';
    d.innerHTML = '<span class="dot '+(w.alive?(w.mode||'claude'):'dead')+'"></span>'
      + '<div class="win">'+w.label+'<small>puerto '+w.port+(w.alive?'':' · proxy caído (reconectando)')+'</small></div>';
    for (const m of ['claude','qwen']) {
      const b = document.createElement('button');
      b.textContent = m==='claude' ? '🟠 Claude' : '🔵 Otro modelo';
      b.className = (w.mode===m && w.alive) ? ('active '+m) : '';
      b.onclick = async () => {
        await fetch('http://127.0.0.1:'+w.port+'/__switch/mode',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({mode:m})});
        refresh();
      };
      d.appendChild(b);
    }
    el.appendChild(d);
  }
}
refresh(); setInterval(refresh, 4000);
</script></body></html>`;

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${MANAGER_PORT}`);
  try {
    if (url.pathname === '/' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(UI);
    }
    if (url.pathname === '/__ports/acquire' && req.method === 'POST') {
      const { owner } = JSON.parse((await readBody(req)) || '{}');
      if (!owner) { res.writeHead(400, {'content-type':'application/json'}); return res.end('{"error":"owner requerido"}'); }
      let a = assignments.get(owner);
      if (!a) {
        const port = freePort();
        if (!port) { res.writeHead(503, {'content-type':'application/json'}); return res.end('{"error":"sin puertos libres"}'); }
        a = { owner, port, pid: null, child: null, label: labelOf(owner), acquiredAt: Date.now() };
        assignments.set(owner, a);
      }
      if (!isAlive(a)) a.child = spawnProxy(a.port);
      saveManagerState();
      // espera breve a que el proxy levante
      for (let i = 0; i < 20; i++) {
        const s = await proxyMode(a.port);
        if (s) break;
        await new Promise(r => setTimeout(r, 150));
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ port: a.port }));
    }
    if (url.pathname === '/__ports/release' && req.method === 'POST') {
      const { owner } = JSON.parse((await readBody(req)) || '{}');
      const a = assignments.get(owner);
      if (a) {
        try { a.child?.kill(); } catch {}
        assignments.delete(owner);
        saveManagerState();
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end('{}');
    }
    if (url.pathname === '/__ports/list') {
      const out = [];
      const ds = await proxyMode(DEFAULT_PORT);
      out.push({ owner: '__default__', label: 'Terminal / global', port: DEFAULT_PORT, mode: ds?.mode || null, alive: !!ds });
      for (const [owner, a] of assignments) {
        const s = await proxyMode(a.port);
        out.push({ owner, label: a.label, port: a.port, mode: s?.mode || null, alive: !!s });
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(out));
    }
    // todo lo demás (/v1/* del CLI de terminal) -> proxy default
    if (req.method !== 'GET' || !url.pathname.startsWith('/__')) return await forwardToDefault(req, res);
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{"error":"not found"}');
  } catch (e) {
    if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: e.message }));
  }
});

server.listen(MANAGER_PORT, '127.0.0.1', () => {
  console.log(`[manager] claude-switch en http://127.0.0.1:${MANAGER_PORT} (puertos de proxy: ${PORT_MIN}-${PORT_MAX})`);
});
