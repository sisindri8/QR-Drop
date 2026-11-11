/* QR Drop — content script (runs on every page and iframe).
 *  1. Finds file inputs (visible, hidden, in open shadow DOM, created dynamically).
 *  2. Shows a QR badge next to each; click -> modal with a QR code.
 *  3. Pairs with the phone through the shared Session (signaling goes via background.js).
 *  4. Injects received files into the input as if the user had picked them. */
(function () {
  "use strict";
  if (window.__qrdrop) return;
  window.__qrdrop = true;
  const { Session, formatBytes, qrSvg } = self.QRD;

  const getSettings = () =>
    chrome.storage.sync.get({ server: self.QRD_DEFAULT_SERVER, confirm: true, pickerHook: true });

  // ------------------------------------------------------------------ shadow UI root
  let host = null;
  let root = null;
  const CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
    .badge { position: fixed; width: 26px; height: 26px; border-radius: 7px; border: 0; padding: 0;
      display: none; align-items: center; justify-content: center; cursor: pointer;
      background: #10b981; color: #fff; box-shadow: 0 2px 8px rgba(0,0,0,.35); opacity: .9;
      transition: transform .12s, opacity .12s; }
    .badge:hover { opacity: 1; transform: scale(1.12); }
    .badge svg { width: 16px; height: 16px; }
    .overlay { position: fixed; inset: 0; background: rgba(8,10,14,.55); display: flex;
      align-items: center; justify-content: center; padding: 12px; }
    .modal { position: relative; width: 340px; max-width: 100%; max-height: 100%; overflow: auto;
      background: #14181f; color: #e5e7eb; border-radius: 16px; padding: 22px 20px 16px;
      text-align: center; box-shadow: 0 20px 60px rgba(0,0,0,.5); }
    .close { position: absolute; top: 8px; right: 10px; background: none; border: 0; color: #9ca3af;
      font-size: 22px; cursor: pointer; line-height: 1; }
    .close:hover { color: #fff; }
    h2 { margin: 0 0 4px; font-size: 17px; color: #d1fae5; font-weight: 600; }
    .sub { margin: 0 0 12px; font-size: 12.5px; color: #9ca3af; }
    .qr { background: #fff; border-radius: 10px; padding: 6px; width: 210px; height: 210px; margin: 0 auto 10px;
      display: flex; align-items: center; justify-content: center; color: #6b7280; font-size: 13px; }
    .qr svg { width: 100%; height: 100%; display: block; }
    .qr.ok { background: #064e3b; color: #6ee7b7; font-size: 54px; }
    .status { font-size: 13.5px; min-height: 18px; color: #cbd5e1; margin: 4px 0 8px; }
    .status.ok { color: #34d399; } .status.err { color: #f87171; }
    .barwrap { display: none; height: 6px; background: #252b36; border-radius: 4px; overflow: hidden; margin: 6px 0; }
    .barwrap.on { display: block; }
    .bar { height: 100%; width: 0; background: #10b981; transition: width .08s linear; }
    .info { font-size: 12px; color: #9ca3af; min-height: 16px; word-break: break-all; }
    .prompt { display: none; background: #1d2430; border-radius: 10px; padding: 10px; margin: 8px 0; font-size: 13px; }
    .prompt.on { display: block; }
    .row { display: flex; gap: 8px; justify-content: center; margin-top: 8px; }
    button.btn { border: 0; border-radius: 8px; padding: 8px 14px; font-size: 13px; cursor: pointer;
      background: #10b981; color: #052e22; font-weight: 600; }
    button.btn.ghost { background: #252b36; color: #e5e7eb; }
    .send { display: none; margin-top: 6px; }
    .send.on { display: block; }
    .foot { margin: 12px 0 0; font-size: 11px; color: #6b7280; }
    .chip { position: fixed; right: 16px; bottom: 16px; display: flex; align-items: center; gap: 4px;
      background: #14181f; color: #e5e7eb; border-radius: 999px; padding: 4px 4px 4px 14px; font-size: 13px;
      box-shadow: 0 6px 24px rgba(0,0,0,.45); }
    .chip button { background: none; border: 0; color: inherit; cursor: pointer; font-size: 13px; padding: 6px 10px; }
    .chip .go { color: #34d399; font-weight: 600; padding: 6px 4px; }
    .chooser { position: fixed; inset: 0; background: rgba(8,10,14,.45); display: flex;
      align-items: center; justify-content: center; padding: 12px; }
    .chooser .box { background: #14181f; color: #e5e7eb; border-radius: 14px; padding: 16px 18px;
      width: 300px; max-width: 100%; text-align: center; box-shadow: 0 20px 60px rgba(0,0,0,.5); }
    .chooser h3 { margin: 0 0 12px; font-size: 15px; color: #d1fae5; font-weight: 600; }
    .chooser .row { flex-direction: column; }
    .toast { position: fixed; right: 16px; bottom: 16px; background: #064e3b; color: #d1fae5; padding: 10px 14px;
      border-radius: 10px; font-size: 13px; box-shadow: 0 6px 24px rgba(0,0,0,.4); }
  `;

  function ensureRoot() {
    if (root && host.isConnected) return root;
    host = document.createElement("qr-drop-root");
    host.style.cssText = "all:initial;position:fixed;top:0;left:0;width:0;height:0;z-index:2147483647;";
    root = host.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = CSS;
    root.appendChild(style);
    (document.documentElement || document.body).appendChild(host);
    // Re-attach existing badges if the page wiped the DOM.
    for (const b of badges.values()) root.appendChild(b.el);
    return root;
  }

  // ------------------------------------------------------------------ file input detection
  const badges = new Map(); // input -> { el }
  const BADGE_SVG =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M14 14h3v3h-3zM18 18h3v3h-3zM14 18h0M18 14h0"/></svg>';

  function attach(input) {
    if (badges.has(input) || input.type !== "file") return;
    ensureRoot();
    const el = document.createElement("button");
    el.className = "badge";
    el.title = "Upload from phone (QR Drop)";
    el.innerHTML = BADGE_SVG;
    el.addEventListener("mousedown", (e) => e.preventDefault());
    el.addEventListener("mouseenter", () => { try { chrome.runtime.sendMessage({ t: "warm" }).catch(() => {}); } catch (_) {} }, { once: true });
    el.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      openModal({ kind: "input", el: input, accept: input.accept || "", multiple: input.multiple });
    });
    root.appendChild(el);
    badges.set(input, { el });
    scheduleReposition();
  }

  function deepScan(node) {
    const out = [];
    const walk = (n) => {
      if (!n.querySelectorAll) return;
      n.querySelectorAll('input[type="file"]').forEach((i) => out.push(i));
      for (const el of n.querySelectorAll("*")) if (el.shadowRoot) walk(el.shadowRoot);
    };
    walk(node);
    out.forEach(attach);
  }

  function visibleRect(el) {
    const r = el.getBoundingClientRect();
    if (r.width < 8 || r.height < 8) return null;
    const cs = getComputedStyle(el);
    if (cs.visibility === "hidden" || cs.display === "none" || parseFloat(cs.opacity) === 0) return null;
    return r;
  }

  /** Hidden inputs (opacity:0, 1px, display:none) -> anchor to their label / nearest visible wrapper. */
  function pickAnchor(input) {
    if (visibleRect(input)) return input;
    const cands = [];
    if (input.labels) cands.push(...input.labels);
    const lab = input.closest && input.closest("label");
    if (lab) cands.push(lab);
    let p = input.parentElement;
    for (let i = 0; i < 5 && p; i++, p = p.parentElement) cands.push(p);
    for (const c of cands) {
      const r = visibleRect(c);
      if (r && r.width <= 900 && r.height <= 420) return c;
    }
    return null;
  }

  let rafPending = false;
  function scheduleReposition() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      reposition();
    });
  }

  function reposition() {
    for (const [input, b] of badges) {
      if (!input.isConnected) {
        b.el.remove();
        badges.delete(input);
        continue;
      }
      const anchor = input.disabled ? null : pickAnchor(input);
      const r = anchor && anchor.getBoundingClientRect();
      if (!r || r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) {
        b.el.style.display = "none";
        continue;
      }
      let left = r.right + 6;
      if (left + 28 > innerWidth) left = Math.max(2, r.right - 30);
      b.el.style.display = "flex";
      b.el.style.left = left + "px";
      b.el.style.top = Math.max(2, r.top + r.height / 2 - 13) + "px";
    }
  }

  let scanTimer = null;
  function scheduleScan() {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(() => {
      const run = () => {
        deepScan(document);
        scheduleReposition();
      };
      "requestIdleCallback" in window ? requestIdleCallback(run, { timeout: 1500 }) : run();
    }, 500);
  }

  deepScan(document);
  addEventListener("scroll", scheduleReposition, { passive: true, capture: true });
  addEventListener("resize", scheduleReposition, { passive: true });
  new MutationObserver((muts) => {
    for (const m of muts) {
      if (m.target === document.documentElement && [...m.addedNodes].every((n) => n === host)) continue;
      scheduleScan();
      return;
    }
  }).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["style", "class", "hidden", "disabled"] });
  setInterval(() => badges.size && scheduleReposition(), 1500); // catches CSS-only layout shifts

  // ------------------------------------------------------------------ programmatic click() chip + context menu
  let lastCtx = null;
  document.addEventListener("contextmenu", (e) => (lastCtx = e.composedPath()[0] || e.target), true);

  addEventListener("message", (e) => {
    const d = e.data;
    if (e.source !== window || !d || d.qrdrop !== 1 || d.t !== "file-click") return;
    if (navigator.userActivation && !navigator.userActivation.isActive) return;
    showChip({ kind: "registry", id: d.id, accept: d.accept, multiple: d.multiple });
  });

  // Sites that call showOpenFilePicker(): hook.js asks us; we answer with phone files, "native", or cancel.
  addEventListener("message", async (e) => {
    const d = e.data;
    if (e.source !== window || !d || d.qrdrop !== 1 || d.t !== "picker-open") return;
    const reply = (t, extra) => window.postMessage({ qrdrop: 1, t, id: d.id, ...extra }, "*");
    let settings;
    try { settings = await getSettings(); } catch (_) { return; } // hook.js falls back to native on its own
    if (settings.pickerHook === false || /YOUR-APP/.test(settings.server || "")) return reply("picker-native");
    reply("picker-ack");
    showChooser(d, reply);
  });

  function showChooser(d, reply) {
    ensureRoot();
    root.querySelectorAll(".chooser").forEach((c) => c.remove());
    const wrap = document.createElement("div");
    wrap.className = "chooser";
    wrap.innerHTML =
      '<div class="box"><h3>Choose a file from…</h3><div class="row">' +
      '<button class="btn phone">📱 My phone</button>' +
      '<button class="btn ghost comp">💻 This computer</button>' +
      '<button class="btn ghost cancel">Cancel</button></div></div>';
    let answered = false;
    const onKey = (ev) => ev.key === "Escape" && finish("picker-cancel");
    const finish = (t) => {
      if (answered) return;
      answered = true;
      document.removeEventListener("keydown", onKey, true);
      wrap.remove();
      if (t === "phone") openModal({ kind: "picker", id: d.id, accept: d.accept, multiple: d.multiple, reply });
      else reply(t);
    };
    document.addEventListener("keydown", onKey, true);
    wrap.querySelector(".phone").onclick = () => finish("phone");
    wrap.querySelector(".comp").onclick = () => finish("picker-native");
    wrap.querySelector(".cancel").onclick = () => finish("picker-cancel");
    wrap.addEventListener("mousedown", (ev) => ev.target === wrap && finish("picker-cancel"));
    root.appendChild(wrap);
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.t === "ctx") openModal({ kind: "drop", el: lastCtx || document.body, accept: "", multiple: true });
  });

  let chipTimer = null;
  function showChip(target) {
    ensureRoot();
    root.querySelectorAll(".chip").forEach((c) => c.remove());
    const chip = document.createElement("div");
    chip.className = "chip";
    chip.innerHTML = '<button class="go">📱 Upload from phone</button><button class="x" aria-label="Dismiss">×</button>';
    chip.querySelector(".go").onclick = () => {
      chip.remove();
      openModal(target);
    };
    chip.querySelector(".x").onclick = () => chip.remove();
    root.appendChild(chip);
    clearTimeout(chipTimer);
    chipTimer = setTimeout(() => chip.remove(), 9000);
  }

  // ------------------------------------------------------------------ signaling over the background port
  function makePortSignal() {
    const port = chrome.runtime.connect({ name: "qrd-signal" });
    const s = {
      onmessage: null,
      onclose: null,
      send: (m) => { try { port.postMessage(m); } catch (_) {} },
      close: () => { try { port.disconnect(); } catch (_) {} },
    };
    port.onMessage.addListener((m) => {
      if (m.t === "closed") s.onclose && s.onclose();
      else s.onmessage && s.onmessage(m);
    });
    port.onDisconnect.addListener(() => s.onclose && s.onclose());
    return s;
  }

  // ------------------------------------------------------------------ file injection
  function findInputNear(el) {
    if (!el || !el.closest) return null;
    const direct = el.closest('input[type="file"]');
    if (direct) return direct;
    const lab = el.closest("label");
    if (lab && lab.control && lab.control.type === "file") return lab.control;
    const inside = el.querySelector && el.querySelector('input[type="file"]');
    if (inside) return inside;
    const wrap = el.closest("form, [class*=upload], [class*=drop], [id*=upload], [id*=drop]");
    return (wrap && wrap.querySelector('input[type="file"]')) || null;
  }

  function setInputFiles(input, files) {
    const list = input.multiple ? files : files.slice(0, 1);
    const dt = new DataTransfer();
    list.forEach((f) => dt.items.add(f));
    input.files = dt.files;
    input.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    input.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
  }

  function dispatchDrop(el, files) {
    const dt = new DataTransfer();
    files.forEach((f) => dt.items.add(f));
    for (const type of ["dragenter", "dragover", "drop"]) {
      el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, composed: true, dataTransfer: dt }));
    }
  }

  function injectFiles(target, files) {
    if (target.kind === "input") return setInputFiles(target.el, files);
    if (target.kind === "picker") {
      target.settled = true;
      const list = target.multiple ? files : files.slice(0, 1);
      return target.reply("picker-files", { files: list });
    }
    if (target.kind === "registry") return window.postMessage({ qrdrop: 1, t: "inject", id: target.id, files }, "*");
    // right-click "receive here": prefer a real file input nearby, else simulate a drag-and-drop.
    const input = findInputNear(target.el);
    if (input) return setInputFiles(input, files);
    dispatchDrop(target.el || document.body, files);
  }

  // ------------------------------------------------------------------ modal
  const MODAL_HTML = `
    <div class="modal" role="dialog" aria-label="QR Drop">
      <button class="close" aria-label="Close">×</button>
      <h2>Phone ⇄ computer</h2>
      <p class="sub">Scan with your phone camera</p>
      <div class="qr">Preparing…</div>
      <div class="status">Starting…</div>
      <div class="prompt">
        <div class="ptext"></div>
        <div class="row"><button class="btn yes">Accept</button><button class="btn ghost no">Decline</button></div>
      </div>
      <div class="barwrap"><div class="bar"></div></div>
      <div class="info"></div>
      <div class="send"><button class="btn ghost sendbtn">Send a file to phone ›</button><input type="file" multiple hidden></div>
      <p class="foot">Direct peer-to-peer · files never touch a server</p>
    </div>`;

  let current = null;
  function closeModal() {
    current && current.close();
  }

  async function openModal(target) {
    closeModal();
    ensureRoot();
    const settings = await getSettings();
    const wrap = document.createElement("div");
    wrap.className = "overlay";
    wrap.innerHTML = MODAL_HTML;
    root.appendChild(wrap);
    const $ = (s) => wrap.querySelector(s);
    const ui = {
      sub: $(".sub"), qr: $(".qr"), status: $(".status"), prompt: $(".prompt"), ptext: $(".ptext"),
      bar: $(".bar"), barwrap: $(".barwrap"), info: $(".info"), send: $(".send"), sendbtn: $(".sendbtn"),
      picker: $('input[type="file"]'),
    };
    const setStatus = (t, kind) => { ui.status.textContent = t; ui.status.className = "status" + (kind ? " " + kind : ""); };

    let session = null;
    let closed = false;
    let qrHtml = "";
    const modal = {
      close() {
        if (closed) return;
        closed = true;
        if (target.kind === "picker" && !target.settled) { target.settled = true; target.reply("picker-cancel"); }
        session && session.close();
        wrap.remove();
        document.removeEventListener("keydown", onKey, true);
        if (current === modal) current = null;
      },
    };
    current = modal;
    const onKey = (e) => e.key === "Escape" && modal.close();
    document.addEventListener("keydown", onKey, true);
    $(".close").onclick = modal.close;
    wrap.addEventListener("mousedown", (e) => e.target === wrap && modal.close());

    let signal;
    try {
      signal = makePortSignal();
    } catch (_) {
      ui.qr.textContent = "⚠";
      return setStatus("QR Drop was updated — reload this page.", "err");
    }

    const server = (settings.server || "").replace(/\/+$/, "");
    const showQr = (on) => { ui.qr.style.display = on ? "flex" : "none"; ui.sub.style.display = on ? "" : "none"; };
    const barReset = () => { ui.barwrap.classList.remove("on"); ui.bar.style.width = "0"; ui.info.textContent = ""; };

    function ask(meta) {
      const n = meta.files.length;
      const size = formatBytes(meta.files.reduce((s, f) => s + f.size, 0));
      ui.ptext.textContent = `Receive ${n === 1 ? '"' + meta.files[0].name + '"' : n + " files"} (${size}) from your phone?`;
      ui.prompt.classList.add("on");
      return new Promise((resolve) => {
        const done = (v) => { ui.prompt.classList.remove("on"); resolve(v ? true : "Declined on computer"); };
        $(".yes").onclick = () => done(true);
        $(".no").onclick = () => done(false);
      });
    }

    const errText = {
      "no-server": "No QR Drop server set. Open the extension icon → Settings.",
      "server-unreachable": "Can't reach the QR Drop server. Check the address in settings.",
      "rate-limited": "Too many attempts — wait a minute.",
      expired: "This code expired. Close and try again.",
      "room-full": "Another phone is already connected.",
    };

    session = new Session({
      role: "host",
      signal,
      hello: { mode: target.kind, accept: target.accept || "", multiple: !!target.multiple },
      onRoom: (room) => {
        qrHtml = qrSvg(`${server}/#${room}`, 5);
        ui.qr.innerHTML = qrHtml;
      },
      onState: (s, detail) => {
        if (closed) return;
        switch (s) {
          case "waiting":
            ui.qr.classList.remove("ok");
            if (qrHtml) ui.qr.innerHTML = qrHtml;
            showQr(true);
            ui.send.classList.remove("on");
            setStatus("Waiting for your phone…");
            break;
          case "negotiating": setStatus("Phone found — connecting…"); break;
          case "connected":
            ui.qr.textContent = "✓";
            ui.qr.classList.add("ok");
            ui.sub.style.display = "none";
            ui.send.classList.add("on");
            setStatus("Phone connected — choose a file on your phone", "ok");
            break;
          case "stuck":
            setStatus("Can't link directly. Put phone and computer on the same Wi-Fi (or turn on a TURN relay).", "err");
            break;
          case "failed": setStatus("Connection failed — try scanning again.", "err"); break;
          case "disconnected": setStatus("Phone disconnected.", "err"); break;
          case "signal-closed": setStatus("Lost connection to the QR Drop server.", "err"); break;
          case "error": setStatus(errText[detail] || "Server error: " + detail, "err"); break;
        }
      },
      onBatch: async (meta) => {
        if (target.kind === "input" || target.kind === "registry" || target.kind === "picker") {
          if (!target.multiple && meta.files.length > 1) return "This upload field accepts only one file";
        }
        return settings.confirm ? ask(meta) : true;
      },
      onProgress: (p) => {
        ui.barwrap.classList.add("on");
        ui.bar.style.width = (p.total ? Math.round((p.done / p.total) * 100) : 100) + "%";
        const multi = p.fileCount > 1 ? ` (${p.fileIndex + 1}/${p.fileCount})` : "";
        ui.info.textContent = `${p.dir === "in" ? "Receiving" : "Sending"} ${p.name}${multi} · ${formatBytes(p.done)} / ${formatBytes(p.total)} · ${formatBytes(p.speed)}/s`;
      },
      onFiles: (files) => {
        try {
          injectFiles(target, files);
          setStatus(`Done — ${files.length === 1 ? files[0].name : files.length + " files"} added ✓`, "ok");
          toast(`${files.length === 1 ? '"' + files[0].name + '"' : files.length + " files"} added from phone`);
          setTimeout(modal.close, 1000);
        } catch (e) {
          setStatus("Couldn't attach the file: " + e.message, "err");
        }
      },
      onSent: () => { setStatus("Sent to phone ✓", "ok"); barReset(); },
      onError: (e) => setStatus(e.message || "Transfer error", "err"),
    });
    session.start();

    // desktop -> phone
    const sendToPhone = (files) => {
      if (!files.length) return;
      barReset();
      setStatus("Sending to phone…");
      session.sendFiles(files).catch((e) => {
        barReset();
        setStatus(e.code === "rejected" ? "Phone declined: " + e.message : e.message, "err");
      });
    };
    ui.sendbtn.onclick = () => ui.picker.click();
    ui.picker.onchange = () => { sendToPhone([...ui.picker.files]); ui.picker.value = ""; };
    wrap.addEventListener("dragover", (e) => e.preventDefault());
    wrap.addEventListener("drop", (e) => {
      e.preventDefault();
      if (session.state === "connected") sendToPhone([...e.dataTransfer.files]);
    });
  }

  function toast(msg) {
    ensureRoot();
    const t = document.createElement("div");
    t.className = "toast";
    t.textContent = msg;
    root.appendChild(t);
    setTimeout(() => t.remove(), 2800);
  }
})();
