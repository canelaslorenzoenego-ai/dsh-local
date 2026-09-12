// Smoke test for the two embedded servers (dsh-web.js on 3080, proxy.js on 8787/8788).
// Boots both as child processes against a throwaway HOME, exercises every API
// endpoint (including the session-token gate), prints a pass/fail summary, exits.
// Run: node apk/test/smoke.cjs
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ASSETS = path.join(__dirname, '..', 'assets');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-smoke-'));
fs.mkdirSync(path.join(HOME, 'web', 'dsh'), { recursive: true });
// Run server copies from the temp HOME: the project package.json declares
// "type": "module", which would break these CommonJS assets if spawned in-tree.
fs.copyFileSync(path.join(ASSETS, 'dsh-web.js'), path.join(HOME, 'dsh-web.js'));
fs.copyFileSync(path.join(ASSETS, 'proxy.js'), path.join(HOME, 'proxy.js'));
fs.copyFileSync(path.join(ASSETS, 'web', 'dsh', 'index.html'), path.join(HOME, 'web', 'dsh', 'index.html'));
fs.copyFileSync(path.join(ASSETS, 'web', 'terminal.html'), path.join(HOME, 'web', 'terminal.html'));
fs.copyFileSync(path.join(ASSETS, 'web', 'xterm.js'), path.join(HOME, 'web', 'xterm.js'));
fs.copyFileSync(path.join(ASSETS, 'web', 'xterm.css'), path.join(HOME, 'web', 'xterm.css'));

const results = [];
function record(name, ok, extra) {
  results.push({ name, ok, extra: extra || '' });
  console.log((ok ? '  ✓ ' : '  ✗ ') + name + (extra ? '  — ' + extra : ''));
}

// Session token acquired from /api/session; injected into every request once set.
let SESS = null;
function req(method, urlPath, body, port, headers) {
  return new Promise((resolve, reject) => {
    let p = urlPath;
    if (SESS && p.indexOf('token=') === -1) {
      p += (p.indexOf('?') >= 0 ? '&' : '?') + 'token=' + encodeURIComponent(SESS);
    }
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({
      host: '127.0.0.1', port: port || 3080, path: p, method,
      headers: Object.assign(
        data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {},
        headers || {}),
    }, res => {
      let b = '';
      res.on('data', d => { b += d; });
      res.on('end', () => resolve({ code: res.statusCode, body: b }));
    });
    r.on('error', reject);
    r.setTimeout(3000, () => { r.destroy(); reject(new Error('timeout')); });
    if (data) r.write(data);
    r.end();
  });
}
async function until(fn, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await new Promise(r2 => setTimeout(r2, 150));
  }
  return false;
}

