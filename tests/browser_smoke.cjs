/* Optional real-browser integration test. Uses an installed Playwright Core. */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const project = path.resolve(__dirname, '..');
const argument = name => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : null; };
const supplied = argument('--playwright-path') || process.env.PLAYWRIGHT_CORE_PATH;
let playwright;
for (const candidate of [supplied, 'playwright-core', 'playwright', path.resolve(project, '../MapTagAutomation/MapTagAutomation/bin/Debug/net8.0-windows/.playwright/package')].filter(Boolean)) {
  try { playwright = require(candidate); break; } catch (error) { if (supplied === candidate) throw error; }
}
if (!playwright) throw new Error('Install Playwright Core separately, or pass --playwright-path <installed package directory>. This test does not download dependencies.');
const chrome = argument('--chrome-path') || process.env.CHROME_PATH || [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
].find(candidate => fs.existsSync(candidate));
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
const server = http.createServer((req, res) => {
  const file = path.resolve(project, '.' + decodeURIComponent(new URL(req.url, 'http://localhost').pathname));
  const relative = path.relative(project, file);
  if (req.method !== 'GET' || relative.startsWith('..') || path.isAbsolute(relative)) { res.writeHead(403); res.end(); return; }
  try { const content = fs.readFileSync(file); res.writeHead(200, { 'Content-Type': mime[path.extname(file)] || 'application/octet-stream' }); res.end(content); }
  catch { res.writeHead(404); res.end(); }
});

