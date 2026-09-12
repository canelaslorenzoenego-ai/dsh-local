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

# Repair apt for prefixes extracted by older app versions. Idempotent, cheap
# (skips instantly once fixed), and runs on EVERY start — unlike the bootstrap
# installer, which only ever runs once on first open.
repair_apt() {
  # 1) signing keys: bootstrap ships them in share/termux-keyring/ but older
  #    installs never copied them to etc/apt/trusted.gpg.d/ → "unauthenticated"
  #    lists and apt refusing to install anything.
  if [ -d "$PREFIX/share/termux-keyring" ] && [ -n "$(ls "$PREFIX/share/termux-keyring"/*.gpg 2>/dev/null)" ]; then
    if [ -z "$(ls "$PREFIX/etc/apt/trusted.gpg.d"/*.gpg 2>/dev/null)" ]; then
      mkdir -p "$PREFIX/etc/apt/trusted.gpg.d"
      cp "$PREFIX/share/termux-keyring"/*.gpg "$PREFIX/etc/apt/trusted.gpg.d/" 2>/dev/null &&
        echo "[setup] repaired: apt signing keys installed"
    fi
  fi
  # 2) https source with no https method in this bootstrap → apt dies before
  #    downloading anything. Force the http mirror (files still signature-checked).
  if [ -f "$PREFIX/etc/apt/sources.list" ] && grep -q '^deb https://' "$PREFIX/etc/apt/sources.list" 2>/dev/null; then
    sed -i 's|https://|http://|g' "$PREFIX/etc/apt/sources.list"
    echo "[setup] repaired: apt sources moved to http (no https method in bootstrap)"
  fi
  # 3) apt.conf written by very old installers lacks Dir/Methods mapping
  if [ -f "$PREFIX/etc/apt/apt.conf" ] && ! grep -q 'Dir::Bin::Methods' "$PREFIX/etc/apt/apt.conf" 2>/dev/null; then
    printf 'Dir::Bin::Methods "%s/lib/apt/methods/";\\n' "$PREFIX" >> "$PREFIX/etc/apt/apt.conf"
  fi
}

install_node() {
  command -v node >/dev/null 2>&1 && { echo "[setup] node already present"; return 0; }
  echo "[setup] step 1/3: repairing apt config…"
  apt_env
  repair_apt
  echo "[setup] step 2/3: apt update + install…"
  # coreutils' timeout may be missing on odd prefixes — run plain then
  if command -v timeout >/dev/null 2>&1; then T=timeout; else T=""; fi
  if ${T:+$T 600} apt update >$HOME/.apt-update.log 2>&1; then
    if ${T:+$T 900} apt install -y --allow-unauthenticated nodejs >$HOME/.apt-node.log 2>&1 && command -v node >/dev/null 2>&1; then
      echo "[setup] node installed via apt"
      return 0
    fi
    echo "[setup] apt install failed — last lines:"; tail -4 $HOME/.apt-node.log 2>/dev/null
  else
    echo "[setup] apt update failed — last lines:"; tail -4 $HOME/.apt-update.log 2>/dev/null
  fi
  # ---- fallback: direct download with curl (no apt involved) ----
  echo "[setup] step 3/3: apt unavailable — trying direct package download…"
  if install_node_direct; then return 0; fi
  echo "[setup] ALL install paths failed — dump of apt update log:"
  tail -6 $HOME/.apt-update.log 2>/dev/null
  echo "[setup] curl log:"; tail -6 $HOME/.curl-node.log 2>/dev/null
  return 1
}

install_node_direct() {
  apt_env
  # Pull the Termux nodejs deb over https with the bootstrap's curl + CA bundle,
  # and unpack it into the prefix with dpkg-deb/tar (both ship in bootstrap).
  local REPO="https://packages-cf.termux.dev/apt/termux-main"
  local TMP=$HOME/.node-dl
  mkdir -p "$TMP"
  echo "[setup] fetching Termux package index…"
  local FNAME
  # Try gzipped Packages first
  FNAME=$(curl -fsSL --retry 3 --max-time 180 "$REPO/dists/stable/main/binary-aarch64/Packages.gz" 2>>$HOME/.curl-node.log \
    | gzip -d 2>/dev/null \
    | awk '/^Package: nodejs$/{f=1} f&&/^Filename: /{print $2; exit}') 2>>$HOME/.curl-node.log
  if [ -z "$FNAME" ]; then
    # Try uncompressed Packages as fallback
    FNAME=$(curl -fsSL --retry 3 --max-time 180 "$REPO/dists/stable/main/binary-aarch64/Packages" 2>>$HOME/.curl-node.log \
      | awk '/^Package: nodejs$/{f=1} f&&/^Filename: /{print $2; exit}') 2>>$HOME/.curl-node.log
  fi
  if [ -z "$FNAME" ]; then
    echo "[setup] could not resolve nodejs package — last lines:"; tail -5 $HOME/.curl-node.log
    echo "[setup] URL tried: $REPO/dists/stable/main/binary-aarch64/Packages"
    return 1
  fi
  echo "[setup] downloading nodejs ($FNAME)…"
  if ! curl -fSL --retry 3 --max-time 600 -o "$TMP/node.deb" "$REPO/$FNAME" >>$HOME/.curl-node.log 2>&1; then
    echo "[setup] download failed — last lines:"; tail -5 $HOME/.curl-node.log
    return 1
  fi
  echo "[setup] unpacking into prefix…"
  # Termux debs carry absolute com.termux paths (./data/data/com.termux/files/usr/…).
  # dpkg-deb streams the data tarball; strip the leading components.
  if [ ! -x "$PREFIX/bin/dpkg-deb" ]; then
    echo "[setup] dpkg-deb not found — trying tar directly"
    "$PREFIX/bin/tar" -xJf "$TMP/node.deb" --strip-components=6 -C "$PREFIX" 2>>$HOME/.curl-node.log || {
      echo "[setup] unpack failed — last lines:"; tail -5 $HOME/.curl-node.log
      return 1;
    }
  else
    "$PREFIX/bin/dpkg-deb" --fsys-tarfile "$TMP/node.deb" \
      | "$PREFIX/bin/tar" -xJ --strip-components=6 -C "$PREFIX" 2>>$HOME/.curl-node.log || {
      echo "[setup] unpack failed — last lines:"; tail -5 $HOME/.curl-node.log
      return 1;
    }
  fi
  rm -rf "$TMP"
  command -v node >/dev/null 2>&1 || { echo "[setup] node binary did not run after unpack"; return 1; }
  echo "[setup] node $(node -v) installed via direct package download"
  return 0
}

case "$1" in
  proxy)
    # The gateway needs node too — don't depend on the harness having run first.
    if ! command -v node >/dev/null 2>&1; then
      echo "[proxy] node missing — installing (first run, ~1-2 min)"
      install_node || { echo "[proxy] ERROR: node install failed — check Terminal tab for details"; exit 1; }
    fi
    echo "[proxy] provisioning container in background (bash, git, python, jq, ripgrep)"
    sh $HOME/provision.sh >/dev/null 2>&1 &
    echo "[proxy] starting gateway :8787 + terminal :8788"
    exec node proxy.js
    ;;
  harness)
    install_node || { echo "[setup] ERROR: node install failed — check Terminal tab for details"; exit 1; }
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
