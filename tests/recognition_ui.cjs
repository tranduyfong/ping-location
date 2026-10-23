/* Preview/ROI/direct-label/OCR-progress UI checks; OCR is a deterministic shim. */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const project = path.resolve(__dirname, '..');
const arg = name => { const index = process.argv.indexOf(name); return index < 0 ? null : process.argv[index + 1]; };
let playwright;
for (const candidate of [arg('--playwright-path') || process.env.PLAYWRIGHT_CORE_PATH, 'playwright-core', path.resolve(project, '../MapTagAutomation/MapTagAutomation/bin/Debug/net8.0-windows/.playwright/package')].filter(Boolean)) { try { playwright = require(candidate); break; } catch {} }
if (!playwright) throw new Error('Pass --playwright-path <installed Playwright Core package>.');
const executablePath = arg('--chrome-path') || process.env.CHROME_PATH || ['C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome', '/usr/bin/chromium'].find(file => fs.existsSync(file));
const server = http.createServer((request, response) => {
  const file = path.resolve(project, '.' + decodeURIComponent(new URL(request.url, 'http://localhost').pathname));
  const relative = path.relative(project, file);
  if (relative.startsWith('..') || path.isAbsolute(relative)) { response.writeHead(403); response.end(); return; }
  try { response.setHeader('Content-Type', ({ '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' })[path.extname(file)] || 'application/octet-stream'); response.end(fs.readFileSync(file)); }
  catch { response.writeHead(404); response.end(); }
});
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await playwright.chromium.launch({ executablePath, headless: true });
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
    const errors = [], messages = [];
    let pendingOcr = null, failPrepare = true, cancelled = false;
    page.on('pageerror', error => errors.push(error.message));
    await page.exposeFunction('__recognitionRpc', async message => {
      messages.push(message.type);
      if (message.type === 'prepare') return failPrepare ? { ok: false, error: 'Test: debugger connection unavailable' } : { ok: true, value: { attachedNow: false } };
      if (message.type === 'capture') return { ok: true, value: { image: `data:image/png;base64,${(await page.screenshot()).toString('base64')}` } };
      if (message.type === 'health') return { ok: true, value: { status: 'ok', ocrReady: true, loaded: true } };
      if (message.type === 'ocr') return new Promise(resolve => { pendingOcr = { resolve, body: message.body }; });
      if (message.type === 'cancelOcr') { cancelled = true; if (pendingOcr) { pendingOcr.resolve({ ok: false, error: 'Đã dừng quét OCR.' }); pendingOcr = null; } return { ok: true, value: { cancelled: true } }; }
      if (message.type === 'detach') return { ok: true, value: { detached: true } };
      return { ok: false, error: `Unexpected RPC ${message.type}` };
    });
    async function inject() {
      await page.evaluate(() => { window.__recognitionListeners = []; window.chrome = { runtime: { sendMessage: message => window.__recognitionRpc(message), onMessage: { addListener: listener => window.__recognitionListeners.push(listener) } }, storage: { local: { get: async () => ({}), set: async () => {} } } }; });
      for (const file of ['bridge.js', 'core.js', 'adapter.js', 'content.js']) await page.addScriptTag({ path: path.join(project, 'extension', file) });
    }
    async function waitOcr() {
      const deadline = Date.now() + 10000;
      while (!pendingOcr && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
      assert.ok(pendingOcr, 'OCR request should be pending');
    }
    async function progress(message, completed, total) { await page.evaluate(({ message, completed, total }) => window.__recognitionListeners.forEach(listener => listener({ channel: 'PingLocation', type: 'ocrProgress', state: 'running', progress: { stage: 'recognition', message, completed, total } })), { message, completed, total }); }
    await page.goto(`http://127.0.0.1:${server.address().port}/demo/index.html`);
    await page.evaluate(() => document.querySelector('[data-ping-panel]').remove());
    await inject();
    await page.locator('#ping-location-root #capturePreviewButton').click();
    await page.waitForFunction(() => !PingLocationApp.state.busy && document.querySelector('#ping-location-root').shadowRoot.querySelector('#capturePreview img')?.naturalWidth > 0);
    const preview = await page.evaluate(() => { const image = document.querySelector('#ping-location-root').shadowRoot.querySelector('#capturePreview img'); return { width: image.naturalWidth, height: image.naturalHeight, rows: PingLocationApp.state.info.rows.length, controlReady: PingLocationApp.state.controlReady }; });
    assert.deepEqual(preview, { width: 1226, height: 916, rows: 0, controlReady: false });
    assert.match(await page.locator('#ping-location-root #status').textContent(), /Chụp màn hình thành công/);
    failPrepare = false;
    await page.locator('#ping-location-root #region').click();
    await page.locator('#ping-location-root .region-picker').waitFor();
    await page.mouse.move(430, 250); await page.mouse.down(); await page.mouse.move(1000, 750, { steps: 8 }); await page.mouse.up();
    await page.waitForFunction(() => !PingLocationApp.state.busy && PingLocationApp.state.region?.width === 570);
    assert.deepEqual(await page.evaluate(() => PingLocationApp.state.region), { x: 430, y: 250, width: 570, height: 500 });
    assert.deepEqual(await page.evaluate(() => { const image = document.querySelector('#ping-location-root').shadowRoot.querySelector('#capturePreview img'); return { width: image.naturalWidth, height: image.naturalHeight }; }), { width: 570, height: 500 });
    await page.locator('#ping-location-root #scan').click();
    await waitOcr();
    assert.ok(!('angles' in pendingOcr.body), 'automatic mode lets service choose orientation');
    await progress('Đang đọc ô 2 trên 4', 2, 4);
    assert.match(await page.locator('#ping-location-root #status').textContent(), /Đang đọc ô 2 trên 4.*2\/4/);
    const firstJob = pendingOcr; pendingOcr = null;
    firstJob.resolve({ ok: true, value: { detections: [{ code: 'VX-02', x: 280, y: 250, confidence: .97 }], warnings: [] } });
    await page.waitForFunction(() => !PingLocationApp.state.busy && !PingLocationApp.state.scanning && PingLocationApp.state.detections.length === 1);
    assert.deepEqual(await page.evaluate(() => PingLocationApp.state.detections.map(({ code, x, y, source }) => ({ code, x, y, source }))), [{ code: 'VX-02', x: 710, y: 500, source: 'ocr' }]);
    assert.equal(await page.locator('#ping-location-root .marker').count(), 1);
    await page.locator('#ping-location-root #scan').click();
    await waitOcr();
    await progress('Đang nạp mô hình thử nghiệm', 0, 2);
    await page.locator('#ping-location-root #stop').click();
    await page.waitForFunction(() => !PingLocationApp.state.busy && !PingLocationApp.state.scanning);
    assert.equal(cancelled, true);
    assert.equal(await page.evaluate(() => PingLocationApp.state.detections.length), 1, 'cancel does not apply a new result');
    assert.equal(messages.filter(type => type === 'ocr').length, 2);
    console.log('PASS recognition UI: screen preview without manager/control, manual ROI drag/crop, OCR progress, local-to-screen coordinates, markers and cancellation.');

    await page.goto(`http://127.0.0.1:${server.address().port}/demo/index.html`);
    await page.evaluate(() => document.querySelector('[data-ping-panel]').remove());
    await inject();
    await page.locator('#ping-location-root #codePrefixes').fill('VT39');
    await page.locator('#ping-location-root #scan').click();
    await waitOcr();
    assert.equal(pendingOcr.body.profile, 'balanced');
    const prefixJob = pendingOcr; pendingOcr = null;
    prefixJob.resolve({ ok: true, value: { detections: [
      { code: 'VI39-11', x: 280, y: 250, confidence: .99 },
      { code: 'YT39-17', x: 380, y: 350, confidence: .99 }
    ], warnings: [] } });
    await page.waitForFunction(() => !PingLocationApp.state.busy && PingLocationApp.state.detections.length === 2);
    assert.deepEqual(await page.evaluate(() => PingLocationApp.state.detections.map(d => [d.code, d.originalCode, d.requiresReview])),
      [['VT39-11', 'VI39-11', true], ['VT39-17', 'YT39-17', true]]);
    assert.equal(await page.locator('#ping-location-root .marker.review').count(), 2);
    assert.match(await page.locator('#ping-location-root #recognized').textContent(), /VT39-11.*VI39-11/);
    assert.match(await page.locator('#ping-location-root #status').textContent(), /2 cần duyệt/);
    console.log('PASS recognition UI: VI/YT prefix suggestions retain raw readings and render two review markers.');

    const ocrCount = messages.filter(type => type === 'ocr').length, healthCount = messages.filter(type => type === 'health').length;
    await page.goto(`http://127.0.0.1:${server.address().port}/demo/index.html`);
    await page.setContent('<svg data-ping-map width="900" height="700" style="position:absolute;left:400px;top:100px"><rect width="900" height="700" fill="#e9e3cc"/><text x="100" y="150" font-size="24">VX-02</text><text x="400" y="350" transform="rotate(30 400 350)" font-size="24">VN48-123</text></svg>');
    await inject();
    await page.locator('#ping-location-root #scan').click();
    await page.waitForFunction(() => !PingLocationApp.state.busy && PingLocationApp.state.detections.length === 2);
    assert.deepEqual(await page.evaluate(() => PingLocationApp.state.detections.map(item => item.code).sort()), ['VN48-123', 'VX-02']);
    assert.ok(await page.evaluate(() => PingLocationApp.state.detections.every(item => item.source === 'dom')));
    assert.equal(await page.locator('#ping-location-root .marker').count(), 2);
    assert.equal(messages.filter(type => type === 'ocr').length, ocrCount, 'SVG labels bypass OCR');
    assert.equal(messages.filter(type => type === 'health').length, healthCount, 'SVG labels do not require service readiness');
    assert.match(await page.locator('#ping-location-root #status').textContent(), /Đã đọc trực tiếp 2 mã/);
    assert.deepEqual(errors, []);
    console.log('PASS recognition UI: actual rotated SVG text is read directly with two map markers, no manager and no OCR service calls.');
  } finally { if (browser) await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
