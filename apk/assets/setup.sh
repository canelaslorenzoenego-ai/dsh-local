#!/data/data/com.dshlocal.app/files/usr/bin/sh
# setup.sh — runs inside the embedded prefix. Args: harness | proxy
PREFIX=/data/data/com.dshlocal.app/files/usr
export PATH=$PREFIX/bin:$PREFIX/bin/applets:$PATH
export HOME=/data/data/com.dshlocal.app/files/home
export TMPDIR=$PREFIX/tmp
export LD_PRELOAD=
cd $HOME

# Ensure HTTPS method is available for apt
ensure_https() {
  # Create https method script if it doesn't exist
  if [ ! -f "$PREFIX/lib/apt/methods/https" ]; then
    mkdir -p "$PREFIX/lib/apt/methods"
    cat > "$PREFIX/lib/apt/methods/https" <<'EOFHTTPS'
#!/bin/sh
# Simple HTTPS method for apt using curl
exec curl -sS -L --fail --ftp-pasv -o "$@"
EOFHTTPS
    chmod +x "$PREFIX/lib/apt/methods/https"
    echo "[setup] created https method for apt"
  fi
  
  # Ensure curl is executable
  if [ -f "$PREFIX/bin/curl" ]; then
    chmod +x "$PREFIX/bin/curl" 2>/dev/null || true
  fi
}

