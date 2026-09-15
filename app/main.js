/**
 * Guga — processus principal Electron (§3.2, §9, §10.2).
 * - Fenêtre principale + icône de zone de notification (Tray).
 * - Popup « appel téléphonique » toujours au premier plan, raccourci global Ctrl+Alt+A (§7.14).
 * - Le renderer est isolé (contextIsolation, sandbox, nodeIntegration=false) ; il n'a jamais le
 *   jeton de session : le preload passe par IPC et c'est ce processus qui appelle l'API 127.0.0.1.
 * - Sous Windows, le service moteur tourne à part (WinSW). En développement, l'application peut
 *   lancer le moteur elle-même (GUGA_SPAWN_ENGINE=1).
 */
const { app, BrowserWindow, Tray, Menu, globalShortcut, ipcMain, shell, dialog, nativeImage, safeStorage, Notification } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const http = require("node:http");
const { spawn } = require("node:child_process");

const API_HOST = "127.0.0.1";
const API_PORT = Number(process.env.GUGA_API_PORT || 8765);
const DATA_DIR = process.env.GUGA_DATA_DIR || (process.platform === "win32" ? path.join(process.env.LOCALAPPDATA || os.homedir(), "Guga") : path.join(os.homedir(), ".guga"));

let mainWin = null, callWin = null, tray = null, engineProc = null, sessionToken = null, sseReq = null;

function readSessionToken() {
  try { return fs.readFileSync(path.join(DATA_DIR, "session.token"), "utf8").trim(); } catch { return null; }
}

/** Appel HTTP vers l'API locale, avec le jeton de session (jamais transmis au renderer). */
function apiRequest(method, urlPath, body, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    if (!sessionToken) sessionToken = readSessionToken();
    const data = body === undefined ? null : JSON.stringify(body);
    const req = http.request({ host: API_HOST, port: API_PORT, path: urlPath, method, headers: {
      authorization: `Bearer ${sessionToken}`, ...(data ? { "content-type": "application/json", "content-length": Buffer.byteLength(data) } : {}), ...extraHeaders,
    } }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const raw = Buffer.concat(chunks);
        const ct = res.headers["content-type"] || "";
        if (res.statusCode === 401) { sessionToken = readSessionToken(); }
        if (ct.includes("json")) { try { resolve({ status: res.statusCode, body: JSON.parse(raw.toString("utf8")) }); } catch { resolve({ status: res.statusCode, body: null }); } }
        else resolve({ status: res.statusCode, body: raw.toString("utf8"), contentType: ct });
      });
    });
    req.on("error", reject);
    req.setTimeout(60_000, () => req.destroy(new Error("délai dépassé")));
    if (data) req.write(data);
    req.end();
  });
}

/** Abonnement SSE relayé vers les fenêtres. */
function connectEvents() {
  if (sseReq) sseReq.destroy();
  if (!sessionToken) sessionToken = readSessionToken();
  const req = http.request({ host: API_HOST, port: API_PORT, path: "/events", headers: { authorization: `Bearer ${sessionToken}`, accept: "text/event-stream" } }, (res) => {
    let buf = "";
    res.on("data", (c) => {
      buf += c.toString("utf8");
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, i); buf = buf.slice(i + 2);
        const type = (block.match(/^event: (.+)$/m) || [])[1];
        const data = (block.match(/^data: (.+)$/m) || [])[1];
        if (type && data) broadcast("guga:event", { type, data: JSON.parse(data) });
      }
    });
    res.on("end", () => setTimeout(connectEvents, 3000));
  });
  req.on("error", () => setTimeout(connectEvents, 3000));
  req.end();
  sseReq = req;
}

function broadcast(channel, payload) {
  for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send(channel, payload);
}

function createMainWindow() {
  if (mainWin) { mainWin.show(); mainWin.focus(); return mainWin; }
  mainWin = new BrowserWindow({
    width: 1440, height: 900, minWidth: 980, minHeight: 600, show: false, title: "Guga",
    backgroundColor: "#f6f7f9",
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: true },
  });
  mainWin.loadFile(path.join(__dirname, "renderer", "index.html"));
  mainWin.once("ready-to-show", () => mainWin.show());
  mainWin.on("close", (e) => { if (!app.isQuiting) { e.preventDefault(); mainWin.hide(); } });
  mainWin.on("closed", () => { mainWin = null; });
  mainWin.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) shell.openExternal(url); return { action: "deny" }; });
  return mainWin;
}

