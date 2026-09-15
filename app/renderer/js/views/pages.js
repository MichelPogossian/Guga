/** Vues secondaires : alertes, paramètres, journal, état. */
import { api } from "../api.js";
import { toast, confirm, h, raw } from "../ui.js";
import { fmt, label } from "../store.js";

export async function renderAlerts(root, openMessage) {
  const a = await api.alerts();
  root.innerHTML = `<div class="page"><h2>Alertes</h2><h3>Délais procéduraux (${a.procedural.length})</h3><div id="proc"></div><h3>RIB CARPA stagnants (${a.rib.length})</h3><div id="rib"></div></div>`;
  const proc = root.querySelector("#proc");
  proc.innerHTML = a.procedural.length ? a.procedural.map((x) => h`<div class="alert-item"><span class="when">${x.due_at || "—"}</span><div><b>${x.kind.replace(/_/g, " ")}</b> — ${x.subject}<br><span class="faint">${x.legal_basis || ""}</span><br><a href="#" data-open="${x.message_id}">Ouvrir l'e-mail</a> · <a href="#" data-ack="${x.id}">Accuser réception</a></div></div>`).join("") : `<p class="muted">Aucun délai en attente.</p>`;
  root.querySelector("#rib").innerHTML = a.rib.length ? a.rib.map((x) => h`<div class="alert-item"><span class="when">${x.days} j</span><div>Statut <b>${label(x.status)}</b> inchangé depuis ${fmt.dateTime(x.since)} · <a href="#" data-open="${x.messageId}">Ouvrir</a></div></div>`).join("") : `<p class="muted">Aucune demande stagnante (calcul quotidien à 8 h).</p>`;
  root.querySelectorAll("[data-open]").forEach((el) => el.addEventListener("click", (e) => { e.preventDefault(); openMessage(el.dataset.open); }));
  root.querySelectorAll("[data-ack]").forEach((el) => el.addEventListener("click", async (e) => { e.preventDefault(); await api.ackAlert(el.dataset.ack); toast("Réception accusée"); renderAlerts(root, openMessage); }));
}

