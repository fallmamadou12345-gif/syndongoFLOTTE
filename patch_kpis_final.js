#!/usr/bin/env node
// Patch SyNdongo — KPIs cohérents dashboard
// Marge = Facturé - Dépenses | Taux = Encaissé / Facturé
const fs = require('fs');

// ── SERVEUR : ajouter taux_recouvrement dans la réponse ──────
const SERVEUR = '/opt/render/project/src/serveur.js';
let srv = fs.readFileSync(SERVEUR, 'utf8');

// Chercher et afficher le contexte actuel
const idx = srv.indexOf('taux_marge');
console.log('Contexte actuel taux_marge:', srv.slice(idx-20, idx+80));

// Remplacer taux_marge par taux correct
const OLD_TAUX = `taux_marge:recPeriode>0?Math.round((recPeriode-depPeriode)/recPeriode*1000)/10:0,`;
const NEW_TAUX = `taux_marge:facPeriode>0?Math.round(recPeriode/facPeriode*1000)/10:100,`;

if(srv.includes(OLD_TAUX)){
  srv = srv.replace(OLD_TAUX, NEW_TAUX);
  // Aussi corriger la marge = facturé - dépenses
  srv = srv.replace(
    `marge:recPeriode-depPeriode,`,
    `marge:facPeriode-depPeriode,`
  );
  fs.writeFileSync(SERVEUR, srv);
  console.log('✅ Serveur : taux recouvrement + marge = facturé-dépenses');
} else {
  console.log('⚠️  Pattern taux_marge non trouvé — vérification:');
  console.log(srv.slice(idx, idx+120));
}

// ── FRONTEND : libellés KPIs ─────────────────────────────────
const INDEX = '/opt/render/project/src/index.html';
let html = fs.readFileSync(INDEX, 'utf8');

// 1. Renommer "Recettes totales" → "Total Encaissé"
html = html.replace(
  `<div class="kpi-label">Recettes totales</div><div class="kpi-val" id="k-rec"`,
  `<div class="kpi-label">Total Encaissé</div><div class="kpi-val" id="k-rec"`
);

// 2. Ajouter "Total Facturé" avant Marge (déplacer k-facture en 2e position)
// Les libellés sont déjà dans le bon ordre — juste corriger le texte du taux
const OLD_PCT = `document.getElementById('k-pct').textContent=d.kpis.taux_marge+'%';`;
const NEW_PCT = `const pctEl=document.getElementById('k-pct');
  if(pctEl) pctEl.textContent='Recouvrement '+d.kpis.taux_marge+'%';`;
html = html.replace(OLD_PCT, NEW_PCT);

// 3. Corriger l'affichage de la marge (c'est facturé-dépenses maintenant)
// Le champ k-marge reçoit déjà d.kpis.marge — OK côté serveur

fs.writeFileSync(INDEX, html);
console.log('✅ Frontend : libellés KPIs mis à jour');
console.log('\nRésumé des KPIs après patch:');
console.log('  Total Encaissé  = somme versements');
console.log('  Total Facturé   = somme facturations');
console.log('  Dépenses        = somme dépenses');
console.log('  Marge nette     = Facturé - Dépenses');
console.log('  Recouvrement    = Encaissé / Facturé %');
console.log('  Total Retards   = Σ MAX(0, Facturé-Encaissé) par véhicule');