function openCallPopup(prefill = {}) {
  if (callWin && !callWin.isDestroyed()) { callWin.show(); callWin.focus(); callWin.webContents.send("guga:call-prefill", prefill); return; }
  callWin = new BrowserWindow({
    width: 520, height: 620, alwaysOnTop: true, resizable: true, minimizable: false, title: "Guga — Appel téléphonique", backgroundColor: "#ffffff",
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  callWin.setAlwaysOnTop(true, "floating");
  callWin.loadFile(path.join(__dirname, "renderer", "call.html"));
  callWin.once("ready-to-show", () => callWin.webContents.send("guga:call-prefill", prefill));
  callWin.on("closed", () => { callWin = null; });
}

function createTray() {
  const icon = nativeImage.createFromDataURL("data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAaklEQVQ4T2NkoBAwUqifgWoG/P//n4EYwMjIiKKOLAP+//8fD8QNRBiQgKYRZAAjIyMD0IAJQHwADRvUyMDAIEDIAKAaAxD3A7EGkYGwAt0TDPxfwBiIf4BcgS6AZgCSAQxUyQwUZyaKDQAAqQwnVGsyNK4AAAAASUVORK5CYII=");
  tray = new Tray(icon);
  tray.setToolTip("Guga — pilotage des e-mails du cabinet");
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "Ouvrir Guga", click: () => createMainWindow() },
    { label: "Notifier un appel (Ctrl+Alt+A)", click: () => openCallPopup() },
    { type: "separator" },
    { label: "Synchroniser maintenant", click: () => apiRequest("POST", "/sync").catch(() => {}) },
    { label: "Dossier de données", click: () => shell.openPath(DATA_DIR) },
    { type: "separator" },
    { label: "Quitter", click: () => { app.isQuiting = true; app.quit(); } },
  ]));
  tray.on("double-click", () => createMainWindow());
}

function maybeSpawnEngine() {
  if (process.env.GUGA_SPAWN_ENGINE !== "1") return;
  const candidates = [path.join(process.resourcesPath || "", "engine", "index.js"), path.join(__dirname, "..", "engine", "dist", "index.js")];
  const entry = candidates.find((p) => fs.existsSync(p));
  if (!entry) return;
  engineProc = spawn(process.execPath, [entry], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", GUGA_DATA_DIR: DATA_DIR }, stdio: "ignore" });
  engineProc.on("exit", () => { engineProc = null; });
}

// --- IPC exposé au preload (le renderer n'a accès qu'à ces canaux) --------
ipcMain.handle("api", async (_e, { method, path: p, body, headers }) => {
  const allowed = { "x-guga-intent": headers?.["x-guga-intent"] };
  return apiRequest(method, p, body, Object.fromEntries(Object.entries(allowed).filter(([, v]) => v)));
});
ipcMain.handle("open-external", async (_e, url) => { if (/^https?:\/\//.test(url)) await shell.openExternal(url); });
ipcMain.handle("open-call-popup", async (_e, prefill) => openCallPopup(prefill || {}));
ipcMain.handle("close-self", async (e) => BrowserWindow.fromWebContents(e.sender)?.close());
ipcMain.handle("notify", async (_e, { title, body }) => { if (Notification.isSupported()) new Notification({ title, body }).show(); });
ipcMain.handle("save-file", async (e, { suggestedName, content }) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const r = await dialog.showSaveDialog(win, { defaultPath: suggestedName });
  if (r.canceled || !r.filePath) return null;
  fs.writeFileSync(r.filePath, content);
  return r.filePath;
});
ipcMain.handle("attachment-url", async (_e, { messageId, attachmentId }) => {
  if (!sessionToken) sessionToken = readSessionToken();
  return `http://${API_HOST}:${API_PORT}/messages/${messageId}/attachments/${attachmentId}?token=${encodeURIComponent(sessionToken)}`;
});
ipcMain.handle("secret-set", async (_e, { key, value }) => {
  // DPAPI (safeStorage) côté application : le blob chiffré est remis au service par fichier 0600.
  const enc = safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(value).toString("base64") : Buffer.from(value).toString("base64");
  const file = path.join(DATA_DIR, "secrets.app.json");
  let cur = {}; try { cur = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
  cur[key] = { enc, dpapi: safeStorage.isEncryptionAvailable() };
  fs.writeFileSync(file, JSON.stringify(cur), { mode: 0o600 });
  return true;
});

app.whenReady().then(() => {
  maybeSpawnEngine();
  createTray();
  createMainWindow();
  connectEvents();
  const ok = globalShortcut.register("CommandOrControl+Alt+A", () => openCallPopup());
  if (!ok) console.warn("raccourci global indisponible");
  app.on("activate", () => createMainWindow());
});
app.on("window-all-closed", (e) => { /* reste dans la zone de notification */ });
app.on("before-quit", () => { app.isQuiting = true; globalShortcut.unregisterAll(); if (engineProc) engineProc.kill(); if (sseReq) sseReq.destroy(); });
