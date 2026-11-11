/* QR Drop — page-world hook (runs in the page's own JS world at document_start).
 *
 * 1. Many sites never show a visible <input type=file>: they create one in memory and call
 *    input.click() when you press their custom "Upload" button. We can't see those from the
 *    isolated content-script world, so we wrap click(), remember the input, and tell the content
 *    script. Later the content script asks us to put the received files into that exact input.
 *
 * 2. Sites using the File System Access API call window.showOpenFilePicker() instead of an input.
 *    We wrap it: the content script shows a small chooser ("From phone" / "This computer").
 *      - phone    -> we resolve with file-handle look-alikes backed by the received File objects
 *      - computer -> we call the browser's real picker (the click on our chooser re-grants the
 *                    user activation the real picker requires)
 *      - dismiss  -> we reject with an AbortError, exactly like cancelling the native dialog
 *    If the content script doesn't answer quickly (extension reloaded, disabled...), we fall
 *    straight through to the native picker so the site never breaks. */
(function () {
  "use strict";
  if (window.__qrdHook) return;
  window.__qrdHook = true;

  // ------------------------------------------------------------ input.click()
  const registry = new Map(); // id -> WeakRef(input)
  let seq = 0;
  const origClick = HTMLInputElement.prototype.click;

  HTMLInputElement.prototype.click = function () {
    try {
      if (this.type === "file" && !this.disabled) {
        const id = "qrd" + ++seq;
        registry.set(id, new WeakRef(this));
        if (registry.size > 50) registry.delete(registry.keys().next().value);
        window.postMessage(
          { qrdrop: 1, t: "file-click", id, accept: this.accept || "", multiple: !!this.multiple },
          "*"
        );
      }
    } catch (_) {}
    return origClick.apply(this, arguments);
  };

  // ------------------------------------------------------------ showOpenFilePicker()
  const ACK_TIMEOUT_MS = 800;
  const pending = new Map(); // id -> { native, resolve, reject, settled, timer }
  let pseq = 0;

  function acceptFromOptions(o) {
    const out = [];
    for (const t of (o && o.types) || []) {
      for (const [mime, exts] of Object.entries((t && t.accept) || {})) {
        out.push(mime);
        (Array.isArray(exts) ? exts : [exts]).forEach((x) => out.push(x));
      }
    }
    return out.join(",");
  }

  function fakeHandle(file) {
    const h = {
      kind: "file",
      name: file.name,
      getFile: async () => file,
      isSameEntry: async (other) => other === h,
      queryPermission: async () => "granted",
      requestPermission: async () => "granted",
    };
    return h;
  }

  const origPicker = typeof window.showOpenFilePicker === "function" ? window.showOpenFilePicker : null;
  if (origPicker) {
    window.showOpenFilePicker = function (options) {
      const self = this;
      const args = arguments;
      const native = () => origPicker.apply(self, args);
      const id = "qrp" + ++pseq;
      return new Promise((resolve, reject) => {
        const entry = { native, resolve, reject, settled: false, timer: null };
        pending.set(id, entry);
        // No answer from the content script -> don't trap the site; use the native picker.
        entry.timer = setTimeout(() => settle(id, "native"), ACK_TIMEOUT_MS);
        try {
          window.postMessage(
            { qrdrop: 1, t: "picker-open", id, accept: acceptFromOptions(options), multiple: !!(options && options.multiple) },
            "*"
          );
        } catch (_) {
          settle(id, "native");
        }
      });
    };
  }

  function settle(id, kind, files) {
    const e = pending.get(id);
    if (!e || e.settled) return;
    e.settled = true;
    clearTimeout(e.timer);
    pending.delete(id);
    if (kind === "native") e.native().then(e.resolve, e.reject);
    else if (kind === "files") e.resolve(files.map(fakeHandle));
    else e.reject(new DOMException("The user aborted a request.", "AbortError"));
  }

  // ------------------------------------------------------------ messages from the content script
  window.addEventListener("message", (e) => {
    const d = e.data;
    if (e.source !== window || !d || d.qrdrop !== 1) return;

    if (d.t === "inject") {
      const ref = registry.get(d.id);
      const input = ref && ref.deref();
      if (!input || !Array.isArray(d.files)) return;
      const dt = new DataTransfer();
      d.files.forEach((f) => dt.items.add(f));
      input.files = dt.files;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    } else if (d.t === "picker-ack") {
      // Content script is alive and showing the chooser: stop the fall-through timer.
      const p = pending.get(d.id);
      if (p) clearTimeout(p.timer);
    } else if (d.t === "picker-native") settle(d.id, "native");
    else if (d.t === "picker-files" && Array.isArray(d.files) && d.files.length) settle(d.id, "files", d.files);
    else if (d.t === "picker-cancel") settle(d.id, "cancel");
  });
})();
