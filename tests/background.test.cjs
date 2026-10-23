'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { randomUUID } = require('node:crypto');

const script = fs.readFileSync(require.resolve('../extension/background.js'), 'utf8');
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const turn = () => new Promise(resolve => setImmediate(resolve));
async function until(condition) {
  // Give timers a chance to run: repeated setImmediate turns can finish before
  // the zero-delay polling timer becomes due, especially on Windows.
  const deadline = Date.now() + 2000;
  while (!condition() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 1));
  assert.ok(condition(), 'expected async operation to start');
}

function harness() {
  const listeners = {};
  const event = name => ({ addListener(fn) { listeners[name] = fn; } });
  const state = { active: true, focused: true, viewport: { width: 1000, height: 800 }, attaches: 0, detaches: 0, commands: [], messages: [], fetches: [], captures: 0 };
  const chrome = {
    action: { onClicked: event('action'), setBadgeText: async () => {} },
    scripting: { executeScript: async () => {} },
    tabs: {
      get: async id => ({ id, windowId: 1, active: state.active }),
      query: async () => [{ id: 9 }],
      captureVisibleTab: async () => { state.captures++; return 'data:image/png;base64,capture'; },
      sendMessage: async (tabId, message) => { state.messages.push({ tabId, message }); },
      onRemoved: event('removed')
    },
    windows: { get: async () => ({ focused: state.focused }) },
    debugger: {
      attach: async () => { state.attaches++; },
      detach: async () => { state.detaches++; },
      sendCommand: async (target, method, parameters) => {
        state.commands.push({ target, method, parameters });
        return method === 'Runtime.evaluate' ? { result: { value: state.viewport } } : {};
      },
      onDetach: event('detached')
    },
    runtime: { onMessage: event('message') },
    commands: { onCommand: event('command') }
  };
  const context = vm.createContext({ chrome, crypto: { randomUUID }, AbortController, setTimeout, clearTimeout, atob, console,
    fetch: async (url, init) => { state.fetches.push({ url, init }); return { ok: true, status: 200, json: async () => url.endsWith('/jobs') ? { jobId: 'cached-job', state: 'completed', progress: { stage: 'completed', completed: 1, total: 1, message: 'Done' }, result: { width: 1000, height: 800, detections: [], warnings: [] } } : { healthy: true } }; } });
  vm.runInContext(script, context, { filename: 'background.js' });
  function send(type, body = {}, sender = { tab: { id: 9 }, frameId: 0 }) {
    if (type === 'click' && !Object.prototype.hasOwnProperty.call(body, 'expectedViewport')) body = { expectedViewport: { width: 1000, height: 800 }, ...body };
    return new Promise(resolve => {
      const accepted = listeners.message({ channel: 'PingLocation', type, ...body }, sender, resolve);
      if (!accepted) resolve({ ignored: true });
    });
  }
  async function begin() { const result = await send('begin'); assert.equal(result.ok, true, result.error); return result.value.runToken; }
  return { chrome, context, listeners, state, send, begin };
}
const json = (value, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => value });
const job = (state, extras = {}) => ({ jobId: 'test-job', state, progress: { stage: state, completed: state === 'completed' ? 2 : 0, total: 2, message: state }, ...extras });
function fastPoll(h) { h.context.setTimeout = (fn, delay) => setTimeout(fn, delay <= 750 ? 0 : delay); }

test('clicks require current begin token and dispatch exactly one trusted mouse sequence', async () => {
  const h = harness();
  assert.equal((await h.send('click', { x: 100, y: 100 })).ok, false);
  const runToken = await h.begin();
  assert.equal(typeof runToken, 'string');
  assert.equal((await h.send('click', { runToken: 'wrong', x: 100, y: 100 })).ok, false);
  const result = await h.send('click', { runToken, x: 100, y: 200 });
  assert.equal(result.ok, true);
  assert.equal(result.value.clicked, true);
  assert.equal(h.state.attaches, 1);
  assert.deepEqual(h.state.commands.map(item => item.method), ['Runtime.evaluate', 'Input.dispatchMouseEvent', 'Input.dispatchMouseEvent', 'Input.dispatchMouseEvent']);
  assert.deepEqual(h.state.commands.slice(1).map(item => item.parameters.type), ['mouseMoved', 'mousePressed', 'mouseReleased']);
  await h.send('detach');
  assert.equal((await h.send('click', { runToken, x: 100, y: 100 })).ok, false);
  assert.equal(h.state.detaches, 1);
});

