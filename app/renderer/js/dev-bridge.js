/** Pont window.guga pour le mode web de développement (remplace preload.js hors Electron). */
(function () {
  if (window.guga) return;
  const call = async (method, path, body, headers) => {
    const r = await fetch("/api" + path, { method, headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(headers || {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const ct = r.headers.get("content-type") || "";
    return { status: r.status, body: ct.includes("json") ? await r.json() : await r.text() };
  };
  const listeners = new Set();
  const es = new EventSource("/api/events");
  for (const t of ["hello", "placement", "sync", "backlog", "action", "alert", "call.incoming"]) es.addEventListener(t, (e) => { for (const fn of listeners) fn({ type: t, data: JSON.parse(e.data) }); });
  window.guga = {
    get: (p) => call("GET", p), post: (p, b, h) => call("POST", p, b, h), put: (p, b) => call("PUT", p, b), patch: (p, b) => call("PATCH", p, b), del: (p) => call("DELETE", p),
    async act(action, targetIds, path, body) { const i = await call("POST", "/intents", { action, targetIds }); if (i.status !== 200) return i; return call("POST", path, body, { "x-guga-intent": i.body.token }); },
    onEvent: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    onCallPrefill: () => {}, openExternal: (u) => window.open(u, "_blank"), openCallPopup: () => window.open("call.html", "guga-call", "width=520,height=620"),
    closeSelf: () => window.close(), notify: (t, b) => console.log("notify", t, b),
    saveFile: async (name, content) => { const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([content])); a.download = name; a.click(); return name; },
    attachmentUrl: async (m, a) => `/api/messages/${m}/attachments/${a}`, secretSet: async () => false,
  };
})();
