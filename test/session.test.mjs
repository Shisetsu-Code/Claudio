import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('session progress is observable before finish and survives restart', async () => {
  const { SessionStore } = await import('../lib/session.mjs');
  const dir = await mkdtemp(join(tmpdir(), 'claudio-session-'));
  let time = 1000;
  try {
    const store = new SessionStore({ dataDir: dir, now: () => time });
    store.start('https://example.org/demo');
    store.beginBatch(10);
    time = 2500;
    store.spin({ i: 1, ms: 1500, changed: 0.1, dLum: 0 });
    assert.equal(store.snapshot().current.batch.completed, 1);
    assert.equal(store.snapshot().current.batch.remaining, 9);
    assert.equal(store.snapshot().current.elapsedMs, 1500);
    store.finding({ title: 'Bonus encontrado', detail: 'Observado por Claude', category: 'bonus' });
    store.finishBatch('time_budget');
    assert.equal(store.snapshot().current.status, 'ready');
    store.beginBatch(2);
    store.spin({ i: 1, ms: 200, changed: 0.2, dLum: 0, anomalia: ['cambio_escena'] });
    store.finishBatch('anomalia');
    assert.equal(store.snapshot().current.totalSpins, 2);
    assert.equal(store.snapshot().current.anomalies, 1);
    time = 3000;
    store.close();
    time = 9000;
    assert.equal(store.snapshot().current.elapsedMs, 2000);
    const restored = new SessionStore({ dataDir: dir });
    assert.equal(restored.snapshot().history[0].findings[0].title, 'Bonus encontrado');
    store.start('https://example.org/another');
    assert.equal(store.snapshot().current.totalSpins, 0);
    assert.equal(store.snapshot().history.length, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('dashboard streams progress, rejects foreign origins and uses a free port', async () => {
  const { SessionStore } = await import('../lib/session.mjs');
  const { startDashboard } = await import('../lib/dashboard.mjs');
  const dir = await mkdtemp(join(tmpdir(), 'claudio-http-'));
  const store = new SessionStore({ dataDir: dir });
  const dashboard = await startDashboard({ store, port: 0 });
  try {
    store.start('https://example.org/');
    const res = await fetch(dashboard.url + '/api/state');
    assert.equal(res.status, 200);
    assert.equal((await res.json()).current.totalSpins, 0);
    assert.equal((await fetch(dashboard.url + '/api/state', { headers: { Origin: 'https://evil.example' } })).status, 403);
    assert.equal((await fetch(dashboard.url + '/api/state', { method: 'POST' })).status, 405);
    const signal = AbortSignal.timeout(5000);
    const events = await fetch(dashboard.url + '/events', { signal });
    const reader = events.body.getReader();
    await reader.read();
    store.beginBatch(3);
    store.spin({ i: 1, ms: 100 });
    let data = '';
    while (!data.includes('"completed":1')) {
      const chunk = await reader.read();
      assert.equal(chunk.done, false);
      data += new TextDecoder().decode(chunk.value);
    }
    assert.match(data, /"completed":1/);
    await reader.cancel();
    const html = await (await fetch(dashboard.url)).text();
    assert.match(html, /Claudio/);
    const occupied = await startDashboard({ store, port: Number(new URL(dashboard.url).port) });
    assert.notEqual(occupied.url, dashboard.url);
    await occupied.close();
  } finally { store.flush(); await dashboard.close(); await rm(dir, { recursive: true, force: true }); }
});

test('closing during a batch is terminal and distinguishes attempts from observed spins', async () => {
  const { SessionStore } = await import('../lib/session.mjs');
  const dir = await mkdtemp(join(tmpdir(), 'claudio-terminal-'));
  try {
    const store = new SessionStore({ dataDir: dir });
    store.start('https://example.org/'); store.beginBatch(3);
    store.attempt(); store.spin({ ms: 100, moved: false, anomalia: ['sin_reaccion'] });
    assert.equal(store.snapshot().current.totalAttempts, 1);
    assert.equal(store.snapshot().current.totalSpins, 0);
    store.attempt();
    store.close('interrupted');
    store.finishBatch('completed');
    store.error(new Error('late browser disconnect'));
    const current = store.snapshot().current;
    assert.equal(current.status, 'interrupted');
    assert.equal(current.batch.status, 'interrupted');
    assert.equal(current.unconfirmedSpins, 1);
    assert.equal(current.inFlight, false);
    store.start('https://example.org/resume'); store.beginBatch(2);
    store.attempt(); store.finishBatch('cancelled');
    assert.equal(store.snapshot().current.inFlight, true);
    store.resolvePending({ moved: true, ms: 1200 });
    assert.equal(store.snapshot().current.totalSpins, 1);
    assert.equal(store.snapshot().current.totalAttempts, 1);
    assert.equal(store.snapshot().current.batch.completed, 1);
    store.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('restart recovers an interrupted in-flight session as terminal history', async () => {
  const { SessionStore } = await import('../lib/session.mjs');
  const dir = await mkdtemp(join(tmpdir(), 'claudio-recover-'));
  try {
    const store = new SessionStore({ dataDir: dir });
    store.start('https://example.org/'); store.beginBatch(5); store.attempt(); store.flush();
    const recovered = new SessionStore({ dataDir: dir }).snapshot().history[0];
    assert.equal(recovered.status, 'interrupted');
    assert.equal(recovered.batch.status, 'interrupted');
    assert.equal(recovered.inFlight, false);
    assert.equal(recovered.unconfirmedSpins, 1);
    assert.ok(recovered.endedAt);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
