/* QR Drop — phone page. Joins the room from the QR (#room), then sends/receives over WebRTC. */
(function () {
  "use strict";
  const { Session, formatBytes } = QRD;
  const $ = (id) => document.getElementById(id);
  const status = (t, k) => { $("status").textContent = t; $("status").className = "status" + (k ? " " + k : ""); };

  const room = decodeURIComponent(location.hash.slice(1));
  if (!room) return status("No code found. Scan the QR code shown on your computer.", "err");

  // Keep the screen awake while connected (phones kill background transfers).
  let wake = null;
  const keepAwake = async () => { try { wake = await navigator.wakeLock.request("screen"); } catch (_) {} };
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && session && session.state === "connected") keepAwake(); });

  function wsSignal() {
    const ws = new WebSocket((location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/ws");
    const q = [];
    const s = {
      onmessage: null, onclose: null,
      send: (m) => (ws.readyState === 1 ? ws.send(JSON.stringify(m)) : q.push(m)),
      close: () => ws.close(),
    };
    ws.onopen = () => q.splice(0).forEach((m) => ws.send(JSON.stringify(m)));
    ws.onmessage = (e) => s.onmessage && s.onmessage(JSON.parse(e.data));
    ws.onclose = () => s.onclose && s.onclose();
    return s;
  }

  const errText = {
    "no-room": "This code has expired. Scan the QR code on your computer again.",
    "room-full": "Another phone is already connected to this code.",
    expired: "This code expired. Scan a new one.",
  };

  const barReset = () => { $("barWrap").classList.remove("on"); $("bar").style.width = "0"; $("info").textContent = ""; };

  const session = new Session({
    role: "guest", room, signal: wsSignal(),
    onState: (s, d) => {
      if (s === "negotiating") status("Connecting to your computer…");
      else if (s === "connected") { status("Connected ✓ Choose a file to send.", "ok"); $("actions").hidden = false; keepAwake(); }
      else if (s === "stuck") status("Can't reach your computer directly. Join the same Wi-Fi as the computer and rescan.", "err");
      else if (s === "failed") status("Connection failed. Rescan the QR code.", "err");
      else if (s === "peer-left") { status("The computer closed the session. Scan a new code to continue.", "err"); $("actions").hidden = true; }
      else if (s === "disconnected") { status("Disconnected. Reload this page to reconnect.", "err"); $("actions").hidden = true; }
      else if (s === "signal-closed" && session.state !== "connected") status("Lost the server connection. Reload this page.", "err");
      else if (s === "error") status(errText[d] || "Error: " + d, "err");
    },
    onPeerHello: (h) => {
      // The desktop tells us what its upload field accepts.
      $("fileInput").accept = h.accept || "";
      $("fileInput").multiple = h.multiple !== false;
      $("pickLabel").textContent = $("fileInput").multiple ? "Choose file(s) to send" : "Choose a file to send";
      $("camBtn").style.display = !h.accept || /image/.test(h.accept) ? "" : "none";
    },
    onBatch: () => true,
    onProgress: (p) => {
      $("barWrap").classList.add("on");
      $("bar").style.width = (p.total ? Math.round((p.done / p.total) * 100) : 100) + "%";
      const multi = p.fileCount > 1 ? ` (${p.fileIndex + 1}/${p.fileCount})` : "";
      $("info").textContent = `${p.dir === "in" ? "Receiving" : "Sending"} ${p.name}${multi} · ${formatBytes(p.done)} / ${formatBytes(p.total)} · ${formatBytes(p.speed)}/s`;
    },
    onSent: (m) => { status(`Delivered ✓ (${m.count} file${m.count > 1 ? "s" : ""})`, "ok"); barReset(); },
    onFiles: (files) => {
      barReset();
      status(`Received ${files.length} file${files.length > 1 ? "s" : ""} from your computer ✓`, "ok");
      for (const f of files) addReceived(f);
    },
    onError: (e) => status(e.message || "Transfer error", "err"),
  });
  session.start();

  function addReceived(file) {
    const url = URL.createObjectURL(file);
    const el = document.createElement("div");
    el.className = "item";
    el.innerHTML = '<div class="name"></div><div class="meta"></div><a download>Save</a>';
    el.querySelector(".name").textContent = file.name;
    el.querySelector(".meta").textContent = formatBytes(file.size);
    const a = el.querySelector("a");
    a.href = url;
    a.download = file.name;
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      const b = document.createElement("button");
      b.textContent = "Share / save to Photos";
      b.onclick = () => navigator.share({ files: [file] }).catch(() => {});
      el.appendChild(b);
    }
    $("received").prepend(el);
  }

  function send(files) {
    if (!files.length) return;
    barReset();
    status("Sending…");
    session.sendFiles(files).catch((e) => {
      barReset();
      status(e.code === "rejected" ? "Computer says: " + e.message : e.message, "err");
    });
  }
  for (const id of ["fileInput", "camInput"]) {
    $(id).addEventListener("change", (e) => { send([...e.target.files]); e.target.value = ""; });
  }
})();
