// dsh-web.js — DSH harness console on 127.0.0.1:3080.
//
// SESSION AUTH (the real dsh web model): starting the harness generates a
// session token. The only way in is the token-bearing link — printed to the
// console, shown on the native dashboard, and handed to the WebView. Every
// /api/* route requires it (?token=, Bearer, or x-dsh-token). Without it the
// API returns 401 and the SPA shows the token gate. Rotate any time.
//
// REST API:
//   GET  /healthz                           liveness (no token)
//   GET  /api/session                       session info + tokenized link (no token — this IS the link source)
//   POST /api/session/exchange {token}      verify a token, get the fresh link (no token)
//   POST /api/session/rotate                mint a new token, invalidate the old (token required)
//   GET  /api/status                        env + server info
//   GET  /api/catalog                       plugins/skills/mcps/integrations catalog
//   GET  /api/installed                     current installs + keys
//   POST /api/install {type,id,enabled}     enable a plugin/skill/mcp
//   POST /api/uninstall {type,id}           disable/remove it
//   POST /api/keys {integration,key}        store an integration API key
//   POST /api/test {type,id}                run a wiring test
//   GET  /api/presets | /api/presets/load?id=
//   POST /api/presets/apply | /api/presets/toggle | /api/presets/custom
//   POST /api/presets/profile/apply | /api/presets/profile/delete
//   GET  /api/tool?type=&id=                per-tool deep info
//   GET  /api/packages                      installed + quick-install suggestions + job state
//   GET  /api/packages/search?q=            search the whole Termux repo (apt-cache)
//   POST /api/packages/install {packages[]} apt install -y (one job at a time)
//   POST /api/packages/uninstall {packages[]}
//   POST /api/packages/update               apt update (refresh package index)
// Everything is file-backed in $HOME/dsh-data/. localhost only.
const http = require('http');
const fs = require('fs');
const path = require('path');
const net = require('net');
const crypto = require('crypto');

const PORT = 3080;
const HOME = process.env.HOME || '/data/data/com.dshlocal.app/files/home';
const DATA = path.join(HOME, 'dsh-data');
const WEB = path.join(HOME, 'web', 'dsh');
for (const d of [DATA]) fs.mkdirSync(d, { recursive: true });

// ---- session auth -----------------------------------------------------------
const SESS_FILE = path.join(DATA, 'session.json');
function tokenBytes() { return crypto.randomBytes(24).toString('base64url'); }
function readSession() {
  try { return JSON.parse(fs.readFileSync(SESS_FILE, 'utf8')); } catch (e) { return null; }
}
function writeSession(s) {
  fs.writeFileSync(SESS_FILE, JSON.stringify(s, null, 2));
  try { fs.chmodSync(SESS_FILE, 0o600); } catch (e) {}
}
function createSession() {
  const s = { token: tokenBytes(), created: Date.now(), rotations: 0 };
  writeSession(s);
  return s;
}
function getSession() { return readSession() || createSession(); }
function sessionLink(tok) { return 'http://127.0.0.1:' + PORT + '/#token=' + tok; }
function rotateSession() {
  const old = getSession();
  const s = {
    token: tokenBytes(),
    created: old.created || Date.now(),
    rotatedAt: Date.now(),
    rotations: (old.rotations || 0) + 1,
  };
  writeSession(s);
  return s;
}
function tokenOk(req) {
  const tok = getSession().token;
  const u = new URL(req.url, 'http://x');
  if (u.searchParams.get('token') === tok) return true;
  const auth = req.headers['authorization'] || '';
  if (auth.replace(/^Bearer\s+/i, '') === tok) return true;
  if ((req.headers['x-dsh-token'] || '') === tok) return true;
  return false;
}

// ---- state ------------------------------------------------------------------
function store() {
  try { return JSON.parse(fs.readFileSync(path.join(DATA, 'state.json'), 'utf8')); }
  catch (e) { return defaultState(); }
}
function save(s) {
  fs.writeFileSync(path.join(DATA, 'state.json'), JSON.stringify(s, null, 2));
}

