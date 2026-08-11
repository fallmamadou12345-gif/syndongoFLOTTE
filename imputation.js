// imputation.js — logique d'imputation FIFO des versements sur les facturations.
// Fichier UNIQUE partagé entre le serveur (require('./imputation.js')) et le
// navigateur (<script src="/imputation.js">) — une seule fonction, un seul
// comportement, deux runtimes. Ne jamais dupliquer cette logique ailleurs.
//
// Extrait à l'identique de l'ancienne fonction imputerVersements() d'index.html
// (Phase Financement 1) — comportement strictement inchangé.

/**
 * imputerVersements(facsTout, versTout, facsPeriodeIds, affIds)
 *
 * Logique : les versements règlent les facturations dans l'ordre chronologique (FIFO).
 * On calcule combien de chaque facture a été réglé, puis on somme
 * uniquement pour les factures de la période choisie.
 *
 * Résultat : { encImpute, retard }
 * - encImpute : montant encaissé imputé sur la période (≤ facturé période)
 * - retard    : montant non encore payé pour la période
 */
function imputerVersements(facsTout, versTout, facsPeriodeIds, affIds) {
  // Trier les facturations par date (plus ancien en premier)
  var facsTriees = (facsTout||[]).slice().sort(function(a,b){ return a.date.localeCompare(b.date); });

  // Trier les versements par date
  // affIds=null signifie que versTout est déjà filtré par le bon véhicule
  var versFiltrés = affIds === null
    ? (versTout||[]).slice()
    : (versTout||[]).filter(function(vs){ return (affIds||[]).includes(vs.affectation_id); });
  var versTriees = versFiltrés.sort(function(a,b){ return a.date_versement.localeCompare(b.date_versement); });

  // Pool FIFO : chaque versement est utilisé une seule fois
  var pool = versTriees.map(function(vs){ return vs.montant; });

  // Imputer séquentiellement sur chaque facture (ordre chronologique)
  var imputations = {};
  facsTriees.forEach(function(fac) {
    var due = fac.montant_facture || 0;
    var impute = 0;
    for (var i = 0; i < pool.length && due > 0; i++) {
      var prise = Math.min(pool[i], due);
      impute += prise;
      pool[i] -= prise;
      due -= prise;
    }
    imputations[fac.id] = impute;
  });

  // Sommer uniquement sur les factures de la période demandée
  var periodeSet = new Set(facsPeriodeIds || []);
  var facMontant = 0, encImpute = 0;
  facsTriees.forEach(function(fac) {
    if (periodeSet.has(fac.id)) {
      facMontant += (fac.montant_facture || 0);
      encImpute  += (imputations[fac.id] || 0);
    }
  });

  // Cap : l'encaissé imputé ne peut pas dépasser le facturé de la période
  encImpute = Math.min(encImpute, facMontant);
  return { encImpute: encImpute, retard: Math.max(0, facMontant - encImpute) };
}

// Compatibilité Node (require) sans rien changer à l'exécution navigateur.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { imputerVersements: imputerVersements };
}
