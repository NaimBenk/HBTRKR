// Keep infrastructure failures distinct from an empty calendar or local quota.
export function syncErrorMessage(error, projectId){
    const code = String(error?.code || error?.message || '');
    if(code === 'permission-denied' || code.endsWith('/permission-denied')){
        return `Firebase refuse l’accès aux données HBTRK (projet ${projectId}). Les règles Firestore doivent autoriser les documents de synchronisation dans users/{uid}/data. Tes changements locaux sont conservés. Réessaie après correction des règles.`;
    }
    if(code === 'unauthenticated' || code.endsWith('/unauthenticated')){
        return 'La session Firebase a expiré. Reconnecte-toi au même compte ; les changements locaux en attente sont conservés.';
    }
    if(code === 'sync-document-missing'){
        return 'Le document de synchronisation est introuvable sur le serveur. La copie locale est conservée : ne réimporte pas une sauvegarde pour contourner cette erreur.';
    }
    if(code === 'unsupported-sync-version') return 'Cette version des données nécessite une mise à jour de HBTRK. Recharge la page sans effacer les données du site.';
    if(typeof error === 'string') return error;
    return 'Le serveur est temporairement inaccessible. Les changements locaux sont conservés et l’envoi sera retenté automatiquement.';
}
