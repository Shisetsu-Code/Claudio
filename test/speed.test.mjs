import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

test('speed scales canvas clocks and timers, resets continuously and reaches new frames', async () => {
  const { prepareSpeed, setContextSpeed } = await import('../lib/speed.mjs');
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    await prepareSpeed(context, 1);
    const page = await context.newPage();
    await page.goto('data:text/html,<title>Speed test</title>');
    await setContextSpeed(context, 4);
    const measured = await page.evaluate(() => new Promise(resolve => {
      const before = performance.now(), dateBefore = Date.now();
      setTimeout(() => requestAnimationFrame(timestamp => resolve({
        perf: performance.now() - before, date: Date.now() - dateBefore, raf: timestamp - before,
      })), 800);
    }));
    assert.ok(measured.perf >= 780 && measured.perf < 1600, JSON.stringify(measured));
    assert.ok(Math.abs(measured.date - measured.perf) < 20);
    assert.ok(Math.abs(measured.raf - measured.perf) < 80);
    const realStart = performance.now();
    await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 1200)));
    const realMs = performance.now() - realStart;
    assert.ok(realMs < 750 && realMs > 150, `1200ms at 4x took ${realMs}ms`);
    const beforeReset = await page.evaluate(() => performance.now());
    await setContextSpeed(context, 1);
    const afterReset = await page.evaluate(() => performance.now());
    assert.ok(afterReset >= beforeReset && afterReset - beforeReset < 200);
    await page.setContent('<iframe srcdoc="<title>Frame</title>"></iframe>');
    await setContextSpeed(context, 4);
    await page.evaluate(() => { const iframe = document.createElement('iframe'); iframe.srcdoc = '<title>New frame</title>'; document.body.append(iframe); });
    await page.waitForFunction(() => document.querySelectorAll('iframe').length === 2);
    for (const frame of page.frames()) {
      await frame.waitForFunction(() => globalThis.__claudioClock?.rate === 4);
    }
    await page.reload();
    await page.waitForFunction(() => globalThis.__claudioClock?.rate === 4);
    await assert.rejects(() => setContextSpeed(context, 0), /1.*8/);
    await setContextSpeed(context, 1);
    const normalStart = performance.now();
    await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 250)));
    assert.ok(performance.now() - normalStart >= 220);
    await setContextSpeed(context, 4);
    await page.evaluate(() => { window.animation = document.body.animate([{ opacity: 0.3 }, { opacity: 1 }], { duration: 10000 }); });
    await new Promise(resolve => setTimeout(resolve, 150));
    const animationTime = await page.evaluate(() => window.animation.currentTime);
    assert.ok(animationTime >= 350 && animationTime < 1400, `Animation progressed ${animationTime}ms at 4x`);
  } finally { await browser.close(); }
});

test('changing speed reschedules pending timers and cancellation remains effective', async () => {
  const { prepareSpeed, setContextSpeed } = await import('../lib/speed.mjs');
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    await prepareSpeed(context, 1);
    const page = await context.newPage();
    await page.goto('data:text/html,<title>Timers</title>');
    await page.evaluate(() => {
      window.done = false; window.cancelledFired = false;
      const id = setInterval(() => { window.cancelledFired = true; }, 2000);
      clearTimeout(id);
      setTimeout(() => { window.done = true; }, 1600);
    });
    await setContextSpeed(context, 4);
    await page.waitForFunction(() => window.done, null, { timeout: 1100 });
    assert.equal(await page.evaluate(() => window.cancelledFired), false);
  } finally { await browser.close(); }
});
