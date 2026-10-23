'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const core = require('../extension/core.js');

const script = fs.readFileSync(require.resolve('../extension/content.js'), 'utf8');

// A small DOM mock exercises panel initialization and data flow. Real rendering,
// trusted input, canvas capture and map integration are checked in the browser demo.
function harness() {
  class Node {
    constructor(tag) { this.tagName = tag; this.children = []; this.style = {}; this.value = ''; this.textContent = ''; this.files = []; this.disabled = false; this.checked = false; }
    append(...nodes) { this.children.push(...nodes); }
    replaceChildren(...nodes) { this.children = nodes; }
    contains(node) { return this === node || this.children.some(child => child.contains && child.contains(node)); }
    attachShadow() { return this.shadow = new Node('shadow'); }
    getElementById(id) {
      if (this.id === id) return this;
      for (const child of this.children) { const found = child.getElementById?.(id); if (found) return found; }
      return null;
    }
    querySelectorAll(selector) {
      const tags = selector.split(',').map(tag => tag.trim());
      return this.children.flatMap(child => [ ...(tags.includes(child.tagName) ? [child] : []), ...(child.querySelectorAll ? child.querySelectorAll(selector) : []) ]);
    }
    set innerHTML(html) {
      this.children = [];
      for (const match of html.matchAll(/<(\w+)\b[^>]*\bid="([^"]+)"[^>]*>/g)) {
        const node = new Node(match[1]); node.id = match[2]; node.value = /\bvalue="([^"]*)"/.exec(match[0])?.[1] || ''; node.checked = /\schecked(?:\s|>)/.test(match[0]);
        if (node.tagName === 'select' && !node.value) node.value = /^\s*<option\b[^>]*\bvalue="([^"]*)"/.exec(html.slice(match.index + match[0].length))?.[1] || '';
        this.children.push(node);
      }
    }
    click() { return this.onclick?.(); }
    getContext() { return { drawImage() {}, fillRect() {}, getImageData() { return { data: new Uint8ClampedArray(28000) }; } }; }
    toDataURL() { return 'data:image/png;base64,example'; }
  }
  const listeners = {}, messages = [], blobs = [];
  const page = new Node('html');
  const info = { rows: [{ code: 'VX-02' }], mapRect: { x: 0, y: 0, width: 1000, height: 800 }, panelRect: { x: 750, y: 100, width: 250, height: 300 }, diagnostics: [] };
  const adapter = { inspect: async () => structuredClone(info), readLabels: async () => [], getView: async () => ({ x: 0, y: 0, zoom: 1 }), arm: async () => ({}), verify: async () => ({ confirmed: true }), nextPage: async () => ({ advanced: false }) };
  const context = vm.createContext({
    document: { documentElement: page, hidden: false, createElement: tag => new Node(tag), addEventListener(name, listener) { listeners[name] = listener; }, removeEventListener() {}, elementFromPoint: () => page },
    location: { origin: 'https://example.test', pathname: '/map' }, innerWidth: 1000, innerHeight: 800,
    PingCore: core, PingAdapter: adapter, addEventListener(name, listener) { listeners[name] = listener; },
    chrome: { runtime: { sendMessage: async request => { messages.push(request); return { ok: true, value: request.type === 'capture' ? { image: 'data:image/png;base64,example' } : request.type === 'begin' ? { runToken: 'mock-run-token' } : request.type === 'prepare' ? { attachedNow: false } : request.type === 'health' ? { ocrReady: true, jobsApi: 1, workerWarm: true } : request.type === 'ocr' ? { width: 1000, height: 800, detections: [], warnings: [] } : {} }; }, onMessage: { addListener(fn) { listeners.message = fn; } } }, storage: { local: { get: async () => ({}), set: async () => {} } } },
    createImageBitmap: async () => ({ width: 1000, height: 800, close() {} }), fetch: async () => ({ blob: async () => ({}) }),
    setTimeout: fn => { queueMicrotask(fn); return 1; }, URL: { createObjectURL(blob) { blobs.push(blob); return 'blob:test'; }, revokeObjectURL() {} }, Blob, console
  });
  context.window = context;
  vm.runInContext(script, context, { filename: 'content.js' });
  const root = page.children[0], shadow = root.shadow;
  return { context, page, root, shadow, info, adapter, messages, blobs, listeners, get state() { return context.PingLocationApp.state; }, button: id => shadow.getElementById(id) };
}

