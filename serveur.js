// SyNdongo - Serveur Node.js (pas besoin de Python !)
const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

const DB_FILE = './syndongo_data.json';
const PORT = process.env.PORT || 8000;

// Base de données en fichier JSON local
function loadDB() {
  if (!fs.existsSync(DB_FILE)) {
    const init = {
      vehicules: [
        { id: "v1", immatriculation: "DK-4821-A", marque: "Samand", modele: "LX", annee: 2019, statut: "actif", km_actuel: 87200, km_prochain_vidange: 88000 },
        { id: "v2", immatriculation: "DK-3310-B", marque: "Kia", modele: "Picanto", annee: 2020, statut: "en_panne", km_actuel: 54300, km_prochain_vidange: 56000 },
        { id: "v3", immatriculation: "DK-9901-A", marque: "Hyundai", modele: "i10", annee: 2018, statut: "actif", km_actuel: 112000, km_prochain_vidange: 114000 },
        { id: "v4", immatriculation: "DK-1143-B", marque: "Samand", modele: "LX", annee: 2019, statut: "actif", km_actuel: 76500, km_prochain_vidange: 80000 },
        { id: "v5", immatriculation: "DK-5502-C", marque: "Kia", modele: "Morning", annee: 2021, statut: "actif", km_actuel: 41200, km_prochain_vidange: 45000 }
      ],
      chauffeurs: [
        { id: "c1", prenom: "Ibrahima", nom: "Sy",     telephone: "+221771234567", numero_permis: "SN-2018-00123", statut: "actif" },
        { id: "c2", prenom: "Amadou",   nom: "Diallo", telephone: "+221781234568", numero_permis: "SN-2017-00456", statut: "actif" },
        { id: "c3", prenom: "Cheikh",   nom: "Ndiaye", telephone: "+221701234569", numero_permis: "SN-2019-00789", statut: "actif" },
        { id: "c4", prenom: "Moussa",   nom: "Diouf",  telephone: "+221761234570", numero_permis: "SN-2016-00321", statut: "actif" },
        { id: "c5", prenom: "Pape",     nom: "Fall",   telephone: "+221751234571", numero_permis: "SN-2020-00654", statut: "actif" }
      ],
      affectations: [
        { id: "a1", vehicule_id: "v1", chauffeur_id: "c1", montant_journalier: 12000, date_debut: "2024-01-01", date_fin: null },
        { id: "a2", vehicule_id: "v3", chauffeur_id: "c3", montant_journalier: 10000, date_debut: "2024-01-01", date_fin: null },
        { id: "a3", vehicule_id: "v4", chauffeur_id: "c4", montant_journalier: 10000, date_debut: "2024-01-01", date_fin: null },
        { id: "a4", vehicule_id: "v5", chauffeur_id: "c5", montant_journalier: 11500, date_debut: "2024-01-01", date_fin: null }
      ],
      versements: [],
      depenses: [],
      alertes: []
    };
    fs.writeFileSync(DB_FILE, JSON.stringify(init, null, 2));
  }
  return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
}