export async function renderSettings(root) {
  const [s, contacts, cases, rules] = await Promise.all([api.settings(), api.contacts(), api.cases(), api.rules()]);
  const c = s.config;
  root.innerHTML = `<div class="page"><h2>Paramètres</h2>
    <div class="cards">
      <div class="card"><h4>Boîtes connectées</h4>${s.columns ? "" : ""}<ul>${(await api.columns()).mailboxes.map((m) => h`<li><b>${m.label}</b> ${m.address} <span class="faint">(${m.connector}${m.lastSyncAt ? ", sync " + fmt.dateTime(m.lastSyncAt) : ""})</span>${raw(m.lastError ? `<br><span style="color:var(--danger)">${m.lastError}</span>` : "")}</li>`).join("")}</ul><p class="faint">Connecteur : <b>${c.connector}</b>. Le connecteur Graph se configure dans config.toml et l'assistant de première ouverture (D1, D2).</p></div>
      <div class="card"><h4>IA</h4><p>Ollama local ${c.ai.enabled ? "activé" : "désactivé"} · modèle <b>${c.ai.model}</b> · embeddings <b>${c.ai.embedModel}</b><br>API externe pseudonymisée : <b>${c.externalAi.enabled ? "activée" : "désactivée (défaut)"}</b></p><p class="faint">Seuils : LLM si score &lt; ${c.thresholds.skipLlm} · confiance mini ${c.thresholds.minConfidence} · rattachement ${c.thresholds.caseLink} / écart ${c.thresholds.caseLinkGap}</p></div>
      <div class="card"><h4>Cabinet</h4><p>Domaine <b>${c.firmDomain}</b><br>Adresses de l'utilisatrice : ${c.userAddresses.join(", ")}<br>Comptabilité : ${c.accountingAddress}</p><p class="faint">Données : ${c.dataDir}</p></div>
      <div class="card"><h4>Sauvegardes</h4><p>Dernière : ${s.settings["backup.last"] ? fmt.dateTime(s.settings["backup.last"].at) : "aucune"}</p><div class="form-row"><input id="bk-dir" placeholder="Destination secondaire (lecteur réseau, D10)" value="${s.settings["backup.secondary_dir"] || ""}"><button id="bk-save">Enregistrer</button><button id="bk-now">Sauvegarder maintenant</button></div></div>
    </div>
    <h3>Contacts et rôles (${contacts.contacts.length})</h3>
    <div class="form-row"><input id="c-name" placeholder="Nom"><input id="c-emails" placeholder="e-mails séparés par ;"><select id="c-role"><option value="partner">Associé</option><option value="associate">Collaborateur</option><option value="opponent">Adversaire</option><option value="expert">Expert</option><option value="client">Client</option><option value="clerk">Huissier / greffe</option><option value="accounting">Comptabilité</option><option value="other">Autre</option></select><input id="c-firm" placeholder="Cabinet / société"><input id="c-bar" placeholder="Barreau"><input id="c-phone" placeholder="Téléphone"><button id="c-add" class="primary">Ajouter</button></div>
    <table class="tbl"><thead><tr><th>Nom</th><th>E-mails</th><th>Rôle</th><th>Cabinet</th><th></th></tr></thead><tbody id="c-body"></tbody></table>
    <h3>Dossiers Secib (${cases.cases.length})</h3>
    <div class="form-row"><input id="k-ref" placeholder="Réf. Secib"><input id="k-label" placeholder="Libellé"><input id="k-parties" placeholder="Parties séparées par |"><input id="k-court" placeholder="Juridiction"><input id="k-hearings" placeholder="Audiences ISO séparées par |"><button id="k-add" class="primary">Ajouter</button></div>
    <div class="form-row"><textarea id="k-csv" rows="3" placeholder="Import CSV Secib : ref;label;parties|;court;hearings|" style="flex:1"></textarea><button id="k-import">Importer</button></div>
    <table class="tbl"><thead><tr><th>Réf.</th><th>Libellé</th><th>Parties</th><th>Juridiction</th><th>Audiences</th></tr></thead><tbody>${cases.cases.map((k) => h`<tr><td class="mono">${k.secibRef}</td><td>${k.label}</td><td>${k.parties.join(", ")}</td><td>${k.court || ""}</td><td>${k.hearings.map((x) => fmt.dateTime(x)).join(", ")}</td></tr>`).join("")}</tbody></table>
    <h3>Règles de classement (YAML)</h3>
    ${rules.suggestions.length ? `<p>Suggestions issues des corrections : ${rules.suggestions.map((x) => h`<code>${x.when.from_domain} → ${x.column} (${x.count})</code>`).join(" ")}</p>` : ""}
    <textarea id="rules" class="code">${h`${rules.yaml}`}</textarea>
    <div class="form-row"><button id="rules-save" class="primary">Enregistrer les règles</button><span class="faint">Chaque modification est journalisée.</span></div>
    <h3>Précision sur 30 jours</h3><div id="acc"></div>
    <h3>Modèle de notification d'appel</h3><textarea id="call-tpl" rows="5" style="width:100%">${h`${s.settings["call.template"] || ""}`}</textarea><div class="form-row"><button id="call-save">Enregistrer</button><span class="faint">Variables : {{caller}} {{phone}} {{case}} {{subject}}</span></div>
  </div>`;
  const body = root.querySelector("#c-body");
  body.innerHTML = contacts.contacts.map((x) => h`<tr><td>${x.name}</td><td class="mono">${x.emails.join(", ")}</td><td>${x.role}</td><td>${x.firm || ""}</td><td><button data-del="${x.id}">Supprimer</button></td></tr>`).join("");
  body.querySelectorAll("[data-del]").forEach((b) => b.addEventListener("click", async () => { if (await confirm({ title: "Supprimer le contact", text: "Confirmer ?", danger: true })) { await api.deleteContact(b.dataset.del); renderSettings(root); } }));
  root.querySelector("#c-add").addEventListener("click", async () => {
    try { await api.saveContact({ name: v("#c-name"), emails: v("#c-emails").split(/[;,\s]+/).filter(Boolean), role: v("#c-role"), firm: v("#c-firm") || undefined, barId: v("#c-bar") || undefined, phone: v("#c-phone") || undefined }); toast("Contact ajouté"); renderSettings(root); } catch (e) { toast(e.message, "err"); }
  });
  root.querySelector("#k-add").addEventListener("click", async () => {
    try { await api.saveCase({ secibRef: v("#k-ref"), label: v("#k-label"), parties: v("#k-parties").split("|").filter(Boolean), court: v("#k-court") || undefined, hearings: v("#k-hearings").split("|").filter(Boolean) }); toast("Dossier ajouté"); renderSettings(root); } catch (e) { toast(e.message, "err"); }
  });
  root.querySelector("#k-import").addEventListener("click", async () => { try { const r = await api.importCases(v("#k-csv")); toast(`${r.imported} dossier(s) importé(s)`); renderSettings(root); } catch (e) { toast(e.message, "err"); } });
  root.querySelector("#rules-save").addEventListener("click", async () => { try { const r = await api.saveRules(v("#rules")); toast(`${r.count} règles enregistrées`); } catch (e) { toast(e.message, "err"); } });
  root.querySelector("#bk-save").addEventListener("click", async () => { await api.saveSettings({ "backup.secondary_dir": v("#bk-dir") || null }); toast("Destination enregistrée"); });
  root.querySelector("#bk-now").addEventListener("click", async () => { try { const r = await api.backup(); toast(r.path ? "Sauvegarde : " + r.path : "Échec de la sauvegarde", r.path ? "ok" : "err"); } catch (e) { toast(e.message, "err"); } });
  root.querySelector("#call-save").addEventListener("click", async () => { await api.saveSettings({ "call.template": v("#call-tpl") }); toast("Modèle enregistré"); });
  try { const a = await api.accuracy(); root.querySelector("#acc").innerHTML = `<table class="tbl"><thead><tr><th>Colonne</th><th>Placements IA</th><th>Corrections</th><th>Précision</th></tr></thead><tbody>${Object.entries(a.byColumn).map(([k, x]) => h`<tr><td>${k}</td><td>${x.placed}</td><td>${x.corrected}</td><td>${Math.round(x.precision * 100)} %</td></tr>`).join("") || `<tr><td colspan="4" class="muted">Pas encore de données</td></tr>`}</tbody></table>`; } catch { /* ignore */ }
  function v(sel) { return root.querySelector(sel).value.trim(); }
}

