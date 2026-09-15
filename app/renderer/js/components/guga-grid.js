/** <guga-grid> — liste virtualisée en JavaScript natif : seules les lignes visibles sont rendues (§9.2). */
import { h, raw } from "../ui.js";
import { fmt, label } from "../store.js";

const ROW_H = 44;

export class GugaGrid extends HTMLElement {
  constructor() {
    super();
    this.items = []; this.selected = new Set(); this.current = null; this.columnDef = null;
    this.innerHTML = `<div class="grid-head"><span></span><span></span><span>Expéditeur</span><span>Objet</span><span>Reçu</span><span>Statut</span><span>Indicateurs</span></div><div class="grid-body"><div class="grid-spacer"></div></div>`;
    this.body = this.querySelector(".grid-body"); this.spacer = this.querySelector(".grid-spacer");
    this.body.addEventListener("scroll", () => this.render());
    this.body.addEventListener("click", (e) => this.onClick(e));
    this.body.addEventListener("dblclick", (e) => { const r = e.target.closest(".row"); if (r) this.emit("open", { id: r.dataset.id }); });
    this.body.addEventListener("contextmenu", (e) => { const r = e.target.closest(".row"); if (!r) return; e.preventDefault(); if (!this.selected.has(r.dataset.id)) { this.selected = new Set([r.dataset.id]); this.current = r.dataset.id; } this.emit("select", {}); this.emit("context", { x: e.clientX, y: e.clientY }); });
    this.tabIndex = 0;
    this.addEventListener("keydown", (e) => this.onKey(e));
    new ResizeObserver(() => this.render()).observe(this.body);
  }
  emit(name, detail) { this.dispatchEvent(new CustomEvent(name, { detail, bubbles: true })); }
  setItems(items, columnDef) {
    this.items = items; this.columnDef = columnDef;
    const ids = new Set(items.map((i) => i.id));
    for (const s of [...this.selected]) if (!ids.has(s)) this.selected.delete(s);
    if (this.current && !ids.has(this.current)) this.current = null;
    this.spacer.style.height = `${Math.max(1, items.length) * ROW_H}px`;
    this.render();
  }
  onClick(e) {
    const r = e.target.closest(".row"); if (!r) return;
    const id = r.dataset.id;
    if (e.target.matches("input[type=checkbox]")) { if (e.target.checked) this.selected.add(id); else this.selected.delete(id); this.emit("select", {}); this.render(); return; }
    if (e.shiftKey && this.current) {
      const a = this.items.findIndex((i) => i.id === this.current), b = this.items.findIndex((i) => i.id === id);
      for (let k = Math.min(a, b); k <= Math.max(a, b); k++) this.selected.add(this.items[k].id);
    } else if (e.ctrlKey || e.metaKey) { if (this.selected.has(id)) this.selected.delete(id); else this.selected.add(id); }
    else this.selected = new Set([id]);
    this.current = id; this.emit("select", {}); this.emit("open", { id }); this.render();
  }
  onKey(e) {
    const idx = this.items.findIndex((i) => i.id === this.current);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const n = Math.min(this.items.length - 1, Math.max(0, idx + (e.key === "ArrowDown" ? 1 : -1)));
      if (!this.items[n]) return;
      this.current = this.items[n].id; if (!e.shiftKey) this.selected = new Set([this.current]); else this.selected.add(this.current);
      this.scrollTo(n); this.emit("select", {}); this.emit("open", { id: this.current }); this.render();
    } else if (e.key === "Enter" && this.current) this.emit("open", { id: this.current });
    else if (e.key === " " && this.current) { e.preventDefault(); if (this.selected.has(this.current)) this.selected.delete(this.current); else this.selected.add(this.current); this.emit("select", {}); this.render(); }
    else if (e.key === "a" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); this.selected = new Set(this.items.map((i) => i.id)); this.emit("select", {}); this.render(); }
    else if (e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey)) { e.preventDefault(); const r = this.body.querySelector(".row.sel"); const b = r ? r.getBoundingClientRect() : this.getBoundingClientRect(); this.emit("context", { x: b.left + 40, y: b.top + 20 }); }
  }
  scrollTo(n) { const top = n * ROW_H; if (top < this.body.scrollTop) this.body.scrollTop = top; else if (top + ROW_H > this.body.scrollTop + this.body.clientHeight) this.body.scrollTop = top + ROW_H - this.body.clientHeight; }
  render() {
    const H = this.body.clientHeight || 600;
    const start = Math.max(0, Math.floor(this.body.scrollTop / ROW_H) - 5);
    const end = Math.min(this.items.length, Math.ceil((this.body.scrollTop + H) / ROW_H) + 5);
    if (!this.items.length) { this.spacer.innerHTML = `<div class="empty">Aucun e-mail dans cette vue.</div>`; return; }
    let html = "";
    for (let i = start; i < end; i++) html += this.rowHtml(this.items[i], i);
    this.spacer.innerHTML = html;
  }
  rowHtml(m, i) {
    const p = m.placement || {};
    const cd = fmt.countdown(p.deadlineAt);
    const cls = ["row", this.selected.has(m.id) ? "sel" : "", m.isRead ? "" : "unread", p.processed ? "processed" : ""].join(" ");
    const flags = [
      p.isUrgent ? `<span class="badge urgent">URGENT</span>` : "",
      cd ? `<span class="badge deadline ${cd.late ? "late" : ""}">${cd.text}</span>` : "",
      p.toConfirm ? `<span class="badge confirm" title="Classement à confirmer (confiance ${Math.round((p.confidence || 0) * 100)} %)">à confirmer</span>` : "",
      m.rib && m.rib.recipientKind === "opponent" ? `<span class="badge opp" title="Destinataire : confrère adverse">ADVERSE</span>` : "",
      m.openAlerts ? `<span class="badge alert">${m.openAlerts} délai${m.openAlerts > 1 ? "s" : ""}</span>` : "",
      p.redirectedFrom ? `<span class="badge" title="Redirigé depuis ${p.redirectedFrom}">← ${p.redirectedFrom}</span>` : "",
    ].join("");
    const status = p.status ? `<span class="badge status">${label(p.status)}</span>` : "";
    const caseTag = p.secibRef ? ` <span class="badge" title="${p.caseLabel || ""}">${p.secibRef}</span>` : "";
    return h`<div class="${cls}" data-id="${m.id}" style="top:${i * ROW_H}px" role="row" aria-selected="${this.selected.has(m.id)}">
      <input type="checkbox" ${raw(this.selected.has(m.id) ? "checked" : "")} aria-label="Sélectionner">
      <span class="attach">${m.hasAttachments ? "📎" : ""}</span>
      <span class="from" title="${m.from.address}">${m.from.name || m.from.address}<small>${m.mailboxLabel}</small></span>
      <span class="subj" title="${m.subject}">${m.subject || "(sans objet)"}${raw(caseTag)}<small>${p.summary || m.preview || ""}</small></span>
      <span class="date" title="${fmt.dateTime(m.receivedAt)}">${fmt.date(m.receivedAt)}</span>
      <span>${raw(status)}</span>
      <span class="flags">${raw(flags)}</span></div>`;
  }
}
customElements.define("guga-grid", GugaGrid);
