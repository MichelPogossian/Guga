/** Point d'entrée du renderer : navigation, recherche globale, flux d'événements, raccourcis. */
import { api } from "./api.js";
import { store } from "./store.js";
import { toast } from "./ui.js";
import "./components/guga-context-menu.js";
import { BoardView } from "./views/board.js";
import { renderAlerts, renderSettings, renderAudit, renderStatus } from "./views/pages.js";

const main = document.getElementById("main");
const board = new BoardView(main);
let view = "board";

store.set({ column: localStorage.getItem("guga.column") || "PUBS" });

async function show(name) {
  view = name;
  document.querySelectorAll("#nav button").forEach((b) => b.classList.toggle("on", b.dataset.view === name));
  try {
    if (name === "board") await board.mount();
    else if (name === "alerts") await renderAlerts(main, async (id) => { await show("board"); await board.open(id); });
    else if (name === "settings") await renderSettings(main);
    else if (name === "audit") await renderAudit(main);
    else if (name === "status") await renderStatus(main);
    setConnected(true);
  } catch (e) { setConnected(false); main.innerHTML = `<div class="page"><h2>Moteur injoignable</h2><p class="muted">${e.message}</p><p>Le service « Guga Engine » doit être démarré. En développement : <code>npm run engine</code>.</p><button id="retry">Réessayer</button></div>`; main.querySelector("#retry").addEventListener("click", () => show(name)); }
}
document.querySelectorAll("#nav button").forEach((b) => b.addEventListener("click", () => show(b.dataset.view)));

function setConnected(ok) { const c = document.getElementById("conn"); c.className = "conn " + (ok ? "ok" : "ko"); }
function banner(text, error = false) { const b = document.getElementById("banner"); if (!text) { b.hidden = true; return; } b.hidden = false; b.textContent = text; b.className = "banner" + (error ? " error" : ""); }

// Recherche globale ( / )
const gs = document.getElementById("global-search");
let gsTimer;
gs.addEventListener("input", () => { clearTimeout(gsTimer); gsTimer = setTimeout(async () => {
  const q = gs.value.trim();
  if (!q) { if (view === "board") await board.load(); return; }
  if (view !== "board") await show("board");
  try { const r = await api.search(q); board.grid.setItems(r.items); document.getElementById("count").textContent = `${r.items.length} résultat(s) toutes colonnes`; } catch (e) { toast(e.message, "err"); }
}, 250); });
document.addEventListener("keydown", (e) => {
  if (e.key === "/" && !/input|textarea|select/i.test(e.target.tagName)) { e.preventDefault(); gs.focus(); gs.select(); }
  if (e.key === "Escape" && e.target === gs) { gs.value = ""; gs.blur(); board.load(); }
});
document.getElementById("btn-call").addEventListener("click", () => window.guga.openCallPopup({}));
document.getElementById("btn-sync").addEventListener("click", async () => { try { await api.sync(); toast("Synchronisation lancée"); } catch (e) { toast(e.message, "err"); } });

// Flux SSE relayé par le processus principal
let refreshTimer = null;
window.guga.onEvent(({ type, data }) => {
  setConnected(true);
  if (type === "backlog" || type === "hello") { const n = data.remaining ?? data.backlog ?? 0; banner(n > 0 ? `Rattrapage en cours — ${n} e-mail${n > 1 ? "s" : ""} restant${n > 1 ? "s" : ""}` : null); }
  if (type === "sync" && data.status === "error") banner(`Synchronisation ${data.mailbox} : ${data.detail}`, true);
  if (type === "alert" && data.count) { const b = document.getElementById("nav-alerts"); b.hidden = false; b.textContent = data.count; }
  if ((type === "placement" || type === "sync" || type === "action") && view === "board") {
    clearTimeout(refreshTimer); refreshTimer = setTimeout(() => { board.refreshColumns(); board.load(); }, 800);
  }
});

show("board");
