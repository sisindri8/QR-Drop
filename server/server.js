// QR Drop server — three jobs, all tiny:
//   1. Serve the phone page (public/) over HTTPS (Render/Fly/etc. give you TLS).
//   2. WebSocket signaling at /ws: pairs one "host" (desktop) with one "guest"
//      (phone) in a random room and relays WebRTC handshake messages.
//   3. Hand out ICE servers (STUN + optional TURN) so TURN secrets never live
//      inside the extension.
// FILES NEVER TOUCH THIS SERVER. After the handshake they flow peer-to-peer.

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";

const PORT = process.env.PORT || 8787;
const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "public");

const ROOM_IDLE_TTL_MS = 10 * 60 * 1000; // unjoined room expires after 10 min
const ROOM_MAX_AGE_MS = 6 * 60 * 60 * 1000; // hard cap
const CREATE_LIMIT_PER_MIN = 30; // per IP
const MAX_MSG_BYTES = 64 * 1024; // SDP blobs are a few KB

// ---------------------------------------------------------------- ICE servers
const STUN = [{ urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] }];
let iceCache = { at: 0, value: STUN };

async function getIceServers() {
  if (Date.now() - iceCache.at < 10 * 60 * 1000) return iceCache.value;
  let value = STUN;
  try {
    const { METERED_DOMAIN, METERED_API_KEY, TURN_URLS, TURN_USERNAME, TURN_CREDENTIAL } = process.env;
    if (METERED_DOMAIN && METERED_API_KEY) {
      // Metered.ca free tier (50GB/mo relay). Returns a ready-made iceServers array.
      const r = await fetch(`https://${METERED_DOMAIN}/api/v1/turn/credentials?apiKey=${METERED_API_KEY}`);
      if (r.ok) value = [...STUN, ...(await r.json())];
    } else if (TURN_URLS && TURN_USERNAME && TURN_CREDENTIAL) {
      value = [...STUN, { urls: TURN_URLS.split(","), username: TURN_USERNAME, credential: TURN_CREDENTIAL }];
    }
  } catch (e) {
    console.warn("TURN credential fetch failed, using STUN only:", e.message);
  }
  iceCache = { at: Date.now(), value };
  return value;
}

// ---------------------------------------------------------------- static files
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".json": "application/json",
};

const server = http.createServer((req, res) => {
  let url;
  try {
    url = new URL(req.url, "http://x");
  } catch {
    res.writeHead(400);
    return res.end("bad request");
  }
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  // Extension warm-up ping (Render free tier sleeps) — also usable as a health check.
  if (url.pathname === "/healthz") {
    res.writeHead(200, { "Content-Type": "text/plain", "Access-Control-Allow-Origin": "*" });
    return res.end("ok");
  }
  let rel;
  try {
    rel = decodeURIComponent(url.pathname);
  } catch {
    res.writeHead(400);
    return res.end("bad request");
  }
  if (rel === "/") rel = "/index.html";
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (file !== PUBLIC_DIR && !file.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403);
    return res.end();
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404);
      return res.end("not found");
    }
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(file)] || "application/octet-stream",
      "Cache-Control": "no-cache",
    });
    res.end(data);
  });
});

// ---------------------------------------------------------------- signaling
/** room id -> { host: ws, guest: ws|null, created: number } */
const rooms = new Map();
const createLog = new Map(); // ip -> timestamps

function clientIp(req) {
  // The LAST X-Forwarded-For entry is the one our own proxy (Render/Fly/...) appended, so it is the
  // real client address. The first entry is client-controlled and trivially spoofed.
  // Set TRUST_PROXY=0 if the server is exposed directly to the internet (no proxy in front).
  if (process.env.TRUST_PROXY !== "0") {
    const xff = req.headers["x-forwarded-for"];
    if (xff) {
      const parts = String(xff).split(",").map((x) => x.trim()).filter(Boolean);
      if (parts.length) return parts[parts.length - 1];
    }
  }
  return req.socket.remoteAddress || "";
}
function rateLimited(ip) {
  const now = Date.now();
  const list = (createLog.get(ip) || []).filter((t) => now - t < 60_000);
  list.push(now);
  createLog.set(ip, list);
  return list.length > CREATE_LIMIT_PER_MIN;
}
const send = (ws, obj) => ws && ws.readyState === 1 && ws.send(JSON.stringify(obj));

const wss = new WebSocketServer({ server, path: "/ws", maxPayload: MAX_MSG_BYTES });

wss.on("connection", (ws, req) => {
  ws.isAlive = true;
  ws.on("pong", () => (ws.isAlive = true));
  const ip = clientIp(req);
  let roomId = null;
  let role = null;

  ws.on("message", async (raw) => {
    let m;
    try {
      m = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (m.t === "ping") return send(ws, { t: "pong" });

    if (m.t === "create" && !roomId) {
      if (rateLimited(ip)) return send(ws, { t: "error", code: "rate-limited" });
      roomId = crypto.randomBytes(16).toString("base64url"); // 128-bit, unguessable
      role = "host";
      rooms.set(roomId, { host: ws, guest: null, created: Date.now() });
      return send(ws, { t: "created", room: roomId, ice: await getIceServers() });
    }

    if (m.t === "join" && !roomId) {
      const room = typeof m.room === "string" && rooms.get(m.room);
      if (!room) return send(ws, { t: "error", code: "no-room" });
      if (room.guest) return send(ws, { t: "error", code: "room-full" });
      roomId = m.room;
      role = "guest";
      room.guest = ws;
      send(ws, { t: "joined", ice: await getIceServers() });
      return send(room.host, { t: "peer-joined" });
    }

    if (m.t === "sig" && roomId) {
      const room = rooms.get(roomId);
      if (!room) return;
      const other = role === "host" ? room.guest : room.host;
      return send(other, { t: "sig", d: m.d });
    }
  });

  ws.on("close", () => {
    const room = roomId && rooms.get(roomId);
    if (!room) return;
    if (role === "host") {
      send(room.guest, { t: "peer-left" });
      rooms.delete(roomId);
    } else if (room.guest === ws) {
      room.guest = null; // slot reopens so a reloaded phone page can rejoin
      send(room.host, { t: "peer-left" });
    }
  });
});

// Heartbeat + room expiry
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
  const now = Date.now();
  for (const [id, room] of rooms) {
    const idleExpired = !room.guest && now - room.created > ROOM_IDLE_TTL_MS;
    if (idleExpired || now - room.created > ROOM_MAX_AGE_MS) {
      send(room.host, { t: "error", code: "expired" });
      room.host && room.host.close();
      room.guest && room.guest.close();
      rooms.delete(id);
    }
  }
  for (const [ip, list] of createLog) if (!list.some((t) => now - t < 60_000)) createLog.delete(ip);
}, 25_000).unref();

server.listen(PORT, () => console.log(`QR Drop server on :${PORT}`));
export { server, wss };