async function prepareRun(h, codes, detectedCodes = codes) {
  h.info.rows = codes.map(code => ({ code }));
  h.state.detections = detectedCodes.map(code => ({ code, x: 100, y: 100, confidence: 1, source: 'manual' }));
  await h.button('inspect').onclick();
  h.state.view = JSON.stringify({ x: 0, y: 0, zoom: 1 });
  h.state.stamp = new Uint8ClampedArray(28000);
}
function mockRpc(h, handlers) {
  const original = h.context.chrome.runtime.sendMessage;
  h.context.chrome.runtime.sendMessage = async request => {
    if (!Object.prototype.hasOwnProperty.call(handlers, request.type)) return original(request);
    h.messages.push(request);
    return handlers[request.type](request);
  };
}
const detected = (code = 'VX-02', x = 100, y = 100, source = 'ocr') => ({ code, x, y, confidence: 0.98, source });

test('panel loads once and inspecting rows creates a missing plan without invented coordinates', async () => {
  const h = harness();
  assert.ok(h.context.PingLocationApp);
  await h.button('inspect').onclick();
  assert.equal(h.state.info.rows.length, 1);
  assert.equal(h.state.plan[0].status, 'missing');
  assert.equal(h.state.plan[0].target, null);
  h.root.style.display = 'none';
  vm.runInContext(script, h.context, { filename: 'content.js' });
  assert.equal(h.page.children.length, 1);
  assert.equal(h.root.style.display, '');
});

test('exported session JSON can be imported but manual approval is required again', async () => {
  const h = harness();
  h.state.detections = [{ code: 'VX-02', x: 100, y: 100, confidence: 1, source: 'manual' }];
  h.button('export').onclick();
  const saved = await h.blobs[0].text();
  assert.equal(JSON.parse(saved).version, 1);
  h.button('file').files = [{ name: 'ping-location-session.json', size: saved.length, text: async () => saved }];
  await h.button('file').onchange();
  assert.equal(h.state.detections.length, 1);
  assert.equal(h.state.detections[0].source, 'import');
  assert.equal(h.state.detections[0].requiresReview, true);
  assert.equal(h.state.plan[0].status, 'review');
  assert.equal(h.state.busy, false);
  assert.equal(h.messages.some(message => message.type === 'click'), false);
});

test('invalid imported coordinates leave the existing detection set intact', async () => {
  const h = harness();
  h.state.detections = [{ code: 'VX-02', x: 100, y: 100, confidence: 1, source: 'manual' }];
  h.button('file').files = [{ name: 'bad.csv', size: 30, text: async () => 'code,x,y\nVX-02,Infinity,100' }];
  await h.button('file').onchange();
  assert.equal(h.state.detections[0].source, 'manual');
  assert.equal(h.state.detections[0].x, 100);
  assert.equal(h.button('status').className, 'error');
  assert.equal(h.state.busy, false);
});

test('stop while arm or capture is pending blocks restart until the old run finishes cleanup', async () => {
  for (const phase of ['arm', 'capture']) {
    const h = harness();
    await h.button('inspect').onclick();
    h.state.detections = [{ code: 'VX-02', x: 100, y: 100, confidence: 1, source: 'manual' }];
    await h.button('preview').onclick();
    h.state.view = JSON.stringify({ x: 0, y: 0, zoom: 1 });
    h.state.stamp = new Uint8ClampedArray(28000);
    let resolve, waiting = false;
    const gate = new Promise(yes => { resolve = yes; });
    if (phase === 'arm') h.adapter.arm = async () => { waiting = true; return gate; };
    else {
      const send = h.context.chrome.runtime.sendMessage;
      h.context.chrome.runtime.sendMessage = async request => {
        if (request.type === 'capture') { waiting = true; h.messages.push(request); return gate; }
        return send(request);
      };
    }
    const pending = h.button('run').onclick();
    for (let i = 0; i < 20 && !waiting; i++) await new Promise(yes => setImmediate(yes));
    assert.equal(waiting, true, phase);
    assert.equal(h.state.busy, true, phase);
    assert.equal(h.button('inspect').disabled, true, phase);
    assert.equal(h.button('stop').disabled, false, phase);
    h.button('stop').onclick();
    assert.equal(h.state.running, false, phase);
    assert.equal(h.state.busy, true, phase);
    await h.button('run').onclick();
    assert.equal(h.messages.filter(request => request.type === 'begin').length, 1, phase);
    resolve(phase === 'arm' ? {} : { ok: true, value: { image: 'data:image/png;base64,example' } });
    await pending;
    assert.equal(h.state.busy, false, phase);
    assert.equal(h.button('inspect').disabled, false, phase);
    assert.equal(h.messages.filter(request => request.type === 'click').length, 0, phase);
    assert.equal(h.messages.filter(request => request.type === 'detach').length, 2, phase);
    assert.equal(h.root.style.visibility, '', phase);
  }
});

