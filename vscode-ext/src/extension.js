// Claude Model Switch: indicador en la barra de estado para alternar
// entre Claude (suscripción) y Qwen local vía el proxy claude-switch.
const vscode = require('vscode');

const BASE = process.env.CLAUDE_SWITCH_URL || 'http://127.0.0.1:8790';
let item;
let timer;

async function getStatus() {
  try {
    const r = await fetch(`${BASE}/__switch/status`, { signal: AbortSignal.timeout(2000) });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

function render(status) {
  if (!status) {
    item.text = '⚪ claude-switch: sin proxy';
    item.tooltip = 'claude-switch no responde en ' + BASE + '\nArrancalo: ~/claude-switch/switch.sh start';
    return;
  }
  const isQwen = status.mode === 'qwen';
  item.text = isQwen ? '🔵 Qwen local' : '🟠 Claude · suscripción';
  item.tooltip =
    (isQwen ? 'Modelo activo: Qwen local (LM Studio)\n' : 'Modelo activo: Claude (suscripción)\n') +
    'Clic para cambiar al otro\n⌘⌥M también cambia';
}

async function setMode(mode) {
  try {
    const r = await fetch(`${BASE}/__switch/mode`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode }),
      signal: AbortSignal.timeout(3000),
    });
    const d = await r.json();
    vscode.window.showInformationMessage(`claude-switch → ${d.mode === 'qwen' ? '🔵 Qwen local' : '🟠 Claude (suscripción)'}`);
    render(await getStatus());
  } catch {
    vscode.window.showErrorMessage('claude-switch no responde. Arranca: ~/claude-switch/switch.sh start');
  }
}

async function toggle() {
  try {
    const r = await fetch(`${BASE}/__switch/toggle`, { method: 'POST', signal: AbortSignal.timeout(3000) });
    const d = await r.json();
    vscode.window.showInformationMessage(`claude-switch → ${d.mode === 'qwen' ? '🔵 Qwen local' : '🟠 Claude (suscripción)'}`);
    render(await getStatus());
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

  const poll = async () => render(await getStatus());
  poll();
  timer = setInterval(poll, 5000);
  context.subscriptions.push({ dispose: () => clearInterval(timer) });
}

function deactivate() {}

module.exports = { activate, deactivate };