(async () => {
  const env = Object.assign({}, process.env, { HOME, PREFIX: path.join(HOME, 'usr') });
  const procs = [];
  try {
    procs.push(spawn('node', [path.join(HOME, 'dsh-web.js')], { env, stdio: 'ignore' }));
    procs.push(spawn('node', [path.join(HOME, 'proxy.js')], { env, stdio: 'ignore' }));

    // ---- wait for both ports ----
    const up3080 = await until(async () => { try { return (await req('GET', '/healthz')).code === 200; } catch (e) { return false; } }, 8000);
    const up8787 = await until(async () => { try { return (await req('GET', '/healthz', null, 8787)).code === 200; } catch (e) { return false; } }, 8000);
    record('dsh-web boots + /healthz', up3080);
    record('gateway boots + /healthz', up8787);
    if (!up3080) throw new Error('dsh-web did not boot');

    // ---- session auth: the real dsh tokenized-link model ----
    let r = await req('GET', '/api/session');
    const sess = JSON.parse(r.body);
    record('session: protected + token + tokenized link', r.code === 200 && sess.protected === true
      && typeof sess.token === 'string' && sess.token.length >= 20 && sess.link.indexOf('token=') !== -1, sess.link);
    r = await req('GET', '/api/status');
    record('api without token: 401', r.code === 401);
    r = await req('GET', '/api/status?token=' + encodeURIComponent(sess.token));
    record('api with ?token=: 200', r.code === 200);
    r = await req('GET', '/api/status', null, 3080, { Authorization: 'Bearer ' + sess.token });
    record('api with Bearer header: 200', r.code === 200);
    r = await req('GET', '/api/status', null, 3080, { 'x-dsh-token': sess.token });
    record('api with x-dsh-token header: 200', r.code === 200);
    r = await req('POST', '/api/session/exchange', { token: 'wrong-token' });
    record('exchange wrong token: 403', r.code === 403);
    r = await req('POST', '/api/session/exchange', { token: sess.token });
    record('exchange correct token: ok + link', r.code === 200 && JSON.parse(r.body).ok === true && !!JSON.parse(r.body).link);
    r = await req('POST', '/api/session/rotate', {});
    record('rotate without token: 401', r.code === 401);
    r = await req('POST', '/api/session/rotate?token=' + encodeURIComponent(sess.token), {});
    const rot = JSON.parse(r.body);
    record('rotate with token: fresh token issued', r.code === 200 && rot.ok === true && rot.token !== sess.token, 'rotations=' + rot.rotations);
    r = await req('GET', '/api/status?token=' + encodeURIComponent(sess.token));
    record('old token dead after rotate: 401', r.code === 401);
    r = await req('GET', '/api/status?token=' + encodeURIComponent(rot.token));
    record('new token accepted: 200', r.code === 200);
    SESS = rot.token; // from here on, req() authenticates itself

    // ---- dsh-web API surface ----
    r = await req('GET', '/api/status');
    const st = JSON.parse(r.body);
    record('status: server fields + session meta', r.code === 200 && typeof st.harness === 'boolean' && typeof st.gateway === 'boolean' && typeof st.preset === 'string' && typeof st.tools === 'number' && !!st.provision && !!st.session, 'preset=' + st.preset + ' tools=' + st.tools);
    record('status: agent defaults', !!st.agent && st.agent.maxSubAgents >= 1 && !!st.agent.sandbox, JSON.stringify(st.agent || {}).slice(0, 80));

    r = await req('GET', '/api/presets');
    const pr = JSON.parse(r.body);
    const ids = pr.presets.map(p => p.id);
    record('presets: dsh four + profiles list', r.code === 200 && JSON.stringify(ids) === JSON.stringify(['standard', 'code', 'minimal', 'cordis']), ids.join(','));
    record('presets: tool counts + sandbox on each', pr.presets.every(p => p.tools > 0 && !!p.sandbox && typeof p.codeMode === 'boolean'), pr.presets.map(p => p.id + ':' + p.tools).join(' '));
    record('presets: profiles array exposed', Array.isArray(pr.profiles) && !!pr.agent);

    r = await req('GET', '/api/catalog');
    const cat = JSON.parse(r.body);
    record('catalog: expanded 13/9/8/8', r.code === 200 && cat.plugins.length === 13 && cat.skills.length === 9 && cat.mcps.length === 8 && cat.integrations.length === 8, cat.plugins.length + '/' + cat.skills.length + '/' + cat.mcps.length + '/' + cat.integrations.length);
    record('catalog: docs + subtools enriched', cat.plugins.every(p => p.docs && p.tools && p.tools.length) && cat.mcps.every(m => m.docs && m.tools));
    record('catalog: new dsh-faithful tools present',
      !!cat.plugins.find(p => p.id === 'sessions') && !!cat.plugins.find(p => p.id === 'trajectory')
      && !!cat.plugins.find(p => p.id === 'model-router') && !!cat.mcps.find(m => m.id === 'mcp-github')
      && !!cat.skills.find(s => s.id === 'code-reviewer') && !!cat.integrations.find(i => i.id === 'openrouter'));

    r = await req('GET', '/api/tool?type=plugins&id=core-shell');
    const t1 = JSON.parse(r.body);
    record('tool info: shell exec detail', r.code === 200 && t1.item.name === 'Shell Exec' && Array.isArray(t1.inPresets) && t1.inPresets.includes('standard') && !!t1.item.docs);
    r = await req('GET', '/api/tool?type=mcps&id=mcp-time');
    const t2 = JSON.parse(r.body);
    record('tool info: new mcp detail + custom-only', r.code === 200 && t2.item.cmd === 'time' && t2.inPresets.length === 0);
    r = await req('GET', '/api/tool?type=nope&id=x');
    record('tool info: 404 unknown', r.code === 404);

    // ---- preset apply swaps state atomically (new tool counts) ----
    r = await req('POST', '/api/presets/apply', { id: 'minimal' });
    record('apply minimal', r.code === 200 && JSON.parse(r.body).tools === 2);
    r = await req('GET', '/api/installed');
    let inst = JSON.parse(r.body);
    record('minimal state: exactly 2 tools enabled', Object.keys(inst.plugins).length === 2 && Object.keys(inst.skills).length === 0 && Object.keys(inst.mcps).length === 0 && inst.plugins['core-shell'].enabled && inst.plugins['core-files'].enabled);
    r = await req('GET', '/api/status');
    record('status reflects minimal', JSON.parse(r.body).preset === 'minimal');

    r = await req('POST', '/api/presets/apply', { id: 'cordis' });
    record('apply cordis (creator): 22 tools', r.code === 200 && JSON.parse(r.body).tools === 22);
    r = await req('GET', '/api/status');
    const stc = JSON.parse(r.body);
    record('cordis: autoApprove + runtimeInspect', stc.autoApprove === true && stc.agent.maxSubAgents === 8);

    r = await req('POST', '/api/presets/apply', { id: 'standard' });
    record('apply standard: 19 tools', r.code === 200 && JSON.parse(r.body).tools === 19);

    // ---- custom studio path ----
    r = await req('GET', '/api/presets/load?id=current');
    const cur = JSON.parse(r.body);
    record('load current: full toolset + agent', r.code === 200 && Object.keys(cur.tools.plugins).length === 10 && !!cur.agent.sandbox);
    r = await req('GET', '/api/presets/load?id=minimal');
    record('load preset id: minimal shape', JSON.parse(r.body).agent.contextCompaction === false);
    r = await req('GET', '/api/presets/load?id=ghost');
    record('load unknown: 404', r.code === 404);

    const customBody = {
      tools: { plugins: { 'core-files': true, 'core-git': true }, skills: { 'test-writer': true }, mcps: {} },
      agent: { autoApprove: false, maxSubAgents: 6, sandbox: 'read-only', codeMode: true, model: 'gateway', systemPrompt: 'be terse' },
      name: 'my-agent',
    };
    r = await req('POST', '/api/presets/custom', customBody);
    record('custom: apply with profile save', r.code === 200 && JSON.parse(r.body).tools === 3);
    r = await req('GET', '/api/installed');
    inst = JSON.parse(r.body);
    record('custom: exactly the chosen tools live', Object.keys(inst.plugins).length === 2 && inst.skills['test-writer'] && !inst.plugins['core-shell'] && inst.preset === 'custom');
    r = await req('GET', '/api/presets');
    const pr2 = JSON.parse(r.body);
    record('custom: profile persisted with meta', pr2.profiles.length === 1 && pr2.profiles[0].name === 'my-agent' && pr2.profiles[0].tools === 3 && pr2.profiles[0].sandbox === 'read-only', JSON.stringify(pr2.profiles[0] || {}));
    r = await req('POST', '/api/presets/custom', { tools: { plugins: { 'evil-id': true, 'core-web': true }, skills: {}, mcps: {} }, agent: { sandbox: 'hacker-mode' } });
    r = await req('GET', '/api/installed');
    inst = JSON.parse(r.body);
    record('custom: invalid tool ids rejected', !inst.plugins['evil-id'] && inst.plugins['core-web'] && Object.keys(inst.plugins).length === 1);
    r = await req('GET', '/api/status');
    record('custom: unknown sandbox preserves previous (read-only from my-agent)', JSON.parse(r.body).agent.sandbox === 'read-only');

    r = await req('POST', '/api/presets/profile/apply', { name: 'my-agent' });
    record('profile apply', r.code === 200 && JSON.parse(r.body).tools === 3);
    r = await req('GET', '/api/installed');
    record('profile apply restores toolset', Object.keys(JSON.parse(r.body).plugins).length === 2);
    r = await req('POST', '/api/presets/profile/apply', { name: 'nope' });
    record('profile apply unknown: 404', r.code === 404);
    r = await req('POST', '/api/presets/profile/delete', { name: 'my-agent' });
    r = await req('GET', '/api/presets');
    record('profile delete', JSON.parse(r.body).profiles.length === 0);

    // ---- toggles / keys / test ----
    r = await req('POST', '/api/presets/toggle', { type: 'mcps', id: 'mcp-memory' });
    record('toggle on -> preset custom', r.code === 200 && JSON.parse(r.body).enabled === true);
    r = await req('POST', '/api/keys', { integration: 'openai', key: 'sk-test-123456' });
    record('key store', r.code === 200);
    r = await req('GET', '/api/installed');
    record('key stored masked (no plaintext)', JSON.parse(r.body).keys.openai && JSON.stringify(JSON.parse(r.body)).indexOf('sk-test-123456') === -1);
    r = await req('POST', '/api/test', { type: 'integration', id: 'openai' });
    record('test integration: stored key recognized', JSON.parse(r.body).ok === true);
    r = await req('POST', '/api/test', { type: 'integration', id: 'anthropic' });
    record('test integration: missing key flagged', JSON.parse(r.body).ok === false);
    r = await req('POST', '/api/test', { type: 'mcp', id: 'mcp-memory' });
    record('test mcp: enabled -> ok', JSON.parse(r.body).ok === true);
    r = await req('POST', '/api/test', { type: 'plugins', id: 'core-shell' });
    record('test plugin: gateway reachable', JSON.parse(r.body).ok === true);

    // ---- gateway endpoints ----
    r = await req('GET', '/v1/models', null, 8787);
    const models = JSON.parse(r.body);
    record('gateway /v1/models', r.code === 200 && models.object === 'list' && models.data.length >= 1);
    r = await req('POST', '/v1/chat/completions', { model: 'local-harness', messages: [{ role: 'user', content: 'ping' }] }, 8787);
    const chat = JSON.parse(r.body);
    record('gateway chat (echo mode)', r.code === 200 && chat.object === 'chat.completion' && chat.choices[0].message.content.indexOf('ping') !== -1);
    r = await req('POST', '/v1/chat/completions', { model: 'm', messages: [{ role: 'user', content: 'hi' }], stream: true }, 8787);
    record('gateway streaming SSE', r.code === 200 && r.body.indexOf('data: [DONE]') !== -1);

    // ---- terminal session gate (shared token with dsh-web) ----
    r = await req('GET', '/stream?seq=0', null, 8788);
    record('terminal /stream with token: 200', r.code === 200 && r.body.indexOf('seq') !== -1);
    r = await req('GET', '/stream?seq=0&token=wrong', null, 8788);
    record('terminal /stream wrong token: 401', r.code === 401);
    r = await req('GET', '/?token=INVALID', null, 8788);
    record('terminal page without valid token: locked page', r.code === 401 && r.body.indexOf('locked') !== -1);
    r = await req('GET', '/?token=' + encodeURIComponent(SESS), null, 8788);
    record('terminal page with token: served', r.code === 200 && r.body.indexOf('Terminal') !== -1);
    r = await req('GET', '/web/xterm.js?token=' + encodeURIComponent(SESS), null, 8788);
    record('terminal assets served with token', r.code === 200);

    // ---- chat playground ----
    r = await req('GET', '/api/chats');
    record('chats: empty list initially', r.code === 200 && JSON.parse(r.body).chats.length === 0);
    r = await req('POST', '/api/chat', { message: 'ping from smoke' });
    const chat1 = JSON.parse(r.body);
    record('chat: creates conversation via gateway', r.code === 200 && chat1.chat.messages.length === 2
      && chat1.reply.indexOf('ping from smoke') !== -1, 'replies=' + chat1.chat.messages.length);
    r = await req('POST', '/api/chat', { chatId: chat1.chat.id, message: 'second turn' });
    const chat2 = JSON.parse(r.body);
    record('chat: history accumulates in thread', r.code === 200 && chat2.chat.messages.length === 4
      && chat2.chat.id === chat1.chat.id);
    r = await req('GET', '/api/chats');
    const chatList = JSON.parse(r.body).chats;
    record('chats: listed with count + title', r.code === 200 && chatList.length === 1
      && chatList[0].count === 4 && !!chatList[0].title);
    r = await req('POST', '/api/chats/get', { id: chat1.chat.id });
    record('chats: get by id', r.code === 200 && JSON.parse(r.body).messages.length === 4);
    r = await req('POST', '/api/chat', { message: '' });
    record('chat: empty message rejected', r.code === 400);
    r = await req('POST', '/api/chats/delete', { id: chat1.chat.id });
    r = await req('GET', '/api/chats');
    record('chats: delete works', r.code === 200 && JSON.parse(r.body).chats.length === 0);

    // ---- usage metering ----
    r = await req('GET', '/api/usage');
    const usage = JSON.parse(r.body);
    record('usage: chat calls metered by model', r.code === 200 && usage.total >= 2
      && usage.byModel['local-harness'] && usage.byModel['local-harness'].calls >= 2
      && usage.byModel['local-harness'].messages >= 4, 'total=' + usage.total);

    // ---- files manager ----
    r = await req('GET', '/api/files');
    const files0 = JSON.parse(r.body);
    record('files: workspace listing', r.code === 200 && Array.isArray(files0.entries) && !!files0.root, files0.root);
    r = await req('POST', '/api/files/write', { path: 'docs/hello.txt', content: 'hello from smoke' });
    record('files: write creates nested file', r.code === 200);
    r = await req('GET', '/api/files/read?path=docs/hello.txt');
    record('files: read back matches', r.code === 200 && JSON.parse(r.body).content === 'hello from smoke');
    r = await req('GET', '/api/files/read?path=../secrets.json');
    record('files: traversal refused', r.code === 404);
    r = await req('GET', '/api/files?dir=..');
    record('files: dir traversal refused', r.code === 404);
    r = await req('POST', '/api/files/write', { path: '../escape.txt', content: 'x' });
    record('files: write traversal refused', r.code === 403);
    r = await req('POST', '/api/files/delete', { path: 'docs/hello.txt' });
    r = await req('GET', '/api/files/read?path=docs/hello.txt');
    record('files: delete works', r.code === 404);

    // ---- events / activity ----
    r = await req('GET', '/api/events');
    const ev0 = JSON.parse(r.body);
    record('events: boot + chat + file events logged', r.code === 200 && ev0.events.length >= 2
      && ev0.events.some(e => e.type === 'boot') && ev0.events.some(e => e.type === 'chat'),
      ev0.events.map(e => e.type).join(','));
    r = await req('GET', '/api/events');
    const before = JSON.parse(r.body).events.length;
    // ack first: it also resets the per-boot event dedup so a re-apply logs fresh
    await req('POST', '/api/events/ack', {});
    await req('POST', '/api/presets/apply', { id: 'minimal' });
    r = await req('GET', '/api/events');
    const ev1 = JSON.parse(r.body);
    record('events: preset apply is logged', r.code === 200 && ev1.events.length >= 1
      && ev1.events[0].type === 'preset', ev1.events.map(e => e.type).join(','));
    r = await req('POST', '/api/events/ack', {});
    r = await req('GET', '/api/events');
    record('events: ack clears', r.code === 200 && JSON.parse(r.body).events.length === 0);

    // ---- secrets vault ----
    r = await req('POST', '/api/keys', { integration: 'deepseek', key: 'sk-vault-test' });
    r = await req('GET', '/api/secrets');
    const sec = JSON.parse(r.body);
    record('secrets: id listed, plaintext never returned', r.code === 200 && sec.ids.includes('deepseek')
      && r.body.indexOf('sk-vault-test') === -1, sec.file);

    // ---- SPA serving ----
    r = await req('GET', '/');
    record('console SPA served', r.code === 200 && r.body.indexOf('DSH Console') !== -1);
    r = await req('GET', '/../../etc/passwd');
    record('path traversal blocked', r.code === 404);

    // ---- adversarial hardening suite ----
    // 1) request-body cap: a giant chat payload must 413, not OOM the server
    const big = 'x'.repeat(3 * 1024 * 1024);
    r = await req('POST', '/api/chat', { message: big });
    record('hardening: 3 MB body rejected with 413', r.code === 413, 'code=' + r.code);
    r = await req('GET', '/healthz');
    record('hardening: server alive after oversized body', r.code === 200);

    // 2) symlink escape: link inside the workspace pointing outside must not be followable
    const wsRoot = path.join(HOME, 'workspace');
    try { fs.symlinkSync(HOME, path.join(wsRoot, 'out')); } catch (e) {}
    r = await req('GET', '/api/files/read?path=out/dsh-data/session.json');
    record('hardening: symlink escape refused', r.code === 404, 'code=' + r.code);
    r = await req('GET', '/api/files?dir=out');
    record('hardening: symlink dir escape refused', r.code === 404, 'code=' + r.code);
    r = await req('POST', '/api/files/delete', { path: 'out/dsh-data/session.json' });
    record('hardening: symlink delete escape refused', r.code === 403, 'code=' + r.code);
    try { fs.unlinkSync(path.join(wsRoot, 'out')); } catch (e) {}

    // 3) oversized file read refused (4 MB cap) instead of stringing the editor
    const bigPath = path.join(wsRoot, 'big.bin');
    fs.writeFileSync(bigPath, Buffer.alloc(5 * 1024 * 1024, 65));
    r = await req('GET', '/api/files/read?path=big.bin');
    record('hardening: >4 MB file read refused', r.code === 404, 'code=' + r.code);
    fs.unlinkSync(bigPath);

    // 4) chat history hard cap: flood a chat, then confirm only 500 messages persist
    r = await req('POST', '/api/chats', { title: 'cap test' });
    const capChat = JSON.parse(r.body);
    for (let i = 0; i < 260; i++) {
      r = await req('POST', '/api/chat', { chatId: capChat.id, message: 'm' + i });
    }
    const capData = JSON.parse(fs.readFileSync(path.join(HOME, 'dsh-data', 'chats', capChat.id + '.json'), 'utf8'));
    record('hardening: chat history capped at 500 messages', capData.messages.length === 500, 'len=' + capData.messages.length);
    await req('POST', '/api/chats/delete', { id: capChat.id });

    // 5) malformed JSON body must degrade to {} (400 on required fields), not a crash
    await new Promise((resolve) => {
      const rq = http.request({ host: '127.0.0.1', port: 3080, path: '/api/chat?token=' + encodeURIComponent(SESS), method: 'POST',
        headers: { 'Content-Type': 'application/json' } }, res => {
        let b = ''; res.on('data', d => { b += d; }); res.on('end', () => {
          record('hardening: malformed JSON body handled', res.statusCode === 400, 'code=' + res.statusCode);
          resolve();
        });
      });
      rq.on('error', () => { record('hardening: malformed JSON body handled', false, 'conn error'); resolve(); });
      rq.end('{not json');
    });

    // 6) gateway apiKeys: when gateway.json requires a key, the chat relay must present it
    fs.writeFileSync(path.join(HOME, 'gateway.json'), JSON.stringify({ apiKeys: ['smoke-key-1'] }));
    r = await req('POST', '/api/chat', { message: 'authed?' });
    // Echo reply through an authed gateway = the relay presented a valid bearer
    // key (a missing key would have drawn a 401, surfacing as a non-echo reply).
    const chatAuthed = JSON.parse(r.body);
    record('hardening: chat relay sends bearer key when gateway requires it',
      chatAuthed.reply && chatAuthed.reply.indexOf('echo mode') !== -1,
      'reply=' + String(chatAuthed.reply || '').slice(0, 50).replace(/\n/g, ' '));
    // and a wrong key must NOT get through the gateway itself
    const rq6 = await new Promise((resolve) => {
      const rq = http.request({ host: '127.0.0.1', port: 8787, path: '/v1/chat/completions', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer wrong-key' } }, resolve);
      rq.on('error', () => resolve({ statusCode: 0 }));
      rq.end(JSON.stringify({ model: 'x', messages: [] }));
    });
    record('hardening: gateway rejects wrong bearer key', rq6.statusCode === 401, 'code=' + rq6.statusCode);
    fs.unlinkSync(path.join(HOME, 'gateway.json'));

    // 7) terminal: locked (token-less) request gets 401, not the shell
    await new Promise((resolve) => {
      const rq = http.request({ host: '127.0.0.1', port: 8788, path: '/stream', method: 'GET' }, res => {
        res.resume(); res.on('end', () => {
          record('hardening: terminal fails closed without token', res.statusCode === 401, 'code=' + res.statusCode);
          resolve();
        });
      });
      rq.on('error', () => { record('hardening: terminal fails closed without token', false, 'conn error'); resolve(); });
      rq.end();
    });

    // ---- state persistence across restart ----
    procs[0].kill();
    await until(async () => { try { await req('GET', '/healthz'); return false; } catch (e) { return true; } }, 4000);
    procs[0] = spawn('node', [path.join(HOME, 'dsh-web.js')], { env, stdio: 'ignore' });
    await until(async () => { try { return (await req('GET', '/healthz')).code === 200; } catch (e) { return false; } }, 8000);
    r = await req('GET', '/api/status');
    const stAfter = JSON.parse(r.body);
    record('state persists across restart', stAfter.preset === 'minimal' && stAfter.integrations === 2, 'preset=' + stAfter.preset + ' integrations=' + stAfter.integrations);
    r = await req('GET', '/api/session');
    const sessAfter = JSON.parse(r.body);
    record('session token survives restart', sessAfter.token === SESS, 'rotations=' + sessAfter.rotations);
  } catch (e) {
    record('SMOKE RUN ABORTED', false, e.message);
  } finally {
    procs.forEach(p => { try { p.kill(); } catch (e) {} });
  }

  const pass = results.filter(r2 => r2.ok).length;
  console.log('\n' + pass + '/' + results.length + ' passed' + (pass === results.length ? ' — ALL GREEN' : ''));
  fs.rmSync(HOME, { recursive: true, force: true });
  process.exit(pass === results.length ? 0 : 1);
})();
