# Arquitectura técnica

## Por qué un proxy (y no cambiar variables de entorno)

Claude Code lee `ANTHROPIC_BASE_URL` **una sola vez, al arrancar el proceso**. Cambiar la variable después no afecta a las sesiones ya abiertas — hay que matar y relanzar cada CLI, y con la extensión de VSCode eso significa recargar ventanas.

La solución es una capa de indirección permanente: `ANTHROPIC_BASE_URL` apunta siempre al proxy local, y el **proxy** decide por dónde manda cada petición según su estado interno. Como el cambio ocurre donde se toman las decisiones de ruteo (el proxy), todas las sesiones — abiertas o futuras — cambian con la siguiente petición.

```
Claude Code (N sesiones)
        │  HTTP, ANTHROPIC_BASE_URL=http://127.0.0.1:8790
        ▼
┌────────────────────────────────────────────┐
│ claude-switch (server.mjs)                 │
│                                            │
│  estado: mode = "claude" | "qwen"          │
│            (state.json, persiste)          │
│                                            │
│  mode == "claude":                         │
│    passthrough binario → api.anthropic.com │
│                                            │
│  mode == "qwen":                           │
│    /v1/messages: Anthropic ⇄ OpenAI        │
│    → LM Studio :1234/v1/chat/completions   │
└────────────────────────────────────────────┘
```

## Modo Claude: passthrough transparente

Para cada petición que no sea de control:

1. Se reenvía método, path y query a `https://api.anthropic.com`.
2. Se reenvían **todos los headers** del cliente, menos los hop-by-hop (`host`, `connection`, `content-length`, `accept-encoding`).
3. El body se reenvía sin tocar.

Consecuencias:

- **Auth**: con suscripción, Claude Code envía `Authorization: Bearer <oauth-token>` (token almacenado en el keychain del SO). El proxy lo reenvía tal cual y **nunca lo persiste**. Por eso no hay que configurar API keys: el token real viaja cliente→proxy→Anthropic.
- **Streaming**: los chunks SSE de `/v1/messages` se reescriben tal cual (solo se limpian `transfer-encoding`/`content-encoding` en la respuesta para evitar dobles codificaciones).
- **Endpoints menores** (`/v1/messages/count_tokens`, `/v1/models`, OAuth, etc.) también pasan por el passthrough: el modo claude no conoce rutas, solo reenvía.

## Modo Qwen: conversión Anthropic ⇄ OpenAI

Solo se intercepta `POST /v1/messages`; el resto de rutas devuelve un error 502 explicativo (Claude Code funciona sin problemas con eso).

### Request: Anthropic Messages → OpenAI chat/completions

| Anthropic | OpenAI |
|---|---|
| `system` (string o array de bloques) | mensaje `role: system` (se unen los bloques con `\n`) |
| `messages[].content` string | tal cual |
| bloque `text` (user/assistant) | parte de `content` (string si es la única, array de partes si hay imágenes) |
| bloque `image` (base64) | `{type: image_url, image_url: {url: data:...}}` |
| bloque `tool_use` (assistant) | `tool_calls[]` con `function.arguments` JSON-stringificado |
| bloque `tool_result` (user) | mensaje `role: tool` con `tool_call_id` |
| `tools[]` (`input_schema`) | `tools[]` (`parameters`) |
| `tool_choice: any` / `tool` | `tool_choice: required` / `{type: function, function: {name}}` |
| `max_tokens`, `temperature`, `top_p` | tal cual |
| `model` | mapeado por nombre: contiene `haiku` → `haikuModel`, resto → `qwenModel` |

### Response: OpenAI → Anthropic (no streaming)

- `message.content` → bloque `text`
- `message.tool_calls[]` → bloques `tool_use` (con `id`, `name`, `input` parseado de `arguments`)
- `finish_reason: tool_calls` → `stop_reason: tool_use`; resto → `end_turn`
- `usage` → `usage.input_tokens` / `output_tokens`

### Streaming: SSE OpenAI → eventos Anthropic

Claude Code exige la secuencia exacta de eventos del protocolo Anthropic. El proxy traduce chunk a chunk:

```
OpenAI (chunks)                          →  Anthropic (eventos)
─────────────────────────────────────────────────────────────────
primer chunk con content                 →  message_start + content_block_start(0, text)
chunk con delta.content                  →  content_block_delta(0, text_delta)
chunk con delta.tool_calls[i] (nuevo)    →  content_block_stop(0)* + content_block_start(i+1, tool_use)
chunk con tool_calls[i].arguments (parcial) → content_block_delta(i+1, input_json_delta)
[DONE] / fin del stream                  →  content_block_stop(resto) + message_delta(stop_reason) + message_stop
```

\* el bloque de texto se cierra antes de abrir el de tool, como exige el protocolo.

`finish_reason: tool_calls` en cualquier chunk fuerza `stop_reason: tool_use` en el `message_delta` final. Los tokens de `usage` (si el backend los envía) se propagan al `message_delta`.

### Límites conocidos de la conversión

- `cache_control` (prompt caching) no se traduce: LM Studio no lo soporta.
- El conteo de tokens es aproximado (viene del backend local).
- Si el backend local devuelve un error HTTP, el proxy lo reformatea como error Anthropic con el body original truncado a 500 chars.

## API de control

Base: `http://127.0.0.1:8790`

| Endpoint | Método | Descripción |
|---|---|---|
| `/__switch/status` | GET | `{"mode":"claude"\|"qwen","lmstudio":bool,"lmstudioBase":...,"qwenModel":...}` |
| `/__switch/toggle` | POST | Alterna el modo. Devuelve `{"mode":...}` |
| `/__switch/mode` | POST | Body `{"mode":"claude"\|"qwen"}`. Idempotente |
| `/` | GET | UI web (botones + salud de LM Studio) |

El health de LM Studio (`lmstudio`) es un `GET {lmstudioBase}/models` con timeout de 1.5 s, evaluado bajo demanda en `/__switch/status`.

## Estado y persistencia

- `state.json`: `{"mode": "claude"|"qwen"}` — se escribe en cada cambio. El modo sobrevive reinicios del proxy y del equipo.
- `config.json`: configuración estática (se lee una vez al arrancar; editar + reiniciar el proxy para aplicar).

## Modelo de seguridad

- El proxy escucha **solo en `127.0.0.1`** (no expuesto a la red).
- No guarda tokens: el OAuth de la suscripción pasa en memoria por cada petición.
- El modo qwen no envía nada fuera de la máquina (salvo que LM Studio lo haga).
- La UI web y la API de control no requieren auth (es localhost); si algún día la expones, agrega un token compartido a los endpoints `/__switch/*`.

## Extensión de VSCode

`vscode-ext/` es una extensión mínima (~100 líneas):

- Crea un item en la barra de estado (izquierda) con el modo actual.
- Pulea `/__switch/status` cada 5 s y actualiza el texto (`🟠 Claude · suscripción` / `🔵 Qwen local` / `⚪ sin proxy`).
- Clic en el item → `POST /__switch/toggle`. Comandos adicionales para forzar un modo concreto. Atajo por defecto: `⌘⌥M`.
- Si el proxy no responde, el item muestra `⚪ claude-switch: sin proxy` y los comandos avisan con un error.

## Troubleshooting

| Síntoma | Causa / solución |
|---|---|
| Claude Code: "connection refused" | El proxy no corre → `./switch.sh start`. Revisa `server.err.log`. |
| `EADDRINUSE` en el log | Dos instancias peleando por el puerto. Deja que launchd lo gestione: mata la manual (`pkill -f server.mjs`) y `./switch.sh start`. |
| 401 `OAuth access token is invalid` en modo claude | Token de la suscripción expirado → `claude /login`. El passthrough funciona (el error viene de Anthropic, no del proxy). |
| "You've hit your session limit" | Límite de tu plan Anthropic; se resetea a la hora indicada. No es un bug del proxy. |
| Modo qwen: "LM Studio no responde" | Arranca LM Studio con el modelo cargado y verifica que el puerto sea 1234. El indicador de la UI/barra de estado lo muestra en vivo. |
| Cambié `config.json` y no hace efecto | El config se lee al arrancar → `./switch.sh stop && ./switch.sh start`. |
| La barra de estado de VSCode no aparece | Recarga la ventana una vez (`Developer: Reload Window`) para activar la extensión recién instalada. |
| Quiero otro modelo local (p. ej. para haiku) | Cambia `haikuModel` en `config.json`, o pon un LiteLLM detrás y apunta `lmstudioBase` a él (el proxy habla OpenAI, así que cualquier backend OpenAI-compatible sirve). |
