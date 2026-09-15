/** Pont typé window.guga (contextBridge) — seul accès du renderer au monde extérieur (§9.1, §10.2). */
const { contextBridge, ipcRenderer } = require("electron");

const call = (method, path, body, headers) => ipcRenderer.invoke("api", { method, path, body, headers });

contextBridge.exposeInMainWorld("guga", {
  get: (path) => call("GET", path),
  post: (path, body, headers) => call("POST", path, body, headers),
  put: (path, body) => call("PUT", path, body),
  patch: (path, body) => call("PATCH", path, body),
  del: (path) => call("DELETE", path),
  /** Action du plan d'action : demande un jeton d'intention puis exécute (deux appels distincts, jamais fusionnés). */
  async act(action, targetIds, path, body) {
    const intent = await call("POST", "/intents", { action, targetIds });
    if (intent.status !== 200) return intent;
    return call("POST", path, body, { "x-guga-intent": intent.body.token });
  },
  onEvent: (fn) => { const h = (_e, p) => fn(p); ipcRenderer.on("guga:event", h); return () => ipcRenderer.off("guga:event", h); },
  onCallPrefill: (fn) => ipcRenderer.on("guga:call-prefill", (_e, p) => fn(p)),
  openExternal: (url) => ipcRenderer.invoke("open-external", url),
  openCallPopup: (prefill) => ipcRenderer.invoke("open-call-popup", prefill),
  closeSelf: () => ipcRenderer.invoke("close-self"),
  notify: (title, body) => ipcRenderer.invoke("notify", { title, body }),
  saveFile: (suggestedName, content) => ipcRenderer.invoke("save-file", { suggestedName, content }),
  attachmentUrl: (messageId, attachmentId) => ipcRenderer.invoke("attachment-url", { messageId, attachmentId }),
  secretSet: (key, value) => ipcRenderer.invoke("secret-set", { key, value }),
});
