# setup.sh — runs inside the embedded prefix. Args: harness | proxy
PREFIX=/data/data/com.dshlocal.app/files/usr
export PATH=$PREFIX/bin:$PATH
export HOME=/data/data/com.dshlocal.app/files/home
export TMPDIR=$PREFIX/tmp
export LD_PRELOAD=
cd $HOME

case "$1" in
  proxy)
    echo "[proxy] provisioning container in background (bash, git, python, jq, ripgrep)"
    sh $HOME/provision.sh >/dev/null 2>&1 &
    echo "[proxy] starting gateway :8787 + terminal :8788"
    exec node proxy.js
    ;;
  harness)
    if ! command -v node >/dev/null 2>&1; then
      echo "[setup] installing Node.js (first run, ~1-2 min)"
      apt update 2>&1 | tail -1
      apt install -y nodejs 2>&1 | tail -2
    fi
    if ! command -v node >/dev/null 2>&1; then
      echo "[setup] ERROR: node install failed"
      exit 1
    fi
    node -v
    touch $HOME/.dsh-node-ok
    echo "[setup] dsh console (plugins/skills/mcps/integrations) on 127.0.0.1:3080"
    if command -v npx >/dev/null 2>&1; then
      echo "[setup] attaching real dsh core on :3081 if available…"
      (npx -y @deepseek-ai/dsh web --no-open --port 3081 >/dev/null 2>&1 || true) &
    fi
    exec node dsh-web.js
    ;;
  *)
    echo "usage: setup.sh harness|proxy"
    exit 2
    ;;
esac
