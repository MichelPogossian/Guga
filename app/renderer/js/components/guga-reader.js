/** <guga-reader> — panneau de lecture : corps assaini dans une iframe sandbox, PJ, preuves IA, historique, modules (§9.2). */
import { h, raw, esc } from "../ui.js";
import { fmt, label } from "../store.js";

export class GugaReader extends HTMLElement {
  constructor() { super(); this.m = null; this.ribStates = null; }
  connectedCallback() { if (!this.m) this.render(); }
  set message(m) { this.m = m; this.render(); }
  emit(name, detail) { this.dispatchEvent(new CustomEvent(name, { detail, bubbles: true })); }

  render() {
    const m = this.m;
    if (!m) { this.innerHTML = `<div class="empty">Sélectionnez un e-mail pour le lire.</div>`; return; }
    const p = m.placement || {};
    const ev = m.evidence || {};
    const cd = fmt.countdown(p.deadlineAt);
    this.innerHTML = h`
      <div class="reader-head">
        <h2>${m.subject || "(sans objet)"}</h2>
        <div class="reader-meta">
          <span>De</span><span>${m.from.name ? m.from.name + " <" + m.from.address + ">" : m.from.address}</span>
          <span>À</span><span>${m.to.join(", ")}</span>
          ${raw(m.cc.length ? `<span>Cc</span><span>${esc(m.cc.join(", "))}</span>` : "")}
          <span>Reçu</span><span>${fmt.dateTime(m.receivedAt)} · ${m.mailboxLabel}</span>
          <span>Colonne</span><span>${p.column || ""} ${raw(p.status ? `<span class="badge status">${esc(label(p.status))}</span>` : "")} ${raw(p.isUrgent ? `<span class="badge urgent">URGENT</span>` : "")} ${raw(cd ? `<span class="badge deadline ${cd.late ? "late" : ""}">${esc(cd.text)}</span>` : "")} ${raw(p.toConfirm ? `<span class="badge confirm">à confirmer</span>` : "")}</span>
          ${raw(p.secibRef ? `<span>Dossier</span><span><b>${esc(p.secibRef)}</b> ${esc(p.caseLabel || "")}</span>` : "")}
        </div>
      </div>
      <div class="reader-actions" id="reader-actions"></div>
      <div class="reader-body" id="reader-body"></div>
      <div id="reader-panels"></div>`;
    this.renderActions();
    this.renderBody();
    this.renderPanels();
  }

  renderActions() {
    const p = this.m.placement || {};
    const box = this.querySelector("#reader-actions");
    const btn = (labelTxt, action, extra = {}) => { const b = document.createElement("button"); b.textContent = labelTxt; if (extra.danger) b.className = "danger"; if (extra.primary) b.className = "primary"; b.addEventListener("click", () => this.emit("action", { action, ...extra })); return b; };
    box.appendChild(btn(p.processed ? "Rouvrir" : "✓ Traité", "toggle-processed"));
    box.appendChild(btn("Rediriger…", "menu"));
    box.appendChild(btn(p.isUrgent ? "Retirer l'urgence" : "Marquer urgent", "toggle-urgent"));
    box.appendChild(btn("Échéance…", "deadline"));
    box.appendChild(btn("Dossier…", "case"));
    if (p.column === "PUBS" || p.column === "CC") box.appendChild(btn("Supprimer dans Outlook", "soft_delete", { danger: true }));
    if (p.column === "CLAIRE") box.appendChild(btn("Transférer à la comptabilité", "forward-accounting", { primary: true }));
    if (p.column === "PIECES") box.appendChild(btn("Télécharger les pièces", "pieces-download"));
    if (p.column === "PLAIDOIRIE") box.appendChild(btn("Générer le dossier de plaidoirie", "hearing-pack"));
    if (p.column === "NOUVEAUX") box.appendChild(btn("Vérifier RCS / barreaux", "newcase-verify"));
    if (p.column === "EXPERTISE") box.appendChild(btn("Proposer des dates", "expertise-slots"));
    box.appendChild(btn(this.m.isRead ? "Marquer non lu dans Outlook" : "Marquer lu dans Outlook", "mark_read"));
    box.appendChild(btn("Reclasser (IA)", "reclassify"));
  }

