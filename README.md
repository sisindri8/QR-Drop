# QR Drop v4 — phone ⇄ desktop file transfer for every website

Install the extension → every `<input type="file">` on every site gets a small green badge.
Click it, scan the QR with your phone, pick a file: it lands in the upload field.
Works the other way too: send files from the desktop to the phone.

Files travel **directly between the two devices (WebRTC)**. The server only introduces them.

```
extension/   Chrome/Edge/Brave/Opera/Arc (Manifest V3)
server/      Node: phone page + WebSocket signaling + TURN credentials   (deploy this)
shared/      session.js — the transfer engine used by both sides
test/        end-to-end tests (real WebRTC)
```

## 1. Deploy the server (5 min, free)

Render: push this repo to GitHub → **New → Blueprint** → select it (uses `render.yaml`).
Any Node host works (`cd server && npm install && npm start`; it reads `PORT`). It must be **HTTPS**
(phones need it for camera-scanned links + WebRTC); Render/Fly/Railway give you that.

> Render's free tier sleeps after ~15 min idle (first request takes ~30 s). The extension pings
> `/healthz` when you hover a badge to wake it early. For zero cold start use a paid instance,
> Fly.io, or a cron ping every 10 min.

## 2. Point the extension at it

The extension ships with a placeholder (`https://YOUR-APP.onrender.com`) because only you know your deployed URL. Either edit
`extension/lib/config.js` (`QRD_DEFAULT_SERVER`) before loading, or just load it: on first install a setup page
opens where you paste the URL → **Save & test connection** (the same box is in the toolbar popup any time).

## 3. Load the extension

`chrome://extensions` → Developer mode → **Load unpacked** → select `extension/`.

## Using it

| Situation | What to do |
|---|---|
| Normal upload field (visible or hidden behind a custom button) | Click the green badge next to it |
| Site opens the file dialog from its own "Upload" button | A **"📱 Upload from phone"** chip appears bottom-right for 9 s |
| Site uses the File System Access API (`showOpenFilePicker()`) | A **"Choose a file from… 📱 My phone / 💻 This computer"** chooser appears; pick phone, scan, done. "This computer" opens the normal dialog. Can be turned off in the popup |
| Drag-and-drop zone with no input at all | Right-click it → **QR Drop: receive a file from my phone here** |
| Computer → phone | In the modal click **Send a file to phone**, or drag files onto it. Or toolbar icon → **Send a file to my phone** |

The phone page reads the field's `accept` / `multiple` rules, so it only offers valid choices.
Multi-file selection works. On the phone, received files get **Save** and **Share/save to Photos**.

## Speed — what actually matters

* Direct WebRTC data channel, tuned: 128 KB messages, event-driven backpressure with a 10 MB high-water
  mark, 4 MB read-ahead, no per-chunk framing, receiver folds data into disk-backed Blobs.
  In my loopback test this sustained **~65 MB/s** (real Wi-Fi will be lower).
* **Real-world speed is set by the network path, not the code.** Same Wi-Fi/LAN → direct, fast
  (tens of MB/s on Wi-Fi 5/6). Different networks → STUN usually still finds a direct path; if not,
  traffic is **relayed through TURN**, which is slower and costs bandwidth.
* There's no magic faster protocol available to a browser extension: WebRTC (SCTP/DTLS) is the only
  peer-to-peer transport browsers expose. Parallel channels share one SCTP connection, so they don't
  add throughput; I deliberately did not add them.
* TURN setup (optional but recommended for phone-on-mobile-data): create a free app at metered.ca,
  then set `METERED_DOMAIN` and `METERED_API_KEY` on the server. See `server/.env.example`.

## Security model

* Room ID = 128-bit random, only ever in the QR's URL **fragment** (`/#room`, not sent in HTTP requests).
* A room holds exactly one host + one phone; others get `room-full`. Unjoined rooms expire in 10 min.
* The desktop asks **"Receive N file(s) from your phone?"** before any bytes flow
  (toggle in popup; default ON). Single-file fields refuse multi-file batches.
* Signaling runs in the extension's service worker, so sites' Content-Security-Policy can't block it
  and pages can't see the room.
* Create-room rate limit per IP; 64 KB max signaling message.
* The sender's TURN secrets live only on your server, never in the extension.

## Known limits (honest list)

* Chromium browsers only (service-worker + `world: MAIN` content scripts).
* Inputs inside **cross-origin iframes** get a badge, but the modal renders inside that iframe (fine if
  it's large; cramped if tiny). Closed shadow DOM inputs can't be seen; use the right-click path.
* `showOpenFilePicker()` is supported for **opening** files only (the phone's files come back as read-only handle look-alikes).
  `showSaveFilePicker()` / `showDirectoryPicker()` are not hooked, and a site that needs a handle it can *write back to* won't work with phone files.
* Several GB: received data is folded into Blobs, but the final `File` still has to be handed to the
  page, so very large files depend on the browser's Blob storage.
* The phone page must stay open and awake (it requests a screen wake lock). iOS may pause it if you leave the tab.
* If both devices block peer connections (AP isolation, strict corporate NAT) you need TURN.

## Tests

```
cd test && npm install
node e2e.mjs   # signaling + real WebRTC: batches, empty files, rejection, 200 MB sha256, rejoin
node ext.mjs   # real content.js/hook.js/background.js in jsdom: hidden inputs, shadow UI, injection, drop path,
               # showOpenFilePicker chooser + fallback, first-run setup
npm test       # runs both
```
Versions: the project, `manifest.json` and `server/package.json` are all **4.0.0**.

After editing `shared/session.js` run `scripts/sync.sh` to copy it into `extension/lib` and `server/public`.
