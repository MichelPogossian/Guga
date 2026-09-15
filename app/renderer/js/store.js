/** Store d'événements minimal : état applicatif + abonnements (§3.2 « store d'événements simple »). */
export class Store {
  constructor(initial) { this.state = initial; this.subs = new Set(); }
  get() { return this.state; }
  set(patch) {
    const next = typeof patch === "function" ? patch(this.state) : { ...this.state, ...patch };
    this.state = next;
    for (const fn of this.subs) fn(this.state);
  }
  subscribe(fn) { this.subs.add(fn); return () => this.subs.delete(fn); }
}

export const store = new Store({
  view: "board",
  columns: [], backlog: 0, mailboxes: [],
  column: "PUBS", filter: { q: "", urgent: false, processed: "0", status: "", sort: "received_desc" },
  items: [], total: 0, selected: new Set(), current: null, currentDetail: null,
  connected: false, banner: null,
});

export const fmt = {
  date(iso) {
    if (!iso) return "";
    const d = new Date(iso); const now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    return sameDay ? d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" }) : d.toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit", year: d.getFullYear() === now.getFullYear() ? undefined : "2-digit" });
  },
  dateTime(iso) { return iso ? new Date(iso).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" }) : ""; },
  countdown(iso) {
    if (!iso) return null;
    const ms = Date.parse(iso.length <= 10 ? iso + "T23:59:00" : iso) - Date.now();
    const h = Math.round(ms / 3600_000);
    if (ms < 0) return { text: `dépassé ${fmt.date(iso)}`, late: true };
    if (h < 24) return { text: `dans ${h} h`, late: false };
    const dd = Math.round(h / 24);
    return { text: `J-${dd} (${fmt.date(iso)})`, late: false };
  },
  size(n) { return n == null ? "" : n > 1e6 ? (n / 1e6).toFixed(1) + " Mo" : n > 1e3 ? Math.round(n / 1e3) + " Ko" : n + " o"; },
};

export const STATUS_LABELS = {
  RATTACHE: "Rattaché", NON_RATTACHE: "Non rattaché", A_EDITER: "À éditer", A_VERIFIER: "À vérifier", A_FAIRE_VERIFIER: "À faire vérifier",
  EN_ATTENTE: "En attente", A_ENVOYER_AVEC_PROTOCOLE: "À envoyer avec protocole", ENVOYE: "Envoyé", A_PREPARER: "À préparer", GENERE: "Généré", IMPRIME: "Imprimé",
  A_TRAITER: "À traiter", EN_COURS: "En cours", FAIT: "Fait", PENDING: "Vérification en cours", VERIFIE: "Vérifié", INCOHERENCE: "Incohérence", SAISI: "Saisi dans Secib",
  A_ACCUSER: "À accuser", ACCUSE: "Accusé", AGENDA: "Inscrit à l'agenda", A_TELECHARGER: "À télécharger", TELECHARGE: "Téléchargé", DECOUPE: "Découpé",
  A_QUALIFIER: "À qualifier", DATES_PROPOSEES: "Dates proposées", NOTIFIE: "Notifié", TRAITE: "Traité", TRANSFERE_COMPTA: "Transféré à la compta",
};
export const label = (s) => (s ? STATUS_LABELS[s] ?? s : "");