test('automatic pages skip initially unchecked and completed codes even when repeated on later pages', async () => {
  const h = harness(), armed = [];
  h.state.completed.add('VX-08');
  await prepareRun(h, ['VX-02', 'VX-04', 'VX-08'], ['VX-02', 'VX-04', 'VX-06', 'VX-08']);
  h.state.selected.delete('VX-04');
  assert.equal(h.button('autoPages').checked, true);
  let advances = 0;
  h.adapter.nextPage = async () => {
    advances++;
    if (advances === 1) {
      h.info.rows = ['VX-02', 'VX-04', 'VX-06', 'VX-08'].map(code => ({ code }));
      return { advanced: true };
    }
    return { advanced: false };
  };
  h.adapter.arm = async code => { armed.push(code); };
  await h.button('run').onclick();
  assert.deepEqual(armed, ['VX-02', 'VX-06']);
  assert.equal(advances, 2);
  assert.equal(h.messages.filter(message => message.type === 'click').length, 2);
  for (const request of h.messages.filter(message => message.type === 'click')) {
    assert.equal(request.runToken, 'mock-run-token');
    assert.equal(request.expectedViewport.width, 1000);
    assert.equal(request.expectedViewport.height, 800);
  }
  assert.equal(h.state.completed.has('VX-04'), false);
  assert.equal(h.state.completed.has('VX-08'), true);
  assert.equal(h.button('status').className, '');
});

test('automatic pages can begin with no ready codes and find a matched code on the next page', async () => {
  const h = harness(), armed = [];
  await prepareRun(h, ['VX-99'], ['VX-02']);
  assert.equal(h.state.plan[0].status, 'missing');
  let advances = 0;
  h.adapter.nextPage = async () => {
    advances++;
    if (advances === 1) { h.info.rows = [{ code: 'VX-02' }]; return { advanced: true }; }
    return { advanced: false };
  };
  h.adapter.arm = async code => { armed.push(code); };
  await h.button('run').onclick();
  assert.deepEqual(armed, ['VX-02']);
  assert.equal(advances, 2);
  assert.equal(h.state.completed.has('VX-02'), true);
  assert.equal(h.button('status').className, '');
});

test('disabled automatic pages process selected current-page codes and never navigate', async () => {
  const h = harness(), armed = [];
  await prepareRun(h, ['VX-02', 'VX-04']);
  h.state.selected.delete('VX-04');
  h.button('autoPages').checked = false;
  let advances = 0;
  h.adapter.nextPage = async () => { advances++; return { advanced: true }; };
  h.adapter.arm = async code => { armed.push(code); };
  await h.button('run').onclick();
  assert.deepEqual(armed, ['VX-02']);
  assert.equal(advances, 0);
});

test('new ready rows that refill the same page are processed without reapplying a completed code', async () => {
  const h = harness(), armed = [];
  await prepareRun(h, ['VX-02'], ['VX-02', 'VX-04']);
  h.adapter.arm = async code => { armed.push(code); };
  h.adapter.verify = async code => {
    if (code === 'VX-02') h.info.rows = [{ code: 'VX-02' }, { code: 'VX-04' }];
    return { confirmed: true };
  };
  await h.button('run').onclick();
  assert.deepEqual(armed, ['VX-02', 'VX-04']);
  assert.equal(h.messages.filter(message => message.type === 'click').length, 2);
});

