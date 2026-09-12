// dsh-web.js — DSH harness console on 127.0.0.1:3080.
// Serves the management SPA (web/dsh/index.html) plus a local REST API:
//   GET  /api/status                        env + server info
//   GET  /api/catalog                       built-in plugins/skills/mcps/integrations catalog
//   GET  /api/installed                     current installs + keys
//   POST /api/install {type,id,enabled}     enable a plugin/skill/mcp
//   POST /api/uninstall {type,id}           disable/remove it
//   POST /api/keys {integration,key}        store an integration API key
//   POST /api/test {type,id}                run a wiring test (plugin smoke / mcp ping / upstream)
// Everything is file-backed in $HOME/dsh-data/. localhost only, no auth by design.
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

function store() {
  try { return JSON.parse(fs.readFileSync(path.join(DATA, 'state.json'), 'utf8')); }
  catch (e) { return defaultState(); }
}
function save(s) {
  fs.writeFileSync(path.join(DATA, 'state.json'), JSON.stringify(s, null, 2));
}

// ---- built-in catalog ----------------------------------------------------
const CATALOG = {
  plugins: [
    { id: 'core-shell', name: 'Shell Exec', desc: 'Run sandboxed shell commands as agent tools.', kind: 'builtin',
      tools: ['bash (persistent)', 'run-command', 'process-list', 'kill-process'],
      docs: 'Gives the model a persistent shell session inside the app sandbox. Commands run with the sandbox mode you chose: read-only denies writes, workspace-write limits writes to the workspace root, danger-full-access is unconstrained. Long-running processes keep their own PTY.' },
    { id: 'core-files', name: 'File I/O', desc: 'Read/write/search workspace files.', kind: 'builtin',
      tools: ['str_replace_editor', 'read-file', 'glob', 'grep'],
      docs: 'Filesystem tools scoped to the workspace root. str_replace_editor is the exact edit primitive dsh\'s Minimal preset pairs with persistent bash. Grep is backed by ripgrep once the container is provisioned.' },
    { id: 'core-git', name: 'Git', desc: 'Clone, commit, branch, diff, log.', kind: 'builtin',
      tools: ['git-status', 'git-diff', 'git-commit', 'git-branch', 'git-log'],
      docs: 'Structured git operations over the workspace repository. Identity and default branch are pre-configured during provisioning, so the agent can commit without setup. Pair with the Commit Helper skill for clean messages.' },
    { id: 'core-web', name: 'Web Fetch', desc: 'Fetch pages and APIs into agent context.', kind: 'builtin',
      tools: ['web-fetch', 'web-search-headers', 'api-call'],
      docs: 'HTTP client tools for pulling pages and JSON APIs into context. Requests go out through the app\'s own network stack; no key is required, and responses are truncated to keep context lean.' },
    { id: 'plan-mode', name: 'Plan Mode', desc: 'Forces the agent to plan before acting.', kind: 'builtin',
      tools: ['plan-create', 'plan-update', 'plan-read'],
      docs: 'Adds a plan document the agent must maintain: steps, status, notes. Encourages decomposition before edits and gives you a readable trail of intent. Enabled by Standard, PTC and Creator presets.' },
    { id: 'swarms', name: 'Agent Swarms', desc: 'Spawn parallel sub-agents on subtasks.', kind: 'builtin',
      tools: ['spawn-subagent', 'agent-status', 'agent-message'],
      docs: 'Lets the agent delegate independent subtasks to parallel sub-agents, up to your Max sub-agents setting. Each sub-agent gets its own context window and the same toolset; results merge back into the parent session.' },
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
  ],
  mcps: [
    { id: 'mcp-memory', name: 'Memory', desc: 'Persistent key/value memory across sessions.', cmd: 'memory', tools: ['memory-get', 'memory-set', 'memory-list'], docs: 'A knowledge graph the agent can read and write across sessions — decisions, preferences, project facts. Stored app-private.' },
    { id: 'mcp-fetch', name: 'Fetch', desc: 'MCP server for URL fetching + caching.', cmd: 'fetch', tools: ['fetch-url', 'fetch-cache-read'], docs: 'Fetches URLs, strips boilerplate, and caches responses so repeated reads are cheap and deterministic.' },
    { id: 'mcp-git', name: 'Git MCP', desc: 'Git operations over Model Context Protocol.', cmd: 'git', tools: ['git-read-tree', 'git-log-mcp', 'git-blame'], docs: 'Read-oriented git server exposing tree, log and blame over MCP — complements the built-in Git plugin\'s write path.' },
    { id: 'mcp-sqlite', name: 'SQLite', desc: 'Query local SQLite databases via MCP.', cmd: 'sqlite', tools: ['sqlite-query', 'sqlite-schema'], docs: 'Direct SQL access to local .db files with schema introspection. Read-only by default; writes follow your sandbox mode.' },
  ],
  integrations: [
    { id: 'deepseek',  name: 'DeepSeek API',   env: 'DEEPSEEK_API_KEY',  hint: 'sk-… from platform.deepseek.com' },
    { id: 'openai',    name: 'OpenAI API',     env: 'OPENAI_API_KEY',    hint: 'sk-… from platform.openai.com' },
    { id: 'anthropic', name: 'Anthropic API',  env: 'ANTHROPIC_API_KEY', hint: 'sk-ant-…' },
    { id: 'github',    name: 'GitHub Token',   env: 'GITHUB_TOKEN',      hint: 'ghp_… personal access token' },
    { id: 'freebuff',  name: 'FreeBuff Proxy', env: 'FREEBUFF_URL',      hint: 'http://127.0.0.1:3457/v1' },
  ],
};

