# Guga — application locale de pilotage des e-mails du cabinet

Implémentation du cahier des charges technique v1.0 (15/09/2026) : moteur Node.js/TypeScript exécuté en
service Windows, application bureau Electron avec interface HTML/CSS/JS natifs, base SQLite locale,
IA locale (Ollama). Les e-mails restent dans Outlook ; aucune action irréversible n'est jamais automatique.

```
Guga/
  engine/        moteur (service) : connecteurs, pipeline de classification, API 127.0.0.1, jobs, audit
  app/           application Electron : fenêtre, tray, popup appel, renderer (Web Components, grille virtualisée)
  tools/         WinSW (service Windows), config.toml d'exemple
  docs/          notes d'installation et d'exploitation
```

## Démarrage rapide (développement, connecteur simulé)

```bash
npm install
npm run engine          # moteur sur 127.0.0.1:8765, données dans ~/.guga (ou %LOCALAPPDATA%\Guga)
npm run app             # application Electron (dans un second terminal)
npm test                # 28 tests : audit chaîné, règles, échéances, RIB, API, invariant « moteur sans écriture »
```

Variables utiles : `GUGA_DATA_DIR`, `GUGA_API_PORT`, `GUGA_CONNECTOR` (`fake` | `graph`), `GUGA_AI_ENABLED=0`,
`GUGA_AI_MODEL`, `GUGA_AI_EMBED_MODEL`. Sans Ollama (ou avec `GUGA_AI_ENABLED=0`), le classement fonctionne par
règles + garde-fous + similarité ; le LLM n'est qu'un étage d'enrichissement (résumé, échéance, entités, re-classement).

Mode web de développement (interface sans Electron, pour la recette) : `node app/scripts/dev-web.js` puis
http://127.0.0.1:8790 — le jeton de session reste côté serveur.

## Architecture (CDC §3)

- **Plan de lecture** : `SyncService` (delta → normalisation → index FTS → placement provisoire → job de
  classification rapide → job d'enrichissement LLM). Il ne détient aucune fonction d'écriture ; le test
  `test/invariants.test.ts` l'impose par analyse statique et par exécution.
- **Plan d'action** : `ActionService` seul détenteur du `MailboxWriter`. Chaque route `/actions/*` exige un
  jeton d'intention à usage unique (`POST /intents`) émis au moment de la confirmation utilisateur, et tout
  appel est journalisé (`action_log`, ajout seul, chaîne SHA-256, triggers SQL anti UPDATE/DELETE).
- **Pipeline** (`engine/src/classify`) : garde-fous → règles YAML (`engine/rules/rules.yaml`) → similarité
  k-NN sur embeddings → LLM local (sortie JSON Schema validée par zod, prompt `engine/prompts/classify_v3.md`)
  → fusion 0,45 / 0,25 / 0,30, contraintes dures, seuil 0,55 avec colonne de repli (aucun message sans colonne).
- **Apprentissage** : chaque redirection manuelle alimente `ai_feedback` et le vote k-NN ; un placement validé
  par l'utilisatrice n'est jamais écrasé par l'IA ; suggestions de règles hebdomadaires depuis les corrections.
- **Modules** : RIB CARPA (machine à états, alertes de stagnation, bandeau « destinataire adverse » et double
  confirmation), PROCÉDURE (catalogue `engine/rules/procedure_catalog.yaml`, échéances jours ouvrés / art. 642 CPC,
  preuve textuelle, accusé de réception), NOUVEAUX DOSSIERS (extraction parties/RCS/avocat, adaptateur Pappers,
  verdict VÉRIFIÉ / INCOHÉRENCE / PENDING, fiche « prête à saisir » Secib), EXPERTISE (qualification, dates
  proposées), CONTACT (alerte « seule destinataire »), CLAIRE (transfert comptabilité), appel téléphonique
  (popup toujours au premier plan, Ctrl+Alt+A, note + brouillon depuis modèle).

## Périmètre livré et restes à faire

| Phase (CDC §15) | État |
|---|---|
| 1 — socle (service, connecteur, base, pipeline, tableau, recherche, filtres) | livré |
| 2 — actions (jetons d'intention, suppression douce, déplacement, transfert, redirection, audit chaîné, apprentissage) | livré |
| 3 — workflows RIB, INSTRUCTIONS, PROCÉDURE | livré (catalogue de motifs à enrichir en atelier) |
| 4 — vérifications RCS / barreaux | extraction + adaptateur Pappers livrés ; extracteurs de barreaux et Infogreffe à cadrer (D7) |
| 5 — pièces à télécharger (Playwright, découpage, renommage) | détection des liens livrée ; téléchargement/découpage renvoient 501 (D7) |
| 6 — dossiers de plaidoirie (docx, A3, impression) | 501 — dépend des modèles du cabinet (D8) |
| 7 — expertise | qualification et créneaux livrés ; agenda Outlook (Calendars.Read) et brouillons vers l'expert à connecter |
| 8 — appel | livré (popup, raccourci global, modèle d'e-mail) ; CTI à cadrer (D9) |

Autres points ouverts : connecteur IMAP (repli D1, non livré) ; chiffrement SQLCipher activé automatiquement si
`better-sqlite3-multiple-ciphers` est installé (Windows), sinon base non chiffrée avec avertissement ;
l'application Electron gère les secrets via `safeStorage` (DPAPI) ; l'installeur NSIS est configuré dans
`app/package.json` (`npm run dist -w app`) mais n'a pas été produit sur macOS.

## Exploitation

- `npm run cli -- status | resync | audit verify | audit export | backup | restore <fichier>`
- Service Windows : `tools/guga-engine.winsw.xml` (démarrage automatique différé, redémarrage sur échec).
- Sauvegarde quotidienne 3 h (14 jours, destination secondaire configurable), alertes RIB 8 h, purge cache 90 j,
  suggestions de règles le lundi 7 h. Journaux techniques pino sans contenu métier.

## Vérifié sur le poste de développement (macOS, 15/09/2026)
- `npm test` : 28 tests verts (audit chaîné et triggers, règles/garde-fous sur le corpus de 27 e-mails typés, échéances
  et jours fériés, machine à états RIB, API avec jetons d'intention, invariant « moteur sans écriture », apprentissage).
- Interface (mode web de développement) : tableau, lecteur, menu contextuel, suppression douce avec confirmation → jeton
  d'intention → journal, page Journal avec vérification de chaîne, Paramètres, État.
- Non vérifié ici : service Windows, SQLCipher, installeur NSIS, connecteur Graph sur un vrai tenant, LLM (Ollama trop
  lent sans GPU sur ce poste ; le pipeline a été validé sans LLM et le chemin LLM est couvert par le schéma zod).