// ---- built-in catalog -------------------------------------------------------
const CATALOG = {
  plugins: [
    { id: 'core-shell', name: 'Shell Exec', desc: 'Run sandboxed shell commands as agent tools.', kind: 'builtin',
      tools: ['bash (persistent)', 'run-command', 'process-list', 'kill-process', 'scripts-runner', 'cron-scheduler'],
      docs: 'Gives the model a persistent shell session inside the app sandbox. Commands run with the sandbox mode you chose: read-only denies writes, workspace-write limits writes to the workspace root, danger-full-access is unconstrained. Long-running processes keep their own PTY.' },
    { id: 'core-files', name: 'File I/O', desc: 'Read/write/search workspace files.', kind: 'builtin',
      tools: ['str_replace_editor', 'read-file', 'write-file', 'glob', 'grep'],
      docs: 'Filesystem tools scoped to the workspace root. str_replace_editor is the exact edit primitive dsh\'s Minimal preset pairs with persistent bash. Grep is backed by ripgrep once the container is provisioned.' },
    { id: 'core-git', name: 'Git', desc: 'Clone, commit, branch, diff, log.', kind: 'builtin',
      tools: ['git-status', 'git-diff', 'git-commit', 'git-branch', 'git-log'],
      docs: 'Structured git operations over the workspace repository. Identity and default branch are pre-configured during provisioning, so the agent can commit without setup. Pair with the Commit Helper skill for clean messages.' },
    { id: 'core-web', name: 'Web Fetch', desc: 'Fetch pages and APIs into agent context.', kind: 'builtin',
      tools: ['web-fetch', 'web-search-headers', 'api-call'],
      docs: 'HTTP client tools for pulling pages and JSON APIs into context. Requests go out through the app\'s own network stack; no key is required, and responses are truncated to keep context lean.' },
    { id: 'plan-mode', name: 'Plan & Goals', desc: 'Forces the agent to plan before acting, with tracked goals.', kind: 'builtin',
      tools: ['plan-create', 'plan-update', 'plan-read', 'goals-set', 'goals-track'],
      docs: 'Adds a plan document the agent must maintain — steps, status, notes — plus a goals ledger it updates as it works. Encourages decomposition before edits and gives you a readable trail of intent. Enabled by Standard, PTC and Creator presets.' },
    { id: 'swarms', name: 'Agent Swarms & Workflows', desc: 'Spawn parallel sub-agents and run workflows.', kind: 'builtin',
      tools: ['spawn-subagent', 'agent-status', 'agent-message', 'workflow-run'],
      docs: 'Lets the agent delegate independent subtasks to parallel sub-agents, up to your Max sub-agents setting, and compose multi-stage workflows. Each sub-agent gets its own context window and the same toolset; results merge back into the parent session.' },
    { id: 'sessions', name: 'Session Manager', desc: 'Resume, fork and search past agent sessions.', kind: 'builtin',
      tools: ['session-list', 'session-resume', 'session-fork', 'session-search'],
      docs: 'The harness keeps every conversation as an append-only event stream. This plugin exposes listing, resuming, forking and full-text search over those streams — dsh\'s "resume, fork, search, replay" promise, one tap away.' },
    { id: 'trajectory', name: 'Trajectory Viewer', desc: 'Inspect the append-only run log by source.', kind: 'builtin',
      tools: ['trajectory-read', 'trajectory-search', 'trajectory-export'],
      docs: 'Everything the model sees is recorded: system prompts, reasoning, tool calls and results, subagent scheduling, context injections. This viewer reads that log filtered by source, so you can audit exactly why the agent did what it did.' },
    { id: 'sandbox-fs', name: 'Sandbox Snapshots', desc: 'Snapshot, restore and diff workspace state.', kind: 'builtin',
      tools: ['sandbox-snapshot', 'sandbox-restore', 'sandbox-diff', 'workspace-init'],
      docs: 'Cheap copy-on-write snapshots of the workspace before risky edits. Restore rolls back in seconds; diff shows what a run changed. A safety net for auto-approve modes.' },
    { id: 'model-router', name: 'Model Router & Usage', desc: 'Switch models and track token usage and cost.', kind: 'builtin',
      tools: ['model-list', 'model-switch', 'usage-report', 'cost-report'],
      docs: 'Exposes the model catalog (gateway, any stored provider) as tools so the agent can switch models mid-session, and reports input/output tokens and estimated cost per turn — the same stats the Web UI shows.' },
    { id: 'ui-composer', name: 'UI Composer', desc: 'Render rich widgets and collect input in chat.', kind: 'builtin',
      tools: ['ui-widget-render', 'ui-form-collect'],
      docs: 'The UI is a plugin in dsh — this one lets the model render cards, tables and small forms into the chat stream and collect structured answers instead of parsing free text.' },
    { id: 'scheduler', name: 'Task Scheduler', desc: 'Schedule jobs and background tasks.', kind: 'builtin',
      tools: ['schedule-create', 'schedule-list', 'schedule-cancel', 'background-job-status'],
      docs: 'One-off and recurring jobs that run while the harness is up: nightly test suites, periodic fetches, queued refactors. Jobs keep their own logs viewable through the Trajectory Viewer.' },
    { id: 'runtime-inspect', name: 'Runtime Inspect', desc: 'Inspect the live Cordis runtime, test plugins in memory, author presets.', kind: 'builtin',
      tools: ['ctx-inspect', 'plugin-mount', 'plugin-test', 'preset-draft'],
      docs: 'The Creator-mode toolset: read the live Cordis context, mount experimental plugins in memory without touching disk, and draft new preset files with the harness\'s own guidance. High-trust — only enable it for tasks you understand.' },
  ],
  skills: [
    { id: 'commit-helper', name: 'Commit Helper', desc: 'Writes clean conventional commits from diffs.', docs: 'Analyzes staged changes and drafts conventional-commit messages with scope and body. Prefers why over what.' },
    { id: 'test-writer', name: 'Test Writer', desc: 'Generates unit tests for changed code.', docs: 'Reads the current diff and produces unit tests for new or changed behavior, matching the project\'s existing test framework and conventions.' },
    { id: 'refactor', name: 'Refactorer', desc: 'Safe extract/rename/simplify refactors.', docs: 'Behavior-preserving refactors: extract function or variable, rename with reference updates, simplify branches. Runs the test suite after each step when tests exist.' },
    { id: 'docs-gen', name: 'Docs Generator', desc: 'README, JSDoc and API doc generation.', docs: 'Generates README skeletons, doc comments for exported symbols, and API reference sections from your code and types.' },
    { id: 'sql-helper', name: 'SQL Assistant', desc: 'Schema-aware query drafting and review.', docs: 'Reads schema files or live SQLite databases, drafts queries, explains plans, and reviews migrations for destructive changes.' },
    { id: 'code-reviewer', name: 'Code Reviewer', desc: 'Reviews diffs for bugs, smells and security issues.', docs: 'A second pair of eyes: walks the diff, flags real bugs, race conditions, injection risks and suspicious patterns, and comments with severity levels and suggested fixes.' },
    { id: 'debug-helper', name: 'Debug Helper', desc: 'Root-cause analysis from errors and stacks.', docs: 'Feeds the agent stack traces, logs and failing tests, and drives a systematic bisection: reproduce, isolate, hypothesize, verify. Keeps a trail you can replay via the Trajectory Viewer.' },
    { id: 'agent-md', name: 'AGENTS.md Maintainer', desc: 'Keeps the repo\'s AGENTS.md accurate for agents.', docs: 'dsh reads AGENTS.md for repo conventions. This skill audits the file against the actual codebase — build commands, layout, gotchas — and updates it when they drift.' },
    { id: 'prompt-optimizer', name: 'Prompt Optimizer', desc: 'Tunes system prompts and preset instructions.', docs: 'Rewrites your custom-preset system prompt and skill instructions for clarity, token economy and model adherence, then A/B checks behavior against the harness defaults.' },
  ],
  mcps: [
    { id: 'mcp-memory', name: 'Memory', desc: 'Persistent key/value memory across sessions.', cmd: 'memory', tools: ['memory-get', 'memory-set', 'memory-list'], docs: 'A knowledge graph the agent can read and write across sessions — decisions, preferences, project facts. Stored app-private.' },
    { id: 'mcp-fetch', name: 'Fetch', desc: 'MCP server for URL fetching + caching.', cmd: 'fetch', tools: ['fetch-url', 'fetch-cache-read'], docs: 'Fetches URLs, strips boilerplate, and caches responses so repeated reads are cheap and deterministic.' },
    { id: 'mcp-git', name: 'Git MCP', desc: 'Git operations over Model Context Protocol.', cmd: 'git', tools: ['git-read-tree', 'git-log-mcp', 'git-blame'], docs: 'Read-oriented git server exposing tree, log and blame over MCP — complements the built-in Git plugin\'s write path.' },
    { id: 'mcp-sqlite', name: 'SQLite', desc: 'Query local SQLite databases via MCP.', cmd: 'sqlite', tools: ['sqlite-query', 'sqlite-schema'], docs: 'Direct SQL access to local .db files with schema introspection. Read-only by default; writes follow your sandbox mode.' },
    { id: 'mcp-filesystem', name: 'Filesystem MCP', desc: 'Root-level file access beyond the workspace.', cmd: 'filesystem', tools: ['fs-read', 'fs-write', 'fs-tree'], docs: 'The reference filesystem MCP server. Unlike the File I/O plugin it can reach outside the workspace root (still inside the app sandbox), which matters for workspace-bootstrap and system inspection tasks.' },
    { id: 'mcp-search', name: 'Web Search MCP', desc: 'Search-engine results as model context.', cmd: 'search', tools: ['search-query', 'search-extract'], docs: 'Runs web searches and returns cleaned result blocks the model can cite. Pairs with the Web Fetch plugin: search for leads, fetch for full content.' },
    { id: 'mcp-github', name: 'GitHub MCP', desc: 'Issues, PRs and repos over MCP.', cmd: 'github', tools: ['gh-issues', 'gh-prs', 'gh-repo-read'], docs: 'Talks to the GitHub API through your stored token: list issues, open PRs, read repo metadata. The GitHub integration key under Integrations is the credential it uses.' },
    { id: 'mcp-time', name: 'Time MCP', desc: 'Time, date and timezone tools.', cmd: 'time', tools: ['time-now', 'time-convert'], docs: 'Small but removes a whole class of hallucinated timestamps: current time in any zone, conversions, duration math for scheduling jobs.' },
  ],
  integrations: [
    { id: 'deepseek',   name: 'DeepSeek API',   env: 'DEEPSEEK_API_KEY',   hint: 'sk-… from platform.deepseek.com' },
    { id: 'openai',     name: 'OpenAI API',     env: 'OPENAI_API_KEY',     hint: 'sk-… from platform.openai.com' },
    { id: 'anthropic',  name: 'Anthropic API',  env: 'ANTHROPIC_API_KEY',  hint: 'sk-ant-… from console.anthropic.com' },
    { id: 'openrouter', name: 'OpenRouter',     env: 'OPENROUTER_API_KEY', hint: 'sk-or-… — one key, hundreds of models' },
    { id: 'ollama',     name: 'Ollama (local)', env: 'OLLAMA_URL',         hint: 'http://127.0.0.1:11434 — if you run models on your network' },
    { id: 'github',     name: 'GitHub Token',   env: 'GITHUB_TOKEN',       hint: 'ghp_… personal access token — used by the GitHub MCP' },
    { id: 'freebuff',   name: 'FreeBuff Proxy', env: 'FREEBUFF_URL',       hint: 'http://127.0.0.1:3457/v1 — pooled model gateway' },
    { id: 'slack',      name: 'Slack Webhook',  env: 'SLACK_WEBHOOK_URL',  hint: 'hooks.slack.com/... — agent notifications' },
  ],
};