test('a faulty paginator that reports the same unchanged page is capped at 100 page visits', async () => {
  const h = harness();
  await prepareRun(h, ['VX-99'], ['VX-02']);
  let advances = 0;
  h.adapter.nextPage = async () => { advances++; return { advanced: true }; };
  await h.button('run').onclick();
  assert.equal(advances, 99);
  assert.equal(h.messages.filter(message => message.type === 'click').length, 0);
  assert.equal(h.state.running, false);
  assert.equal(h.state.busy, false);
  assert.equal(h.button('status').className, 'error');
  assert.match(h.button('status').textContent, /100/);
});

test('action limit stops at 500 confirmed assignments without clicking a 501st code', async () => {
  const h = harness();
  const codes = Array.from({ length: 501 }, (_, i) => 'VX-' + String(i + 1).padStart(4, '0'));
  await prepareRun(h, codes);
  let arms = 0;
  h.adapter.arm = async () => { arms++; };
  await h.button('run').onclick();
  assert.equal(arms, 500);
  assert.equal(h.messages.filter(message => message.type === 'click').length, 500);
  assert.equal(h.state.completed.size, 500);
  assert.equal(h.state.completed.has('VX-0501'), false);
  assert.equal(h.state.busy, false);
  assert.equal(h.button('status').className, 'error');
  assert.match(h.button('status').textContent, /500/);
});

test('empty final results may omit map bounds and finish cleanly without another navigation', async () => {
  const h = harness();
  await prepareRun(h, ['VX-02']);
  h.adapter.verify = async () => { h.info.rows = []; h.info.mapRect = null; return { confirmed: true }; };
  let advances = 0;
  h.adapter.nextPage = async () => { advances++; return { advanced: true }; };
  await h.button('run').onclick();
  assert.equal(h.messages.filter(message => message.type === 'click').length, 1);
  assert.equal(h.state.completed.has('VX-02'), true);
  assert.equal(h.state.plan.length, 0);
  assert.equal(advances, 0);
  assert.equal(h.state.busy, false);
  assert.equal(h.button('status').className, '');
});

test('nonempty results without map bounds stop before arming or clicking', async () => {
  const h = harness();
  await prepareRun(h, ['VX-02']);
  h.info.mapRect = null;
  let arms = 0;
  h.adapter.arm = async () => { arms++; };
  await h.button('run').onclick();
  assert.equal(arms, 0);
  assert.equal(h.messages.filter(message => message.type === 'click').length, 0);
  assert.equal(h.button('status').className, 'error');
  assert.equal(h.state.busy, false);
});

test('stop while pagination is pending never assigns a code that appears on the arriving page', async () => {
  const h = harness();
  await prepareRun(h, ['VX-99'], ['VX-02']);
  let resolve, waiting = false;
  const gate = new Promise(yes => { resolve = yes; });
  h.adapter.nextPage = async () => { waiting = true; return gate; };
  const pending = h.button('run').onclick();
  for (let i = 0; i < 20 && !waiting; i++) await new Promise(yes => setImmediate(yes));
  assert.equal(waiting, true);
  h.button('stop').onclick();
  await h.button('run').onclick();
  h.info.rows = [{ code: 'VX-02' }];
  resolve({ advanced: true });
  await pending;
  assert.equal(h.messages.filter(message => message.type === 'begin').length, 1);
  assert.equal(h.messages.filter(message => message.type === 'click').length, 0);
  assert.equal(h.state.completed.size, 0);
  assert.equal(h.state.busy, false);
});

test('inspection prepares Chrome before reading bounds and clicks carry the settled viewport', async () => {
  const h = harness();
  const send = h.context.chrome.runtime.sendMessage;
  let prepared = false;
  h.context.chrome.runtime.sendMessage = async request => {
    if (request.type === 'prepare') {
      prepared = true;
      h.context.innerHeight = 760;
      h.info.mapRect.height = 760;
      h.messages.push(request);
      return { ok: true, value: { attachedNow: true } };
    }
    return send(request);
  };
  h.adapter.inspect = async () => { assert.equal(prepared, true); return structuredClone(h.info); };
  await prepareRun(h, ['VX-02']);
  assert.equal(h.state.info.mapRect.height, 760);
  await h.button('run').onclick();
  const request = h.messages.find(message => message.type === 'click');
  assert.ok(request);
  assert.equal(request.expectedViewport.width, 1000);
  assert.equal(request.expectedViewport.height, 760);
  assert.equal(h.messages.filter(message => message.type === 'prepare').length, 1);
});