  renderBody() {
    const body = this.querySelector("#reader-body");
    if (this.m.bodyHtml && window.DOMPurify) {
      const clean = DOMPurify.sanitize(this.m.bodyHtml, { FORBID_TAGS: ["script", "style", "iframe", "object", "embed", "form", "input"], FORBID_ATTR: ["onerror", "onload", "style"] })
        .replace(/<img\b([^>]*?)\bsrc=["']https?:[^"']*["']/gi, '<img$1 data-blocked-src="remote" alt="[image distante bloquée]"');
      const doc = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'"><style>body{font-family:Segoe UI,system-ui,sans-serif;font-size:14px;line-height:1.5;padding:12px 16px;margin:0;color:#1b2430;background:#fff}a{color:#0f766e}img[data-blocked-src]{border:1px dashed #ccc;padding:4px;font-size:11px;color:#888}</style></head><body>${clean}</body></html>`;
      const f = document.createElement("iframe");
      f.setAttribute("sandbox", ""); f.setAttribute("referrerpolicy", "no-referrer"); f.srcdoc = doc;
      f.addEventListener("load", () => { try { f.style.height = Math.min(1600, Math.max(320, f.contentDocument.body.scrollHeight + 32)) + "px"; } catch { /* sandbox */ } });
      body.replaceChildren(f);
    } else {
      const pre = document.createElement("pre"); pre.textContent = this.m.bodyText || "(message vide)"; body.replaceChildren(pre);
    }
    if (this.m.links && this.m.links.length) {
      const div = document.createElement("div"); div.className = "panel"; div.innerHTML = `<h4>Liens détectés</h4><ul></ul>`;
      for (const l of this.m.links.slice(0, 15)) { const li = document.createElement("li"); const a = document.createElement("a"); a.href = "#"; a.textContent = (l.secureShare ? "🔒 " : "") + l.url; a.title = "Ouvrir dans le navigateur"; a.addEventListener("click", (e) => { e.preventDefault(); window.guga.openExternal(l.url); }); li.appendChild(a); div.querySelector("ul").appendChild(li); }
      body.appendChild(div);
    }
  }

