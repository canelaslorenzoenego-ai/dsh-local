#!/data/data/com.dshlocal.app/files/usr/bin/sh
# One-time container provisioning for the embedded Linux prefix.
# Installs a real toolchain and writes shell profiles. Idempotent; runs in the
# background on first server start so servers boot fast.
PREFIX=/data/data/com.dshlocal.app/files/usr
export PATH=$PREFIX/bin:$PATH
export HOME=/data/data/com.dshlocal.app/files/home
export TMPDIR=$PREFIX/tmp
export LANG=C.UTF-8
LD_PRELOAD=
DATA=$HOME/dsh-data
LOG=$DATA/provision.json
mkdir -p "$DATA" "$HOME/workspace"

step() { printf '{"done":false,"step":"%s"}\n' "$1" > "$LOG"; }
done_ok() { printf '{"done":true,"step":"ready","ts":%s}\n' "$(date +%s 2>/dev/null || echo 0)" > "$LOG"; }

if [ -f "$DATA/.provisioned" ]; then done_ok; exit 0; fi
mkdir "$DATA/.prov-lock" 2>/dev/null || exit 0  # only one provisioner at a time

# Fix Termux apt configuration - this is critical for apt to work
fix_apt() {
  echo "[provision] fixing apt configuration..."
  
  # 1. Install signing keys from Termux keyring if available
  if [ -d "$PREFIX/share/termux-keyring" ] && [ -n "$(ls "$PREFIX/share/termux-keyring"/*.gpg 2>/dev/null)" ]; then
    mkdir -p "$PREFIX/etc/apt/trusted.gpg.d"
    cp "$PREFIX/share/termux-keyring"/*.gpg "$PREFIX/etc/apt/trusted.gpg.d/" 2>/dev/null
    echo "[provision] installed Termux signing keys"
  fi
  
  # 2. Create apt.conf with required settings
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
EOF
  echo "[provision] created apt.conf"
  
  # 3. Fix sources.list - convert https to http if no https method
  if [ -f "$PREFIX/etc/apt/sources.list" ]; then
    # Check if https method exists
    if [ ! -f "$PREFIX/lib/apt/methods/https" ] && [ ! -f "$PREFIX/bin/curl" ]; then
      sed -i 's|https://|http://|g' "$PREFIX/etc/apt/sources.list"
      echo "[provision] converted sources to http (no https method)"
    fi
  fi
  
  # 4. Ensure the sources.list has proper content
  cat > "$PREFIX/etc/apt/sources.list" <<'EOF'
deb https://packages.termux.dev/apt/termux-main stable main
deb https://packages.termux.dev/apt/termux-root root stable
EOF
  
  # Convert to http if needed
  if [ ! -f "$PREFIX/lib/apt/methods/https" ] && [ ! -x "$PREFIX/bin/curl" ]; then
    sed -i 's|https://|http://|g' "$PREFIX/etc/apt/sources.list"
  fi
  
  echo "[provision] configured sources.list"
}

step "fixing apt configuration"
fix_apt

step "updating package index"
apt update 2>&1 | tail -5 || true

step "installing core packages"
apt install -y bash 2>&1 | tail -3 || true

step "installing toolchain"
for pkg in git curl ca-certificates jq procps findutils tar xz-utils nano python python-pip ripgrep openssh wget golang rust clang php perl ruby nodejs sqlite openssl ffmpeg imagemagick; do
  apt install -y "$pkg" 2>&1 | tail -2 || true
done

step "writing shell profile"
if [ ! -f "$HOME/.bashrc" ]; then
  cat > "$HOME/.bashrc" <<'EOF'
export PS1='\[\e[1;34m\]dsh\[\e[0m\]:\w\$ '
export LANG=C.UTF-8
export EDITOR=nano
alias ll='ls -la'
alias la='ls -a'
alias gs='git status'
alias gl='git log --oneline -12'
cd "$HOME/workspace" 2>/dev/null
EOF
fi
[ -f "$HOME/.profile" ] || printf '. "$HOME/.bashrc" 2>/dev/null\n' > "$HOME/.profile"
mkdir -p "$PREFIX/etc/profile.d"
printf 'export LANG=C.UTF-8\nexport EDITOR=nano\n' > "$PREFIX/etc/profile.d/dsh.sh" 2>/dev/null || true

step "git defaults"
git config --global init.defaultBranch main 2>/dev/null || true
git config --global user.name "dsh-local" 2>/dev/null || true
git config --global user.email "dsh@localhost" 2>/dev/null || true

# Create a helpful script for installing more packages
mkdir -p "$HOME/bin"
cat > "$HOME/bin/termux-install" <<'EOFSCRIPT'
#!/data/data/com.dshlocal.app/files/usr/bin/sh
# Install any Termux package
if [ -z "$1" ]; then
  echo "Usage: termux-install <package-name>"
  echo "Example: termux-install vim"
  exit 1
fi
echo "Installing $1..."
apt update && apt install -y "$1" && echo "Done! Run 'pkg show $1' for info."
EOFSCRIPT
chmod +x "$HOME/bin/termux-install"

touch "$DATA/.provisioned"
rm -rf "$DATA/.prov-lock"
done_ok
