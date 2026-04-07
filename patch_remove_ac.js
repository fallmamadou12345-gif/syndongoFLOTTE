#!/usr/bin/env node
// Patch SyNdongo — Supprimer tout le code autocomplete qui casse les pages
const fs = require('fs');
const INDEX = '/opt/render/project/src/index.html';
let html = fs.readFileSync(INDEX, 'utf8');

const before = html.length;

// 1. Supprimer le CSS autocomplete
html = html.replace(/\/\* ── AUTOCOMPLETE VÉHICULE[\s\S]*?\.ac-clear\{[^}]+\}/g, '');

// 2. Supprimer tout le bloc JS autocomplete (de "// ─── AUTOCOMPLETE VÉHICULE" jusqu'à la fin du bloc)
html = html.replace(/\/\/ ─── AUTOCOMPLETE VÉHICULE[\s\S]*?\/\/ ─── AUTOCOMPLETE CHAUFFEURS[\s\S]*?^}/m, '');

// 3. Supprimer les blocs AC restants
html = html.replace(/\/\/ ─── AUTOCOMPLETE[\s\S]*?(?=\/\/ ─{3}|\n\/\/ [A-Z])/g, '');

// 4. Remplacer les inputs autocomplete par des selects normaux dans le HTML
// Facturation véhicule
html = html.replace(
  /<div class="ac-wrap"[^>]*>[\s\S]*?id="fv"[^>]*>[\s\S]*?id="fv-dd"[^>]*><\/div><\/div>/,
  '<select id="fv" onchange="onFacVeh()"><option value="">— choisir —</option></select>'
);
// Encaissement chauffeur
html = html.replace(
  /<div class="ac-wrap"[^>]*>[\s\S]*?id="ec"[^>]*>[\s\S]*?id="ec-dd"[^>]*><\/div><\/div>/,
  '<select id="ec" onchange="onEncChauffeur()"><option value="">— choisir —</option></select>'
);
// Affectation véhicule
html = html.replace(
  /<div class="ac-wrap"[^>]*>[\s\S]*?id="av"[^>]*>[\s\S]*?id="av-dd"[^>]*><\/div><\/div>/,
  '<select id="av"><option value="">— choisir —</option></select>'
);
// Affectation chauffeur
html = html.replace(
  /<div class="ac-wrap"[^>]*>[\s\S]*?id="ac"[^>]*>[\s\S]*?id="ac-dd"[^>]*><\/div><\/div>/,
  '<select id="ac"><option value="">— choisir —</option></select>'
);
// Dépenses véhicule
html = html.replace(
  /<div class="ac-wrap"[^>]*>[\s\S]*?id="dv"[^>]*>[\s\S]*?id="dv-dd"[^>]*><\/div><\/div>/,
  '<select id="dv"><option value="">— choisir —</option></select>'
);
// Dashboard filtre véhicule
html = html.replace(
  /<div class="ac-wrap"[^>]*>[\s\S]*?id="dash-filter-veh"[^>]*>[\s\S]*?id="dash-filter-veh-dd"[^>]*><\/div><\/div>/,
  '<select id="dash-filter-veh" style="font-size:12px;width:155px" onchange="loadDashboard()"><option value="">Tous véhicules</option></select>'
);
// Historique facturations
html = html.replace(
  /<div class="ac-wrap"[^>]*>[\s\S]*?id="ff-veh"[^>]*>[\s\S]*?id="ff-veh-dd"[^>]*><\/div><\/div>/,
  '<select id="ff-veh" style="font-size:12px;width:160px" onchange="loadFac()"><option value="">Tous véhicules</option></select>'
);
// Historique encaissements
html = html.replace(
  /<div class="ac-wrap"[^>]*>[\s\S]*?id="ve-veh"[^>]*>[\s\S]*?id="ve-veh-dd"[^>]*><\/div><\/div>/,
  '<select id="ve-veh" style="font-size:12px;width:160px" onchange="loadVersements()"><option value="">Tous véhicules</option></select>'
);

// 5. Supprimer les appels aux fonctions AC dans loadVersements
html = html.replace(/\/\/ Remplir le select véhicules si vide[\s\S]*?}\s*\n\s*}/m, '}');

const after = html.length;
fs.writeFileSync(INDEX, html);
console.log(`✅ Autocomplete supprimé — ${before - after} caractères retirés`);
console.log('Redémarrez le serveur pour appliquer.');