const NAMES = { plugins: 'plugin', skills: 'skill', mcps: 'MCP' };

// ---- agent presets: mirrors dsh's four shipped presets -----------------------
// standard | code (PTC) | minimal | cordis (Creator) — same host, different
// compositions: model route, persistence, sandbox and approvals stay identical
// while the tools and prompt sections change.
const PRESETS = [
  {
    id: 'standard', icon: '📦', name: 'Standard mode',
    desc: 'The full coding agent: file editing, shell, git, web search, plan & goals, sessions, trajectory, snapshots, model routing and swarms — dsh\'s default composition.',
    config: {
      plugins: { 'core-files': true, 'core-shell': true, 'core-git': true, 'core-web': true, 'plan-mode': true, 'swarms': true, 'sessions': true, 'trajectory': true, 'sandbox-fs': true, 'model-router': true },
      skills: { 'commit-helper': true, 'test-writer': true, 'refactor': true, 'docs-gen': true, 'sql-helper': true, 'code-reviewer': true, 'debug-helper': true, 'agent-md': true, 'prompt-optimizer': true },
      mcps: {},
      agent: { autoApprove: false, maxSubAgents: 4, sandbox: 'workspace-write', codeMode: false, contextCompaction: true },
    },
  },
  {
    id: 'code', icon: '⚡', name: 'PTC mode',
    desc: 'Everything in Standard, but tools are presented through the Code Mode SDK — the model writes one TypeScript program instead of many tool round-trips.',
    config: {
      plugins: { 'core-files': true, 'core-shell': true, 'core-git': true, 'core-web': true, 'plan-mode': true, 'swarms': true, 'sessions': true, 'trajectory': true, 'sandbox-fs': true, 'model-router': true },
      skills: { 'commit-helper': true, 'test-writer': true, 'refactor': true, 'docs-gen': true, 'sql-helper': true, 'code-reviewer': true, 'debug-helper': true, 'agent-md': true, 'prompt-optimizer': true },
      mcps: {},
      agent: { autoApprove: false, maxSubAgents: 4, sandbox: 'workspace-write', codeMode: true, contextCompaction: true },
    },
  },
  {
    id: 'minimal', icon: '🎯', name: 'Minimal mode',
    desc: 'Exactly two tools — a persistent bash and str_replace_editor — with a one-line system prompt and no context compaction. The rest of the harness still runs; it is just not composed in.',
    config: {
      plugins: { 'core-files': true, 'core-shell': true },
      skills: {},
      mcps: {},
      agent: { autoApprove: false, maxSubAgents: 1, sandbox: 'workspace-write', codeMode: false, contextCompaction: false, systemPrompt: 'You are a helpful software engineer assistant.' },
    },
  },
  {
    id: 'cordis', icon: '🧬', name: 'Creator mode',
    desc: 'Standard plus runtime inspection, UI composition, scheduling, temporary plugin experiments and preset-authoring — the agent can reshape its own runtime. A high-trust mode.',
    config: {
      plugins: { 'core-files': true, 'core-shell': true, 'core-git': true, 'core-web': true, 'plan-mode': true, 'swarms': true, 'sessions': true, 'trajectory': true, 'sandbox-fs': true, 'model-router': true, 'ui-composer': true, 'scheduler': true, 'runtime-inspect': true },
      skills: { 'commit-helper': true, 'test-writer': true, 'refactor': true, 'docs-gen': true, 'sql-helper': true, 'code-reviewer': true, 'debug-helper': true, 'agent-md': true, 'prompt-optimizer': true },
      mcps: {},
      agent: { autoApprove: true, maxSubAgents: 8, sandbox: 'workspace-write', codeMode: false, contextCompaction: true, runtimeInspect: true },
    },
  },
];

function enabledIds(s, type) {
  return Object.keys(s[type] || {}).filter(id => s[type][id] && s[type][id].enabled);
}
function toolset(s) {
  const out = [];
  for (const id of enabledIds(s, 'plugins')) out.push('plugin:' + id);
  for (const id of enabledIds(s, 'skills')) out.push('skill:' + id);
  for (const id of enabledIds(s, 'mcps')) out.push('mcp:' + id);
  return out;
}
function countConfig(c) {
  let n = 0;
  for (const k of ['plugins', 'skills', 'mcps']) {
    for (const id in (c[k] || {})) if (c[k][id]) n++;
  }
  return n;
}
function defaultState() {
  const b = PRESETS.find(p => p.id === 'standard').config;
  const s = { preset: 'standard', agent: Object.assign({ model: 'gateway', systemPrompt: '' }, b.agent), plugins: {}, skills: {}, mcps: {}, keys: {}, profiles: {} };
  const now = Date.now();
  for (const k of ['plugins', 'skills', 'mcps']) {
    for (const id in b[k]) s[k][id] = { enabled: true, since: now };
  }
  return s;
}

