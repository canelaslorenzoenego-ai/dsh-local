// Smoke test for the two embedded servers (dsh-web.js on 3080, proxy.js on 8787/8788).
// Boots both as child processes against a throwaway HOME, exercises every API
// endpoint, prints a pass/fail summary, and exits. Run: node apk/test/smoke.js
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
function req(method, urlPath, body, port) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({
      host: '127.0.0.1', port: port || 3080, path: urlPath, method,
      headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {},
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

    // ---- dsh-web API surface ----
    let r = await req('GET', '/api/status');
    const st = JSON.parse(r.body);
    record('status: server fields', r.code === 200 && typeof st.harness === 'boolean' && typeof st.gateway === 'boolean' && typeof st.preset === 'string' && typeof st.tools === 'number' && !!st.provision, 'preset=' + st.preset + ' tools=' + st.tools);
    record('status: agent defaults', !!st.agent && st.agent.maxSubAgents >= 1 && !!st.agent.sandbox, JSON.stringify(st.agent || {}).slice(0, 80));

    r = await req('GET', '/api/presets');
    const pr = JSON.parse(r.body);
    const ids = pr.presets.map(p => p.id);
    record('presets: dsh four + profiles list', r.code === 200 && JSON.stringify(ids) === JSON.stringify(['standard', 'code', 'minimal', 'cordis']), ids.join(','));
    record('presets: tool counts + sandbox on each', pr.presets.every(p => p.tools > 0 && !!p.sandbox && typeof p.codeMode === 'boolean'), pr.presets.map(p => p.id + ':' + p.tools).join(' '));
    record('presets: profiles array exposed', Array.isArray(pr.profiles) && !!pr.agent);

    r = await req('GET', '/api/catalog');
    const cat = JSON.parse(r.body);
    record('catalog: 4 types populated', r.code === 200 && cat.plugins.length === 7 && cat.skills.length === 5 && cat.mcps.length === 4 && cat.integrations.length === 5);
    record('catalog: docs + subtools enriched', cat.plugins.every(p => p.docs && p.tools && p.tools.length) && cat.mcps.every(m => m.docs && m.tools));

    r = await req('GET', '/api/tool?type=plugins&id=core-shell');
    const t1 = JSON.parse(r.body);
    record('tool info: shell exec detail', r.code === 200 && t1.item.name === 'Shell Exec' && Array.isArray(t1.inPresets) && t1.inPresets.includes('standard') && !!t1.item.docs);
    r = await req('GET', '/api/tool?type=mcps&id=mcp-sqlite');
    const t2 = JSON.parse(r.body);
    record('tool info: sqlite detail + custom-only when absent', r.code === 200 && t2.item.cmd === 'sqlite' && t2.inPresets.length === 0);
    r = await req('GET', '/api/tool?type=nope&id=x');
    record('tool info: 404 unknown', r.code === 404);

    // ---- preset apply swaps state atomically ----
    r = await req('POST', '/api/presets/apply', { id: 'minimal' });
    record('apply minimal', r.code === 200 && JSON.parse(r.body).tools === 2);
    r = await req('GET', '/api/installed');
    let inst = JSON.parse(r.body);
    record('minimal state: exactly 2 tools enabled', Object.keys(inst.plugins).length === 2 && Object.keys(inst.skills).length === 0 && Object.keys(inst.mcps).length === 0 && inst.plugins['core-shell'].enabled && inst.plugins['core-files'].enabled);
    r = await req('GET', '/api/status');
    record('status reflects minimal', JSON.parse(r.body).preset === 'minimal');

    r = await req('POST', '/api/presets/apply', { id: 'cordis' });
    record('apply cordis (creator)', r.code === 200 && JSON.parse(r.body).tools === 12);
    r = await req('GET', '/api/status');
    const stc = JSON.parse(r.body);
    record('cordis: autoApprove + runtimeInspect', stc.autoApprove === true && stc.agent.maxSubAgents === 8);

    // ---- custom studio path ----
    r = await req('GET', '/api/presets/load?id=current');
    const cur = JSON.parse(r.body);
    record('load current: full toolset + agent', r.code === 200 && Object.keys(cur.tools.plugins).length === 7 && !!cur.agent.sandbox);
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
    r = await req('POST', '/api/keys', { integration: 'deepseek', key: 'sk-test-123456' });
    record('key store', r.code === 200);
    r = await req('GET', '/api/installed');
    record('key stored masked (no plaintext)', JSON.parse(r.body).keys.deepseek && JSON.stringify(JSON.parse(r.body)).indexOf('sk-test-123456') === -1);
    r = await req('POST', '/api/test', { type: 'integration', id: 'deepseek' });
    record('test integration: stored key recognized', JSON.parse(r.body).ok === true);
    r = await req('POST', '/api/test', { type: 'integration', id: 'openai' });
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

    // ---- SPA serving ----
    r = await req('GET', '/');
    record('console SPA served', r.code === 200 && r.body.indexOf('DSH Console') !== -1);
    r = await req('GET', '/web/xterm.js', null, 8788);
    record('terminal assets served', r.code === 200 && r.body.indexOf('Terminal') !== -1);
    r = await req('GET', '/../../etc/passwd');
    record('path traversal blocked', r.code === 404);

    // ---- state persistence across restart ----
    procs[0].kill();
    await until(async () => { try { await req('GET', '/healthz'); return false; } catch (e) { return true; } }, 4000);
    procs[0] = spawn('node', [path.join(HOME, 'dsh-web.js')], { env, stdio: 'ignore' });
    await until(async () => { try { return (await req('GET', '/healthz')).code === 200; } catch (e) { return false; } }, 8000);
    r = await req('GET', '/api/status');
    const stAfter = JSON.parse(r.body);
    record('state persists across server restart', stAfter.preset === 'custom' && stAfter.integrations === 1, 'preset=' + stAfter.preset + ' integrations=' + stAfter.integrations);
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
