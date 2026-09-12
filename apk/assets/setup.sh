# setup.sh — runs inside the embedded prefix. Args: harness | proxy
PREFIX=/data/data/com.dshlocal.app/files/usr
export PATH=$PREFIX/bin:$PREFIX/bin/applets:$PATH
export HOME=/data/data/com.dshlocal.app/files/home
export TMPDIR=$PREFIX/tmp
export LD_PRELOAD=
cd $HOME

# apt needs its full env every run (Dir:: layout lives in $PREFIX/etc/apt/apt.conf)
apt_env() {
  export PATH=$PREFIX/bin:$PREFIX/bin/applets:$PATH
  export TMPDIR=$PREFIX/tmp
  export LD_PRELOAD=
  export LANG=C.UTF-8
}

install_node() {
  command -v node >/dev/null 2>&1 && return 0
  echo "[setup] installing Node.js (first run, ~1-2 min)"
  apt_env
  if ! apt update >$HOME/.apt-update.log 2>&1; then
    echo "[setup] apt update failed — see Terminal: tail $HOME/.apt-update.log"
    tail -3 $HOME/.apt-update.log
    return 1
  fi
  if ! apt install -y nodejs >$HOME/.apt-node.log 2>&1; then
    echo "[setup] apt install nodejs failed — see Terminal: tail $HOME/.apt-node.log"
    tail -3 $HOME/.apt-node.log
    return 1
  fi
  return 0
}

case "$1" in
  proxy)
    # The gateway needs node too — don't depend on the harness having run first.
    if ! command -v node >/dev/null 2>&1; then
      echo "[proxy] node missing — installing (first run, ~1-2 min)"
      install_node || { echo "[proxy] ERROR: node install failed — start the Harness first or check Terminal"; exit 1; }
    fi
    echo "[proxy] provisioning container in background (bash, git, python, jq, ripgrep)"
    sh $HOME/provision.sh >/dev/null 2>&1 &
    echo "[proxy] starting gateway :8787 + terminal :8788"
    exec node proxy.js
    ;;
  harness)
    install_node || { echo "[setup] ERROR: node install failed"; exit 1; }
    if ! command -v node >/dev/null 2>&1; then
      echo "[setup] ERROR: node install failed"
      exit 1
    fi
    node -v
    touch $HOME/.dsh-node-ok
    mkdir -p $HOME/dsh-data
    printf '{"type":"boot","title":"Harness booting","detail":"Node %%s ready, console starting","sev":"info","ts":%s}' \
      $(date +%%s)000 $(node -v) > $HOME/dsh-data/event-live.json 2>/dev/null
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
