/** Utilitaires d'interface : toasts, confirmation, échappement. */
export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
export const h = (strings, ...vals) => strings.reduce((a, s, i) => a + s + (i < vals.length ? (vals[i] instanceof Raw ? vals[i].s : esc(vals[i])) : ""), "");
class Raw { constructor(s) { this.s = s; } }
export const raw = (s) => new Raw(s);

export function toast(text, kind = "ok") {
  const el = document.createElement("div");
  el.className = "toast" + (kind === "err" ? " err" : "");
  el.textContent = text;
  document.getElementById("toasts").appendChild(el);
  setTimeout(() => el.remove(), kind === "err" ? 6000 : 3000);
}

/** Boîte de confirmation ; renvoie null si annulé, sinon la valeur saisie (ou true). */
export function confirm({ title, text, okLabel = "Confirmer", danger = false, input = null }) {
  const dlg = document.getElementById("confirm");
  document.getElementById("confirm-title").textContent = title;
  document.getElementById("confirm-text").textContent = text;
  const ok = document.getElementById("confirm-ok");
  ok.textContent = okLabel; ok.className = danger ? "danger" : "primary";
  const wrap = document.getElementById("confirm-input-wrap"), inp = document.getElementById("confirm-input");
  wrap.hidden = !input; if (input) { document.getElementById("confirm-input-label").textContent = input.label; inp.value = input.value ?? ""; inp.placeholder = input.placeholder ?? ""; }
  return new Promise((resolve) => {
    dlg.onclose = () => resolve(dlg.returnValue === "ok" ? (input ? inp.value : true) : null);
    dlg.showModal();
    if (input) inp.focus();
  });
}
