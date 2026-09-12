# Publish DSH Local to GitHub

The Freebuff container blocks `git`/`gh` commands (Vly manages version control there), so the push happens from **your machine**. Takes ~2 minutes.

## 1. Download the project

From the Freebuff project view, download the project as a ZIP and unpack it.

## 2. Create the GitHub repo

Go to <https://github.com/new> and create a repo — suggested settings:

- **Name:** `dsh-local`
- **Description:** `Native Android APK with embedded Linux — DeepSeek Harness console + OpenAI-compatible gateway + terminal, all on localhost`
- **Visibility:** your choice (Public shares the source + APK; Private keeps it yours)
- **Do NOT** initialize with a README (we already have one)

## 3. Push

In the unpacked project folder, run:

```bash
# if the folder isn't already a git repo:
git init -b main

git add -A
git commit -m "DSH Local v2.5.1 — standalone native APK (embedded Linux, dsh console, gateway, terminal)"

git remote add origin https://github.com/<YOUR-USERNAME>/dsh-local.git
git push -u origin main
```

Replace `<YOUR-USERNAME>` with your GitHub username. If HTTPS asks for a password, use a [Personal Access Token](https://github.com/settings/tokens) (classic, `repo` scope) — GitHub no longer accepts account passwords.

Or with the GitHub CLI: `gh repo create dsh-local --public --source=. --push`

## What gets pushed

- `apk/` — full native app source, build script, assets (incl. the 30 MB Termux bootstrap), 43-assertion smoke test
- `public/downloads/dsh-local-v2.5.1.apk` — the signed release build
- `src/` — the single static product/download page (no backend)
- `README.md`, `PUBLISH-TO-GITHUB.md`

`.gitignore` already excludes `node_modules`, build intermediates (`apk/build`), and `.env.local`, so the repo stays lean (~35 MB total).

## Releases (optional but recommended)

Instead of committing the 30 MB APK into git, you can tag a release and attach the APK:

1. Remove it from tracking: `git rm --cached public/downloads/dsh-local-v2.5.1.apk` and add `public/downloads` to `.gitignore`
2. `git tag v2.5.1 && git push origin main --tags`
3. On GitHub → **Releases** → **Draft a new release** → pick tag `v2.5.1` → drag in the APK → publish

This gives users a clean `/releases` download page with checksums.