function saveDB(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function today() {
  return new Date().toISOString().split('T')[0];
}

// Routeur API
function handleAPI(req, res, body) {
  const db = loadDB();
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;
  const method = req.method;

  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  let data = {};
  try { data = body ? JSON.parse(body) : {}; } catch(e) {}

  // --- DASHBOARD ---
  if (pathname === '/api/dashboard' && method === 'GET') {
    const totalRecettes = db.versements.reduce((s, v) => s + v.montant, 0);
    const totalDepenses = db.depenses.reduce((s, d) => s + d.montant, 0);
    const actifs = db.vehicules.filter(v => v.statut === 'actif').length;
    const alertes = [];
    db.vehicules.forEach(v => {
      if (v.km_prochain_vidange && v.km_actuel >= v.km_prochain_vidange * 0.95)
        alertes.push({ type: 'warn', message: `Vidange due — ${v.immatriculation} : ${v.km_actuel.toLocaleString()} km / seuil ${v.km_prochain_vidange.toLocaleString()} km` });
    });
    db.versements.filter(v => v.statut === 'partiel').forEach(v => {
      const aff = db.affectations.find(a => a.id === v.affectation_id);
      const c = aff ? db.chauffeurs.find(x => x.id === aff.chauffeur_id) : null;
      alertes.push({ type: 'danger', message: `Versement partiel — ${c ? c.prenom + ' ' + c.nom : '?'} : écart ${(v.montant_attendu - v.montant).toLocaleString()} FCFA` });
    });
    return res.end(JSON.stringify({
      kpis: { recettes_30j: totalRecettes, depenses_30j: totalDepenses, marge_nette_30j: totalRecettes - totalDepenses,
              taux_marge: totalRecettes > 0 ? Math.round((totalRecettes - totalDepenses) / totalRecettes * 100 * 10) / 10 : 0,
              vehicules_actifs: actifs, vehicules_total: db.vehicules.length, chauffeurs_actifs: db.chauffeurs.filter(c => c.statut === 'actif').length },
      alertes
    }));
  }

  // --- VEHICULES ---
  if (pathname === '/api/vehicules' && method === 'GET') {
    return res.end(JSON.stringify(db.vehicules.map(v => ({
      ...v, alerte_vidange: !!(v.km_prochain_vidange && v.km_actuel >= v.km_prochain_vidange * 0.95)
    }))));
  }
  if (pathname === '/api/vehicules' && method === 'POST') {
    if (db.vehicules.find(v => v.immatriculation === data.immatriculation?.toUpperCase()))
      return res.end(JSON.stringify({ detail: 'Immatriculation déjà enregistrée' }));
    const v = { id: uid(), ...data, immatriculation: data.immatriculation.toUpperCase() };
    db.vehicules.push(v);
    saveDB(db);
    return res.end(JSON.stringify({ id: v.id, message: 'Véhicule créé' }));
  }
  const vMatch = pathname.match(/^\/api\/vehicules\/(.+)$/);
  if (vMatch && method === 'DELETE') {
    const id = vMatch[1];
    if (db.affectations.find(a => a.vehicule_id === id && !a.date_fin))
      return res.end(JSON.stringify({ detail: 'Impossible : un chauffeur est affecté à ce véhicule' }));
    db.vehicules = db.vehicules.filter(v => v.id !== id);
    saveDB(db);
    return res.end(JSON.stringify({ message: 'Véhicule supprimé' }));
  }
  if (vMatch && method === 'PATCH') {
    const id = vMatch[1];
    const idx = db.vehicules.findIndex(v => v.id === id);
    if (idx === -1) return res.end(JSON.stringify({ detail: 'Introuvable' }));
    db.vehicules[idx] = { ...db.vehicules[idx], ...data };
    saveDB(db);
    return res.end(JSON.stringify({ message: 'Mis à jour' }));
  }

  // --- CHAUFFEURS ---
  if (pathname === '/api/chauffeurs' && method === 'GET') {
    return res.end(JSON.stringify(db.chauffeurs.filter(c => c.statut === 'actif')));
  }
  if (pathname === '/api/chauffeurs' && method === 'POST') {
    if (db.chauffeurs.find(c => c.telephone === data.telephone))
      return res.end(JSON.stringify({ detail: 'Téléphone déjà enregistré' }));
    const c = { id: uid(), ...data, statut: 'actif', date_embauche: today() };
    db.chauffeurs.push(c);
    saveDB(db);
    return res.end(JSON.stringify({ id: c.id, message: 'Chauffeur enregistré' }));
  }
  const cMatch = pathname.match(/^\/api\/chauffeurs\/(.+)$/);
  if (cMatch && method === 'DELETE') {
    const id = cMatch[1];
    const idx = db.chauffeurs.findIndex(c => c.id === id);
    if (idx !== -1) { db.chauffeurs[idx].statut = 'depart'; saveDB(db); }
    return res.end(JSON.stringify({ message: 'Chauffeur marqué comme parti' }));
  }

  // --- AFFECTATIONS ---
  if (pathname === '/api/affectations' && method === 'GET') {
    const actives = db.affectations.filter(a => !a.date_fin).map(a => {
      const v = db.vehicules.find(x => x.id === a.vehicule_id);
      const c = db.chauffeurs.find(x => x.id === a.chauffeur_id);
      return { ...a, vehicule: v ? v.immatriculation + ' · ' + v.marque : '?', chauffeur: c ? c.prenom + ' ' + c.nom : '?' };
    });
    return res.end(JSON.stringify(actives));
  }
  if (pathname === '/api/affectations' && method === 'POST') {
    if (db.affectations.find(a => a.vehicule_id === data.vehicule_id && !a.date_fin))
      return res.end(JSON.stringify({ detail: 'Ce véhicule est déjà affecté à un chauffeur' }));
    if (db.affectations.find(a => a.chauffeur_id === data.chauffeur_id && !a.date_fin))
      return res.end(JSON.stringify({ detail: 'Ce chauffeur est déjà affecté à un véhicule' }));
    const a = { id: uid(), ...data, date_fin: null };
    db.affectations.push(a);
    saveDB(db);
    return res.end(JSON.stringify({ id: a.id, message: 'Affectation créée' }));
  }
  const aMatch = pathname.match(/^\/api\/affectations\/(.+)\/cloturer$/);
  if (aMatch && method === 'PATCH') {
    const idx = db.affectations.findIndex(a => a.id === aMatch[1]);
    if (idx !== -1) { db.affectations[idx].date_fin = today(); saveDB(db); }
    return res.end(JSON.stringify({ message: 'Affectation clôturée' }));
  }

  // --- VERSEMENTS ---
  if (pathname === '/api/versements' && method === 'GET') {
    const enriched = db.versements.slice(-100).reverse().map(v => {
      const aff = db.affectations.find(a => a.id === v.affectation_id);
      const c = aff ? db.chauffeurs.find(x => x.id === aff.chauffeur_id) : null;
      const veh = aff ? db.vehicules.find(x => x.id === aff.vehicule_id) : null;
      return { ...v, chauffeur: c ? c.prenom + ' ' + c.nom : '?', vehicule: veh ? veh.immatriculation : '?' };
    });
    return res.end(JSON.stringify(enriched));
  }
  if (pathname === '/api/versements' && method === 'POST') {
    const aff = db.affectations.find(a => a.id === data.affectation_id);
    if (!aff) return res.end(JSON.stringify({ detail: 'Affectation introuvable' }));
    const attendu = aff.montant_journalier;
    const montant = Number(data.montant);
    const statut = montant >= attendu ? 'recu' : montant > 0 ? 'partiel' : 'en_retard';
    const v = { id: uid(), ...data, montant, montant_attendu: attendu, statut, created_at: new Date().toISOString() };
    db.versements.push(v);
    saveDB(db);
    return res.end(JSON.stringify({ id: v.id, statut, ecart: attendu - montant, message: 'Versement enregistré' }));
  }

  // --- DEPENSES ---
  if (pathname === '/api/depenses' && method === 'GET') {
    return res.end(JSON.stringify(db.depenses.slice(-100).reverse()));
  }
  if (pathname === '/api/depenses' && method === 'POST') {
    const d = { id: uid(), ...data, montant: Number(data.montant), date_depense: today(), created_at: new Date().toISOString() };
    db.depenses.push(d);
    saveDB(db);
    return res.end(JSON.stringify({ id: d.id, message: 'Dépense enregistrée' }));
  }

  // --- ALERTES ---
  if (pathname === '/api/alertes' && method === 'GET') {
    return res.end(JSON.stringify(db.alertes.slice(-50).reverse()));
  }
  if (pathname === '/api/alertes' && method === 'POST') {
    const msgs = {
      versement_retard:    'SyNdongo — Votre versement est en retard. Merci de régulariser.',
      document_expiration: 'SyNdongo — Un document de votre véhicule expire bientôt. Action requise.',
      vidange_due:         'SyNdongo — Votre véhicule approche du seuil de vidange. Planifiez avec Xelcom.',
      panne:               'SyNdongo — Panne déclarée. Le manager a été notifié.'
    };
    const c = data.chauffeur_id ? db.chauffeurs.find(x => x.id === data.chauffeur_id) : null;
    const message = data.message || msgs[data.type_alerte] || 'Message SyNdongo';
    const al = { id: uid(), ...data, message, statut: 'simule', created_at: new Date().toISOString() };
    db.alertes.push(al);
    saveDB(db);
    return res.end(JSON.stringify({ id: al.id, statut: 'simule', message, note: 'Mode simulation — configurez Twilio pour envois réels' }));
  }


  // --- PATCH Chauffeur ---
  const cPatch = pathname.match(/^\/api\/chauffeurs\/(.+)$/);
  if (cPatch && method === 'PATCH') {
    const idx = db.chauffeurs.findIndex(c => c.id === cPatch[1]);
    if (idx !== -1) { db.chauffeurs[idx] = { ...db.chauffeurs[idx], ...data }; saveDB(db); }
    return res.end(JSON.stringify({ message: 'Chauffeur mis à jour' }));
  }

  // --- DELETE Versement ---
  const vsDel = pathname.match(/^\/api\/versements\/(.+)$/);
  if (vsDel && method === 'DELETE') {
    db.versements = db.versements.filter(v => v.id !== vsDel[1]);
    saveDB(db);
    return res.end(JSON.stringify({ message: 'Versement supprimé' }));
  }
  // --- PATCH Versement ---
  if (vsDel && method === 'PATCH') {
    const idx = db.versements.findIndex(v => v.id === vsDel[1]);
    if (idx !== -1) {
      const attendu = db.versements[idx].montant_attendu;
      const montant = data.montant !== undefined ? data.montant : db.versements[idx].montant;
      const statut = montant >= attendu ? 'recu' : montant > 0 ? 'partiel' : 'en_retard';
      db.versements[idx] = { ...db.versements[idx], ...data, montant, statut };
      saveDB(db);
    }
    return res.end(JSON.stringify({ message: 'Versement mis à jour' }));
  }

  // --- DELETE Dépense ---
  const dDel = pathname.match(/^\/api\/depenses\/(.+)$/);
  if (dDel && method === 'DELETE') {
    db.depenses = db.depenses.filter(d => d.id !== dDel[1]);
    saveDB(db);
    return res.end(JSON.stringify({ message: 'Dépense supprimée' }));
  }
  // --- PATCH Dépense ---
  if (dDel && method === 'PATCH') {
    const idx = db.depenses.findIndex(d => d.id === dDel[1]);
    if (idx !== -1) { db.depenses[idx] = { ...db.depenses[idx], ...data }; saveDB(db); }
    return res.end(JSON.stringify({ message: 'Dépense mise à jour' }));
  }

  res.writeHead(404);
  res.end(JSON.stringify({ detail: 'Route introuvable' }));
}

// Serveur principal
const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  if (req.url.startsWith('/api/')) {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => handleAPI(req, res, body));
    return;
  }

  // Servir l'interface HTML
  if (req.url === '/' || req.url === '/index.html') {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8'));
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log('');
  console.log('  ================================');
  console.log('   SyNdongo demarre !');
  console.log('  ================================');
  console.log('');
  console.log('  Ouvrez votre navigateur sur :');
  console.log('  http://localhost:' + PORT);
  console.log('');
  console.log('  Donnees sauvegardees dans :');
  console.log('  syndongo_data.json');
  console.log('');
});
