/* QR Drop — service worker.
 * Owns the signaling WebSocket so page CSP (Gmail, GitHub, banks...) can never block it.
 * Content scripts / extension pages talk to it over a long-lived Port; only tiny JSON
 * handshake messages go through here. File bytes travel peer-to-peer and never touch it. */
importScripts("lib/config.js");

const getSettings = () => chrome.storage.sync.get({ server: self.QRD_DEFAULT_SERVER, confirm: true });
const isPlaceholder = (s) => !s || /YOUR-APP/.test(s);

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "qrd-signal") return;
  let ws = null;
  let closed = false;
  const queue = [];
  const toPage = (m) => { try { port.postMessage(m); } catch (_) {} };

  port.onMessage.addListener((m) => {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(m));
    else queue.push(m);
  });
  port.onDisconnect.addListener(() => {
    closed = true;
    try { ws && ws.close(); } catch (_) {}
  });

  getSettings().then(({ server }) => {
    if (closed) return;
    if (isPlaceholder(server)) return toPage({ t: "error", code: "no-server" });
    const url = server.replace(/\/+$/, "").replace(/^http/, "ws") + "/ws";
    try { ws = new WebSocket(url); } catch (_) { return toPage({ t: "error", code: "server-unreachable" }); }
    ws.onopen = () => queue.splice(0).forEach((m) => ws.send(JSON.stringify(m)));
    ws.onmessage = (e) => { try { toPage(JSON.parse(e.data)); } catch (_) {} };
    ws.onerror = () => toPage({ t: "error", code: "server-unreachable" });
    ws.onclose = () => { if (!closed) toPage({ t: "closed" }); };
  });
});

// Free hosts sleep when idle. Hovering a badge pings /healthz so the server is awake by the click.
chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.t === "warm") {
    getSettings().then(({ server }) => {
      if (!isPlaceholder(server)) fetch(server.replace(/\/+$/, "") + "/healthz", { mode: "no-cors" }).catch(() => {});
    });
  }
});

// Right-click fallback for drag-and-drop zones that have no file input at all.
chrome.runtime.onInstalled.addListener((details) => {
  // First run with no server configured: open the setup page instead of failing silently later.
  if (details && details.reason === "install") {
    getSettings().then(({ server }) => {
      if (isPlaceholder(server)) chrome.tabs.create({ url: chrome.runtime.getURL("popup.html") });
    });
  }
  chrome.contextMenus.removeAll(() => chrome.contextMenus.create({
    id: "qrd-here",
    title: "QR Drop: receive a file from my phone here",
    contexts: ["all"],
  }));
});
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === "qrd-here" && tab && tab.id != null) {
    chrome.tabs.sendMessage(tab.id, { t: "ctx" }, { frameId: info.frameId || 0 }).catch(() => {});
  }
});
