/** Vue tableau : onglets colonnes, filtres persistés, grille virtualisée, lecteur, menu contextuel, actions. */
import { api } from "../api.js";
import { store, label } from "../store.js";
import { toast, confirm, h, raw } from "../ui.js";
import "../components/guga-grid.js";
import "../components/guga-reader.js";

export const COLUMN_ORDER = ["PUBS", "CC", "RIB", "PLAIDOIRIE", "INSTR_ASSOC", "INSTR_COLLAB", "NOUVEAUX", "PROCEDURE", "PIECES", "EXPERTISE", "CONTACT", "CLAIRE"];

export class BoardView {
  constructor(root) {
    this.root = root; this.grid = null; this.reader = null; this.loadSeq = 0;
    this.filters = JSON.parse(localStorage.getItem("guga.filters") || "{}");
  }

  async mount() {
    this.root.innerHTML = `<div class="tabs" id="tabs"></div>
      <div class="filters" id="filters">
        <input type="search" id="col-search" placeholder="Filtrer cette colonne">
        <select id="f-processed"><option value="0">Non traités</option><option value="">Tous</option><option value="1">Traités</option></select>
        <select id="f-status"><option value="">Tous statuts</option></select>
        <label><input type="checkbox" id="f-urgent"> Urgents</label>
        <label><input type="checkbox" id="f-confirm"> À confirmer</label>
        <select id="f-from-col"><option value="">—</option></select>
        <select id="f-sort"><option value="received_desc">Plus récents</option><option value="received_asc">Plus anciens</option><option value="deadline">Par échéance</option></select>
        <button id="f-bulk" disabled>Actions (0)</button>
        <span class="count" id="count"></span>
      </div>
      <div class="split" id="split"><guga-grid id="grid"></guga-grid><guga-reader id="reader"></guga-reader></div>`;
    this.grid = this.root.querySelector("#grid"); this.reader = this.root.querySelector("#reader");
    this.grid.addEventListener("open", (e) => this.open(e.detail.id));
    this.grid.addEventListener("select", () => this.updateBulk());
    this.grid.addEventListener("context", (e) => this.contextMenu(e.detail.x, e.detail.y));
    this.reader.addEventListener("action", (e) => this.readerAction(e.detail));
    this.reader.addEventListener("attachment", async (e) => { const url = await window.guga.attachmentUrl(e.detail.messageId, e.detail.attachmentId); const w = document.createElement("iframe"); w.src = url; w.style.cssText = "width:100%;height:70vh;border:0"; const dlg = document.createElement("dialog"); dlg.style.width = "80vw"; dlg.style.maxWidth = "1100px"; dlg.appendChild(w); const c = document.createElement("button"); c.textContent = "Fermer"; c.addEventListener("click", () => dlg.close()); dlg.appendChild(c); document.body.appendChild(dlg); dlg.addEventListener("close", () => dlg.remove()); dlg.showModal(); });
    this.reader.addEventListener("toast", (e) => toast(e.detail.text));
    const f = this.root.querySelector("#filters");
    f.querySelector("#col-search").addEventListener("input", debounce(() => this.applyFilter(), 250));
    for (const id of ["#f-processed", "#f-status", "#f-urgent", "#f-confirm", "#f-from-col", "#f-sort"]) f.querySelector(id).addEventListener("change", () => this.applyFilter());
    f.querySelector("#f-bulk").addEventListener("click", (e) => { const b = e.target.getBoundingClientRect(); this.contextMenu(b.left, b.bottom + 4); });
    const fc = f.querySelector("#f-from-col"); fc.innerHTML = `<option value="">Instruction reçue de…</option>` + COLUMN_ORDER.map((c) => `<option value="${c}">${c}</option>`).join("");
    await this.refreshColumns();
    await this.selectColumn(store.get().column, true);
  }

  async refreshColumns() {
    const r = await api.columns();
    store.set({ columns: r.columns, backlog: r.backlog, mailboxes: r.mailboxes });
    this.renderTabs();
  }

