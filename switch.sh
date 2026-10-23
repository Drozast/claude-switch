#!/bin/bash
# claude-switch: start | stop | status | toggle | claude | qwen [puerto]
# toggle/claude/qwen actúan sobre el proxy default (terminal) si no se pasa puerto.
DIR="$(cd "$(dirname "$0")" && pwd)"
PORT=$(python3 -c "import json;print(json.load(open('$DIR/config.json')).get('managerPort',8790))" 2>/dev/null || echo 8790)
BASE="http://127.0.0.1:$PORT"
SVC="com.drozast.claude-switch"
UID_NUM=$(id -u)
PLIST="$HOME/Library/LaunchAgents/$SVC.plist"

is_running() { curl -s --max-time 2 "$BASE/" >/dev/null 2>&1; }
is_loaded() { launchctl print "gui/$UID_NUM/$SVC" >/dev/null 2>&1; }

case "${1:-status}" in
  start)
    if is_running; then echo "ya está corriendo en $BASE"; exit 0; fi
    if [ -f "$PLIST" ]; then
      if is_loaded; then launchctl kickstart -k "gui/$UID_NUM/$SVC"; else launchctl bootstrap "gui/$UID_NUM" "$PLIST"; fi
    else
      nohup node "$DIR/manager.mjs" >> "$DIR/server.log" 2>&1 &
    fi
    sleep 1
    is_running && echo "arrancado en $BASE (UI: $BASE/)" || { echo "falló el arranque, mira $DIR/server.err.log"; exit 1; }
    ;;
  stop)
    if is_loaded; then
      launchctl bootout "gui/$UID_NUM/$SVC" && echo "detenido (volverá solo al iniciar sesión; o usa: claude-switch start)"
    else
      pkill -f "node $DIR/manager.mjs"; pkill -f "node $DIR/server.mjs" && echo "detenido" || echo "no estaba corriendo"
    fi
    ;;
  status)
    if is_running; then
      curl -s "$BASE/__ports/list" | python3 -c '
import json,sys
for w in json.load(sys.stdin):
    icon = {"claude":"🟠","qwen":"🔵"}.get(w.get("mode") or "", "⚪")
    print(f"{icon} {w[\"label\"]:<28} puerto {w[\"port\"]}  modo: {w.get(\"mode\") or \"?\"}  {\"ok\" if w[\"alive\"] else \"CAÍDO\"}")'
    else
      echo "servidor detenido"
    fi
    ;;
  toggle)
    is_running || { "$0" start; }
    P="${2:-$((PORT+1))}"
    curl -s -X POST "http://127.0.0.1:$P/__switch/toggle" | python3 -c 'import json,sys;m=json.load(sys.stdin)["mode"];print("puerto '"$P"' ahora: "+m)'
    ;;
  claude)
    is_running || { "$0" start; }
    P="${2:-$((PORT+1))}"
    curl -s -X POST -H 'content-type: application/json' -d '{"mode":"claude"}' "http://127.0.0.1:$P/__switch/mode" | python3 -c 'import json,sys;print("puerto '"$P"' ahora: "+json.load(sys.stdin)["mode"])'
    ;;
  qwen)
    is_running || { "$0" start; }
    P="${2:-$((PORT+1))}"
    curl -s -X POST -H 'content-type: application/json' -d '{"mode":"qwen"}' "http://127.0.0.1:$P/__switch/mode" | python3 -c 'import json,sys;print("puerto '"$P"' ahora: "+json.load(sys.stdin)["mode"])'
    ;;
  *)
    echo "uso: claude-switch start|stop|status|toggle|claude|qwen [puerto]"
    ;;
esac
