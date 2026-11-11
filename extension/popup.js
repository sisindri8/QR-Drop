const $ = (id) => document.getElementById(id);
const msg = (t, k) => { $("msg").textContent = t; $("msg").className = k || ""; };
chrome.storage.sync.get({ server: self.QRD_DEFAULT_SERVER, confirm: true, pickerHook: true }).then((s) => {
  $("server").value = /YOUR-APP/.test(s.server) ? "" : s.server;
  $("confirm").checked = s.confirm;
  $("pickerHook").checked = s.pickerHook;
});
$("open").onclick = () => chrome.tabs.create({ url: chrome.runtime.getURL("transfer.html") });
$("save").onclick = async () => {
  let server = $("server").value.trim().replace(/\/+$/, "");
  if (server && !/^https?:\/\//.test(server)) server = "https://" + server;
  await chrome.storage.sync.set({ server, confirm: $("confirm").checked, pickerHook: $("pickerHook").checked });
  if (!server) return msg("Enter your server address.", "err");
  msg("Testing…");
  try {
    const r = await fetch(server + "/healthz", { cache: "no-store" });
    msg(r.ok ? "Saved — server reachable ✓" : "Saved, but server answered " + r.status, r.ok ? "ok" : "err");
  } catch (_) {
    msg("Saved, but can't reach it (free hosts can take ~30s to wake — try again).", "err");
  }
};
