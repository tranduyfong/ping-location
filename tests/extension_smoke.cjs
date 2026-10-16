/* Optional actual MV3/background/debugger smoke test in a disposable profile. */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const project = path.resolve(__dirname, '..');
const arg = name => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : null; };
const packagePath = arg('--playwright-path') || process.env.PLAYWRIGHT_CORE_PATH || path.resolve(project, '../MapTagAutomation/MapTagAutomation/bin/Debug/net8.0-windows/.playwright/package');
const { chromium } = require(packagePath);
const localChromium = process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'ms-playwright/chromium-1243/chrome-win64/chrome.exe');
const executablePath = arg('--chrome-path') || process.env.CHROME_PATH || (localChromium && fs.existsSync(localChromium) ? localChromium : undefined);
const server = http.createServer((request, response) => {
  const file = path.resolve(project, '.' + decodeURIComponent(new URL(request.url, 'http://localhost').pathname));
  const relative = path.relative(project, file);
  if (request.method !== 'GET' || relative.startsWith('..') || path.isAbsolute(relative)) { response.writeHead(403); response.end(); return; }
  try { response.setHeader('Content-Type', ({ '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' })[path.extname(file)] || 'application/octet-stream'); response.end(fs.readFileSync(file)); }
  catch { response.writeHead(404); response.end(); }
});

(async () => {
  const tempRoot = path.resolve(os.tmpdir());
  const profile = fs.mkdtempSync(path.join(tempRoot, 'ping-location-extension-test-'));
  let context;
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const extension = path.join(project, 'extension');
    context = await chromium.launchPersistentContext(profile, {
      executablePath, headless: true, viewport: null,
      ignoreDefaultArgs: ['--disable-extensions'],
      args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--enable-unsafe-extension-debugging', '--window-size=1600,1100']
    });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 15000 });
    const id = new URL(worker.url()).hostname;
    assert.ok(id, 'unpacked extension worker loaded');
    // Keep sample points out of any running real OCR service. Capture, focus,
    // session tokens, activeTab and chrome.debugger remain the actual extension.
    await worker.evaluate(() => {
      const original = globalThis.fetch;
      globalThis.fetch = (input, options) => String(input).startsWith('http://127.0.0.1:8766/') ? Promise.resolve(new Response(JSON.stringify({ saved: true, status: 'ok' }), { status: 200, headers: { 'Content-Type': 'application/json' } })) : original(input, options);
      globalThis.__smokeCaptures = [];
      const capture = chrome.tabs.captureVisibleTab;
      chrome.tabs.captureVisibleTab = async (...args) => { const image = await capture(...args); globalThis.__smokeCaptures.push(image); return image; };
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/demo/index.html`);
    await page.bringToFront();
    const cdp = await context.newCDPSession(page);
    const { targetInfo } = await cdp.send('Target.getTargetInfo');
    const browserCdp = await context.browser().newBrowserCDPSession();
    const { targetInfos } = await browserCdp.send('Target.getTargets', { filter: [{ type: 'tab', exclude: false }, { exclude: true }] });
    const tabTarget = targetInfos.find(target => target.url === targetInfo.url);
    assert.ok(tabTarget, `Cannot resolve browser tab target: ${JSON.stringify(targetInfos)}`);
    await browserCdp.send('Extensions.triggerAction', { id, targetId: tabTarget.targetId });
    await page.locator('#ping-location-root').waitFor({ timeout: 15000 });
    const tabs = await worker.evaluate(() => chrome.tabs.query({ active: true, currentWindow: true }));
    const tabId = tabs.find(tab => tab.url?.includes('/demo/index.html'))?.id;
    assert.ok(tabId);
    async function state() {
      return worker.evaluate(async tabId => {
        const result = await chrome.scripting.executeScript({ target: { tabId }, func: () => {
          const current = window.PingLocationApp?.state;
          return current ? { busy: current.busy, running: current.running, codes: current.info?.rows.map(row => row.code) || [], detections: current.detections.map(point => point.code), ready: current.plan.filter(row => row.status === 'ready').length, log: current.log, status: document.querySelector('#ping-location-root').shadowRoot.getElementById('status').textContent } : null;
        } });
        return result[0].result;
      }, tabId);
    }
    async function until(predicate, timeout = 30000) {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) { const current = await state(); if (predicate(current)) return current; await new Promise(resolve => setTimeout(resolve, 100)); }
      throw new Error(`Timed out: ${JSON.stringify(await state())}`);
    }
    await page.locator('#ping-location-root #inspect').click();
    const initial = await until(current => current?.codes.length === 5 && !current.busy);
    const prompts = [];
    page.on('dialog', dialog => dialog.type() === 'prompt' && prompts.length ? dialog.accept(prompts.shift()) : dialog.dismiss());
    for (const code of initial.codes) {
      const point = await page.evaluate(code => __pingDemo.centers().find(point => point.code === code), code);
      prompts.push(code);
      await page.locator('#ping-location-root #mark').click();
      await page.waitForFunction(() => document.querySelector('#ping-location-root').style.visibility === 'hidden');
      await page.mouse.click(point.x, point.y);
      await until(current => current.detections.includes(code) && !current.busy);
    }
    assert.equal((await state()).ready, 5);
    await page.locator('#ping-location-root #run').click();
    const result = await until(current => !current.running && current.log.some(entry => ['success', 'error'].includes(entry.kind)), 60000);
    if (result.log.filter(entry => entry.kind === 'success').length !== 5) {
      const captures = await worker.evaluate(() => globalThis.__smokeCaptures);
      fs.mkdirSync(path.join(project, 'tmp'), { recursive: true });
      for (const [index, image] of captures.entries()) {
        const buffer = Buffer.from(image.split(',')[1], 'base64');
        console.log('capture', index, buffer.readUInt32BE(16), buffer.readUInt32BE(20));
        if (index >= captures.length - 3) fs.writeFileSync(path.join(project, `tmp/extension-capture-${index}.png`), buffer);
      }
    }
    assert.equal(result.log.filter(entry => entry.kind === 'success').length, 5, JSON.stringify(result));
    assert.equal(await page.evaluate(() => __pingDemo.pending()), 19);
    assert.deepEqual(errors, []);
    console.log('PASS actual MV3 extension: native action/activeTab, isolated content, captureVisibleTab, session tokens, debugger clicks, 5 verified assignments.');
  } finally {
    if (context) await context.close();
    await new Promise(resolve => server.close(resolve));
    const relative = path.relative(tempRoot, path.resolve(profile));
    if (!relative.startsWith('..') && !path.isAbsolute(relative) && path.basename(profile).startsWith('ping-location-extension-test-')) fs.rmSync(profile, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
