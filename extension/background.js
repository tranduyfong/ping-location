"use strict";
const attached = new Set();
const busy = new Set();
const detaching = new Set();
const sessions = new Map();
const activeOcr = new Map();
const serviceUrl = "http://127.0.0.1:8766";
let captureTail = Promise.resolve();
let lastCaptureAt = 0;

chrome.action.onClicked.addListener(async tab => {
  if (!tab.id || !/^https?:/.test(tab.url || "")) return;
  try {
    await chrome.scripting.executeScript({target: {tabId: tab.id}, world: "MAIN", files: ["bridge.js"]});
    await chrome.scripting.executeScript({target: {tabId: tab.id}, files: ["core.js", "adapter.js", "content.js"]});
  } catch (error) {
    await chrome.action.setBadgeText({tabId: tab.id, text: "!"});
    console.error("Ping Location:", error.message);
  }
});

function assertSession(tabId, token) {
  if (typeof token !== "string" || !token || sessions.get(tabId) !== token) {
    throw new Error("Phiên điều khiển đã dừng hoặc không còn hợp lệ.");
  }
}
async function activeTab(tabId, guard = () => {}) {
  const tab = await chrome.tabs.get(tabId);
  guard();
  const win = await chrome.windows.get(tab.windowId);
  guard();
  if (!tab.active || !win.focused) throw new Error("Hãy giữ tab bản đồ ở phía trước rồi thử lại.");
  return tab;
}
function capture(tabId) {
  // Chrome permits at most two visible-tab captures per second. Serialize across
  // every tab, and check focus only after the queued throttle delay has elapsed.
  const pending = captureTail.catch(() => {}).then(async () => {
    const delay = Math.max(0, 600 - (Date.now() - lastCaptureAt));
    if (delay) await new Promise(resolve => setTimeout(resolve, delay));
    const tab = await activeTab(tabId);
    lastCaptureAt = Date.now();
    try {
      const image = await chrome.tabs.captureVisibleTab(tab.windowId, {format: "png"});
      if (typeof image !== "string" || !image.startsWith("data:image/png;base64,")) throw new Error("Chrome không trả về ảnh PNG.");
      return {image, ...pngDimensions(image)};
    } catch (error) {
      throw new Error("Không chụp được tab bản đồ. Hãy tải lại trang (F5), bấm lại biểu tượng Ping Location rồi thử chụp. Sau khi cập nhật tiện ích cần tải lại cả trang bản đồ. Chi tiết: " + error.message);
    }
  });
  captureTail = pending.catch(() => {});
  return pending;
}
function pngDimensions(image) {
  try {
    const bytes = atob(image.slice(image.indexOf(",") + 1, image.indexOf(",") + 33));
    if (bytes.length < 24 || bytes.slice(1, 4) !== "PNG") return {};
    const number = offset => ((bytes.charCodeAt(offset) << 24) | (bytes.charCodeAt(offset + 1) << 16) | (bytes.charCodeAt(offset + 2) << 8) | bytes.charCodeAt(offset + 3)) >>> 0;
    const width = number(16), height = number(20);
    return width && height ? {width, height} : {};
  } catch (_) { return {}; }
}
async function detach(tabId) {
  // Invalidate before the first await, including when attach is still pending.
  sessions.delete(tabId);
  cancelOcr(tabId);
  if (!attached.has(tabId)) return;
  attached.delete(tabId);
  detaching.add(tabId);
  try { await chrome.debugger.detach({tabId}); } catch (_) { /* already detached */ }
  finally { detaching.delete(tabId); }
}
async function begin(tabId) {
  if (busy.has(tabId) || detaching.has(tabId)) throw new Error("Chrome đang hoàn tất thao tác trước; hãy thử lại.");
  const runToken = crypto.randomUUID();
  sessions.set(tabId, runToken);
  try {
    await activeTab(tabId, () => assertSession(tabId, runToken));
    assertSession(tabId, runToken);
    return {runToken};
  } catch (error) {
    if (sessions.get(tabId) === runToken) sessions.delete(tabId);
    throw error;
  }
}
async function attachSession(tabId, runToken) {
  assertSession(tabId, runToken);
  if (attached.has(tabId)) return false;
  await chrome.debugger.attach({tabId}, "1.3");
  attached.add(tabId);
  try { assertSession(tabId, runToken); }
  catch (error) { await detach(tabId); throw error; }
  return true;
}
async function prepare(tabId) {
  const {runToken} = await begin(tabId);
  const attachedNow = await attachSession(tabId, runToken);
  assertSession(tabId, runToken);
  return {attachedNow};
}
async function click(tabId, request) {
  const guard = () => assertSession(tabId, request.runToken);
  guard();
  if (!Number.isFinite(request.x) || !Number.isFinite(request.y) || request.x < 0 || request.y < 0) {
    throw new Error("Tọa độ bấm không hợp lệ.");
  }
  const expected = request.expectedViewport;
  if (!expected || !Number.isFinite(expected.width) || !Number.isFinite(expected.height) || expected.width <= 0 || expected.height <= 0) {
    throw new Error("Thiếu kích thước khung nhìn hợp lệ để kiểm tra tọa độ.");
  }
  await activeTab(tabId, guard);
  guard();
  await attachSession(tabId, request.runToken);
  guard();
  const target = {tabId};
  // Read dimensions from the target itself; caller-provided bounds are not proof
  // that a coordinate is still inside the current viewport.
  const dimensions = await chrome.debugger.sendCommand(target, "Runtime.evaluate", {
    expression: "({width:innerWidth,height:innerHeight})", returnByValue: true
  });
  guard();
  const viewport = dimensions?.result?.value;
  if (!viewport || !Number.isFinite(viewport.width) || !Number.isFinite(viewport.height) ||
      viewport.width <= 0 || viewport.height <= 0 || request.x >= viewport.width || request.y >= viewport.height) {
    throw new Error("Tọa độ nằm ngoài khung nhìn hiện tại.");
  }
  if (Math.abs(viewport.width - expected.width) >= 1 || Math.abs(viewport.height - expected.height) >= 1) {
    throw new Error("Kích thước khung nhìn đã thay đổi sau khi kết nối Chrome. Hãy đọc và quét lại bản đồ.");
  }
  for (const event of [
    {type: "mouseMoved", x: request.x, y: request.y},
    {type: "mousePressed", x: request.x, y: request.y, button: "left", clickCount: 1},
    {type: "mouseReleased", x: request.x, y: request.y, button: "left", clickCount: 1}
  ]) {
    guard();
    await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", event);
    guard();
  }
  return {clicked: true};
}
async function serviceJson(path, options = {}) {
  const controller = new AbortController();
  let timedOut = false;
  const abort = () => controller.abort();
  if (options.signal?.aborted) throw new Error("Đã dừng quét OCR.");
  options.signal?.addEventListener("abort", abort, {once: true});
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, options.timeout || 10000);
  try {
    const response = await fetch(serviceUrl + path, {
      signal: controller.signal,
      method: options.method || "GET",
      ...(options.body === undefined ? {} : {headers: {"Content-Type": "application/json"}, body: JSON.stringify(options.body)})
    });
    if (path === "/jobs" && response.status === 404) throw new Error("Dịch vụ OCR đang chạy là bản cũ. Đóng cửa sổ dịch vụ cũ rồi mở lại ping-location/start.cmd để cập nhật.");
    let data;
    try { data = await response.json(); }
    catch (_) { throw new Error(`Dịch vụ OCR trả về dữ liệu không hợp lệ (HTTP ${response.status}).`); }
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error(`Dịch vụ OCR trả về dữ liệu không hợp lệ (HTTP ${response.status}).`);
    if (!response.ok) {
      const detail = typeof data.error === "object" ? data.error?.message || data.error?.code : data.error;
      throw new Error(data.message ? `${detail || "OCR"}: ${data.message}` : detail || `OCR HTTP ${response.status}`);
    }
    return data;
  } catch (error) {
    if (options.signal?.aborted) throw new Error("Đã dừng quét OCR.");
    if (timedOut) throw new Error("Dịch vụ OCR không phản hồi trong 10 giây. Mở ping-location/start.cmd, chờ dịch vụ sẵn sàng rồi thử lại.");
    if (error instanceof TypeError || error.name === "TypeError") throw new Error("Không kết nối được dịch vụ OCR tại 127.0.0.1:8766. Mở ping-location/start.cmd rồi thử lại. Chi tiết: " + error.message);
    throw error;
  } finally { clearTimeout(timer); options.signal?.removeEventListener("abort", abort); }
}
function deleteOcrJob(record) {
  if (record.jobId && !record.deleting) {
    record.deleting = true;
    serviceJson("/jobs/" + encodeURIComponent(record.jobId), {method: "DELETE"}).catch(() => {});
  }
}
function cancelOcr(tabId) {
  const record = activeOcr.get(tabId);
  if (!record) return {cancelled: false};
  record.cancelled = true;
  record.controller.abort();
  deleteOcrJob(record);
  return {cancelled: true};
}
function waitOcr(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new Error("Đã dừng quét OCR.")); return; }
    const cancel = () => { clearTimeout(timer); reject(new Error("Đã dừng quét OCR.")); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", cancel); resolve(); }, ms);
    signal.addEventListener("abort", cancel, {once: true});
  });
}
function reportOcr(tabId, job) {
  chrome.tabs.sendMessage(tabId, {channel: "PingLocation", type: "ocrProgress", jobId: job.jobId, state: job.state,
    progress: job.progress && typeof job.progress === "object" ? job.progress : {stage: job.state, completed: 0, total: 0, message: "Đang xử lý OCR…"}}).catch(() => {});
}
async function runOcr(tabId, body) {
  if (activeOcr.has(tabId)) throw new Error("Tab này đang quét OCR. Bấm Dừng trước khi quét lại.");
  const record = {controller: new AbortController(), jobId: null, cancelled: false, deleting: false};
  activeOcr.set(tabId, record);
  const deadline = Date.now() + 180000;
  let finished = false;
  try {
    // Do not abort job creation: its short response supplies the ID required to
    // cancel work that the server may already have accepted.
    let job = await serviceJson("/jobs", {method: "POST", body});
    if (typeof job.jobId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(job.jobId)) throw new Error("Dịch vụ OCR trả về mã phiên quét không hợp lệ. Hãy cập nhật dịch vụ bằng start.cmd.");
    record.jobId = job.jobId;
    let missingResult = false;
    while (true) {
      if (record.cancelled) { deleteOcrJob(record); throw new Error("Đã dừng quét OCR."); }
      if (Date.now() >= deadline) throw new Error("Phiên OCR vượt quá 3 phút và đã dừng. Thử quét nhanh hoặc chia vùng bản đồ nhỏ hơn.");
      if (!["queued", "running", "completed", "failed", "cancelled"].includes(job.state)) throw new Error("Trạng thái OCR không hợp lệ. Hãy cập nhật dịch vụ bằng start.cmd.");
      reportOcr(tabId, job);
      if (job.state === "completed" && job.result && typeof job.result === "object" && Array.isArray(job.result.detections)) { finished = true; return job.result; }
      if (job.state === "failed") throw new Error(typeof job.error === "object" ? job.error?.message || job.error?.code || "Không đọc được bản đồ." : job.error || "Không đọc được bản đồ.");
      if (job.state === "cancelled") throw new Error("Đã dừng quét OCR.");
      if (job.state === "completed") {
        if (missingResult) throw new Error("Phiên OCR hoàn tất nhưng thiếu kết quả. Hãy quét lại.");
        missingResult = true;
      } else await waitOcr(Math.min(750, deadline - Date.now()), record.controller.signal);
      if (record.cancelled) throw new Error("Đã dừng quét OCR.");
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error("Phiên OCR vượt quá 3 phút và đã dừng. Thử quét nhanh hoặc chia vùng bản đồ nhỏ hơn.");
      job = await serviceJson("/jobs/" + encodeURIComponent(record.jobId), {signal: record.controller.signal, timeout: Math.min(10000, remaining)});
      if (job.jobId !== record.jobId) throw new Error("Dịch vụ OCR trả nhầm phiên quét. Đã dừng để tránh dùng sai tọa độ.");
    }
  } finally {
    if (!finished) deleteOcrJob(record);
    if (activeOcr.get(tabId) === record) activeOcr.delete(tabId);
  }
}

