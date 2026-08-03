# HBTRK

HBTRK est un calendrier annuel pour suivre des habitudes récurrentes et organiser les tâches de chaque journée.

## Lancer le site en local

Le projet doit être servi par un serveur local : ouvrir directement `index.html` empêche les modules JavaScript et l’authentification de fonctionner correctement.

```powershell
npm install
npm run dev
```

Ouvrir ensuite [http://127.0.0.1:4173](http://127.0.0.1:4173).

Un aperçu local sans connexion Firebase est disponible à l’adresse suivante :

```text
http://127.0.0.1:4173/?preview=1
```

## Vérifier la version

```powershell
npm run check
```

Cette commande valide le JavaScript et recompile le CSS Tailwind minifié.

## Données

Les habitudes, tâches, couleurs et complétions sont synchronisées avec Firebase pour l’utilisateur connecté. Le menu permet aussi d’exporter ou d’importer une sauvegarde JSON HBTRK.
