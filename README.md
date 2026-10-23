# claude-switch

Cambia entre **Claude (suscripción)** y **Qwen local (LM Studio)** en Claude Code con un clic, sin cerrar sesiones ni ventanas de VSCode.

```
┌─────────────┐   ANTHROPIC_BASE_URL    ┌──────────────────────┐
│ Claude Code │ ──────────────────────► │  claude-switch :8790 │
│ (VSCode /   │                         │                      │
│  terminal)  │                         │  modo claude ───────┼──► api.anthropic.com (tu suscripción, token OAuth intacto)
└─────────────┘                         │  modo qwen   ───────┼──► LM Studio :1234 (qwen3-coder-30b)
                                        └──────────────────────┘
```

El truco: Claude Code apunta **siempre** al proxy local. El proxy decide por dónde manda cada petición, y ese cambio es en caliente — la próxima petición de cualquier sesión abierta usa el otro modelo. No hay que reiniciar nada.

## Características

- 🟠 **Modo Claude**: passthrough transparente a `api.anthropic.com`. Tu token OAuth de la suscripción (Pro/Max) pasa intacto; el proxy no lo guarda ni lo ve.
- 🔵 **Modo Qwen**: convierte la Anthropic Messages API a formato OpenAI y manda a LM Studio. Soporta streaming SSE, tool calls (`tool_use`/`tool_result`), system prompts, imágenes base64 y `tool_choice`.
- 🖱️ **Un clic**: extensión de VSCode con indicador en la barra de estado (`🟠 Claude · suscripción` / `🔵 Qwen local`), atajo `⌘⌥M`, página web con dos botones grandes, o alias de terminal.
- 🔄 **Cambio en caliente**: sin cerrar sesiones, terminales ni ventanas. El modo persiste entre reinicios.
- 🩺 **Salud**: la UI y la barra de estado indican si LM Studio responde antes de que lo necesites.
- 📦 **Cero dependencias**: Node ≥ 18, un solo archivo de servidor.

## Requisitos

- [Node.js](https://nodejs.org) ≥ 18 (el servidor)
- Claude Code (CLI y/o extensión de VSCode) con **suscripción** activa
- Para el modo Qwen: [LM Studio](https://lmstudio.ai) corriendo con el modelo cargado (default: `qwen3-coder-30b` en `http://127.0.0.1:1234`)

## Instalación

### 1. Clonar

```bash
git clone https://github.com/Drozast/claude-switch.git
cd claude-switch
```

### 2. Configurar (si tu setup difiere del default)

Edita `config.json`:

```json
{
  "port": 8790,
  "anthropicTarget": "https://api.anthropic.com",
  "lmstudioBase": "http://127.0.0.1:1234/v1",
  "qwenModel": "qwen3-coder-30b",
  "haikuModel": "qwen3-coder-30b"
}
```

| Clave | Descripción |
|---|---|
| `port` | Puerto del proxy (default 8790) |
| `anthropicTarget` | Endpoint de Anthropic al que reenvía el modo claude |
| `lmstudioBase` | Base OpenAI-compatible de LM Studio (incluye `/v1`) |
| `qwenModel` | Modelo para peticiones sonnet/opus |
| `haikuModel` | Modelo para peticiones haiku (tareas en background) |

### 3. Apuntar Claude Code al proxy

Agrega esto a `~/.claude/settings.json` (aplica a CLI y extensión de VSCode):

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:8790"
  }
}
```

> ⚠️ No agregues `ANTHROPIC_AUTH_TOKEN` ni `ANTHROPIC_API_KEY`: con suscripción, Claude Code envía su token OAuth y el proxy lo reenvía tal cual.

### 4. Arranque automático (macOS)

```bash
./install-autostart.sh
```

Crea un LaunchAgent (`com.drozast.claude-switch`) que arranca el proxy al iniciar sesión y lo reinicia si muere. En Linux usa `systemd --user`; en Windows, Task Scheduler o `nssm`.

### 5. Extensión de VSCode (opcional, para el clic)

```bash
cd vscode-ext
npx @vscode/vsce package --allow-missing-repository
code --install-extension claude-model-switch-*.vsix
```

Te da:
- Indicador en la barra de estado (abajo a la izquierda): clic para alternar
- Atajo `⌘⌥M` (toggle)
- Comandos en la paleta: *Claude Switch: Cambiar modelo / Usar Claude / Usar Qwen*

## Uso

| Método | Acción |
|---|---|
| **Barra de estado VSCode** | Clic en `🟠 Claude · suscripción` ↔ `🔵 Qwen local` |
| **Atajo** | `⌘⌥M` |
| **Web** | http://127.0.0.1:8790 — botones grandes + estado de LM Studio |
| **Terminal** | `./switch.sh toggle` · `./switch.sh qwen` · `./switch.sh claude` · `./switch.sh status` |

Para usar Qwen: arranca LM Studio con el modelo cargado, haz clic en 🔵 y listo. Para volver: clic en 🟠. Las conversaciones abiertas continúan exactamente donde estaban; solo la **próxima** petición cambia de modelo.

## Operación

```bash
./switch.sh start     # arrancar (usa launchd si está instalado)
./switch.sh stop      # detener
./switch.sh status    # modo actual + salud de LM Studio
./switch.sh toggle    # alternar
./switch.sh claude    # forzar modo claude
./switch.sh qwen      # forzar modo qwen
```

Archivos: `config.json` (configuración) · `state.json` (modo actual, generado) · `server.log` / `server.err.log` (logs).

## Documentación

- [docs/ARQUITECTURA.md](docs/ARQUITECTURA.md) — cómo funciona el proxy, la conversión Anthropic↔OpenAI, API de control, seguridad y troubleshooting.

## Notas

- **Límites de sesión**: en modo Claude sigues consumiendo tu suscripción (incluidos los límites de 5h/semana). El modo Qwen es local e ilimitado (según tu máquina).
- **El proxy debe estar corriendo**: si no, Claude Code no conecta. Con el autostart no debería pasar; si pasa, `./switch.sh start`.
- **Modelos**: el modo Qwen mapea *todos* los nombres de modelo de Claude a `qwenModel`/`haikuModel`. Si quieres varios modelos locales (p. ej. uno para haiku), usa LiteLLM detrás y apunta `lmstudioBase` a él.

## Licencia

[MIT](LICENSE) — © Dani Rozas Torres