  renderTabs() {
    const { columns, column } = store.get();
    const tabs = this.root.querySelector("#tabs"); if (!tabs) return;
    tabs.innerHTML = columns.map((c) => h`<button class="tab ${c.code === column ? "on" : ""}" data-code="${c.code}" title="${c.total} au total, ${c.unprocessed} non traités"><span class="dot" style="background:${c.color || "#999"}"></span>${c.label}<span class="n ${c.unprocessed ? "hot" : ""}">${c.unprocessed}</span>${raw(c.urgent ? `<span class="urg" title="${c.urgent} urgent(s)">▲${c.urgent}</span>` : "")}${raw(c.alerts ? `<span class="alert" title="alertes">${c.alerts}</span>` : "")}</button>`).join("");
    tabs.querySelectorAll(".tab").forEach((t) => t.addEventListener("click", () => this.selectColumn(t.dataset.code)));
  }

  async selectColumn(code, first = false) {
    store.set({ column: code });
    localStorage.setItem("guga.column", code);
    this.renderTabs();
    const def = store.get().columns.find((c) => c.code === code);
    const st = this.root.querySelector("#f-status");
    st.innerHTML = `<option value="">Tous statuts</option>` + (def ? def.statusSchema.map((s) => `<option value="${s}">${label(s)}</option>`).join("") : "");
    // Filtres persistés par colonne (base locale, repli localStorage)
    let saved = this.filters[code];
    try { const r = await api.columnFilter(code); if (r.filter) saved = r.filter; } catch { /* hors ligne */ }
    const f = { q: "", processed: "0", status: "", urgent: false, toConfirm: false, fromColumn: "", sort: "received_desc", ...(saved || {}) };
    this.root.querySelector("#col-search").value = f.q; this.root.querySelector("#f-processed").value = f.processed; st.value = f.status;
    this.root.querySelector("#f-urgent").checked = f.urgent; this.root.querySelector("#f-confirm").checked = f.toConfirm; this.root.querySelector("#f-from-col").value = f.fromColumn; this.root.querySelector("#f-sort").value = f.sort;
    await this.load();
    if (!first) this.grid.focus();
  }

  currentFilter() {
    return { q: this.root.querySelector("#col-search").value.trim(), processed: this.root.querySelector("#f-processed").value, status: this.root.querySelector("#f-status").value,
      urgent: this.root.querySelector("#f-urgent").checked, toConfirm: this.root.querySelector("#f-confirm").checked, fromColumn: this.root.querySelector("#f-from-col").value, sort: this.root.querySelector("#f-sort").value };
  }
  async applyFilter() {
    const code = store.get().column; const f = this.currentFilter();
    this.filters[code] = f; localStorage.setItem("guga.filters", JSON.stringify(this.filters));
    api.saveColumnFilter(code, f).catch(() => {});
    await this.load();
  }

  async load() {
    const seq = ++this.loadSeq;
    const { column } = store.get(); const f = this.currentFilter();
    try {
      const r = await api.messages({ column, q: f.q, processed: f.processed === "" ? undefined : f.processed, status: f.status, urgent: f.urgent, toConfirm: f.toConfirm, fromColumn: f.fromColumn, sort: f.sort, limit: 1000 });
      if (seq !== this.loadSeq) return;
      store.set({ items: r.items, total: r.total });
      this.grid.setItems(r.items, store.get().columns.find((c) => c.code === column));
      this.root.querySelector("#count").textContent = `${r.items.length} / ${r.total}`;
      this.updateBulk();
      const cur = store.get().current;
      if (cur && !r.items.some((i) => i.id === cur)) { store.set({ current: null }); this.reader.message = null; }
    } catch (e) { toast(e.message, "err"); }
  }

  async open(id) {
    store.set({ current: id });
    try { const m = await api.message(id); if (store.get().current === id) { store.set({ currentDetail: m }); this.reader.message = m; } } catch (e) { toast(e.message, "err"); }
  }
  async reloadCurrent() { const id = store.get().current; if (id) await this.open(id); }

  updateBulk() { const n = this.grid.selected.size; const b = this.root.querySelector("#f-bulk"); b.disabled = n === 0; b.textContent = `Actions (${n})`; }

  selectedIds() { return [...this.grid.selected]; }

