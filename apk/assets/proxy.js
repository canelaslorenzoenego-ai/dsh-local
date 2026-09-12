// proxy.js — two servers in one process:
//   :8787  OpenAI-compatible gateway (/v1/models, /v1/chat/completions, /healthz)
//   :8788  terminal server (serves terminal page + shell I/O for the Terminal tab)
//
// Gateway modes (config file $HOME/gateway.json):
//   { "upstream": "https://api.example.com/v1/chat/completions", "upstreamKey": "sk-..." }
//     -> relays requests to any OpenAI-compatible backend
//   { "apiKeys": ["my-key"] }                    -> require that bearer key
//   { "models": ["id1","id2"] }                  -> advertised model list
//   no upstream                                  -> local echo mode (wiring tests)
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const GATE_PORT = 8787;
const TERM_PORT = 8788;
const HOME = process.env.HOME || '/data/data/com.dshlocal.app/files/home';
const WEB = path.join(HOME, 'web');
const CONFIG = path.join(HOME, 'gateway.json');

// ---- session auth (shared with dsh-web.js: $HOME/dsh-data/session.json) ----
// FAIL-CLOSED: if the harness hasn't minted a session yet, the proxy mints one
// itself (same file, same shape) — the terminal is never token-less.
const SESSION_FILE = path.join(HOME, 'dsh-data', 'session.json');
function sessionToken() {
  try { return JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8')).token; }
  catch (e) {
    try {
      fs.mkdirSync(path.dirname(SESSION_FILE), { recursive: true });
      const tok = crypto.randomBytes(24).toString('base64url');
      fs.writeFileSync(SESSION_FILE, JSON.stringify(
        { token: tok, created: Date.now(), rotations: 0, mintedBy: 'proxy' }, null, 2));
      try { fs.chmodSync(SESSION_FILE, 0o600); } catch (e2) {}
      return tok;
    } catch (e2) { return null; }
  }
}
function tokenOk(req, u) {
  const tok = sessionToken();
  if (!tok) return false; // fail closed
  const auth = req.headers['authorization'] || '';
  if (auth.replace(/^Bearer\s+/i, '') === tok) return true;
  if ((req.headers['x-dsh-token'] || '') === tok) return true;
  return u.searchParams.get('token') === tok;
}
const LOCKED_PAGE = '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
  + '<style>body{background:#0B0E14;color:#E8EDF7;font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;text-align:center;padding:24px}'
  + 'div{max-width:420px}h2{font-size:18px;margin:0 0 8px}p{color:#8B96AC;font-size:13px;line-height:1.6}'
  + 'code{color:#8FA6FF;background:#1A2130;border:1px solid #263043;border-radius:8px;padding:2px 8px;font-size:12px}</style></head><body>'
  + '<div><h2>🔒 Terminal locked</h2>'
  + '<p>This terminal is protected by the DSH session token.</p>'
  + '<p>Open it through the console link on the dashboard, or add <code>?token=…</code> to the URL.</p></div>'
  + '</body></html>';

function loadCfg() {
  try { return JSON.parse(fs.readFileSync(CONFIG, 'utf8')); } catch (e) { return {}; }
}

// ---------------------------------------------------------------- terminal (8788)
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
let shell = null;
let seq = 0;
const RING = [];

function write(data) {
  seq++;
  RING.push({ seq: seq, data: data });
  while (RING.length > 4000) RING.shift();
}

function ringSince(s) {
  let d = '';
  for (let i = 0; i < RING.length; i++) if (RING[i].seq > s) d += RING[i].data;
  return { seq: seq, data: d };
}

function startShell() {
  const pref = process.env.PREFIX;
  // prefer bash as a login shell (profile, aliases, workspace cwd) when provisioned
  const bashBin = pref + '/bin/bash';
  const shBin = fs.existsSync(bashBin) ? bashBin : pref + '/bin/sh';
  const scriptBin = pref + '/bin/script';
  const useScript = fs.existsSync(scriptBin); // util-linux script => real pty
  const cmd = useScript
    ? [scriptBin, '-qfc', shBin + ' -l', '/dev/null']
    : [shBin, '-i'];
  shell = spawn(cmd[0], cmd.slice(1), {
    env: Object.assign({}, process.env, { TERM: 'xterm-256color' }),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  shell.stdout.on('data', d => write(d.toString('utf8')));
  shell.stderr.on('data', d => write(d.toString('utf8')));
  shell.on('error', e => { write('\r\n\x1b[31m[shell error: ' + e.message + ']\x1b[0m\r\n'); shell = null; });
  shell.on('exit', () => { write('\r\n\x1b[2m[shell exited — restart proxy for a new one]\x1b[0m\r\n'); shell = null; });
}

const termServer = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  // session gate: every terminal route requires the shared token
  if (!tokenOk(req, u)) {
    if (u.pathname === '/' || u.pathname === '/terminal.html') {
      res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(LOCKED_PAGE);
    } else {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized — open the terminal via the session link' }));
    }
    return;
  }
  if (u.pathname === '/input' && req.method === 'POST') {
    let b = '';
    req.on('data', d => { b += d; });
    req.on('end', () => {
      if (shell && shell.stdin && shell.stdin.writable) shell.stdin.write(b);
      res.writeHead(204); res.end();
    });
    return;
  }
  if (u.pathname === '/stream') {
    const since = parseInt(u.searchParams.get('seq') || '0', 10) || 0;
    const out = ringSince(since);
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(out));
    return;
  }
  // URLs are /web/<file>; serve from WEB root with the /web/ prefix stripped.
  const f = u.pathname === '/' ? 'terminal.html'
    : u.pathname.replace(/\.\./g, '').replace(/^\/+/, '').replace(/^web\//, '');
  fs.readFile(path.join(WEB, f), (e, d) => {
    if (e) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'text/plain' });
    res.end(d);
  });
});

