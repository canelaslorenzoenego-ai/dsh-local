// Publishes the entire project to GitHub via the REST API (no git binary needed —
// the container blocks git, but the API does everything: create repo, upload blobs,
// build a tree + commit, and point main at it).
//
// Requires GITHUB_TOKEN in the environment.
// Token scope: classic PAT with `repo` scope, or fine-grained with
// Administration: rw + Contents: rw.
//
// Usage: GITHUB_TOKEN=ghp_xxx node scripts/publish-to-github.cjs [repo-name]
const { readFileSync, readdirSync, statSync } = require("node:fs");
const { join, relative, sep } = require("node:path");

const API = "https://api.github.com";
const TOKEN = process.env.GITHUB_TOKEN;
const REPO_NAME = process.argv[2] || "dsh-local";
const ROOT = process.cwd();

const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", ".vite", "build",
  "apk/build", "apk\\build", "__pycache__",
]);
const SKIP_FILES = new Set([".env.local", ".env", "package-lock.json", "bun.lockb"]);
const SKIP_EXT = new Set([".log", ".tmp"]);

if (!TOKEN) {
  console.error(
    "✗ GITHUB_TOKEN is not set.\n" +
    "  Run: GITHUB_TOKEN=ghp_xxx node scripts/publish-to-github.cjs"
  );
  process.exit(1);
}

const gh = async (path, opts = {}) => {
  const res = await fetch(`${API}${path}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "dsh-local-publisher",
      "Content-Type": "application/json",
      ...(opts.headers || {}),
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`GitHub API ${res.status} on ${path}: ${body.slice(0, 400)}`);
  }
  return res.status === 204 ? null : res.json();
};

const walk = (dir) => {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = relative(ROOT, join(dir, entry.name));
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(rel) || SKIP_DIRS.has(rel.split(sep).join("/"))) continue;
      out.push(...walk(join(dir, entry.name)));
    } else if (entry.isFile()) {
      const ext = entry.name.slice(entry.name.lastIndexOf("."));
      if (SKIP_FILES.has(entry.name) || SKIP_EXT.has(ext)) continue;
      out.push(join(dir, entry.name));
    }
  }
  return out;
};

async function main() {
  // 0. Validate token + scopes
  const res = await fetch(`${API}/user`, {
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "dsh-local-publisher",
    },
  });
  if (!res.ok) {
    throw new Error(
      res.status === 401
        ? "Token rejected (401) — check it's complete and not expired/revoked"
        : `Token check failed: ${res.status}`
    );
  }
  const me = await res.json();
  const scopes = res.headers.get("x-oauth-scopes") || "(none listed)";
  console.log(`✓ Authenticated as ${me.login} · scopes: ${scopes}`);

  // 1. Create repo (idempotent — reuse if it already exists)
  let repo;
  try {
    repo = await gh("/user/repos", {
      method: "POST",
      body: JSON.stringify({
        name: REPO_NAME,
        description:
          "Native Android APK with embedded Linux — DeepSeek Harness console + OpenAI-compatible gateway + terminal, all on localhost",
        private: false,
        auto_init: false,
      }),
    });
    console.log(`✓ Created repo ${me.login}/${REPO_NAME}`);
  } catch (e) {
    if (String(e).includes("422")) {
      repo = await gh(`/repos/${me.login}/${REPO_NAME}`);
      console.log(`• Repo ${me.login}/${REPO_NAME} already exists — force-updating main`);
    } else throw e;
  }
  const full = repo.full_name;

  // 1.5 Bootstrap: the Git Data API (blobs) 409s on a repo with zero commits,
  // so seed one file through the Contents API first if main doesn't exist.
  let hasMain = true;
  try {
    await gh(`/repos/${full}/branches/main`);
  } catch {
    hasMain = false;
  }
  if (!hasMain) {
    const readme = (() => {
      try { return readFileSync(join(ROOT, "README.md")); }
      catch { return Buffer.from("# DSH Local\n"); }
    })();
    await gh(`/repos/${full}/contents/README.md`, {
      method: "PUT",
      body: JSON.stringify({
        message: "Initial commit",
        content: readme.toString("base64"),
      }),
    });
    console.log("✓ Bootstrapped empty repo with an initial commit");

    // GitHub's git backend is eventually consistent: poll until refs/heads/main
    // is visible to the Git Data API (otherwise blob uploads 409 "repo is empty").
    process.stdout.write("  waiting for GitHub to register the branch…");
    for (let i = 0; i < 45; i++) {
      try {
        await gh(`/repos/${full}/git/refs/heads/main`);
        console.log(" ready");
        break;
      } catch {
        process.stdout.write(".");
        await new Promise((r) => setTimeout(r, 2000));
      }
      if (i === 44) console.log("\n⚠ branch still not visible — continuing with retries");
    }
  }

  // 2. Collect + upload blobs
  const files = walk(ROOT);
  const totalMB = files.reduce((n, f) => n + statSync(f).size, 0) / 1e6;
  const big = files.filter((f) => statSync(f).size > 50e6);
  if (big.length) throw new Error(`Files over 50 MB can't go through the API: ${big.join(", ")}`);
  console.log(`✓ ${files.length} files, ${totalMB.toFixed(1)} MB total`);

  const tree = [];
  let done = 0;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const putBlob = async (file) => {
    const content = readFileSync(file).toString("base64");
    for (let attempt = 0; ; attempt++) {
      try {
        return await gh(`/repos/${full}/git/blobs`, {
          method: "POST",
          body: JSON.stringify({ content, encoding: "base64" }),
        });
      } catch (e) {
        if (String(e).includes("409") && attempt < 5) {
          await sleep(3000 * (attempt + 1));
          continue;
        }
        throw e;
      }
    }
  };
  const queue = [...files];
  const CONC = 4;
  const workers = Array.from({ length: CONC }, async () => {
    for (;;) {
      const file = queue.shift();
      if (!file) return;
      const { sha } = await putBlob(file);
      tree.push({
        path: relative(ROOT, file).split(sep).join("/"),
        mode: "100644",
        type: "blob",
        sha,
      });
      done++;
      if (done % 25 === 0 || done === files.length)
        console.log(`  … ${done}/${files.length} uploaded`);
    }
  });
  await Promise.all(workers);

  // 3. Tree → commit → main (on top of existing history when present)
  const { sha: treeSha } = await gh(`/repos/${full}/git/trees`, {
    method: "POST",
    body: JSON.stringify({ tree }),
  });
  let parents = [];
  try {
    const ref = await gh(`/repos/${full}/git/ref/heads/main`);
    if (ref && ref.object && ref.object.sha) parents = [ref.object.sha];
  } catch (e) { /* empty repo — no parent */ }
  const { sha: commitSha } = await gh(`/repos/${full}/git/commits`, {
    method: "POST",
    body: JSON.stringify({
      message:
        "DSH Local v2.7.0 — chat playground, files manager, usage analytics, activity feed, secrets vault, screenshots",
      tree: treeSha,
      parents,
    }),
  });
  try {
    await gh(`/repos/${full}/git/refs`, {
      method: "POST",
      body: JSON.stringify({ ref: "refs/heads/main", sha: commitSha }),
    });
  } catch {
    await gh(`/repos/${full}/git/refs/heads/main`, {
      method: "PATCH",
      body: JSON.stringify({ sha: commitSha, force: true }),
    });
  }

  console.log(`\n🎉 Published: https://github.com/${full}`);
  console.log(`   Files: ${files.length} · Commit: ${commitSha.slice(0, 7)}`);
}

main().catch((e) => {
  console.error(`✗ Publish failed: ${e.message}`);
  process.exit(1);
});