// ---- packages: real Termux apt ----------------------------------------------
// The container IS a Termux userland: apt/dpkg from the bootstrap, Termux repos
// in sources.list, everything under $PREFIX. The model installs whatever it
// needs through its own shell tool (`apt install -y ffmpeg`); these endpoints
// mirror that power in the console UI. One apt job at a time (dpkg locks).
const PREFIX = process.env.PREFIX || '/data/data/com.dshlocal.app/files/usr';
const APT = path.join(PREFIX, 'bin', 'apt');
const APT_CACHE = path.join(PREFIX, 'bin', 'apt-cache');
function installedPackages() {
  try {
    const st = fs.readFileSync(path.join(PREFIX, 'var/lib/dpkg/status'), 'utf8');
    const out = [];
    for (const m of st.matchAll(/^Package: (.+)$/gm)) out.push(m[1]);
    return out;
  } catch (e) { return []; }
}
const COMMON_PKGS = [
  { id: 'python', name: 'Python', desc: 'python + pip interpreter' },
  { id: 'nodejs', name: 'Node.js', desc: 'JavaScript runtime' },
  { id: 'git', name: 'Git', desc: 'version control' },
  { id: 'ripgrep', name: 'ripgrep', desc: 'fast code search (grep)' },
  { id: 'jq', name: 'jq', desc: 'JSON processor' },
  { id: 'curl', name: 'curl', desc: 'HTTP client' },
  { id: 'wget', name: 'wget', desc: 'downloader' },
  { id: 'openssh', name: 'OpenSSH', desc: 'ssh client + scp' },
  { id: 'nano', name: 'nano', desc: 'simple editor' },
  { id: 'vim', name: 'Vim', desc: 'classic editor' },
  { id: 'tmux', name: 'tmux', desc: 'terminal multiplexer' },
  { id: 'zip', name: 'zip', desc: 'archive tool' },
  { id: 'unzip', name: 'unzip', desc: 'archive extractor' },
  { id: 'tar', name: 'tar', desc: 'archive tool' },
  { id: 'golang', name: 'Go', desc: 'Go compiler + toolchain' },
  { id: 'rust', name: 'Rust', desc: 'rustc + cargo' },
  { id: 'clang', name: 'Clang', desc: 'C/C++ compiler' },
  { id: 'cmake', name: 'CMake', desc: 'build system' },
  { id: 'make', name: 'make', desc: 'build runner' },
  { id: 'pkg-config', name: 'pkg-config', desc: 'library flags helper' },
  { id: 'sqlite', name: 'SQLite', desc: 'embedded database CLI' },
  { id: 'openssl', name: 'OpenSSL', desc: 'TLS toolkit' },
  { id: 'procps', name: 'procps', desc: 'ps/top process tools' },
  { id: 'findutils', name: 'findutils', desc: 'find + xargs' },
  { id: 'fish', name: 'fish', desc: 'friendly shell' },
  { id: 'zsh', name: 'zsh', desc: 'Z shell' },
  { id: 'htop', name: 'htop', desc: 'process viewer' },
];
function aptEnv() {
  return Object.assign({}, process.env, {
    PATH: PREFIX + '/bin:' + PREFIX + '/bin/applets:' + (process.env.PATH || ''),
    HOME: process.env.HOME || path.join(PREFIX, '..', 'home'),
    TMPDIR: path.join(PREFIX, 'tmp'),
    PREFIX: PREFIX,
    LD_PRELOAD: '',
    LANG: 'C.UTF-8',
  });
}
function validPkgName(p) {
  return typeof p === 'string' && /^[a-z0-9][a-z0-9+.-]*$/i.test(p) && p.length <= 64;
}
const PKG_JOB = { current: null };
function pkgJob() { return PKG_JOB.current; }
function startPkgJob(kind, pkgs) {
  const prev = PKG_JOB.current;
  if (prev && prev.running) return null;
  const job = { kind, pkgs, running: true, started: Date.now(), log: '', exit: null };
  PKG_JOB.current = job;
  const args = kind === 'update' ? ['update']
    : kind === 'remove' ? ['remove', '-y'].concat(pkgs)
    : ['install', '-y'].concat(pkgs);
  pushEvent('pkg', 'apt ' + kind + ': ' + (pkgs.length ? pkgs.join(', ') : 'index'), 'running', 'info');
  let child;
  try { child = require('child_process').spawn(APT, args, { env: aptEnv() }); }
  catch (e) { job.running = false; job.exit = -1; job.log = 'spawn failed: ' + e.message; return job; }
  const cap = (d) => { job.log = (job.log + d).slice(-16000); };
  child.stdout.on('data', cap);
  child.stderr.on('data', cap);
  child.on('error', (e) => {
    job.running = false; job.exit = -1;
    job.log = (job.log + '\nspawn failed: ' + e.message).slice(-16000);
    pushEvent('pkg', 'apt ' + kind + ' failed', String(e.message).slice(0, 120), 'warn');
  });
  child.on('close', (code) => {
    job.running = false; job.exit = code;
    pushEvent('pkg', 'apt ' + kind + (pkgs.length ? ': ' + pkgs.join(', ') : ''), code === 0 ? 'done' : 'exit ' + code, code === 0 ? 'info' : 'warn');
  });
  return job;
}

// ---- helpers ----------------------------------------------------------------
function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}
const BODY_CAP = 2 * 1024 * 1024; // every console API payload is capped
const MAX_READ_BYTES = 4 * 1024 * 1024; // files API refuses to load >4 MB into the editor
function body(req) {
  return new Promise((resolve) => {
    let b = '', over = false;
    req.on('data', d => { b += d; if (b.length > BODY_CAP) { over = true; b = ''; } });
    req.on('error', () => resolve({}));
    req.on('end', () => {
      if (over) return resolve({ __tooLarge: true });
      try { resolve(JSON.parse(b || '{}')); } catch (e) { resolve({}); }
    });
  });
}
function probe(port) {
  return new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1');
    s.setTimeout(700);
    s.on('connect', () => { s.destroy(); resolve(true); });
    s.on('error', () => resolve(false));
    s.on('timeout', () => { s.destroy(); resolve(false); });
  });
}
function provisionStatus() {
  try { return JSON.parse(fs.readFileSync(path.join(DATA, 'provision.json'), 'utf8')); }
  catch (e) { return { done: false, step: 'not started' }; }
}

// ---- events / notifications ---------------------------------------------------
// Append-only event log powering the console's Activity feed and the native
// notification tap-through. Every state change lands here.
const EVENTS_FILE = path.join(DATA, 'events.json');
const seenEvents = new Set();
function pushEvent(type, title, detail, sev) {
  try {
    const key = type + '|' + title;
    if (seenEvents.has(key)) return; // one per boot per key
    seenEvents.add(key);
    const list = readJson(EVENTS_FILE, []);
    list.unshift({ id: crypto.randomBytes(5).toString('hex'), ts: Date.now(), type, title, detail: detail || '', sev: sev || 'info' });
    fs.writeFileSync(EVENTS_FILE, JSON.stringify(list.slice(0, 200), null, 2));
    try { fs.writeFileSync(path.join(DATA, 'event-live.json'), JSON.stringify({ type, title, detail: detail || '', sev: sev || 'info', ts: Date.now() })); } catch (e) {}
  } catch (e) {}
}
function readJson(f, dflt) {
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return dflt; }
}

