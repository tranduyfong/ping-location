'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../extension/core.js');

const bounds = { width: 1000, height: 800, mapRect: { x: 0, y: 0, width: 800, height: 800 }, excludedRects: [{ x: 600, y: 100, width: 200, height: 300 }] };
const point = (code, x = 100, y = 100, extras = {}) => ({ code, x, y, confidence: 0.96, source: 'ocr', ...extras });
const plan = (rows, detections, options = bounds) => core.buildPlan(rows, detections, options);

test('code matching preserves prefixes, dots and zero padding', () => {
  assert.equal(core.normalizeCode(' vnb.tp.1 – 00345 '), 'VNB.TP.1-00345');
  assert.equal(core.normalizeCode('VN 48—123'), 'VN48-123');
  assert.equal(core.normalizeCode('ABC-12x'), '');
  assert.equal(core.normalizeCode('VX-2-3'), '');
  assert.deepEqual(core.extractCodes('VN48-123 / ASP - 233; VX-002, VNB.TP.1-345\nVX-002'), ['VN48-123', 'ASP-233', 'VX-002', 'VNB.TP.1-345']);
  assert.deepEqual(core.extractCodes('foo_VX-02 VX-2ABC 1VX-02 ABC-VX-02'), []);
  const result = plan(['VX-02', 'VX-2', 'VNB.TP.1-345', 'VNB.TP.2-345'], [point('VX-02'), point('VNB.TP.1-345')]);
  assert.deepEqual(result.map(item => item.status), ['ready', 'missing', 'ready', 'missing']);
});

test('Vietnamese codes retain diacritics and never alias D to Đ', () => {
  for (const code of ['KĐ7-93', 'ĐLSH-173', 'ĐÔNG.ƯỚC-002', 'VM3-28']) {
    assert.equal(core.normalizeCode(code.toLowerCase().normalize('NFD')), code);
    assert.deepEqual(core.extractCodes(`${code} 153.00 m²`), [code]);
  }
  assert.deepEqual(core.extractCodes('KĐ7-93 KD7-93 ĐLSH-173 DLSH-173'), ['KĐ7-93', 'KD7-93', 'ĐLSH-173', 'DLSH-173']);
  assert.deepEqual(core.extractCodes('KĐ7-93Á foo_ĐLSH-173'), []);
  assert.deepEqual(plan(['KĐ7-93', 'KD7-93'], [point('KĐ7-93')]).map(item => item.status), ['ready', 'missing']);
});

test('OCR prefix suggestions keep the number and always require human review', () => {
  const result = core.reviewOcrCodes([point('VI39-011'), point('YT39-017')], ['VT39-19']);
  assert.deepEqual(result.map(p => [p.code, p.originalCode, p.requiresReview]),
    [['VT39-011', 'VI39-011', true], ['VT39-017', 'YT39-017', true]]);
  assert.equal(plan(['VT39-011'], result)[0].status, 'review');
  assert.match(plan(['VT39-011'], result)[0].reason, /VI39-011/);
  assert.equal(core.reviewOcrCodes([point('VI39-11')], ['VT39-19', 'VI39-19'])[0].code, 'VI39-11');
  const ambiguous = core.reviewOcrCodes([point('VI39-11')], ['VT39-19', 'VI38-19'])[0];
  assert.equal(ambiguous.code, 'VI39-11');
  assert.equal(ambiguous.requiresReview, true);
  assert.equal(core.reviewOcrCodes([point('VI39-11')], [])[0].code, 'VI39-11');
  assert.equal(core.reviewOcrCodes([point('VI39-11', 100, 100, { source: 'manual' })], ['VT39-19'])[0].code, 'VI39-11');
});

test('near observations deduplicate by confidence but distant duplicates block automatic work', () => {
  const near = plan(['VX-02'], [point('VX-02', 100, 100, { confidence: 0.9 }), point('VX-02', 105, 104, { confidence: 0.98 })]);
  assert.equal(near[0].status, 'ready');
  assert.equal(near[0].target.x, 105);
  assert.equal(plan(['VX-02'], [point('VX-02'), point('VX-02', 300, 100)])[0].status, 'ambiguous');
  assert.equal(plan(['VX-02'], [point('VX-02'), point('VX-02', 700, 200)])[0].status, 'ambiguous');
  assert.deepEqual(plan(['VX-02', 'vx-02'], [point('VX-02')]).map(item => item.status), ['review', 'review']);
});

test('unsafe coordinates, hidden UI and malformed options never supply a ready target', () => {
  for (const detection of [point('VX-02', NaN), point('VX-02', Infinity), point('VX-02', -1), point('VX-02', 2), point('VX-02', 800), point('VX-02', 700, 200), point('VX-02', 598, 200), point('VX-02', 100, 100, { confidence: NaN }), point('VX-02', 100, 100, { confidence: 2 }), point('VX-02', 100, 100, { source: '' })]) {
    const result = plan(['VX-02'], [detection])[0];
    assert.equal(result.status, 'review');
    assert.equal(result.target, null);
  }
  assert.equal(plan(['VX-02'], [point('VX-02')], { width: NaN })[0].status, 'review');
  assert.equal(plan(['VX-02'], [point('VX-02')], { excludedRects: [{}] })[0].status, 'review');
  assert.equal(plan(['VX-02'], [point('VX-02', 100, 100, { source: 'untrusted' })])[0].status, 'review');
  assert.equal(plan(['VX-02'], [point('VX-02', 100, 100, { confidence: 0.8 })])[0].status, 'review');
});

