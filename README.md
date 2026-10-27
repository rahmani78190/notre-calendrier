# Notre Calendrier

Calendrier à deux avec un globe des lieux et des rappels sur téléphone.

- `site/` : l'appli (mise en ligne automatiquement sur GitHub Pages).
- `scripts/notify.mjs` : le robot qui envoie les rappels, lancé toutes les 15 minutes par `.github/workflows/notify.yml`.
- Les données (événements, prénoms, téléphones inscrits) sont dans Firebase (offre gratuite).

Le secret `FIREBASE_SERVICE_ACCOUNT` (Settings → Secrets and variables → Actions) contient la clé du compte de service Firebase.
