const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

const DB_FILE = './syndongo_data.json';
const PORT = process.env.PORT || 8000;

function loadDB() {
  if (!fs.existsSync(DB_FILE)) {
    const init = {
      vehicules: [], chauffeurs: [], affectations: [],
      versements: [], depenses: [], alertes: [],
      activites: [], tags: ["Groupe A","Groupe B","Proprietaire 1","Zone Nord","Zone Sud"]
    };
    fs.writeFileSync(DB_FILE, JSON.stringify(init, null, 2));
  }
  const db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  if (!db.activites) db.activites = [];
  if (!db.tags) db.tags = ["Groupe A","Groupe B","Zone Nord","Zone Sud"];
  return db;
}

function saveDB(db) { fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2)); }
function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2,6); }
function today() { return new Date().toISOString().split('T')[0]; }

function handleAPI(req, res, body) {
  const db = loadDB();
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;
  const method = req.method;
  const query = parsed.query;

  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  let data = {};
  try { data = body ? JSON.parse(body) : {}; } catch(e) {}

  // DASHBOARD
  if (pathname === '/api/dashboard' && method === 'GET') {
    const totalRecettes = db.versements.reduce((s,v) => s+v.montant, 0);
    const totalDepenses = db.depenses.reduce((s,d) => s+d.montant, 0);
    const actifs = db.vehicules.filter(v => v.statut === 'actif').length;
    const todayActifs = (db.activites||[]).filter(a => a.date === today() && a.travaille).length;
    const alertes = [];
    db.vehicules.forEach(v => {
      if (v.km_prochain_vidange && v.km_actuel >= v.km_prochain_vidange * 0.95)
        alertes.push({ type:'warn', message:`Vidange due — ${v.immatriculation} : ${(v.km_actuel||0).toLocaleString()} km` });
    });
    db.versements.filter(v => v.statut === 'partiel').forEach(v => {
      const aff = db.affectations.find(a => a.id === v.affectation_id);
      const c = aff ? db.chauffeurs.find(x => x.id === aff.chauffeur_id) : null;
      alertes.push({ type:'danger', message:`Versement partiel — ${c?c.prenom+' '+c.nom:'?'} : écart ${(v.montant_attendu-v.montant).toLocaleString()} FCFA` });
    });
    return res.end(JSON.stringify({
      kpis: { recettes_30j: totalRecettes, depenses_30j: totalDepenses,
              marge_nette_30j: totalRecettes-totalDepenses,
              taux_marge: totalRecettes>0 ? Math.round((totalRecettes-totalDepenses)/totalRecettes*1000)/10 : 0,
              vehicules_actifs: actifs, vehicules_total: db.vehicules.length,
              chauffeurs_actifs: db.chauffeurs.filter(c=>c.statut==='actif').length,
              vehicules_travaille_aujourd_hui: todayActifs },
      alertes
    }));
  }

  // TAGS
  if (pathname === '/api/tags' && method === 'GET') return res.end(JSON.stringify(db.tags));
  if (pathname === '/api/tags' && method === 'POST') {
    if (data.tag && !db.tags.includes(data.tag)) { db.tags.push(data.tag); saveDB(db); }
    return res.end(JSON.stringify(db.tags));
  }
  if (pathname === '/api/tags' && method === 'DELETE') {
    db.tags = db.tags.filter(t => t !== data.tag); saveDB(db);
    return res.end(JSON.stringify(db.tags));
  }

  // VEHICULES
  if (pathname === '/api/vehicules' && method === 'GET') {
    const search = (query.q||'').toLowerCase();
    const tag = query.tag||'';
    let list = db.vehicules.map(v => {
      const todayAct = (db.activites||[]).find(a => a.vehicule_id===v.id && a.date===today());
      return { ...v, alerte_vidange: !!(v.km_prochain_vidange && v.km_actuel >= v.km_prochain_vidange*0.95),
               travaille_aujourd_hui: todayAct ? todayAct.travaille : null };
    });
    if (search) list = list.filter(v =>
      v.immatriculation.toLowerCase().includes(search) ||
      (v.marque||'').toLowerCase().includes(search) ||
      (v.modele||'').toLowerCase().includes(search) ||
      (v.tag||'').toLowerCase().includes(search)
    );
    if (tag) list = list.filter(v => v.tag === tag);
    return res.end(JSON.stringify(list));
  }
  if (pathname === '/api/vehicules' && method === 'POST') {
    if (db.vehicules.find(v => v.immatriculation === (data.immatriculation||'').toUpperCase().trim()))
      return res.end(JSON.stringify({ detail: 'Ce véhicule existe déjà (' + data.immatriculation.toUpperCase() + ')' }));
    const v = { id: uid(), ...data, immatriculation: (data.immatriculation||'').toUpperCase().trim(), tag: data.tag||'' };
    db.vehicules.push(v); saveDB(db);
    return res.end(JSON.stringify({ id: v.id, message: 'Véhicule créé' }));
  }
  const vMatch = pathname.match(/^\/api\/vehicules\/([^/]+)$/);
  if (vMatch && method === 'DELETE') {
    if (db.affectations.find(a => a.vehicule_id===vMatch[1] && !a.date_fin))
      return res.end(JSON.stringify({ detail: 'Impossible : un chauffeur est affecté à ce véhicule' }));
    db.vehicules = db.vehicules.filter(v => v.id !== vMatch[1]); saveDB(db);
    return res.end(JSON.stringify({ message: 'Véhicule supprimé' }));
  }
  if (vMatch && method === 'PATCH') {
    const idx = db.vehicules.findIndex(v => v.id === vMatch[1]);
    if (idx !== -1) { db.vehicules[idx] = { ...db.vehicules[idx], ...data }; saveDB(db); }
    return res.end(JSON.stringify({ message: 'Mis à jour' }));
  }
  // Fiche véhicule détail
  const vFiche = pathname.match(/^\/api\/vehicules\/([^/]+)\/fiche$/);
  if (vFiche && method === 'GET') {
    const v = db.vehicules.find(x => x.id === vFiche[1]);
    if (!v) { res.writeHead(404); return res.end(JSON.stringify({ detail: 'Introuvable' })); }
    const affActive = db.affectations.find(a => a.vehicule_id===v.id && !a.date_fin);
    const chauffeur = affActive ? db.chauffeurs.find(c => c.id===affActive.chauffeur_id) : null;
    const affIds = db.affectations.filter(a => a.vehicule_id===v.id).map(a => a.id);
    const versements = db.versements.filter(vs => affIds.includes(vs.affectation_id)).slice(-20).reverse();
    const depenses = db.depenses.filter(d => d.vehicule_id===v.id).slice(-20).reverse();
    const recettes = versements.reduce((s,vs) => s+vs.montant, 0);
    const charges = depenses.reduce((s,d) => s+d.montant, 0);
    return res.end(JSON.stringify({ vehicule: v, chauffeur, affectation: affActive, versements, depenses, recettes, charges, marge: recettes-charges }));
  }

  // ACTIVITE JOURNALIERE
  if (pathname === '/api/activites' && method === 'POST') {
    const existing = (db.activites||[]).findIndex(a => a.vehicule_id===data.vehicule_id && a.date===today());
    if (existing !== -1) db.activites[existing].travaille = data.travaille;
    else db.activites.push({ id: uid(), vehicule_id: data.vehicule_id, date: today(), travaille: data.travaille });
    saveDB(db);
    return res.end(JSON.stringify({ message: 'Activité enregistrée' }));
  }

  // CHAUFFEURS
  if (pathname === '/api/chauffeurs' && method === 'GET') {
    const search = (query.q||'').toLowerCase();
    let list = db.chauffeurs.filter(c => c.statut==='actif');
    if (search) list = list.filter(c =>
      (c.prenom||'').toLowerCase().includes(search) ||
      (c.nom||'').toLowerCase().includes(search) ||
      (c.telephone||'').includes(search) ||
      (c.numero_permis||'').toLowerCase().includes(search)
    );
    return res.end(JSON.stringify(list));
  }
  if (pathname === '/api/chauffeurs' && method === 'POST') {
    if (db.chauffeurs.find(c => c.telephone === (data.telephone||'').trim()))
      return res.end(JSON.stringify({ detail: 'Ce numéro de téléphone est déjà enregistré' }));
    if (data.numero_permis && db.chauffeurs.find(c => c.numero_permis === (data.numero_permis||'').trim()))
      return res.end(JSON.stringify({ detail: 'Ce numéro de permis est déjà enregistré' }));
    const c = { id: uid(), ...data, telephone: (data.telephone||'').trim(), statut: 'actif', date_embauche: today() };
    db.chauffeurs.push(c); saveDB(db);
    return res.end(JSON.stringify({ id: c.id, message: 'Chauffeur enregistré' }));
  }
  const cMatch = pathname.match(/^\/api\/chauffeurs\/([^/]+)$/);
  if (cMatch && method === 'DELETE') {
    const idx = db.chauffeurs.findIndex(c => c.id===cMatch[1]);
    if (idx !== -1) { db.chauffeurs[idx].statut = 'depart'; saveDB(db); }
    return res.end(JSON.stringify({ message: 'Chauffeur marqué comme parti' }));
  }
  if (cMatch && method === 'PATCH') {
    const idx = db.chauffeurs.findIndex(c => c.id===cMatch[1]);
    if (idx !== -1) {
      if (data.telephone && data.telephone !== db.chauffeurs[idx].telephone) {
        if (db.chauffeurs.find((c,i) => i!==idx && c.telephone===data.telephone))
          return res.end(JSON.stringify({ detail: 'Ce numéro de téléphone est déjà utilisé' }));
      }
      db.chauffeurs[idx] = { ...db.chauffeurs[idx], ...data }; saveDB(db);
    }
    return res.end(JSON.stringify({ message: 'Chauffeur mis à jour' }));
  }
  // Fiche chauffeur
  const cFiche = pathname.match(/^\/api\/chauffeurs\/([^/]+)\/fiche$/);
  if (cFiche && method === 'GET') {
    const c = db.chauffeurs.find(x => x.id===cFiche[1]);
    if (!c) { res.writeHead(404); return res.end(JSON.stringify({ detail: 'Introuvable' })); }
    const affActive = db.affectations.find(a => a.chauffeur_id===c.id && !a.date_fin);
    const vehicule = affActive ? db.vehicules.find(v => v.id===affActive.vehicule_id) : null;
    const affIds = db.affectations.filter(a => a.chauffeur_id===c.id).map(a => a.id);
    const versements = db.versements.filter(vs => affIds.includes(vs.affectation_id)).slice(-20).reverse();
    const totalVerse = versements.reduce((s,vs) => s+vs.montant, 0);
    const totalAttendu = versements.reduce((s,vs) => s+vs.montant_attendu, 0);
    return res.end(JSON.stringify({ chauffeur: c, vehicule, affectation: affActive, versements, totalVerse, totalAttendu, ecart: totalAttendu-totalVerse }));
  }

  // AFFECTATIONS
  if (pathname === '/api/affectations' && method === 'GET') {
    const actives = db.affectations.filter(a => !a.date_fin).map(a => {
      const v = db.vehicules.find(x => x.id===a.vehicule_id);
      const c = db.chauffeurs.find(x => x.id===a.chauffeur_id);
      return { ...a, vehicule: v?v.immatriculation+' · '+v.marque:'?', chauffeur: c?c.prenom+' '+c.nom:'?' };
    });
    return res.end(JSON.stringify(actives));
  }
  if (pathname === '/api/affectations' && method === 'POST') {
    if (db.affectations.find(a => a.vehicule_id===data.vehicule_id && !a.date_fin))
      return res.end(JSON.stringify({ detail: 'Ce véhicule est déjà affecté à un chauffeur' }));
    if (db.affectations.find(a => a.chauffeur_id===data.chauffeur_id && !a.date_fin))
      return res.end(JSON.stringify({ detail: 'Ce chauffeur est déjà affecté à un véhicule' }));
    const a = { id: uid(), ...data, date_fin: null }; db.affectations.push(a); saveDB(db);
    return res.end(JSON.stringify({ id: a.id, message: 'Affectation créée' }));
  }
  const aMatch = pathname.match(/^\/api\/affectations\/([^/]+)\/cloturer$/);
  if (aMatch && method === 'PATCH') {
    const idx = db.affectations.findIndex(a => a.id===aMatch[1]);
    if (idx !== -1) { db.affectations[idx].date_fin = today(); saveDB(db); }
    return res.end(JSON.stringify({ message: 'Affectation clôturée' }));
  }

  // VERSEMENTS
  if (pathname === '/api/versements' && method === 'GET') {
    return res.end(JSON.stringify(db.versements.slice(-200).reverse().map(v => {
      const aff = db.affectations.find(a => a.id===v.affectation_id);
      const c = aff ? db.chauffeurs.find(x => x.id===aff.chauffeur_id) : null;
      const veh = aff ? db.vehicules.find(x => x.id===aff.vehicule_id) : null;
      return { ...v, chauffeur: c?c.prenom+' '+c.nom:'?', vehicule: veh?veh.immatriculation:'?' };
    })));
  }
  if (pathname === '/api/versements' && method === 'POST') {
    const aff = db.affectations.find(a => a.id===data.affectation_id);
    if (!aff) return res.end(JSON.stringify({ detail: 'Affectation introuvable' }));
    const attendu = aff.montant_journalier;
    const montant = Number(data.montant);
    const statut = montant>=attendu?'recu':montant>0?'partiel':'en_retard';
    const v = { id: uid(), ...data, montant, montant_attendu: attendu, statut, created_at: new Date().toISOString() };
    db.versements.push(v); saveDB(db);
    return res.end(JSON.stringify({ id: v.id, statut, ecart: attendu-montant, message: 'Versement enregistré' }));
  }
  const vsDel = pathname.match(/^\/api\/versements\/([^/]+)$/);
  if (vsDel && method === 'DELETE') {
    db.versements = db.versements.filter(v => v.id!==vsDel[1]); saveDB(db);
    return res.end(JSON.stringify({ message: 'Versement supprimé' }));
  }
  if (vsDel && method === 'PATCH') {
    const idx = db.versements.findIndex(v => v.id===vsDel[1]);
    if (idx !== -1) {
      const attendu = db.versements[idx].montant_attendu;
      const montant = data.montant !== undefined ? Number(data.montant) : db.versements[idx].montant;
      const statut = montant>=attendu?'recu':montant>0?'partiel':'en_retard';
      db.versements[idx] = { ...db.versements[idx], ...data, montant, statut }; saveDB(db);
    }
    return res.end(JSON.stringify({ message: 'Versement mis à jour' }));
  }

  // DEPENSES
  if (pathname === '/api/depenses' && method === 'GET') {
    return res.end(JSON.stringify(db.depenses.slice(-200).reverse()));
  }
  if (pathname === '/api/depenses' && method === 'POST') {
    const d = { id: uid(), ...data, montant: Number(data.montant), date_depense: today(), created_at: new Date().toISOString() };
    db.depenses.push(d); saveDB(db);
    return res.end(JSON.stringify({ id: d.id, message: 'Dépense enregistrée' }));
  }
  const dDel = pathname.match(/^\/api\/depenses\/([^/]+)$/);
  if (dDel && method === 'DELETE') {
    db.depenses = db.depenses.filter(d => d.id!==dDel[1]); saveDB(db);
    return res.end(JSON.stringify({ message: 'Dépense supprimée' }));
  }
  if (dDel && method === 'PATCH') {
    const idx = db.depenses.findIndex(d => d.id===dDel[1]);
    if (idx !== -1) { db.depenses[idx] = { ...db.depenses[idx], ...data }; saveDB(db); }
    return res.end(JSON.stringify({ message: 'Dépense mise à jour' }));
  }

  // ALERTES
  if (pathname === '/api/alertes' && method === 'GET') return res.end(JSON.stringify(db.alertes.slice(-50).reverse()));
  if (pathname === '/api/alertes' && method === 'POST') {
    const msgs = { versement_retard:'SyNdongo — Versement en retard. Merci de régulariser.', document_expiration:'SyNdongo — Document expirant bientôt. Action requise.', vidange_due:'SyNdongo — Vidange due. Planifiez avec Xelcom.', panne:'SyNdongo — Panne déclarée. Manager notifié.' };
    const message = data.message || msgs[data.type_alerte] || 'Message SyNdongo';
    const al = { id: uid(), ...data, message, statut: 'simule', created_at: new Date().toISOString() };
    db.alertes.push(al); saveDB(db);
    return res.end(JSON.stringify({ id: al.id, statut: 'simule', message }));
  }

  res.writeHead(404); res.end(JSON.stringify({ detail: 'Route introuvable' }));
}

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  if (req.url.startsWith('/api/')) {
    let body = ''; req.on('data', chunk => body += chunk);
    req.on('end', () => handleAPI(req, res, body)); return;
  }
  if (req.url === '/' || req.url === '/index.html') {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8')); return;
  }
  res.writeHead(404); res.end('Not found');
});

server.listen(PORT, () => {
  console.log('\n  SyNdongo v5 démarré sur le port ' + PORT + '\n');
});