export async function renderAudit(root) {
  root.innerHTML = `<div class="page"><h2>Journal d'audit</h2><div class="form-row"><input id="a-action" placeholder="Action (ex. outlook.)"><input id="a-from" type="date"><input id="a-to" type="date"><button id="a-go">Filtrer</button><button id="a-verify">Vérifier la chaîne</button><button id="a-export">Exporter CSV signé</button><span id="a-res" class="faint"></span></div><table class="tbl"><thead><tr><th>#</th><th>Date</th><th>Acteur</th><th>Action</th><th>Cible</th><th>Résultat</th><th>Détail</th></tr></thead><tbody id="a-body"></tbody></table></div>`;
  const load = async () => {
    const q = { limit: 300 }; const act = root.querySelector("#a-action").value.trim(); if (act) q.action = act;
    const f = root.querySelector("#a-from").value; if (f) q.from = f; const t = root.querySelector("#a-to").value; if (t) q.to = t + "T23:59:59";
    const r = await api.audit(q);
    root.querySelector("#a-body").innerHTML = r.entries.map((e) => h`<tr><td class="mono">${e.seq}</td><td>${fmt.dateTime(e.at)}</td><td>${e.actor}</td><td>${e.action}</td><td class="mono">${(e.target_id || "").slice(0, 12)}</td><td>${e.result}</td><td class="mono" title="${e.hash}">${e.payload_json.slice(0, 120)}</td></tr>`).join("");
  };
  root.querySelector("#a-go").addEventListener("click", load);
  root.querySelector("#a-verify").addEventListener("click", async () => { const r = await api.auditVerify(); root.querySelector("#a-res").textContent = r.ok ? `Chaîne intègre (${r.checked} entrées)` : `CHAÎNE ROMPUE à la ligne ${r.brokenAt}`; });
  root.querySelector("#a-export").addEventListener("click", async () => { const csv = await api.auditCsv(); const p = await window.guga.saveFile("guga-journal.csv", csv); if (p) toast("Exporté : " + p); });
  await load();
}

export async function renderStatus(root) {
  const s = await api.status();
  root.innerHTML = `<div class="page"><h2>État</h2><div class="cards">
    <div class="card"><h4>Messages indexés</h4><div class="big">${s.messages}</div></div>
    <div class="card"><h4>File de classification</h4><div class="big">${s.queue.classify}</div><span class="faint">sync en attente : ${s.queue.sync}</span></div>
    <div class="card"><h4>IA locale</h4><div class="big">${s.ai.available ? "disponible" : "indisponible"}</div><span class="faint">${s.ai.model || "—"} · ${s.ai.embedModel || "sans embeddings"}</span></div>
    <div class="card"><h4>Espace disque</h4><div class="big">${s.diskFree ? (s.diskFree / 1e9).toFixed(1) + " Go" : "—"}</div><span class="faint">${s.dataDir}</span></div>
    <div class="card"><h4>Dernière sauvegarde</h4><div class="big">${s.lastBackup ? fmt.dateTime(s.lastBackup.at) : "aucune"}</div></div>
    <div class="card"><h4>Base</h4><div class="big">${s.dbEncrypted ? "chiffrée" : "non chiffrée"}</div><span class="faint">connecteur ${s.connector} · v${s.version}</span></div>
  </div><h3>Boîtes</h3><table class="tbl"><thead><tr><th>Boîte</th><th>Adresse</th><th>Dernière synchronisation</th><th>Erreur</th></tr></thead><tbody>${s.mailboxes.map((m) => h`<tr><td>${m.label}</td><td>${m.address}</td><td>${m.lastSyncAt ? fmt.dateTime(m.lastSyncAt) : "—"}</td><td style="color:var(--danger)">${m.lastError || ""}</td></tr>`).join("")}</tbody></table>
  <h3>Erreurs récentes</h3>${s.recentErrors.length ? `<ul>${s.recentErrors.map((e) => h`<li class="mono">${e.kind} — ${e.error}</li>`).join("")}</ul>` : `<p class="muted">Aucune.</p>`}</div>`;
}