  contextMenu(x, y) {
    const ids = this.selectedIds(); if (!ids.length) return;
    const { column, columns } = store.get(); const def = columns.find((c) => c.code === column);
    const one = ids.length === 1 ? store.get().items.find((i) => i.id === ids[0]) : null;
    const entries = [
      { sub: `${ids.length} e-mail${ids.length > 1 ? "s" : ""} sélectionné${ids.length > 1 ? "s" : ""}` },
      { label: "✓ Marquer traité", run: () => this.redirectMany(ids, { processed: true }) },
      { label: "Marquer urgent / retirer", run: () => this.redirectMany(ids, { isUrgent: !(one ? one.placement.isUrgent : false) }) },
      { label: "Échéance…", run: () => this.askDeadline(ids) },
      { label: "Rattacher à un dossier…", run: () => this.askCase(ids) },
      "-", { sub: "Rediriger vers" },
      ...COLUMN_ORDER.filter((c) => c !== column).map((c) => ({ label: `→ ${columns.find((x) => x.code === c)?.label || c}`, run: () => this.redirectMany(ids, { column: c, reason: column === "PUBS" ? "Ce n'est pas une pub" : undefined }) })),
      "-",
    ];
    if (def && def.statusSchema.length) { entries.push({ sub: "Statut" }); for (const s of def.statusSchema) entries.push({ label: label(s), run: () => this.setStatus(ids, s) }); entries.push("-"); }
    entries.push({ sub: "Outlook (avec confirmation)" });
    entries.push({ label: "Marquer comme lu dans Outlook", run: () => this.outlook("mark_read", ids, { read: true }, `Marquer ${ids.length} e-mail(s) comme lu(s) dans Outlook ?`) });
    entries.push({ label: "Annuler le dernier déplacement", run: () => this.outlook("undo_move", ids, {}, `Restaurer ${ids.length} e-mail(s) dans leur dossier d'origine ?`) });
    if (column === "CLAIRE") entries.push({ label: "Transférer à la comptabilité…", run: () => this.forwardAccounting(ids) });
    if (def && def.allowsDelete) entries.push({ label: `Supprimer ${ids.length > 1 ? "les " + ids.length + " sélectionnés" : ""} (→ Éléments supprimés)`, danger: true, run: () => this.softDelete(ids) });
    document.getElementById("ctx").open(x, y, entries);
  }

  async redirectMany(ids, body) {
    try { if (ids.length === 1) await api.redirect(ids[0], body); else await api.redirectMany(ids, body); toast(body.column ? `Redirigé vers ${body.column}` : "Mis à jour"); await this.afterChange(); } catch (e) { toast(e.message, "err"); }
  }
  async setStatus(ids, status) { await this.redirectMany(ids, { status }); }
  async askDeadline(ids) {
    const cur = ids.length === 1 ? (store.get().items.find((i) => i.id === ids[0])?.placement.deadlineAt || "") : "";
    const v = await confirm({ title: "Échéance", text: "Date (AAAA-MM-JJ) ou date et heure (AAAA-MM-JJTHH:MM). Vide pour retirer.", okLabel: "Enregistrer", input: { label: "Échéance", value: cur, placeholder: "2026-09-30T12:00" } });
    if (v === null) return;
    if (v && !/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/.test(v)) return toast("Format invalide", "err");
    await this.redirectMany(ids, { deadlineAt: v || null });
  }
  async askCase(ids) {
    const { cases } = await api.cases();
    const v = await confirm({ title: "Rattacher à un dossier", text: "Référence Secib ou début du libellé.", okLabel: "Rattacher", input: { label: "Dossier", placeholder: "2024-0187 ou BATIMO" } });
    if (!v) return;
    const c = cases.find((x) => x.secibRef === v) || cases.find((x) => (x.label || "").toLowerCase().includes(v.toLowerCase()) || (x.secibRef || "").startsWith(v));
    if (!c) return toast("Dossier introuvable — créez-le dans Paramètres", "err");
    await this.redirectMany(ids, { caseId: c.id, ...(store.get().column === "CC" ? { status: "RATTACHE" } : {}) });
  }
  async softDelete(ids) {
    const ok = await confirm({ title: "Supprimer dans Outlook", text: `Déplacer ${ids.length} e-mail(s) vers « Éléments supprimés » d'Outlook ? L'opération est journalisée et réversible pendant 30 jours.`, okLabel: `Supprimer ${ids.length > 1 ? "les " + ids.length : ""}`, danger: true });
    if (!ok) return;
    await this.runOutlook("soft_delete", ids, {});
  }
  async outlook(op, ids, extra, text) { const ok = await confirm({ title: "Action Outlook", text, okLabel: "Confirmer" }); if (ok) await this.runOutlook(op, ids, extra); }
  async runOutlook(op, ids, extra) {
    try {
      const r = await api.outlook(op, ids, extra);
      const ko = r.results.filter((x) => !x.ok);
      toast(ko.length ? `${r.results.length - ko.length} ok, ${ko.length} refusé(s) : ${ko[0].detail}` : `${r.results.length} action(s) effectuée(s) et journalisée(s)`, ko.length ? "err" : "ok");
      await this.afterChange();
    } catch (e) { toast(e.message, "err"); }
  }
  async forwardAccounting(ids) {
    const s = await api.settings();
    const to = s.config.accountingAddress;
    const comment = await confirm({ title: "Transférer à la comptabilité", text: `Transférer ${ids.length} e-mail(s) à ${to} ? Commentaire optionnel :`, okLabel: "Transférer", input: { label: "Commentaire", placeholder: "Pour traitement" } });
    if (comment === null) return;
    await this.runOutlook("forward", ids, { to: [to], comment: comment || undefined });
  }
  async afterChange() { await this.refreshColumns(); await this.load(); await this.reloadCurrent(); }

