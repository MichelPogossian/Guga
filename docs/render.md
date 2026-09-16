# Déploiement de démonstration sur Render

Ce mode sert l'interface et le moteur **avec le connecteur simulé** (corpus de 27 e-mails) : ni Outlook, ni Ollama,
ni données réelles. Le CDC impose une exécution mono-poste pour le cabinet ; Render n'est qu'une vitrine.

1. Pousser le dépôt sur GitHub (fait : `MichelPogossian/Guga`).
2. Render → **New → Blueprint** → choisir le dépôt ; `render.yaml` est détecté.
3. Renseigner `GUGA_WEB_PASSWORD` (demandé car `sync: false`). Identifiant : `guga`.
4. Déployer. Santé : `GET /healthz`. Interface : `https://guga-demo.onrender.com` (authentification HTTP Basic).

Notes
- Plan `starter` requis pour le disque persistant `/var/data` (SQLite). En plan `free`, supprimer le bloc `disk`
  et `GUGA_DATA_DIR` : la base est recréée à chaque déploiement, ce qui est acceptable pour une démo.
- L'API Fastify reste liée à 127.0.0.1 dans le conteneur ; seul le serveur web (0.0.0.0:$PORT) est exposé et il
  injecte le jeton de session côté serveur.
- Test local du mode web : `npm run build -w engine && GUGA_WEB_PASSWORD=secret GUGA_AI_ENABLED=0 PORT=8790 npm run web -w engine`.

## Service déployé (16/09/2026)
- Service Render `guga` (`srv-dal8d78ae00c73ftmcgg`), région Francfort, plan free, dépôt public `MichelPogossian/Guga`, déploiement automatique sur `main`.
- URL : https://guga-pe2k.onrender.com — identifiant `guga`, mot de passe dans la variable d'environnement `GUGA_WEB_PASSWORD` du service (tableau de bord Render → guga → Environment).
- Plan free : la base SQLite est recréée à chaque déploiement et le service s'endort après 15 min d'inactivité (premier accès lent).
