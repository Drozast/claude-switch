#!/usr/bin/env node
// claude-switch: proxy conmutable entre Claude (suscripción) y Qwen local (LM Studio).
// El CLI de Claude Code apunta SIEMPRE a este servidor (ANTHROPIC_BASE_URL).
// - modo "claude": reenvía tal cual a api.anthropic.com (el token OAuth pasa intacto)
// - modo "qwen":   convierte Anthropic Messages API -> OpenAI y manda a LM Studio
// Cambio de modo en caliente: POST /__switch/toggle  (sin cerrar sesiones)

import { createServer } from 'node:http';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(__dirname, 'config.json');

// args opcionales (el manager lanza instancias por ventana: --port N --state-file path)
function argVal(flag) {
  const i = process.argv.indexOf(flag);
  return i > 0 ? process.argv[i + 1] : undefined;
}
const PORT_ARG = parseInt(argVal('--port') || '', 10) || 0;
const STATE_PATH = argVal('--state-file') || join(__dirname, 'state.json');

function loadConfig() {
  const def = {
    port: 8790,
    anthropicTarget: 'https://api.anthropic.com',
    lmstudioBase: 'http://127.0.0.1:1234/v1',
    qwenModel: 'qwen3-coder-30b',
    haikuModel: 'qwen3-coder-30b',
    extraOpenAI: {},
  };
  try {
    const c = { ...def, ...JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) };
    if (PORT_ARG) c.port = PORT_ARG;
    return c;
  } catch {
    return def;
  }
}

const cfg = loadConfig();

// ─── estado (modo) ───────────────────────────────────────────────
let state = { mode: 'claude' };
try {
  if (existsSync(STATE_PATH)) state = { ...state, ...JSON.parse(readFileSync(STATE_PATH, 'utf8')) };
} catch {}
function saveState() {
  try { writeFileSync(STATE_PATH, JSON.stringify(state, null, 2)); } catch {}
}