  async readerAction(d) {
    const id = store.get().current; if (!id) return;
    const m = store.get().currentDetail;
    switch (d.action) {
      case "toggle-processed": return this.redirectMany([id], { processed: !m.placement.processed });
      case "toggle-urgent": return this.redirectMany([id], { isUrgent: !m.placement.isUrgent });
      case "deadline": return this.askDeadline([id]);
      case "case": return this.askCase([id]);
      case "menu": { this.grid.selected = new Set([id]); const b = this.reader.querySelector("#reader-actions").getBoundingClientRect(); return this.contextMenu(b.left + 80, b.bottom); }
      case "soft_delete": return this.softDelete([id]);
      case "forward-accounting": return this.forwardAccounting([id]);
      case "mark_read": return this.outlook("mark_read", [id], { read: !m.isRead }, `${m.isRead ? "Marquer non lu" : "Marquer lu"} dans Outlook ?`);
      case "reclassify": try { await api.reclassify(id); toast("Reclassement demandé"); } catch (e) { toast(e.message, "err"); } return;
      case "ack-alert": try { await api.ackAlert(d.alertId); toast("Réception accusée"); await this.afterChange(); } catch (e) { toast(e.message, "err"); } return;
      case "link-case": try { await api.linkCase(id, d.caseId); toast("Rattaché"); await this.afterChange(); } catch (e) { toast(e.message, "err"); } return;
      case "rib-transition": {
        if (d.to === "ENVOYE" && m.rib && m.rib.recipient_kind === "opponent") {
          const a = await confirm({ title: "Destinataire adverse", text: "Le RIB CARPA est destiné à un confrère adverse. Confirmez-vous qu'il a bien été envoyé ?", okLabel: "Oui, envoyé", danger: true }); if (!a) return;
          const b = await confirm({ title: "Seconde confirmation", text: "Cette étape est irréversible dans le suivi. Confirmer une seconde fois.", okLabel: "Confirmer définitivement", danger: true }); if (!b) return;
        }
        try { const r = await api.ribTransition(id, d.to); toast(r.forced ? "Transition forcée (journalisée)" : "Statut mis à jour"); await this.afterChange(); } catch (e) { toast(e.message, "err"); } return;
      }
      case "rib-ecarpa": try { await api.ribUpdate(id, { ecarpaCreated: d.value }); toast("e-Carpa mis à jour"); } catch (e) { toast(e.message, "err"); } return;
      case "newcase-verify": try { const r = await api.verifyNewCase(id); toast(`Verdict : ${r.verdict}`); await this.afterChange(); } catch (e) { toast(e.message, "err"); } return;
      case "expertise-slots": try { const r = await api.expertiseSlots(id); const box = this.reader.querySelector("#slots"); if (box) box.innerHTML = `<div class="evidence">Dates proposées par l'expert : ${r.proposed.map((x) => `<b>${x}</b>`).join(", ") || "aucune détectée"}<br><span class="faint">${r.note}</span></div>`; } catch (e) { toast(e.message, "err"); } return;
      case "hearing-pack": try { await api.hearingPack(m.placement.caseId || "x"); } catch (e) { toast(e.message, "err"); } return;
      case "pieces-download": try { await api.piecesDownload(id); } catch (e) { toast(e.message, "err"); } return;
    }
  }
}

function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }
