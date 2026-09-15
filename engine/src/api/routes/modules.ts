/** Routes des modules métier (§7). Les modules des phases 5–6 renvoient 501 avec le prérequis manquant. */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { ulid } from "ulid";
import type { Engine } from "../../engine.js";
import { RIB_STATES, RIB_TRANSITIONS } from "../../modules/rib.js";
import { extractParties, secibSheet, storeNewCase, verifyParties } from "../../modules/newcase.js";
import { findCaseCandidates } from "../../modules/caselink.js";

export async function registerModuleRoutes(app: FastifyInstance, e: Engine) {
  // --- RIB CARPA (§7.3) ---
  app.get("/modules/rib/states", async () => ({ states: RIB_STATES, transitions: RIB_TRANSITIONS }));
  app.post("/modules/rib/:id/transition", async (req) => {
    const { to } = z.object({ to: z.enum(RIB_STATES) }).parse(req.body);
    const id = (req.params as any).id;
    const r = e.rib.transition(id, to);
    return { ...r, message: e.repo.getMessage(id) };
  });
  app.patch("/modules/rib/:id", async (req) => {
    const id = (req.params as any).id;
    const info = z.object({ instructedBy: z.string().nullable().optional(), recipientKind: z.enum(["internal", "opponent", "other"]).nullable().optional(),
      recipientContact: z.string().nullable().optional(), caseId: z.string().nullable().optional(), ecarpaCreated: z.boolean().optional() }).parse(req.body);
    e.rib.update(id, info);
    return e.repo.getMessage(id);
  });

  // --- PROCÉDURE (§7.8) ---
  app.post("/modules/procedure/alerts/:alertId/ack", async (req) => {
    const alertId = (req.params as any).alertId;
    const a = e.db.prepare(`SELECT * FROM procedural_alert WHERE id=?`).get(alertId) as any;
    if (!a) throw Object.assign(new Error("alerte introuvable"), { statusCode: 404 });
    e.db.prepare(`UPDATE procedural_alert SET acknowledged=1 WHERE id=?`).run(alertId);
    e.db.prepare(`UPDATE placement SET status='ACCUSE', updated_at=? WHERE message_id=? AND column_code='PROCEDURE'`).run(new Date().toISOString(), a.message_id);
    e.audit.record("user", "procedure.ack", { kind: "message", id: a.message_id }, { alertId, kind: a.kind, dueAt: a.due_at });
    return { ok: true };
  });

  // --- NOUVEAUX DOSSIERS (§7.7) ---
  app.post("/modules/new-case/:id/verify", async (req) => {
    const id = (req.params as any).id;
    const m = e.repo.messageRaw(id);
    if (!m) throw Object.assign(new Error("introuvable"), { statusCode: 404 });
    const parties = extractParties(m.body_text);
    const r = await verifyParties(parties, e.adapters.filter((a) => a.enabled && a.lookup));
    storeNewCase(e.db, id, { parties, sheet: secibSheet(parties, { subject: m.subject }) }, r.checks, r.verdict, r.discrepancies);
    e.db.prepare(`UPDATE placement SET status=? WHERE message_id=? AND column_code='NOUVEAUX'`).run(r.verdict, id);
    e.audit.record("user", "newcase.verify", { kind: "message", id }, { verdict: r.verdict, adapters: e.adapters.filter((a) => a.enabled && a.lookup).map((a) => a.name) });
    return { parties, ...r, sheet: secibSheet(parties, { subject: m.subject }) };
  });

  // --- Rattachement dossier (§7.2) ---
  app.get("/modules/case-link/:id/candidates", async (req) => {
    const id = (req.params as any).id;
    const m = e.repo.messageRaw(id);
    if (!m) throw Object.assign(new Error("introuvable"), { statusCode: 404 });
    return { candidates: findCaseCandidates(e.db, `${m.subject}\n${m.body_text}`, [], null) };
  });
  app.post("/modules/case-link/:id", async (req) => {
    const id = (req.params as any).id;
    const { caseId } = z.object({ caseId: z.string() }).parse(req.body);
    e.placements.redirect(id, { caseId, status: e.db.prepare(`SELECT column_code FROM placement WHERE message_id=?`).pluck().get(id) === "CC" ? "RATTACHE" : undefined });
    return e.repo.getMessage(id);
  });

  // --- EXPERTISE (§7.10) : proposition de créneaux sans conflit avec les audiences connues ---
  app.get("/modules/expertise/:id/slots", async (req) => {
    const id = (req.params as any).id;
    const m = e.repo.getMessage(id);
    if (!m) throw Object.assign(new Error("introuvable"), { statusCode: 404 });
    const busy = new Set<string>();
    for (const c of e.repo.listCases()) for (const h of c.hearings) busy.add(String(h).slice(0, 10));
    const text = `${m.subject}\n${m.bodyText}`;
    const proposed = [...text.matchAll(/\b(lundi|mardi|mercredi|jeudi|vendredi)\s+(\d{1,2})\s+(janvier|février|mars|avril|mai|juin|juillet|août|septembre|octobre|novembre|décembre)(?:\s+(\d{4}))?(?:\s+(?:à\s+)?(\d{1,2})\s?h(\d{2})?)?/gi)]
      .map((x) => x[0]);
    return { proposed, busyDates: [...busy], note: "Agenda Outlook (Calendars.Read) non connecté : conflits vérifiés sur les audiences Secib importées uniquement." };
  });

  // --- Appel téléphonique (§7.14) ---
  app.post("/calls", async (req) => {
    const b = z.object({ caller: z.string().min(1), phone: z.string().optional(), caseId: z.string().nullable().optional(), subject: z.string().optional(), forwardedTo: z.string().optional() }).parse(req.body);
    const id = ulid();
    e.db.prepare(`INSERT INTO call_note(id,caller,phone,case_id,subject,forwarded_to,created_at) VALUES (?,?,?,?,?,?,?)`).run(id, b.caller, b.phone ?? null, b.caseId ?? null, b.subject ?? null, b.forwardedTo ?? null, new Date().toISOString());
    e.audit.record("user", "call.note", { kind: "call", id }, { caller: b.caller, forwardedTo: b.forwardedTo });
    const tpl = e.repo.getSetting<string>("call.template", "Bonjour,\n\n{{caller}}{{phone}} a appelé{{case}}{{subject}}.\n\nMerci de rappeler.\n\nBien à vous");
    const c = b.caseId ? e.repo.listCases().find((x) => x.id === b.caseId) : null;
    const body = tpl.replace("{{caller}}", b.caller).replace("{{phone}}", b.phone ? ` (${b.phone})` : "").replace("{{case}}", c ? ` au sujet du dossier ${c.secibRef} ${c.label}` : "").replace("{{subject}}", b.subject ? ` : ${b.subject}` : "");
    return { id, draft: { to: b.forwardedTo ? [b.forwardedTo] : [], subject: `Appel de ${b.caller}${c ? " — " + c.secibRef : ""}`, bodyHtml: body.replace(/\n/g, "<br>") } };
  });
  app.get("/calls/lookup", async (req) => {
    const { q } = z.object({ q: z.string().min(1) }).parse(req.query);
    const n = q.toLowerCase();
    return {
      contacts: e.repo.listContacts().filter((c) => c.name.toLowerCase().includes(n) || c.emails.some((x) => x.includes(n)) || (c.phone ?? "").includes(n)).slice(0, 8),
      cases: e.repo.listCases().filter((c) => c.label.toLowerCase().includes(n) || (c.secibRef ?? "").includes(n)).slice(0, 8),
    };
  });

  // --- Phases 5 et 6 : non livrées dans cette version ---
  const notYet = (what: string, prereq: string) => async (_req: unknown, reply: any) => reply.code(501).send({ error: `${what} : module prévu en ${prereq}` });
  app.post("/modules/hearing-pack/:case/generate", notYet("Dossier de plaidoirie", "phase 6 (modèles .docx du cabinet requis, D8)"));
  app.post("/modules/hearing-pack/:case/print", notYet("Impression du dossier de plaidoirie", "phase 6 (D8)"));
  app.post("/modules/pieces/:id/download", notYet("Téléchargement par navigateur piloté", "phase 5 (Playwright, D7)"));
  app.post("/modules/pieces/:id/split", notYet("Découpage des pièces", "phase 5"));
  app.post("/modules/pieces/:id/rename", notYet("Renommage depuis bordereau", "phase 5"));
}