chrome.runtime.onMessage.addListener((request, sender, respond) => {
  if (!sender.tab?.id || (sender.frameId !== undefined && sender.frameId !== 0) || !request || request.channel !== "PingLocation") return false;
  const tabId = sender.tab.id;
  (async () => {
    switch (request.type) {
      case "capture": return capture(tabId);
      case "ocr": return runOcr(tabId, request.body);
      case "cancelOcr": return cancelOcr(tabId);
      case "health":
      case "feedback": return serviceJson(request.type === "health" ? "/health" : "/feedback", request.type === "health" ? {} : {method: "POST", body: request.body});
      case "prepare": return prepare(tabId);
      case "begin": return begin(tabId);
      case "click": {
        if (busy.has(tabId)) throw new Error("Đang có thao tác bấm khác.");
        busy.add(tabId);
        try { return await click(tabId, request); } finally { busy.delete(tabId); }
      }
      case "stop":
      case "detach": await detach(tabId); return {};
      default: throw new Error("Lệnh không được hỗ trợ.");
    }
  })().then(value => respond({ok: true, value}), error => respond({ok: false, error: error.message}));
  return true;
});
chrome.debugger.onDetach.addListener(source => {
  if (source.tabId) {
    attached.delete(source.tabId);
    sessions.delete(source.tabId);
    cancelOcr(source.tabId);
    chrome.tabs.sendMessage(source.tabId, {channel: "PingLocation", type: "stop", reason: "Kết nối điều khiển Chrome đã đóng."}).catch(() => {});
  }
});
chrome.tabs.onRemoved.addListener(tabId => { sessions.delete(tabId); attached.delete(tabId); cancelOcr(tabId); });
chrome.commands.onCommand.addListener(async command => {
  if (command !== "stop") return;
  const tabIds = new Set([...sessions.keys(), ...attached, ...activeOcr.keys()]);
  // The keyboard shortcut cancels immediately, before querying tabs or notifying UI.
  sessions.clear();
  for (const tabId of activeOcr.keys()) cancelOcr(tabId);
  try {
    const tabs = await chrome.tabs.query({active: true, currentWindow: true});
    if (tabs[0]?.id) tabIds.add(tabs[0].id);
    await Promise.all([...tabIds].map(async tabId => {
      await chrome.tabs.sendMessage(tabId, {channel: "PingLocation", type: "stop", reason: "Đã dừng bằng Ctrl+Shift+X."}).catch(() => {});
      await detach(tabId);
    }));
  } catch (error) { console.error("Ping Location:", error.message); }
});
