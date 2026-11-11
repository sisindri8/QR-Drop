/* QR Drop — shared session + transfer engine (used by the extension AND the phone page).
 *
 * One RTCDataChannel, tuned for throughput:
 *   - raw WebRTC (no PeerJS framing overhead)
 *   - 128KB messages when the peer allows it (falls back to 16KB)
 *   - event-driven backpressure (bufferedamountlow) instead of polling timers
 *   - 4MB read-ahead so disk reads overlap with network sends
 *   - receiver folds chunks into a Blob every 32MB so big files don't pile up in RAM
 *
 * Protocol (JSON control messages as strings, file bytes as binary):
 *   hello   {role, ...info}                 both ways, on channel open
 *   batch   {bid, files:[{name,size,mime}]} sender -> receiver ("may I send these?")
 *   batch-accept | batch-reject {bid,reason}
 *   file    {bid,i}   binary chunks...   end {bid,i}
 *   batch-done {bid, ok}                    receiver -> sender once everything arrived
 */
(function (global) {
  "use strict";

  const HIGH_WATER = 10 * 1024 * 1024; // pause sending above this many buffered bytes
  const LOW_WATER = 4 * 1024 * 1024; // resume when it drains below this
  const READ_BLOCK = 4 * 1024 * 1024;
  const FLUSH_BYTES = 32 * 1024 * 1024;
  const CONNECT_STUCK_MS = 25000;
  const ACCEPT_TIMEOUT_MS = 120000;

  const rid = () => {
    const a = new Uint8Array(8);
    crypto.getRandomValues(a);
    return Array.from(a, (b) => b.toString(16).padStart(2, "0")).join("");
  };

  function formatBytes(n) {
    if (!n) return "0 B";
    const u = ["B", "KB", "MB", "GB", "TB"];
    let i = 0;
    while (n >= 1024 && i < u.length - 1) {
      n /= 1024;
      i++;
    }
    return `${n.toFixed(n < 10 && i > 0 ? 1 : 0)} ${u[i]}`;
  }

  /** Render text as an inline SVG QR (needs the vendored qrcode-generator global). */
  function qrSvg(text, cell) {
    const qr = global.qrcode(0, "M");
    qr.addData(text);
    qr.make();
    return qr.createSvgTag({ cellSize: cell || 5, margin: 4, scalable: true });
  }

  const MAX_FILES_PER_BATCH = 1000;
  /** Returns an error string if a peer's "batch" message is malformed, else null. */
  function validateBatch(m) {
    if (!m || typeof m.bid !== "string" || !Array.isArray(m.files)) return "Malformed transfer request";
    if (m.files.length === 0 || m.files.length > MAX_FILES_PER_BATCH) return "Invalid number of files";
    for (const f of m.files) {
      if (!f || typeof f.name !== "string" || !Number.isSafeInteger(f.size) || f.size < 0) {
        return "Malformed transfer request";
      }
    }
    return null;
  }

  class Session {
    /**
     * opts:
     *  role: "host" | "guest"
     *  signal: { send(obj), onmessage, onclose, close() }
     *  room: (guest) room id to join
     *  hello: extra info to send the peer on open (e.g. {accept, multiple})
     *  onState(state, detail), onRoom(room), onPeerHello(msg)
     *  onBatch(meta) -> true | false | "reason string" | Promise of those
     *  onProgress(p), onFiles(files, meta), onSent(meta), onError(err)
     */
    constructor(opts) {
      this.o = opts;
      this.role = opts.role;
      this.signal = opts.signal;
      this.state = "new";
      this.pc = null;
      this.dc = null;
      this.iceServers = [];
      this._waiters = new Map();
      this._in = null;
      this._sending = false;
      this._lastTick = { in: 0, out: 0 };
      this._speed = { in: null, out: null };
    }

    // ------------------------------------------------------------ lifecycle
    start() {
      this.signal.onmessage = (m) => this._onSignal(m);
      this.signal.onclose = () => {
        if (this.state !== "closed") this._setState("signal-closed");
      };
      this._ping = setInterval(() => this.signal.send({ t: "ping" }), 20000);
      if (this.role === "host") this.signal.send({ t: "create" });
      else this.signal.send({ t: "join", room: this.o.room });
    }

    close() {
      this._setState("closed");
      clearInterval(this._ping);
      clearTimeout(this._stuck);
      this._rejectWaiters(new Error("closed"));
      this._closePeer();
      try {
        this.signal.close();
      } catch (_) {}
    }

    _setState(s, detail) {
      this.state = s;
      this.o.onState && this.o.onState(s, detail);
    }

    // ------------------------------------------------------------ signaling
    _onSignal(m) {
      switch (m.t) {
        case "created":
          this.room = m.room;
          this.iceServers = m.ice || [];
          this.o.onRoom && this.o.onRoom(m.room);
          this._setState("waiting");
          break;
        case "joined":
          this.iceServers = m.ice || [];
          this._setState("negotiating");
          break;
        case "peer-joined":
          this._setState("negotiating");
          this._newPeer(true);
          break;
        case "peer-left":
          this._rejectWaiters(new Error("Phone disconnected"));
          this._closePeer();
          this._setState(this.role === "host" ? "waiting" : "peer-left");
          break;
        case "sig":
          this._onSig(m.d).catch((e) => this._fail(e));
          break;
        case "error":
          this._setState("error", m.code);
          break;
      }
    }

    _fail(e) {
      this.o.onError && this.o.onError(e);
    }

    // ------------------------------------------------------------ WebRTC
    _newPeer(offerer) {
      this._closePeer();
      const pc = new RTCPeerConnection({ iceServers: this.iceServers });
      this.pc = pc;
      this._remoteSet = false;
      this._pendingIce = [];

      pc.onicecandidate = (e) => {
        if (e.candidate) this.signal.send({ t: "sig", d: { ice: e.candidate.toJSON() } });
      };
      pc.oniceconnectionstatechange = () => {
        if (pc.iceConnectionState === "failed") this._setState("failed");
      };

      clearTimeout(this._stuck);
      this._stuck = setTimeout(() => {
        if (this.state !== "connected" && this.state !== "closed") this._setState("stuck");
      }, CONNECT_STUCK_MS);

      if (offerer) {
        this._setupChannel(pc.createDataChannel("qrd", { ordered: true }));
        pc.createOffer()
          .then((o) => pc.setLocalDescription(o))
          .then(() => this.signal.send({ t: "sig", d: { sdp: pc.localDescription.toJSON() } }))
          .catch((e) => this._fail(e));
      } else {
        pc.ondatachannel = (e) => this._setupChannel(e.channel);
      }
    }

    async _onSig(d) {
      if (!this.pc) this._newPeer(false);
      const pc = this.pc;
      if (d.sdp) {
        await pc.setRemoteDescription(d.sdp);
        this._remoteSet = true;
        for (const c of this._pendingIce) await pc.addIceCandidate(c).catch(() => {});
        this._pendingIce = [];
        if (d.sdp.type === "offer") {
          await pc.setLocalDescription(await pc.createAnswer());
          this.signal.send({ t: "sig", d: { sdp: pc.localDescription.toJSON() } });
        }
      } else if (d.ice) {
        if (!this._remoteSet) this._pendingIce.push(d.ice);
        else await pc.addIceCandidate(d.ice).catch(() => {});
      }
    }

    _closePeer() {
      clearTimeout(this._stuck);
      try {
        this.dc && this.dc.close();
      } catch (_) {}
      try {
        this.pc && this.pc.close();
      } catch (_) {}
      this.dc = this.pc = null;
      this._in = null;
    }

    _setupChannel(dc) {
      dc.binaryType = "arraybuffer";
      dc.bufferedAmountLowThreshold = LOW_WATER;
      this.dc = dc;
      dc.onopen = () => {
        clearTimeout(this._stuck);
        const mm = this.pc && this.pc.sctp && this.pc.sctp.maxMessageSize;
        this.chunkSize = mm ? Math.min(131072, mm) : 16384;
        this._setState("connected");
        this._ctl({ t: "hello", role: this.role, ...(this.o.hello || {}) });
      };
      dc.onclose = () => {
        this._rejectWaiters(new Error("Connection closed"));
        if (this.state !== "closed" && this.state !== "waiting" && this.state !== "peer-left") {
          this._setState("disconnected");
        }
      };
      dc.onmessage = (e) => {
        if (typeof e.data === "string") {
          let m;
          try {
            m = JSON.parse(e.data);
          } catch (_) {
            return;
          }
          this._onCtl(m);
        } else {
          this._onChunk(e.data);
        }
      };
    }

    _ctl(obj) {
      if (this.dc && this.dc.readyState === "open") this.dc.send(JSON.stringify(obj));
    }

    // ------------------------------------------------------------ receiving
    _onCtl(m) {
      switch (m.t) {
        case "hello":
          this.peerHello = m;
          this.o.onPeerHello && this.o.onPeerHello(m);
          break;

        case "batch": {
          const bad = validateBatch(m);
          if (bad) {
            this._ctl({ t: "batch-reject", bid: m && m.bid, reason: bad });
            break;
          }
          Promise.resolve(this.o.onBatch ? this.o.onBatch(m) : true).then((verdict) => {
            if (verdict === true) {
              const total = m.files.reduce((s, f) => s + f.size, 0);
              this._in = { bid: m.bid, files: m.files, out: [], cur: null, total, done: 0, t0: performance.now() };
              this._ctl({ t: "batch-accept", bid: m.bid });
            } else {
              this._ctl({ t: "batch-reject", bid: m.bid, reason: typeof verdict === "string" ? verdict : "Declined" });
            }
          }).catch(() => this._ctl({ t: "batch-reject", bid: m.bid, reason: "Declined" }));
          break;
        }

        case "file": {
          const b = this._in;
          if (!b || b.bid !== m.bid) return;
          b.cur = { i: m.i, meta: b.files[m.i], pending: [], pendingBytes: 0, blob: new Blob([]), got: 0 };
          break;
        }

        case "end": {
          const b = this._in;
          if (!b || b.bid !== m.bid || !b.cur) return;
          this._finishFile(b);
          break;
        }

        case "batch-accept":
        case "batch-reject":
        case "batch-done":
          this._resolveWaiter(m.t + ":" + m.bid, m);
          break;
      }
    }

    _onChunk(buf) {
      const b = this._in;
      const c = b && b.cur;
      if (!c) return;
      const n = buf.byteLength;
      c.pending.push(buf);
      c.pendingBytes += n;
      c.got += n;
      b.done += n;
      if (c.pendingBytes >= FLUSH_BYTES) {
        // Fold into a Blob: browsers back large Blobs with disk, freeing JS memory.
        c.blob = new Blob([c.blob, ...c.pending]);
        c.pending = [];
        c.pendingBytes = 0;
      }
      this._tick("in", b, c.meta, c.i, c.got);
    }

    _finishFile(b) {
      const c = b.cur;
      b.cur = null;
      const type = c.meta.mime || "application/octet-stream";
      const blob = new Blob([c.blob, ...c.pending], { type });
      if (blob.size !== c.meta.size) {
        this._ctl({ t: "batch-done", bid: b.bid, ok: false });
        this._in = null;
        this._fail(new Error(`Size mismatch for ${c.meta.name} (${blob.size} of ${c.meta.size})`));
        return;
      }
      b.out.push(new File([blob], c.meta.name, { type, lastModified: c.meta.lastModified || Date.now() }));
      this._tick("in", b, c.meta, c.i, c.meta.size, true);
      if (b.out.length === b.files.length) {
        const files = b.out;
        this._in = null;
        this._ctl({ t: "batch-done", bid: b.bid, ok: true });
        this.o.onFiles && this.o.onFiles(files, { count: files.length, total: b.total });
      }
    }

    // ------------------------------------------------------------ sending
    /** Send an array of File objects. Resolves when the peer confirms receipt. */
    async sendFiles(files) {
      if (!this.dc || this.dc.readyState !== "open") throw new Error("Not connected");
      if (this._sending) throw new Error("A transfer is already running");
      this._sending = true;
      try {
        const bid = rid();
        const meta = files.map((f) => ({ name: f.name, size: f.size, mime: f.type, lastModified: f.lastModified }));
        const total = meta.reduce((s, f) => s + f.size, 0);

        const answer = this._wait("batch-accept:" + bid, "batch-reject:" + bid, ACCEPT_TIMEOUT_MS);
        this._ctl({ t: "batch", bid, files: meta });
        const verdict = await answer;
        if (verdict.t === "batch-reject") {
          const e = new Error(verdict.reason || "Declined");
          e.code = "rejected";
          throw e;
        }

        const out = { total, done: 0, t0: performance.now(), files: meta };
        const finished = this._wait("batch-done:" + bid, null, 60000);
        for (let i = 0; i < files.length; i++) {
          this._ctl({ t: "file", bid, i });
          await this._stream(files[i], out, meta[i], i);
          this._ctl({ t: "end", bid, i });
        }
        const done = await finished;
        if (!done.ok) throw new Error("Receiver reported an incomplete file");
        this.o.onSent && this.o.onSent({ count: files.length, total });
      } finally {
        this._sending = false;
      }
    }

    async _stream(file, out, meta, index) {
      const dc = this.dc;
      const chunk = this.chunkSize || 16384;
      let sent = 0;
      let next = file.size ? file.slice(0, READ_BLOCK).arrayBuffer() : null;
      for (let off = 0; off < file.size; off += READ_BLOCK) {
        const buf = await next;
        // Read the next block while we push this one into the network.
        if (off + READ_BLOCK < file.size) next = file.slice(off + READ_BLOCK, off + 2 * READ_BLOCK).arrayBuffer();
        for (let p = 0; p < buf.byteLength; p += chunk) {
          if (dc.readyState !== "open") throw new Error("Connection closed");
          if (dc.bufferedAmount > HIGH_WATER) await this._drain(dc);
          const len = Math.min(chunk, buf.byteLength - p);
          dc.send(new Uint8Array(buf, p, len));
          sent += len;
          out.done += len;
          this._tick("out", out, meta, index, sent);
        }
      }
      this._tick("out", out, meta, index, file.size, true);
    }

    _drain(dc) {
      // Event-driven (bufferedamountlow) with a slow poll as a safety net, so a
      // missed/never-fired event on some WebRTC stack can't stall a transfer.
      return new Promise((resolve, reject) => {
        let poll;
        const check = () => {
          if (dc.readyState !== "open") {
            cleanup();
            reject(new Error("Connection closed"));
          } else if (dc.bufferedAmount <= LOW_WATER) {
            cleanup();
            resolve();
          }
        };
        const cleanup = () => {
          clearInterval(poll);
          dc.removeEventListener("bufferedamountlow", check);
          dc.removeEventListener("close", check);
        };
        dc.addEventListener("bufferedamountlow", check);
        dc.addEventListener("close", check);
        poll = setInterval(check, 40);
        check();
      });
    }

    // ------------------------------------------------------------ progress
    _tick(dir, batch, meta, index, fileDone, force) {
      const now = performance.now();
      if (!force && now - this._lastTick[dir] < 90) return;
      this._lastTick[dir] = now;
      const elapsed = (now - batch.t0) / 1000 || 0.001;
      this.o.onProgress &&
        this.o.onProgress({
          dir,
          name: meta.name,
          fileIndex: index,
          fileCount: batch.files ? batch.files.length : undefined,
          fileDone,
          fileSize: meta.size,
          done: batch.done,
          total: batch.total,
          speed: batch.done / elapsed, // bytes/sec averaged over the batch
        });
    }

    // ------------------------------------------------------------ waiters
    _wait(keyA, keyB, timeoutMs) {
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => {
          this._waiters.delete(keyA);
          keyB && this._waiters.delete(keyB);
          reject(new Error("Timed out waiting for the other device"));
        }, timeoutMs);
        const entry = {
          resolve: (m) => {
            clearTimeout(t);
            this._waiters.delete(keyA);
            keyB && this._waiters.delete(keyB);
            resolve(m);
          },
          reject: (e) => {
            clearTimeout(t);
            reject(e);
          },
        };
        this._waiters.set(keyA, entry);
        if (keyB) this._waiters.set(keyB, entry);
      });
    }
    _resolveWaiter(key, m) {
      const w = this._waiters.get(key);
      if (w) w.resolve(m);
    }
    _rejectWaiters(err) {
      const seen = new Set();
      for (const w of this._waiters.values()) if (!seen.has(w)) (seen.add(w), w.reject(err));
      this._waiters.clear();
    }
  }

  global.QRD = { Session, formatBytes, qrSvg };
})(typeof self !== "undefined" ? self : globalThis);
