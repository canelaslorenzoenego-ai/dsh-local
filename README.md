# DSH Local

A fully standalone native Android APK — **no web backend, no cloud, no accounts**. Everything the product does happens on-device.

## What this project is

The deliverable is `public/downloads/dsh-local-v2.6.0.apk`: a native Java Android app (`com.dshlocal.app`) that carries an entire agent stack inside a single install:

- **Embedded Linux** — the official Termux bootstrap (aarch64) is unpacked into app-private storage on first launch (staging → symlinks → atomic rename → apt/dpkg path rewriting). No Termux install, no F-Droid, no root.
- **DeepSeek Harness console** (`127.0.0.1:3080`) — dsh's real agent presets (Standard, PTC, Minimal, Creator), a full Custom preset studio, 13 plugins, 9 skills, 8 MCPs, 8 integrations, tool search and detail views.
- **Tokenized session links** — the real `dsh web` auth model: starting the harness generates a session token, the console opens only through the tokenized link (shown on the dashboard), and Rotate kills every copy instantly. The terminal shares the same gate.
- **Proxy gateway** (`127.0.0.1:8787`) — OpenAI-compatible `/v1/models` + streaming `/v1/chat/completions`, configurable via `~/gateway.json`.
- **Terminal** (`127.0.0.1:8788`) — real bash login shell in xterm.js, works in-app and in Chrome.
- **Native dashboard** — two Start/Stop buttons (that's it), PIN privacy with screenshot blocking, open-in-app or browser toggle, foreground-service keepalive.

## APK source layout

All native sources live under `apk/`:

```
apk/
├── AndroidManifest.xml          # com.dshlocal.app, targetSdk 28 (W^X bypass), v2.6.0
├── build.sh                     # aapt2 → javac → d8 → zipalign → apksigner pipeline
├── src/com/dshlocal/app/        # MainActivity, ServerService, BootstrapInstaller, Prefs
├── assets/
│   ├── bootstrap-aarch64.zip    # official Termux bootstrap, extracted on first open
│   ├── dsh-web.js               # harness console server (:3080)
│   ├── proxy.js                 # gateway + terminal server (:8787/:8788)
│   ├── setup.sh / provision.sh  # node install + toolchain provisioning
│   └── web/                     # console SPA + terminal (xterm.js)
├── res/                         # layouts, drawables, animations (pulse/slide/fade)
└── test/smoke.cjs               # 61-assertion end-to-end server test
```

## Building / testing the APK

```bash
bash apk/build.sh              # builds + signs → apk/build/dsh-local.apk
node apk/test/smoke.cjs        # boots both servers, runs all 61 assertions
```

The build script downloads the Android SDK toolchain (aapt2, d8, apksigner, android.jar) into `$HOME/android-sdk` on first run if missing.

## The web page in this repo

`src/` contains only a single static product/download page (Vite + React + Tailwind + shadcn/ui) that documents the app and serves the APK from `/downloads/`. There is deliberately **no backend**: no Convex, no auth, no database, no API keys. The landing page and the APK are the whole product.

## Conventions (web page)

- Pages in `src/pages`, shadcn primitives in `src/components/ui`
- Tailwind v4 with the ember theme tokens in `src/index.css`
- Framer Motion for animations; single-route app (`/`), 404 fallback
- Use **bun** as the package manager

## Version history

| Version | Notes |
|---|---|
| v1.0.0 | Termux-bridge prototype (removed) |
| v2.0.0 | Full rebuild: embedded Linux, two servers, terminal, PIN |
| v2.1.0 | Auto-bootstrap on first open |
| v2.2.0 | Plugins / skills / MCPs / integrations console |
| v2.3.1 | dsh's real presets (Standard / PTC / Minimal / Creator) |
| v2.4.0 | Custom preset studio + provisioned container |
| v2.5.1 | Animations, tool search/info, 43/43 smoke test green |
| v2.6.0 | Session-token auth (dsh tokenized links), catalog 13/9/8/8, dashboard session card — 61/61 green |