test('OCR scan works with a map but no pending hotspot rows and displays recognized codes', async () => {
  const h = harness();
  h.info.rows = [];
  mockRpc(h, { ocr: async () => ({ ok: true, value: { detections: [detected()], warnings: [] } }) });
  await h.button('scan').onclick();
  assert.equal(h.state.info.rows.length, 0);
  assert.equal(h.state.detections.length, 1);
  assert.equal(h.state.detections[0].code, 'VX-02');
  assert.equal(h.state.plan.length, 0);
  assert.equal(h.button('capturePreview').children[0].tagName, 'img');
  assert.match(h.button('recognized').textContent, /VX-02/);
  assert.equal(h.button('markers').children.length, 1);
  assert.equal(h.button('status').className, '');
  assert.equal(h.state.scanning, false);
  assert.equal(h.state.busy, false);
  const request = h.messages.find(message => message.type === 'ocr');
  assert.equal(h.button('angles').value, 'auto');
  assert.equal(Object.prototype.hasOwnProperty.call(request.body, 'angles'), false);
});

test('screen preview works without hotspot rows, a detected map, or any OCR service request', async () => {
  const h = harness();
  h.info.rows = []; h.info.mapRect = null;
  mockRpc(h, {
    health: async () => { throw new Error('OCR service must not be consulted for preview'); },
    ocr: async () => { throw new Error('OCR must not run for preview'); }
  });
  await h.button('capturePreviewButton').onclick();
  assert.deepEqual({ ...h.state.info.mapRect }, { x: 0, y: 0, width: 1000, height: 800 });
  const preview = h.button('capturePreview');
  assert.equal(preview.children[0].src, 'data:image/png;base64,example');
  assert.match(preview.children[1].textContent, /1000.*800/);
  assert.match(h.button('status').textContent, /thành công/);
  assert.equal(h.messages.some(message => ['health', 'ocr'].includes(message.type)), false);
  assert.equal(h.button('status').className, '');
});

test('partly offscreen map bounds are clipped before preview and OCR coordinates return to viewport space', async () => {
  const h = harness();
  h.info.rows = [];
  h.info.mapRect = { x: 900, y: 700, width: 500, height: 500 };
  mockRpc(h, { ocr: async () => ({ ok: true, value: { detections: [detected('VX-02', 50, 50)], warnings: [] } }) });
  await h.button('scan').onclick();
  assert.deepEqual({ ...h.state.info.mapRect }, { x: 900, y: 700, width: 100, height: 100 });
  assert.match(h.button('capturePreview').children[1].textContent, /100.*100/);
  assert.equal(h.state.detections[0].x, 950);
  assert.equal(h.state.detections[0].y, 750);
  assert.equal(h.button('status').className, '');
});

test('debugger prepare errors still allow screenshot preview and OCR recognition', async () => {
  const h = harness();
  mockRpc(h, {
    prepare: async () => ({ ok: false, error: 'Another debugger is already attached' }),
    ocr: async () => ({ ok: true, value: { detections: [detected()], warnings: [] } })
  });
  await h.button('capturePreviewButton').onclick();
  assert.equal(h.button('capturePreview').children[0].tagName, 'img');
  await h.button('scan').onclick();
  assert.equal(h.state.controlReady, false);
  assert.equal(h.state.detections[0].code, 'VX-02');
  assert.equal(h.button('status').className, '');
  assert.equal(h.messages.filter(message => message.type === 'ocr').length, 1);
  await h.button('run').onclick();
  assert.equal(h.messages.filter(message => message.type === 'click').length, 0);
  assert.match(h.button('status').textContent, /Chưa kết nối điều khiển Chrome/);
});

test('health reporting OCR unavailable produces a human error before sending an OCR job', async () => {
  const h = harness();
  mockRpc(h, { health: async () => ({ ok: true, value: { ocrReady: false, missingModels: ['text-recognition.onnx'] } }) });
  await h.button('scan').onclick();
  assert.equal(h.messages.some(message => message.type === 'ocr'), false);
  assert.equal(h.messages.some(message => message.type === 'capture'), false);
  assert.equal(h.button('status').className, 'error');
  assert.match(h.button('status').textContent, /OCR chưa sẵn sàng/);
  assert.match(h.button('status').textContent, /text-recognition\.onnx/);
  assert.equal(h.state.scanning, false);
  assert.equal(h.state.busy, false);
});