(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await playwright.chromium.launch({ executablePath: chrome, headless: true });
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
    const browserErrors = [];
    page.on('pageerror', error => browserErrors.push(error.message));
    const url = `http://127.0.0.1:${server.address().port}/demo/index.html`;
    async function openAdapter() {
      await page.goto(url);
      await page.addScriptTag({ path: path.join(project, 'extension/bridge.js') });
      await page.addScriptTag({ path: path.join(project, 'extension/adapter.js') });
    }
    await openAdapter();
    const before = await page.evaluate(() => PingAdapter.inspect());
    assert.equal(before.rows.length, 5);
    assert.equal(before.pendingCount, 24);
    assert.deepEqual(before.diagnostics, []);
    // Real-page fallback has no special data attributes. Its footer supplies the
    // filtered pending total; no generic toast is accepted as success.
    await page.evaluate(() => { document.querySelectorAll('[data-ping-panel],[data-ping-row],[data-ping-code],[data-ping-attach]').forEach(element => { for (const key of ['data-ping-panel', 'data-ping-row', 'data-ping-code', 'data-ping-attach', 'data-code']) element.removeAttribute(key); }); document.querySelector('.hotspot-panel').removeAttribute('data-pending-total'); });
    const fallback = await page.evaluate(() => PingAdapter.inspect());
    assert.equal(fallback.rows.length, 5);
    assert.equal(fallback.pendingCount, 24);
    const fallbackCode = fallback.rows[0].code;
    await page.evaluate(code => PingAdapter.arm(code, { successSelector: '[data-no-success]' }), fallbackCode);
    const fallbackPoint = (await page.evaluate(() => __pingDemo.centers())).find(point => point.code === fallbackCode);
    await page.mouse.click(fallbackPoint.x, fallbackPoint.y);
    assert.equal((await page.evaluate(code => PingAdapter.verify(code, { successSelector: '[data-no-success]' }), fallbackCode)).confirmed, true);
    await openAdapter();
    const code = before.rows[0].code;
    // An old success signal for the same code must never confirm a new attempt.
    await page.evaluate(code => { const toast = document.querySelector('[data-ping-success]'); toast.hidden = false; toast.textContent = `Đã gắn thành công ${code}`; toast.dataset.code = code; toast.dataset.eventId = 'old'; }, code);
    await page.evaluate(code => PingAdapter.arm(code), code);
    assert.equal((await page.evaluate(code => PingAdapter.verify(code), code)).confirmed, false);
    let centers = await page.evaluate(() => __pingDemo.centers());
    const wrong = centers.find(point => point.code !== code);
    await page.mouse.click(wrong.x, wrong.y);
    assert.equal((await page.evaluate(code => PingAdapter.verify(code), code)).confirmed, false);
    await page.evaluate(code => { const toast = document.querySelector('#success-message'); toast.setAttribute('data-ping-success', ''); toast.dataset.code = code; toast.dataset.eventId = 'new-error'; toast.textContent = `Gắn thất bại ${code}`; }, code);
    assert.equal((await page.evaluate(code => PingAdapter.verify(code), code)).confirmed, false);
    const target = centers.find(point => point.code === code);
    await page.mouse.click(target.x, target.y);
    assert.equal((await page.evaluate(code => PingAdapter.verify(code), code)).confirmed, true);
    assert.equal(await page.evaluate(() => __pingDemo.pending()), 23);
    await page.locator('#assigned-tab').click();
    const placed = await page.evaluate(() => PingAdapter.inspect());
    assert.equal(placed.rows.length, 0);
    assert.ok(placed.diagnostics.some(message => message.includes('Đã gắn')));
    await page.locator('#pending-tab').click();
    await page.evaluate(() => { const row = document.querySelector('[data-ping-row]'); row.parentElement.append(row.cloneNode(true)); });
    assert.equal(await page.evaluate(async () => { try { await PingAdapter.arm(document.querySelector('[data-ping-row]').dataset.code); return false; } catch { return true; } }), true);
    await page.locator('#reset-demo').click();
    for (let pageIndex = 0; pageIndex < 4; pageIndex++) assert.equal((await page.evaluate(() => PingAdapter.nextPage())).advanced, true);
    assert.equal((await page.evaluate(() => PingAdapter.nextPage())).advanced, false, 'disabled last page cannot wrap');
    await page.locator('#reset-demo').click();
    await page.evaluate(() => { window.__pickedSelector = undefined; PingAdapter.pickSelector().then(selector => { window.__pickedSelector = selector; }); });
    await page.mouse.click(900, 400);
    await page.waitForFunction(() => typeof window.__pickedSelector === 'string');
    assert.equal(await page.evaluate(() => document.querySelector(window.__pickedSelector).id), 'demo-map');
    // Verify the read-only MAIN bridge uses local engine coordinates correctly.
    await page.evaluate(() => {
      const canvas = document.querySelector('#demo-map');
      window.krpano = { get: key => ({ 'view.hlookat': 12, 'xml.scene': 'demo', 'stagewidth': canvas.clientWidth, 'stageheight': canvas.clientHeight, 'hotspot.count': 0 })[key],
        getBoundingClientRect: () => canvas.getBoundingClientRect(), spheretoscreen: (ath, atv) => ({ x: ath * 10, y: atv * 10 }), screentosphere: (x, y) => ({ x: x / 10, y: y / 10 }) };
    });
    assert.equal((await page.evaluate(() => PingAdapter.getView())).hlookat, 12);
    assert.deepEqual(await page.evaluate(() => PingAdapter.project(12, 4)), { x: 120, y: 124, space: 'viewport-css' });
    assert.deepEqual(await page.evaluate(() => PingAdapter.unproject(120, 124)), { ath: 12, atv: 4 });
    // Actual VHUB creates lc_hs_* pins with title = productCode after saving.
    await page.evaluate(() => {
      window.__smokePins = [];
      window.krpano.get = key => {
        if (key === 'hotspot.count') return window.__smokePins.length;
        if (key === 'xml.scene') return 'demo';
        const match = key.match(/^hotspot\[(\d+)\]\.(name|title|ath|atv)$/);
        return match ? window.__smokePins[Number(match[1])]?.[match[2]] : null;
      };
    });
    const pinCode = (await page.evaluate(() => PingAdapter.inspect())).rows[0].code;
    await page.evaluate(code => PingAdapter.arm(code, { successSelector: '[data-no-success]' }), pinCode);
    const pinPoint = (await page.evaluate(() => __pingDemo.centers())).find(point => point.code === pinCode);
    await page.mouse.click(pinPoint.x, pinPoint.y);
    await page.evaluate(code => {
      document.querySelector('[data-ping-panel]').removeAttribute('data-pending-total');
      document.querySelector('#page-info').textContent = 'Không hiển thị tổng';
      window.__smokePins.push({ name: 'lc_hs_saved', title: code + '0', ath: 1, atv: 2 });
    }, pinCode);
    assert.equal((await page.evaluate(code => PingAdapter.verify(code, { successSelector: '[data-no-success]' }), pinCode)).confirmed, false, 'a pin with a partial code is insufficient');
    await page.evaluate(code => { window.__smokePins[0].title = code; }, pinCode);
    assert.equal((await page.evaluate(code => PingAdapter.verify(code, { successSelector: '[data-no-success]' }), pinCode)).confirmed, true, 'new exact-code application pin confirms the removed pending row');
    // Every synthetic plot center must actually be clickable, without overlaps.
    await openAdapter();
    centers = await page.evaluate(() => __pingDemo.centers());
    for (const point of centers) {
      await page.locator('#search-code').fill(point.code);
      await page.evaluate(code => PingAdapter.arm(code), point.code);
      await page.mouse.click(point.x, point.y);
      assert.equal((await page.evaluate(code => PingAdapter.verify(code), point.code)).confirmed, true, point.code);
    }
    assert.equal(await page.evaluate(() => __pingDemo.pending()), 0);
    async function finalRowFixture() {
      await page.evaluate(() => {
        document.body.innerHTML = '<div id="fixture-host"><aside id="final-panel" style="position:absolute;left:20px;top:20px;width:350px;height:350px"><header><h2>Quản lý hotspot</h2><span id="fixture-scene">scene_mb_quy_can</span></header><div id="final-row" style="display:flex;justify-content:space-between;height:70px;align-items:center"><span>VX-02</span><button>Gắn</button></div><p id="final-footer">Trang 1/1 · 1 căn</p></aside></div><canvas style="position:absolute;left:450px;top:20px;width:650px;height:500px"></canvas>';
      });
      await page.evaluate(() => PingAdapter.arm('VX-02', { successSelector: '[data-no-success]' }));
      await page.evaluate(() => { document.querySelector('#final-row').remove(); document.querySelector('#final-footer').textContent = 'Trang 1/1 · 0 căn'; });
    }
    await finalRowFixture();
    assert.equal((await page.evaluate(() => PingAdapter.verify('VX-02', { successSelector: '[data-no-success]' }))).confirmed, true, 'final pending row confirms without data selectors or remaining Gắn buttons');
    await finalRowFixture();
    await page.evaluate(() => { document.querySelector('#fixture-scene').textContent = 'another_scene'; });
    assert.equal((await page.evaluate(() => PingAdapter.verify('VX-02', { successSelector: '[data-no-success]' }))).confirmed, false, 'changed scene cannot reuse the original panel');
    await finalRowFixture();
    await page.evaluate(() => { document.body.append(document.querySelector('#final-panel')); });
    assert.equal((await page.evaluate(() => PingAdapter.verify('VX-02', { successSelector: '[data-no-success]' }))).confirmed, false, 'reparented panel cannot reuse the original proof');
    await finalRowFixture();
    await page.evaluate(() => { const original = document.querySelector('#final-panel'); original.replaceWith(original.cloneNode(true)); });
    assert.equal((await page.evaluate(() => PingAdapter.verify('VX-02', { successSelector: '[data-no-success]' }))).confirmed, false, 'replacement panel cannot reuse the original proof');
    console.log('PASS adapter: wrong clicks, stale/negative success, tab guard, duplicates, picker, read-only bridge, all 24 plots.');

    // Browser integration uses a Chrome API shim, while capture and clicks are real.
    const messages = [], feedback = [];
    let activeToken = null, wrongClick = false, prompts = [];
    await page.exposeFunction('__pingSmokeRpc', async message => {
      messages.push(message.type);
      try {
        let value;
        if (message.type === 'capture') value = { image: `data:image/png;base64,${(await page.screenshot()).toString('base64')}` };
        else if (message.type === 'prepare') value = { attachedNow: false };
        else if (message.type === 'begin') { activeToken = `smoke-${Date.now()}`; value = { runToken: activeToken }; }
        else if (message.type === 'click') {
          assert.ok(activeToken, 'click requires an active session'); assert.equal(message.runToken, activeToken, 'click requires the current token');
          if (wrongClick) {
            const candidate = await page.evaluate(({ x, y }) => __pingDemo.centers().find(point => Math.hypot(point.x - x, point.y - y) > 200), message);
            await page.mouse.click(candidate.x, candidate.y);
          } else await page.mouse.click(message.x, message.y);
          value = { clicked: true };
        } else if (message.type === 'detach') { activeToken = null; value = { detached: true }; }
        else if (message.type === 'feedback') { feedback.push(message.body); value = { saved: true }; }
        else if (message.type === 'health') value = { status: 'ok' };
        else throw new Error(`Unexpected RPC: ${message.type}`);
        return { ok: true, value };
      } catch (error) { return { ok: false, error: error.message }; }
    });
    page.on('dialog', dialog => { if (dialog.type() === 'prompt' && prompts.length) return dialog.accept(prompts.shift()); return dialog.dismiss(); });
    async function openApp() {
      await page.goto(url);
      await page.evaluate(() => { window.chrome = { runtime: { sendMessage: message => window.__pingSmokeRpc(message), onMessage: { addListener() {} } }, storage: { local: { get: async () => ({}), set: async () => {} } } }; });
      for (const file of ['bridge.js', 'core.js', 'adapter.js', 'content.js']) await page.addScriptTag({ path: path.join(project, 'extension', file) });
      await page.locator('#ping-location-root #inspect').click();
      await page.waitForFunction(() => window.PingLocationApp?.state.info?.rows.length === 5 && !PingLocationApp.state.busy);
      return page.evaluate(() => PingLocationApp.state.info.rows.map(row => row.code));
    }
    async function markCode(code) {
      prompts.push(code);
      const point = await page.evaluate(code => __pingDemo.centers().find(point => point.code === code), code);
      await page.locator('#ping-location-root #mark').click();
      await page.waitForFunction(() => document.querySelector('#ping-location-root').style.visibility === 'hidden');
      await page.mouse.click(point.x, point.y);
      await page.waitForFunction(code => PingLocationApp.state.detections.some(item => item.code === code) && !PingLocationApp.state.busy, code);
    }
    const codes = await openApp();
    for (const code of codes) await markCode(code);
    assert.equal(await page.evaluate(() => PingLocationApp.state.plan.filter(row => row.status === 'ready').length), 5);
    fs.mkdirSync(path.join(project, 'docs'), { recursive: true });
    await page.screenshot({ path: path.join(project, 'docs/ping-location-preview.png') });
    await page.locator('#ping-location-root #run').click();
    await page.waitForFunction(() => !PingLocationApp.state.running && PingLocationApp.state.log.some(entry => ['success', 'error'].includes(entry.kind)), null, { timeout: 45000 });
    const integrated = await page.evaluate(() => ({ pending: __pingDemo.pending(), successes: PingLocationApp.state.log.filter(entry => entry.kind === 'success'), errors: PingLocationApp.state.log.filter(entry => entry.kind === 'error'), status: document.querySelector('#ping-location-root').shadowRoot.getElementById('status').textContent }));
    assert.equal(integrated.successes.length, 5, JSON.stringify(integrated));
    assert.equal(integrated.pending, 19);
    assert.equal(activeToken, null, 'session detaches after completion');
    assert.equal(feedback.length, 5);
    assert.ok(messages.filter(type => type === 'capture').length >= 10, 'real captures exercised before/during the run');
    console.log('PASS content: read list, prompt/manual points, 5-item run, live screenshot guards, exact verification and detached token.');

    const wrongCodes = await openApp();
    await markCode(wrongCodes[0]);
    wrongClick = true;
    await page.locator('#ping-location-root #run').click();
    await page.waitForFunction(() => !PingLocationApp.state.running && PingLocationApp.state.log.some(entry => entry.kind === 'error'), null, { timeout: 30000 });
    assert.equal(await page.evaluate(() => __pingDemo.pending()), 24);
    assert.equal(await page.evaluate(() => PingLocationApp.state.log.filter(entry => entry.kind === 'success').length), 0);
    assert.equal(activeToken, null);
    assert.deepEqual(browserErrors, []);
    console.log('PASS content failure: wrong map click never confirmed, run stops, no assignment or success log, session detached.');
  } finally { if (browser) await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
