#!/usr/bin/env bash
set -euo pipefail
SDK="$HOME/android-sdk"
BT="$SDK/build-tools/v"
PLAT="$SDK/platforms/android-34/android.jar"
cd "$(dirname "$0")"

rm -rf build
mkdir -p build/classes build/dex build/apk

echo "== aapt2 compile =="
"$BT/aapt2" compile --dir res -o build/res.zip

echo "== aapt2 link =="
mkdir -p build/gen
"$BT/aapt2" link -o build/base.apk -I "$PLAT" --manifest AndroidManifest.xml \
  -A assets -R build/res.zip --auto-add-overlay --java build/gen

echo "== javac =="
find src build/gen -name '*.java' > build/sources.txt
javac --release 11 -encoding UTF-8 -classpath "$PLAT" -d build/classes @build/sources.txt

echo "== d8 =="
find build/classes -name '*.class' > build/classlist.txt
"$BT/d8" --release --min-api 26 --lib "$PLAT" --output build/dex @build/classlist.txt

echo "== package dex =="
(cd build/dex && zip -q -X "$OLDPWD/build/base.apk" classes.dex)

echo "== zipalign =="
"$BT/zipalign" -f 4 build/base.apk build/aligned.apk

echo "== keystore =="
if [ ! -f build/dsh.keystore ]; then
  keytool -genkeypair -keystore build/dsh.keystore -alias dshlocal \
    -keyalg RSA -keysize 2048 -validity 10000 \
    -storepass dshlocal -keypass dshlocal \
    -dname "CN=DSH Local, OU=Mobile, O=DSH Local, C=US"
fi

echo "== apksigner =="
"$BT/apksigner" sign --ks build/dsh.keystore --ks-pass pass:dshlocal --key-pass pass:dshlocal \
  --out build/dsh-local.apk build/aligned.apk

echo "== verify =="
"$BT/apksigner" verify --print-certs build/dsh-local.apk

echo "== done =="
ls -la build/dsh-local.apk