termServer.listen(TERM_PORT, '127.0.0.1', () => {
  console.log('terminal server on 127.0.0.1:' + TERM_PORT);
  startShell();
});

// ---------------------------------------------------------------- gateway (8787)
const gate = http.createServer((req, res) => {
  const cfg = loadCfg();
  const gu = new URL(req.url, 'http://x');
  const gpath = gu.pathname;

  if (gpath === '/healthz') { res.writeHead(200); res.end('ok'); return; }

  if (gpath === '/v1/models' && req.method === 'GET') {
    const ids = (cfg.models && cfg.models.length) ? cfg.models : ['local-harness'];
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ object: 'list', data: ids.map(id => ({ id: id, object: 'model', owned_by: 'dsh-local' })) }));
    return;
  }

  if (req.method === 'POST' && gpath.indexOf('/v1/chat/completions') === 0) {
    const auth = req.headers['authorization'] || '';
    const key = auth.replace(/^Bearer\s+/i, '');
    const keys = cfg.apiKeys || [];
    if (keys.length && keys.indexOf(key) === -1) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'invalid api key' } }));
      return;
    }
    let body = '';
    let over = false;
    req.on('data', d => {
      if (over) return;
      body += d;
      if (body.length > 10 * 1024 * 1024) { over = true; body = ''; } // 10 MB cap
    });
    req.on('end', () => {
      if (over) {
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'request body too large' } }));
        return;
      }
      let j = {};
      try { j = JSON.parse(body); } catch (e) {}
      if (cfg.upstream) return relay(cfg, j, res);
      return localReply(j, res);
    });
    return;
  }

  res.writeHead(404); res.end();
});

function relay(cfg, j, res) {
  let u;
  try { u = new URL(cfg.upstream); } catch (e) {
    res.writeHead(500); res.end(JSON.stringify({ error: { message: 'bad upstream url' } })); return;
  }
  const lib = u.protocol === 'https:' ? https : http;
  const r2 = lib.request({
    hostname: u.hostname,
    port: u.port || (u.protocol === 'https:' ? 443 : 80),
    path: u.pathname + (u.search || ''),
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + (cfg.upstreamKey || ''),
      'Accept': j.stream ? 'text/event-stream' : 'application/json',
    },
  }, up => {
    res.writeHead(up.statusCode, up.headers);
    up.pipe(res);
  });
  r2.on('error', e => {
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'upstream failed: ' + e.message } }));
  });
  r2.end(JSON.stringify(j));
}

function localReply(j, res) {
  const id = 'chatcmpl-' + crypto.randomBytes(6).toString('hex');
  const created = Math.floor(Date.now() / 1000);
  const model = j.model || 'local-harness';
  const msgs = j.messages || [];
  const last = msgs.length ? msgs[msgs.length - 1] : {};
  const content = typeof last.content === 'string' ? last.content : JSON.stringify(last.content || '');
  const text = '[dsh-local gateway · echo mode]\n\nReceived: ' + content.slice(0, 400) +
    '\n\nSet "upstream" in gateway.json to relay to a real OpenAI-compatible backend.';
  if (j.stream) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const chunk = (c) => 'data: ' + JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: c, finish_reason: null }] }) + '\n\n';
    res.write(chunk({ role: 'assistant' }));
    res.write(chunk({ content: text }));
    res.write(chunk({}));
    res.write('data: ' + JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + '\n\n');
    res.write('data: [DONE]\n\n');
    res.end();
  } else {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      id, object: 'chat.completion', created, model,
      choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    }));
  }
}

gate.listen(GATE_PORT, '127.0.0.1', () => console.log('gateway on 127.0.0.1:' + GATE_PORT));
