/** <guga-context-menu> — menu unique (clic droit / bouton) avec les actions autorisées par column_def (§9.2). */
export class GugaContextMenu extends HTMLElement {
  constructor() { super(); this.setAttribute("role", "menu"); document.addEventListener("click", (e) => { if (!this.contains(e.target)) this.close(); }); document.addEventListener("keydown", (e) => { if (e.key === "Escape") this.close(); }); }
  open(x, y, entries) {
    this.innerHTML = "";
    for (const e of entries) {
      if (e === "-") { this.appendChild(document.createElement("hr")); continue; }
      if (e.sub) { const s = document.createElement("div"); s.className = "sub"; s.textContent = e.sub; this.appendChild(s); continue; }
      const b = document.createElement("button"); b.type = "button"; b.setAttribute("role", "menuitem"); b.textContent = e.label; if (e.danger) b.classList.add("danger"); if (e.disabled) b.disabled = true;
      b.addEventListener("click", () => { this.close(); e.run(); });
      this.appendChild(b);
    }
    this.classList.add("open");
    const w = this.offsetWidth, hgt = this.offsetHeight;
    this.style.left = Math.min(x, window.innerWidth - w - 8) + "px"; this.style.top = Math.min(y, window.innerHeight - hgt - 8) + "px";
    this.querySelector("button:not(:disabled)")?.focus();
  }
  close() { this.classList.remove("open"); }
}
customElements.define("guga-context-menu", GugaContextMenu);