test('default scan preserves resolution and prefix suggestions cannot become ready automatically', async () => {
  const h = harness();
  h.info.rows = [{ code: 'VT39-11' }, { code: 'VT39-17' }];
  mockRpc(h, { ocr: async () => ({ ok: true, value: {
    detections: [detected('VI39-11', 100, 100), detected('YT39-17', 200, 200)], warnings: []
  } }) });
  await h.button('scan').onclick();
  const request = h.messages.find(message => message.type === 'ocr');
  assert.equal(request.body.profile, 'balanced');
  assert.equal(request.body.angles, undefined);
  assert.deepEqual(Array.from(h.state.plan, item => item.status), ['review', 'review']);
  assert.deepEqual(Array.from(h.state.detections, item => item.originalCode), ['VI39-11', 'YT39-17']);
  assert.match(h.button('recognized').textContent, /VT39-11.*VI39-11/);
  h.button('confidence').value = '0.5';
  h.button('confidence').onchange();
  assert.equal(h.state.selected.size, 0);
});

test('an explicit prefix works without pending rows and quick scan remains available', async () => {
  const h = harness();
  h.info.rows = [];
  h.button('codePrefixes').value = 'VT39';
  h.button('angles').value = 'quick';
  mockRpc(h, { ocr: async () => ({ ok: true, value: { detections: [detected('VI39-011')], warnings: [] } }) });
  await h.button('scan').onclick();
  assert.equal(h.messages.find(message => message.type === 'ocr').body.profile, 'quick');
  assert.equal(h.state.detections[0].code, 'VT39-011');
  assert.equal(h.state.detections[0].originalCode, 'VI39-011');
  assert.equal(h.state.detections[0].requiresReview, true);
});

test('direct map labels bypass the OCR service and render their recognized codes', async () => {
  const h = harness();
  h.adapter.readLabels = async () => [detected('VNB.TP.1-00345', 100, 100, 'dom')];
  h.info.rows = [{ code: 'VNB.TP.1-00345' }];
  mockRpc(h, {
    health: async () => { throw new Error('offline health should be bypassed'); },
    ocr: async () => { throw new Error('OCR should be bypassed'); }
  });
  await h.button('scan').onclick();
  assert.equal(h.messages.some(message => ['health', 'ocr'].includes(message.type)), false);
  assert.equal(h.state.detections[0].source, 'dom');
  assert.equal(h.state.plan[0].status, 'ready');
  assert.match(h.button('recognized').textContent, /VNB\.TP\.1-00345/);
  assert.match(h.button('status').textContent, /trực tiếp/);
  assert.equal(h.button('markers').children.length, 1);
});

