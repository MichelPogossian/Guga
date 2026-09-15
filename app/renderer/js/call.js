/** Popup « appel téléphonique » (§7.14) : recherche instantanée, note d'appel, brouillon depuis le modèle. */
import { api } from "./api.js";
const form = document.getElementById("call-form"), results = document.getElementById("lookup-results"), status = document.getElementById("call-status");
let lawyers = [];
(async () => { try { const { contacts } = await api.contacts(); lawyers = contacts.filter((c) => c.role === "partner" || c.role === "associate"); const sel = document.getElementById("forward-to"); for (const l of lawyers) { const o = document.createElement("option"); o.value = l.emails[0]; o.textContent = l.name; sel.appendChild(o); } } catch { status.textContent = "Moteur injoignable"; } })();
window.guga.onCallPrefill((p) => { for (const [k, v] of Object.entries(p || {})) if (form.elements[k]) form.elements[k].value = v; });
let t;
form.elements.lookup.addEventListener("input", () => { clearTimeout(t); t = setTimeout(async () => {
  const q = form.elements.lookup.value.trim(); results.innerHTML = ""; if (q.length < 2) return;
  const r = await api.callLookup(q);
  for (const c of r.cases) { const li = document.createElement("li"); li.textContent = `📁 ${c.secibRef} — ${c.label}`; li.addEventListener("click", () => { form.elements.caseId.value = c.id; form.elements.lookup.value = `${c.secibRef} — ${c.label}`; results.innerHTML = ""; }); results.appendChild(li); }
  for (const c of r.contacts) { const li = document.createElement("li"); li.textContent = `👤 ${c.name} (${c.role})`; li.addEventListener("click", () => { form.elements.caller.value = c.name; if (c.phone) form.elements.phone.value = c.phone; results.innerHTML = ""; }); results.appendChild(li); }
}, 200); });
form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const b = { caller: form.elements.caller.value.trim(), phone: form.elements.phone.value.trim() || undefined, caseId: form.elements.caseId.value || null, subject: form.elements.subject.value.trim() || undefined, forwardedTo: form.elements.forwardedTo.value || undefined };
  try {
    const r = await api.createCall(b);
    status.textContent = "Note enregistrée. " + (r.draft.to.length ? "Brouillon prêt : " + r.draft.subject : "Aucun destinataire : brouillon non créé.");
    if (r.draft.to.length) {
      // Le brouillon Outlook est créé via le plan d'action (jeton d'intention) sur le premier e-mail du dossier s'il existe, sinon en brouillon libre.
      const mid = (await api.messages({ caseId: b.caseId || "", limit: 1 })).items[0]?.id;
      if (mid) { await api.outlook("create_draft", [mid], { draft: r.draft }); status.textContent += " — brouillon créé dans Outlook."; }
      else status.textContent += " — copiez le texte : " + r.draft.bodyHtml.replace(/<br>/g, "\n");
    }
    await window.guga.notify("Guga — appel", `${b.caller}${b.forwardedTo ? " → " + b.forwardedTo : ""}`);
    setTimeout(() => window.guga.closeSelf(), 2500);
  } catch (err) { status.textContent = err.message; }
});
document.getElementById("call-cancel").addEventListener("click", () => window.guga.closeSelf());
