const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

const DB_FILE = process.env.DATA_PATH || './syndongo_data.json';
const PORT = process.env.PORT || 8000;

// ── Helpers tags ──────────────────────────────────────────
function normalizeTag(t) { return typeof t==='object' ? (t.nom||t.name||'') : String(t||''); }
function normalizeTags(arr) { return [...new Set((arr||[]).map(normalizeTag).filter(Boolean))]; }


const MANAGER_PASSWORD = process.env.MANAGER_PASSWORD || 'ndongo2026';

// ── WAVE CONFIG ───────────────────────────────────────────────
const WAVE_API_KEY = process.env.WAVE_API_KEY || '';
const WAVE_WEBHOOK_SECRET = process.env.WAVE_WEBHOOK_SECRET || '';
const APP_URL = process.env.APP_URL || 'https://syndongoflotte.onrender.com';

// Créer une demande de paiement Wave (clé API = celle du gestionnaire ou du manager)
async function createWavePayment(montant, phone, description, reference, apiKey) {
  const key = apiKey || WAVE_API_KEY;
  if (!key) return { error: 'Clé Wave non configurée — ajoutez votre clé dans Accès & Partage' };
  try {
    const https = require('https');
    const body = JSON.stringify({
      currency: 'XOF',
      amount: montant.toString(),
      error_url: APP_URL+'/api/wave/error',
      success_url: APP_URL+'/api/wave/success',
      client_reference: reference,
      restrict_mobile: phone || undefined,
      aggregated_merchant_id: null
    });
    return new Promise((resolve) => {
      const req = https.request({
        hostname: 'api.wave.com',
        path: '/v1/checkout/sessions',
        method: 'POST',
        headers: {
          'Authorization': 'Bearer '+key,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body)
        }
      }, (res) => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          try { resolve(JSON.parse(data)); }
          catch(e) { resolve({ error: data }); }
        });
      });
      req.on('error', e => resolve({ error: e.message }));
      req.write(body);
      req.end();
    });
  } catch(e) { return { error: e.message }; }
}

// Vérifier la signature webhook Wave
function verifyWaveSignature(body, signature) {
  if (!WAVE_WEBHOOK_SECRET) return true; // Pas de secret = pas de vérification
  const crypto = require('crypto');
  const expected = crypto.createHmac('sha256', WAVE_WEBHOOK_SECRET).update(body).digest('hex');
  return signature === expected;
}