# Fix apt configuration completely
fix_apt() {
  echo "[setup] fixing apt configuration..."
  
  # Create directories
  mkdir -p "$PREFIX/etc/apt"
  mkdir -p "$PREFIX/etc/apt/trusted.gpg.d"
  mkdir -p "$PREFIX/lib/apt/methods"
  mkdir -p "$PREFIX/var/lib/apt/lists"
  mkdir -p "$PREFIX/var/cache/apt/archives"
  
  # Install signing keys from Termux keyring
  if [ -d "$PREFIX/share/termux-keyring" ] && [ -n "$(ls "$PREFIX/share/termux-keyring"/*.gpg 2>/dev/null)" ]; then
    cp "$PREFIX/share/termux-keyring"/*.gpg "$PREFIX/etc/apt/trusted.gpg.d/" 2>/dev/null
    echo "[setup] installed Termux signing keys"
  fi
  
  # Create apt.conf
  cat > "$PREFIX/etc/apt/apt.conf" <<EOF
APT {
  Get {
    AllowUnauthenticated "true";
  };
};
Dir::Bin::Methods "$PREFIX/lib/apt/methods/";
Dir::Etc::SourceList "$PREFIX/etc/apt/sources.list";
Dir::Etc::SourceParts "$PREFIX/etc/apt/sources.list.d";
Dir::State "$PREFIX/var/lib/apt";
Dir::Cache "$PREFIX/var/cache/apt";
Dir::State::Lists "$PREFIX/var/lib/apt/lists";
Dir::State::status "$PREFIX/var/lib/dpkg/status";
Dir::Cache::archives "$PREFIX/var/cache/apt/archives";
Dir::Log "$PREFIX/var/log/apt";
Dir::Log::Terminal "$PREFIX/var/log/apt/term.log";
Dir::Log::History "$PREFIX/var/log/apt/history.log";
EOF
  
  # Create proper sources.list with both https and http options
  cat > "$PREFIX/etc/apt/sources.list" <<EOF
deb https://packages.termux.dev/apt/termux-main stable main
EOF
  
  # Create https method
  ensure_https
  
  echo "[setup] apt configuration complete"
}

# Install Node.js via direct download
install_node_direct() {
  apt_env
  
  # First ensure HTTPS works
  ensure_https
  
  # Test HTTPS connectivity
  if ! curl -s --max-time 10 https://google.com >/dev/null 2>&1; then
    echo "[setup] HTTPS not working, trying http mirror..."
    # Use http mirror as fallback
    REPO="http://packages-cf.termux.dev/apt/termux-main"
  else
    REPO="https://packages.termux.dev/apt/termux-main"
    echo "[setup] HTTPS is working"
  fi
  
  local TMP=$HOME/.node-dl
  mkdir -p "$TMP"
  
  echo "[setup] fetching Termux package index from $REPO..."
  
  # Try to get the package list
  FNAME=$(curl -fsSL --retry 3 --max-time 120 "$REPO/dists/stable/main/binary-aarch64/Packages" 2>>$HOME/.curl-node.log \
    | awk '/^Package: nodejs$/{f=1} f&&/^Filename: /{print $2; exit}') 2>>$HOME/.curl-node.log
  
  if [ -z "$FNAME" ]; then
    echo "[setup] Packages file not found, trying with .gz..."
    FNAME=$(curl -fsSL --retry 3 --max-time 120 "$REPO/dists/stable/main/binary-aarch64/Packages.gz" 2>>$HOME/.curl-node.log \
      | gzip -d 2>/dev/null \
      | awk '/^Package: nodejs$/{f=1} f&&/^Filename: /{print $2; exit}') 2>>$HOME/.curl-node.log
  fi
  
  if [ -z "$FNAME" ]; then
    echo "[setup] could not find nodejs package"
    echo "[setup] Trying alternative mirror..."
    # Try alternative mirror
    REPO="https://mirror.freedif.org/termux/termux-main"
    FNAME=$(curl -fsSL --retry 3 --max-time 120 "$REPO/dists/stable/main/binary-aarch64/Packages" 2>>$HOME/.curl-node.log \
      | awk '/^Package: nodejs$/{f=1} f&&/^Filename: /{print $2; exit}') 2>>$HOME/.curl-node.log
  fi
  
  if [ -z "$FNAME" ]; then
    echo "[setup] ALL mirrors failed"
    echo "[setup] Last curl output:"
    tail -20 $HOME/.curl-node.log
    return 1
  fi
  
  echo "[setup] Found nodejs: $FNAME"
  echo "[setup] Downloading from $REPO..."
  
  if ! curl -fSL --retry 3 --max-time 600 -o "$TMP/node.deb" "$REPO/$FNAME" >>$HOME/.curl-node.log 2>&1; then
    echo "[setup] Download failed"
    tail -10 $HOME/.curl-node.log
    return 1
  fi
  
  echo "[setup] Downloaded $(ls -lh $TMP/node.deb | awk '{print $5}')"
  echo "[setup] Unpacking..."
  
  # Unpack the deb
  if [ -x "$PREFIX/bin/dpkg-deb" ]; then
    "$PREFIX/bin/dpkg-deb" --fsys-tarfile "$TMP/node.deb" \
      | "$PREFIX/bin/tar" -xJ --strip-components=6 -C "$PREFIX" 2>>$HOME/.curl-node.log || {
      echo "[setup] dpkg-deb unpack failed, trying direct tar..."
      "$PREFIX/bin/tar" -xJf "$TMP/node.deb" --strip-components=6 -C "$PREFIX" 2>>$HOME/.curl-node.log || {
        echo "[setup] tar unpack failed"
        tail -10 $HOME/.curl-node.log
        return 1
      }
    }
  else
    echo "[setup] dpkg-deb not found, using tar directly"
    "$PREFIX/bin/tar" -xJf "$TMP/node.deb" --strip-components=6 -C "$PREFIX" 2>>$HOME/.curl-node.log || {
      echo "[setup] tar unpack failed"
      tail -10 $HOME/.curl-node.log
      return 1
    }
  fi
  
  rm -rf "$TMP"
  
  # Verify node works
  if ! command -v node >/dev/null 2>&1; then
    echo "[setup] node binary not found after unpack"
    return 1
  fi
  
  # Test node runs
  if ! node -e "console.log('ok')" >/dev/null 2>&1; then
    echo "[setup] node binary exists but won't run"
    echo "[setup] checking library dependencies..."
    ldd "$(which node)" 2>&1 || true
    return 1
  fi
  
  echo "[setup] node $(node -v) installed successfully"
  return 0
}

install_node() {
  if command -v node >/dev/null 2>&1; then
    echo "[setup] node already installed: $(node -v)"
    return 0
  fi
  
  echo "[setup] Installing Node.js..."
  
  # First fix apt configuration
  fix_apt
  
  # Try apt install first (faster if apt works)
  echo "[setup] Trying apt install..."
  if apt update >$HOME/.apt-update.log 2>&1 && \
     apt install -y --allow-unauthenticated nodejs >$HOME/.apt-node.log 2>&1 && \
     command -v node >/dev/null 2>&1; then
    echo "[setup] node installed via apt: $(node -v)"
    return 0
  fi
  
  echo "[setup] apt failed, trying direct download..."
  tail -5 $HOME/.apt-node.log 2>/dev/null || true
  
  if install_node_direct; then
    return 0
  fi
  
  echo "[setup] ALL install methods failed"
  echo "[setup] apt log:"
  tail -10 $HOME/.apt-update.log 2>/dev/null || true
  echo "[setup] curl log:"
  tail -10 $HOME/.curl-node.log 2>/dev/null || true
  return 1
}

case "$1" in
  proxy)
    echo "[proxy] Starting Proxy Gateway..."
    
    # Ensure node is installed
    if ! command -v node >/dev/null 2>&1; then
      echo "[proxy] Node.js not found, installing..."
      install_node || {
        echo "[proxy] ERROR: Failed to install Node.js"
        echo "[proxy] Check the Terminal tab for details"
        exit 1
      }
    fi
    
    echo "[proxy] Node $(node -v) ready"
    echo "[proxy] Starting provisioning in background..."
    sh $HOME/provision.sh >/dev/null 2>&1 &
    
    echo "[proxy] Starting gateway :8787 + terminal :8788"
    exec node proxy.js
    ;;
    
  harness)
    echo "[harness] Starting DeepSeek Harness..."
    
    # Ensure node is installed
    if ! command -v node >/dev/null 2>&1; then
      echo "[harness] Node.js not found, installing..."
      install_node || {
        echo "[harness] ERROR: Failed to install Node.js"
        echo "[harness] Check the Terminal tab for details"
        exit 1
      }
    fi
    
    echo "[harness] Node $(node -v) ready"
    
    # Mark node as ready
    touch $HOME/.dsh-node-ok
    mkdir -p $HOME/dsh-data
    
    # Log boot event
    printf '{"type":"boot","title":"Harness booting","detail":"Node %s ready","sev":"info","ts":%s}' \
      "$(node -v)" "$(date +%s)000" > $HOME/dsh-data/event-live.json 2>/dev/null
    
    echo "[harness] Starting console on 127.0.0.1:3080"
    
    # Try to start real dsh core if available
    if command -v npx >/dev/null 2>&1; then
      echo "[harness] Starting dsh core on :3081..."
      (npx -y @deepseek-ai/dsh web --no-open --port 3081 >/dev/null 2>&1 || true) &
    fi
    
    exec node dsh-web.js
    ;;
    
  *)
    echo "Usage: setup.sh {harness|proxy}"
    exit 2
    ;;
esac
