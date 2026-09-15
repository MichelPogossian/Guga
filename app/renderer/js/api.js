/** Accès à l'API locale via le pont preload (window.guga). Aucune fetch directe depuis le renderer. */
const g = () => window.guga;

async function unwrap(p) {
  const r = await p;
  if (r.status >= 400) throw new Error((r.body && r.body.error) || `Erreur ${r.status}`);
  return r.body;
}

export const api = {
  columns: () => unwrap(g().get("/columns")),
  messages: (params) => unwrap(g().get("/messages?" + new URLSearchParams(Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined && v !== "" && v !== false && v !== null))))),
  search: (q) => unwrap(g().get("/search?q=" + encodeURIComponent(q))),
  message: (id) => unwrap(g().get(`/messages/${id}`)),
  redirect: (id, body) => unwrap(g().patch(`/placements/${id}`, body)),
  redirectMany: (messageIds, body) => unwrap(g().patch(`/placements`, { messageIds, ...body })),
  outlook: (op, messageIds, extra = {}) => unwrap(g().act(`outlook.${op}`, messageIds, "/actions/outlook", { op, messageIds, ...extra })),
  external: (adapter, action, targetId) => unwrap(g().post("/actions/external", { adapter, action, targetId })),
  ribStates: () => unwrap(g().get("/modules/rib/states")),
  ribTransition: (id, to) => unwrap(g().post(`/modules/rib/${id}/transition`, { to })),
  ribUpdate: (id, info) => unwrap(g().patch(`/modules/rib/${id}`, info)),
  ackAlert: (alertId) => unwrap(g().post(`/modules/procedure/alerts/${alertId}/ack`)),
  verifyNewCase: (id) => unwrap(g().post(`/modules/new-case/${id}/verify`)),
  caseCandidates: (id) => unwrap(g().get(`/modules/case-link/${id}/candidates`)),
  linkCase: (id, caseId) => unwrap(g().post(`/modules/case-link/${id}`, { caseId })),
  expertiseSlots: (id) => unwrap(g().get(`/modules/expertise/${id}/slots`)),
  hearingPack: (caseId) => unwrap(g().post(`/modules/hearing-pack/${caseId}/generate`)),
  piecesDownload: (id) => unwrap(g().post(`/modules/pieces/${id}/download`)),
  alerts: () => unwrap(g().get("/alerts")),
  cases: () => unwrap(g().get("/cases")),
  contacts: () => unwrap(g().get("/contacts")),
  saveContact: (c) => unwrap(g().put("/contacts", c)),
  deleteContact: (id) => unwrap(g().del(`/contacts/${id}`)),
  saveCase: (c) => unwrap(g().put("/cases", c)),
  importCases: (csv) => unwrap(g().post("/cases/import", { csv })),
  settings: () => unwrap(g().get("/settings")),
  saveSettings: (s) => unwrap(g().put("/settings", s)),
  columnFilter: (code) => unwrap(g().get(`/settings/filters/${code}`)),
  saveColumnFilter: (code, f) => unwrap(g().put(`/settings/filters/${code}`, f)),
  rules: () => unwrap(g().get("/rules")),
  saveRules: (yaml) => unwrap(g().put("/rules", { yaml })),
  audit: (params) => unwrap(g().get("/audit?" + new URLSearchParams(params))),
  auditVerify: () => unwrap(g().get("/audit/verify")),
  auditCsv: () => g().get("/audit/export.csv").then((r) => r.body),
  status: () => unwrap(g().get("/status")),
  accuracy: () => unwrap(g().get("/stats/accuracy")),
  sync: () => unwrap(g().post("/sync")),
  reclassify: (id) => unwrap(g().post(`/reclassify/${id}`)),
  backup: () => unwrap(g().post("/backup")),
  callLookup: (q) => unwrap(g().get("/calls/lookup?q=" + encodeURIComponent(q))),
  createCall: (b) => unwrap(g().post("/calls", b)),
};