// ─── utilidades ──────────────────────────────────────────────────
function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.join(' ')}\n`;
  process.stdout.write(line);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function stripHopHeaders(headers) {
  const out = { ...headers };
  for (const h of ['host', 'connection', 'content-length', 'accept-encoding']) delete out[h];
  return out;
}

// ─── modo claude: proxy transparente ─────────────────────────────
async function proxyToAnthropic(req, res) {
  const target = new URL(req.url, cfg.anthropicTarget);
  const headers = stripHopHeaders(req.headers);
  headers['x-forwarded-host'] = 'api.anthropic.com';
  const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await readBody(req);

  const upstream = await fetch(target, {
    method: req.method,
    headers,
    body,
    redirect: 'manual',
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
    } catch (e) {
      log('stream error claude:', e.message);
    } finally {
      res.end();
    }
  } else {
    res.end();
  }
}

// ─── conversión Anthropic -> OpenAI ──────────────────────────────
function blockToText(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(b => (typeof b === 'string' ? b : b.text || '')).join('');
  return content.text || JSON.stringify(content);
}

function pickModel(name) {
  const n = String(name || '').toLowerCase();
  if (n.includes('haiku')) return cfg.haikuModel;
  return cfg.qwenModel;
}

function anthropicToOpenAI(body) {
  const messages = [];
  if (body.system) {
    const text = typeof body.system === 'string'
      ? body.system
      : body.system.map(b => (typeof b === 'string' ? b : b.text || '')).join('\n');
    if (text.trim()) messages.push({ role: 'system', content: text });
  }
  for (const m of body.messages || []) {
    if (typeof m.content === 'string') {
      messages.push({ role: m.role, content: m.content });
      continue;
    }
    const blocks = Array.isArray(m.content) ? m.content : [];
    if (m.role === 'user') {
      const userParts = [];
      for (const b of blocks) {
        if (b.type === 'tool_result') {
          messages.push({ role: 'tool', tool_call_id: b.tool_use_id, content: blockToText(b.content) });
        } else if (b.type === 'text') {
          userParts.push({ type: 'text', text: b.text });
        } else if (b.type === 'image' && b.source?.type === 'base64') {
          userParts.push({ type: 'image_url', image_url: { url: `data:${b.source.media_type};base64,${b.source.data}` } });
        }
      }
      if (userParts.length) {
        messages.push({ role: 'user', content: userParts.length === 1 && userParts[0].type === 'text' ? userParts[0].text : userParts });
      }
    } else {
      const texts = [];
      const toolCalls = [];
      for (const b of blocks) {
        if (b.type === 'text') texts.push(b.text);
        else if (b.type === 'tool_use') {
          toolCalls.push({ id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } });
        }
      }
      const msg = { role: 'assistant', content: texts.length ? texts.join('') : null };
      if (toolCalls.length) msg.tool_calls = toolCalls;
      messages.push(msg);
    }
  }

  const out = {
    model: pickModel(body.model),
    messages,
    stream: !!body.stream,
  };
  if (body.max_tokens != null) out.max_tokens = body.max_tokens;
  if (body.temperature != null) out.temperature = body.temperature;
  if (body.top_p != null) out.top_p = body.top_p;
  if (cfg.extraOpenAI && typeof cfg.extraOpenAI === 'object') Object.assign(out, cfg.extraOpenAI);
  if (Array.isArray(body.tools) && body.tools.length) {
    out.tools = body.tools.map(t => ({
      type: 'function',
      function: { name: t.name, description: t.description || '', parameters: t.input_schema ?? { type: 'object', properties: {} } },
    }));
    if (body.tool_choice) {
      const tc = body.tool_choice;
      if (tc.type === 'any') out.tool_choice = 'required';
      else if (tc.type === 'tool' && tc.name) out.tool_choice = { type: 'function', function: { name: tc.name } };
      // "auto" es el default de OpenAI, no se envía nada
    }
  }
  return out;
}

// ─── modo qwen: respuesta OpenAI -> Anthropic (no streaming) ─────
function openAIToAnthropic(data, requestedModel) {
  const choice = data.choices?.[0] || {};
  const msg = choice.message || {};
  const content = [];
  if (msg.content) content.push({ type: 'text', text: msg.content });
  for (const tc of msg.tool_calls || []) {
    let input = {};
    try { input = JSON.parse(tc.function?.arguments || '{}'); } catch {}
    content.push({ type: 'tool_use', id: tc.id || `toolu_${Math.random().toString(36).slice(2, 10)}`, name: tc.function?.name, input });
  }
  const usage = data.usage || {};
  return {
    id: data.id || `msg_${Date.now()}`,
    type: 'message',
    role: 'assistant',
    model: requestedModel,
    content,
    stop_reason: (choice.finish_reason === 'tool_calls' ? 'tool_use' : 'end_turn'),
    stop_sequence: null,
    usage: {
      input_tokens: usage.prompt_tokens || 0,
      output_tokens: usage.completion_tokens || 0,
    },
  };
}

// ─── modo qwen: streaming SSE OpenAI -> eventos Anthropic ────────
function sse(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

async function streamOpenAIToAnthropic(upstream, res, requestedModel) {
  let started = false;
  let finishReason = 'end_turn';
  let inputTokens = 0, outputTokens = 0;
  const blocks = new Map(); // index -> {type, id, name, json}
  let textBlockOpen = false;

  const ensureStart = () => {
    if (started) return;
    started = true;
    sse(res, 'message_start', {
      type: 'message_start',
      message: {
        id: `msg_${Date.now()}`, type: 'message', role: 'assistant', model: requestedModel,
        content: [], stop_reason: null, stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    });
  };

  const openTextBlock = () => {
    ensureStart();
    if (textBlockOpen) return;
    textBlockOpen = true;
    sse(res, 'content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
  };

  const closeTextBlock = () => {
    if (textBlockOpen) {
      sse(res, 'content_block_stop', { type: 'content_block_stop', index: 0 });
      textBlockOpen = false;
    }
  };

  const decoder = new TextDecoder();
  let buf = '';
  const reader = upstream.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') continue;
        let chunk;
        try { chunk = JSON.parse(payload); } catch { continue; }
        const delta = chunk.choices?.[0]?.delta;
        if (chunk.usage) {
          inputTokens = chunk.usage.prompt_tokens || inputTokens;
          outputTokens = chunk.usage.completion_tokens || outputTokens;
        }
        if (chunk.choices?.[0]?.finish_reason === 'tool_calls') finishReason = 'tool_use';
        if (!delta) continue;
        if (delta.content) {
          openTextBlock();
          sse(res, 'content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: delta.content } });
        }
        for (const tc of delta.tool_calls || []) {
          closeTextBlock();
          ensureStart();
          const i = tc.index ?? 0;
          let entry = blocks.get(i);
          if (!entry) {
            entry = { id: tc.id || `toolu_${Math.random().toString(36).slice(2, 10)}`, name: '', json: '' };
            blocks.set(i, entry);
            sse(res, 'content_block_start', {
              type: 'content_block_start', index: i + 1,
              content_block: { type: 'tool_use', id: entry.id, name: tc.function?.name || '', input: {} },
            });
          }
          if (tc.function?.name) entry.name = tc.function.name;
          if (tc.function?.arguments) {
            entry.json += tc.function.arguments;
            sse(res, 'content_block_delta', {
              type: 'content_block_delta', index: i + 1,
              delta: { type: 'input_json_delta', partial_json: tc.function.arguments },
            });
          }
        }
      }
    }
  } catch (e) {
    log('stream error qwen:', e.message);
  }
  closeTextBlock();
  for (const [i] of blocks) sse(res, 'content_block_stop', { type: 'content_block_stop', index: i + 1 });
  sse(res, 'message_delta', {
    type: 'message_delta',
    delta: { stop_reason: finishReason, stop_sequence: null },
    usage: { input_tokens: inputTokens, output_tokens: outputTokens },
  });
  sse(res, 'message_stop', { type: 'message_stop' });
  res.end();
}

async function handleQwen(req, res) {
  const raw = await readBody(req);
  let body;
  try { body = JSON.parse(raw.toString('utf8')); } catch {
    res.writeHead(400, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'body no es JSON' } }));
  }
  const openaiReq = anthropicToOpenAI(body);
  const url = `${cfg.lmstudioBase}/chat/completions`;

  let upstream;
  try {
    upstream = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(openaiReq),
    });
  } catch (e) {
    res.writeHead(502, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({
      type: 'error', error: {
        type: 'api_error',
        message: `LM Studio no responde en ${cfg.lmstudioBase}. ¿Está corriendo con el modelo cargado? (${e.message})`,
      },
    }));
  }

  const contentType = upstream.headers.get('content-type') || '';
  if (!upstream.ok) {
    const text = await upstream.text();
    res.writeHead(upstream.status, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({
      type: 'error', error: { type: 'api_error', message: `LM Studio ${upstream.status}: ${text.slice(0, 500)}` },
    }));
  }

  if (openaiReq.stream && contentType.includes('text/event-stream')) {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    await streamOpenAIToAnthropic(upstream, res, body.model);
  } else {
    const data = await upstream.json();
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(openAIToAnthropic(data, body.model)));
  }
}

// ─── UI web ──────────────────────────────────────────────────────
const UI = `<!doctype html>
<html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>claude-switch</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; margin: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; background: #14161a; color: #e8eaed; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 24px; }
  .card { width: 100%; max-width: 560px; background: #1d2025; border: 1px solid #2c3038; border-radius: 16px; padding: 28px; }
  h1 { font-size: 15px; letter-spacing: .08em; text-transform: uppercase; color: #9aa0a8; margin-bottom: 4px; }
  .status { font-size: 26px; font-weight: 700; margin: 10px 0 22px; display: flex; align-items: center; gap: 10px; }
  .dot { width: 12px; height: 12px; border-radius: 50%; }
  .dot.claude { background: #c96442; box-shadow: 0 0 10px #c9644288; }
  .dot.qwen { background: #7aa2f7; box-shadow: 0 0 10px #7aa2f788; }
  .btns { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  button { font-size: 17px; font-weight: 600; padding: 18px 12px; border-radius: 12px; border: 2px solid transparent; cursor: pointer; background: #262a31; color: #e8eaed; transition: all .15s; }
  button:hover { transform: translateY(-1px); }
  button.active.claude { border-color: #c96442; background: #c9644222; color: #ffb59d; }
  button.active.qwen { border-color: #7aa2f7; background: #7aa2f722; color: #a8c5ff; }
  .lm { margin-top: 18px; font-size: 13px; color: #9aa0a8; display: flex; align-items: center; gap: 8px; }
  .lm .ok { color: #6cc47e; } .lm .bad { color: #e5534b; }
  .hint { margin-top: 14px; font-size: 12px; color: #6b7078; line-height: 1.5; }
</style></head><body>
<div class="card">
  <h1>claude-switch</h1>
  <div class="status"><span class="dot claude" id="dot"></span><span id="mode">…</span></div>
  <div class="btns">
    <button id="bClaude" onclick="setMode('claude')">🟠 Claude · suscripción</button>
    <button id="bQwen" onclick="setMode('qwen')">🔵 Qwen · local</button>
  </div>
  <div class="lm" id="lm">comprobando LM Studio…</div>
  <div class="hint">El cambio es inmediato: las sesiones de Claude Code abiertas en VSCode pasan a usar el otro modelo con el próximo mensaje. No hay que cerrar nada.</div>
</div>
<script>
async function refresh() {
  try {
    const s = await (await fetch('/__switch/status')).json();
    document.getElementById('mode').textContent = s.mode === 'qwen' ? 'Qwen local' : 'Claude (suscripción)';
    document.getElementById('dot').className = 'dot ' + s.mode;
    document.getElementById('bClaude').className = s.mode === 'claude' ? 'active claude' : '';
    document.getElementById('bQwen').className = s.mode === 'qwen' ? 'active qwen' : '';
    const lm = document.getElementById('lm');
    if (s.lmstudio) { lm.innerHTML = '<span class="ok">●</span> LM Studio responde en ' + s.lmstudioBase; }
    else { lm.innerHTML = '<span class="bad">●</span> LM Studio NO responde en ' + s.lmstudioBase + ' — arrácalo antes de usar Qwen'; }
  } catch (e) { document.getElementById('mode').textContent = 'sin conexión al servidor'; }
}
async function setMode(m) { await fetch('/__switch/mode', { method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify({ mode: m }) }); refresh(); }
refresh(); setInterval(refresh, 4000);
</script></body></html>`;

// ─── servidor ────────────────────────────────────────────────────
async function lmstudioAlive() {
  try {
    const r = await fetch(`${cfg.lmstudioBase}/models`, { signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch { return false; }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${cfg.port}`);
  try {
    if (url.pathname === '/' || url.pathname === '/index.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(UI);
    }
    if (url.pathname === '/__switch/status') {
      const lmstudio = await lmstudioAlive();
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ mode: state.mode, lmstudio, lmstudioBase: cfg.lmstudioBase, qwenModel: cfg.qwenModel }));
    }
    if (url.pathname === '/__switch/toggle' && req.method === 'POST') {
      state.mode = state.mode === 'claude' ? 'qwen' : 'claude';
      saveState();
      log(`TOGGLE -> ${state.mode}`);
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ mode: state.mode }));
    }
    if (url.pathname === '/__switch/mode' && req.method === 'POST') {
      const body = await readBody(req);
      const { mode } = JSON.parse(body.toString('utf8') || '{}');
      if (mode !== 'claude' && mode !== 'qwen') {
        res.writeHead(400, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: 'mode debe ser "claude" o "qwen"' }));
      }
      if (mode !== state.mode) {
        state.mode = mode;
        saveState();
        log(`MODE -> ${mode}`);
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ mode: state.mode }));
    }
    // resto: /v1/messages y demás -> según modo
    if (state.mode === 'claude') return await proxyToAnthropic(req, res);
    if (url.pathname.startsWith('/v1/messages')) return await handleQwen(req, res);
    // endpoints menores en modo qwen (count_tokens etc.)
    if (url.pathname.includes('count_tokens')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ input_tokens: 1 }));
    }
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: `modo qwen no soporta ${url.pathname} (usa modo claude)` } }));
  } catch (e) {
    log('ERROR', req.method, req.url, e.message);
    if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: e.message } }));
  }
});

server.listen(cfg.port, '127.0.0.1', () => {
  log(`claude-switch listo en http://127.0.0.1:${cfg.port} (modo actual: ${state.mode})`);
  log(`  claude -> ${cfg.anthropicTarget}`);
  log(`  qwen   -> ${cfg.lmstudioBase} (${cfg.qwenModel})`);
});