function loadDB() {
  if (!fs.existsSync(DB_FILE)) {
    const dir = path.dirname(DB_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(DB_FILE, JSON.stringify({
      vehicules:[], chauffeurs:[], affectations:[],
      versements:[], depenses:[], alertes:[], activites:[],
      facturations:[], tags:[], proprietaires:[], gestionnaires:[]
    }, null, 2));
  }
  const db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  // Normaliser les tags (s'assurer qu'ils sont tous des strings)
  if(db.tags) db.tags = normalizeTags(db.tags);
  ['activites','facturations','tags','proprietaires','versements',
   'depenses','alertes','gestionnaires','historique','journal',
   'livreurs','recettes_livreurs','paiements_livreurs'].forEach(k=>{ if(!db[k]) db[k]=[]; });
  if(!db.config_livreurs) db.config_livreurs = { taux_horaire: 500, paliers: [] };
  if(!Array.isArray(db.config_livreurs.paliers)) db.config_livreurs.paliers = [];
  return db;
}

function saveDB(db) {
  const dir = path.dirname(DB_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(DB_FILE, JSON.stringify(db));
}

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2,6);
const today = () => new Date().toISOString().split('T')[0];
const genPin = () => String(Math.floor(1000 + Math.random() * 9000));

function getRole(req) {
  const parsed = url.parse(req.url, true);
  const token = parsed.query.token || req.headers['x-token'] || '';
  if (token === MANAGER_PASSWORD) return { role:'manager' };
  const db = loadDB();
  const proprio = db.proprietaires.find(p => p.password === token);
  if (proprio) return { role:'proprietaire', proprio };
  const gest = db.gestionnaires.find(g => g.password === token);
  if (gest) return { role:'gestionnaire', gest };
  if (token.startsWith('lv:')) {
    const [, lvId, lvPin] = token.split(':');
    const livreur = db.chauffeurs.find(c => c.id === lvId && c.categorie === 'livreur' && c.statut === 'actif' && c.pin && c.pin === lvPin);
    if (livreur) return { role:'livreur', livreur };
  }
  return { role:'public' };
}

function cors(res) {
  res.setHeader('Content-Type','application/json');
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','GET,POST,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type,X-Token');
}

// Permissions granulaires gestionnaire : facturer et/ou encaisser (absent = true, rétrocompatible)
function peutFacturer(auth) { return auth.role !== 'gestionnaire' || auth.gest.is_manager || auth.gest.peut_facturer !== false; }
function peutEncaisser(auth) { return auth.role !== 'gestionnaire' || auth.gest.is_manager || auth.gest.peut_encaisser !== false; }

// Véhicules visibles selon rôle
function vehsVisibles(db, auth) {
  if (auth.role === 'manager') return db.vehicules;
  if (auth.role === 'proprietaire') return db.vehicules.filter(v => auth.proprio.vehicules_ids.includes(v.id));
  if (auth.role === 'gestionnaire') {
    const gTags = auth.gest.tags || (auth.gest.tag ? [auth.gest.tag] : []);
    // Si le gestionnaire a des tags, inclure aussi les véhicules de ces tags
    if (gTags.length) {
      const byTag = db.vehicules.filter(v => gTags.includes(v.tag));
      const byId  = db.vehicules.filter(v => auth.gest.vehicules_ids.includes(v.id));
      const allIds = new Set([...byTag.map(v=>v.id), ...byId.map(v=>v.id)]);
      return db.vehicules.filter(v => allIds.has(v.id));
    }
    return db.vehicules.filter(v => auth.gest.vehicules_ids.includes(v.id));
  }
  return [];
}

// Ids des livreurs (chauffeurs catégorie 'livreur') visibles par l'utilisateur courant
function livreursVisiblesIds(db, auth) {
  const myVehs = vehsVisibles(db, auth).map(v => v.id);
  let list = db.chauffeurs.filter(c => c.statut === 'actif' && c.categorie === 'livreur');
  if (auth.role === 'manager') return list.map(c => c.id);
  if (auth.role === 'gestionnaire') {
    const affVeh = db.affectations.filter(a => myVehs.includes(a.vehicule_id) && !a.date_fin).map(a => a.chauffeur_id);
    const mesLivreurs = list.filter(c => c.cree_par === auth.gest.id).map(c => c.id);
    const tousIds = new Set([...affVeh, ...mesLivreurs]);
    return list.filter(c => tousIds.has(c.id)).map(c => c.id);
  }
  if (auth.role === 'proprietaire') {
    const affVeh = db.affectations.filter(a => myVehs.includes(a.vehicule_id) && !a.date_fin).map(a => a.chauffeur_id);
    return list.filter(c => affVeh.includes(c.id)).map(c => c.id);
  }
  return [];
}

// Calcul de paie livreur : heures × taux + primes par palier appliquées JOUR PAR JOUR
// (le palier le plus haut atteint par le montant versé CE jour-là s'applique, non cumulable ce jour ;
//  les primes des différents jours s'additionnent ensuite sur toute la période)
function calculPaieLivreur(db, livreurId, dd, df) {
  const recettes = db.recettes_livreurs.filter(r => r.livreur_id === livreurId && r.date >= dd && r.date <= df);
  const total_heures = recettes.reduce((s, r) => s + r.heures, 0);
  const affIds = db.affectations.filter(a => a.chauffeur_id === livreurId).map(a => a.id);
  const versements = db.versements.filter(vs => affIds.includes(vs.affectation_id) && vs.date_versement >= dd && vs.date_versement <= df);
  const total_verse = versements.reduce((s, vs) => s + vs.montant, 0);
  const total_facture = db.facturations.filter(f => f.chauffeur_id === livreurId && f.date >= dd && f.date <= df).reduce((s, f) => s + (f.montant_facture || 0), 0);

  // Manquant réel : imputation FIFO sur TOUT l'historique des versements du livreur
  // (même méthode que le calcul des retards véhicule), pas seulement le versé de la période —
  // un versement fait avant ou après la période peut couvrir une facturation de la période.
  const facsAll = db.facturations.filter(f => f.chauffeur_id === livreurId).slice().sort((a, b) => a.date.localeCompare(b.date));
  const versAll = db.versements.filter(vs => affIds.includes(vs.affectation_id)).slice().sort((a, b) => a.date_versement.localeCompare(b.date_versement));
  const pool = versAll.map(vs => vs.montant);
  const manquant_par_jour = {};
  let manquant = 0;
  facsAll.forEach(fac => {
    let due = fac.montant_facture || 0, impute = 0;
    for (let i = 0; i < pool.length && due > 0; i++) {
      const prise = Math.min(pool[i], due);
      impute += prise; pool[i] -= prise; due -= prise;
    }
    const m = (fac.montant_facture || 0) - impute;
    if (fac.date >= dd && fac.date <= df && m > 0) {
      manquant += m;
      manquant_par_jour[fac.date] = (manquant_par_jour[fac.date] || 0) + m;
    }
  });

  const taux_horaire = db.config_livreurs.taux_horaire || 0;
  const paliers = [...db.config_livreurs.paliers].sort((a, b) => b.seuil - a.seuil);

  const versePerDay = {};
  versements.forEach(vs => { versePerDay[vs.date_versement] = (versePerDay[vs.date_versement] || 0) + vs.montant; });
  const detail_primes = [];
  let prime = 0;
  Object.keys(versePerDay).sort().forEach(date => {
    const montant_jour = versePerDay[date];
    const pl = paliers.find(p => montant_jour >= p.seuil);
    if (pl) { prime += pl.prime; detail_primes.push({ date, montant_jour, seuil: pl.seuil, prime: pl.prime }); }
  });

  const salaire_base = Math.round(total_heures * taux_horaire);
  const montant_a_payer = salaire_base + prime;
  return { livreur_id: livreurId, nb_jours: recettes.length, total_heures, total_facture, total_verse, manquant, manquant_par_jour,
    taux_horaire, prime, detail_primes, nb_jours_primes: detail_primes.length, salaire_base, montant_a_payer };
}

async function handleAPI(req, res, body) {
  const db = loadDB();
  const parsed = url.parse(req.url, true);
  const p = parsed.pathname;
  const method = req.method;
  const q = parsed.query;
  const auth = getRole(req);
  cors(res);
  if (method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  let data = {};
  try { data = body ? JSON.parse(body) : {}; } catch(e) {}

  const isManager = auth.role === 'manager';
  const isGest = auth.role === 'gestionnaire';
  const isProprio = auth.role === 'proprietaire';
  const canWrite = isManager || isGest;

  // Le rôle "livreur" (accès chauffeur en lecture seule) ne peut atteindre que
  // ses propres routes dédiées — jamais les routes manager/gestionnaire/proprietaire,
  // dont beaucoup n'ont pas de garde de rôle explicite et sont "ouvertes par défaut".
  if (auth.role === 'livreur' && p !== '/api/auth' && !p.startsWith('/api/livreur/')) {
    res.writeHead(403); return res.end(JSON.stringify({ detail: 'Accès réservé à l\'espace livreur' }));
  }

  // ── AUTH ──────────────────────────────────────────────────
  if (p === '/api/auth' && method === 'POST') {
    if (data.password === MANAGER_PASSWORD)
      return res.end(JSON.stringify({ role:'manager', token:data.password, nom:'Manager' }));
    const pr = db.proprietaires.find(x => x.password === data.password);
    if (pr) return res.end(JSON.stringify({ role:'proprietaire', token:data.password, nom:pr.nom, proprio_id:pr.id }));
    const gt = db.gestionnaires.find(x => x.password === data.password);
    if (gt) return res.end(JSON.stringify({
      role:'gestionnaire',
      token:data.password,
      nom:gt.nom,
      gest_id:gt.id,
      tags:gt.tags||[],
      tag:gt.tag||'',
      vehicules_ids:gt.vehicules_ids||[],
      is_manager: gt.is_manager || false,         // Affiche comme Manager dans l'UI
      affiche_comme: gt.is_manager ? 'Manager' : 'Gestionnaire',
      peut_facturer: gt.peut_facturer !== false,
      peut_encaisser: gt.peut_encaisser !== false
    }));
    if (data.telephone && data.pin) {
      const tel = String(data.telephone).trim();
      const pin = String(data.pin).trim();
      const lv = db.chauffeurs.find(c => c.categorie === 'livreur' && c.statut === 'actif' && c.telephone === tel && c.pin && c.pin === pin);
      if (lv) return res.end(JSON.stringify({ role:'livreur', token:'lv:'+lv.id+':'+lv.pin, nom:lv.prenom+' '+lv.nom, livreur_id:lv.id }));
      res.writeHead(401); return res.end(JSON.stringify({ detail:'Téléphone ou code incorrect' }));
    }
    // Reconnexion auto (localStorage) avec un jeton livreur déjà émis : "lv:<id>:<pin>"
    if (typeof data.password === 'string' && data.password.startsWith('lv:')) {
      const [, lvId, lvPin] = data.password.split(':');
      const lv = db.chauffeurs.find(c => c.id === lvId && c.categorie === 'livreur' && c.statut === 'actif' && c.pin && c.pin === lvPin);
      if (lv) return res.end(JSON.stringify({ role:'livreur', token:data.password, nom:lv.prenom+' '+lv.nom, livreur_id:lv.id }));
    }
    res.writeHead(401); return res.end(JSON.stringify({ detail:'Mot de passe incorrect' }));
  }

  // ── DASHBOARD ─────────────────────────────────────────────
  if (p === '/api/dashboard' && method === 'GET') {
    try {
    let vehs = vehsVisibles(db, auth);
    // Filtres optionnels
    if(q.tag) vehs=vehs.filter(v=>v.tag===q.tag);
    // Filtre multi-tags : ?tags=TNDF,Mmd,SY TRANSPORT
    if(q.tags) {
      const tagList = q.tags.split(',').map(t=>t.trim()).filter(Boolean);
      if(tagList.length) vehs=vehs.filter(v=>tagList.includes(v.tag));
    }
    if(q.vehicule_id) vehs=vehs.filter(v=>v.id===q.vehicule_id);
    const vIds = vehs.map(v => v.id);
    const affIds = db.affectations.filter(a => vIds.includes(a.vehicule_id)).map(a => a.id);
    const totalRec = db.versements.filter(v => affIds.includes(v.affectation_id)).reduce((s,v)=>s+v.montant,0);
    const totalDep = db.depenses.filter(d => vIds.includes(d.vehicule_id)).reduce((s,d)=>s+d.montant,0);
    const totalFac = db.facturations.filter(f => vIds.includes(f.vehicule_id)).reduce((s,f)=>s+f.montant_facture,0);
    // Filtre par période si demandé
    const date_debut = q.date_debut || '';
    const date_fin = q.date_fin || '';
    // Jour de référence = dernier jour de la période, ou aujourd'hui si pas de période
    const tj = date_fin && date_fin <= today() ? date_fin : today();
    const stats = {actif:0,panne:0,repos:0,inactif:0,non_saisi:0};
    // Affectations actives AU JOUR DE RÉFÉRENCE
    // Règle : affectation active = pas de date_fin (en cours) = chauffeur toujours affecté
    // Si date_fin existe, l'affectation est terminée → le véhicule n'est plus présumé actif
    const affActivesIds = new Set(
      db.affectations
        .filter(a => !a.date_fin) // Affectations en cours (sans date de fin)
        .map(a => a.vehicule_id)
    );
    const activitesToday = [];
    vehs.forEach(v => {
      const act = db.activites.find(a => a.vehicule_id===v.id && a.date===tj);
      if (act) {
        stats[act.statut_jour] = (stats[act.statut_jour]||0)+1;
        activitesToday.push({vehicule_id:v.id, statut_jour:act.statut_jour, date_ref:tj});
      } else if (affActivesIds.has(v.id)) {
        stats.actif++;
        activitesToday.push({vehicule_id:v.id, statut_jour:'actif', presume:true, date_ref:tj});
      } else {
        stats.non_saisi++;
        activitesToday.push({vehicule_id:v.id, statut_jour:'non_saisi', date_ref:tj});
      }
    });
    let recPeriode = totalRec, depPeriode = totalDep, facPeriode = totalFac;
    if (date_debut && date_fin) {
      recPeriode = db.versements.filter(v=>affIds.includes(v.affectation_id)&&v.date_versement>=date_debut&&v.date_versement<=date_fin).reduce((s,v)=>s+v.montant,0);
      depPeriode = db.depenses.filter(d=>vIds.includes(d.vehicule_id)&&d.date_depense>=date_debut&&d.date_depense<=date_fin).reduce((s,d)=>s+d.montant,0);
      facPeriode = db.facturations.filter(f=>vIds.includes(f.vehicule_id)&&f.date>=date_debut&&f.date<=date_fin).reduce((s,f)=>s+f.montant_facture,0);
    }
    const alertes = [];
    vehs.forEach(v => {
      if (v.km_prochain_vidange && v.km_actuel >= v.km_prochain_vidange*0.95)
        alertes.push({type:'warn', message:`Vidange due — ${v.immatriculation}`});
    });
    // Retard CORRECT : par vehicule puis somme (evite compensation entre vehicules)
    // Retard dashboard avec imputation FIFO
    function imputerFIFODash(facsAll,versAll,facsPeriodeIds){
      const ft=[...facsAll].sort((a,b)=>a.date.localeCompare(b.date));
      const vt=[...versAll].sort((a,b)=>a.date_versement.localeCompare(b.date_versement));
      const pool=vt.map(vs=>vs.montant);
      const imp={};
      ft.forEach(fac=>{
        let due=fac.montant_facture||0,impute=0;
        for(let i=0;i<pool.length&&due>0;i++){const p=Math.min(pool[i],due);impute+=p;pool[i]-=p;due-=p;}
        imp[fac.id]=impute;
      });
      const perSet=new Set(facsPeriodeIds);
      let facM=0,encI=0;
      ft.forEach(fac=>{if(perSet.has(fac.id)){facM+=fac.montant_facture||0;encI+=imp[fac.id]||0;}});
      return Math.max(0,facM-Math.min(encI,facM));
    }
    // Retard = dette globale de TOUS les véhicules visibles (cohérent avec page Retards sans filtre)
    let retardTotal=0;
    let retardNbVehs=0;
    vehs.forEach(v=>{
      const vAffIds=db.affectations.filter(a=>a.vehicule_id===v.id).map(a=>a.id);
      const facsAll=db.facturations.filter(f=>f.vehicule_id===v.id);
      const versAll=db.versements.filter(vs=>vAffIds.includes(vs.affectation_id));
      const totFacGlob=facsAll.reduce((s,f)=>s+(f.montant_facture||0),0);
      const totVersGlob=versAll.reduce((s,v)=>s+v.montant,0);
      const ret=Math.max(0,totFacGlob-totVersGlob);
      if(ret>0){retardTotal+=ret;retardNbVehs++;}
    });
    // Cohérence des KPIs :
    // recettes = versements reçus (encaissé réel)
    // facture_total = montant facturé (ce qui est dû)
    // marge = encaissé - dépenses
    // retard = par véhicule MAX(0, facturé - encaissé)
    // taux_marge = encaissé / facturé (taux de recouvrement)
    const tauxRecouvrement = facPeriode>0 ? Math.round(recPeriode/facPeriode*1000)/10 : 100;
    return res.end(JSON.stringify({
      kpis:{
        recettes:recPeriode,          // Total encaissé
        depenses:depPeriode,
        marge:recPeriode-depPeriode,  // Marge = encaissé - dépenses
        taux_marge:tauxRecouvrement,  // Taux de recouvrement
        vehicules_total:vehs.length,
        retard_total:retardTotal,retard_nb_vehs:retardNbVehs,
        facture_total:facPeriode      // Total facturé
      },
      stats_jour:stats, activites_today:activitesToday, alertes:alertes||[], role:auth.role,
      periode:{date_debut,date_fin,active:!!(date_debut&&date_fin)}
    }));
    } catch(dashErr) {
      console.error('Dashboard error:', dashErr.message);
      return res.end(JSON.stringify({
        kpis:{recettes:0,depenses:0,marge:0,taux_marge:0,vehicules_total:0,retard_total:0,facture_total:0},
        stats_jour:{actif:0,panne:0,repos:0,inactif:0,non_saisi:0},
        alertes:[],role:auth.role,periode:{active:false}
      }));
    }
  }

  // ── TAGS ──────────────────────────────────────────────────
  if (p==='/api/tags'&&method==='GET') {
    if (auth.role === 'manager') return res.end(JSON.stringify(normalizeTags(db.tags)));
    const myTags = new Set(vehsVisibles(db, auth).map(v => v.tag).filter(Boolean));
    if (auth.role === 'gestionnaire') {
      (auth.gest.tags || (auth.gest.tag ? [auth.gest.tag] : [])).forEach(t => myTags.add(t));
    }
    return res.end(JSON.stringify(normalizeTags([...myTags])));
  }
  if (p==='/api/tags'&&method==='POST') {
    if(!isManager){res.writeHead(403);return res.end(JSON.stringify({detail:'Refusé'}));}
    // Normaliser: toujours stocker les tags comme strings simples
    const rawTag = data.tag;
    const tagStr = typeof rawTag==='object' ? (rawTag.nom||rawTag.name||JSON.stringify(rawTag)) : String(rawTag||'');
    if(!tagStr.trim()) return res.end(JSON.stringify(normalizeTags(db.tags)));
    // Si c'est une mise à jour (ancien -> nouveau)
    if(data.ancien) {
      const idx = db.tags.findIndex(t => normalizeTag(t) === String(data.ancien));
      if(idx !== -1) db.tags[idx] = tagStr.trim();
      else db.tags.push(tagStr.trim());
    } else {
      const exists = db.tags.some(t => normalizeTag(t) === tagStr.trim());
      if(!exists) db.tags.push(tagStr.trim());
    }
    // Normaliser tous les tags existants
    db.tags = normalizeTags(db.tags);
    saveDB(db);
    return res.end(JSON.stringify(db.tags));
  }
  if (p==='/api/tags'&&method==='DELETE') {
    if(!isManager){res.writeHead(403);return res.end(JSON.stringify({detail:'Refusé'}));}
    const toDelete = String(data.tag||'');
    db.tags = normalizeTags(db.tags).filter(t => t !== toDelete);
    saveDB(db);return res.end(JSON.stringify(db.tags));
  }
  // PATCH tag (renommer)
  if (p==='/api/tags'&&method==='PATCH') {
    if(!isManager){res.writeHead(403);return res.end(JSON.stringify({detail:'Refusé'}));}
    const ancien = String(data.ancien||'');
    const nouveau = String(data.nouveau||'').trim();
    if(!ancien||!nouveau) return res.end(JSON.stringify({detail:'Ancien et nouveau nom requis'}));
    // Renommer dans les tags
    const idx = db.tags.findIndex(t => normalizeTag(t) === ancien);
    if(idx !== -1) db.tags[idx] = nouveau;
    // Renommer sur tous les véhicules
    db.vehicules.forEach(v => { if(normalizeTag(v.tag) === ancien) v.tag = nouveau; });
    db.tags = normalizeTags(db.tags);
    saveDB(db);
    return res.end(JSON.stringify({ message: 'Tag renommé', tags: db.tags }));
  }

  // ── VEHICULES ─────────────────────────────────────────────
  if (p==='/api/vehicules'&&method==='GET') {
    let list = vehsVisibles(db, auth);
    if(q.q){const sq=q.q.toLowerCase();list=list.filter(v=>(v.immatriculation||'').toLowerCase().includes(sq)||(v.marque||'').toLowerCase().includes(sq)||(v.tag||'').toLowerCase().includes(sq));}
    if(q.tag) list=list.filter(v=>v.tag===q.tag);
    if(q.tags){const tl=q.tags.split(',').map(t=>t.trim()).filter(Boolean);if(tl.length)list=list.filter(v=>tl.includes(v.tag));}
    if(q.statut_jour){const tj2=today();list=list.filter(v=>{const act=db.activites.find(a=>a.vehicule_id===v.id&&a.date===tj2);return (act?act.statut_jour:'non_saisi')===q.statut_jour;});}
    const tj=today();
    list=list.map(v=>{
      const act=db.activites.find(a=>a.vehicule_id===v.id&&a.date===tj);
      // Présomption: si affectation active et pas de saisie → actif présumé
      const hasAffActive = db.affectations.some(a=>a.vehicule_id===v.id&&!a.date_fin);
      const statutJour = act ? act.statut_jour : (hasAffActive ? 'actif' : 'non_saisi');
      return{...v,statut_jour:statutJour,statut_presume:!act&&hasAffActive,alerte_vidange:!!(v.km_prochain_vidange&&v.km_actuel>=v.km_prochain_vidange*0.95)};
    });
    return res.end(JSON.stringify(list));
  }
  if (p==='/api/vehicules'&&method==='POST') {
    if(!isManager&&!isGest){res.writeHead(403);return res.end(JSON.stringify({detail:'Refuse'}));}
    const immat=(data.immatriculation||'').toUpperCase().trim();
    if(db.vehicules.find(v=>v.immatriculation===immat)) return res.end(JSON.stringify({detail:immat+' deja enregistre'}));
    const v={id:uid(),...data,immatriculation:immat,tag:data.tag||''};
    db.vehicules.push(v);
    if(data.proprio_id){const pr=db.proprietaires.find(x=>x.id===data.proprio_id);if(pr&&!pr.vehicules_ids.includes(v.id))pr.vehicules_ids.push(v.id);}
    if(data.gest_id){const gt=db.gestionnaires.find(x=>x.id===data.gest_id);if(gt&&!gt.vehicules_ids.includes(v.id))gt.vehicules_ids.push(v.id);}
    if(isGest){const gt=db.gestionnaires.find(x=>x.id===auth.gest.id);if(gt&&!gt.vehicules_ids.includes(v.id))gt.vehicules_ids.push(v.id);v.cree_par=auth.gest.id;}
    db.historique=(db.historique||[]);
    db.historique.push({id:uid(),type:'vehicule_cree',ref_id:v.id,ref_nom:v.immatriculation,
      auteur:isGest?auth.gest.nom:'Manager',role:auth.role,date:new Date().toISOString()});
    saveDB(db);return res.end(JSON.stringify({id:v.id,message:'Vehicule cree'}));
  }
  const vM=p.match(/^\/api\/vehicules\/([^/]+)$/);
  if(vM&&method==='PATCH'){
    if(!isManager&&!isGest){res.writeHead(403);return res.end(JSON.stringify({detail:'Refusé'}));}
    const idx=db.vehicules.findIndex(v=>v.id===vM[1]);
    if(idx!==-1){
      db.vehicules[idx]={...db.vehicules[idx],...data};
      if(data.proprio_id!==undefined){db.proprietaires.forEach(pr=>{pr.vehicules_ids=pr.vehicules_ids.filter(id=>id!==vM[1]);});if(data.proprio_id){const pr=db.proprietaires.find(x=>x.id===data.proprio_id);if(pr)pr.vehicules_ids.push(vM[1]);}}
      if(data.gest_id!==undefined){db.gestionnaires.forEach(gt=>{gt.vehicules_ids=gt.vehicules_ids.filter(id=>id!==vM[1]);});if(data.gest_id){const gt=db.gestionnaires.find(x=>x.id===data.gest_id);if(gt)gt.vehicules_ids.push(vM[1]);}}
      saveDB(db);
    }
    return res.end(JSON.stringify({message:'Mis à jour'}));
  }
  if(vM&&method==='DELETE'){
    if(!isManager){res.writeHead(403);return res.end(JSON.stringify({detail:'Refusé'}));}
    if(db.affectations.find(a=>a.vehicule_id===vM[1]&&!a.date_fin)) return res.end(JSON.stringify({detail:'Impossible : chauffeur affecté'}));
    db.vehicules=db.vehicules.filter(v=>v.id!==vM[1]);
    db.proprietaires.forEach(pr=>{pr.vehicules_ids=pr.vehicules_ids.filter(id=>id!==vM[1]);});
    db.gestionnaires.forEach(gt=>{gt.vehicules_ids=gt.vehicules_ids.filter(id=>id!==vM[1]);});
    saveDB(db);return res.end(JSON.stringify({message:'Supprimé'}));
  }

  // ── FICHE VEHICULE ────────────────────────────────────────
  const vFiche=p.match(/^\/api\/vehicules\/([^/]+)\/fiche$/);
  if(vFiche&&method==='GET'){
    const v=db.vehicules.find(x=>x.id===vFiche[1]);
    if(!v){res.writeHead(404);return res.end(JSON.stringify({detail:'Introuvable'}));}
    const myVehs=vehsVisibles(db,auth).map(x=>x.id);
    if(!myVehs.includes(v.id)){res.writeHead(403);return res.end(JSON.stringify({detail:'Refusé'}));}
    const affActive=db.affectations.find(a=>a.vehicule_id===v.id&&!a.date_fin);
    const chauffeur=affActive?db.chauffeurs.find(c=>c.id===affActive.chauffeur_id):null;
    const affIds=db.affectations.filter(a=>a.vehicule_id===v.id).map(a=>a.id);
    const versements=db.versements.filter(vs=>affIds.includes(vs.affectation_id));
    const depenses=db.depenses.filter(d=>d.vehicule_id===v.id);
    const facturations=db.facturations.filter(f=>f.vehicule_id===v.id);
    const total_facture=facturations.reduce((s,f)=>s+f.montant_facture,0);
    const total_verse=versements.reduce((s,vs)=>s+vs.montant,0);
    const total_depenses=depenses.reduce((s,d)=>s+d.montant,0);
    const historique=[];
    for(let i=0;i<30;i++){
      const d=new Date();d.setDate(d.getDate()-i);
      const ds=d.toISOString().split('T')[0];
      const act=db.activites.find(a=>a.vehicule_id===v.id&&a.date===ds);
      const fac=db.facturations.find(f=>f.vehicule_id===v.id&&f.date===ds);
      const vers=versements.filter(vs=>vs.date_versement===ds);
      historique.push({date:ds,statut:act?act.statut_jour:'non_saisi',montant_facture:fac?fac.montant_facture:0,montant_verse:vers.reduce((s,v)=>s+v.montant,0)});
    }
    return res.end(JSON.stringify({vehicule:v,chauffeur,affectation:affActive,versements:versements.slice(-20).reverse(),depenses:depenses.slice(-10).reverse(),total_facture,total_verse,total_depenses,recette_nette:total_verse-total_depenses,manquant:Math.max(0,total_facture-total_verse),historique}));
  }

  // ── ACTIVITES ─────────────────────────────────────────────
  if(p==='/api/activites'&&method==='POST'){
    if(!canWrite){res.writeHead(403);return res.end(JSON.stringify({detail:'Refusé'}));}
    // Gestionnaire : vérifier que le véhicule lui appartient
    if(isGest&&!auth.gest.vehicules_ids.includes(data.vehicule_id)){res.writeHead(403);return res.end(JSON.stringify({detail:'Véhicule non assigné'}));}
    const statut_jour=data.statut_jour||'actif';
    const existing=db.activites.findIndex(a=>a.vehicule_id===data.vehicule_id&&a.date===today());
    const entry={id:existing!==-1?db.activites[existing].id:uid(),vehicule_id:data.vehicule_id,date:today(),statut_jour};
    if(existing!==-1)db.activites[existing]=entry;else db.activites.push(entry);
    saveDB(db);return res.end(JSON.stringify({message:'Statut enregistré',statut_jour}));
  }
  if(p==='/api/activites/stats'&&method==='GET'){
    const nb=parseInt(q.jours||'30');
    const depuis=new Date();depuis.setDate(depuis.getDate()-nb);
    const myVehs=vehsVisibles(db,auth).map(v=>v.id);
    const stats={actif:0,panne:0,repos:0,inactif:0};
    const pannesVeh={};
    db.activites.filter(a=>myVehs.includes(a.vehicule_id)&&new Date(a.date)>=depuis).forEach(a=>{
      stats[a.statut_jour]=(stats[a.statut_jour]||0)+1;
      if(a.statut_jour==='panne'){pannesVeh[a.vehicule_id]=(pannesVeh[a.vehicule_id]||0)+1;}
    });
    return res.end(JSON.stringify({stats,pannes_par_vehicule:pannesVeh,nb_jours:nb}));
  }

  // ── CHAUFFEURS ────────────────────────────────────────────
  if(p==='/api/chauffeurs'&&method==='GET'){
    const myVehs=vehsVisibles(db,auth).map(v=>v.id);
    let list=db.chauffeurs.filter(c=>c.statut==='actif');
    if(isGest){
      // Gestionnaire voit : chauffeurs affectés à ses véhicules + chauffeurs qu'il a créés
      const affVeh=db.affectations.filter(a=>myVehs.includes(a.vehicule_id)&&!a.date_fin).map(a=>a.chauffeur_id);
      const mesChauffeurs=list.filter(c=>c.cree_par===auth.gest.id).map(c=>c.id);
      const tousIds=[...new Set([...affVeh,...mesChauffeurs])];
      list=list.filter(c=>tousIds.includes(c.id));
    } else if(isProprio){
      const affVeh=db.affectations.filter(a=>myVehs.includes(a.vehicule_id)&&!a.date_fin).map(a=>a.chauffeur_id);
      list=list.filter(c=>affVeh.includes(c.id));
    }
    if(q.q){const sq=q.q.toLowerCase();list=list.filter(c=>(c.prenom||'').toLowerCase().includes(sq)||(c.nom||'').toLowerCase().includes(sq)||(c.telephone||'').includes(sq));}
    list=list.map(c=>{
      const aff=db.affectations.find(a=>a.chauffeur_id===c.id&&!a.date_fin);
      const veh=aff?db.vehicules.find(v=>v.id===aff.vehicule_id):null;
      return{...c,vehicule_actuel:veh?veh.immatriculation+' · '+veh.marque:null,affectation_active:!!aff};
    });
    return res.end(JSON.stringify(list));
  }
  if(p==='/api/chauffeurs'&&method==='POST'){
    if(!isManager&&!isGest){res.writeHead(403);return res.end(JSON.stringify({detail:'Refusé'}));}
    if(db.chauffeurs.find(c=>c.telephone===(data.telephone||'').trim())) return res.end(JSON.stringify({detail:'Téléphone déjà enregistré'}));
    if(data.numero_permis&&db.chauffeurs.find(c=>c.numero_permis===(data.numero_permis||'').trim())) return res.end(JSON.stringify({detail:'Permis déjà enregistré'}));
    // Gérer les numéros Wave multiples
    const numerosWave = data.numeros_wave&&data.numeros_wave.length
      ? data.numeros_wave.map(n=>n.trim()).filter(n=>n)
      : (data.telephone_wave?[data.telephone_wave.trim()]:[data.telephone||''].map(n=>n.trim()));
    const c={id:uid(),...data,
              telephone:(data.telephone||'').trim(),
              numeros_wave: numerosWave,
              telephone_wave: numerosWave[0]||'', // Compat
              statut:'actif',date_embauche:today(),
              cree_par:isGest?auth.gest.id:'manager'};
    if(c.categorie==='livreur') c.pin=genPin();
    db.chauffeurs.push(c);
    // Historique
    db.historique=(db.historique||[]);
    db.historique.push({id:uid(),type:'chauffeur_cree',ref_id:c.id,ref_nom:c.prenom+' '+c.nom,
      auteur:isGest?auth.gest.nom:'Manager',role:auth.role,date:new Date().toISOString()});
    saveDB(db);return res.end(JSON.stringify({id:c.id,pin:c.pin,message:'Chauffeur enregistré'}));
  }
  const cM=p.match(/^\/api\/chauffeurs\/([^/]+)$/);
  if(cM&&method==='DELETE'){if(!isManager){res.writeHead(403);return res.end(JSON.stringify({detail:'Refusé'}));}const idx=db.chauffeurs.findIndex(c=>c.id===cM[1]);if(idx!==-1){db.chauffeurs[idx].statut='depart';saveDB(db);}return res.end(JSON.stringify({message:'Chauffeur marqué comme parti'}));}
  if(cM&&method==='PATCH'){if(!isManager&&!isGest){res.writeHead(403);return res.end(JSON.stringify({detail:'Refusé'}));}const idx=db.chauffeurs.findIndex(c=>c.id===cM[1]);if(idx!==-1){if(data.telephone&&data.telephone!==db.chauffeurs[idx].telephone&&db.chauffeurs.find((c,i)=>i!==idx&&c.telephone===data.telephone))return res.end(JSON.stringify({detail:'Téléphone déjà utilisé'}));db.chauffeurs[idx]={...db.chauffeurs[idx],...data};if(db.chauffeurs[idx].categorie==='livreur'&&!db.chauffeurs[idx].pin)db.chauffeurs[idx].pin=genPin();saveDB(db);}return res.end(JSON.stringify({message:'Mis à jour'}));}

  // ── FICHE CHAUFFEUR ───────────────────────────────────────
  const cFiche=p.match(/^\/api\/chauffeurs\/([^/]+)\/fiche$/);
  if(cFiche&&method==='GET'){
    const c=db.chauffeurs.find(x=>x.id===cFiche[1]);
    if(!c){res.writeHead(404);return res.end(JSON.stringify({detail:'Introuvable'}));}
    const affActive=db.affectations.find(a=>a.chauffeur_id===c.id&&!a.date_fin);
    const vehicule=affActive?db.vehicules.find(v=>v.id===affActive.vehicule_id):null;
    const myVehs=vehsVisibles(db,auth).map(v=>v.id);
    if(!isManager&&vehicule&&!myVehs.includes(vehicule.id)){res.writeHead(403);return res.end(JSON.stringify({detail:'Refusé'}));}
    const affIds=db.affectations.filter(a=>a.chauffeur_id===c.id).map(a=>a.id);
    const versements=db.versements.filter(vs=>affIds.includes(vs.affectation_id));
    const depenses=db.depenses.filter(d=>d.chauffeur_id===c.id);
    const facturations=db.facturations.filter(f=>f.chauffeur_id===c.id);
    const total_facture=facturations.reduce((s,f)=>s+f.montant_facture,0);
    const total_verse=versements.reduce((s,vs)=>s+vs.montant,0);
    const total_depenses=depenses.reduce((s,d)=>s+d.montant,0);
    return res.end(JSON.stringify({chauffeur:c,vehicule,affectation:affActive,versements:versements.slice(-20).reverse(),total_facture,total_verse,total_depenses,recette_nette:total_verse-total_depenses,manquant:Math.max(0,total_facture-total_verse)}));
  }

  // ── AFFECTATIONS ──────────────────────────────────────────
  if(p==='/api/affectations'&&method==='GET'){
    const myVehs=vehsVisibles(db,auth).map(v=>v.id);
    let list=db.affectations.filter(a=>!a.date_fin&&myVehs.includes(a.vehicule_id));
    return res.end(JSON.stringify(list.map(a=>{
      const v=db.vehicules.find(x=>x.id===a.vehicule_id);
      const c=db.chauffeurs.find(x=>x.id===a.chauffeur_id);
      return{...a,vehicule:v?v.immatriculation+' · '+v.marque:'?',chauffeur:c?c.prenom+' '+c.nom:'?'};
    })));
  }
  if(p==='/api/affectations'&&method==='POST'){
    if(!isManager&&!isGest){res.writeHead(403);return res.end(JSON.stringify({detail:'Refusé'}));}
    const vehPourAff=db.vehicules.find(v=>v.id===data.vehicule_id);
    const maxAffVeh=(vehPourAff&&vehPourAff.categorie==='moto')?2:1;
    const affActivesVeh=db.affectations.filter(a=>a.vehicule_id===data.vehicule_id&&!a.date_fin);
    if(affActivesVeh.length>=maxAffVeh) return res.end(JSON.stringify({detail: maxAffVeh===2?'Cette moto a déjà 2 livreurs affectés':'Ce véhicule a déjà un chauffeur'}));
    if(db.affectations.find(a=>a.chauffeur_id===data.chauffeur_id&&!a.date_fin)) return res.end(JSON.stringify({detail:'Ce chauffeur est déjà affecté'}));
    const a={id:uid(),...data,date_fin:null,cree_par:isGest?auth.gest.id:'manager'};
    db.affectations.push(a);
    db.historique=(db.historique||[]);
    const vehAff=db.vehicules.find(v=>v.id===data.vehicule_id);
    const chaufAff=db.chauffeurs.find(c=>c.id===data.chauffeur_id);
    db.historique.push({id:uid(),type:'affectation_creee',ref_id:a.id,
      ref_nom:(vehAff?vehAff.immatriculation:'?')+' → '+(chaufAff?chaufAff.prenom+' '+chaufAff.nom:'?'),
      auteur:isGest?auth.gest.nom:'Manager',role:auth.role,date:new Date().toISOString()});
    saveDB(db);
    return res.end(JSON.stringify({id:a.id,message:'Affectation créée'}));
  }
  const aM=p.match(/^\/api\/affectations\/([^/]+)\/cloturer$/);
  if(aM&&method==='PATCH'){
    if(!isManager&&!isGest){res.writeHead(403);return res.end(JSON.stringify({detail:'Refusé'}));}
    const idx=db.affectations.findIndex(a=>a.id===aM[1]);
    if(idx!==-1){
      // Gestionnaire : vérifier que le véhicule lui appartient
      if(isGest&&!auth.gest.vehicules_ids.includes(db.affectations[idx].vehicule_id)){
        res.writeHead(403);return res.end(JSON.stringify({detail:'Véhicule non assigné'}));
      }
      db.affectations[idx].date_fin=today();
      db.historique=(db.historique||[]);
      const vehCl=db.vehicules.find(v=>v.id===db.affectations[idx].vehicule_id);
      const chCl=db.chauffeurs.find(c=>c.id===db.affectations[idx].chauffeur_id);
      db.historique.push({id:uid(),type:'affectation_cloturee',ref_id:aM[1],
        ref_nom:(vehCl?vehCl.immatriculation:'?')+' ← '+(chCl?chCl.prenom+' '+chCl.nom:'?'),
        auteur:isGest?auth.gest.nom:'Manager',role:auth.role,date:new Date().toISOString()});
      saveDB(db);
    }
    return res.end(JSON.stringify({message:'Clôturée'}));
  }

  // ── VERSEMENTS ────────────────────────────────────────────
  if(p==='/api/versements'&&method==='GET'){
    let visVehs=vehsVisibles(db,auth);
    if(q.tag) visVehs=visVehs.filter(v=>v.tag===q.tag);
    const myVehs=visVehs.map(v=>v.id);
    const myAffIds=db.affectations.filter(a=>myVehs.includes(a.vehicule_id)).map(a=>a.id);
    let list=db.versements.filter(v=>myAffIds.includes(v.affectation_id));
    if(q.date_debut&&q.date_fin) list=list.filter(v=>v.date_versement>=q.date_debut&&v.date_versement<=q.date_fin);
    // Filtre par vehicule_id : retourne TOUS les versements de ce véhicule sans limite
    if(q.vehicule_id){
      const vAffIds=db.affectations.filter(a=>a.vehicule_id===q.vehicule_id&&myVehs.includes(a.vehicule_id)).map(a=>a.id);
      list=list.filter(v=>vAffIds.includes(v.affectation_id));
      return res.end(JSON.stringify(list.sort((a,b)=>b.date_versement.localeCompare(a.date_versement)).map(v=>{
        const aff=db.affectations.find(a=>a.id===v.affectation_id);
        const c=aff?db.chauffeurs.find(x=>x.id===aff.chauffeur_id):null;
        const veh=db.vehicules.find(x=>x.id===q.vehicule_id);
        return{...v,chauffeur:c?c.prenom+' '+c.nom:'?',vehicule:veh?veh.immatriculation:'?',vehicule_id:q.vehicule_id};
      })));
    }
    return res.end(JSON.stringify(list.reverse().map(v=>{
      const aff=db.affectations.find(a=>a.id===v.affectation_id);
      const c=aff?db.chauffeurs.find(x=>x.id===aff.chauffeur_id):null;
      const veh=aff?db.vehicules.find(x=>x.id===aff.vehicule_id):null;
      return{...v,chauffeur:c?c.prenom+' '+c.nom:'?',vehicule:veh?veh.immatriculation:'?',vehicule_id:veh?veh.id:''};
    })));
  }
  if(p==='/api/versements'&&method==='POST'){
    if(!canWrite){res.writeHead(403);return res.end(JSON.stringify({detail:'Refusé'}));}
    if(!peutEncaisser(auth)){res.writeHead(403);return res.end(JSON.stringify({detail:'Vous n\'avez pas la permission d\'encaisser'}));}
    const aff=db.affectations.find(a=>a.id===data.affectation_id);
    if(!aff) return res.end(JSON.stringify({detail:'Affectation introuvable'}));
    if(isGest&&!auth.gest.vehicules_ids.includes(aff.vehicule_id)){res.writeHead(403);return res.end(JSON.stringify({detail:'Véhicule non assigné'}));}
    const attendu=aff.montant_journalier,montant=Number(data.montant);
    const statut=montant>=attendu?'recu':montant>0?'partiel':'en_retard';
    const v={id:uid(),...data,montant,montant_attendu:attendu,statut,created_at:new Date().toISOString()};
    db.versements.push(v);saveDB(db);return res.end(JSON.stringify({id:v.id,statut,ecart:attendu-montant,message:'Versement enregistré'}));
  }
  const vsM=p.match(/^\/api\/versements\/([^/]+)$/);
  // SUPPRIMER un versement
  const versM=p.match(/^\/api\/versements\/([^/]+)$/);
  if(versM&&method==='DELETE'){
    if(!canWrite){res.writeHead(403);return res.end(JSON.stringify({detail:'Refusé'}));}
    if(!peutEncaisser(auth)){res.writeHead(403);return res.end(JSON.stringify({detail:'Vous n\'avez pas la permission d\'encaisser'}));}
    const vs=db.versements.find(v=>v.id===versM[1]);
    if(!vs){res.writeHead(404);return res.end(JSON.stringify({detail:'Versement introuvable'}));}
    const aff=db.affectations.find(a=>a.id===vs.affectation_id);
    if(isGest&&aff&&!auth.gest.vehicules_ids.includes(aff.vehicule_id)){
      res.writeHead(403);return res.end(JSON.stringify({detail:'Véhicule non assigné'}));
    }
    db.versements=db.versements.filter(v=>v.id!==versM[1]);
    db.historique=(db.historique||[]);
    const vehV=aff?db.vehicules.find(x=>x.id===aff.vehicule_id):null;
    db.historique.push({id:uid(),type:'versement_supprime',
      ref_nom:(vehV?vehV.immatriculation:'?')+' '+vs.date_versement+' ('+vs.montant+' F)',
      auteur:isGest?auth.gest.nom:'Manager',role:auth.role,date:new Date().toISOString()});
    saveDB(db);return res.end(JSON.stringify({message:'Versement supprimé'}));
  }

  if(vsM&&method==='DELETE'){if(!isManager){res.writeHead(403);return res.end(JSON.stringify({detail:'Refusé'}));}db.versements=db.versements.filter(v=>v.id!==vsM[1]);saveDB(db);return res.end(JSON.stringify({message:'Supprimé'}));}
  if(vsM&&method==='PATCH'){if(!canWrite){res.writeHead(403);return res.end(JSON.stringify({detail:'Refusé'}));}if(!peutEncaisser(auth)){res.writeHead(403);return res.end(JSON.stringify({detail:'Vous n\'avez pas la permission d\'encaisser'}));}const idx=db.versements.findIndex(v=>v.id===vsM[1]);if(idx!==-1){const at=db.versements[idx].montant_attendu;const m=data.montant!==undefined?Number(data.montant):db.versements[idx].montant;const s=m>=at?'recu':m>0?'partiel':'en_retard';db.versements[idx]={...db.versements[idx],...data,montant:m,statut:s};saveDB(db);}return res.end(JSON.stringify({message:'Mis à jour'}));}

  // ── DEPENSES ──────────────────────────────────────────────
  if(p==='/api/depenses'&&method==='GET'){
    const myVehs=vehsVisibles(db,auth).map(v=>v.id);
    let list=db.depenses.filter(d=>myVehs.includes(d.vehicule_id));
    if(q.date_debut&&q.date_fin) list=list.filter(d=>d.date_depense>=q.date_debut&&d.date_depense<=q.date_fin);
    return res.end(JSON.stringify(list.slice(-300).reverse()));
  }
  if(p==='/api/depenses'&&method==='POST'){
    if(!canWrite){res.writeHead(403);return res.end(JSON.stringify({detail:'Refusé'}));}
    if(isGest&&!auth.gest.vehicules_ids.includes(data.vehicule_id)){res.writeHead(403);return res.end(JSON.stringify({detail:'Véhicule non assigné'}));}
    const payeur=data.payeur==='tiers'?'tiers':'gestionnaire';
    const d={id:uid(),...data,montant:Number(data.montant),justificatif:data.justificatif||null,date_facture:data.date_facture||null,payeur,tiers_nom:payeur==='tiers'?(data.tiers_nom||'').trim()||null:null,tiers_statut:payeur==='tiers'?(data.tiers_statut==='rembourse'?'rembourse':'a_rembourser'):null,date_depense:today(),created_at:new Date().toISOString()};
    db.depenses.push(d);saveDB(db);return res.end(JSON.stringify({id:d.id,message:'Dépense enregistrée'}));
  }
  const dM=p.match(/^\/api\/depenses\/([^/]+)$/);
  if(dM&&method==='DELETE'){
    if(!canWrite){res.writeHead(403);return res.end(JSON.stringify({detail:'Refusé'}));}
    // Gestionnaire : vérifier que la dépense appartient à un de ses véhicules
    if(isGest){
      const dep=db.depenses.find(d=>d.id===dM[1]);
      if(dep&&!auth.gest.vehicules_ids.includes(dep.vehicule_id)){res.writeHead(403);return res.end(JSON.stringify({detail:'Accès refusé'}));}
    }
    db.depenses=db.depenses.filter(d=>d.id!==dM[1]);
    saveDB(db);return res.end(JSON.stringify({message:'Supprimé'}));
  }
  if(dM&&method==='PATCH'){if(!canWrite){res.writeHead(403);return res.end(JSON.stringify({detail:'Refusé'}));}const idx=db.depenses.findIndex(d=>d.id===dM[1]);if(idx!==-1){db.depenses[idx]={...db.depenses[idx],...data};saveDB(db);}return res.end(JSON.stringify({message:'Mis à jour'}));}

  // ── LIVREURS MOTO — CONFIG (taux horaire + paliers de primes) ──
  if(p==='/api/config_livreurs'&&method==='GET'){
    return res.end(JSON.stringify(db.config_livreurs));
  }
  if(p==='/api/config_livreurs'&&method==='PATCH'){
    if(!isManager){res.writeHead(403);return res.end(JSON.stringify({detail:'Refusé'}));}
    if(data.taux_horaire!==undefined) db.config_livreurs.taux_horaire=Number(data.taux_horaire)||0;
    if(Array.isArray(data.paliers)){
      db.config_livreurs.paliers=data.paliers
        .map(x=>({seuil:Number(x.seuil)||0,prime:Number(x.prime)||0}))
        .sort((a,b)=>a.seuil-b.seuil);
    }
    saveDB(db);return res.end(JSON.stringify({message:'Configuration mise à jour',config:db.config_livreurs}));
  }

  // ── LIVREURS MOTO — liste (= chauffeurs de catégorie livreur) ───
  if(p==='/api/livreurs'&&method==='GET'){
    const visIds=livreursVisiblesIds(db,auth);
    let list=db.chauffeurs.filter(c=>visIds.includes(c.id));
    if(q.q){const sq=q.q.toLowerCase();list=list.filter(c=>(c.prenom||'').toLowerCase().includes(sq)||(c.nom||'').toLowerCase().includes(sq));}
    list=list.map(c=>{
      const aff=db.affectations.find(a=>a.chauffeur_id===c.id&&!a.date_fin);
      const veh=aff?db.vehicules.find(v=>v.id===aff.vehicule_id):null;
      return{id:c.id,prenom:c.prenom,nom:c.nom,telephone:c.telephone,moto_immat:veh?veh.immatriculation:null,pin:c.pin||null};
    });
    return res.end(JSON.stringify(list));
  }

  // ── LIVREURS MOTO — régénérer le code PIN d'accès ───────────────
  const regenPinM=p.match(/^\/api\/livreurs\/([^/]+)\/regen_pin$/);
  if(regenPinM&&method==='POST'){
    if(!canWrite){res.writeHead(403);return res.end(JSON.stringify({detail:'Refusé'}));}
    if(!livreursVisiblesIds(db,auth).includes(regenPinM[1])){res.writeHead(403);return res.end(JSON.stringify({detail:'Refusé'}));}
    const idx=db.chauffeurs.findIndex(c=>c.id===regenPinM[1]&&c.categorie==='livreur');
    if(idx===-1){res.writeHead(404);return res.end(JSON.stringify({detail:'Livreur introuvable'}));}
    db.chauffeurs[idx].pin=genPin();
    saveDB(db);
    return res.end(JSON.stringify({pin:db.chauffeurs[idx].pin,message:'Code PIN régénéré'}));
  }

  // ── HEURES LIVREURS (saisie journalière — le montant est géré via Facturation/Versement) ──
  if(p==='/api/recettes_livreurs'&&method==='GET'){
    const visIds=livreursVisiblesIds(db,auth);
    let list=db.recettes_livreurs.filter(r=>visIds.includes(r.livreur_id));
    if(q.livreur_id) list=list.filter(r=>r.livreur_id===q.livreur_id);
    if(q.date_debut) list=list.filter(r=>r.date>=q.date_debut);
    if(q.date_fin) list=list.filter(r=>r.date<=q.date_fin);
    return res.end(JSON.stringify(list.slice(-500).reverse()));
  }
  if(p==='/api/recettes_livreurs'&&method==='POST'){
    if(!canWrite){res.writeHead(403);return res.end(JSON.stringify({detail:'Refusé'}));}
    if(!data.livreur_id) return res.end(JSON.stringify({detail:'Livreur obligatoire'}));
    if(isGest&&!livreursVisiblesIds(db,auth).includes(data.livreur_id)){res.writeHead(403);return res.end(JSON.stringify({detail:'Livreur non assigné'}));}
    const date=data.date||today();
    const heures=Number(data.heures)||0;
    const existing=db.recettes_livreurs.findIndex(r=>r.livreur_id===data.livreur_id&&r.date===date);
    const r={id:existing!==-1?db.recettes_livreurs[existing].id:uid(),livreur_id:data.livreur_id,date,heures,note:data.note||'',created_at:new Date().toISOString()};
    if(existing!==-1) db.recettes_livreurs[existing]=r; else db.recettes_livreurs.push(r);
    saveDB(db);return res.end(JSON.stringify({id:r.id,message:'Heures enregistrées'}));
  }
  const rlM=p.match(/^\/api\/recettes_livreurs\/([^/]+)$/);
  if(rlM&&method==='DELETE'){
    if(!canWrite){res.writeHead(403);return res.end(JSON.stringify({detail:'Refusé'}));}
    const rExist=db.recettes_livreurs.find(r=>r.id===rlM[1]);
    if(isGest&&rExist&&!livreursVisiblesIds(db,auth).includes(rExist.livreur_id)){res.writeHead(403);return res.end(JSON.stringify({detail:'Refusé'}));}
    db.recettes_livreurs=db.recettes_livreurs.filter(r=>r.id!==rlM[1]);
    saveDB(db);return res.end(JSON.stringify({message:'Supprimé'}));
  }

  // ── CALCUL PAIE LIVREUR (heures × taux + prime par palier sur le vrai versé) ──
  const calcM=p.match(/^\/api\/livreurs\/([^/]+)\/calcul$/);
  if(calcM&&method==='GET'){
    const livreur=db.chauffeurs.find(c=>c.id===calcM[1]);
    if(!livreur){res.writeHead(404);return res.end(JSON.stringify({detail:'Introuvable'}));}
    if(!isManager&&!livreursVisiblesIds(db,auth).includes(calcM[1])){res.writeHead(403);return res.end(JSON.stringify({detail:'Refusé'}));}
    const dd=q.date_debut||'0000-00-00', df=q.date_fin||'9999-99-99';
    return res.end(JSON.stringify(calculPaieLivreur(db,calcM[1],dd,df)));
  }

  // ── PAIEMENTS LIVREURS ───────────────────────────────────────
  if(p==='/api/paiements_livreurs'&&method==='GET'){
    const visIds=livreursVisiblesIds(db,auth);
    let list=db.paiements_livreurs.filter(pm=>visIds.includes(pm.livreur_id));
    if(q.livreur_id) list=list.filter(pm=>pm.livreur_id===q.livreur_id);
    return res.end(JSON.stringify(list.slice(-300).reverse()));
  }
  if(p==='/api/paiements_livreurs'&&method==='POST'){
    if(!canWrite){res.writeHead(403);return res.end(JSON.stringify({detail:'Refusé'}));}
    if(!data.livreur_id) return res.end(JSON.stringify({detail:'Livreur obligatoire'}));
    if(isGest&&!livreursVisiblesIds(db,auth).includes(data.livreur_id)){res.writeHead(403);return res.end(JSON.stringify({detail:'Livreur non assigné'}));}
    const pm={id:uid(),livreur_id:data.livreur_id,periode_debut:data.periode_debut||'',periode_fin:data.periode_fin||'',
      total_heures:Number(data.total_heures)||0,total_verse:Number(data.total_verse)||0,
      taux_horaire:Number(data.taux_horaire)||0,prime:Number(data.prime)||0,
      montant:Number(data.montant)||0,statut:'paye',
      date_paiement:today(),auteur:isGest?auth.gest.nom:'Manager',created_at:new Date().toISOString()};
    db.paiements_livreurs.push(pm);saveDB(db);
    return res.end(JSON.stringify({id:pm.id,message:'Paiement enregistré'}));
  }
  const plM=p.match(/^\/api\/paiements_livreurs\/([^/]+)$/);
  if(plM&&method==='DELETE'){
    if(!isManager){res.writeHead(403);return res.end(JSON.stringify({detail:'Refusé'}));}
    db.paiements_livreurs=db.paiements_livreurs.filter(pm=>pm.id!==plM[1]);
    saveDB(db);return res.end(JSON.stringify({message:'Supprimé'}));
  }

  // ── ESPACE LIVREUR (accès lecture seule du livreur lui-même, token "lv:") ──
  // Toujours scopé sur auth.livreur.id : jamais d'id fourni par le client.
  if(p==='/api/livreur/me'&&method==='GET'){
    if(auth.role!=='livreur'){res.writeHead(403);return res.end(JSON.stringify({detail:'Refusé'}));}
    const lv=auth.livreur;
    const aff=db.affectations.find(a=>a.chauffeur_id===lv.id&&!a.date_fin);
    const veh=aff?db.vehicules.find(v=>v.id===aff.vehicule_id):null;
    return res.end(JSON.stringify({id:lv.id,prenom:lv.prenom,nom:lv.nom,telephone:lv.telephone,
      moto_immat:veh?veh.immatriculation:null,montant_journalier:aff?(aff.montant_journalier||0):0}));
  }
  if(p==='/api/livreur/dashboard'&&method==='GET'){
    if(auth.role!=='livreur'){res.writeHead(403);return res.end(JSON.stringify({detail:'Refusé'}));}
    const lvId=auth.livreur.id;
    const dd=q.date_debut||'0000-00-00', df=q.date_fin||'9999-99-99';
    const calc=calculPaieLivreur(db,lvId,dd,df);
    const recettes=db.recettes_livreurs.filter(r=>r.livreur_id===lvId&&r.date>=dd&&r.date<=df);
    const affIds=db.affectations.filter(a=>a.chauffeur_id===lvId).map(a=>a.id);
    const versements=db.versements.filter(vs=>affIds.includes(vs.affectation_id)&&vs.date_versement>=dd&&vs.date_versement<=df);
    const parJour={};
    function jourDe(date){ return parJour[date]=parJour[date]||{date,heures:0,verse:0}; }
    recettes.forEach(r=>{ jourDe(r.date).heures+=r.heures; });
    versements.forEach(vs=>{ jourDe(vs.date_versement).verse+=vs.montant; });
    Object.keys(calc.manquant_par_jour).forEach(date=>{ jourDe(date).manquant=calc.manquant_par_jour[date]; });
    const primeParDate={};
    calc.detail_primes.forEach(d=>{ primeParDate[d.date]=d.prime; });
    const detail_jours=Object.values(parJour).sort((a,b)=>b.date.localeCompare(a.date)).map(j=>{
      const prime=primeParDate[j.date]||0;
      const salaire=Math.round(j.heures*calc.taux_horaire);
      const manquant=j.manquant||0;
      return Object.assign({},j,{manquant,prime,montant_a_payer:salaire+prime});
    });
    return res.end(JSON.stringify(Object.assign({},calc,{detail_jours})));
  }
  if(p==='/api/livreur/paiements'&&method==='GET'){
    if(auth.role!=='livreur'){res.writeHead(403);return res.end(JSON.stringify({detail:'Refusé'}));}
    const list=db.paiements_livreurs.filter(pm=>pm.livreur_id===auth.livreur.id);
    return res.end(JSON.stringify(list.slice(-300).reverse()));
  }

  // ── FACTURATIONS ──────────────────────────────────────────
  if(p==='/api/facturations'&&method==='GET'){
    let visVehsFac=vehsVisibles(db,auth);
    if(q.tag) visVehsFac=visVehsFac.filter(v=>v.tag===q.tag);
    const myVehs=visVehsFac.map(v=>v.id);
    let list=db.facturations.filter(f=>myVehs.includes(f.vehicule_id));
    if(q.vehicule_id) list=list.filter(f=>f.vehicule_id===q.vehicule_id);
    if(q.chauffeur_id) list=list.filter(f=>f.chauffeur_id===q.chauffeur_id);
    if(q.date_debut&&q.date_fin) list=list.filter(f=>f.date>=q.date_debut&&f.date<=q.date_fin);
    return res.end(JSON.stringify(list.reverse().map(f=>{
      const v=db.vehicules.find(x=>x.id===f.vehicule_id);
      const c=db.chauffeurs.find(x=>x.id===f.chauffeur_id);
      return{...f,vehicule:v?v.immatriculation:'?',chauffeur:c?c.prenom+' '+c.nom:'?'};
    })));
  }
  if(p==='/api/facturations'&&method==='POST'){
    if(!canWrite){res.writeHead(403);return res.end(JSON.stringify({detail:'Refusé'}));}
    if(!peutFacturer(auth)){res.writeHead(403);return res.end(JSON.stringify({detail:'Vous n\'avez pas la permission de facturer'}));}
    // Gestionnaire : vérifier que le véhicule lui est assigné (via tags ou ids)
    if(isGest){
      const myVehs=vehsVisibles(db,auth).map(v=>v.id);
      if(!myVehs.includes(data.vehicule_id)){res.writeHead(403);return res.end(JSON.stringify({detail:'Véhicule non assigné à votre compte'}));}
    }
    const existing=db.facturations.findIndex(f=>f.vehicule_id===data.vehicule_id&&f.date===data.date);
    if(existing!==-1){
      // Mise à jour si même véhicule/date (pas un vrai doublon — c'est une correction)
      db.facturations[existing]={...db.facturations[existing],...data,updated_at:new Date().toISOString()};
      saveDB(db);
      return res.end(JSON.stringify({message:'Facturation mise à jour',id:db.facturations[existing].id,updated:true}));
    }
    const f={id:uid(),...data,created_at:new Date().toISOString()};
    db.facturations.push(f);saveDB(db);return res.end(JSON.stringify({id:f.id,message:'Facturation enregistrée',updated:false}));
  }
  // MODIFIER une facturation
  const facM=p.match(/^\/api\/facturations\/([^/]+)$/);
  if(facM&&method==='PATCH'){
    if(!canWrite){res.writeHead(403);return res.end(JSON.stringify({detail:'Refus\u00e9'}));}
    if(!peutFacturer(auth)){res.writeHead(403);return res.end(JSON.stringify({detail:'Vous n\'avez pas la permission de facturer'}));}
    const idx=db.facturations.findIndex(f=>f.id===facM[1]);
    if(idx===-1){res.writeHead(404);return res.end(JSON.stringify({detail:'Facturation introuvable'}));}
    if(isGest&&!auth.gest.vehicules_ids.includes(db.facturations[idx].vehicule_id)){res.writeHead(403);return res.end(JSON.stringify({detail:'V\u00e9hicule non assign\u00e9'}));}
    const old=db.facturations[idx];
    db.facturations[idx]={...old,...data,updated_at:new Date().toISOString()};
    db.historique=(db.historique||[]);
    const vFac=db.vehicules.find(v=>v.id===old.vehicule_id);
    db.historique.push({id:uid(),type:'facturation_modifiee',
      ref_nom:(vFac?vFac.immatriculation:'?')+' '+old.date+' : '+old.montant_facture+' F -> '+data.montant_facture+' F',
      auteur:isGest?auth.gest.nom:'Manager',role:auth.role,date:new Date().toISOString()});
    saveDB(db);return res.end(JSON.stringify({message:'Facturation modifi\u00e9e'}));
  }
  // SUPPRIMER une facturation
  if(facM&&method==='DELETE'){
    if(!canWrite){res.writeHead(403);return res.end(JSON.stringify({detail:'Refus\u00e9'}));}
    if(!peutFacturer(auth)){res.writeHead(403);return res.end(JSON.stringify({detail:'Vous n\'avez pas la permission de facturer'}));}
    const fac=db.facturations.find(f=>f.id===facM[1]);
    if(!fac){res.writeHead(404);return res.end(JSON.stringify({detail:'Facturation introuvable'}));}
    if(isGest&&!auth.gest.vehicules_ids.includes(fac.vehicule_id)){res.writeHead(403);return res.end(JSON.stringify({detail:'V\u00e9hicule non assign\u00e9'}));}
    db.facturations=db.facturations.filter(f=>f.id!==facM[1]);
    db.historique=(db.historique||[]);
    const vFacD=db.vehicules.find(v=>v.id===fac.vehicule_id);
    db.historique.push({id:uid(),type:'facturation_supprimee',
      ref_nom:(vFacD?vFacD.immatriculation:'?')+' '+fac.date+' ('+fac.montant_facture+' F)',
      auteur:isGest?auth.gest.nom:'Manager',role:auth.role,date:new Date().toISOString()});
    saveDB(db);return res.end(JSON.stringify({message:'Facturation supprim\u00e9e'}));
  }
  // FACTURATION MULTIPLE
  if(p==='/api/facturations/multiple'&&method==='POST'){
    if(!canWrite){res.writeHead(403);return res.end(JSON.stringify({detail:'Refusé'}));}
    if(!peutFacturer(auth)){res.writeHead(403);return res.end(JSON.stringify({detail:'Vous n\'avez pas la permission de facturer'}));}
    const {vehicules_ids, type_journee, date} = data;
    if(!vehicules_ids||!vehicules_ids.length) return res.end(JSON.stringify({detail:'Aucun véhicule sélectionné'}));
    const results=[];
    for(const vid of vehicules_ids){
      if(isGest&&!auth.gest.vehicules_ids.includes(vid)) continue;
      const aff=db.affectations.find(a=>a.vehicule_id===vid&&!a.date_fin);
      if(!aff) continue;
      const montant_base=aff.montant_journalier;
      const montant_facture=type_journee==='complet'?montant_base:type_journee==='demi_panne'?Math.round(montant_base/2):0;
      const existing=db.facturations.findIndex(f=>f.vehicule_id===vid&&f.date===date);
      const fac={id:existing!==-1?db.facturations[existing].id:uid(),vehicule_id:vid,chauffeur_id:aff.chauffeur_id,date,type_journee,montant_facture,montant_base,created_at:new Date().toISOString()};
      if(existing!==-1)db.facturations[existing]=fac;else db.facturations.push(fac);
      // Mettre à jour le statut jour
      const sjMap={complet:'actif',demi_panne:'panne',repos:'repos',inactif:'inactif'};
      const statut_jour=sjMap[type_journee]||'actif';
      const eidx=db.activites.findIndex(a=>a.vehicule_id===vid&&a.date===date);
      const entry={id:eidx!==-1?db.activites[eidx].id:uid(),vehicule_id:vid,date,statut_jour};
      if(eidx!==-1)db.activites[eidx]=entry;else db.activites.push(entry);
      results.push({vehicule_id:vid,montant_facture});
    }
    saveDB(db);return res.end(JSON.stringify({message:`${results.length} véhicules facturés`,results}));
  }

  // ── ENCAISSEMENT ──────────────────────────────────────────
  if(p==='/api/encaissements'&&method==='POST'){
    if(!canWrite){res.writeHead(403);return res.end(JSON.stringify({detail:'Refusé'}));}
    if(!peutEncaisser(auth)){res.writeHead(403);return res.end(JSON.stringify({detail:'Vous n\'avez pas la permission d\'encaisser'}));}
    const{chauffeur_id,montant_recu,mode_paiement,date_encaissement,mode_imputation}=data;
    const aff_active=db.affectations.find(a=>a.chauffeur_id===chauffeur_id&&!a.date_fin);
    if(!aff_active) return res.end(JSON.stringify({detail:'Aucune affectation active'}));
    if(isGest&&!auth.gest.vehicules_ids.includes(aff_active.vehicule_id)){res.writeHead(403);return res.end(JSON.stringify({detail:'Véhicule non assigné'}));}
    const montant=Number(montant_recu);
    const affIds=db.affectations.filter(a=>a.chauffeur_id===chauffeur_id).map(a=>a.id);
    const total_verse=db.versements.filter(v=>affIds.includes(v.affectation_id)).reduce((s,v)=>s+v.montant,0);
    const total_facture=db.facturations.filter(f=>f.chauffeur_id===chauffeur_id).reduce((s,f)=>s+f.montant_facture,0);
    const dette=Math.max(0,total_facture-total_verse);
    const statut=montant>=aff_active.montant_journalier?'recu':montant>0?'partiel':montant===0?'repos_panne':'en_retard';
    const v={id:uid(),affectation_id:aff_active.id,montant,montant_attendu:aff_active.montant_journalier,statut,
              mode_paiement:mode_paiement||'especes',reference:data.reference||'',
              date_versement:date_encaissement||today(),created_at:new Date().toISOString()};
    db.versements.push(v);
    // Historique encaissement
    db.historique=(db.historique||[]);
    const vehEnc=db.vehicules.find(x=>x.id===aff_active.vehicule_id);
    const chEnc=db.chauffeurs.find(x=>x.id===chauffeur_id);
    db.historique.push({id:uid(),type:'encaissement',
      ref_nom:(vehEnc?vehEnc.immatriculation:'?')+' — '+(chEnc?chEnc.prenom+' '+chEnc.nom:'?')+' — '+montant+' F ('+mode_paiement+')',
      auteur:isGest?auth.gest.nom:'Manager',role:auth.role,date:new Date().toISOString()});
    saveDB(db);
    return res.end(JSON.stringify({message:'Encaissement enregistré',versement_id:v.id,dette_avant:dette,dette_apres:Math.max(0,dette-montant)}));
  }

  // ── RETARDS ───────────────────────────────────────────────
  if(p==='/api/retards'&&method==='GET'){
    let vehs=vehsVisibles(db,auth);
    const date_debut=q.date_debut||'';
    const date_fin=q.date_fin||'';
    // Filtre par tag (simple ou multi)
    if(q.tag) vehs=vehs.filter(v=>v.tag===q.tag);
    if(q.tags) {
      const tagList=q.tags.split(',').map(t=>t.trim()).filter(Boolean);
      if(tagList.length) vehs=vehs.filter(v=>tagList.includes(v.tag));
    }

    // ── Retard RÉEL = Dette cumulée globale ───────────────────
    // Retard = Total facturé depuis le début - Total versé depuis le début
    // La période filtre uniquement les véhicules ACTIFS sur cette période
    // (ont au moins une facturation dans la période).
    // Cela évite les faux retards dus au FIFO inter-périodes.

    const retards=vehs.map(v=>{
      const affs=db.affectations.filter(a=>a.vehicule_id===v.id);
      const affIds=affs.map(a=>a.id);
      const aff_active=affs.find(a=>!a.date_fin);
      const chauffeur=aff_active?db.chauffeurs.find(c=>c.id===aff_active.chauffeur_id):null;

      // Toutes les données du véhicule
      const facsAll=db.facturations.filter(f=>f.vehicule_id===v.id);
      const versAll=db.versements.filter(vs=>affIds.includes(vs.affectation_id));

      // Filtre période : ne garder que les véhicules ayant des factures sur la période
      if(date_debut&&date_fin){
        const facsPer=facsAll.filter(f=>f.date>=date_debut&&f.date<=date_fin);
        if(facsPer.length===0) return null;
      }

      // Dette globale = tout l'historique
      const totFac=facsAll.reduce((s,f)=>s+(f.montant_facture||0),0);
      const totVers=versAll.reduce((s,v)=>s+v.montant,0);
      const retard=Math.max(0,totFac-totVers);

      if(retard===0) return null;

      // Trouver le gestionnaire responsable de ce véhicule (par tag ou par vehicules_ids)
      const gestResp = db.gestionnaires.find(g => {
        const gTags = g.tags || (g.tag ? [g.tag] : []);
        return gTags.includes(v.tag) || (g.vehicules_ids||[]).includes(v.id);
      });

      return{
        vehicule_id:v.id,
        immatriculation:v.immatriculation,
        marque:v.marque,
        tag:v.tag||'',
        chauffeur:chauffeur?chauffeur.prenom+' '+chauffeur.nom:'Non affecté',
        gestionnaire:gestResp?gestResp.nom:'—',
        gestionnaire_id:gestResp?gestResp.id:null,
        total_facture:totFac,
        total_verse:totVers,
        retard
      };
    }).filter(Boolean).sort((a,b)=>b.retard-a.retard);
    return res.end(JSON.stringify(retards));
  }
  if(p==='/api/rapport'&&method==='GET'){
    const vehs=vehsVisibles(db,auth);
    const date_debut=q.date_debut||'';
    const date_fin=q.date_fin||'';
    return res.end(JSON.stringify(vehs.map(v=>{
      const affs=db.affectations.filter(a=>a.vehicule_id===v.id);
      const affIds=affs.map(a=>a.id);
      const aff=affs.find(a=>!a.date_fin);
      const c=aff?db.chauffeurs.find(x=>x.id===aff.chauffeur_id):null;
      let vers=db.versements.filter(vs=>affIds.includes(vs.affectation_id));
      let deps=db.depenses.filter(d=>d.vehicule_id===v.id);
      let facs=db.facturations.filter(f=>f.vehicule_id===v.id);
      if(date_debut&&date_fin){vers=vers.filter(vs=>vs.date_versement>=date_debut&&vs.date_versement<=date_fin);deps=deps.filter(d=>d.date_depense>=date_debut&&d.date_depense<=date_fin);facs=facs.filter(f=>f.date>=date_debut&&f.date<=date_fin);}
      return{immatriculation:v.immatriculation,marque:v.marque,tag:v.tag||'',chauffeur:c?c.prenom+' '+c.nom:'Non affecté',recettes:vers.reduce((s,vs)=>s+vs.montant,0),depenses:deps.reduce((s,d)=>s+d.montant,0),facture:facs.reduce((s,f)=>s+f.montant_facture,0)};
    })));
  }

  // ── ALERTES ───────────────────────────────────────────────
  if(p==='/api/alertes'&&method==='GET') return res.end(JSON.stringify(db.alertes.slice(-50).reverse()));
  if(p==='/api/alertes'&&method==='POST'){
    const al={id:uid(),...data,message:data.message||'SyNdongo — Alerte',statut:'simule',created_at:new Date().toISOString()};
    db.alertes.push(al);saveDB(db);return res.end(JSON.stringify({id:al.id,statut:'simule'}));
  }

  // ── GESTIONNAIRES ─────────────────────────────────────────
  if(p==='/api/gestionnaires'&&method==='GET'){
    if(!isManager&&!isGest){res.writeHead(403);return res.end(JSON.stringify({detail:'Refusé'}));}
    if(isGest){
      // Un gestionnaire ne voit que sa propre fiche (avec clé Wave masquée)
      const g=db.gestionnaires.find(x=>x.id===auth.gest.id);
      if(!g) return res.end(JSON.stringify([]));
      const safe={...g, wave_api_key: g.wave_api_key?'***CONFIGUREE***':''};
      return res.end(JSON.stringify([safe]));
    }
    // Manager voit tout mais masque les clés Wave
    const list=db.gestionnaires.map(g=>({...g,wave_api_key:g.wave_api_key?'***CONFIGUREE***':''}));
    return res.end(JSON.stringify(list));
  }
  if(p==='/api/gestionnaires'&&method==='POST'){
    if(!isManager){res.writeHead(403);return res.end(JSON.stringify({detail:'Refusé'}));}
    if(db.gestionnaires.find(g=>g.password===data.password)) return res.end(JSON.stringify({detail:'Ce mot de passe est déjà utilisé'}));
    const g={id:uid(),nom:data.nom,telephone:data.telephone||'',email:data.email||'',password:data.password||uid().slice(0,8),vehicules_ids:data.vehicules_ids||[],tag:data.tag||'',proprio_id:data.proprio_id||null,peut_facturer:data.peut_facturer!==false,peut_encaisser:data.peut_encaisser!==false};
    db.gestionnaires.push(g);saveDB(db);return res.end(JSON.stringify({id:g.id,password:g.password,message:'Gestionnaire créé'}));
  }
  const gM=p.match(/^\/api\/gestionnaires\/([^/]+)$/);
  if(gM&&method==='PATCH'){
    // Manager peut tout modifier. Gestionnaire peut modifier sa PROPRE clé Wave uniquement.
    if(!isManager&&!(isGest&&auth.gest.id===gM[1])){
      res.writeHead(403);return res.end(JSON.stringify({detail:'Refusé'}));
    }
    const idx=db.gestionnaires.findIndex(g=>g.id===gM[1]);
    if(idx!==-1){
      if(isGest&&!isManager){
        // Gestionnaire : ne peut modifier que sa clé Wave et ses infos personnelles
        const allowed={wave_api_key:data.wave_api_key,nom:data.nom,telephone:data.telephone,email:data.email};
        Object.keys(allowed).forEach(k=>{if(allowed[k]!==undefined)db.gestionnaires[idx][k]=allowed[k];});
      } else {
        db.gestionnaires[idx]={...db.gestionnaires[idx],...data};
      }
      saveDB(db);
    }
    return res.end(JSON.stringify({message:'Mis à jour'}));
  }
  if(gM&&method==='DELETE'){
    if(!isManager){res.writeHead(403);return res.end(JSON.stringify({detail:'Refusé'}));}
    db.gestionnaires=db.gestionnaires.filter(g=>g.id!==gM[1]);saveDB(db);
    return res.end(JSON.stringify({message:'Supprimé'}));
  }

  // ── PROPRIETAIRES ─────────────────────────────────────────
  // Manager : voit tous les propriétaires
  // Gestionnaire : voit seulement les propriétaires de ses véhicules
  if(p==='/api/proprietaires'&&method==='GET'){
    if(!isManager&&!isGest){res.writeHead(403);return res.end(JSON.stringify({detail:'Refusé'}));}
    if(isGest){
      // Filtrer : seulement les propriétaires qui ont au moins 1 véhicule du gestionnaire
      const myVehIds=auth.gest.vehicules_ids||[];
      const myProps=db.proprietaires.filter(pr=>pr.vehicules_ids.some(vid=>myVehIds.includes(vid)));
      return res.end(JSON.stringify(myProps));
    }
    return res.end(JSON.stringify(db.proprietaires));
  }
  if(p==='/api/proprietaires'&&method==='POST'){
    if(!isManager&&!isGest){res.writeHead(403);return res.end(JSON.stringify({detail:'Refusé'}));}
    if(db.proprietaires.find(pr=>pr.password===data.password)) return res.end(JSON.stringify({detail:'Ce mot de passe est déjà utilisé'}));
    // Gestionnaire : ne peut créer un proprio que pour ses propres véhicules
    let vehicules_ids = data.vehicules_ids||[];
    if(isGest){
      const myVehIds=auth.gest.vehicules_ids||[];
      vehicules_ids=vehicules_ids.filter(vid=>myVehIds.includes(vid));
      if(!vehicules_ids.length) vehicules_ids=[];
    }
    const pr={id:uid(),nom:data.nom,email:data.email||'',telephone:data.telephone||'',
               password:data.password||uid().slice(0,8),vehicules_ids,
               cree_par:isGest?auth.gest.id:'manager'};
    db.proprietaires.push(pr);saveDB(db);
    return res.end(JSON.stringify({id:pr.id,password:pr.password,message:'Propriétaire créé'}));
  }
  const prM=p.match(/^\/api\/proprietaires\/([^/]+)$/);
  if(prM&&method==='PATCH'){
    if(!isManager&&!isGest){res.writeHead(403);return res.end(JSON.stringify({detail:'Refusé'}));}
    const idx=db.proprietaires.findIndex(pr=>pr.id===prM[1]);
    if(idx!==-1){
      // Gestionnaire : ne peut modifier que les propriétaires liés à ses véhicules
      if(isGest){
        const myVehIds=auth.gest.vehicules_ids||[];
        const prVehs=db.proprietaires[idx].vehicules_ids||[];
        if(!prVehs.some(vid=>myVehIds.includes(vid))){res.writeHead(403);return res.end(JSON.stringify({detail:'Refusé'}));}
        // Filtrer les vehicules_ids dans la mise à jour
        if(data.vehicules_ids) data.vehicules_ids=data.vehicules_ids.filter(vid=>myVehIds.includes(vid));
      }
      db.proprietaires[idx]={...db.proprietaires[idx],...data};saveDB(db);
    }
    return res.end(JSON.stringify({message:'Mis à jour'}));
  }
  if(prM&&method==='DELETE'){
    if(!isManager&&!isGest){res.writeHead(403);return res.end(JSON.stringify({detail:'Refusé'}));}
    if(isGest){
      // Gestionnaire : ne peut supprimer que les propriétaires qu'il a créés
      const pr=db.proprietaires.find(pr=>pr.id===prM[1]);
      if(!pr||pr.cree_par!==auth.gest.id){res.writeHead(403);return res.end(JSON.stringify({detail:'Refusé — vous ne pouvez supprimer que les accès que vous avez créés'}));}
    }
    db.proprietaires=db.proprietaires.filter(pr=>pr.id!==prM[1]);saveDB(db);
    return res.end(JSON.stringify({message:'Supprimé'}));
  }

  // ── FACTURATION AUTOMATIQUE PAR STATUT ───────────────────────
  // Appelée quand on change le statut journalier d'un véhicule
  // Actif → facture = montant_journalier (lendemain seulement)
  // Panne ou Repos ou Inactif → facture = 0 pour ce jour
  if(p==='/api/activites/auto_facture'&&method==='POST'){
    if(!canWrite){res.writeHead(403);return res.end(JSON.stringify({detail:'Refusé'}));}
    if(!peutFacturer(auth)){res.writeHead(403);return res.end(JSON.stringify({detail:'Vous n\'avez pas la permission de facturer'}));}
    const {vehicule_id, statut_jour, date} = data;
    const targetDate = date || today();
    
    // Trouver l'affectation active
    const aff = db.affectations.find(a=>a.vehicule_id===vehicule_id&&!a.date_fin);
    if(!aff) return res.end(JSON.stringify({message:'Aucune affectation — facturation ignorée'}));
    
    // Calculer le montant selon le statut
    let montant_facture = 0;
    let type_journee = 'repos';
    if(statut_jour==='actif'){
      montant_facture = aff.montant_journalier;
      type_journee = 'complet';
    } else if(statut_jour==='panne'){
      montant_facture = 0; // panne = rien à payer
      type_journee = 'demi_panne';
    } else if(statut_jour==='repos'||statut_jour==='inactif'){
      montant_facture = 0;
      type_journee = statut_jour==='inactif'?'inactif':'repos';
    }
    
    // Créer ou mettre à jour la facturation pour ce jour
    const existIdx = db.facturations.findIndex(f=>f.vehicule_id===vehicule_id&&f.date===targetDate);
    const fac = {
      id: existIdx!==-1?db.facturations[existIdx].id:uid(),
      vehicule_id, chauffeur_id:aff.chauffeur_id, date:targetDate,
      type_journee, montant_facture, montant_base:aff.montant_journalier,
      auto:true, created_at:new Date().toISOString()
    };
    if(existIdx!==-1) db.facturations[existIdx]=fac;
    else db.facturations.push(fac);
    
    // Historique
    const veh=db.vehicules.find(v=>v.id===vehicule_id);
    db.historique=(db.historique||[]);
    db.historique.push({id:uid(),type:'auto_facturation',
      ref_nom:(veh?veh.immatriculation:'?')+' → '+type_journee+' → '+montant_facture+' F',
      auteur:isGest?auth.gest.nom:'Manager',role:auth.role,date:new Date().toISOString()});
    
    saveDB(db);
    return res.end(JSON.stringify({message:'Facturation automatique créée',montant_facture,type_journee}));
  }

  // ── WAVE API OFFICIELLE ───────────────────────────────────────

  // Créer une session de paiement Wave (paiement manuel déclenché par l'agent)
  if(p==='/api/wave/checkout'&&method==='POST'){
    if(!canWrite){res.writeHead(403);return res.end(JSON.stringify({detail:'Refusé'}));}
    const {chauffeur_id, montant} = data;
    const chauffeur=db.chauffeurs.find(c=>c.id===chauffeur_id);
    if(!chauffeur) return res.end(JSON.stringify({detail:'Chauffeur introuvable'}));
    // Clé Wave : celle du gestionnaire en priorité, sinon celle du manager
    const waveKey = isGest ? (auth.gest.wave_api_key||WAVE_API_KEY) : WAVE_API_KEY;
    if(!waveKey) return res.end(JSON.stringify({detail:'Clé Wave non configurée. Ajoutez votre clé dans Accès & Partage → Configuration Wave.'}));
    const reference='SND-'+uid().toUpperCase();
    const result = await createWavePayment(
      Number(montant),
      chauffeur.telephone,
      'SyNdongo — '+chauffeur.prenom+' '+chauffeur.nom,
      reference,
      waveKey
    );
    if(result.error) return res.end(JSON.stringify({detail:'Erreur Wave: '+result.error}));
    // Sauvegarder la référence en attente
    db.wave_pending=(db.wave_pending||{});
    db.wave_pending[reference]={chauffeur_id,montant:Number(montant),created_at:new Date().toISOString()};
    saveDB(db);
    return res.end(JSON.stringify({
      checkout_url: result.wave_launch_url || result.checkout_status?.checkout_url || '',
      reference,
      message:'Session Wave créée'
    }));
  }

  // Webhook Wave officiel — reçoit les événements de paiement
  if(p==='/api/webhook/wave'&&method==='POST'){
    // Vérifier signature
    const sig=req.headers['wave-signature']||'';
    if(!verifyWaveSignature(body,sig)&&WAVE_WEBHOOK_SECRET){
      res.writeHead(401);return res.end(JSON.stringify({status:'invalid_signature'}));
    }
    // Format Wave: { type, data: { checkout_session: { client_reference, amount, payment_status } } }
    const event=data;
    const session=event?.data?.checkout_session||event;
    const reference=session.client_reference||session.reference||'';
    const amount=Number(session.amount||session.net_amount||0);
    const payment_status=session.payment_status||event.type||'';
    
    if(payment_status!=='succeeded'&&payment_status!=='checkout.session.completed'&&event.type!=='checkout.session.completed'){
      return res.end(JSON.stringify({status:'ignored',payment_status}));
    }
    
    // Trouver le chauffeur via la référence ou le téléphone
    let chauffeur=null,affectation=null;
    const pending=db.wave_pending&&db.wave_pending[reference];
    if(pending){
      // Identification par référence SyNdongo (la plus fiable)
      chauffeur=db.chauffeurs.find(c=>c.id===pending.chauffeur_id);
      affectation=db.affectations.find(a=>a.chauffeur_id===pending.chauffeur_id&&!a.date_fin);
    } else {
      // Fallback: chercher par numéro Wave pré-enregistré (priorité) puis téléphone
      const phone=(session.client_phone||session.mobile||session.payer_mobile||'').replace(/\D/g,'');
      if(phone){
        // 1. Chercher dans TOUS les numéros Wave enregistrés
        chauffeur=db.chauffeurs.find(c=>{
          const nums=c.numeros_wave&&c.numeros_wave.length?c.numeros_wave:[c.telephone_wave||'',c.telephone||''];
          return nums.some(n=>n&&n.replace(/\D/g,'').slice(-8)===phone.slice(-8));
        });
        // 2. Fallback numéro téléphone principal
        if(!chauffeur) chauffeur=db.chauffeurs.find(c=>c.telephone&&c.telephone.replace(/\D/g,'').slice(-8)===phone.slice(-8));
        if(chauffeur) affectation=db.affectations.find(a=>a.chauffeur_id===chauffeur.id&&!a.date_fin);
      }
    }
    
    // Logger la transaction pour audit même si non trouvé
    db.historique=(db.historique||[]);
    const txRef=session.transaction_id||session.id||reference||uid();
    
    if(!chauffeur||!affectation){
      console.log('Wave webhook: chauffeur/affectation introuvable, ref:', reference);
      return res.end(JSON.stringify({status:'not_found',reference}));
    }
    
    const montant=amount||pending?.montant||0;
    const statut=montant>=affectation.montant_journalier?'recu':montant>0?'partiel':'en_retard';
    const v={id:uid(),affectation_id:affectation.id,montant,montant_attendu:affectation.montant_journalier,
             statut,mode_paiement:'wave',reference:reference,
             date_versement:today(),created_at:new Date().toISOString(),source:'wave_auto'};
    db.versements.push(v);
    // Supprimer de wave_pending
    if(db.wave_pending&&db.wave_pending[reference]) delete db.wave_pending[reference];
    db.historique=(db.historique||[]);
    const vehW=db.vehicules.find(x=>x.id===affectation.vehicule_id);
    db.historique.push({id:uid(),type:'wave_auto',
      ref_nom:(vehW?vehW.immatriculation:'?')+' — '+chauffeur.prenom+' '+chauffeur.nom+' — '+montant+' F Wave (auto)',
      auteur:'Wave API',role:'system',date:new Date().toISOString()});
    saveDB(db);
    console.log('[Wave AUTO]', chauffeur.prenom, chauffeur.nom, montant, 'F', reference);
    res.writeHead(200);return res.end(JSON.stringify({status:'ok',montant,chauffeur:chauffeur.prenom+' '+chauffeur.nom}));
  }

  // Page de succès Wave (redirection après paiement)
  if(p==='/api/wave/success'&&method==='GET'){
    res.setHeader('Content-Type','text/html; charset=utf-8');
    return res.end(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Paiement réussi</title><style>body{font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;background:#f5f4f0;margin:0}.box{background:#fff;border-radius:16px;padding:32px;text-align:center;max-width:380px;border:2px solid #3B6D11}.icon{font-size:48px}.title{font-size:20px;font-weight:700;color:#3B6D11;margin:12px 0}.sub{color:#6b6b67;font-size:14px}</style></head><body><div class="box"><div class="icon">✅</div><div class="title">Paiement Wave reçu !</div><div class="sub">Votre versement a été enregistré automatiquement dans SyNdongo.</div></div></body></html>`);
  }
  if(p==='/api/wave/error'&&method==='GET'){
    res.setHeader('Content-Type','text/html; charset=utf-8');
    return res.end(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Erreur paiement</title><style>body{font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;background:#f5f4f0;margin:0}.box{background:#fff;border-radius:16px;padding:32px;text-align:center;max-width:380px;border:2px solid #A32D2D}.icon{font-size:48px}.title{font-size:20px;font-weight:700;color:#A32D2D;margin:12px 0}.sub{color:#6b6b67;font-size:14px}</style></head><body><div class="box"><div class="icon">❌</div><div class="title">Paiement annulé</div><div class="sub">Le paiement Wave n'a pas abouti. Veuillez réessayer.</div></div></body></html>`);
  }

  // Statut des paiements Wave en attente
  // Le gestionnaire peut voir ses propres paiements en attente
  if(p==='/api/wave/pending'&&method==='GET'){
    if(!isManager&&!isGest){res.writeHead(403);return res.end(JSON.stringify({detail:'Refusé'}));}
    const pending=db.wave_pending||{};
    const list=Object.entries(pending).map(([ref,p])=>{
      const c=db.chauffeurs.find(x=>x.id===p.chauffeur_id);
      return{reference:ref,chauffeur:c?c.prenom+' '+c.nom:'?',montant:p.montant,created_at:p.created_at};
    });
    return res.end(JSON.stringify(list));
  }

  // ── JOURNAL DE BORD ──────────────────────────────────────────
  // ── RAPPELS PERSONNALISÉS ─────────────────────────────────
  if(p==='/api/rappels_custom'&&method==='GET'){
    // Filtrer par véhicules visibles (gestionnaire ne voit que ses véhicules)
    const myVehIds = vehsVisibles(db,auth).map(v=>v.id);
    const rcVisible = (db.rappels_custom||[]).filter(r=>
      !r.vehicule_id || myVehIds.includes(r.vehicule_id)
    );
    return res.end(JSON.stringify(rcVisible));
  }
  if(p==='/api/rappels_custom'&&method==='POST'){
    if(!isManager){res.writeHead(403);return res.end(JSON.stringify({detail:'Refusé'}));}
    const rc={id:uid(),...data,created_at:new Date().toISOString()};
    if(!db.rappels_custom) db.rappels_custom=[];
    db.rappels_custom.push(rc);
    saveDB(db);
    return res.end(JSON.stringify({message:'Rappel créé',id:rc.id}));
  }
  const rcM=p.match(/^\/api\/rappels_custom\/([^/]+)$/);
  if(rcM&&method==='DELETE'){
    if(!isManager){res.writeHead(403);return res.end(JSON.stringify({detail:'Refusé'}));}
    db.rappels_custom=(db.rappels_custom||[]).filter(r=>r.id!==rcM[1]);
    saveDB(db);
    return res.end(JSON.stringify({message:'Supprimé'}));
  }
  if(rcM&&method==='PATCH'){
    if(!isManager){res.writeHead(403);return res.end(JSON.stringify({detail:'Refusé'}));}
    const idx=( db.rappels_custom||[]).findIndex(r=>r.id===rcM[1]);
    if(idx!==-1){db.rappels_custom[idx]={...db.rappels_custom[idx],...data};saveDB(db);}
    return res.end(JSON.stringify({message:'Mis à jour'}));
  }

  if(p==='/api/journal'&&method==='GET'){
    const myVehs=vehsVisibles(db,auth).map(v=>v.id);
    let list=db.journal||[];
    // Filtrer par véhicules visibles
    list=list.filter(j=>myVehs.includes(j.vehicule_id));
    if(q.vehicule_id) list=list.filter(j=>j.vehicule_id===q.vehicule_id);
    if(q.categorie) list=list.filter(j=>j.categorie===q.categorie);
    if(q.date_debut) list=list.filter(j=>j.date>=q.date_debut);
    if(q.date_fin) list=list.filter(j=>j.date<=q.date_fin);
    // Enrichir avec immat
    list=list.slice(-200).reverse().map(j=>{
      const v=db.vehicules.find(x=>x.id===j.vehicule_id);
      return{...j,vehicule:v?v.immatriculation+' · '+v.marque:'Tous véhicules'};
    });
    return res.end(JSON.stringify(list));
  }
  if(p==='/api/journal'&&method==='POST'){
    if(!isManager&&!isGest){res.writeHead(403);return res.end(JSON.stringify({detail:'Refusé — lecture seule'}));}
    if(isGest&&!auth.gest.vehicules_ids.includes(data.vehicule_id)){
      res.writeHead(403);return res.end(JSON.stringify({detail:'Véhicule non assigné'}));
    }
    if(!db.journal) db.journal=[];
    const j={id:uid(),vehicule_id:data.vehicule_id,
              note:data.note||data.texte||'',
              categorie:data.categorie||data.type||'info',
              date:data.date||today(),
              auteur:isGest?auth.gest.nom:'Manager',role:auth.role,
              created_at:new Date().toISOString()};
    db.journal.push(j);saveDB(db);
    return res.end(JSON.stringify({id:j.id,message:'Note publiée'}));
  }
  const jM=p.match(/^\/api\/journal\/([^/]+)$/);
  if(jM&&method==='DELETE'){
    if(!isManager&&!isGest){res.writeHead(403);return res.end(JSON.stringify({detail:'Refusé'}));}
    if(!db.journal) db.journal=[];
    const j=db.journal.find(x=>x.id===jM[1]);
    if(j&&isGest&&j.auteur!==auth.gest.nom){res.writeHead(403);return res.end(JSON.stringify({detail:'Vous ne pouvez supprimer que vos propres notes'}));}
    db.journal=db.journal.filter(x=>x.id!==jM[1]);saveDB(db);
    return res.end(JSON.stringify({message:'Note supprimée'}));
  }

  // ── HISTORIQUE ────────────────────────────────────────────
  if(p==='/api/historique'&&method==='GET'){
    if(!isManager&&!isGest){res.writeHead(403);return res.end(JSON.stringify({detail:'Refusé'}));}
    let list=db.historique||[];
    // Gestionnaire voit seulement son historique
    if(isGest) list=list.filter(h=>h.auteur===auth.gest.nom||h.role==='gestionnaire');
    if(q.limit) list=list.slice(-parseInt(q.limit));
    return res.end(JSON.stringify(list.slice(-100).reverse()));
  }

  res.writeHead(404);res.end(JSON.stringify({detail:'Route introuvable'}));
}

const server=http.createServer((req,res)=>{
  cors(res);
  if(req.method==='OPTIONS'){res.writeHead(204);res.end();return;}
  if(req.url.startsWith('/api/')){let body='';req.on('data',c=>body+=c);req.on('end',()=>handleAPI(req,res,body));return;}
  if(req.url==='/'||req.url.startsWith('/index')){res.setHeader('Content-Type','text/html; charset=utf-8');res.end(fs.readFileSync(path.join(__dirname,'index.html'),'utf8'));return;}
  res.writeHead(404);res.end('Not found');
});
server.listen(PORT,()=>console.log('\n  SyNdongo v9 — port '+PORT+'\n  DB: '+DB_FILE+'\n'));