  renderPanels() {
    const m = this.m, p = m.placement || {}, ev = m.evidence || {};
    const box = this.querySelector("#reader-panels");
    let html = "";
    if (m.attachments && m.attachments.length) {
      html += `<div class="panel"><h4>Pièces jointes (${m.attachments.length})</h4>` + m.attachments.map((a) => h`<div class="att"><a data-att="${a.id}">📄 ${a.name}</a> <span class="faint">${fmt.size(a.size)}</span></div>`).join("") + `</div>`;
    }
    if (p.column === "RIB" && m.rib) {
      html += `<div class="panel"><h4>RIB CARPA</h4>` + (m.rib.recipient_kind === "opponent" ? `<div class="evidence" style="border-color:var(--danger);color:var(--danger)"><b>Destinataire : confrère adverse</b> — double confirmation exigée avant tout envoi.</div>` : "") +
        h`<div class="kv"><span>Instruction de</span><span>${m.rib.instructed_by || "—"}</span><span>Destinataire</span><span>${m.rib.recipient_contact || m.rib.recipient_kind || "—"}</span><span>e-Carpa</span><span><label><input type="checkbox" id="rib-ecarpa" ${raw(m.rib.ecarpa_created ? "checked" : "")}> sous-compte créé</label></span><span>Statut depuis</span><span>${fmt.dateTime(m.rib.status_since)}</span></div>` +
        `<div class="stateline" id="rib-states" style="margin-top:8px"></div></div>`;
    }
    if (p.column === "PROCEDURE" && m.alerts && m.alerts.length) {
      html += `<div class="panel"><h4>Délais détectés</h4>` + m.alerts.map((a) => h`<div class="evidence"><b>${a.kind.replace(/_/g, " ")}</b> — échéance <b>${a.due_at || "à préciser"}</b><br><span class="faint">${a.legal_basis || ""}</span><br>« ${a.evidence || ""} »<br>${raw(a.acknowledged ? `<span class="badge status">accusé</span>` : `<button data-ack="${esc(a.id)}">Accuser réception</button>`)}</div>`).join("") + `</div>`;
    }
    if (p.column === "NOUVEAUX" && m.newCase) {
      const ext = JSON.parse(m.newCase.extracted_json || "{}"); const disc = JSON.parse(m.newCase.discrepancies_json || "[]");
      html += `<div class="panel"><h4>Nouveau dossier — verdict <span class="badge ${m.newCase.verdict === "INCOHERENCE" ? "alert" : "status"}">${esc(label(m.newCase.verdict))}</span></h4>` +
        (disc.length ? `<ul>${disc.map((d) => h`<li>${d}</li>`).join("")}</ul>` : "") +
        ((ext.parties || []).map((pt) => h`<div class="evidence"><b>${pt.name}</b> — SIREN ${pt.siren || "?"} (RCS ${pt.rcsCity || "?"})<br>${pt.address || ""}<br>${pt.counsel ? "Avocat : " + pt.counsel + (pt.bar ? " (Barreau de " + pt.bar + ")" : "") : ""}</div>`).join("")) +
        (ext.sheet ? `<button id="copy-sheet">Copier la fiche « prête à saisir » Secib</button>` : "") + `</div>`;
    }
    if (p.column === "EXPERTISE" && m.expertise) {
      html += h`<div class="panel"><h4>Expertise</h4><div class="kv"><span>Nature</span><span>${m.expertise.kind}</span><span>Partie représentée</span><span>${m.expertise.represents_party || "à préciser"}</span><span>Notifié à</span><span>${(JSON.parse(m.expertise.notified_to_json || "[]")).join(", ") || "—"}</span></div><div id="slots"></div></div>`;
    }
    if (ev.caseCandidates && ev.caseCandidates.length) {
      html += `<div class="panel"><h4>Dossiers candidats</h4><ul class="candidates">` + ev.caseCandidates.map((c) => h`<li><span><b>${c.secibRef}</b> ${c.label} <span class="faint">(${Math.round(c.score * 100)} % — ${c.common.join(", ")})</span></span><button data-link="${c.caseId}">Rattacher</button></li>`).join("") + `</ul></div>`;
    }
    // Preuves IA
    const llm = ev.llm; const stages = ev.stages || [];
    html += `<div class="panel"><h4>Pourquoi ce classement</h4>`;
    if (llm) html += h`<div class="evidence">${llm.summary || ""}${raw(llm.deadline_evidence ? `<br><span class="faint">Échéance : « ${esc(llm.deadline_evidence)} »</span>` : "")}</div>`;
    else if (ev.deadlineEvidence) html += h`<div class="evidence"><span class="faint">Échéance : « ${ev.deadlineEvidence} »</span></div>`;
    html += `<ul>` + stages.filter((s) => s.notes && s.notes.length).map((s) => h`<li><b>${s.stage}</b> : ${s.notes.slice(0, 4).join(" · ")}</li>`).join("") + (ev.hardConstraints && ev.hardConstraints.length ? h`<li><b>contraintes</b> : ${ev.hardConstraints.join(" · ")}</li>` : "") + `</ul>` +
      `<div class="faint">Confiance ${Math.round((p.confidence || 0) * 100)} % · source ${p.source || ""}</div></div>`;
    if (m.history && m.history.length) {
      html += `<div class="panel"><h4>Historique</h4><ul>` + m.history.map((x) => h`<li><span class="faint">${fmt.dateTime(x.at)}</span> ${x.actor} : ${x.from_column || "—"} → ${x.to_column}${x.to_status ? " (" + label(x.to_status) + ")" : ""}${x.reason ? " — " + x.reason : ""}</li>`).join("") + `</ul></div>`;
    }
    if (m.audit && m.audit.length) {
      html += `<div class="panel"><h4>Journal des actions</h4><ul>` + m.audit.slice(0, 8).map((x) => h`<li><span class="faint">${fmt.dateTime(x.at)}</span> ${x.action} — ${x.result}</li>`).join("") + `</ul></div>`;
    }
    box.innerHTML = html;
    box.querySelectorAll("[data-att]").forEach((a) => a.addEventListener("click", () => this.emit("attachment", { attachmentId: a.dataset.att, messageId: m.id })));
    box.querySelectorAll("[data-ack]").forEach((b) => b.addEventListener("click", () => this.emit("action", { action: "ack-alert", alertId: b.dataset.ack })));
    box.querySelectorAll("[data-link]").forEach((b) => b.addEventListener("click", () => this.emit("action", { action: "link-case", caseId: b.dataset.link })));
    box.querySelector("#copy-sheet")?.addEventListener("click", () => { navigator.clipboard.writeText(JSON.parse(m.newCase.extracted_json).sheet); this.emit("toast", { text: "Fiche copiée dans le presse-papiers" }); });
    box.querySelector("#rib-ecarpa")?.addEventListener("change", (e) => this.emit("action", { action: "rib-ecarpa", value: e.target.checked }));
    if (p.column === "RIB" && m.rib) this.renderRibStates();
  }

  async renderRibStates() {
    if (!this.ribStates) { try { this.ribStates = (await import("../api.js")).api.ribStates(); this.ribStates = await this.ribStates; } catch { return; } }
    const box = this.querySelector("#rib-states"); if (!box) return;
    const cur = this.m.rib.status;
    for (const s of this.ribStates.states) {
      const b = document.createElement("button"); b.textContent = label(s); if (s === cur) b.className = "cur"; b.disabled = s === cur;
      if (!this.ribStates.transitions[cur].includes(s) && s !== cur) b.title = "Transition hors parcours nominal (sera journalisée comme forcée)";
      b.addEventListener("click", () => this.emit("action", { action: "rib-transition", to: s }));
      box.appendChild(b);
    }
  }
}
customElements.define("guga-reader", GugaReader);
