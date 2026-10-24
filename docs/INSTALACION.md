# Instalación paso a paso

Al terminar vas a poder usar Claude Code con tu suscripción de Claude **o con cualquier otro modelo** (uno local en tu Mac, uno en otra máquina de tu red, o un proveedor con API key), y cambiar entre ellos con un clic sin cerrar la sesión.

> **Nota sobre nombres:** el modo alternativo se llama `qwen` en los comandos y en la API (`./switch.sh qwen`) por razones históricas, y las claves de `config.json` se llaman `qwenModel` y `lmstudioBase`. Son nombres, nada más: sirven para **cualquier** modelo y cualquier backend compatible con OpenAI.

## 1. Requisitos

| Qué | Para qué | Cómo comprobarlo |
|---|---|---|
| [Node.js](https://nodejs.org) ≥ 18 | corre el proxy | `node -v` |
| Claude Code con sesión iniciada | es el cliente que vas a redirigir | `claude --version` y haber hecho `claude /login` |
| Un backend para el modo alternativo | a dónde van las peticiones cuando no usas Claude | ver el paso 3 (puedes dejarlo para después) |
| VS Code (opcional) | para el botón de la barra de estado | `code --version` |

macOS es lo que está más probado (el autoarranque usa `launchd`). En Linux y Windows el proxy funciona igual con `node manager.mjs`; solo cambia cómo lo dejas arrancando solo (paso 4).

## 2. Descargar

```bash
git clone https://github.com/Drozast/claude-switch.git
cd claude-switch
```

No hay `npm install`: el proyecto no tiene dependencias.

## 3. Elegir tu backend y configurarlo

Copia la plantilla (`config.json` es tuyo y no se sube a git):

```bash
cp config.example.json config.json
```

Abre `config.json` y deja lo que corresponda a tu caso. Solo tocas lo de tu escenario; lo demás se queda como está.

### Escenario A: un modelo local en tu Mac con LM Studio

1. Instala [LM Studio](https://lmstudio.ai), descarga un modelo con soporte de herramientas (por ejemplo un Qwen3-Coder) y arranca su servidor local (pestaña *Developer* → *Start Server*, puerto 1234).
2. En `config.json`, pon el nombre exacto del modelo tal como sale en `http://127.0.0.1:1234/v1/models`:

```json
{
  "lmstudioBase": "http://127.0.0.1:1234/v1",
  "qwenModel": "nombre-del-modelo",
  "haikuModel": "nombre-del-modelo"
}
```

### Escenario B: un servidor propio en tu red (llama.cpp, vLLM…)

Apunta a la dirección del servidor (IP de tu LAN o de Tailscale). Si usas `llama-server`, el contexto se reparte entre los slots (`--ctx-size` ÷ `--parallel`), así que ajusta `maxPromptTokens` por debajo del contexto de una sesión:

```json
{
  "lmstudioBase": "http://192.168.1.50:8080/v1",
  "qwenModel": "nombre-del-modelo",
  "haikuModel": "nombre-del-modelo",
  "maxPromptTokens": 85000,
  "extraOpenAI": { "chat_template_kwargs": { "enable_thinking": false } }
}
```

`extraOpenAI` se mezcla en cada petición; el ejemplo apaga el razonamiento en modelos que lo traen, que suele ser lo más rápido para trabajar con herramientas.

### Escenario C: otro proveedor con API key (OpenRouter, DeepSeek, OpenAI…)

```json
{
  "lmstudioBase": "https://openrouter.ai/api/v1",
  "qwenModel": "id-del-modelo-en-ese-proveedor",
  "haikuModel": "id-del-modelo-en-ese-proveedor",
  "extraOpenAI": {}
}
```

La clave **no la pongas en el archivo**: exporta la variable antes de arrancar el proxy.

```bash
export CLAUDE_SWITCH_BACKEND_KEY=tu-clave
```

(Si lo dejas corriendo con autoarranque, la variable tiene que estar en el entorno del servicio; en macOS agrégala en el `plist` o usa `launchctl setenv CLAUDE_SWITCH_BACKEND_KEY tu-clave`.)

### Escenario D: usar una API key de Anthropic en vez de la suscripción

No hay nada que configurar en claude-switch: Claude Code manda su credencial (token de suscripción o `ANTHROPIC_API_KEY`) y el modo Claude la reenvía tal cual. Para el modo alternativo, usa cualquiera de los escenarios A a C.

## 4. Arrancar el proxy

### macOS (arranca solo al iniciar sesión)

```bash
./install-autostart.sh
```

Crea un LaunchAgent y lo arranca. Para operarlo después: `./switch.sh start | stop | status`.

### Linux

Prueba primero a mano:

```bash
node manager.mjs
```

Para que arranque solo, un servicio de usuario de systemd (ejemplo; ajusta las rutas):

```ini
# ~/.config/systemd/user/claude-switch.service
[Unit]
Description=claude-switch

[Service]
ExecStart=/usr/bin/node /ruta/a/claude-switch/manager.mjs
WorkingDirectory=/ruta/a/claude-switch
Restart=on-failure

[Install]
WantedBy=default.target
```

```bash
systemctl --user enable --now claude-switch
```

### Windows

Ejecuta `node manager.mjs` desde la carpeta del proyecto. Para que arranque al iniciar sesión, créalo como tarea programada (Task Scheduler) o con `nssm`.

### Comprobar que está vivo

```bash
./switch.sh status
```

Debe listar el proxy global (`puerto 8791`). También puedes abrir <http://127.0.0.1:8790>: es el panel con todas las ventanas y un botón por modo. Si no responde, mira `server.err.log` en la carpeta del proyecto.

## 5. Apuntar Claude Code al proxy

Para el CLI de terminal, agrega esto a `~/.claude/settings.json` (si ya tienes un bloque `env`, solo suma la clave):

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:8790"
  }
}
```

> No agregues `ANTHROPIC_AUTH_TOKEN` ni `ANTHROPIC_API_KEY`: Claude Code manda su propia credencial y el proxy la reenvía sin guardarla.

Abre una sesión nueva de `claude` en la terminal. Ya pasa por el proxy, en modo Claude: funciona igual que antes.

## 6. La extensión de VS Code (el botón)

```bash
cd vscode-ext
npx @vscode/vsce package --allow-missing-repository
code --install-extension claude-model-switch-*.vsix
```

Luego:

1. Recarga la ventana de VS Code (*Developer: Reload Window*).
2. Abre una sesión **nueva** de Claude Code (las que ya estaban abiertas siguen con su configuración anterior).
3. Abajo a la izquierda aparece `🟠 Claude · suscripción`. Un clic cambia al otro modelo (`🔵 <nombre de tu modelo>`) y otro clic vuelve. Atajo: `⌘⌥M`.
4. El icono de ventana a su lado abre el panel con todas las ventanas dentro de VS Code, sin navegador.

Cada ventana tiene su propio proxy y su propio modo. La extensión guarda el puerto de la ventana en `.claude/settings.local.json` del proyecto; ese archivo es local y no hay que subirlo a git.

## 7. Probarlo

1. En una ventana, haz clic para pasar al otro modelo y escribe algo corto ("responde solo con la palabra: listo"). Debe responder tu modelo.
2. Vuelve a Claude con otro clic y repite: responde Claude.
3. Desde la terminal también puedes forzarlo: `./switch.sh qwen` y `./switch.sh claude`. Sin número de puerto actúan sobre el proxy de la terminal.

Si el otro modelo no responde, revisa en este orden: que el backend esté corriendo, que `lmstudioBase` termine en `/v1` y que `qwenModel` sea el nombre exacto que devuelve `/v1/models`. El panel (<http://127.0.0.1:8790>) y la barra de estado avisan si el backend no contesta.

## 8. Cuando se te acabe la cuota de Claude

Cambia de modo con un clic. La conversación sigue donde estaba: Claude Code guarda el historial y lo reenvía completo al otro modelo. Lo que cambia:

- La primera respuesta puede tardar, porque el otro modelo no tiene ese historial en caché y lo lee entero.
- Si el historial no cabe en la ventana de contexto de tu modelo, el proxy descarta los mensajes más viejos (`maxPromptTokens`). Si la sesión es muy larga, haz `/compact` antes de cambiar.
- El estilo de las respuestas cambia a mitad de conversación, porque es otro modelo.

## 9. Desinstalar

```bash
./switch.sh stop
rm ~/Library/LaunchAgents/com.drozast.claude-switch.plist   # macOS, si instalaste el autoarranque
```

Quita la clave `ANTHROPIC_BASE_URL` de `~/.claude/settings.json`, desinstala la extensión desde VS Code y borra la carpeta. Si alguna ventana tiene `.claude/settings.local.json` con esa clave, bórrala también.

## Si algo falla

La tabla de problemas más comunes está en [ARQUITECTURA.md](ARQUITECTURA.md#troubleshooting).
