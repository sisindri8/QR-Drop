const { Session, formatBytes, qrSvg } = QRD;
const $ = (id) => document.getElementById(id);
const setStatus = (t, k) => { $("status").textContent = t; $("status").className = k || ""; };

(async () => {
  const settings = await chrome.storage.sync.get({ server: self.QRD_DEFAULT_SERVER, confirm: false });
  const server = (settings.server || "").replace(/\/+$/, "");
  const port = chrome.runtime.connect({ name: "qrd-signal" });
  const signal = {
    onmessage: null, onclose: null,
    send: (m) => { try { port.postMessage(m); } catch (_) {} },
    close: () => { try { port.disconnect(); } catch (_) {} },
  };
  port.onMessage.addListener((m) => (m.t === "closed" ? signal.onclose && signal.onclose() : signal.onmessage && signal.onmessage(m)));
  port.onDisconnect.addListener(() => signal.onclose && signal.onclose());

  let qrHtml = "";
  const errText = {
    "no-server": "No server set — open the extension icon and add your server address.",
    "server-unreachable": "Can't reach the QR Drop server.",
    expired: "Code expired — reload this page.",
    "room-full": "Another phone is already connected.",
  };

  const session = new Session({
    role: "host", signal,
    hello: { mode: "standalone", accept: "", multiple: true },
    onRoom: (room) => { qrHtml = qrSvg(`${server}/#${room}`, 5); $("qr").innerHTML = qrHtml; },
    onState: (s, d) => {
      if (s === "waiting") { $("qr").className = ""; if (qrHtml) $("qr").innerHTML = qrHtml; $("sub").style.display = ""; $("drop").classList.remove("on"); setStatus("Waiting for your phone…"); }
      else if (s === "negotiating") setStatus("Phone found — connecting…");
      else if (s === "connected") { $("qr").className = "ok"; $("qr").textContent = "✓"; $("sub").style.display = "none"; $("drop").classList.add("on"); setStatus("Phone connected — drop files below, or send from your phone", "ok"); }
      else if (s === "stuck") setStatus("Can't link directly. Same Wi-Fi? Or enable a TURN relay on your server.", "err");
      else if (s === "disconnected" || s === "failed") setStatus("Connection lost — reload this page for a new code.", "err");
      else if (s === "signal-closed") setStatus("Lost connection to the QR Drop server.", "err");
      else if (s === "error") setStatus(errText[d] || "Server error: " + d, "err");
    },
    onBatch: () => true,
    onProgress: (p) => {
      $("bw").classList.add("on");
      $("bar").style.width = (p.total ? Math.round((p.done / p.total) * 100) : 100) + "%";
      $("info").textContent = `${p.dir === "in" ? "Receiving" : "Sending"} ${p.name} · ${formatBytes(p.done)} / ${formatBytes(p.total)} · ${formatBytes(p.speed)}/s`;
    },
    onFiles: (files) => {
      for (const f of files) {
        const a = document.createElement("a");
        a.href = URL.createObjectURL(f); a.download = f.name;
        a.innerHTML = `<span></span><span>${formatBytes(f.size)} ⬇</span>`;
        a.firstChild.textContent = f.name;
        $("got").prepend(a);
      }
      setStatus(`Received ${files.length} file${files.length > 1 ? "s" : ""} ✓ — click to save`, "ok");
    },
    onSent: () => { setStatus("Sent to phone ✓", "ok"); $("bw").classList.remove("on"); $("info").textContent = ""; },
    onError: (e) => setStatus(e.message, "err"),
  });
  session.start();

  const send = (files) => {
    if (!files.length || session.state !== "connected") return;
    setStatus("Sending to phone…");
    session.sendFiles(files).catch((e) => setStatus(e.code === "rejected" ? "Phone declined: " + e.message : e.message, "err"));
  };
  $("drop").onclick = () => $("picker").click();
  $("picker").onchange = (e) => { send([...e.target.files]); e.target.value = ""; };
  ["dragover", "dragenter"].forEach((t) => document.addEventListener(t, (e) => { e.preventDefault(); $("drop").classList.add("over"); }));
  ["dragleave", "drop"].forEach((t) => document.addEventListener(t, (e) => { e.preventDefault(); $("drop").classList.remove("over"); }));
  document.addEventListener("drop", (e) => send([...e.dataTransfer.files]));
})();