test('OCR progress is visible while scanning and Stop cancels the outstanding job', async () => {
  const h = harness();
  let finish, waiting = false;
  const gate = new Promise(resolve => { finish = resolve; });
  mockRpc(h, {
    ocr: async () => { waiting = true; return gate; },
    cancelOcr: async () => { finish({ ok: false, error: 'Đã dừng quét OCR.' }); return { ok: true, value: { cancelled: true } }; }
  });
  const pending = h.button('scan').onclick();
  for (let i = 0; i < 20 && !waiting; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(waiting, true);
  assert.equal(h.state.scanning, true);
  h.listeners.message({ channel: 'PingLocation', type: 'ocrProgress', state: 'running', progress: { message: 'Đang đọc dãy căn', completed: 12, total: 100 } });
  assert.match(h.button('status').textContent, /Đang đọc dãy căn.*12\/100/);
  h.button('stop').onclick();
  await pending;
  assert.equal(h.messages.some(message => message.type === 'cancelOcr'), true);
  assert.equal(h.messages.some(message => message.type === 'detach'), true);
  assert.equal(h.state.detections.length, 0);
  assert.equal(h.state.scanning, false);
  assert.equal(h.state.busy, false);
  assert.match(h.button('status').textContent, /Đã dừng/);
  assert.equal(h.button('capturePreview').children[0].tagName, 'img');
});

test('zero recognized labels retain the captured preview and explain increasing text size', async () => {
  const h = harness();
  await h.button('scan').onclick();
  assert.equal(h.state.detections.length, 0);
  assert.equal(h.button('capturePreview').children[0].tagName, 'img');
  assert.match(h.button('status').textContent, /Đã chụp được bản đồ.*chưa đọc được mã/);
  assert.match(h.button('status').textContent, /phóng to chữ/);
  assert.equal(h.button('status').className, '');
});

test('runtime invalidation explains refreshing the map and reopening the extension', async () => {
  const h = harness();
  h.context.chrome.runtime.sendMessage = async () => { throw new Error('Extension context invalidated.'); };
  await h.button('capturePreviewButton').onclick();
  assert.equal(h.button('status').className, 'error');
  assert.match(h.button('status').textContent, /F5/);
  assert.match(h.button('status').textContent, /mở lại Ping Location/);
  assert.equal(h.state.busy, false);
});

test('cancellation prevents late direct label results from replacing existing detections', async () => {
  const h = harness();
  const previous = [detected('VX-04', 120, 100, 'manual')];
  h.state.detections = previous;
  let finish, waiting = false;
  const gate = new Promise(resolve => { finish = resolve; });
  h.adapter.readLabels = async () => { waiting = true; return gate; };
  const pending = h.button('scan').onclick();
  for (let i = 0; i < 20 && !waiting; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(waiting, true);
  h.button('stop').onclick();
  const stoppedStatus = h.button('status').textContent;
  assert.equal(h.state.scanning, false);
  h.listeners.message({ channel: 'PingLocation', type: 'ocrProgress', state: 'running', progress: { message: 'Late progress', completed: 1, total: 2 } });
  assert.equal(h.button('status').textContent, stoppedStatus);
  finish([detected('VX-02', 100, 100, 'dom')]);
  await pending;
  assert.equal(h.state.detections, previous);
  assert.equal(h.state.detections[0].code, 'VX-04');
  assert.equal(h.state.revision, 0);
  assert.equal(h.state.view, null);
  assert.equal(h.messages.some(message => ['capture', 'health', 'ocr', 'click'].includes(message.type)), false);
  assert.match(h.button('status').textContent, /hủy|dừng/);
  assert.equal(h.state.busy, false);
});

test('cancelled final snapshot cannot commit direct or OCR detections or overwrite view state', async () => {
  for (const source of ['dom', 'ocr']) {
    const h = harness();
    const previous = [detected('VX-04', 120, 100, 'manual')];
    const previousStamp = new Uint8ClampedArray(28000);
    h.state.detections = previous;
    h.state.view = 'previous-view';
    h.state.stamp = previousStamp;
    h.state.revision = 7;
    h.state.stale = true;
    if (source === 'dom') h.adapter.readLabels = async () => [detected('VX-02', 100, 100, 'dom')];
    let finish, waiting = false, captures = 0;
    const gate = new Promise(resolve => { finish = resolve; });
    mockRpc(h, {
      capture: async () => {
        captures++;
        if (captures === (source === 'dom' ? 1 : 3)) { waiting = true; return gate; }
        return { ok: true, value: { image: 'data:image/png;base64,example' } };
      },
      ocr: async () => ({ ok: true, value: { detections: [detected()], warnings: [] } })
    });
    const pending = h.button('scan').onclick();
    for (let i = 0; i < 20 && !waiting; i++) await new Promise(resolve => setImmediate(resolve));
    assert.equal(waiting, true, source);
    h.button('stop').onclick();
    finish({ ok: true, value: { image: 'data:image/png;base64,example' } });
    await pending;
    assert.equal(h.state.detections, previous, source);
    assert.equal(h.state.view, 'previous-view', source);
    assert.equal(h.state.stamp, previousStamp, source);
    assert.equal(h.state.revision, 7, source);
    assert.equal(h.state.stale, true, source);
    assert.equal(h.state.scanning, false, source);
    assert.equal(h.state.busy, false, source);
    assert.equal(h.messages.some(message => message.type === 'click'), false, source);
    assert.match(h.button('status').textContent, /hủy|dừng/, source);
    assert.equal(h.root.style.visibility, '', source);
  }
});
