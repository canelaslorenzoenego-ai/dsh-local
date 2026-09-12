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

# Add full Termux repositories (F-Droid official) for access to all packages
add_termux_repos() {
  echo "[provision] adding full Termux package repositories…"
  mkdir -p "$PREFIX/etc/apt"
  
  # Main repository - all standard packages
  cat > "$PREFIX/etc/apt/sources.list" <<'EOF'
deb https://packages.termux.dev/apt/termux-main stable main
EOF
  
  # Add trusted keys if available from bootstrap
  if [ -d "$PREFIX/share/termux-keyring" ] && [ -n "$(ls "$PREFIX/share/termux-keyring"/*.gpg 2>/dev/null)" ]; then
    mkdir -p "$PREFIX/etc/apt/trusted.gpg.d"
    cp "$PREFIX/share/termux-keyring"/*.gpg "$PREFIX/etc/apt/trusted.gpg.d/" 2>/dev/null
    echo "[provision] installed Termux signing keys"
  fi
  
  # Fix apt.conf if needed
  if [ -f "$PREFIX/etc/apt/apt.conf" ] && ! grep -q 'Dir::Bin::Methods' "$PREFIX/etc/apt/apt.conf" 2>/dev/null; then
    printf 'Dir::Bin::Methods "%s/lib/apt/methods/";\n' "$PREFIX" >> "$PREFIX/etc/apt/apt.conf"
  fi
  
  # Convert https to http if no https method available
  if [ -f "$PREFIX/etc/apt/sources.list" ] && grep -q '^deb https://' "$PREFIX/etc/apt/sources.list" 2>/dev/null; then
    sed -i 's|https://|http://|g' "$PREFIX/etc/apt/sources.list"
    echo "[provision] converted to http (no https method in bootstrap)"
  fi
}

step "adding Termux repositories"
add_termux_repos

step "updating package index"
apt update >/dev/null 2>&1 || true

step "installing bash"
apt install -y bash >/dev/null 2>&1 || true

step "installing toolchain: git, python, jq, ripgrep, curl, nano"
for p in git curl ca-certificates jq procps findutils tar xz-utils nano python python-pip ripgrep openssh wget golang rust clang Go php perl ruby nodejs gradle maven sqlite openssl ffmpeg imagemagick; do
  apt install -y "$p" >/dev/null 2>&1 || true
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

touch "$DATA/.provisioned"
rm -rf "$DATA/.prov-lock"
done_ok
