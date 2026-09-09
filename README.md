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

Cette commande valide le JavaScript, exécute les tests de synchronisation et recompile le CSS Tailwind minifié.

## Données

Les habitudes, tâches, couleurs et complétions sont synchronisées avec Firebase pour l’utilisateur connecté. Le menu permet aussi d’exporter ou d’importer une sauvegarde JSON HBTRK.

## Synchronisation v3 — migration à vérifier avant publication

La sauvegarde précédente envoyait l'intégralité de l'état local avec `setDoc`. Une page en retard pouvait donc remplacer les ajouts/validations d'un autre appareil. Les snapshots distants étaient aussi ignorés pendant certaines sauvegardes locales. Il ne suffisait pas de raccourcir le délai d'envoi.

Le nouveau système enregistre immédiatement chaque modification dans un journal local, puis la fusionne avec la version serveur **dans une transaction Firestore**. Chaque champ est comparé à la valeur que l'utilisateur avait réellement vue. Les changements indépendants sont conservés ; les changements concurrents incompatibles ne remplacent pas silencieusement la valeur serveur. Les derniers conflits sont conservés localement et exportables en cliquant sur l'indicateur « À vérifier » (le fichier de récupération décrit les modifications ; ce n'est pas un import HBTRK standard).

- Les opérations non confirmées survivent à la fermeture/reconnexion du navigateur et restent séparées par utilisateur. Ne pas effacer les données du site en présence de changements non sauvegardés.
- Un accusé de réception par flux empêche de rejouer deux fois une opération après une coupure. Les reçus ne doivent pas être supprimés arbitrairement : un appareil peut revenir après une longue période hors ligne.
- Les changements distants sont reçus en temps réel et les opérations locales encore en attente sont réappliquées par-dessus.
- Les habitudes ont désormais un identifiant stable : leur renommage n'efface pas des validations réalisées ailleurs.
- Les reports automatiques ont des identifiants déterministes et respectent les marqueurs de suppression.
- Les simples confirmations de sauvegarde ne reconstruisent pas toute la vue.

### Emplacements Firestore et droits d'accès

Tous les documents restent sous `users/{uid}/data/` et ne doivent être accessibles qu'à l'utilisateur authentifié dont `request.auth.uid == uid` :

| Document | Utilisation |
| --- | --- |
| `fourpill` | Ancienne version, lue uniquement lors de la migration ; le nouveau code ne la modifie pas. |
| `fourpill-v3` | Données courantes, lecture et écriture transactionnelle. |
| `sync-v3-migration` | Marqueur de migration, lecture et création transactionnelle. |
| `sync-v3-{identifiant}` | Reçu d'opérations, lecture et écriture transactionnelle. |

Le [fragment HBTRK](docs/firestore-hbtrk.rules) ajoute uniquement les autorisations nécessaires au propriétaire de ces documents. Il doit être inséré **dans** `match /databases/{database}/documents` des règles du projet **`habit-8d57f`**, en conservant les autres blocs. Ce n'est pas un fichier de règles complet à publier seul. Il n'accorde aucun accès aux données d'un autre utilisateur et n'ajoute pas d'accès administrateur aux habitudes/tâches.

Les règles fournies dans la conversation le 9 septembre ne contiennent aucun bloc `users/{uid}/data` : elles refuseraient aussi la lecture de l'ancien document `fourpill`. Vérifier qu'elles viennent bien de ce projet, et non de l'application de planning qui utilise les collections `employees`, `schedules` et `organizations`. Le compte connecté à la CLI a reçu un refus HTTP 403 lors de la lecture des règles du projet `habit-8d57f` : le fragment n'a pas été publié ni validé contre les règles réellement déployées.

Dans Firebase → Firestore Database → Règles, insérer le fragment, vérifier sa compilation et publier. Un `acp` / déploiement Netlify **ne publie pas les règles Firestore**. Le document historique reste en lecture seule pour le nouveau client ; les éventuelles autorisations présentes dans d'autres blocs sont inchangées (les règles Firestore sont additives).

Une erreur de permission conserve le journal local et affiche maintenant une explication visible avec un bouton Réessayer. Elle ne déclenche jamais de retour à une sauvegarde complète non protégée. Sans première lecture réussie ni cache vérifié, Home/Day restent sur un état de connexion explicite et l'ajout/import/export sont désactivés, plutôt que d'afficher ou exporter un faux calendrier vide. Une copie locale existante reste utilisable et exportable.

La migration lit la version serveur dans une transaction, une seule fois, et conserve l'ancien document. Une migration déjà effectuée n'est pas rejouée si le nouveau document disparaît. Les anciennes pages encore ouvertes peuvent toujours écrire dans `fourpill`, mais ne peuvent pas remplacer `fourpill-v3`. Leurs modifications ultérieures ne sont **pas** fusionnées automatiquement : recharger tous les appareils lors de la mise à jour.

Avant cette première mise à jour, exporter une sauvegarde depuis chaque appareil contenant des changements à garder. L'ancien cache IndexedDB n'est ni effacé ni rejoué automatiquement, car il pourrait contenir des écritures complètes périmées. Les données déjà écrasées avant le correctif ne sont récupérables que depuis un export, une autre copie intacte ou une sauvegarde serveur existante. Revenir à un ancien déploiement ne constitue pas un rollback des données v3.

### Indicateur et annulation

« Sauvegardé » signifie que le serveur a confirmé les opérations. « Sauvegarde… » signifie qu'elles sont conservées localement mais encore en attente du serveur. « Hors ligne » / « Erreur sync » signalent un envoi non confirmé ; l'envoi est retenté automatiquement. Si le stockage local est indisponible ou plein, l'application refuse le changement et l'indique, plutôt que de prétendre l'avoir sauvegardé.

Le bouton ↶ du header (ou Ctrl/Cmd + Z hors des champs de saisie) annule la dernière action locale. L'historique reste sur l'appareil, limité à 20 actions et environ 250 000 caractères JSON ; les gros imports peuvent dépasser ce budget et ne pas être annulables. Il restaure uniquement les éléments concernés, jamais une ancienne copie complète qui écraserait les changements d'un autre appareil. Un conflit d'annulation est signalé et conservé pour récupération.

### Validation

`npm test` couvre les transactions concurrentes, un téléphone en retard, les modifications hors ligne, les fermetures/réouvertures, les accusés perdus, plusieurs onglets, les conflits, les reports, l'archivage, les imports/exports et l'annulation. Le banc de tests simule les réessais de transaction avec le même code de fusion que l'application ; ce n'est pas un test de l'émulateur ni du projet Firebase réel.

Après validation des règles et déploiement, vérifier avec un compte de test sur deux appareils : laisser le téléphone ouvert, ajouter/cocher sur PC, modifier un autre élément sur téléphone ; les deux résultats doivent rester présents. Refaire avec le téléphone hors ligne puis reconnecté, et avec un onglet fermé juste après une modification. Attendre « Sauvegardé » et recharger les deux côtés pour confirmer la persistance serveur.

Références : [transactions Firestore](https://firebase.google.com/docs/firestore/manage-data/transactions), [cache hors ligne et dernière écriture gagnante](https://firebase.google.com/docs/firestore/manage-data/enable-offline).