test('active tab, focused window, numeric coordinates and target viewport are checked before input', async () => {
  const h = harness();
  h.state.active = false;
  assert.equal((await h.send('begin')).ok, false);
  assert.equal((await h.send('capture')).ok, false);
  assert.equal(h.state.captures, 0);
  h.state.active = true; h.state.focused = false;
  assert.equal((await h.send('begin')).ok, false);
  h.state.focused = true;
  const runToken = await h.begin();
  for (const x of [NaN, Infinity, -1, '100', null]) assert.equal((await h.send('click', { runToken, x, y: 100 })).ok, false);
  assert.equal(h.state.attaches, 0);
  h.state.active = false;
  assert.equal((await h.send('click', { runToken, x: 100, y: 100 })).ok, false);
  h.state.active = true;
  for (const point of [{ x: 1000, y: 100 }, { x: 100, y: 800 }]) assert.equal((await h.send('click', { runToken, ...point })).ok, false);
  assert.equal(h.state.commands.filter(item => item.method === 'Input.dispatchMouseEvent').length, 0);
  assert.equal((await h.send('capture')).ok, true);
  assert.equal(h.state.captures, 1);
});

test('clicks reject missing or invalid expected viewport before attaching Chrome', async () => {
  const h = harness(), runToken = await h.begin();
  for (const expectedViewport of [undefined, null, {}, { width: 0, height: 800 }, { width: 1000, height: Infinity }, { width: '1000', height: 800 }]) {
    assert.equal((await h.send('click', { runToken, x: 100, y: 100, expectedViewport })).ok, false);
  }
  assert.equal(h.state.attaches, 0);
  assert.equal(h.state.commands.length, 0);
});

test('attachment viewport resize rejects stale coordinates before any mouse command', async () => {
  const h = harness(), runToken = await h.begin();
  h.chrome.debugger.attach = async () => { h.state.attaches++; h.state.viewport = { width: 1000, height: 760 }; };
  const response = await h.send('click', { runToken, x: 100, y: 100, expectedViewport: { width: 1000, height: 800 } });
  assert.equal(response.ok, false);
  assert.match(response.error, /khung nhìn/);
  assert.deepEqual(h.state.commands.map(item => item.method), ['Runtime.evaluate']);
  assert.equal(h.state.attaches, 1);
});

test('prepare attaches once before reading the map and can be reused by a later run', async () => {
  const h = harness();
  const first = await h.send('prepare');
  assert.equal(first.ok, true);
  assert.equal(first.value.attachedNow, true);
  const second = await h.send('prepare');
  assert.equal(second.ok, true);
  assert.equal(second.value.attachedNow, false);
  assert.equal(h.state.attaches, 1);
  assert.equal(h.state.commands.length, 0);
  const runToken = await h.begin();
  assert.equal((await h.send('click', { runToken, x: 100, y: 100 })).ok, true);
  assert.equal(h.state.attaches, 1);
});

test('stop during prepare invalidates its token and closes an attachment that arrives later', async () => {
  const h = harness(), gate = deferred();
  h.chrome.debugger.attach = () => { h.state.attaches++; return gate.promise; };
  const pending = h.send('prepare');
  await until(() => h.state.attaches === 1);
  await h.send('stop');
  gate.resolve();
  assert.equal((await pending).ok, false);
  assert.equal(h.state.detaches, 1);
  assert.equal(h.state.commands.length, 0);
});

test('captures serialize globally at least 600ms apart and recheck foreground after throttle', async () => {
  const h = harness(), first = deferred();
  let clock = 10000;
  const times = [], delays = [];
  h.context.Date = { now: () => clock };
  h.context.setTimeout = (fn, delay) => { delays.push(delay); clock += delay; queueMicrotask(fn); return 1; };
  h.chrome.tabs.captureVisibleTab = async () => {
    times.push(clock);
    if (times.length === 1) return first.promise;
    return 'data:image/png;base64,capture';
  };
  const requests = [h.send('capture'), h.send('capture'), h.send('capture')];
  await until(() => times.length === 1);
  assert.equal(times.length, 1);
  first.resolve('data:image/png;base64,capture');
  const responses = await Promise.all(requests);
  assert.equal(responses.every(response => response.ok), true);
  assert.deepEqual(times, [10000, 10600, 11200]);
  assert.deepEqual(delays, [600, 600]);
  h.context.setTimeout = (fn, delay) => { clock += delay; h.state.active = false; queueMicrotask(fn); return 1; };
  assert.equal((await h.send('capture')).ok, false);
  assert.equal(times.length, 3);
});

