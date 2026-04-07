const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

const DB_FILE = process.env.DATA_PATH || './syndongo_data.json';
const PORT = process.env.PORT || 8000;
const MANAGER_PASSWORD = process.env.MANAGER_PASSWORD || 'ndongo2026';

function loadDB() {
  if (!fs.existsSync(DB_FILE)) {
    const dir = path.dirname(DB_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(DB_FILE, JSON.stringify({
      vehicules: [], chauffeurs: [], affectations: [],
      versements: [], depenses: [], alertes: [], activites: [],
      facturations: [], tags: ['Groupe A','Groupe B','Zone Nord','Zone Sud'],
      proprietaires: []
    }, null, 2));
  }
  const db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  ['activites','facturations','tags','proprietaires','versements','depenses','alertes']
    .forEach(k => { if (!db[k]) db[k] = []; });
  if (!db.tags.length) db.tags = ['Groupe A','Groupe B'];
  return db;
}

function saveDB(db) {
  const dir = path.dirname(DB_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2,6);
const today = () => new Date().toISOString().split('T')[0];

function getRole(req) {
  const parsed = url.parse(req.url, true);
  const token = parsed.query.token || req.headers['x-token'] || '';
  if (token === MANAGER_PASSWORD) return { role: 'manager' };
  const db = loadDB();
  const proprio = db.proprietaires.find(p => p.password === token);
  if (proprio) return { role: 'proprietaire', proprio };
  return { role: 'public' };
}

function cors(res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,X-Token');
}

function handleAPI(req, res, body) {
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
  const isProprio = auth.role === 'proprietaire';

  // ── AUTH ──────────────────────────────────────────────────
  if (p === '/api/auth' && method === 'POST') {
    if (data.password === MANAGER_PASSWORD)
      return res.end(JSON.stringify({ role:'manager', token:data.password, nom:'Manager' }));
    const pr = db.proprietaires.find(x => x.password === data.password);
    if (pr) return res.end(JSON.stringify({ role:'proprietaire', token:data.password, nom:pr.nom, proprio_id:pr.id }));
    res.writeHead(401); return res.end(JSON.stringify({ detail:'Mot de passe incorrect' }));
  }

  // ── DASHBOARD ─────────────────────────────────────────────
  if (p === '/api/dashboard' && method === 'GET') {
    let vehs = db.vehicules;
    if (isProprio) vehs = vehs.filter(v => auth.proprio.vehicules_ids.includes(v.id));
    const vIds = vehs.map(v => v.id);
    const affIds = db.affectations.filter(a => vIds.includes(a.vehicule_id)).map(a => a.id);
    const totalRec = db.versements.filter(v => affIds.includes(v.affectation_id)).reduce((s,v)=>s+v.montant,0);
    const totalDep = db.depenses.filter(d => vIds.includes(d.vehicule_id)).reduce((s,d)=>s+d.montant,0);
    const totalFac = db.facturations.filter(f => vIds.includes(f.vehicule_id)).reduce((s,f)=>s+f.montant_facture,0);
    const retard = Math.max(0, totalFac > 0 ? totalFac - totalRec : 0);
    const tj = today();
    const stats = { actif:0, panne:0, repos:0, inactif:0, non_saisi:0 };
    vehs.forEach(v => {
      const act = db.activites.find(a => a.vehicule_id===v.id && a.date===tj);
      if (act) stats[act.statut_jour] = (stats[act.statut_jour]||0)+1;
      else stats.non_saisi++;
    });
    const alertes = [];
    vehs.forEach(v => {
      if (v.km_prochain_vidange && v.km_actuel >= v.km_prochain_vidange*0.95)
        alertes.push({ type:'warn', message:`Vidange due — ${v.immatriculation} (${(v.km_actuel||0).toLocaleString()} km)` });
    });
    db.facturations.filter(f => vIds.includes(f.vehicule_id)).forEach(f => {
      const affT = db.affectations.filter(a => a.vehicule_id===f.vehicule_id).map(a=>a.id);
      const verse = db.versements.filter(v => affT.includes(v.affectation_id)).reduce((s,v)=>s+v.montant,0);
      if (f.montant_facture - verse > 0) {
        const v = db.vehicules.find(x=>x.id===f.vehicule_id);
        const c = db.chauffeurs.find(x=>x.id===f.chauffeur_id);
        alertes.push({ type:'danger', message:`Retard — ${v?v.immatriculation:'?'} / ${c?c.prenom+' '+c.nom:'?'}` });
      }
    });
    return res.end(JSON.stringify({ kpis:{ recettes:totalRec, depenses:totalDep, marge:totalRec-totalDep, taux_marge:totalRec>0?Math.round((totalRec-totalDep)/totalRec*1000)/10:0, vehicules_total:vehs.length, retard_total:retard }, stats_jour:stats, alertes, role:auth.role }));
  }

  // ── TAGS ──────────────────────────────────────────────────
  if (p==='/api/tags' && method==='GET') return res.end(JSON.stringify(db.tags));
  if (p==='/api/tags' && method==='POST') {
    if(!isManager){res.writeHead(403);return res.end(JSON.stringify({detail:'Refusé'}));}
    if(data.tag&&!db.tags.includes(data.tag)){db.tags.push(data.tag);saveDB(db);}
    return res.end(JSON.stringify(db.tags));
  }
  if (p==='/api/tags' && method==='DELETE') {
    if(!isManager){res.writeHead(403);return res.end(JSON.stringify({detail:'Refusé'}));}
    db.tags=db.tags.filter(t=>t!==data.tag);saveDB(db);return res.end(JSON.stringify(db.tags));
  }

  // ── VEHICULES ─────────────────────────────────────────────
  if (p==='/api/vehicules' && method==='GET') {
    let list = db.vehicules;
    if (isProprio) list = list.filter(v=>auth.proprio.vehicules_ids.includes(v.id));
    if (q.q) { const sq=q.q.toLowerCase(); list=list.filter(v=>(v.immatriculation||'').toLowerCase().includes(sq)||(v.marque||'').toLowerCase().includes(sq)||(v.tag||'').toLowerCase().includes(sq)); }
    if (q.tag) list = list.filter(v=>v.tag===q.tag);
    const tj=today();
    list = list.map(v => {
      const act = db.activites.find(a=>a.vehicule_id===v.id&&a.date===tj);
      return {...v, statut_jour:act?act.statut_jour:'non_saisi', alerte_vidange:!!(v.km_prochain_vidange&&v.km_actuel>=v.km_prochain_vidange*0.95)};
    });
    return res.end(JSON.stringify(list));
  }
  if (p==='/api/vehicules' && method==='POST') {
    if(!isManager){res.writeHead(403);return res.end(JSON.stringify({detail:'Refusé'}));}
    const immat=(data.immatriculation||'').toUpperCase().trim();
    if(db.vehicules.find(v=>v.immatriculation===immat)) return res.end(JSON.stringify({detail:`Immatriculation ${immat} déjà enregistrée`}));
    const v={id:uid(),...data,immatriculation:immat,tag:data.tag||''};
    db.vehicules.push(v);
    if(data.proprio_id){const pr=db.proprietaires.find(x=>x.id===data.proprio_id);if(pr&&!pr.vehicules_ids.includes(v.id))pr.vehicules_ids.push(v.id);}
    saveDB(db);return res.end(JSON.stringify({id:v.id,message:'Véhicule créé'}));
  }
  const vM = p.match(/^\/api\/vehicules\/([^/]+)$/);
  if (vM && method==='PATCH') {
    if(!isManager){res.writeHead(403);return res.end(JSON.stringify({detail:'Refusé'}));}
    const idx=db.vehicules.findIndex(v=>v.id===vM[1]);
    if(idx!==-1){
      db.vehicules[idx]={...db.vehicules[idx],...data};
      if(data.proprio_id!==undefined){
        db.proprietaires.forEach(pr=>{pr.vehicules_ids=pr.vehicules_ids.filter(id=>id!==vM[1]);});
        if(data.proprio_id){const pr=db.proprietaires.find(x=>x.id===data.proprio_id);if(pr)pr.vehicules_ids.push(vM[1]);}
      }
      saveDB(db);
    }
    return res.end(JSON.stringify({message:'Mis à jour'}));
  }
  if (vM && method==='DELETE') {
    if(!isManager){res.writeHead(403);return res.end(JSON.stringify({detail:'Refusé'}));}
    if(db.affectations.find(a=>a.vehicule_id===vM[1]&&!a.date_fin)) return res.end(JSON.stringify({detail:'Impossible : chauffeur affecté'}));
    db.vehicules=db.vehicules.filter(v=>v.id!==vM[1]);
    db.proprietaires.forEach(pr=>{pr.vehicules_ids=pr.vehicules_ids.filter(id=>id!==vM[1]);});
    saveDB(db);return res.end(JSON.stringify({message:'Supprimé'}));
  }

  // ── FICHE VEHICULE ────────────────────────────────────────
  const vFiche = p.match(/^\/api\/vehicules\/([^/]+)\/fiche$/);
  if (vFiche && method==='GET') {
    const v = db.vehicules.find(x=>x.id===vFiche[1]);
    if (!v) { res.writeHead(404); return res.end(JSON.stringify({detail:'Introuvable'})); }
    if (isProprio && !auth.proprio.vehicules_ids.includes(v.id)) { res.writeHead(403); return res.end(JSON.stringify({detail:'Refusé'})); }
    const affActive = db.affectations.find(a=>a.vehicule_id===v.id&&!a.date_fin);
    const chauffeur = affActive ? db.chauffeurs.find(c=>c.id===affActive.chauffeur_id) : null;
    const affIds = db.affectations.filter(a=>a.vehicule_id===v.id).map(a=>a.id);
    const versements = db.versements.filter(vs=>affIds.includes(vs.affectation_id));
    const depenses = db.depenses.filter(d=>d.vehicule_id===v.id);
    const facturations = db.facturations.filter(f=>f.vehicule_id===v.id);
    const total_facture = facturations.reduce((s,f)=>s+f.montant_facture,0);
    const total_verse = versements.reduce((s,vs)=>s+vs.montant,0);
    const total_depenses = depenses.reduce((s,d)=>s+d.montant,0);
    // Historique 30 derniers jours
    const historique = [];
    for (let i=0;i<30;i++) {
      const d = new Date(); d.setDate(d.getDate()-i);
      const dateStr = d.toISOString().split('T')[0];
      const act = db.activites.find(a=>a.vehicule_id===v.id&&a.date===dateStr);
      const fac = db.facturations.find(f=>f.vehicule_id===v.id&&f.date===dateStr);
      const vers = versements.filter(vs=>vs.date_versement===dateStr);
      historique.push({ date:dateStr, statut:act?act.statut_jour:'non_saisi', montant_facture:fac?fac.montant_facture:0, montant_verse:vers.reduce((s,v)=>s+v.montant,0) });
    }
    return res.end(JSON.stringify({ vehicule:v, chauffeur, affectation:affActive, versements:versements.slice(-20).reverse(), depenses:depenses.slice(-20).reverse(), total_facture, total_verse, total_depenses, recette_nette:total_verse-total_depenses, manquant:Math.max(0,total_facture-total_verse), historique }));
  }

  // ── ACTIVITES ─────────────────────────────────────────────
  if (p==='/api/activites' && method==='POST') {
    const statut_jour = data.statut_jour || 'actif';
    const existing = db.activites.findIndex(a=>a.vehicule_id===data.vehicule_id&&a.date===today());
    const entry = { id:existing!==-1?db.activites[existing].id:uid(), vehicule_id:data.vehicule_id, date:today(), statut_jour };
    if (existing!==-1) db.activites[existing]=entry; else db.activites.push(entry);
    saveDB(db); return res.end(JSON.stringify({message:'Statut enregistré',statut_jour}));
  }
  if (p==='/api/activites/stats' && method==='GET') {
    const nb = parseInt(q.jours||'30');
    const depuis = new Date(); depuis.setDate(depuis.getDate()-nb);
    const stats = {actif:0,panne:0,repos:0,inactif:0};
    const pannesVeh = {};
    db.activites.filter(a=>new Date(a.date)>=depuis).forEach(a=>{
      stats[a.statut_jour]=(stats[a.statut_jour]||0)+1;
      if(a.statut_jour==='panne'){pannesVeh[a.vehicule_id]=(pannesVeh[a.vehicule_id]||0)+1;}
    });
    return res.end(JSON.stringify({stats,pannes_par_vehicule:pannesVeh,nb_jours:nb}));
  }

  // ── CHAUFFEURS ────────────────────────────────────────────
  if (p==='/api/chauffeurs' && method==='GET') {
    let list = db.chauffeurs.filter(c=>c.statut==='actif');
    if (isProprio) {
      const affVeh = db.affectations.filter(a=>auth.proprio.vehicules_ids.includes(a.vehicule_id)&&!a.date_fin).map(a=>a.chauffeur_id);
      list = list.filter(c=>affVeh.includes(c.id));
    }
    if (q.q) { const sq=q.q.toLowerCase(); list=list.filter(c=>(c.prenom||'').toLowerCase().includes(sq)||(c.nom||'').toLowerCase().includes(sq)||(c.telephone||'').includes(sq)); }
    // Enrichir avec véhicule actuel
    list = list.map(c => {
      const aff = db.affectations.find(a=>a.chauffeur_id===c.id&&!a.date_fin);
      const veh = aff ? db.vehicules.find(v=>v.id===aff.vehicule_id) : null;
      return {...c, vehicule_actuel:veh?veh.immatriculation+' · '+veh.marque:null, affectation_active:!!aff};
    });
    return res.end(JSON.stringify(list));
  }
  if (p==='/api/chauffeurs' && method==='POST') {
    if(!isManager){res.writeHead(403);return res.end(JSON.stringify({detail:'Refusé'}));}
    if(db.chauffeurs.find(c=>c.telephone===(data.telephone||'').trim())) return res.end(JSON.stringify({detail:'Numéro de téléphone déjà enregistré'}));
    if(data.numero_permis&&db.chauffeurs.find(c=>c.numero_permis===(data.numero_permis||'').trim())) return res.end(JSON.stringify({detail:'Numéro de permis déjà enregistré'}));
    const c={id:uid(),...data,telephone:(data.telephone||'').trim(),statut:'actif',date_embauche:today()};
    db.chauffeurs.push(c);saveDB(db);return res.end(JSON.stringify({id:c.id,message:'Chauffeur enregistré'}));
  }
  const cM = p.match(/^\/api\/chauffeurs\/([^/]+)$/);
  if (cM && method==='DELETE') {
    if(!isManager){res.writeHead(403);return res.end(JSON.stringify({detail:'Refusé'}));}
    const idx=db.chauffeurs.findIndex(c=>c.id===cM[1]);
    if(idx!==-1){db.chauffeurs[idx].statut='depart';saveDB(db);}
    return res.end(JSON.stringify({message:'Chauffeur marqué comme parti'}));
  }
  if (cM && method==='PATCH') {
    if(!isManager){res.writeHead(403);return res.end(JSON.stringify({detail:'Refusé'}));}
    const idx=db.chauffeurs.findIndex(c=>c.id===cM[1]);
    if(idx!==-1){
      if(data.telephone&&data.telephone!==db.chauffeurs[idx].telephone&&db.chauffeurs.find((c,i)=>i!==idx&&c.telephone===data.telephone)) return res.end(JSON.stringify({detail:'Téléphone déjà utilisé'}));
      db.chauffeurs[idx]={...db.chauffeurs[idx],...data};saveDB(db);
    }
    return res.end(JSON.stringify({message:'Mis à jour'}));
  }

  // ── FICHE CHAUFFEUR ───────────────────────────────────────
  const cFiche = p.match(/^\/api\/chauffeurs\/([^/]+)\/fiche$/);
  if (cFiche && method==='GET') {
    const c = db.chauffeurs.find(x=>x.id===cFiche[1]);
    if (!c) { res.writeHead(404); return res.end(JSON.stringify({detail:'Introuvable'})); }
    const affActive = db.affectations.find(a=>a.chauffeur_id===c.id&&!a.date_fin);
    const vehicule = affActive ? db.vehicules.find(v=>v.id===affActive.vehicule_id) : null;
    if (isProprio&&vehicule&&!auth.proprio.vehicules_ids.includes(vehicule.id)) { res.writeHead(403); return res.end(JSON.stringify({detail:'Refusé'})); }
    const affIds = db.affectations.filter(a=>a.chauffeur_id===c.id).map(a=>a.id);
    const versements = db.versements.filter(vs=>affIds.includes(vs.affectation_id));
    const depenses = db.depenses.filter(d=>d.chauffeur_id===c.id);
    const facturations = db.facturations.filter(f=>f.chauffeur_id===c.id);
    const total_facture = facturations.reduce((s,f)=>s+f.montant_facture,0);
    const total_verse = versements.reduce((s,vs)=>s+vs.montant,0);
    const total_depenses = depenses.reduce((s,d)=>s+d.montant,0);
    return res.end(JSON.stringify({ chauffeur:c, vehicule, affectation:affActive, versements:versements.slice(-20).reverse(), total_facture, total_verse, total_depenses, recette_nette:total_verse-total_depenses, manquant:Math.max(0,total_facture-total_verse) }));
  }

  // ── AFFECTATIONS ──────────────────────────────────────────
  if (p==='/api/affectations' && method==='GET') {
    let list = db.affectations.filter(a=>!a.date_fin);
    if (isProprio) list = list.filter(a=>auth.proprio.vehicules_ids.includes(a.vehicule_id));
    return res.end(JSON.stringify(list.map(a=>{
      const v=db.vehicules.find(x=>x.id===a.vehicule_id);
      const c=db.chauffeurs.find(x=>x.id===a.chauffeur_id);
      return{...a,vehicule:v?v.immatriculation+' · '+v.marque:'?',chauffeur:c?c.prenom+' '+c.nom:'?',vehicule_id:a.vehicule_id,chauffeur_id:a.chauffeur_id};
    })));
  }
  if (p==='/api/affectations' && method==='POST') {
    if(!isManager){res.writeHead(403);return res.end(JSON.stringify({detail:'Refusé'}));}
    if(db.affectations.find(a=>a.vehicule_id===data.vehicule_id&&!a.date_fin)) return res.end(JSON.stringify({detail:'Ce véhicule a déjà un chauffeur'}));
    if(db.affectations.find(a=>a.chauffeur_id===data.chauffeur_id&&!a.date_fin)) return res.end(JSON.stringify({detail:'Ce chauffeur est déjà affecté'}));
    const a={id:uid(),...data,date_fin:null};db.affectations.push(a);saveDB(db);
    return res.end(JSON.stringify({id:a.id,message:'Affectation créée'}));
  }
  const aM = p.match(/^\/api\/affectations\/([^/]+)\/cloturer$/);
  if (aM && method==='PATCH') {
    if(!isManager){res.writeHead(403);return res.end(JSON.stringify({detail:'Refusé'}));}
    const idx=db.affectations.findIndex(a=>a.id===aM[1]);
    if(idx!==-1){db.affectations[idx].date_fin=today();saveDB(db);}
    return res.end(JSON.stringify({message:'Clôturée'}));
  }

  // ── VERSEMENTS ────────────────────────────────────────────
  if (p==='/api/versements' && method==='GET') {
    let list = db.versements;
    if (isProprio) {
      const affIds=db.affectations.filter(a=>auth.proprio.vehicules_ids.includes(a.vehicule_id)).map(a=>a.id);
      list=list.filter(v=>affIds.includes(v.affectation_id));
    }
    return res.end(JSON.stringify(list.slice(-300).reverse().map(v=>{
      const aff=db.affectations.find(a=>a.id===v.affectation_id);
      const c=aff?db.chauffeurs.find(x=>x.id===aff.chauffeur_id):null;
      const veh=aff?db.vehicules.find(x=>x.id===aff.vehicule_id):null;
      return{...v,chauffeur:c?c.prenom+' '+c.nom:'?',vehicule:veh?veh.immatriculation:'?'};
    })));
  }
  if (p==='/api/versements' && method==='POST') {
    if(!isManager){res.writeHead(403);return res.end(JSON.stringify({detail:'Refusé'}));}
    const aff=db.affectations.find(a=>a.id===data.affectation_id);
    if(!aff) return res.end(JSON.stringify({detail:'Affectation introuvable'}));
    const attendu=aff.montant_journalier,montant=Number(data.montant);
    const statut=montant>=attendu?'recu':montant>0?'partiel':'en_retard';
    const v={id:uid(),...data,montant,montant_attendu:attendu,statut,created_at:new Date().toISOString()};
    db.versements.push(v);saveDB(db);
    return res.end(JSON.stringify({id:v.id,statut,ecart:attendu-montant,message:'Versement enregistré'}));
  }
  const vsM = p.match(/^\/api\/versements\/([^/]+)$/);
  if (vsM && method==='DELETE') {
    if(!isManager){res.writeHead(403);return res.end(JSON.stringify({detail:'Refusé'}));}
    db.versements=db.versements.filter(v=>v.id!==vsM[1]);saveDB(db);return res.end(JSON.stringify({message:'Supprimé'}));
  }
  if (vsM && method==='PATCH') {
    if(!isManager){res.writeHead(403);return res.end(JSON.stringify({detail:'Refusé'}));}
    const idx=db.versements.findIndex(v=>v.id===vsM[1]);
    if(idx!==-1){const at=db.versements[idx].montant_attendu;const m=data.montant!==undefined?Number(data.montant):db.versements[idx].montant;const s=m>=at?'recu':m>0?'partiel':'en_retard';db.versements[idx]={...db.versements[idx],...data,montant:m,statut:s};saveDB(db);}
    return res.end(JSON.stringify({message:'Mis à jour'}));
  }

  // ── DEPENSES ──────────────────────────────────────────────
  if (p==='/api/depenses' && method==='GET') {
    let list=db.depenses;
    if(isProprio) list=list.filter(d=>auth.proprio.vehicules_ids.includes(d.vehicule_id));
    return res.end(JSON.stringify(list.slice(-300).reverse()));
  }
  if (p==='/api/depenses' && method==='POST') {
    if(!isManager){res.writeHead(403);return res.end(JSON.stringify({detail:'Refusé'}));}
    const d={id:uid(),...data,montant:Number(data.montant),date_depense:today(),created_at:new Date().toISOString()};
    db.depenses.push(d);saveDB(db);return res.end(JSON.stringify({id:d.id,message:'Dépense enregistrée'}));
  }
  const dM = p.match(/^\/api\/depenses\/([^/]+)$/);
  if (dM && method==='DELETE') {
    if(!isManager){res.writeHead(403);return res.end(JSON.stringify({detail:'Refusé'}));}
    db.depenses=db.depenses.filter(d=>d.id!==dM[1]);saveDB(db);return res.end(JSON.stringify({message:'Supprimé'}));
  }
  if (dM && method==='PATCH') {
    if(!isManager){res.writeHead(403);return res.end(JSON.stringify({detail:'Refusé'}));}
    const idx=db.depenses.findIndex(d=>d.id===dM[1]);
    if(idx!==-1){db.depenses[idx]={...db.depenses[idx],...data};saveDB(db);}
    return res.end(JSON.stringify({message:'Mis à jour'}));
  }

  // ── FACTURATIONS ──────────────────────────────────────────
  if (p==='/api/facturations' && method==='GET') {
    let list=db.facturations;
    if(isProprio) list=list.filter(f=>auth.proprio.vehicules_ids.includes(f.vehicule_id));
    if(q.vehicule_id) list=list.filter(f=>f.vehicule_id===q.vehicule_id);
    if(q.chauffeur_id) list=list.filter(f=>f.chauffeur_id===q.chauffeur_id);
    return res.end(JSON.stringify(list.slice(-300).reverse().map(f=>{
      const v=db.vehicules.find(x=>x.id===f.vehicule_id);
      const c=db.chauffeurs.find(x=>x.id===f.chauffeur_id);
      return{...f,vehicule:v?v.immatriculation:'?',chauffeur:c?c.prenom+' '+c.nom:'?'};
    })));
  }
  if (p==='/api/facturations' && method==='POST') {
    const existing=db.facturations.findIndex(f=>f.vehicule_id===data.vehicule_id&&f.date===data.date);
    if(existing!==-1){db.facturations[existing]={...db.facturations[existing],...data,updated_at:new Date().toISOString()};saveDB(db);return res.end(JSON.stringify({message:'Facturation mise à jour',id:db.facturations[existing].id}));}
    const f={id:uid(),...data,created_at:new Date().toISOString()};
    db.facturations.push(f);saveDB(db);return res.end(JSON.stringify({id:f.id,message:'Facturation enregistrée'}));
  }

  // ── ENCAISSEMENT FIFO / MANUEL ────────────────────────────
  if (p==='/api/encaissements' && method==='POST') {
    if(!isManager){res.writeHead(403);return res.end(JSON.stringify({detail:'Refusé'}));}
    const {chauffeur_id,montant_recu,mode_paiement,date_encaissement,mode_imputation} = data;
    const aff_active=db.affectations.find(a=>a.chauffeur_id===chauffeur_id&&!a.date_fin);
    if(!aff_active) return res.end(JSON.stringify({detail:'Aucune affectation active'}));
    const montant=Number(montant_recu);
    const affIds=db.affectations.filter(a=>a.chauffeur_id===chauffeur_id).map(a=>a.id);
    const total_verse=db.versements.filter(v=>affIds.includes(v.affectation_id)).reduce((s,v)=>s+v.montant,0);
    const total_facture=db.facturations.filter(f=>f.chauffeur_id===chauffeur_id).reduce((s,f)=>s+f.montant_facture,0);
    const dette=Math.max(0,total_facture-total_verse);
    // Créer le versement
    const statut=montant>=aff_active.montant_journalier?'recu':montant>0?'partiel':'en_retard';
    const v={id:uid(),affectation_id:aff_active.id,montant,montant_attendu:aff_active.montant_journalier,statut,mode_paiement:mode_paiement||'especes',date_versement:date_encaissement||today(),created_at:new Date().toISOString()};
    db.versements.push(v);saveDB(db);
    // Calcul FIFO pour affichage
    let repartition=[];
    if(mode_imputation!=='manuel'){
      const facs=db.facturations.filter(f=>f.chauffeur_id===chauffeur_id&&f.montant_facture>0).sort((a,b)=>new Date(a.date)-new Date(b.date));
      let reste=montant;
      for(const f of facs){if(reste<=0)break;const imp=Math.min(reste,f.montant_facture);repartition.push({date:f.date,type:f.type_journee,montant_facture:f.montant_facture,impute:imp});reste-=imp;}
    }
    return res.end(JSON.stringify({message:'Encaissement enregistré',versement_id:v.id,dette_avant:dette,dette_apres:Math.max(0,dette-montant),repartition}));
  }

  // ── RETARDS ───────────────────────────────────────────────
  if (p==='/api/retards' && method==='GET') {
    let vehs=db.vehicules;
    if(isProprio) vehs=vehs.filter(v=>auth.proprio.vehicules_ids.includes(v.id));
    const retards=vehs.map(v=>{
      const affs=db.affectations.filter(a=>a.vehicule_id===v.id);
      const affIds=affs.map(a=>a.id);
      const aff_active=affs.find(a=>!a.date_fin);
      const chauffeur=aff_active?db.chauffeurs.find(c=>c.id===aff_active.chauffeur_id):null;
      const total_facture=db.facturations.filter(f=>f.vehicule_id===v.id).reduce((s,f)=>s+f.montant_facture,0);
      const total_verse=db.versements.filter(vs=>affIds.includes(vs.affectation_id)).reduce((s,vs)=>s+vs.montant,0);
      const retard=Math.max(0,total_facture>0?total_facture-total_verse:0);
      return{vehicule_id:v.id,immatriculation:v.immatriculation,marque:v.marque,tag:v.tag||'',chauffeur:chauffeur?chauffeur.prenom+' '+chauffeur.nom:'Non affecté',chauffeur_id:chauffeur?chauffeur.id:null,total_facture,total_verse,retard};
    }).filter(r=>r.retard>0).sort((a,b)=>b.retard-a.retard);
    return res.end(JSON.stringify(retards));
  }

  // ── RAPPORT PDF ───────────────────────────────────────────
  if (p==='/api/rapport' && method==='GET') {
    let vehs=db.vehicules;
    if(isProprio) vehs=vehs.filter(v=>auth.proprio.vehicules_ids.includes(v.id));
    return res.end(JSON.stringify(vehs.map(v=>{
      const affs=db.affectations.filter(a=>a.vehicule_id===v.id);
      const affIds=affs.map(a=>a.id);
      const aff=affs.find(a=>!a.date_fin);
      const c=aff?db.chauffeurs.find(x=>x.id===aff.chauffeur_id):null;
      const vers=db.versements.filter(vs=>affIds.includes(vs.affectation_id));
      const deps=db.depenses.filter(d=>d.vehicule_id===v.id);
      const facs=db.facturations.filter(f=>f.vehicule_id===v.id);
      return{immatriculation:v.immatriculation,marque:v.marque+' '+(v.modele||''),tag:v.tag||'',chauffeur:c?c.prenom+' '+c.nom:'Non affecté',recettes:vers.reduce((s,vs)=>s+vs.montant,0),depenses:deps.reduce((s,d)=>s+d.montant,0),facture:facs.reduce((s,f)=>s+f.montant_facture,0),nb_versements:vers.length};
    })));
  }

  // ── ALERTES ───────────────────────────────────────────────
  if (p==='/api/alertes' && method==='GET') return res.end(JSON.stringify(db.alertes.slice(-50).reverse()));
  if (p==='/api/alertes' && method==='POST') {
    const msgs={versement_retard:'SyNdongo — Versement en retard.',document_expiration:'SyNdongo — Document expirant.',vidange_due:'SyNdongo — Vidange due.',panne:'SyNdongo — Panne déclarée.'};
    const al={id:uid(),...data,message:data.message||msgs[data.type_alerte]||'Message SyNdongo',statut:'simule',created_at:new Date().toISOString()};
    db.alertes.push(al);saveDB(db);return res.end(JSON.stringify({id:al.id,statut:'simule',message:al.message}));
  }

  // ── PROPRIETAIRES ─────────────────────────────────────────
  if (p==='/api/proprietaires' && method==='GET') {
    if(!isManager){res.writeHead(403);return res.end(JSON.stringify({detail:'Refusé'}));}
    return res.end(JSON.stringify(db.proprietaires));
  }
  if (p==='/api/proprietaires' && method==='POST') {
    if(!isManager){res.writeHead(403);return res.end(JSON.stringify({detail:'Refusé'}));}
    if(db.proprietaires.find(x=>x.email===data.email&&data.email)) return res.end(JSON.stringify({detail:'Email déjà enregistré'}));
    const pr={id:uid(),nom:data.nom,email:data.email||'',telephone:data.telephone||'',password:data.password||uid().slice(0,8),vehicules_ids:[]};
    db.proprietaires.push(pr);saveDB(db);return res.end(JSON.stringify({id:pr.id,password:pr.password,message:'Propriétaire créé'}));
  }
  const prM = p.match(/^\/api\/proprietaires\/([^/]+)$/);
  if (prM && method==='PATCH') {
    if(!isManager){res.writeHead(403);return res.end(JSON.stringify({detail:'Refusé'}));}
    const idx=db.proprietaires.findIndex(pr=>pr.id===prM[1]);
    if(idx!==-1){db.proprietaires[idx]={...db.proprietaires[idx],...data};saveDB(db);}
    return res.end(JSON.stringify({message:'Mis à jour'}));
  }
  if (prM && method==='DELETE') {
    if(!isManager){res.writeHead(403);return res.end(JSON.stringify({detail:'Refusé'}));}
    db.proprietaires=db.proprietaires.filter(pr=>pr.id!==prM[1]);saveDB(db);
    return res.end(JSON.stringify({message:'Supprimé'}));
  }

  res.writeHead(404); res.end(JSON.stringify({detail:'Route introuvable'}));
}

const server = http.createServer((req, res) => {
  cors(res);
  if (req.method==='OPTIONS'){res.writeHead(204);res.end();return;}
  if (req.url.startsWith('/api/')){let body='';req.on('data',c=>body+=c);req.on('end',()=>handleAPI(req,res,body));return;}
  if (req.url==='/'||req.url.startsWith('/index')){
    res.setHeader('Content-Type','text/html; charset=utf-8');
    res.end(fs.readFileSync(path.join(__dirname,'index.html'),'utf8'));return;
  }
  res.writeHead(404);res.end('Not found');
});

server.listen(PORT,()=>console.log('\n  SyNdongo v8 — port '+PORT+'\n  Manager: '+MANAGER_PASSWORD+'\n  DB: '+DB_FILE+'\n'));
