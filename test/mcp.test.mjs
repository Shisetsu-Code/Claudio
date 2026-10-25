import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { chromium } from 'playwright';

const fixture = `<!doctype html><title>Demo de pruebas</title><style>body{margin:0}canvas{display:block;width:100vw;height:100vh}</style><canvas id="game" width="1280" height="720"></canvas><script>
const ctx=document.querySelector('canvas').getContext('2d');let start=0;
function draw(){const t=performance.now()-start;ctx.fillStyle=start&&t<1200?(Math.floor(t/100)%2?'#deecb3':'#d29d72'):'#2a4136';ctx.fillRect(0,0,1280,720);requestAnimationFrame(draw)}
document.addEventListener('keydown',e=>{if(e.code==='Space')start=performance.now()});draw();</script>`;

test('stdio MCP exposes live dashboard, speed, findings, progress, stop and frozen session', { timeout: 45000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'claudio-e2e-'));
  const continuous = fixture.replace('requestAnimationFrame(draw)', `if(start){for(let y=0;y<720;y+=20)for(let x=0;x<1280;x+=20){const v=Math.sin(x*12.9898+y*78.233+Math.floor(t/50)*37.719)*43758.5453;ctx.fillStyle=v-Math.floor(v)>0.5?'#ffffff':'#000000';ctx.fillRect(x,y,20,20)}}requestAnimationFrame(draw)`);
  const game = http.createServer((req, res) => res.end(req.url === '/continuous' ? continuous : fixture));
  await new Promise(resolve => game.listen(0, '127.0.0.1', resolve));
  const client = new Client({ name: 'claudio-e2e', version: '1.0' });
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [fileURLToPath(new URL('../server.mjs', import.meta.url))],
    env: { ...process.env, CLAUDIO_DATA_DIR: dir, CLAUDIO_DASHBOARD_PORT: '0' }, stderr: 'pipe' });
  let stderr = ''; transport.stderr.on('data', chunk => { stderr += chunk; });
  let browser;
  const call = (name, args = {}) => client.callTool({ name, arguments: args });
  const json = result => JSON.parse(result.content.find(c => c.type === 'text').text);
  try {
    await client.connect(transport);
    const names = (await client.listTools()).tools.map(t => t.name);
    for (const name of ['launch_game', 'spin_loop', 'set_speed', 'record_finding', 'get_status', 'get_dashboard', 'stop_loop']) assert.ok(names.includes(name), name);
    const dashboard = json(await call('get_dashboard'));
    assert.match(dashboard.url, /^http:\/\/127\.0\.0\.1:/);
    const launched = await call('launch_game', { url: `http://127.0.0.1:${game.address().port}`, headless: true, wait_ms: 0, auto_click_texts: [] });
    assert.ok(!launched.isError, JSON.stringify(launched.content[0]));
    const speed = json(await call('set_speed', { rate: 4, fast_mode: true }));
    assert.equal(speed.rate, 4);
    assert.equal(json(await call('get_status')).current.speed, 4);
    const discovery = await call('record_finding', { title: 'Fixture observada', detail: '<img src=x onerror=alert(1)>', category: 'mechanic' });
    assert.equal(discovery.isError, undefined);
    const state = async () => (await fetch(dashboard.url + '/api/state')).json();
    const badAction = await call('act', { actions: [{ type: 'click', point: 'missing' }] });
    assert.equal(badAction.isError, true);
    assert.equal((await state()).current.status, 'error');
    assert.match((await state()).current.lastError, /missing/);
    let done = false;
    const running = call('spin_loop', { count: 5, max_seconds: 10, scene_threshold: 1, lum_threshold: 255 }).then(r => { done = true; return r; });
    let live;
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      live = await state();
      if (live.current.batch?.completed >= 1 && !done) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.equal(done, false, 'dashboard must show intermediate progress');
    assert.ok(live.current.batch.completed >= 1);
    const blocked = await call('act', { actions: [{ type: 'key', key: 'Space' }] });
    assert.equal(blocked.isError, true, 'concurrent browser actions must be rejected');
    await call('stop_loop');
    const summary = json(await running);
    assert.equal(summary.status, 'cancelled');
    assert.ok(summary.tiradas_hechas >= 1 && summary.tiradas_hechas < 5);
    assert.equal((await state()).current.batch.status, 'cancelled');
    const invalidAction = await call('spin_loop', { count: 1, action: { type: 'wait', ms: 999999 } });
    assert.equal(invalidAction.isError, true, 'a batch action must be a click or key, never an unbounded wait');
    const noMotion = json(await call('spin_loop', { count: 1, action: { type: 'key', key: 'Escape' }, start_timeout_ms: 200, spin_timeout_ms: 1000 }));
    assert.equal(noMotion.status, 'anomalia');
    assert.deepEqual(noMotion.anomalias[0].reasons, ['sin_reaccion']);
    const budgetStart = Date.now();
    const budget = json(await call('spin_loop', { count: 10, max_seconds: 5, start_timeout_ms: 45000, action: { type: 'key', key: 'Escape' } }));
    assert.equal(budget.status, 'time_budget');
    assert.ok(Date.now() - budgetStart < 8000, 'waitMotion must respect the batch budget');
    assert.equal((await state()).current.batch.status, 'time_budget');
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1050 } });
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.goto(dashboard.url);
    await page.getByText('Fixture observada', { exact: true }).first().waitFor();
    assert.equal(await page.locator('.findings img').count(), 0);
    assert.deepEqual(errors, []);
    await page.screenshot({ path: join(dir, 'dashboard.png'), fullPage: true });
    await call('close_game');
    const closed = await state();
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal((await state()).current.elapsedMs, closed.current.elapsedMs);
    assert.equal(closed.current.findings[0].title, 'Fixture observada');
    assert.equal(closed.current.status, 'closed');
    assert.ok(!stderr.includes('Unhandled'), stderr);
    await call('launch_game', { url: `http://127.0.0.1:${game.address().port}/continuous`, headless: true, wait_ms: 0, auto_click_texts: [] });
    const stableBudgetStart = Date.now();
    const unstable = json(await call('spin_loop', { count: 1, max_seconds: 5, start_timeout_ms: 2000, spin_timeout_ms: 45000 }));
    assert.equal(unstable.status, 'time_budget');
    assert.ok(Date.now() - stableBudgetStart < 8000, 'waitStable must respect the batch budget');
    const badLaunch = await call('launch_game', { url: 'http://127.0.0.1:1', headless: true, wait_ms: 0, auto_click_texts: [] });
    assert.equal(badLaunch.isError, true);
    assert.equal((await state()).current.status, 'error');
    assert.ok((await state()).current.endedAt);
  } finally {
    await browser?.close(); await client.close();
    await new Promise(resolve => game.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});