test('capture needs no debugger connection and includes PNG image dimensions', async () => {
  const h = harness();
  const header = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(header);
  header.writeUInt32BE(1920, 16); header.writeUInt32BE(1080, 20);
  h.chrome.tabs.captureVisibleTab = async () => 'data:image/png;base64,' + header.toString('base64');
  const response = await h.send('capture');
  assert.equal(response.ok, true);
  assert.equal(response.value.width, 1920);
  assert.equal(response.value.height, 1080);
  assert.equal(h.state.attaches, 0);
  assert.equal(h.state.commands.length, 0);
});

test('capture permission failures explain refreshing the map after extension updates', async () => {
  const h = harness();
  h.chrome.tabs.captureVisibleTab = async () => { throw new Error('activeTab permission not granted'); };
  const response = await h.send('capture');
  assert.equal(response.ok, false);
  assert.match(response.error, /F5/);
  assert.match(response.error, /cập nhật tiện ích/);
  assert.equal(h.state.attaches, 0);
});

test('stop while foreground checks are pending prevents attachment and all mouse input', async () => {
  const h = harness(), runToken = await h.begin(), gate = deferred();
  h.chrome.tabs.get = () => gate.promise;
  const pending = h.send('click', { runToken, x: 100, y: 100 });
  await h.send('stop');
  gate.resolve({ id: 9, windowId: 1, active: true });
  assert.equal((await pending).ok, false);
  assert.equal(h.state.attaches, 0);
  assert.equal(h.state.commands.length, 0);
});

test('stop during debugger attachment closes the late attachment without dispatching input', async () => {
  const h = harness(), runToken = await h.begin(), gate = deferred();
  h.chrome.debugger.attach = () => { h.state.attaches++; return gate.promise; };
  const pending = h.send('click', { runToken, x: 100, y: 100 });
  await until(() => h.state.attaches === 1);
  await h.send('detach');
  gate.resolve();
  assert.equal((await pending).ok, false);
  assert.equal(h.state.detaches, 1);
  assert.equal(h.state.commands.length, 0);
});

test('stop after viewport evaluation or mouse movement never proceeds to mouse press', async () => {
  for (const phase of ['Runtime.evaluate', 'mouseMoved']) {
    const h = harness(), runToken = await h.begin(), gate = deferred();
    const original = h.chrome.debugger.sendCommand;
    let waiting = false;
    h.chrome.debugger.sendCommand = async (target, method, params) => {
      if (method === phase || params.type === phase) { h.state.commands.push({ method, parameters: params }); waiting = true; return gate.promise; }
      return original(target, method, params);
    };
    const pending = h.send('click', { runToken, x: 100, y: 100 });
    await until(() => waiting);
    await h.send('stop');
    gate.resolve({ result: { value: h.state.viewport } });
    assert.equal((await pending).ok, false, phase);
    assert.equal(h.state.commands.some(item => item.parameters.type === 'mousePressed'), false, phase);
  }
});

test('keyboard stop cancels immediately even when tab lookup has not returned', async () => {
  const h = harness(), runToken = await h.begin(), gate = deferred();
  h.chrome.tabs.query = () => gate.promise;
  const shortcut = h.listeners.command('stop');
  assert.equal((await h.send('click', { runToken, x: 100, y: 100 })).ok, false);
  gate.resolve([{ id: 9 }]);
  await shortcut;
  assert.equal(h.state.commands.length, 0);
  assert.equal(h.state.messages.length, 1);
});

test('external detach, tab close and stale tokens cancel sessions; clicks cannot overlap', async () => {
  const h = harness();
  const first = await h.begin();
  const second = await h.begin();
  assert.notEqual(first, second);
  assert.equal((await h.send('click', { runToken: first, x: 100, y: 100 })).ok, false);
  h.listeners.detached({ tabId: 9 });
  assert.equal((await h.send('click', { runToken: second, x: 100, y: 100 })).ok, false);
  const removed = await h.begin();
  h.listeners.removed(9);
  assert.equal((await h.send('click', { runToken: removed, x: 100, y: 100 })).ok, false);
  const runToken = await h.begin(), gate = deferred();
  h.chrome.debugger.attach = () => { h.state.attaches++; return gate.promise; };
  const pending = h.send('click', { runToken, x: 100, y: 100 });
  await until(() => h.state.attaches === 1);
  assert.equal((await h.send('click', { runToken, x: 200, y: 200 })).ok, false);
  assert.equal((await h.send('begin')).ok, false);
  await h.send('stop'); gate.resolve();
  assert.equal((await pending).ok, false);
  assert.equal(h.state.commands.length, 0);
});

