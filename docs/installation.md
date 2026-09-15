# Installation et exploitation (CDC §13)

## Prérequis poste
Windows 10 22H2+ / 11 x64, Node.js 22 LTS (embarqué dans l'installeur), Ollama (installé si absent),
GPU NVIDIA 12 Go recommandé (Qwen 2.5 14B), minimum 16 Go RAM (modèle 3B/7B Q4).

## Installation manuelle (avant l'installeur signé)
1. `npm install && npm run build` (compile `engine/dist`).
2. Copier `tools/config.example.toml` vers `%LOCALAPPDATA%\Guga\config.toml` et l'adapter (connecteur, domaine, adresses).
3. Service : `tools\winsw.exe install tools\guga-engine.winsw.xml` puis `tools\winsw.exe start guga-engine`.
4. Application : `npm run start -w app` (ou l'exécutable `Guga.exe` produit par `npm run dist -w app`).
5. Connecteur Graph (D1/D2) : enregistrer l'application dans Entra ID (permissions déléguées `Mail.Read`,
   `Mail.ReadWrite`, `Mail.Send`, `MailboxSettings.Read`, `Mail.Read.Shared`, `Mail.ReadWrite.Shared`), réaliser le flux
   authorization code + PKCE, puis enregistrer `graph.tenant`, `graph.client_id`, `graph.refresh_token` et
   `graph.shared_mailboxes` (JSON) dans le magasin de secrets (`secrets.json` 0600 ou DPAPI via l'application).

## Modèles IA
`ollama pull qwen2.5:14b` (ou `qwen2.5:7b`) et `ollama pull bge-m3`. Sans modèle d'embeddings, l'étape de similarité
est ignorée ; sans LLM, l'enrichissement est ignoré et le classement reste déterministe. Le moteur choisit le premier
modèle disponible si le modèle configuré est absent. Après 3 échecs ou délais consécutifs, l'IA est mise en pause
10 minutes (disjoncteur) pour ne pas bloquer la file.

## Sauvegardes et restauration
Snapshot cohérent quotidien (`backups/guga-AAAA-MM-JJ.db`, 14 jours) ; destination secondaire dans Paramètres (D10).
`npm run cli -- restore <fichier>` puis `npm run cli -- resync`.

## Recette technique (§14.2)
- Refus d'une action sans jeton d'intention : test `test/api.test.ts`.
- Intégrité du journal : `npm run cli -- audit verify` ou Paramètres → Journal → « Vérifier la chaîne ».
- Aucune écriture depuis le moteur : `test/invariants.test.ts`.
- Une correction manuelle influence un e-mail similaire : `test/classification.test.ts` (vote k-NN pondéré source=user).
