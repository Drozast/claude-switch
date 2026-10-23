// Claude Model Switch (por-ventana): cada ventana de VSCode tiene su propio
// proxy (puerto asignado por el manager) y su propio modo. El modo se inyecta
// vía claudeCode.environmentVariables a nivel de VENTANA, así las sesiones de
// esta ventana usan este puerto y las de otras ventanas usan los suyos.
const vscode = require('vscode');
const crypto = require('crypto');

const MANAGER = process.env.CLAUDE_SWITCH_MANAGER_URL || 'http://127.0.0.1:8790';
let item;
let timer;
let myPort = null;
let owner = null;

function folderKey() {
  const f = vscode.workspace.workspaceFolders?.[0];
  return f ? f.uri.fsPath : 'no-folder';
}

// owner estable por ventana: sobrevive recargas de la ventana (mismo puerto)
function getOwner(context) {
  const key = 'cs-owner:' + folderKey();
  let suffix = context.globalState.get(key);
  if (!suffix) {
    suffix = crypto.randomBytes(3).toString('hex');
    context.globalState.update(key, suffix);
  }
  const name = (vscode.workspace.workspaceFolders?.[0]?.name || 'vscode').replace(/[^\w.-]/g, '_');
  return `vscode-window:${name}:${suffix}`;
}

async function fetchJson(url, opts = {}, timeoutMs = 2500) {
  const r = await fetch(url, { ...opts, signal: AbortSignal.timeout(timeoutMs) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

async function acquirePort(context) {
  owner = getOwner(context);
  for (let i = 0; i < 10; i++) {
    try {
      const d = await fetchJson(`${MANAGER}/__ports/acquire`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ owner }),
      }, 3000);
      myPort = d.port;
      // inyectar ANTHROPIC_BASE_URL a nivel de ventana (solo afecta a esta ventana)
      await vscode.workspace.getConfiguration('claudeCode').update(
        'environmentVariables',
        [{ name: 'ANTHROPIC_BASE_URL', value: `http://127.0.0.1:${myPort}` }],
        vscode.ConfigurationTarget.Window
      );
      return true;
    } catch {
      await new Promise(r => setTimeout(r, 1500));
    }
  }
  return false;
}

async function getStatus() {
  if (!myPort) return null;
  try {
    return await fetchJson(`http://127.0.0.1:${myPort}/__switch/status`, {}, 2000);
  } catch {
    return null;
  }
}

function render(status) {
  if (!status) {
    item.text = '⚪ claude-switch: sin proxy';
    item.tooltip = `claude-switch no responde (ventana ${myPort ? ':' + myPort : ''})\nArranca: ~/claude-switch/switch.sh start`;
    return;
  }
  const isQwen = status.mode === 'qwen';
  item.text = isQwen ? '🔵 Qwen local' : '🟠 Claude · suscripción';
  item.tooltip =
    (isQwen ? 'Modelo activo: Qwen local\n' : 'Modelo activo: Claude (suscripción)\n') +
    `Ventana ${myPort} (solo afecta a esta ventana)\n` +
    'Clic para cambiar · ⌘⌥M también cambia';
}

async function setMode(mode) {
  try {
    await fetchJson(`http://127.0.0.1:${myPort}/__switch/mode`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode }),
    });
    vscode.window.showInformationMessage(`claude-switch (ventana ${myPort}) → ${mode === 'qwen' ? '🔵 Qwen local' : '🟠 Claude (suscripción)'}`);
    render(await getStatus());
  } catch {
    vscode.window.showErrorMessage('claude-switch no responde. Arranca: ~/claude-switch/switch.sh start');
  }
}

async function toggle() {
  try {
    await fetchJson(`http://127.0.0.1:${myPort}/__switch/toggle`, { method: 'POST' });
    const s = await getStatus();
    vscode.window.showInformationMessage(`claude-switch (ventana ${myPort}) → ${s?.mode === 'qwen' ? '🔵 Qwen local' : '🟠 Claude (suscripción)'}`);
    render(s);
  } catch {
    vscode.window.showErrorMessage('claude-switch no responde. Arranca: ~/claude-switch/switch.sh start');
  }
}

function activate(context) {
  item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  item.command = 'claudeSwitch.toggle';
  item.show();
  context.subscriptions.push(item);

  context.subscriptions.push(
    vscode.commands.registerCommand('claudeSwitch.toggle', toggle),
    vscode.commands.registerCommand('claudeSwitch.useClaude', () => setMode('claude')),
    vscode.commands.registerCommand('claudeSwitch.useQwen', () => setMode('qwen'))
  );

  (async () => {
    const ok = await acquirePort(context);
    if (!ok) {
      item.text = '⚪ claude-switch: manager caído';
      item.tooltip = `El manager no responde en ${MANAGER}\nArranca: ~/claude-switch/switch.sh start`;
      return;
    }
    const poll = async () => render(await getStatus());
    poll();
    timer = setInterval(poll, 5000);
    context.subscriptions.push({ dispose: () => clearInterval(timer) });
  })();

  context.subscriptions.push({
    dispose: async () => {
      if (owner) {
        try {
          await fetchJson(`${MANAGER}/__ports/release`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ owner }),
          }, 1500);
        } catch {}
      }
    },
  });
}

function deactivate() {}

module.exports = { activate, deactivate };