test('OCR requests use fixed localhost routes and return HTTP, JSON and network failures', async () => {
  const h = harness();
  assert.equal((await h.send('health')).ok, true);
  assert.equal(h.state.fetches[0].url, 'http://127.0.0.1:8766/health');
  const body = { image: 'data:image/png;base64,example' };
  assert.equal((await h.send('ocr', { body })).ok, true);
  assert.equal(h.state.fetches[1].init.method, 'POST');
  assert.deepEqual(JSON.parse(h.state.fetches[1].init.body), body);
  assert.equal(h.state.fetches[1].url, 'http://127.0.0.1:8766/jobs');
  h.context.fetch = async () => ({ ok: false, status: 400, json: async () => ({ error: 'Invalid image' }) });
  assert.equal((await h.send('ocr', { body })).error, 'Invalid image');
  h.context.fetch = async () => ({ ok: false, status: 502, json: async () => { throw new Error('not json'); } });
  assert.match((await h.send('health')).error, /502/);
  h.context.fetch = async () => ({ ok: true, status: 200, json: async () => null });
  assert.match((await h.send('health')).error, /200/);
  h.context.fetch = async () => { throw new Error('fetch failed'); };
  assert.equal((await h.send('feedback', { body: {} })).error, 'fetch failed');
  assert.equal((await h.send('https://elsewhere.example')).ok, false);
  assert.equal((await h.send('health', {}, { tab: { id: 9 }, frameId: 2 })).ignored, true);
});

test('OCR job polling forwards queued and running progress then returns the existing result format', async () => {
  const h = harness(); fastPoll(h);
  const result = { width: 1000, height: 800, detections: [{ code: 'VX-02', x: 100, y: 100, confidence: 0.98 }], warnings: [] };
  const records = [job('queued'), job('running'), job('completed', { result })];
  const calls = [];
  h.context.fetch = async (url, init) => { calls.push({ url, init }); return json(records.shift(), url.endsWith('/jobs') ? 202 : 200); };
  const response = await h.send('ocr', { body: { image: 'data:image/png;base64,example' } });
  assert.equal(response.ok, true);
  assert.deepEqual(response.value, result);
  assert.deepEqual(calls.map(call => call.url), ['http://127.0.0.1:8766/jobs', 'http://127.0.0.1:8766/jobs/test-job', 'http://127.0.0.1:8766/jobs/test-job']);
  assert.deepEqual(h.state.messages.map(item => item.message.state), ['queued', 'running', 'completed']);
  assert.equal(h.state.messages.every(item => item.message.type === 'ocrProgress'), true);
  assert.equal(h.state.messages[2].message.progress.completed, 2);
});

test('cancel OCR aborts a pending poll and deletes exactly its accepted job', async () => {
  const h = harness(); fastPoll(h);
  const calls = []; let polling = false;
  h.context.fetch = async (url, init) => {
    calls.push({ url, init });
    if (init.method === 'DELETE') return json(job('cancelled'), 202);
    if (init.method === 'POST') return json(job('queued'), 202);
    polling = true;
    return new Promise((resolve, reject) => init.signal.addEventListener('abort', () => { const error = new Error('aborted'); error.name = 'AbortError'; reject(error); }, { once: true }));
  };
  const pending = h.send('ocr', { body: { image: 'example' } });
  await until(() => polling);
  assert.equal((await h.send('ocr', { body: {} })).ok, false);
  const cancelled = await h.send('cancelOcr');
  assert.equal(cancelled.value.cancelled, true);
  assert.equal((await pending).ok, false);
  assert.equal(calls.filter(call => call.init.method === 'DELETE').length, 1);
  assert.equal(calls.find(call => call.init.method === 'GET').init.signal.aborted, true);
  assert.equal(h.state.messages.some(item => item.message.state === 'completed'), false);
  assert.equal((await h.send('cancelOcr')).value.cancelled, false);
});