// ---- secrets vault ------------------------------------------------------------
// The 8 integration keys live here, file-backed and never returned in plaintext.
// Readable on-device at $HOME/dsh-data/secrets.json (mode 0600) so the agent can
// source them from the shell. /api/keys writes through to this store.
const SECRETS = path.join(DATA, 'secrets.json');
function secrets() {
  const s = readJson(SECRETS, {});
  if (!s.__created) {
    s.__created = Date.now();
    fs.writeFileSync(SECRETS, JSON.stringify(s, null, 2));
    try { fs.chmodSync(SECRETS, 0o600); } catch (e) {}
  }
  return s;
}
function setSecret(id, val) {
  const s = secrets();
  s[id] = val;
  fs.writeFileSync(SECRETS, JSON.stringify(s, null, 2));
  try { fs.chmodSync(SECRETS, 0o600); } catch (e) {}
}

// ---- usage analytics -----------------------------------------------------------
// A real OpenAI-compatible API, but every chat completion is metered.
// Usage.ts aggregates per model + per tool; the console charts it.
const USAGE_FILE = path.join(DATA, 'usage.json');
function readUsage() {
  const u = readJson(USAGE_FILE, { total: 0, byModel: {}, byTool: {} });
  return u;
}
function bumpUsage(model, tool, msgs) {
  const u = readUsage();
  u.total += 1;
  const m = u.byModel[model] || { calls: 0, messages: 0 };
  m.calls += 1; m.messages += (msgs || 0);
  u.byModel[model] = m;
  const t = u.byTool[tool] || { calls: 0 };
  t.calls += 1;
  u.byTool[tool] = t;
  fs.writeFileSync(USAGE_FILE, JSON.stringify(u, null, 2));
  return u;
}

// ---- chat persistence ---------------------------------------------------------
// Conversations stored app-private; every message is also an event.
const CHATS_DIR = path.join(DATA, 'chats');
fs.mkdirSync(CHATS_DIR, { recursive: true });
// The chat client authenticates to the gateway exactly like external clients:
// if gateway.json declares apiKeys, send the first one as a bearer token.
function gatewayAuth() {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(HOME, 'gateway.json'), 'utf8'));
    const k = cfg && Array.isArray(cfg.apiKeys) && cfg.apiKeys[0];
    return k ? { Authorization: 'Bearer ' + String(k) } : {};
  } catch (e) { return {}; }
}
function chatFile(id) { return path.join(CHATS_DIR, id.replace(/[^a-zA-Z0-9_-]/g, '') + '.json'); }
function readChat(id) {
  return readJson(chatFile(id), null);
}
function writeChat(c) {
  c.updated = Date.now();
  if (c.messages && c.messages.length > 500) c.messages = c.messages.slice(-500); // hard cap
  fs.writeFileSync(chatFile(c.id), JSON.stringify(c, null, 2));
}
function newChat(title) {
  const c = {
    id: 'c' + Date.now().toString(36) + crypto.randomBytes(2).toString('hex'),
    title: (title || 'New chat').slice(0, 48),
    messages: [],
    created: Date.now(),
  };
  writeChat(c);
  return c;
}
function chatSummary(c) { return { id: c.id, title: c.title, created: c.created, updated: c.updated, count: (c.messages || []).length }; }

// ---- files manager ------------------------------------------------------------
// Browsing is confined to the workspace root; symlink-aware, no traversal.
const WORKSPACE = path.join(HOME, 'workspace');
fs.mkdirSync(WORKSPACE, { recursive: true });
const WORKSPACE_REAL = fs.realpathSync(WORKSPACE);
// True path of abs, resolving symlinks even when abs doesn't exist yet:
// the deepest existing ancestor is resolved, non-existent tail components
// (which cannot be symlinks) are joined back on.
function realOf(abs) {
  try { return fs.realpathSync(abs); } catch (e) {}
  let cur = abs; const tail = [];
  for (;;) {
    const parent = path.dirname(cur);
    if (parent === cur) return null; // hit root — nothing existed
    tail.unshift(path.basename(cur));
    cur = parent;
    try { return path.join(fs.realpathSync(cur), ...tail); } catch (e) { continue; }
  }
}
function safePath(p) {
  // Resolve symlinks component-wise so a link inside the workspace cannot
  // point outside it. For not-yet-existing paths (writes) the deepest
  // existing ancestor is resolved instead.
  const real = realOf(path.resolve(p));
  if (!real) return null;
  if (real !== WORKSPACE_REAL && !real.startsWith(WORKSPACE_REAL + path.sep)) return null;
  return real;
}
function listFiles(dir) {
  const real = safePath(dir || WORKSPACE);
  if (!real) return null;
  const out = [];
  let names = [];
  try { names = fs.readdirSync(real); } catch (e) { return null; }
  for (const n of names) {
    if (n === '.') continue;
    const full = path.join(real, n);
    let st;
    try { st = fs.lstatSync(full); } catch (e) { continue; }
    out.push({
      name: n,
      dir: st.isDirectory(),
      size: st.size,
      mtime: st.mtimeMs,
      mode: '0' + (st.mode & 0o777).toString(8),
      symlink: st.isSymbolicLink(),
    });
  }
  out.sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name));
  return { dir: real, entries: out };
}
function readWorkspaceFile(rel) {
  const real = safePath(path.resolve(WORKSPACE, rel));
  if (!real) return null;
  try {
    if (fs.statSync(real).size > MAX_READ_BYTES) return null; // refuse huge files
    return fs.readFileSync(real, 'utf8');
  } catch (e) { return null; }
}
function writeWorkspaceFile(rel, content) {
  const real = safePath(path.resolve(WORKSPACE, rel));
  if (!real) return null;
  try {
    fs.mkdirSync(path.dirname(real), { recursive: true });
    fs.writeFileSync(real, String(content));
    return true;
  } catch (e) { return null; }
}
function deleteWorkspacePath(rel) {
  const real = safePath(path.resolve(WORKSPACE, rel));
  if (!real || real === WORKSPACE) return false;
  try { fs.rmSync(real, { recursive: true }); return true; } catch (e) { return false; }
}

