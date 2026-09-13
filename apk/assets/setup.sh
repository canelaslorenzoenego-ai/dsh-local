#!/data/data/com.dshlocal.app/files/usr/bin/sh
# setup.sh — runs inside the embedded prefix. Args: harness | proxy
PREFIX=/data/data/com.dshlocal.app/files/usr
export PATH=$PREFIX/bin:$PREFIX/bin/applets:$PATH
export HOME=/data/data/com.dshlocal.app/files/home
export TMPDIR=$PREFIX/tmp
export LD_PRELOAD=
cd $HOME

################################################################################
# Fix Termux apt configuration - this MUST be done first
################################################################################
fix_apt_config() {
  echo "[setup] Step 1: Fixing apt configuration..."
  
  # Create required directories
  mkdir -p "$PREFIX/etc/apt"
  mkdir -p "$PREFIX/etc/apt/trusted.gpg.d"
  mkdir -p "$PREFIX/lib/apt/methods"
  mkdir -p "$PREFIX/var/lib/apt/lists"
  mkdir -p "$PREFIX/var/cache/apt/archives"
  mkdir -p "$PREFIX/var/log/apt"
  
  # 1. Install signing keys from Termux keyring
  if [ -d "$PREFIX/share/termux-keyring" ] && [ -n "$(ls "$PREFIX/share/termux-keyring"/*.gpg 2>/dev/null)" ]; then
    cp "$PREFIX/share/termux-keyring"/*.gpg "$PREFIX/etc/apt/trusted.gpg.d/" 2>/dev/null
    echo "[setup] Installed Termux signing keys from keyring"
  else
    echo "[setup] No keyring found at $PREFIX/share/termux-keyring"
    # Try alternative key locations
    if [ -f "$PREFIX/etc/apt/trusted.gpg.d/termux.gpg" ]; then
      echo "[setup] Found existing termux.gpg"
    fi
  fi
  
  # 2. Create apt.conf with ALL required settings
  cat > "$PREFIX/etc/apt/apt.conf" <<'EOF'
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
Dir::Bin::DPkg "$PREFIX/bin/dpkg";
Dir::Bin::Bzip2 "$PREFIX/bin/bzip2";
Dir::Bin::Gzip "$PREFIX/bin/gzip";
Dir::Bin::xz "$PREFIX/bin/xz";
Dir::Bin::lz4 "$PREFIX/bin/lz4";
Dir::Bin::zstd "$PREFIX/bin/zstd";
EOF
  echo "[setup] Created apt.conf"
  
  # 3. Create HTTPS method for apt (uses curl)
  if [ ! -f "$PREFIX/lib/apt/methods/https" ]; then
    cat > "$PREFIX/lib/apt/methods/https" <<'EOFHTTPS'
#!/bin/sh
# HTTPS method for apt using curl
# Usage: https [options] url
exec curl -sS -L --fail --ftp-pasv -o /dev/null "$@"
EOFHTTPS
    chmod +x "$PREFIX/lib/apt/methods/https" 2>/dev/null || true
    echo "[setup] Created https method for apt"
  fi
  
  # 4. Create http method if needed
  if [ ! -f "$PREFIX/lib/apt/methods/http" ]; then
    cat > "$PREFIX/lib/apt/methods/http" <<'EOFHTTP'
#!/bin/sh
# HTTP method for apt using curl
exec curl -sS -L --fail --ftp-pasv -o /dev/null "$@"
EOFHTTP
    chmod +x "$PREFIX/lib/apt/methods/http" 2>/dev/null || true
    echo "[setup] Created http method for apt"
  fi
  
  # 5. Configure sources.list - use HTTP if HTTPS method unavailable
  if [ -x "$PREFIX/lib/apt/methods/https" ] && [ -f "$PREFIX/bin/curl" ]; then
    # Test if HTTPS actually works
    if curl -s --max-time 5 https://packages.termux.dev >/dev/null 2>&1; then
      echo "deb https://packages.termux.dev/apt/termux-main stable main" > "$PREFIX/etc/apt/sources.list"
      echo "[setup] Using HTTPS sources (tested OK)"
    else
      echo "deb http://packages.termux.dev/apt/termux-main stable main" > "$PREFIX/etc/apt/sources.list"
      echo "[setup] HTTPS test failed, using HTTP sources"
    fi
  else
    echo "deb http://packages.termux.dev/apt/termux-main stable main" > "$PREFIX/etc/apt/sources.list"
    echo "[setup] HTTPS not available, using HTTP sources"
  fi
  
  # Also add root repo
  echo "deb http://packages.termux.dev/apt/termux-root root stable" >> "$PREFIX/etc/apt/sources.list"
  
  echo "[setup] Configured sources.list"
}

################################################################################
# Install Node.js
################################################################################
install_node() {
  # Check if already installed
  if command -v node >/dev/null 2>&1; then
    echo "[setup] Node.js already installed: $(node -v)"
    return 0
  fi
  
  echo "[setup] Installing Node.js..."
  
  # Step 1: Fix apt config
  fix_apt_config
  
  # Step 2: Try apt install first (fastest if it works)
  echo "[setup] Step 2: Trying apt install..."
  apt update 2>&1 | tail -3 || echo "[setup] apt update failed"
  
  if apt install -y --allow-unauthenticated nodejs 2>&1 | tail -5; then
    if command -v node >/dev/null 2>&1; then
      echo "[setup] Node.js installed via apt: $(node -v)"
      return 0
    fi
  fi
  
  echo "[setup] apt install failed, trying direct download..."
  
  # Step 3: Direct download via curl
  TMP=$HOME/.node-dl
  mkdir -p "$TMP"
  
  # Try multiple mirrors
  for REPO in \
    "https://packages.termux.dev/apt/termux-main" \
    "https://packages-cf.termux.dev/apt/termux-main" \
    "http://packages.termux.dev/apt/termux-main" \
    "http://packages-cf.termux.dev/apt/termux-main" \
    "https://mirror.freedif.org/termux/termux-main" \
    "http://mirror.freedif.org/termux/termux-main"; do
    
    echo "[setup] Trying mirror: $REPO"
    
    # Get package filename
    FNAME=$(curl -fsSL --retry 2 --max-time 30 "$REPO/dists/stable/main/binary-aarch64/Packages" 2>/dev/null \
      | awk '/^Package: nodejs$/{f=1} f&&/^Filename: /{print $2; exit}')
    
    if [ -n "$FNAME" ]; then
      echo "[setup] Found nodejs package: $FNAME"
      break
    fi
  done
  
  if [ -z "$FNAME" ]; then
    echo "[setup] ERROR: Could not find nodejs package on any mirror"
    echo "[setup] Last curl attempts:"
    tail -20 $HOME/.curl-node.log 2>/dev/null || echo "No curl log"
    return 1
  fi
  
  # Download the package
  echo "[setup] Downloading nodejs from $REPO..."
  if ! curl -fSL --retry 3 --max-time 300 -o "$TMP/node.deb" "$REPO/$FNAME" 2>>$HOME/.curl-node.log; then
    echo "[setup] ERROR: Download failed"
    tail -10 $HOME/.curl-node.log
    return 1
  fi
  
  echo "[setup] Downloaded $(ls -lh $TMP/node.deb | awk '{print $5}')"
  
  # Unpack the deb
  echo "[setup] Unpacking..."
  
  # Try dpkg-deb first
  if [ -x "$PREFIX/bin/dpkg-deb" ]; then
    "$PREFIX/bin/dpkg-deb" --fsys-tarfile "$TMP/node.deb" 2>/dev/null | \
      "$PREFIX/bin/tar" -xJ --strip-components=6 -C "$PREFIX" 2>>$HOME/.curl-node.log
    if [ $? -eq 0 ] && command -v node >/dev/null 2>&1; then
      echo "[setup] Node.js installed via dpkg-deb: $(node -v)"
      rm -rf "$TMP"
      return 0
    fi
  fi
  
  # Fallback: direct tar extraction
  echo "[setup] Trying direct tar extraction..."
  "$PREFIX/bin/tar" -xJf "$TMP/node.deb" --strip-components=6 -C "$PREFIX" 2>>$HOME/.curl-node.log
  if [ $? -eq 0 ] && command -v node >/dev/null 2>&1; then
    echo "[setup] Node.js installed via tar: $(node -v)"
    rm -rf "$TMP"
    return 0
  fi
  
  # Check what went wrong
  echo "[setup] Extract failed, checking..."
  if [ -f "$PREFIX/bin/node" ]; then
    echo "[setup] node binary exists but may not be executable"
    chmod +x "$PREFIX/bin/node" 2>/dev/null || true
    if command -v node >/dev/null 2>&1; then
      echo "[setup] Node.js works after chmod: $(node -v)"
      rm -rf "$TMP"
      return 0
    fi
  fi
  
  echo "[setup] ERROR: Failed to extract nodejs"
  tail -10 $HOME/.curl-node.log
  return 1
}

################################################################################
# Main
################################################################################
case "$1" in
  proxy)
    echo "[proxy] Starting Proxy Gateway..."
    
    # Install node if needed
    if ! command -v node >/dev/null 2>&1; then
      echo "[proxy] Node.js not found, installing..."
      if ! install_node; then
        echo "[proxy] ERROR: Node.js installation failed"
        echo "[proxy] Please check the Terminal tab for details"
        exit 1
      fi
    fi
    
    echo "[proxy] Node $(node -v) ready"
    
    # Start provisioning in background
    if [ -f "$HOME/provision.sh" ]; then
      sh "$HOME/provision.sh" >/dev/null 2>&1 &
    fi
    
    echo "[proxy] Starting gateway :8787 + terminal :8788"
    exec node proxy.js
    ;;
    
  harness)
    echo "[harness] Starting DeepSeek Harness..."
    
    # Install node if needed
    if ! command -v node >/dev/null 2>&1; then
      echo "[harness] Node.js not found, installing..."
      if ! install_node; then
        echo "[harness] ERROR: Node.js installation failed"
        echo "[harness] Please check the Terminal tab for details"
        exit 1
      fi
    fi
    
    echo "[harness] Node $(node -v) ready"
    
    # Mark node as ready
    touch "$HOME/.dsh-node-ok"
    mkdir -p "$HOME/dsh-data"
    
    # Log boot event
    printf '{"type":"boot","title":"Harness booting","detail":"Node %s ready","sev":"info","ts":%s}' \
      "$(node -v)" "$(date +%s)000" > "$HOME/dsh-data/event-live.json" 2>/dev/null
    
    echo "[harness] Starting console on 127.0.0.1:3080"
    
    # Try to start real dsh core if available
    if command -v npx >/dev/null 2>&1; then
      echo "[harness] Attempting to start dsh core on :3081..."
      (npx -y @deepseek-ai/dsh web --no-open --port 3081 >/dev/null 2>&1 || true) &
    fi
    
    exec node dsh-web.js
    ;;
    
  *)
    echo "Usage: setup.sh {harness|proxy}"
    exit 2
    ;;
esac