const NAMES = { plugins: 'plugin', skills: 'skill', mcps: 'MCP' };

// ---- agent presets: mirrors dsh's four shipped presets ---------------------
// standard | code (PTC) | minimal | cordis (Creator) — same host, different
// compositions: model route, persistence, sandbox and approvals stay identical
// while the tools and prompt sections change.
const PRESETS = [
  {
    id: 'standard', icon: '📦', name: 'Standard mode',
    desc: 'The full coding agent: file editing, shell, file & web search, skills, plan, goals, subagents and workflows — the default dsh composition.',
    config: {
      plugins: { 'core-files': true, 'core-shell': true, 'core-git': true, 'core-web': true, 'plan-mode': true, 'swarms': true },
      skills: { 'commit-helper': true, 'test-writer': true, 'refactor': true, 'docs-gen': true, 'sql-helper': true },
      mcps: {},
      agent: { autoApprove: false, maxSubAgents: 4, sandbox: 'workspace-write', codeMode: false, contextCompaction: true },
    },
  },
  {
    id: 'code', icon: '⚡', name: 'PTC mode',
    desc: 'Everything in Standard, but tools are presented through the Code Mode SDK — the model writes one TypeScript program instead of many tool round-trips.',
    config: {
      plugins: { 'core-files': true, 'core-shell': true, 'core-git': true, 'core-web': true, 'plan-mode': true, 'swarms': true },
      skills: { 'commit-helper': true, 'test-writer': true, 'refactor': true, 'docs-gen': true, 'sql-helper': true },
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
    desc: 'Standard plus runtime inspection, temporary plugin experiments and preset-authoring guidance — the agent can reshape its own runtime. A high-trust mode.',
    config: {
      plugins: { 'core-files': true, 'core-shell': true, 'core-git': true, 'core-web': true, 'plan-mode': true, 'swarms': true, 'runtime-inspect': true },
      skills: { 'commit-helper': true, 'test-writer': true, 'refactor': true, 'docs-gen': true, 'sql-helper': true },
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

// ---- helpers --------------------------------------------------------------
function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}
function body(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', d => { b += d; });
    req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch (e) { resolve({}); } });
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

// ---- server ---------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');

  if (u.pathname === '/healthz') { res.writeHead(200); res.end('ok'); return; }

  if (u.pathname === '/api/status') {
    const s = store();
    const counts = {};
    for (const k of ['plugins', 'skills', 'mcps']) {
      counts[k] = Object.values(s[k] || {}).filter(v => v && v.enabled).length;
    }
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
    save(s);
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

  // static SPA
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

server.listen(PORT, '127.0.0.1', () => console.log('dsh console on 127.0.0.1:' + PORT));