test('cancel during job creation waits for its ID and deletes the late accepted job', async () => {
  const h = harness(), gate = deferred(), calls = [];
  h.context.fetch = async (url, init) => { calls.push({ url, init }); return init.method === 'POST' ? gate.promise : json(job('cancelled'), 202); };
  const pending = h.send('ocr', { body: {} });
  await until(() => calls.length === 1);
  assert.equal((await h.send('cancelOcr')).value.cancelled, true);
  assert.equal(calls[0].init.signal.aborted, false);
  gate.resolve(json(job('queued'), 202));
  assert.equal((await pending).ok, false);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].init.method, 'DELETE');
  assert.match(calls[1].url, /\/jobs\/test-job$/);
  assert.equal(h.state.messages.length, 0);
});

test('stop, detach, closed tab and keyboard shortcut also cancel OCR while leaving click guards intact', async () => {
  for (const action of ['stop', 'detach', 'closed', 'shortcut']) {
    const h = harness(), calls = [];
    h.context.fetch = async (url, init) => { calls.push({ url, init }); return json(job(init.method === 'DELETE' ? 'cancelled' : 'queued'), 202); };
    const runToken = await h.begin();
    const pending = h.send('ocr', { body: {} });
    await until(() => h.state.messages.some(item => item.message.type === 'ocrProgress'));
    if (action === 'closed') h.listeners.removed(9);
    else if (action === 'shortcut') await h.listeners.command('stop');
    else await h.send(action);
    assert.equal((await pending).ok, false, action);
    assert.equal(calls.filter(call => call.init.method === 'DELETE').length, 1, action);
    assert.equal((await h.send('click', { runToken, x: 100, y: 100 })).ok, false, action);
    assert.equal(h.state.commands.length, 0, action);
  }
});

test('failed or mismatched OCR jobs never return detections and are cleaned up', async () => {
  for (const final of [job('failed', { error: { code: 'ocr_failed', message: 'Model unavailable' } }), job('cancelled'), job('unknown'), job('completed', { jobId: 'wrong-job', result: { detections: [] } })]) {
    const h = harness(); fastPoll(h); const calls = [];
    h.context.fetch = async (url, init) => { calls.push({ url, init }); return json(init.method === 'POST' ? job('queued') : final); };
    const response = await h.send('ocr', { body: {} });
    assert.equal(response.ok, false, final.state);
    assert.equal(calls.filter(call => call.init.method === 'DELETE').length, 1, final.state);
  }
});

test('offline and per-request timeout errors point to start.cmd instead of hanging for three minutes', async () => {
  const h = harness();
  h.context.fetch = async () => { throw new TypeError('Failed to fetch'); };
  assert.match((await h.send('health')).error, /start\.cmd/);
  h.context.fetch = async () => ({ ok: false, status: 404, json: async () => { throw new Error('old service HTML'); } });
  assert.match((await h.send('ocr', { body: {} })).error, /bản cũ.*start\.cmd/);
  h.context.setTimeout = (fn, delay) => setTimeout(fn, delay === 10000 ? 0 : delay);
  h.context.fetch = (url, init) => new Promise((resolve, reject) => init.signal.addEventListener('abort', () => { const error = new Error('timeout'); error.name = 'AbortError'; reject(error); }, { once: true }));
  const response = await h.send('ocr', { body: {} });
  assert.equal(response.ok, false);
  assert.match(response.error, /10/);
  assert.match(response.error, /start\.cmd/);
});

test('a running job stops at the overall 180 second deadline and is deleted', async () => {
  const h = harness(); let clock = 1000, polls = 0, deleted = false;
  h.context.Date = { now: () => clock };
  h.context.setTimeout = (fn, delay) => { if (delay <= 750) { clock += delay; queueMicrotask(fn); } return 1; };
  h.context.clearTimeout = () => {};
  h.context.fetch = async (url, init) => {
    if (init.method === 'DELETE') { deleted = true; return json(job('cancelled'), 202); }
    if (init.method === 'GET') polls++;
    return json(job('running'));
  };
  const response = await h.send('ocr', { body: {} });
  assert.equal(response.ok, false);
  assert.match(response.error, /3 phút/);
  assert.equal(clock, 181000);
  assert.ok(polls <= 240);
  assert.equal(deleted, true);
});
