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
      vehicules:[], chauffeurs:[], affectations:[],
      versements:[], depenses:[], alertes:[], activites:[],
      facturations:[], tags:[], proprietaires:[], gestionnaires:[]
    }, null, 2));
  }
  const db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  ['activites','facturations','tags','proprietaires','versements',
   'depenses','alertes','gestionnaires'].forEach(k=>{ if(!db[k]) db[k]=[]; });
  return db;
}

function saveDB(db) {
  const dir = path.dirname(DB_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(DB_FILE, JSON.stringify(db));
}

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2,6);
const today = () => new Date().toISOString().split('T')[0];

function getRole(req) {
  const parsed = url.parse(req.url, true);
  const token = parsed.query.token || req.headers['x-token'] || '';
  if (token === MANAGER_PASSWORD) return { role:'manager' };
  const db = loadDB();
  const proprio = db.proprietaires.find(p => p.password === token);
  if (proprio) return { role:'proprietaire', proprio };
  const gest = db.gestionnaires.find(g => g.password === token);
  if (gest) return { role:'gestionnaire', gest };
  return { role:'public' };
}

function cors(res) {
  res.setHeader('Content-Type','application/json');
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','GET,POST,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type,X-Token');
}

// Véhicules visibles selon rôle
function vehsVisibles(db, auth) {
  if (auth.role === 'manager') return db.vehicules;
  if (auth.role === 'proprietaire') return db.vehicules.filter(v => auth.proprio.vehicules_ids.includes(v.id));
  if (auth.role === 'gestionnaire') return db.vehicules.filter(v => auth.gest.vehicules_ids.includes(v.id));
  return [];
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
  const isGest = auth.role === 'gestionnaire';
  const isProprio = auth.role === 'proprietaire';
  const canWrite = isManager || isGest;

  // ── AUTH ──────────────────────────────────────────────────
  if (p === '/api/auth' && method === 'POST') {
    if (data.password === MANAGER_PASSWORD)
      return res.end(JSON.stringify({ role:'manager', token:data.password, nom:'Manager' }));
    const pr = db.proprietaires.find(x => x.password === data.password);
    if (pr) return res.end(JSON.stringify({ role:'proprietaire', token:data.password, nom:pr.nom, proprio_id:pr.id }));
    const gt = db.gestionnaires.find(x => x.password === data.password);
    if (gt) return res.end(JSON.stringify({ role:'gestionnaire', token:data.password, nom:gt.nom, gest_id:gt.id }));
    res.writeHead(401); return res.end(JSON.stringify({ detail:'Mot de passe incorrect' }));
  }

  // ── DASHBOARD ─────────────────────────────────────────────
  if (p === '/api/dashboard' && method === 'GET') {
    const vehs = vehsVisibles(db, auth);
    const vIds = vehs.map(v => v.id);
    const affIds = db.affectations.filter(a => vIds.includes(a.vehicule_id)).map(a => a.id);
    const totalRec = db.versements.filter(v => affIds.includes(v.affectation_id)).reduce((s,v)=>s+v.montant,0);
    const totalDep = db.depenses.filter(d => vIds.includes(d.vehicule_id)).reduce((s,d)=>s+d.montant,0);
    const totalFac = db.facturations.filter(f => vIds.includes(f.vehicule_id)).reduce((s,f)=>s+f.montant_facture,0);
    const tj = today();
    const stats = {actif:0,panne:0,repos:0,inactif:0,non_saisi:0};
    vehs.forEach(v => {
      const act = db.activites.find(a => a.vehicule_id===v.id && a.date===tj);
      if (act) stats[act.statut_jour] = (stats[act.statut_jour]||0)+1;
      else stats.non_saisi++;
    });
    // Filtre par période si demandé
    const date_debut = q.date_debut || '';
    const date_fin = q.date_fin || '';
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
    return res.end(JSON.stringify({
      kpis:{recettes:recPeriode,depenses:depPeriode,marge:recPeriode-depPeriode,
            taux_marge:recPeriode>0?Math.round((recPeriode-depPeriode)/recPeriode*1000)/10:0,
            vehicules_total:vehs.length,retard_total:Math.max(0,facPeriode-recPeriode),
            facture_total:facPeriode},
      stats_jour:stats, alertes, role:auth.role,
      periode:{date_debut,date_fin,active:!!(date_debut&&date_fin)}
    }));
  }

  // ── TAGS ──────────────────────────────────────────────────
  if (p==='/api/tags'&&method==='GET') return res.end(JSON.stringify(db.tags));
  if (p==='/api/tags'&&method==='POST') {
    if(!isManager){res.writeHead(403);return res.end(JSON.stringify({detail:'Refusé'}));}
    if(data.tag&&!db.tags.includes(data.tag)){db.tags.push(data.tag);saveDB(db);}
    return res.end(JSON.stringify(db.tags));
  }
  if (p==='/api/tags'&&method==='DELETE') {
    if(!isManager){res.writeHead(403);return res.end(JSON.stringify({detail:'Refusé'}));}
    db.tags=db.tags.filter(t=>t!==data.tag);saveDB(db);return res.end(JSON.stringify(db.tags));
  }

  // ── VEHICULES ─────────────────────────────────────────────
  if (p==='/api/vehicules'&&method==='GET') {
    let list = vehsVisibles(db, auth);
    if(q.q){const sq=q.q.toLowerCase();list=list.filter(v=>(v.immatriculation||'').toLowerCase().includes(sq)||(v.marque||'').toLowerCase().includes(sq)||(v.tag||'').toLowerCase().includes(sq));}
    if(q.tag) list=list.filter(v=>v.tag===q.tag);
    if(q.statut_jour){const tj2=today();list=list.filter(v=>{const act=db.activites.find(a=>a.vehicule_id===v.id&&a.date===tj2);return (act?act.statut_jour:'non_saisi')===q.statut_jour;});}
    const tj=today();
    list=list.map(v=>{
      const act=db.activites.find(a=>a.vehicule_id===v.id&&a.date===tj);
      return{...v,statut_jour:act?act.statut_jour:'non_saisi',alerte_vidange:!!(v.km_prochain_vidange&&v.km_actuel>=v.km_prochain_vidange*0.95)};
    });
    return res.end(JSON.stringify(list));
  }
  if (p==='/api/vehicules'&&method==='POST') {
    if(!isManager){res.writeHead(403);return res.end(JSON.stringify({detail:'Refusé'}));}
    const immat=(data.immatriculation||'').toUpperCase().trim();
    if(db.vehicules.find(v=>v.immatriculation===immat)) return res.end(JSON.stringify({detail:`${immat} déjà enregistré`}));
    const v={id:uid(),...data,immatriculation:immat,tag:data.tag||''};
    db.vehicules.push(v);
    if(data.proprio_id){const pr=db.proprietaires.find(x=>x.id===data.proprio_id);if(pr&&!pr.vehicules_ids.includes(v.id))pr.vehicules_ids.push(v.id);}
    if(data.gest_id){const gt=db.gestionnaires.find(x=>x.id===data.gest_id);if(gt&&!gt.vehicules_ids.includes(v.id))gt.vehicules_ids.push(v.id);}
    saveDB(db);return res.end(JSON.stringify({id:v.id,message:'Véhicule créé'}));
  }
  const vM=p.match(/^\/api\/vehicules\/([^/]+)$/);
  if(vM&&method==='PATCH'){
    if(!isManager){res.writeHead(403);return res.end(JSON.stringify({detail:'Refusé'}));}
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
    if(!isManager){
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
    if(!isManager){res.writeHead(403);return res.end(JSON.stringify({detail:'Refusé'}));}
    if(db.chauffeurs.find(c=>c.telephone===(data.telephone||'').trim())) return res.end(JSON.stringify({detail:'Téléphone déjà enregistré'}));
    if(data.numero_permis&&db.chauffeurs.find(c=>c.numero_permis===(data.numero_permis||'').trim())) return res.end(JSON.stringify({detail:'Permis déjà enregistré'}));
    const c={id:uid(),...data,telephone:(data.telephone||'').trim(),statut:'actif',date_embauche:today()};
    db.chauffeurs.push(c);saveDB(db);return res.end(JSON.stringify({id:c.id,message:'Chauffeur enregistré'}));
  }
  const cM=p.match(/^\/api\/chauffeurs\/([^/]+)$/);
  if(cM&&method==='DELETE'){if(!isManager){res.writeHead(403);return res.end(JSON.stringify({detail:'Refusé'}));}const idx=db.chauffeurs.findIndex(c=>c.id===cM[1]);if(idx!==-1){db.chauffeurs[idx].statut='depart';saveDB(db);}return res.end(JSON.stringify({message:'Chauffeur marqué comme parti'}));}
  if(cM&&method==='PATCH'){if(!isManager){res.writeHead(403);return res.end(JSON.stringify({detail:'Refusé'}));}const idx=db.chauffeurs.findIndex(c=>c.id===cM[1]);if(idx!==-1){if(data.telephone&&data.telephone!==db.chauffeurs[idx].telephone&&db.chauffeurs.find((c,i)=>i!==idx&&c.telephone===data.telephone))return res.end(JSON.stringify({detail:'Téléphone déjà utilisé'}));db.chauffeurs[idx]={...db.chauffeurs[idx],...data};saveDB(db);}return res.end(JSON.stringify({message:'Mis à jour'}));}

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
    if(!isManager){res.writeHead(403);return res.end(JSON.stringify({detail:'Refusé'}));}
    if(db.affectations.find(a=>a.vehicule_id===data.vehicule_id&&!a.date_fin)) return res.end(JSON.stringify({detail:'Ce véhicule a déjà un chauffeur'}));
    if(db.affectations.find(a=>a.chauffeur_id===data.chauffeur_id&&!a.date_fin)) return res.end(JSON.stringify({detail:'Ce chauffeur est déjà affecté'}));
    const a={id:uid(),...data,date_fin:null};db.affectations.push(a);saveDB(db);
    return res.end(JSON.stringify({id:a.id,message:'Affectation créée'}));
  }
  const aM=p.match(/^\/api\/affectations\/([^/]+)\/cloturer$/);
  if(aM&&method==='PATCH'){if(!isManager){res.writeHead(403);return res.end(JSON.stringify({detail:'Refusé'}));}const idx=db.affectations.findIndex(a=>a.id===aM[1]);if(idx!==-1){db.affectations[idx].date_fin=today();saveDB(db);}return res.end(JSON.stringify({message:'Clôturée'}));}

  // ── VERSEMENTS ────────────────────────────────────────────
  if(p==='/api/versements'&&method==='GET'){
    const myVehs=vehsVisibles(db,auth).map(v=>v.id);
    const myAffIds=db.affectations.filter(a=>myVehs.includes(a.vehicule_id)).map(a=>a.id);
    let list=db.versements.filter(v=>myAffIds.includes(v.affectation_id));
    if(q.date_debut&&q.date_fin) list=list.filter(v=>v.date_versement>=q.date_debut&&v.date_versement<=q.date_fin);
    return res.end(JSON.stringify(list.slice(-300).reverse().map(v=>{
      const aff=db.affectations.find(a=>a.id===v.affectation_id);
      const c=aff?db.chauffeurs.find(x=>x.id===aff.chauffeur_id):null;
      const veh=aff?db.vehicules.find(x=>x.id===aff.vehicule_id):null;
      return{...v,chauffeur:c?c.prenom+' '+c.nom:'?',vehicule:veh?veh.immatriculation:'?'};
    })));
  }
  if(p==='/api/versements'&&method==='POST'){
    if(!canWrite){res.writeHead(403);return res.end(JSON.stringify({detail:'Refusé'}));}
    const aff=db.affectations.find(a=>a.id===data.affectation_id);
    if(!aff) return res.end(JSON.stringify({detail:'Affectation introuvable'}));
    if(isGest&&!auth.gest.vehicules_ids.includes(aff.vehicule_id)){res.writeHead(403);return res.end(JSON.stringify({detail:'Véhicule non assigné'}));}
    const attendu=aff.montant_journalier,montant=Number(data.montant);
    const statut=montant>=attendu?'recu':montant>0?'partiel':'en_retard';
    const v={id:uid(),...data,montant,montant_attendu:attendu,statut,created_at:new Date().toISOString()};
    db.versements.push(v);saveDB(db);return res.end(JSON.stringify({id:v.id,statut,ecart:attendu-montant,message:'Versement enregistré'}));
  }
  const vsM=p.match(/^\/api\/versements\/([^/]+)$/);
  if(vsM&&method==='DELETE'){if(!isManager){res.writeHead(403);return res.end(JSON.stringify({detail:'Refusé'}));}db.versements=db.versements.filter(v=>v.id!==vsM[1]);saveDB(db);return res.end(JSON.stringify({message:'Supprimé'}));}
  if(vsM&&method==='PATCH'){if(!canWrite){res.writeHead(403);return res.end(JSON.stringify({detail:'Refusé'}));}const idx=db.versements.findIndex(v=>v.id===vsM[1]);if(idx!==-1){const at=db.versements[idx].montant_attendu;const m=data.montant!==undefined?Number(data.montant):db.versements[idx].montant;const s=m>=at?'recu':m>0?'partiel':'en_retard';db.versements[idx]={...db.versements[idx],...data,montant:m,statut:s};saveDB(db);}return res.end(JSON.stringify({message:'Mis à jour'}));}

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
    const d={id:uid(),...data,montant:Number(data.montant),date_depense:today(),created_at:new Date().toISOString()};
    db.depenses.push(d);saveDB(db);return res.end(JSON.stringify({id:d.id,message:'Dépense enregistrée'}));
  }
  const dM=p.match(/^\/api\/depenses\/([^/]+)$/);
  if(dM&&method==='DELETE'){if(!isManager){res.writeHead(403);return res.end(JSON.stringify({detail:'Refusé'}));}db.depenses=db.depenses.filter(d=>d.id!==dM[1]);saveDB(db);return res.end(JSON.stringify({message:'Supprimé'}));}
  if(dM&&method==='PATCH'){if(!canWrite){res.writeHead(403);return res.end(JSON.stringify({detail:'Refusé'}));}const idx=db.depenses.findIndex(d=>d.id===dM[1]);if(idx!==-1){db.depenses[idx]={...db.depenses[idx],...data};saveDB(db);}return res.end(JSON.stringify({message:'Mis à jour'}));}

  // ── FACTURATIONS ──────────────────────────────────────────
  if(p==='/api/facturations'&&method==='GET'){
    const myVehs=vehsVisibles(db,auth).map(v=>v.id);
    let list=db.facturations.filter(f=>myVehs.includes(f.vehicule_id));
    if(q.vehicule_id) list=list.filter(f=>f.vehicule_id===q.vehicule_id);
    if(q.chauffeur_id) list=list.filter(f=>f.chauffeur_id===q.chauffeur_id);
    if(q.date_debut&&q.date_fin) list=list.filter(f=>f.date>=q.date_debut&&f.date<=q.date_fin);
    return res.end(JSON.stringify(list.slice(-500).reverse().map(f=>{
      const v=db.vehicules.find(x=>x.id===f.vehicule_id);
      const c=db.chauffeurs.find(x=>x.id===f.chauffeur_id);
      return{...f,vehicule:v?v.immatriculation:'?',chauffeur:c?c.prenom+' '+c.nom:'?'};
    })));
  }
  if(p==='/api/facturations'&&method==='POST'){
    if(!canWrite){res.writeHead(403);return res.end(JSON.stringify({detail:'Refusé'}));}
    if(isGest&&!auth.gest.vehicules_ids.includes(data.vehicule_id)){res.writeHead(403);return res.end(JSON.stringify({detail:'Véhicule non assigné'}));}
    const existing=db.facturations.findIndex(f=>f.vehicule_id===data.vehicule_id&&f.date===data.date);
    if(existing!==-1){db.facturations[existing]={...db.facturations[existing],...data,updated_at:new Date().toISOString()};saveDB(db);return res.end(JSON.stringify({message:'Facturation mise à jour',id:db.facturations[existing].id}));}
    const f={id:uid(),...data,created_at:new Date().toISOString()};
    db.facturations.push(f);saveDB(db);return res.end(JSON.stringify({id:f.id,message:'Facturation enregistrée'}));
  }
  // FACTURATION MULTIPLE
  if(p==='/api/facturations/multiple'&&method==='POST'){
    if(!canWrite){res.writeHead(403);return res.end(JSON.stringify({detail:'Refusé'}));}
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
    const{chauffeur_id,montant_recu,mode_paiement,date_encaissement,mode_imputation}=data;
    const aff_active=db.affectations.find(a=>a.chauffeur_id===chauffeur_id&&!a.date_fin);
    if(!aff_active) return res.end(JSON.stringify({detail:'Aucune affectation active'}));
    if(isGest&&!auth.gest.vehicules_ids.includes(aff_active.vehicule_id)){res.writeHead(403);return res.end(JSON.stringify({detail:'Véhicule non assigné'}));}
    const montant=Number(montant_recu);
    const affIds=db.affectations.filter(a=>a.chauffeur_id===chauffeur_id).map(a=>a.id);
    const total_verse=db.versements.filter(v=>affIds.includes(v.affectation_id)).reduce((s,v)=>s+v.montant,0);
    const total_facture=db.facturations.filter(f=>f.chauffeur_id===chauffeur_id).reduce((s,f)=>s+f.montant_facture,0);
    const dette=Math.max(0,total_facture-total_verse);
    const statut=montant>=aff_active.montant_journalier?'recu':montant>0?'partiel':'en_retard';
    const v={id:uid(),affectation_id:aff_active.id,montant,montant_attendu:aff_active.montant_journalier,statut,mode_paiement:mode_paiement||'especes',date_versement:date_encaissement||today(),created_at:new Date().toISOString()};
    db.versements.push(v);saveDB(db);
    return res.end(JSON.stringify({message:'Encaissement enregistré',versement_id:v.id,dette_avant:dette,dette_apres:Math.max(0,dette-montant)}));
  }

  // ── RETARDS ───────────────────────────────────────────────
  if(p==='/api/retards'&&method==='GET'){
    const vehs=vehsVisibles(db,auth);
    const date_debut=q.date_debut||'';
    const date_fin=q.date_fin||'';
    const retards=vehs.map(v=>{
      const affs=db.affectations.filter(a=>a.vehicule_id===v.id);
      const affIds=affs.map(a=>a.id);
      const aff_active=affs.find(a=>!a.date_fin);
      const chauffeur=aff_active?db.chauffeurs.find(c=>c.id===aff_active.chauffeur_id):null;
      let facs=db.facturations.filter(f=>f.vehicule_id===v.id);
      let vers=db.versements.filter(vs=>affIds.includes(vs.affectation_id));
      if(date_debut&&date_fin){facs=facs.filter(f=>f.date>=date_debut&&f.date<=date_fin);vers=vers.filter(vs=>vs.date_versement>=date_debut&&vs.date_versement<=date_fin);}
      const total_facture=facs.reduce((s,f)=>s+f.montant_facture,0);
      const total_verse=vers.reduce((s,vs)=>s+vs.montant,0);
      const retard=Math.max(0,total_facture-total_verse);
      return{vehicule_id:v.id,immatriculation:v.immatriculation,marque:v.marque,tag:v.tag||'',chauffeur:chauffeur?chauffeur.prenom+' '+chauffeur.nom:'Non affecté',total_facture,total_verse,retard};
    }).filter(r=>r.retard>0).sort((a,b)=>b.retard-a.retard);
    return res.end(JSON.stringify(retards));
  }

  // ── RAPPORT ───────────────────────────────────────────────
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
    if(!isManager){res.writeHead(403);return res.end(JSON.stringify({detail:'Refusé'}));}
    return res.end(JSON.stringify(db.gestionnaires));
  }
  if(p==='/api/gestionnaires'&&method==='POST'){
    if(!isManager){res.writeHead(403);return res.end(JSON.stringify({detail:'Refusé'}));}
    if(db.gestionnaires.find(g=>g.password===data.password)) return res.end(JSON.stringify({detail:'Ce mot de passe est déjà utilisé'}));
    const g={id:uid(),nom:data.nom,telephone:data.telephone||'',email:data.email||'',password:data.password||uid().slice(0,8),vehicules_ids:data.vehicules_ids||[],tag:data.tag||''};
    db.gestionnaires.push(g);saveDB(db);return res.end(JSON.stringify({id:g.id,password:g.password,message:'Gestionnaire créé'}));
  }
  const gM=p.match(/^\/api\/gestionnaires\/([^/]+)$/);
  if(gM&&method==='PATCH'){
    if(!isManager){res.writeHead(403);return res.end(JSON.stringify({detail:'Refusé'}));}
    const idx=db.gestionnaires.findIndex(g=>g.id===gM[1]);
    if(idx!==-1){db.gestionnaires[idx]={...db.gestionnaires[idx],...data};saveDB(db);}
    return res.end(JSON.stringify({message:'Mis à jour'}));
  }
  if(gM&&method==='DELETE'){
    if(!isManager){res.writeHead(403);return res.end(JSON.stringify({detail:'Refusé'}));}
    db.gestionnaires=db.gestionnaires.filter(g=>g.id!==gM[1]);saveDB(db);
    return res.end(JSON.stringify({message:'Supprimé'}));
  }

  // ── PROPRIETAIRES ─────────────────────────────────────────
  if(p==='/api/proprietaires'&&method==='GET'){
    if(!isManager){res.writeHead(403);return res.end(JSON.stringify({detail:'Refusé'}));}
    return res.end(JSON.stringify(db.proprietaires));
  }
  if(p==='/api/proprietaires'&&method==='POST'){
    if(!isManager){res.writeHead(403);return res.end(JSON.stringify({detail:'Refusé'}));}
    const pr={id:uid(),nom:data.nom,email:data.email||'',telephone:data.telephone||'',password:data.password||uid().slice(0,8),vehicules_ids:[]};
    db.proprietaires.push(pr);saveDB(db);return res.end(JSON.stringify({id:pr.id,password:pr.password,message:'Propriétaire créé'}));
  }
  const prM=p.match(/^\/api\/proprietaires\/([^/]+)$/);
  if(prM&&method==='PATCH'){if(!isManager){res.writeHead(403);return res.end(JSON.stringify({detail:'Refusé'}));}const idx=db.proprietaires.findIndex(pr=>pr.id===prM[1]);if(idx!==-1){db.proprietaires[idx]={...db.proprietaires[idx],...data};saveDB(db);}return res.end(JSON.stringify({message:'Mis à jour'}));}
  if(prM&&method==='DELETE'){if(!isManager){res.writeHead(403);return res.end(JSON.stringify({detail:'Refusé'}));}db.proprietaires=db.proprietaires.filter(pr=>pr.id!==prM[1]);saveDB(db);return res.end(JSON.stringify({message:'Supprimé'}));}

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