test('interpolation preserves even sequences and needs explicit review', () => {
  const anchors = [{ code: 'VX-02', x: 100, y: 100 }, { code: 'VX-06', x: 140, y: 120 }, { code: 'VX-10', x: 180, y: 140 }];
  const detections = core.interpolateSequence(anchors, { step: 2 });
  assert.deepEqual(detections.map(item => item.code), ['VX-02', 'VX-04', 'VX-06', 'VX-08', 'VX-10']);
  assert.deepEqual({ x: detections[1].x, y: detections[1].y }, { x: 120, y: 110 });
  assert.equal(plan(['VX-04'], detections)[0].status, 'review');
  assert.equal(plan(['VX-04'], [{ ...detections[1], source: 'manual', confidence: 1 }])[0].status, 'ready');
  assert.equal(plan(['VX-03'], detections)[0].status, 'missing');
  assert.deepEqual(core.interpolateSequence([{ code: 'ASP-8', x: 100, y: 100 }, { code: 'ASP-10', x: 120, y: 100 }, { code: 'ASP-12', x: 140, y: 100 }], { step: 2 }).map(item => item.code), ['ASP-8', 'ASP-10', 'ASP-12']);
});

test('two anchors, uneven spacing, curves, mixed prefixes/parity and extrapolation are rejected', () => {
  const anchors = [{ code: 'VX-02', x: 100, y: 100 }, { code: 'VX-04', x: 120, y: 100 }, { code: 'VX-06', x: 140, y: 100 }];
  assert.throws(() => core.interpolateSequence(anchors.slice(0, 2)));
  assert.throws(() => core.interpolateSequence([anchors[0], anchors[1], { ...anchors[2], x: 200 }], { step: 2 }));
  assert.throws(() => core.interpolateSequence([anchors[0], { ...anchors[1], y: 140 }, anchors[2]], { step: 2 }));
  assert.throws(() => core.interpolateSequence([anchors[0], anchors[1], { ...anchors[2], code: 'VX-07' }], { step: 2 }));
  assert.throws(() => core.interpolateSequence([anchors[0], anchors[1], { ...anchors[2], code: 'VX-6' }], { step: 2 }));
  assert.throws(() => core.interpolateSequence([anchors[0], anchors[1], { ...anchors[2], code: 'VY-06' }], { step: 2 }));
  assert.throws(() => core.interpolateSequence(anchors, { start: 0, step: 2 }));
  assert.throws(() => core.interpolateSequence(anchors, { end: 8, step: 2 }));
  assert.throws(() => core.interpolateSequence(anchors, { start: 3, step: 2 }));
  const strings = core.interpolateSequence(anchors, { start: 'VX-02', end: 'VX-06', step: '2' });
  assert.deepEqual(strings.map(item => item.code), ['VX-02', 'VX-04', 'VX-06']);
  assert.throws(() => core.interpolateSequence(anchors, { start: 'VX-002', end: 'VX-06', step: '2' }));
});

test('CSV parsing handles quoting, CRLF and malformed documents; imported source cannot impersonate manual approval', () => {
  assert.deepEqual(core.parseCsv('a,b\r\n"one,two","a""b"\r\n"multi\nline",x'), [['a', 'b'], ['one,two', 'a"b'], ['multi\nline', 'x']]);
  assert.equal(core.escapeCsvCell('a,"b"\n'), '"a,""b""\n"');
  assert.throws(() => core.parseCsv('a,"bad'));
  const records = [point('VNB.TP.1-00345', 111.5, 222.75)];
  const imported = core.parseCoordinateFile(core.coordinatesToCsv(records), 'coordinates.csv');
  assert.deepEqual(imported.errors, []);
  assert.equal(imported.detections[0].code, 'VNB.TP.1-00345');
  assert.equal(imported.detections[0].x, 111.5);
  assert.equal(imported.detections[0].source, 'import');
  const malicious = core.parseCoordinateFile(JSON.stringify([{ code: 'VX-02', x: 100, y: 100, source: 'manual', confidence: 0.6 }]));
  assert.equal(malicious.detections[0].source, 'import');
  assert.equal(plan(['VX-02'], malicious.detections)[0].status, 'review');
  const session = core.parseCoordinateFile(JSON.stringify({ version: 1, url: 'https://example.com/map', viewport: { width: 1000, height: 800 }, detections: records, log: [] }), 'ping-location-session.json');
  assert.equal(session.errors.length, 0);
  assert.equal(session.detections[0].code, records[0].code);
  for (const text of ['code,x,y\nVX-02,,20', 'code,x,y\nVX-02,NaN,20', 'code,x,y\nVX-02,20,Infinity', '{bad json', 'code,x,x,y\nVX-02,1,2,3', 'code,x,y\nVX-02,1,2,3']) {
    assert.ok(core.parseCoordinateFile(text).errors.length, text);
  }
  assert.equal(core.parseCoordinateFile('[{"code":"VX-02","x":999,"y":100}]', 'json', bounds).detections.length, 0);
});

test('plan CSV escapes multiline reasons and retains no invented targets for missing codes', () => {
  const result = plan(['VX-02', 'VX-04'], [point('VX-02')]);
  result[0].reason = 'Kiểm tra, "đúng"\nXong';
  const csv = core.parseCsv(core.exportPlanCsv(result));
  assert.equal(csv[1][6], result[0].reason);
  assert.equal(csv[2][1], 'missing');
  assert.equal(csv[2][2], '');
});