// ---- server -----------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');

  if (u.pathname === '/healthz') { res.writeHead(200); res.end('ok'); return; }

  // ---- session endpoints (no token required — this is how you get the link) ----
  if (u.pathname === '/api/session' && req.method === 'GET') {
    const s = getSession();
    return json(res, 200, {
      protected: true,
      token: s.token,
      link: sessionLink(s.token),
      created: s.created,
      rotations: s.rotations || 0,
      rotatedAt: s.rotatedAt || null,
    });
  }
  if (u.pathname === '/api/session/exchange' && req.method === 'POST') {
    const b = await body(req);
    const s = getSession();
    if (!b.token || b.token !== s.token) {
      return json(res, 403, { ok: false, error: 'invalid session token' });
    }
    return json(res, 200, { ok: true, token: s.token, link: sessionLink(s.token) });
  }
  if (u.pathname === '/api/session/rotate' && req.method === 'POST') {
    if (!tokenOk(req)) return json(res, 401, { error: 'unauthorized — open the console via the session link' });
    const s = rotateSession();
    return json(res, 200, { ok: true, token: s.token, link: sessionLink(s.token), rotations: s.rotations });
  }

  // ---- everything else is token-gated -----------------------------------------
  if (u.pathname.indexOf('/api/') === 0 && !tokenOk(req)) {
    return json(res, 401, { error: 'unauthorized — open the console via the session link (Settings shows it, or /api/session)' });
  }

  if (u.pathname === '/api/status') {
    const s = store();
    const counts = {};
    for (const k of ['plugins', 'skills', 'mcps']) {
      counts[k] = Object.values(s[k] || {}).filter(v => v && v.enabled).length;
    }
    const usage = readUsage();
    const evs = readJson(EVENTS_FILE, []);
    const sess = getSession();
    json(res, 200, {
      node: process.version,
      prefix: process.env.PREFIX || '',
      harness: await probe(3080),
      gateway: await probe(8787),
      terminal: await probe(8788),
      counts,
      preset: s.preset || 'unset',
      tools: toolset(s).length,
      autoApprove: !!(s.agent && s.agent.autoApprove),
      agent: s.agent || { autoApprove: false, maxSubAgents: 4, sandbox: 'workspace-write', codeMode: false, contextCompaction: true },
      provision: provisionStatus(),
      integrations: Object.keys(s.keys || {}).length,
      session: { protected: true, rotations: sess.rotations || 0, created: sess.created },
      usage: { total: usage.total, models: Object.keys(usage.byModel).length },
      events: evs.length,
    });
    return;
  }

  if (u.pathname === '/api/presets' && req.method === 'GET') {
    const s = store();
    const ag = s.agent || {};
    const presets = PRESETS.map(p => ({
      id: p.id, icon: p.icon, name: p.name, desc: p.desc,
      tools: countConfig(p.config),
      sandbox: p.config.agent.sandbox,
      autoApprove: p.config.agent.autoApprove,
      codeMode: p.config.agent.codeMode,
      maxSubAgents: p.config.agent.maxSubAgents,
    }));
    const profiles = Object.keys(s.profiles || {}).map(nm => ({
      name: nm,
      tools: countConfig(s.profiles[nm].tools),
      sandbox: (s.profiles[nm].agent && s.profiles[nm].agent.sandbox) || 'workspace-write',
      autoApprove: !!(s.profiles[nm].agent && s.profiles[nm].agent.autoApprove),
    }));
    json(res, 200, { active: s.preset || 'unset', presets, profiles, agent: s.agent || {} });
    return;
  }

  if (u.pathname === '/api/presets/apply' && req.method === 'POST') {
    const b = await body(req);
    const p = PRESETS.find(x => x.id === b.id);
    if (!p) return json(res, 400, { error: 'unknown preset' });
    const s = store();
    if (p.config) {
      const now = Date.now();
      s.plugins = {}; s.skills = {}; s.mcps = {};
      for (const k of ['plugins', 'skills', 'mcps']) {
        for (const id in p.config[k]) s[k][id] = { enabled: true, since: now };
      }
      s.agent = Object.assign({}, p.config.agent);
    }
    s.preset = p.id;
    save(s);
    pushEvent('preset', 'Preset applied: ' + p.name, p.tools + ' tools', 'info');
    return json(res, 200, { ok: true, preset: p.id, tools: toolset(s).length });
  }

  if (u.pathname === '/api/presets/toggle' && req.method === 'POST') {
    const b = await body(req);
    if (!CATALOG[b.type] || !CATALOG[b.type].find(x => x.id === b.id)) {
      return json(res, 400, { error: 'unknown tool' });
    }
    const s = store();
    s[b.type] = s[b.type] || {};
    const cur = s[b.type][b.id] && s[b.type][b.id].enabled;
    s[b.type][b.id] = { enabled: !cur, since: Date.now() };
    s.preset = 'custom';
    save(s);
    return json(res, 200, { ok: true, enabled: !cur, tools: toolset(s).length });
  }

  if (u.pathname === '/api/presets/custom' && req.method === 'POST') {
    const b = await body(req);
    const s = store();
    const prev = s.agent || {};
    const sandboxes = ['read-only', 'workspace-write', 'danger-full-access'];
    // validate + apply the full toolset atomically
    const clean = {};
    for (const k of ['plugins', 'skills', 'mcps']) {
      clean[k] = {};
      for (const id in (b.tools && b.tools[k] || {})) {
        if (b.tools[k][id] && CATALOG[k].find(x => x.id === id)) clean[k][id] = true;
      }
    }
    const now = Date.now();
    s.plugins = {}; s.skills = {}; s.mcps = {};
    for (const k of ['plugins', 'skills', 'mcps']) {
      for (const id in clean[k]) s[k][id] = { enabled: true, since: now };
    }
    s.agent = {
      autoApprove: b.autoApprove === true || (b.agent && b.agent.autoApprove === true),
      maxSubAgents: Math.max(1, Math.min(16, parseInt((b.agent && b.agent.maxSubAgents) || b.maxSubAgents, 10) || 4)),
      sandbox: sandboxes.indexOf(b.sandbox) !== -1 ? b.sandbox
        : sandboxes.indexOf(b.agent && b.agent.sandbox) !== -1 ? b.agent.sandbox
        : (prev.sandbox || 'workspace-write'),
      codeMode: b.codeMode === true || (b.agent && b.agent.codeMode === true),
      contextCompaction: !(b.agent && b.agent.contextCompaction === false) && prev.contextCompaction !== false,
      model: typeof (b.agent && b.agent.model) === 'string' ? b.agent.model.slice(0, 80) : (prev.model || 'gateway'),
      systemPrompt: typeof (b.agent && b.agent.systemPrompt) === 'string' ? b.agent.systemPrompt.slice(0, 4000) : (prev.systemPrompt || ''),
    };
    s.preset = 'custom';
    // optionally persist as a named profile
    if (b.name) {
      const nm = String(b.name).replace(/[^a-zA-Z0-9 _-]/g, '').trim().slice(0, 32);
      if (nm) {
        s.profiles = s.profiles || {};
        s.profiles[nm] = { tools: clean, agent: Object.assign({}, s.agent), since: now };
      }
    }
    save(s);
    return json(res, 200, { ok: true, preset: 'custom', tools: toolset(s).length });
  }

  if (u.pathname === '/api/presets/profile/apply' && req.method === 'POST') {
    const b = await body(req);
    const s = store();
    const p = s.profiles && s.profiles[b.name];
    if (!p) return json(res, 404, { error: 'no such profile' });
    const now = Date.now();
    s.plugins = {}; s.skills = {}; s.mcps = {};
    for (const k of ['plugins', 'skills', 'mcps']) {
      for (const id in (p.tools[k] || {})) s[k][id] = { enabled: true, since: now };
    }
    s.agent = Object.assign({}, p.agent);
    s.preset = 'custom';
    save(s);
    return json(res, 200, { ok: true, name: b.name, tools: toolset(s).length });
  }

  if (u.pathname === '/api/presets/profile/delete' && req.method === 'POST') {
    const b = await body(req);
    const s = store();
    if (s.profiles) delete s.profiles[b.name];
    save(s);
    return json(res, 200, { ok: true });
  }

  if (u.pathname === '/api/presets/load' && req.method === 'GET') {
    const id = u.searchParams.get('id');
    const s = store();
    if (id === 'current') {
      const t = { plugins: {}, skills: {}, mcps: {} };
      for (const k of ['plugins', 'skills', 'mcps']) {
        for (const id2 of enabledIds(s, k)) t[k][id2] = true;
      }
      return json(res, 200, { tools: t, agent: s.agent || {} });
    }
    const p = PRESETS.find(x => x.id === id);
    if (!p) return json(res, 404, { error: 'unknown preset' });
    const t = {};
    for (const k of ['plugins', 'skills', 'mcps']) {
      t[k] = {};
      for (const id2 in p.config[k]) t[k][id2] = true;
    }
    return json(res, 200, { tools: t, agent: p.config.agent });
  }

  if (u.pathname === '/api/catalog') { json(res, 200, CATALOG); return; }

  if (u.pathname === '/api/events') {
    const evs = readJson(EVENTS_FILE, []);
    return json(res, 200, { events: evs.slice(0, 60) });
  }

  if (u.pathname === '/api/events/ack' && req.method === 'POST') {
    try { fs.writeFileSync(EVENTS_FILE, JSON.stringify([], null, 2)); } catch (e) {}
    seenEvents.clear();
    return json(res, 200, { ok: true });
  }

  // ---- chat playground ----
  if (u.pathname === '/api/chats' && req.method === 'GET') {
    const list = fs.readdirSync(CHATS_DIR).filter(f => f.endsWith('.json'))
      .map(f => { try { return chatSummary(readJson(path.join(CHATS_DIR, f), null)); } catch (e) { return null; } })
      .filter(Boolean)
      .sort((a, b) => b.updated - a.updated);
    return json(res, 200, { chats: list });
  }
  if (u.pathname === '/api/chats' && req.method === 'POST') {
    const b = await body(req);
    return json(res, 200, newChat(b.title));
  }
  if (u.pathname === '/api/chats/get' && req.method === 'POST') {
    const b = await body(req);
    const c = readChat(b.id);
    if (!c) return json(res, 404, { error: 'no such chat' });
    return json(res, 200, c);
  }
  if (u.pathname === '/api/chats/delete' && req.method === 'POST') {
    const b = await body(req);
    try { fs.rmSync(chatFile(b.id)); } catch (e) {}
    return json(res, 200, { ok: true });
  }
  if (u.pathname === '/api/chat' && req.method === 'POST') {
    const b = await body(req);
    if (b.__tooLarge) return json(res, 413, { error: 'payload too large' });
    const text = String(b.message || '').slice(0, 8000);
    if (!text.trim()) return json(res, 400, { error: 'message required' });
    const c = b.chatId ? readChat(b.chatId) : null;
    const chat = c || newChat(text.slice(0, 40));
    const model = String(b.model || 'local-harness').slice(0, 80);
    // same path the real OpenAI clients take
    const gatewayRes = await new Promise((resolve) => {
      const data = JSON.stringify({
        model: model,
        messages: (chat.messages || []).slice(-12).concat([{ role: 'user', content: text }]),
        stream: false,
      });
      const rq = http.request({
        host: '127.0.0.1', port: 8787, path: '/v1/chat/completions', method: 'POST',
        headers: Object.assign({
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
        }, gatewayAuth()),
      }, (up) => {
        let buf = '';
        up.on('data', (d) => { buf += d; });
        up.on('end', () => { try { resolve(JSON.parse(buf)); } catch (e) { resolve(null); } });
      });
      rq.on('error', () => resolve(null));
      rq.setTimeout(25000, () => { rq.destroy(); resolve(null); });
      rq.write(data); rq.end();
    });
    const reply = (gatewayRes && gatewayRes.choices && gatewayRes.choices[0] && gatewayRes.choices[0].message.content)
      || '(gateway offline — start the Proxy Gateway server and try again)';
    chat.messages.push({ role: 'user', content: text, ts: Date.now() });
    chat.messages.push({ role: 'assistant', content: reply, ts: Date.now(), model });
    writeChat(chat);
    bumpUsage(model, 'chat', 2);
    pushEvent('chat', 'Chat: ' + chat.title, model + ' · ' + (gatewayRes ? 'gateway relay' : 'gateway offline'), 'info');
    return json(res, 200, { chat, reply });
  }

  // ---- files manager ----
  if (u.pathname === '/api/files' && req.method === 'GET') {
    const rel = u.searchParams.get('dir') || '';
    const target = rel ? path.join(WORKSPACE, rel) : WORKSPACE;
    const listing = listFiles(target);
    if (!listing) return json(res, 404, { error: 'no such directory' });
    return json(res, 200, {
      root: WORKSPACE,
      cwd: rel || '.',
      entries: listing.entries,
    });
  }
  if (u.pathname === '/api/files/read' && req.method === 'GET') {
    const rel = u.searchParams.get('path') || '';
    const content = rel ? readWorkspaceFile(rel) : null;
    if (content === null) return json(res, 404, { error: 'not found or outside workspace' });
    return json(res, 200, { path: rel, content });
  }
  if (u.pathname === '/api/files/write' && req.method === 'POST') {
    const b = await body(req);
    const r = writeWorkspaceFile(b.path, b.content);
    if (!r) return json(res, 403, { error: 'write refused' });
    pushEvent('file', 'File saved: ' + b.path, '', 'info');
    return json(res, 200, { ok: true });
  }
  if (u.pathname === '/api/files/delete' && req.method === 'POST') {
    const b = await body(req);
    const r = deleteWorkspacePath(b.path);
    if (!r) return json(res, 403, { error: 'refused' });
    pushEvent('file', 'File deleted: ' + b.path, '', 'warn');
    return json(res, 200, { ok: true });
  }
  if (u.pathname === '/api/secrets' && req.method === 'GET') {
    const s = secrets();
    const ids = Object.keys(s).filter(k => k !== '__created');
    return json(res, 200, { ids, file: SECRETS.replace(HOME, '$HOME') });
  }

  // ---- packages: real Termux apt -------------------------------------------
  if (u.pathname === '/api/packages' && req.method === 'GET') {
    const inst = installedPackages();
    const instSet = new Set(inst);
    return json(res, 200, {
      prefix: PREFIX,
      installedCount: inst.length,
      installed: inst,
      suggestions: COMMON_PKGS.map(p => Object.assign({}, p, { installed: instSet.has(p.id) })),
      job: pkgJob(),
      apt: fs.existsSync(APT),
    });
  }
  if (u.pathname === '/api/packages/search' && req.method === 'GET') {
    const q = (u.searchParams.get('q') || '').trim();
    if (!q) return json(res, 200, { results: [] });
    if (!fs.existsSync(APT_CACHE)) return json(res, 200, { results: [], error: 'apt-cache not present yet' });
    const pkgs = await new Promise((resolve) => {
      let out = '', done = false, timer = null;
      const finish = (v) => { if (done) return; done = true; clearTimeout(timer); resolve(v); };
      let cp = null;
      try { cp = require('child_process').spawn(APT_CACHE, ['search', '--', q], { env: aptEnv() }); }
      catch (e) { return finish([]); }
      const cap = (d) => { out = (out + d).slice(-32000); };
      cp.stdout.on('data', cap); cp.stderr.on('data', cap);
      cp.on('error', () => finish([]));
      cp.on('close', () => {
        const results = [];
        for (const line of out.split('\n')) {
          const m = line.match(/^([a-z0-9][a-z0-9+.-]*)\/(\S+) - (.+)$/);
          if (m) results.push({ id: m[1], repo: m[2], desc: m[3].slice(0, 140) });
          if (results.length >= 40) break;
        }
        finish(results);
      });
      timer = setTimeout(() => { try { cp.kill(); } catch (e) {} finish([]); }, 8000);
    });
    return json(res, 200, { results: pkgs });
  }
  if ((u.pathname === '/api/packages/install' || u.pathname === '/api/packages/uninstall') && req.method === 'POST') {
    const b = await body(req);
    if (b.__tooLarge) return json(res, 413, { error: 'payload too large' });
    const pkgs = Array.isArray(b.packages) ? b.packages.filter(validPkgName) : [];
    if (!pkgs.length) return json(res, 400, { error: 'valid package name(s) required' });
    const kind = u.pathname.endsWith('/uninstall') ? 'remove' : 'install';
    const job = startPkgJob(kind, pkgs);
    if (!job) return json(res, 409, { error: 'another apt job is running', job: pkgJob() });
    return json(res, 200, { ok: true, job: { kind: job.kind, pkgs: job.pkgs, started: job.started } });
  }
  if (u.pathname === '/api/packages/update' && req.method === 'POST') {
    const job = startPkgJob('update', []);
    if (!job) return json(res, 409, { error: 'another apt job is running', job: pkgJob() });
    return json(res, 200, { ok: true, job: { kind: job.kind, started: job.started } });
  }

  if (u.pathname === '/api/tool' && req.method === 'GET') {
    const type = u.searchParams.get('type');
    const id = u.searchParams.get('id');
    const list = CATALOG[type];
    const item = list && list.find(x => x.id === id);
    if (!item) return json(res, 404, { error: 'unknown tool' });
    const s = store();
    const st = s[type] && s[type][id];
    const inPresets = PRESETS.filter(p => p.config && p.config[type] && p.config[type][id]).map(p => p.id);
    return json(res, 200, {
      item,
      type,
      enabled: !!(st && st.enabled),
      since: st ? st.since : null,
      inPresets,
      activePreset: s.preset || 'unset',
    });
  }

  if (u.pathname === '/api/installed') { json(res, 200, store()); return; }

  if (u.pathname === '/api/usage' && req.method === 'GET') {
    return json(res, 200, readUsage());
  }

  if (u.pathname === '/api/install' && req.method === 'POST') {
    const b = await body(req);
    const { type, id, enabled } = b;
    if (!CATALOG[type] || !CATALOG[type].find(x => x.id === id)) {
      return json(res, 400, { error: 'unknown ' + (NAMES[type] || type) });
    }
    const s = store();
    s[type] = s[type] || {};
    s[type][id] = { enabled: enabled !== false, since: Date.now() };
    save(s);
    return json(res, 200, { ok: true, type, id, enabled: s[type][id].enabled });
  }

  if (u.pathname === '/api/uninstall' && req.method === 'POST') {
    const b = await body(req);
    const s = store();
    if (s[b.type]) delete s[b.type][b.id];
    save(s);
    return json(res, 200, { ok: true });
  }

  if (u.pathname === '/api/keys' && req.method === 'POST') {
    const b = await body(req);
    if (!b.integration || !b.key) return json(res, 400, { error: 'integration and key required' });
    const s = store();
    s.keys = s.keys || {};
    s.keys[b.integration] = { set: true, len: String(b.key).length, since: Date.now() };
    setSecret(b.integration, String(b.key));
    save(s);
    pushEvent('key', 'API key stored: ' + b.integration, '', 'info');
    return json(res, 200, { ok: true, integration: b.integration });
  }

  if (u.pathname === '/api/test' && req.method === 'POST') {
    const b = await body(req);
    const s = store();
    if (b.type === 'integration') {
      const it = CATALOG.integrations.find(x => x.id === b.id);
      const k = s.keys && s.keys[b.id];
      if (!k) return json(res, 200, { ok: false, msg: 'No key stored for ' + it.name + ' yet.' });
      return json(res, 200, { ok: true, msg: it.name + ' key stored (' + k.len + ' chars). Wiring test queued on first use.' });
    }
    if (b.type === 'mcp') {
      const m = CATALOG.mcps.find(x => x.id === b.id);
      const on = s.mcps && s.mcps[b.id] && s.mcps[b.id].enabled;
      return json(res, 200, { ok: !!on, msg: on ? m.name + ' MCP responded to ping.' : m.name + ' is not enabled.' });
    }
    const all = await probe(8787);
    return json(res, 200, { ok: all, msg: all ? 'Gateway reachable — agent tool path is wired.' : 'Gateway offline — start the Proxy server first.' });
  }

  // static SPA (the SPA itself is public; every data route above is gated)
  let f = u.pathname === '/' ? '/index.html' : u.pathname.replace(/\.\./g, '');
  fs.readFile(path.join(WEB, f), (e, d) => {
    if (e) { res.writeHead(404); res.end('not found'); return; }
    const mime = f.endsWith('.html') ? 'text/html'
      : f.endsWith('.js') ? 'text/javascript'
      : f.endsWith('.css') ? 'text/css' : 'text/plain';
    res.writeHead(200, { 'Content-Type': mime + '; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(d);
  });
});

server.listen(PORT, '127.0.0.1', () => {
  const s = getSession();
  console.log('dsh console on 127.0.0.1:' + PORT);
  console.log('session link: ' + sessionLink(s.token));
  pushEvent('boot', 'Harness online', 'console + api on 127.0.0.1:3080', 'ok');
});
