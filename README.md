# claude-switch

Cambia entre **Claude (suscripción)** y **Qwen local (LM Studio)** en Claude Code con un clic, sin cerrar sesiones ni ventanas de VSCode.

```
┌──────────────┐  ANTHROPIC_BASE_URL   ┌─────────────────────────────────┐
│ Ventana VSCode A │ ───────────────► │ manager :8790                   │
│ (extensión inyecta su puerto)        │   ├ proxy :8791  (terminal/global)
├──────────────┤                     │   ├ proxy :8792  (ventana A) ◄──┤ cada uno con su modo
│ Ventana VSCode B │ ───────────────► │   └ proxy :8793  (ventana B)    │
└──────────────┘                     └─────────────────────────────────┘
        cada proxy:  modo claude ──► api.anthropic.com (suscripción, token OAuth intacto)
                      modo qwen   ──► backend OpenAI local (LM Studio, llama.cpp, vLLM…)
```

El truco: Claude Code apunta **siempre** a un proxy local. El proxy decide por dónde manda cada petición, y ese cambio es en caliente — la próxima petición de la sesión abierta usa el otro modelo. No hay que reiniciar nada.

### Modo por-ventana

Cada **ventana** de VSCode tiene su **propio proxy y su propio modo**: la extensión le inyecta a esa ventana `ANTHROPIC_BASE_URL` apuntando a su puerto (vía `claudeCode.environmentVariables` a nivel de ventana). Así puedes tener una ventana en Claude y otra en Qwen al mismo tiempo, y el clic en la barra de estado solo afecta a la ventana donde lo haces.

- El CLI fuera de VSCode (terminal) usa el proxy **default** (`Terminal / global` en la UI).
- La página web del manager (puerto 8790) lista todas las ventanas activas con su modo y botones para cambiarlo.
- Los puertos se asignan de forma estable por ventana (sobreviven recargas); al cerrar la ventana se liberan.
- Dos ventanas del *mismo* proyecto comparten puerto (mismo modo). Ventanas de proyectos distintos son independientes.

## Características

- 🟠 **Modo Claude**: passthrough transparente a `api.anthropic.com`. Tu token OAuth de la suscripción (Pro/Max) pasa intacto; el proxy no lo guarda ni lo ve.
- 🔵 **Modo Qwen**: convierte la Anthropic Messages API a formato OpenAI y manda a tu backend local (LM Studio, llama.cpp en la red, vLLM…). Soporta streaming SSE, tool calls (`tool_use`/`tool_result`), system prompts, imágenes base64 y `tool_choice`.
- 🖱️ **Un clic**: extensión de VSCode con indicador en la barra de estado (`🟠 Claude · suscripción` / `🔵 Qwen local`), atajo `⌘⌥M`, página web con dos botones grandes, o alias de terminal.
- 🔄 **Cambio en caliente**: sin cerrar sesiones, terminales ni ventanas. El modo persiste entre reinicios.
- 🩺 **Salud**: la UI y la barra de estado indican si LM Studio responde antes de que lo necesites.
- 📦 **Cero dependencias**: Node ≥ 18, un solo archivo de servidor.

## Requisitos

- [Node.js](https://nodejs.org) ≥ 18 (el servidor)
- Claude Code (CLI y/o extensión de VSCode) con **suscripción** activa
- Para el modo Qwen: **cualquier backend OpenAI-compatible** corriendo con el modelo cargado — [LM Studio](https://lmstudio.ai) local, `llama-server` (llama.cpp) en otra máquina de tu LAN/Tailscale, vLLM, etc. El default apunta a LM Studio en `http://127.0.0.1:1234`

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
| `lmstudioBase` | Base OpenAI-compatible del backend local (incluye `/v1`). Sirve para **cualquier** backend: LM Studio, llama.cpp/llama-server en tu LAN o Tailscale, vLLM, etc. |
| `qwenModel` | Modelo para peticiones sonnet/opus (el id que aparece en `GET /v1/models`) |
| `haikuModel` | Modelo para peticiones haiku (tareas en background) |
| `extraOpenAI` | Objeto que se mezcla en cada request OpenAI. Ej.: `{"chat_template_kwargs":{"enable_thinking":false}}` para modelos thinking de llama.cpp, o un `temperature` fijo |

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
| **Barra de estado VSCode** | Clic en `🟠 Claude · suscripción` ↔ `🔵 Qwen local` — **solo afecta a esa ventana** |
| **Atajo** | `⌘⌥M` (en la ventana activa) |
| **Web** | http://127.0.0.1:8790 — todas las ventanas + proxy de terminal, con botones por fila |
| **Terminal** | `./switch.sh status` (lista todo) · `./switch.sh qwen [puerto]` · `./switch.sh claude [puerto]` · `./switch.sh toggle [puerto]` — sin puerto, actúa sobre el proxy de terminal |

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

Archivos: `config.json` (configuración) · `states/` (modo por proxy, generado) · `manager-state.json` (asignación de puertos, generado) · `server.log` / `server.err.log` / `proxy-<puerto>.*.log` (logs).

## Documentación

- [docs/ARQUITECTURA.md](docs/ARQUITECTURA.md) — cómo funciona el proxy, la conversión Anthropic↔OpenAI, API de control, seguridad y troubleshooting.

## Notas

- **Límites de sesión**: en modo Claude sigues consumiendo tu suscripción (incluidos los límites de 5h/semana). El modo Qwen es local e ilimitado (según tu máquina).
- **El proxy debe estar corriendo**: si no, Claude Code no conecta. Con el autostart no debería pasar; si pasa, `./switch.sh start`.
- **Backend local**: el modo Qwen mapea *todos* los nombres de modelo de Claude a `qwenModel`/`haikuModel`. El backend puede ser LM Studio, llama.cpp (`llama-server`) en otra máquina de tu red (LAN/Tailscale), vLLM… cualquier API OpenAI-compatible que soporte streaming y function calling.
- **Modelos thinking** (llama.cpp): agrega `"extraOpenAI": {"chat_template_kwargs": {"enable_thinking": false}}` o las respuestas consumen los tokens en reasoning y llegan vacías.

## Licencia

[MIT](LICENSE) — © Dani Rozas Torres
