#!/bin/bash
# claude-switch: start | stop | status | toggle | claude | qwen
DIR="$(cd "$(dirname "$0")" && pwd)"
PORT=$(python3 -c "import json;print(json.load(open('$DIR/config.json')).get('port',8790))" 2>/dev/null || echo 8790)
BASE="http://127.0.0.1:$PORT"
SVC="com.drozast.claude-switch"
UID_NUM=$(id -u)
PLIST="$HOME/Library/LaunchAgents/$SVC.plist"

is_running() { curl -s --max-time 2 "$BASE/__switch/status" >/dev/null 2>&1; }
is_loaded() { launchctl print "gui/$UID_NUM/$SVC" >/dev/null 2>&1; }

case "${1:-status}" in
  start)
    if is_running; then echo "ya está corriendo (modo: $(curl -s $BASE/__switch/status | python3 -c 'import json,sys;print(json.load(sys.stdin)["mode"])' 2>/dev/null))"; exit 0; fi
    if [ -f "$PLIST" ]; then
      if is_loaded; then launchctl kickstart -k "gui/$UID_NUM/$SVC"; else launchctl bootstrap "gui/$UID_NUM" "$PLIST"; fi
    else
      nohup node "$DIR/server.mjs" >> "$DIR/server.log" 2>&1 &
    fi
    sleep 0.8
    is_running && echo "arrancado en $BASE (UI: $BASE/)" || { echo "falló el arranque, mira $DIR/server.err.log"; exit 1; }
    ;;
  stop)
    if is_loaded; then
      launchctl bootout "gui/$UID_NUM/$SVC" && echo "detenido (volverá solo al iniciar sesión; o usa: claude-switch start)"
    else
      pkill -f "node $DIR/server.mjs" && echo "detenido" || echo "no estaba corriendo"
    fi
    ;;
  status)
    if is_running; then
      curl -s "$BASE/__switch/status" | python3 -c 'import json,sys;d=json.load(sys.stdin);print("modo:",d["mode"],"| LM Studio:", "ok" if d["lmstudio"] else "NO responde")'
    else
      echo "servidor detenido"
    fi
    ;;
  toggle)
    is_running || { "$0" start; }
    curl -s -X POST "$BASE/__switch/toggle" | python3 -c 'import json,sys;m=json.load(sys.stdin)["mode"];print("ahora: "+m)'
    ;;
  claude)
    is_running || { "$0" start; }
    curl -s -X POST -H 'content-type: application/json' -d '{"mode":"claude"}' "$BASE/__switch/mode" | python3 -c 'import json,sys;print("ahora: "+json.load(sys.stdin)["mode"])'
    ;;
  qwen)
    is_running || { "$0" start; }
    curl -s -X POST -H 'content-type: application/json' -d '{"mode":"qwen"}' "$BASE/__switch/mode" | python3 -c 'import json,sys;print("ahora: "+json.load(sys.stdin)["mode"])'
    ;;
  *)
    echo "uso: claude-switch start|stop|status|toggle|claude|qwen"
    ;;
esac
