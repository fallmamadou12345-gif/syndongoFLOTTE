const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const zlib = require('zlib');
const crypto = require('crypto');
const { imputerVersements } = require('./imputation.js');

const DB_FILE = process.env.DATA_PATH || './syndongo_data.json';
const PORT = process.env.PORT || 8000;

// ── Mots de passe gestionnaire/propriétaire : hash au repos (scrypt natif Node,
// aucune dépendance ajoutée) ────────────────────────────────────────────────
// Format stocké : "scrypt$<sel_hex>$<hash_hex>". Les comptes existants créés avant
// ce changement ont encore leur mot de passe en clair dans le fichier — verifyPassword()
// reste compatible avec ce cas (comparaison directe), et le convertit en hash dès la
// prochaine connexion réussie (voir POST /api/auth). Aucun compte existant n'est cassé
// par ce changement ; la migration est progressive, un compte à la fois, à la connexion.
function hashPassword(plain) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(plain), salt, 64).toString('hex');
  return 'scrypt$' + salt + '$' + hash;
}
function isHashedPassword(stored) {
  return typeof stored === 'string' && stored.startsWith('scrypt$');
}
function verifyPassword(plain, stored) {
  if (typeof stored !== 'string' || !stored) return false;
  if (isHashedPassword(stored)) {
    const parts = stored.split('$');
    if (parts.length !== 3) return false;
    try {
      const hashBuf = Buffer.from(parts[2], 'hex');
      const testBuf = crypto.scryptSync(String(plain), parts[1], hashBuf.length);
      return hashBuf.length === testBuf.length && crypto.timingSafeEqual(hashBuf, testBuf);
    } catch (e) { return false; }
  }
  // Compte pas encore migré : mot de passe encore en clair dans le fichier.
  return stored === plain;
}

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

// ── EZZLOC GPS CONFIG ──────────────────────────────────────────
// Traceurs GPS installés sur les véhicules/motos. La flotte est répartie sur PLUSIEURS
// comptes EZZloc (le compte principal + un sous-compte par gestionnaire/chauffeur —
// chacun ne voit que ses propres appareils sur le site EZZloc). On se connecte à
// chacun, on garde les tokens en mémoire, et on fusionne les résultats.
// Format env EZZLOC_ACCOUNTS : "usercode1:passmd5_1,usercode2:passmd5_2,..."
const EZZLOC_ACCOUNTS = (function(){
  const raw = process.env.EZZLOC_ACCOUNTS || '';
  const list = raw.split(',').map(s => s.trim()).filter(Boolean).map(function(s){
    const i = s.indexOf(':');
    return { usercode: s.slice(0, i), password_md5: s.slice(i + 1), token: null };
  });
  // Compatibilité avec l'ancien format mono-compte (une seule variable EZZLOC_USERCODE/PASSWORD_MD5)
  if (!list.length && process.env.EZZLOC_USERCODE && process.env.EZZLOC_PASSWORD_MD5) {
    list.push({ usercode: process.env.EZZLOC_USERCODE, password_md5: process.env.EZZLOC_PASSWORD_MD5, token: null });
  }
  return list;
})();

// Retenu à chaque appel /api/ezzloc/vehicules ou ezzlocIdForVehicule : à quel compte
// (index dans EZZLOC_ACCOUNTS) appartient tel VehicleID EZZloc, pour savoir quel token
// utiliser lors des appels suivants (getTrackData, getOdometerDetail…) sur ce véhicule.
let _ezzlocDeviceAccount = {};

function ezzlocRawCall(cmd, token, params) {
  const https = require('https');
  const body = JSON.stringify({ cmd, token: token || '', params: params || {}, language: 2 });
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    const req = https.request({
      hostname: 'www.ezzloc.net',
      path: '/api',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { finish(JSON.parse(data)); }
        catch(e) { finish({ result: 0, resultNote: 'Réponse EZZloc invalide' }); }
      });
    });
    // Sans timeout, une requête EZZloc qui ne répond jamais bloquerait indéfiniment
    // l'appel — et donc la carte correspondante resterait sur son sablier pour toujours.
    req.setTimeout(15000, () => { req.destroy(); finish({ result: 0, resultNote: 'Délai EZZloc dépassé' }); });
    req.on('error', e => finish({ result: 0, resultNote: e.message }));
    req.write(body);
    req.end();
  });
}

async function ezzlocLoginAccount(acc) {
  const r = await ezzlocRawCall('login', '', { UserCode: acc.usercode, Password: acc.password_md5 });
  acc.token = (r.result === 1 && r.detail && r.detail.token) ? r.detail.token : null;
  return acc.token;
}

// Appelle une commande sur UN compte précis, avec reconnexion auto si le token a expiré.
async function ezzlocCallOn(acc, cmd, params) {
  if (!acc.token) await ezzlocLoginAccount(acc);
  if (!acc.token) return { result: 0, resultNote: 'EZZloc non connecté (' + acc.usercode + ')' };
  let r = await ezzlocRawCall(cmd, acc.token, params);
  if (r.result === 400) {
    await ezzlocLoginAccount(acc);
    if (acc.token) r = await ezzlocRawCall(cmd, acc.token, params);
  }
  return r;
}

// Compat : appelle une commande sur le premier compte configuré (usage mono-compte).
async function ezzlocCall(cmd, params) {
  if (!EZZLOC_ACCOUNTS.length) return { result: 0, resultNote: 'Aucun compte EZZloc configuré' };
  return ezzlocCallOn(EZZLOC_ACCOUNTS[0], cmd, params);
}

// Appelle la même commande sur TOUS les comptes en parallèle, fusionne les résultats.
// Suppose que la commande renvoie un tableau (directement dans detail, ou detail.data).
async function ezzlocCallAllAccounts(cmd, params) {
  const results = await Promise.all(EZZLOC_ACCOUNTS.map(function(acc){ return ezzlocCallOn(acc, cmd, params); }));
  const merged = [];
  results.forEach(function(r, idx){
    if (r.result !== 1) return;
    const arr = Array.isArray(r.detail) ? r.detail : (r.detail && Array.isArray(r.detail.data) ? r.detail.data : []);
    arr.forEach(function(item){ _ezzlocDeviceAccount[item.VehicleID] = idx; merged.push(item); });
  });
  return merged;
}

// getVehicleList (liste statique des appareils, pas la position) est interrogé une fois
// par véhicule pour retrouver son compte/ID EZZloc (analyse 24h de chaque carte au
// chargement de la page GPS) — sans cache, ça déclenchait un appel complet aux 7 comptes
// PAR véhicule (jusqu'à 21 fois en rafale), ce qui saturait/ralentissait l'API EZZloc et
// laissait certaines cartes bloquées en chargement indéfiniment. On met en cache la liste
// fusionnée 30 secondes — largement suffisant pour couvrir le lot de requêtes d'une page.
let _ezzlocDeviceListCache = null;
let _ezzlocDeviceListCacheTime = 0;
async function ezzlocGetAllDevicesCached() {
  const now = Date.now();
  if (_ezzlocDeviceListCache && (now - _ezzlocDeviceListCacheTime) < 30000) return _ezzlocDeviceListCache;
  _ezzlocDeviceListCache = await ezzlocCallAllAccounts('getVehicleList', {});
  _ezzlocDeviceListCacheTime = now;
  return _ezzlocDeviceListCache;
}

// Retrouve le compte EZZloc (index) auquel appartient un VehicleID donné — en se basant
// sur le cache rempli par le dernier appel getVehicleLocationByGroup/getVehicleList ;
// si absent du cache, on recherche sur tous les comptes.
async function ezzlocAccountForDevice(vehicleId) {
  if (_ezzlocDeviceAccount[vehicleId] !== undefined) return EZZLOC_ACCOUNTS[_ezzlocDeviceAccount[vehicleId]];
  await ezzlocGetAllDevicesCached();
  if (_ezzlocDeviceAccount[vehicleId] !== undefined) return EZZLOC_ACCOUNTS[_ezzlocDeviceAccount[vehicleId]];
  return null;
}

// Normalise une plaque/texte pour comparaison tolérante (espaces/tirets ignorés)
function ezzlocNorm(s) { return String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, ''); }

// Zone Dakar autorisée : centre approx. de la presqu'île + rayon couvrant Dakar/Pikine/
// Guédiawaye/Rufisque/Bargny, mais excluant Thiès (~70km) et les autres villes.
const DAKAR_CENTRE = { lat: 14.6928, lon: -17.4467 };
const DAKAR_RAYON_KM = 40;
function distanceKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

// Retrouve l'ID EZZloc d'un véhicule SyNdongo : priorité à l'association manuelle
// (db.ezzloc_mapping), sinon on retente la correspondance automatique par plaque.
async function ezzlocIdForVehicule(db, vehiculeId) {
  const mapping = db.ezzloc_mapping || {};
  for (const ezzId in mapping) { if (mapping[ezzId] === vehiculeId) return parseInt(ezzId); }
  const veh = db.vehicules.find(v => v.id === vehiculeId);
  if (!veh || !veh.immatriculation) return null;
  const devices = await ezzlocGetAllDevicesCached();
  const nplate = ezzlocNorm(veh.immatriculation);
  const match = devices.find(d => mapping[String(d.VehicleID)] !== '__none__' && ezzlocNorm(d.RegName).includes(nplate));
  return match ? match.VehicleID : null;
}

// Une journée déjà écoulée ne change plus (le GPS et les commandes Yango de ce jour-là
// sont figés) — on met son résultat en cache indéfiniment pour que revisiter une même
// date soit instantané au lieu de refaire les appels EZZloc à chaque fois. "Aujourd'hui"
// est encore en cours, donc son cache expire vite (2 min) pour rester à peu près à jour.
const _analyse24hCache = {};
function analyse24hCacheKey(vehiculeId, date) { return vehiculeId + '|' + date; }

// Calcule l'analyse 24h (GPS EZZloc croisé aux commandes Yango) pour un véhicule et une
// date donnés. Fonction partagée par l'endpoint /api/analyse24h (consultation à la demande)
// et la sauvegarde automatique quotidienne (snapshotAnalyse24hToutesMotos ci-dessous).
async function calculerAnalyse24h(db, vehiculeId, date) {
  const dm = date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!dm) return { detail: 'Format de date invalide (AAAA-MM-JJ)' };

  const cacheKey = analyse24hCacheKey(vehiculeId, date);
  const aujourdHui = new Date().toISOString().split('T')[0];
  const estAujourdHui = date === aujourdHui;
  const cached = _analyse24hCache[cacheKey];
  if (cached && (!estAujourdHui || (Date.now() - cached.at) < 2 * 60 * 1000)) return cached.data;
  const jourDebut = Date.UTC(+dm[1], +dm[2] - 1, +dm[3], 0, 0, 0);
  const jourFin = jourDebut + 24 * 3600 * 1000 - 1;

  const ezzId = await ezzlocIdForVehicule(db, vehiculeId);
  let trackPoints = [];
  let kmParcourus = 0;
  if (ezzId) {
    const acc = await ezzlocAccountForDevice(ezzId);
    const tr = acc ? await ezzlocCallOn(acc, 'getTrackData', { VehicleID: ezzId, BeginTime: jourDebut, EndTime: jourFin }) : { result: 0 };
    if (tr.result === 1) trackPoints = tr.detail || [];
    // getOdometerDetail découpe ses journées sur un fuseau interne différent de celui
    // du Sénégal (repéré empiriquement à UTC+8) — la borne d'une "journée" EZZloc ne
    // tombe donc pas forcément dans notre fenêtre [jourDebut, jourFin]. On élargit la
    // requête d'une journée avant, puis on ne garde que le bucket le plus récent qui
    // ne dépasse pas la fin de notre journée : c'est celui qui couvre le mieux notre jour.
    const od = acc ? await ezzlocCallOn(acc, 'getOdometerDetail', { VehicleIDs: String(ezzId), BeginTime: jourDebut - 24 * 3600 * 1000, EndTime: jourFin }) : { result: 0 };
    if (od.result === 1 && Array.isArray(od.detail) && od.detail[0] && Array.isArray(od.detail[0].Detail)) {
      const entries = od.detail[0].Detail.filter(function(d){ return d.Date <= jourFin; });
      if (entries.length) {
        const best = entries.reduce(function(a, b){ return b.Date > a.Date ? b : a; });
        kmParcourus = parseFloat(best.Odometer) || 0;
      }
    }
  }
  const commandes = (db.yango_commandes || []).filter(c => c.vehicule_id === vehiculeId &&
    ((c.debut && c.debut >= jourDebut && c.debut <= jourFin) || (c.fin && c.fin >= jourDebut && c.fin <= jourFin)));

  // Bilan journalier : gains + répartition des annulations (client vs chauffeur).
  // "Raison de l'annulation" du CSV Yango : mention explicite du client, sinon on
  // considère que c'est le chauffeur qui a annulé/ignoré la course (reject, seen_timeout…).
  function estAnnuleClient(c) { return /client/i.test(c.raison_annulation || ''); }
  function estAnnuleChauffeur(c) { return !!c.raison_annulation && !estAnnuleClient(c); }

  const termineJour = commandes.filter(c => c.statut === 'Terminé');
  const annuleJour = commandes.filter(c => c.statut === 'Annulé');
  const montantGagne = termineJour.reduce((s, c) => s + (c.tarif || 0), 0);
  const nbAnnuleClient = annuleJour.filter(estAnnuleClient).length;
  const nbAnnuleChauffeur = annuleJour.filter(estAnnuleChauffeur).length;
  const nbAnnuleAutre = annuleJour.length - nbAnnuleClient - nbAnnuleChauffeur;

  // Chaque commande doit compter dans UNE SEULE heure — sinon une course dont le début
  // et la fin tombent dans deux heures différentes serait comptée deux fois (une fois
  // par heure), et la somme des barres dépasserait le total réel de la journée.
  // On retient la fin (heure de conclusion réelle) si connue, sinon le début.
  function heureRepere(c) { return (c.fin != null ? c.fin : c.debut); }

  const SEUIL_ACTIF_KMH = 5;
  const heures = [];
  for (let h = 0; h < 24; h++) {
    const hDebut = jourDebut + h * 3600 * 1000, hFin = hDebut + 3600 * 1000;
    const pts = trackPoints.filter(function(p){ const t = parseInt(p.GpsTime); return t >= hDebut && t < hFin; });
    const vitesses = pts.map(function(p){ return parseFloat(p.Speed) || 0; });
    const vitesseMoy = vitesses.length ? Math.round(vitesses.reduce(function(s,v){return s+v;},0) / vitesses.length) : 0;
    const vitesseMax = vitesses.length ? Math.round(Math.max.apply(null, vitesses)) : 0;
    const cmdsH = commandes.filter(function(c){
      const t = heureRepere(c);
      return t != null && t >= hDebut && t < hFin;
    });
    const cmdsAnnuleH = cmdsH.filter(function(c){ return c.statut === 'Annulé'; });
    const nbTermine = cmdsH.filter(function(c){ return c.statut === 'Terminé'; }).length;
    const nbAnnule = cmdsAnnuleH.length;
    const nbAnnuleClientH = cmdsAnnuleH.filter(estAnnuleClient).length;
    const nbAnnuleChauffeurH = cmdsAnnuleH.filter(estAnnuleChauffeur).length;
    const actif = vitesseMax >= SEUIL_ACTIF_KMH;
    heures.push({
      heure: h, vitesse_moy: vitesseMoy, vitesse_max: vitesseMax,
      nb_termine: nbTermine, nb_annule: nbAnnule,
      nb_annule_client: nbAnnuleClientH, nb_annule_chauffeur: nbAnnuleChauffeurH,
      actif: actif,
      anomalie: actif && nbTermine === 0,
      vide: !actif && nbTermine === 0 && nbAnnule === 0
    });
  }
  const resultat = {
    vehicule_id: vehiculeId, date: date, ezzloc_id: ezzId, km_parcourus: Math.round(kmParcourus * 10) / 10,
    nb_points_gps: trackPoints.length, nb_commandes: commandes.length, heures: heures,
    montant_gagne: montantGagne, nb_termine_jour: termineJour.length,
    nb_annule_client: nbAnnuleClient, nb_annule_chauffeur: nbAnnuleChauffeur, nb_annule_autre: nbAnnuleAutre
  };
  _analyse24hCache[cacheKey] = { at: Date.now(), data: resultat };
  return resultat;
}

// Sauvegarde quotidienne : calcule et enregistre l'analyse 24h de chaque véhicule/moto
// suivi par EZZloc pour une date donnée, afin de garder un historique consultable même
// si EZZloc finit par purger ses propres données anciennes (rétention limitée côté eux).
async function snapshotAnalyse24hToutesMotos(db, date) {
  const devices = await ezzlocGetAllDevicesCached();
  const mapping = db.ezzloc_mapping || {};
  const vehiculeIds = new Set();
  devices.forEach(function(d){
    const mappedId = mapping[String(d.VehicleID)];
    if (mappedId && mappedId !== '__none__') { vehiculeIds.add(mappedId); return; }
    if (mappedId === '__none__') return;
    const nreg = ezzlocNorm(d.RegName);
    const veh = db.vehicules.find(function(v){ return v.immatriculation && nreg.includes(ezzlocNorm(v.immatriculation)); });
    if (veh) vehiculeIds.add(veh.id);
  });

  db.historique_analyse24h = db.historique_analyse24h || [];
  const index = {};
  db.historique_analyse24h.forEach(function(h, i){ index[h.vehicule_id + '|' + h.date] = i; });

  let nbSauvegardes = 0;
  for (const vehiculeId of vehiculeIds) {
    const r = await calculerAnalyse24h(db, vehiculeId, date);
    if (r.detail) continue;
    const record = Object.assign({ saved_at: Date.now() }, r);
    const key = vehiculeId + '|' + date;
    if (index[key] !== undefined) db.historique_analyse24h[index[key]] = record;
    else { db.historique_analyse24h.push(record); index[key] = db.historique_analyse24h.length - 1; }
    nbSauvegardes++;
  }
  saveDB(db);
  return { message: 'Historique sauvegardé', date: date, nb_vehicules: vehiculeIds.size, nb_sauvegardes: nbSauvegardes };
}

// Vérifie une fois par heure si la sauvegarde d'hier a déjà été faite ; sinon la lance.
// Couvre le cas où le serveur tourne en continu (VPS) sans dépendre d'un cron externe.
let _dernierSnapshotDate = null;
function planifierSnapshotAutomatique() {
  async function verifier() {
    try {
      if (!EZZLOC_ACCOUNTS.length) return;
      const h = new Date(); h.setUTCDate(h.getUTCDate() - 1);
      const hier = h.toISOString().split('T')[0];
      if (_dernierSnapshotDate === hier) return;
      const db = loadDB();
      const dejaFait = (db.historique_analyse24h || []).some(function(x){ return x.date === hier; });
      if (dejaFait) { _dernierSnapshotDate = hier; return; }
      const r = await snapshotAnalyse24hToutesMotos(db, hier);
      _dernierSnapshotDate = hier;
      console.log('[snapshot auto] ' + hier + ' : ' + r.nb_sauvegardes + '/' + r.nb_vehicules + ' véhicule(s) sauvegardé(s)');
    } catch (e) { console.log('[snapshot auto] erreur:', e.message); }
  }
  verifier();
  setInterval(verifier, 60 * 60 * 1000);
}

// ── IMPORT CSV YANGO ────────────────────────────────────────────
// Les exports Yango mélangent des lettres cyrilliques visuellement identiques aux
// lettres latines (ex: "SSТ205" avec un Т cyrillique) — sans doute un artefact de leur
// système. On les convertit avant toute comparaison de texte (nom de chauffeur, plaque).
const CYRILLIC_TO_LATIN = {
  'А':'A','В':'B','Е':'E','К':'K','М':'M','Н':'H','О':'O','Р':'P','С':'C','Т':'T','У':'Y','Х':'X',
  'а':'a','в':'b','е':'e','к':'k','м':'m','н':'h','о':'o','р':'p','с':'c','т':'t','у':'y','х':'x'
};
function deCyrillic(s) { return String(s || '').split('').map(ch => CYRILLIC_TO_LATIN[ch] || ch).join(''); }
function normNomYango(s) {
  return deCyrillic(s).toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Z0-9]/g, '');
}

function splitCsvLine(line, delim) {
  const result = [];
  let cur = '', inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (inQuotes && line[i+1] === '"') { cur += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (c === delim && !inQuotes) { result.push(cur); cur = ''; }
    else cur += c;
  }
  result.push(cur);
  return result;
}

// Le Sénégal est en GMT+0 toute l'année (pas d'heure d'été) — on traite donc les dates
// Yango comme de l'UTC pur, ce qui évite toute dépendance au fuseau horaire du serveur
// qui exécute ce code (Windows local en test, VPS en prod).
function parseYangoDate(s) {
  if (!s) return null;
  const m = String(s).trim().match(/^(\d{2})\.(\d{2})\.(\d{4})\s+(\d{2}):(\d{2}):(\d{2})$/);
  if (!m) return null;
  const [, d, mo, y, h, mi, se] = m;
  const t = Date.UTC(+y, +mo - 1, +d, +h, +mi, +se);
  return isNaN(t) ? null : t;
}

function findAllIdx(headers, name) {
  const idxs = [];
  headers.forEach((h, i) => { if (h === name) idxs.push(i); });
  return idxs;
}

// Transforme le texte brut du CSV Yango en tableau de commandes structurées
function parseYangoCSV(text) {
  text = String(text || '').replace(/^﻿/, '');
  const lines = text.split(/\r?\n/).filter(l => l.trim().length);
  if (lines.length < 2) return [];
  const headers = splitCsvLine(lines[0], ';').map(h => h.trim());
  const idIdentifiant = headers.indexOf('Identifiant');
  const idStatut = headers.indexOf('Statut');
  const idsConducteur = findAllIdx(headers, 'Conducteur');
  const idsVehicule = findAllIdx(headers, 'Véhicule');
  const idPriseEnCharge = headers.indexOf('Date de prise en charge');
  const idRealisation = headers.indexOf('Date de réalisation');
  const idRaisonAnnulation = headers.indexOf('Raison de l\'annulation');
  const idDistance = headers.indexOf('Distance parcourue (en km)');
  // "Tarif dans Yango Pro" est souvent vide dans cet export (constaté sur les données
  // réelles) — le montant réellement payé se trouve dans les colonnes de règlement
  // (espèces, sans espèces, compte partenaire, entreprise). On les additionne : une
  // course n'est en général payée que par UN seul de ces moyens, donc la somme donne
  // le montant réel encaissé pour la course.
  const idTarif = headers.indexOf('Tarif dans Yango Pro');
  const idEspeces = headers.indexOf('Espèces');
  const idSansEspeces = headers.indexOf('Paiement sans espèces');
  const idComptePartenaire = headers.indexOf('Paiements sur le compte du partenaire');
  const idEntreprise = headers.indexOf('Paiement d’entreprise');
  const idConducteurNom = idsConducteur.length > 1 ? idsConducteur[1] : idsConducteur[0];
  const idVehiculeNom = idsVehicule.length > 1 ? idsVehicule[1] : idsVehicule[0];

  const out = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = splitCsvLine(lines[i], ';');
    if (cols.length < 2) continue;
    const identifiant = cols[idIdentifiant];
    if (!identifiant) continue;
    const montantPaiements = (parseFloat(cols[idEspeces]) || 0) + (parseFloat(cols[idSansEspeces]) || 0) +
      (parseFloat(cols[idComptePartenaire]) || 0) + (parseFloat(cols[idEntreprise]) || 0);
    out.push({
      identifiant: identifiant,
      statut: cols[idStatut] || '',
      conducteur_nom: (cols[idConducteurNom] || '').trim(),
      vehicule_nom: (cols[idVehiculeNom] || '').trim(),
      debut: parseYangoDate(cols[idPriseEnCharge]),
      fin: parseYangoDate(cols[idRealisation]),
      raison_annulation: cols[idRaisonAnnulation] || '',
      distance_km: parseFloat(cols[idDistance]) || 0,
      tarif: montantPaiements || (parseFloat(cols[idTarif]) || 0)
    });
  }
  return out;
}

// Associe une commande Yango à un véhicule/chauffeur SyNdongo : d'abord par nom de
// chauffeur (le plus fiable, le nom du champ "Véhicule" Yango est souvent juste un
// surnom sans plaque), sinon par plaque si elle apparaît dans le champ "Véhicule".
function matchYangoCommande(cmd, db) {
  const nomChauf = normNomYango(cmd.conducteur_nom);
  let chauffeur = null;
  if (nomChauf) {
    chauffeur = db.chauffeurs.find(c => normNomYango((c.prenom||'') + (c.nom||'')) === nomChauf)
      || db.chauffeurs.find(c => normNomYango((c.nom||'') + (c.prenom||'')) === nomChauf);
  }
  let vehicule = null;
  if (chauffeur) {
    const aff = db.affectations.find(a => a.chauffeur_id === chauffeur.id && !a.date_fin);
    if (aff) vehicule = db.vehicules.find(v => v.id === aff.vehicule_id);
  }
  if (!vehicule && cmd.vehicule_nom) {
    const nreg = normNomYango(cmd.vehicule_nom);
    vehicule = db.vehicules.find(v => v.immatriculation && nreg.includes(normNomYango(v.immatriculation)));
  }
  return { chauffeur_id: chauffeur ? chauffeur.id : null, vehicule_id: vehicule ? vehicule.id : null };
}

// Cache mémoire de la base : évite de relire + reparser le fichier (plusieurs Mo)
// à chaque appel API. Invalidé automatiquement si le fichier change (mtime).
let _dbCache = null;
let _dbCacheMtimeMs = 0;

function loadDB() {
  if (!fs.existsSync(DB_FILE)) {
    const dir = path.dirname(DB_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(DB_FILE, JSON.stringify({
      vehicules:[], chauffeurs:[], affectations:[],
      versements:[], depenses:[], alertes:[], activites:[],
      facturations:[], tags:[], proprietaires:[], gestionnaires:[],
      financements:[], echeances:[], avances:[], remboursements_avance:[], avenants_financement:[]
    }, null, 2));
  }
  const mtimeMs = fs.statSync(DB_FILE).mtimeMs;
  if (_dbCache && mtimeMs === _dbCacheMtimeMs) return _dbCache;

  const db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  // Normaliser les tags (s'assurer qu'ils sont tous des strings)
  if(db.tags) db.tags = normalizeTags(db.tags);
  ['activites','facturations','tags','proprietaires','versements',
   'depenses','alertes','gestionnaires','historique','journal',
   'livreurs','recettes_livreurs','paiements_livreurs','chat_messages','traites',
   'ordres_maintenance',
   // Phase Financement 1 — modèle uniquement, aucune logique branchée encore.
   'financements','echeances','avances','remboursements_avance','avenants_financement'
   ].forEach(k=>{ if(!db[k]) db[k]=[]; });
  if(!db.config_livreurs) db.config_livreurs = { taux_horaire: 500, paliers: [] };
  if(!Array.isArray(db.config_livreurs.paliers)) db.config_livreurs.paliers = [];
  if(!db.config_frais_moto) db.config_frais_moto = { frais_gestion_jour: 1000, commission_pct: 0, tags: ['MOTO GESTION','MOTO SY TRANSPORT'] };
  if(!Array.isArray(db.config_frais_moto.tags)) db.config_frais_moto.tags = ['MOTO GESTION','MOTO SY TRANSPORT'];

  _dbCache = db;
  _dbCacheMtimeMs = mtimeMs;
  return db;
}

function saveDB(db) {
  const dir = path.dirname(DB_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  // Écriture atomique : on écrit dans un fichier temporaire puis on le renomme.
  // Le renommage est une opération atomique du système de fichiers — le fichier
  // final contient toujours soit l'ancien contenu complet, soit le nouveau complet,
  // jamais un état intermédiaire corrompu (même en cas de coupure/crash pendant l'écriture).
  const tmpFile = DB_FILE + '.tmp-' + process.pid;
  fs.writeFileSync(tmpFile, JSON.stringify(db));
  fs.renameSync(tmpFile, DB_FILE);
  _dbCache = db;
  _dbCacheMtimeMs = fs.statSync(DB_FILE).mtimeMs;
}

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2,6);
const today = () => new Date().toISOString().split('T')[0];
const genPin = () => String(Math.floor(1000 + Math.random() * 9000));

function getRole(req) {
  const parsed = url.parse(req.url, true);
  const token = parsed.query.token || req.headers['x-token'] || '';
  if (token === MANAGER_PASSWORD) return { role:'manager' };
  const db = loadDB();
  if (token) {
    const proprio = db.proprietaires.find(p => verifyPassword(token, p.password));
    if (proprio) return { role:'proprietaire', proprio };
    const gest = db.gestionnaires.find(g => verifyPassword(token, g.password));
    if (gest) return { role:'gestionnaire', gest };
  }
  if (token.startsWith('lv:')) {
    const [, lvId, lvPin] = token.split(':');
    const livreur = db.chauffeurs.find(c => c.id === lvId && c.statut === 'actif' && c.pin && c.pin === lvPin);
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
function categorieOk(db, scope, vehiculeId) {
  if (scope === 'tous' || !vehiculeId) return true;
  const veh = db.vehicules.find(v => v.id === vehiculeId);
  if (!veh) return true;
  const isMoto = veh.categorie === 'moto';
  return scope === 'moto' ? isMoto : !isMoto;
}
function peutFacturer(db, auth, vehiculeId) {
  if (auth.role !== 'gestionnaire' || auth.gest.is_manager) return true;
  const scope = auth.gest.facturer_scope || 'tous';
  if (scope === 'aucun') return false;
  return categorieOk(db, scope, vehiculeId);
}
function peutEncaisser(db, auth, vehiculeId) {
  if (auth.role !== 'gestionnaire' || auth.gest.is_manager) return true;
  const scope = auth.gest.encaisser_scope || 'tous';
  if (scope === 'aucun') return false;
  return categorieOk(db, scope, vehiculeId);
}

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

// Un gestionnaire peut agir sur un véhicule s'il lui est visible — via tag OU via
// affectation directe (vehicules_ids). Ne JAMAIS vérifier auth.gest.vehicules_ids seul :
// ça ignore l'accès par tag et bloque à tort les gestionnaires assignés par tag
// (ex. Papa Sakho / Ibrahima Sy sur la flotte moto).
function gestPeutVoirVehicule(db, auth, vehiculeId) {
  if (!vehiculeId) return false;
  return vehsVisibles(db, auth).some(v => v.id === vehiculeId);
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

// Ids de TOUS les chauffeurs (toute catégorie) visibles par l'utilisateur courant — même logique que GET /api/chauffeurs
function chauffeursVisiblesIds(db, auth) {
  const myVehs = vehsVisibles(db, auth).map(v => v.id);
  let list = db.chauffeurs.filter(c => c.statut === 'actif');
  if (auth.role === 'manager') return list.map(c => c.id);
  if (auth.role === 'gestionnaire') {
    const affVeh = db.affectations.filter(a => myVehs.includes(a.vehicule_id) && !a.date_fin).map(a => a.chauffeur_id);
    const mesChauffeurs = list.filter(c => c.cree_par === auth.gest.id).map(c => c.id);
    const tousIds = new Set([...affVeh, ...mesChauffeurs]);
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

  // Prime/palier : réservée aux livreurs moto (categorie==='livreur') — jamais versée
  // par erreur à un chauffeur VTC, ce système d'incitation ne les concerne pas.
  const estLivreurMoto = (db.chauffeurs.find(c => c.id === livreurId) || {}).categorie === 'livreur';
  const taux_horaire = estLivreurMoto ? (db.config_livreurs.taux_horaire || 0) : 0;
  const paliers = estLivreurMoto ? [...db.config_livreurs.paliers].sort((a, b) => b.seuil - a.seuil) : [];

  const versePerDay = {};
  versements.forEach(vs => { versePerDay[vs.date_versement] = (versePerDay[vs.date_versement] || 0) + vs.montant; });
  const detail_primes = [];
  let prime = 0;
  if (estLivreurMoto) {
    Object.keys(versePerDay).sort().forEach(date => {
      const montant_jour = versePerDay[date];
      const pl = paliers.find(p => montant_jour >= p.seuil);
      if (pl) { prime += pl.prime; detail_primes.push({ date, montant_jour, seuil: pl.seuil, prime: pl.prime }); }
    });
  }

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
    const pr = db.proprietaires.find(x => verifyPassword(data.password, x.password));
    if (pr) {
      if (!isHashedPassword(pr.password)) { pr.password = hashPassword(data.password); saveDB(db); }
      return res.end(JSON.stringify({ role:'proprietaire', token:data.password, nom:pr.nom, proprio_id:pr.id }));
    }
    const gt = db.gestionnaires.find(x => verifyPassword(data.password, x.password));
    if (gt) {
      if (!isHashedPassword(gt.password)) { gt.password = hashPassword(data.password); saveDB(db); }
      return res.end(JSON.stringify({
      role:'gestionnaire',
      token:data.password,
      nom:gt.nom,
      gest_id:gt.id,
      tags:gt.tags||[],
      tag:gt.tag||'',
      vehicules_ids:gt.vehicules_ids||[],
      is_manager: gt.is_manager || false,         // Affiche comme Manager dans l'UI
      affiche_comme: gt.is_manager ? 'Manager' : 'Gestionnaire',
      facturer_scope: gt.facturer_scope || 'tous',
      encaisser_scope: gt.encaisser_scope || 'tous'
      }));
    }
    if (data.telephone && data.pin) {
      const tel = String(data.telephone).trim();
      const pin = String(data.pin).trim();
      const lv = db.chauffeurs.find(c => c.statut === 'actif' && c.telephone === tel && c.pin && c.pin === pin);
      if (lv) return res.end(JSON.stringify({ role:'livreur', token:'lv:'+lv.id+':'+lv.pin, nom:lv.prenom+' '+lv.nom, livreur_id:lv.id, categorie:lv.categorie||'chauffeur' }));
      res.writeHead(401); return res.end(JSON.stringify({ detail:'Téléphone ou code incorrect' }));
    }
    // Reconnexion auto (localStorage) avec un jeton livreur déjà émis : "lv:<id>:<pin>"
    if (typeof data.password === 'string' && data.password.startsWith('lv:')) {
      const [, lvId, lvPin] = data.password.split(':');
      const lv = db.chauffeurs.find(c => c.id === lvId && c.statut === 'actif' && c.pin && c.pin === lvPin);
      if (lv) return res.end(JSON.stringify({ role:'livreur', token:data.password, nom:lv.prenom+' '+lv.nom, livreur_id:lv.id, categorie:lv.categorie||'chauffeur' }));
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
    if(!q.inclure_archives) list = list.filter(v=>v.statut!=='archive');
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
    if(isGest){
      const gTags=auth.gest.tags||(auth.gest.tag?[auth.gest.tag]:[]);
      if(gTags.length&&!gTags.includes(data.tag)) return res.end(JSON.stringify({detail:'Vous ne pouvez créer un véhicule que sous vos tags assignés : '+gTags.join(', ')}));
    }
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
    if(idx===-1){res.writeHead(404);return res.end(JSON.stringify({detail:'Véhicule introuvable'}));}
    if(isGest&&!gestPeutVoirVehicule(db,auth,vM[1])){res.writeHead(403);return res.end(JSON.stringify({detail:'Véhicule non assigné'}));}
    if(data.immatriculation!==undefined){
      const immatMaj=(data.immatriculation||'').toUpperCase().trim();
      if(db.vehicules.find(v=>v.id!==vM[1]&&v.immatriculation===immatMaj)) return res.end(JSON.stringify({detail:immatMaj+' déjà enregistré sur un autre véhicule'}));
      data={...data,immatriculation:immatMaj};
    }
    if(data.km_actuel!==undefined){
      const nouveauKm=Number(data.km_actuel);
      const ancienKm=Number(db.vehicules[idx].km_actuel)||0;
      if(!Number.isFinite(nouveauKm)||nouveauKm<0) return res.end(JSON.stringify({detail:'Kilométrage invalide : doit être un nombre positif'}));
      if(nouveauKm<ancienKm) return res.end(JSON.stringify({detail:'Kilométrage refusé : '+nouveauKm+' km est inférieur à la valeur actuelle ('+ancienKm+' km).'}));
    }
    const avant=db.vehicules[idx];
    db.vehicules[idx]={...avant,...data};
    if(data.proprio_id!==undefined){db.proprietaires.forEach(pr=>{pr.vehicules_ids=pr.vehicules_ids.filter(id=>id!==vM[1]);});if(data.proprio_id){const pr=db.proprietaires.find(x=>x.id===data.proprio_id);if(pr)pr.vehicules_ids.push(vM[1]);}}
    if(data.gest_id!==undefined){db.gestionnaires.forEach(gt=>{gt.vehicules_ids=gt.vehicules_ids.filter(id=>id!==vM[1]);});if(data.gest_id){const gt=db.gestionnaires.find(x=>x.id===data.gest_id);if(gt)gt.vehicules_ids.push(vM[1]);}}
    const changements={};
    Object.keys(data).forEach(k=>{
      if(JSON.stringify(avant[k])!==JSON.stringify(db.vehicules[idx][k])) changements[k]={avant:avant[k]===undefined?null:avant[k],apres:db.vehicules[idx][k]};
    });
    if(Object.keys(changements).length){
      db.historique=(db.historique||[]);
      db.historique.push({id:uid(),type:'vehicule_modifie',objet:'vehicule',objet_id:vM[1],ref_nom:db.vehicules[idx].immatriculation,
        auteur:isGest?auth.gest.nom:'Manager',auteur_id:isGest?auth.gest.id:null,role:auth.role,date:new Date().toISOString(),changements});
    }
    saveDB(db);
    return res.end(JSON.stringify({message:'Mis à jour'}));
  }
  if(vM&&method==='DELETE'){
    if(!isManager){res.writeHead(403);return res.end(JSON.stringify({detail:'Refusé'}));}
    const idx=db.vehicules.findIndex(v=>v.id===vM[1]);
    if(idx===-1){res.writeHead(404);return res.end(JSON.stringify({detail:'Véhicule introuvable'}));}
    if(db.affectations.find(a=>a.vehicule_id===vM[1]&&!a.date_fin)) return res.end(JSON.stringify({detail:'Impossible : chauffeur affecté'}));
    // Archivage plutôt que suppression définitive : conserve facturations, dépenses,
    // commissions, affectations et historique — seul le statut change, le véhicule
    // disparaît des listes opérationnelles (GET /vehicules) mais reste accessible par id.
    const avant=db.vehicules[idx];
    db.vehicules[idx]={...avant,statut:'archive'};
    db.historique=(db.historique||[]);
    db.historique.push({id:uid(),type:'vehicule_archive',objet:'vehicule',objet_id:vM[1],ref_nom:avant.immatriculation,
      auteur:isGest?auth.gest.nom:'Manager',auteur_id:isGest?auth.gest.id:null,role:auth.role,date:new Date().toISOString(),
      changements:{statut:{avant:avant.statut||null,apres:'archive'}}});
    saveDB(db);return res.end(JSON.stringify({message:'Véhicule archivé'}));
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

  // Historique du kilométrage — dérivé de db.historique (entrées vehicule_modifie déjà
  // écrites par le PATCH /vehicules/:id, Phase 1 F-06). Aucune nouvelle donnée stockée.
  const kmHistM=p.match(/^\/api\/vehicules\/([^/]+)\/km_historique$/);
  if(kmHistM&&method==='GET'){
    const veh=db.vehicules.find(v=>v.id===kmHistM[1]);
    if(!veh){res.writeHead(404);return res.end(JSON.stringify({detail:'Véhicule introuvable'}));}
    const myVehs=vehsVisibles(db,auth).map(v=>v.id);
    if(!myVehs.includes(veh.id)){res.writeHead(403);return res.end(JSON.stringify({detail:'Refusé'}));}
    let entries=(db.historique||[]).filter(h=>h.type==='vehicule_modifie'&&h.objet_id===kmHistM[1]&&h.changements&&h.changements.km_actuel);
    if(q.date_debut&&q.date_fin){
      entries=entries.filter(h=>{const d=(h.date||'').split('T')[0];return d>=q.date_debut&&d<=q.date_fin;});
    }
    entries=entries.slice().sort((a,b)=>a.date.localeCompare(b.date)).map(h=>({
      date:h.date, avant:h.changements.km_actuel.avant, apres:h.changements.km_actuel.apres, auteur:h.auteur
    }));
    const km_parcourus=entries.length?(entries[entries.length-1].apres||0)-(entries[0].avant||0):null;
    return res.end(JSON.stringify({vehicule_id:kmHistM[1],km_actuel:veh.km_actuel,historique:entries,km_parcourus}));
  }

  // ── ACTIVITES ─────────────────────────────────────────────
  if(p==='/api/activites'&&method==='POST'){
    if(!canWrite){res.writeHead(403);return res.end(JSON.stringify({detail:'Refusé'}));}
    // Gestionnaire : vérifier que le véhicule lui appartient
    if(isGest&&!gestPeutVoirVehicule(db,auth,data.vehicule_id)){res.writeHead(403);return res.end(JSON.stringify({detail:'Véhicule non assigné'}));}
    const statut_jour=data.statut_jour||'actif';
    const existing=db.activites.findIndex(a=>a.vehicule_id===data.vehicule_id&&a.date===today());
    const entry={id:existing!==-1?db.activites[existing].id:uid(),vehicule_id:data.vehicule_id,date:today(),statut_jour};
    if(existing!==-1)db.activites[existing]=entry;else db.activites.push(entry);
    saveDB(db);return res.end(JSON.stringify({message:'Statut enregistré',statut_jour}));
  }
  if(p==='/api/activites'&&method==='GET'){
    const nb=parseInt(q.jours||'60');
    const depuis=new Date();depuis.setDate(depuis.getDate()-nb);
    const myVehsAct=vehsVisibles(db,auth).map(v=>v.id);
    const list=db.activites.filter(a=>myVehsAct.includes(a.vehicule_id)&&new Date(a.date)>=depuis);
    return res.end(JSON.stringify(list));
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
      return{...c,vehicule_actuel:veh?veh.immatriculation+' · '+veh.marque:null,vehicule_id_actuel:veh?veh.id:null,affectation_active:!!aff};
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
    c.pin=genPin();
    db.chauffeurs.push(c);
    // Historique
    db.historique=(db.historique||[]);
    db.historique.push({id:uid(),type:'chauffeur_cree',ref_id:c.id,ref_nom:c.prenom+' '+c.nom,
      auteur:isGest?auth.gest.nom:'Manager',role:auth.role,date:new Date().toISOString()});
    saveDB(db);return res.end(JSON.stringify({id:c.id,pin:c.pin,message:'Chauffeur enregistré'}));
  }
  const cM=p.match(/^\/api\/chauffeurs\/([^/]+)$/);
  if(cM&&method==='DELETE'){if(!isManager){res.writeHead(403);return res.end(JSON.stringify({detail:'Refusé'}));}const idx=db.chauffeurs.findIndex(c=>c.id===cM[1]);if(idx!==-1){db.chauffeurs[idx].statut='depart';saveDB(db);}return res.end(JSON.stringify({message:'Chauffeur marqué comme parti'}));}
  if(cM&&method==='PATCH'){
    if(!isManager&&!isGest){res.writeHead(403);return res.end(JSON.stringify({detail:'Refusé'}));}
    const idx=db.chauffeurs.findIndex(c=>c.id===cM[1]);
    if(idx===-1){res.writeHead(404);return res.end(JSON.stringify({detail:'Chauffeur introuvable'}));}
    if(isGest){
      const affActive=db.affectations.find(a=>a.chauffeur_id===cM[1]&&!a.date_fin);
      const visible=affActive?gestPeutVoirVehicule(db,auth,affActive.vehicule_id):db.chauffeurs[idx].cree_par===auth.gest.id;
      if(!visible){res.writeHead(403);return res.end(JSON.stringify({detail:'Chauffeur non assigné'}));}
    }
    if(data.telephone&&data.telephone!==db.chauffeurs[idx].telephone&&db.chauffeurs.find((c,i)=>i!==idx&&c.telephone===data.telephone))return res.end(JSON.stringify({detail:'Téléphone déjà utilisé'}));
    const avant=db.chauffeurs[idx];
    db.chauffeurs[idx]={...avant,...data};
    if(!db.chauffeurs[idx].pin)db.chauffeurs[idx].pin=genPin();
    const changements={};
    Object.keys(data).forEach(k=>{
      if(k==='pin'||k==='password') return;
      if(JSON.stringify(avant[k])!==JSON.stringify(db.chauffeurs[idx][k])) changements[k]={avant:avant[k]===undefined?null:avant[k],apres:db.chauffeurs[idx][k]};
    });
    if(Object.keys(changements).length){
      db.historique=(db.historique||[]);
      db.historique.push({id:uid(),type:'chauffeur_modifie',objet:'chauffeur',objet_id:cM[1],ref_nom:db.chauffeurs[idx].prenom+' '+db.chauffeurs[idx].nom,
        auteur:isGest?auth.gest.nom:'Manager',auteur_id:isGest?auth.gest.id:null,role:auth.role,date:new Date().toISOString(),changements});
    }
    saveDB(db);
    return res.end(JSON.stringify({message:'Mis à jour'}));
  }

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
    // tout=1 : renvoie aussi les affectations clôturées (nécessaire pour l'imputation FIFO
    // des versements, qui doit couvrir tout l'historique d'un véhicule/chauffeur, pas
    // seulement son affectation active — sinon les versements liés à une ancienne
    // affectation clôturée sont exclus et faussent les calculs Facturé/Encaissé/Retard).
    let list=q.tout==='1'
      ? db.affectations.filter(a=>myVehs.includes(a.vehicule_id))
      : db.affectations.filter(a=>!a.date_fin&&myVehs.includes(a.vehicule_id));
    return res.end(JSON.stringify(list.map(a=>{
      const v=db.vehicules.find(x=>x.id===a.vehicule_id);
      const c=db.chauffeurs.find(x=>x.id===a.chauffeur_id);
      return{...a,vehicule:v?v.immatriculation+' · '+v.marque:'?',chauffeur:c?c.prenom+' '+c.nom:'?'};
    })));
  }
  if(p==='/api/affectations'&&method==='POST'){
    if(!isManager&&!isGest){res.writeHead(403);return res.end(JSON.stringify({detail:'Refusé'}));}
    if(isGest&&!vehsVisibles(db,auth).map(v=>v.id).includes(data.vehicule_id)){
      res.writeHead(403);return res.end(JSON.stringify({detail:'Véhicule hors de votre périmètre'}));
    }
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
      if(isGest&&!gestPeutVoirVehicule(db,auth,db.affectations[idx].vehicule_id)){
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
    const aff=db.affectations.find(a=>a.id===data.affectation_id);
    if(!aff) return res.end(JSON.stringify({detail:'Affectation introuvable'}));
    if(!peutEncaisser(db,auth,aff.vehicule_id)){res.writeHead(403);return res.end(JSON.stringify({detail:'Vous n\'avez pas la permission d\'encaisser'}));}
    if(isGest&&!gestPeutVoirVehicule(db,auth,aff.vehicule_id)){res.writeHead(403);return res.end(JSON.stringify({detail:'Véhicule non assigné'}));}
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
    const vs=db.versements.find(v=>v.id===versM[1]);
    if(!vs){res.writeHead(404);return res.end(JSON.stringify({detail:'Versement introuvable'}));}
    const aff=db.affectations.find(a=>a.id===vs.affectation_id);
    if(!peutEncaisser(db,auth,aff?aff.vehicule_id:null)){res.writeHead(403);return res.end(JSON.stringify({detail:'Vous n\'avez pas la permission d\'encaisser'}));}
    if(isGest&&aff&&!gestPeutVoirVehicule(db,auth,aff.vehicule_id)){
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
  if(vsM&&method==='PATCH'){
    if(!canWrite){res.writeHead(403);return res.end(JSON.stringify({detail:'Refusé'}));}
    const idx=db.versements.findIndex(v=>v.id===vsM[1]);
    if(idx===-1) return res.end(JSON.stringify({message:'Mis à jour'}));
    const affPatch=db.affectations.find(a=>a.id===db.versements[idx].affectation_id);
    if(!peutEncaisser(db,auth,affPatch?affPatch.vehicule_id:null)){res.writeHead(403);return res.end(JSON.stringify({detail:'Vous n\'avez pas la permission d\'encaisser'}));}
    const at=db.versements[idx].montant_attendu;const m=data.montant!==undefined?Number(data.montant):db.versements[idx].montant;const s=m>=at?'recu':m>0?'partiel':'en_retard';db.versements[idx]={...db.versements[idx],...data,montant:m,statut:s};saveDB(db);
    return res.end(JSON.stringify({message:'Mis à jour'}));
  }

  // ── DEPENSES ──────────────────────────────────────────────
  if(p==='/api/depenses'&&method==='GET'){
    const myVehs=vehsVisibles(db,auth).map(v=>v.id);
    let list=db.depenses.filter(d=>myVehs.includes(d.vehicule_id));
    const filtreParDate=!!(q.date_debut&&q.date_fin);
    if(filtreParDate) list=list.filter(d=>d.date_depense>=q.date_debut&&d.date_depense<=q.date_fin);
    // Le plafond de 300 protège une requête non bornée (aucune période demandée) ;
    // avec une période explicite, le filtre de date borne déjà le volume renvoyé —
    // ne pas tronquer, sinon les rapports/analyses sur une période ancienne ou large
    // perdent silencieusement des dépenses (commission, frais de gestion, etc.).
    const result=filtreParDate?list.reverse():list.slice(-300).reverse();
    return res.end(JSON.stringify(result));
  }
  if(p==='/api/depenses'&&method==='POST'){
    if(!canWrite){res.writeHead(403);return res.end(JSON.stringify({detail:'Refusé'}));}
    if(isGest&&!gestPeutVoirVehicule(db,auth,data.vehicule_id)){res.writeHead(403);return res.end(JSON.stringify({detail:'Véhicule non assigné'}));}
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
      if(dep&&!gestPeutVoirVehicule(db,auth,dep.vehicule_id)){res.writeHead(403);return res.end(JSON.stringify({detail:'Accès refusé'}));}
    }
    db.depenses=db.depenses.filter(d=>d.id!==dM[1]);
    saveDB(db);return res.end(JSON.stringify({message:'Supprimé'}));
  }
  if(dM&&method==='PATCH'){if(!canWrite){res.writeHead(403);return res.end(JSON.stringify({detail:'Refusé'}));}const idx=db.depenses.findIndex(d=>d.id===dM[1]);if(idx!==-1){db.depenses[idx]={...db.depenses[idx],...data};saveDB(db);}return res.end(JSON.stringify({message:'Mis à jour'}));}

  // ── ORDRES DE MAINTENANCE (Phase 2A) ────────────────────────
  function genererNumeroMO(db){
    const annee=new Date().getFullYear();
    const prefix='MO-'+annee+'-';
    const nums=db.ordres_maintenance.filter(o=>o.numero&&o.numero.startsWith(prefix)).map(o=>parseInt(o.numero.slice(prefix.length),10)||0);
    const suivant=(nums.length?Math.max(...nums):0)+1;
    return prefix+String(suivant).padStart(4,'0');
  }
  const STATUTS_MO=['PLANIFIE','OUVERT','EN_COURS','EN_ATTENTE_PIECE','TERMINE','ANNULE'];
  const STATUTS_MO_OUVERTS=['OUVERT','EN_COURS','EN_ATTENTE_PIECE'];
  function normaliserPieceMO(p){
    return {
      nom:(p.nom||'').trim(), reference:(p.reference||'').trim(), quantite:Number(p.quantite)||0,
      prix_unitaire:Number(p.prix_unitaire)||0, fournisseur:(p.fournisseur||'').trim(),
      total:(Number(p.quantite)||0)*(Number(p.prix_unitaire)||0)
    };
  }
  function calculerCoutMO(o){
    const piecesTotal=(o.pieces||[]).reduce((s,pc)=>s+(Number(pc.total)||0),0);
    const moCout=Number(o.main_oeuvre&&o.main_oeuvre.cout)||0;
    const autres=Number(o.autres_couts)||0;
    return piecesTotal+moCout+autres;
  }

  if(p==='/api/ordres_maintenance'&&method==='GET'){
    const myVehs=vehsVisibles(db,auth).map(v=>v.id);
    let list=db.ordres_maintenance.filter(o=>myVehs.includes(o.vehicule_id));
    if(q.vehicule_id) list=list.filter(o=>o.vehicule_id===q.vehicule_id);
    if(q.statut) list=list.filter(o=>o.statut===q.statut);
    list=list.map(o=>{
      const dep=o.depense_id?db.depenses.find(d=>d.id===o.depense_id):null;
      return{...o,
        depense_introuvable: !!(o.depense_id && !dep),
        montant_incoherent: !!(dep && o.depense_montant_enregistre!==undefined && dep.montant!==o.depense_montant_enregistre)
      };
    });
    return res.end(JSON.stringify(list.slice().reverse()));
  }
  if(p==='/api/ordres_maintenance'&&method==='POST'){
    if(!canWrite){res.writeHead(403);return res.end(JSON.stringify({detail:'Refusé'}));}
    if(!data.vehicule_id) return res.end(JSON.stringify({detail:'Véhicule obligatoire'}));
    if(isGest&&!gestPeutVoirVehicule(db,auth,data.vehicule_id)){res.writeHead(403);return res.end(JSON.stringify({detail:'Véhicule non assigné'}));}
    const veh=db.vehicules.find(v=>v.id===data.vehicule_id);
    if(!veh){res.writeHead(404);return res.end(JSON.stringify({detail:'Véhicule introuvable'}));}
    const statut=STATUTS_MO.includes(data.statut)?data.statut:'OUVERT';
    const o={
      id:uid(), numero:genererNumeroMO(db), vehicule_id:data.vehicule_id,
      type: data.type==='preventive'?'preventive':'corrective',
      sous_type: (data.sous_type||'').trim()||null,
      statut,
      date_ouverture: data.date_ouverture||today(),
      km_ouverture: data.km_ouverture!==undefined&&data.km_ouverture!==''?Number(data.km_ouverture):(veh.km_actuel||null),
      date_cloture: null, km_cloture: null,
      probleme: (data.probleme||'').trim(),
      garage: (data.garage||'').trim(),
      pieces: Array.isArray(data.pieces)?data.pieces.map(normaliserPieceMO):[],
      main_oeuvre:{
        mecanicien:((data.main_oeuvre&&data.main_oeuvre.mecanicien)||'').trim(),
        heures:Number(data.main_oeuvre&&data.main_oeuvre.heures)||0,
        taux_horaire:Number(data.main_oeuvre&&data.main_oeuvre.taux_horaire)||0,
        cout:0,
        commentaire:((data.main_oeuvre&&data.main_oeuvre.commentaire)||'').trim()
      },
      autres_couts: Number(data.autres_couts)||0,
      depense_id:null, depense_montant_enregistre:null,
      cree_par:isGest?auth.gest.id:'manager', auteur:isGest?auth.gest.nom:'Manager',
      created_at:new Date().toISOString(), updated_at:new Date().toISOString()
    };
    o.main_oeuvre.cout = o.main_oeuvre.heures*o.main_oeuvre.taux_horaire;
    o.cout_total = calculerCoutMO(o);
    db.ordres_maintenance.push(o);
    // Lien statut véhicule : un ordre ouvert/en cours/en attente pièce met le véhicule
    // en maintenance — réutilise le statut existant, n'en crée aucun nouveau.
    if(STATUTS_MO_OUVERTS.includes(o.statut) && veh.statut!=='archive'){
      veh.statut='en_maintenance';
    }
    db.historique=(db.historique||[]);
    db.historique.push({id:uid(),type:'maintenance_ouverte',objet:'ordre_maintenance',objet_id:o.id,
      ref_nom:o.numero+' — '+veh.immatriculation,
      auteur:o.auteur,auteur_id:isGest?auth.gest.id:null,role:auth.role,date:new Date().toISOString()});
    saveDB(db);
    return res.end(JSON.stringify({id:o.id,numero:o.numero,message:'Ordre de maintenance créé'}));
  }
  const moM=p.match(/^\/api\/ordres_maintenance\/([^/]+)$/);
  if(moM&&method==='PATCH'){
    if(!canWrite){res.writeHead(403);return res.end(JSON.stringify({detail:'Refusé'}));}
    const idx=db.ordres_maintenance.findIndex(o=>o.id===moM[1]);
    if(idx===-1){res.writeHead(404);return res.end(JSON.stringify({detail:'Ordre de maintenance introuvable'}));}
    const o=db.ordres_maintenance[idx];
    if(isGest&&!gestPeutVoirVehicule(db,auth,o.vehicule_id)){res.writeHead(403);return res.end(JSON.stringify({detail:'Véhicule non assigné'}));}
    const veh=db.vehicules.find(v=>v.id===o.vehicule_id);
    const ancienStatut=o.statut;
    if(data.type!==undefined) o.type = data.type==='preventive'?'preventive':'corrective';
    if(data.sous_type!==undefined) o.sous_type=(data.sous_type||'').trim()||null;
    if(data.statut!==undefined && STATUTS_MO.includes(data.statut)) o.statut=data.statut;
    if(data.probleme!==undefined) o.probleme=(data.probleme||'').trim();
    if(data.garage!==undefined) o.garage=(data.garage||'').trim();
    if(data.km_cloture!==undefined) o.km_cloture=data.km_cloture===''?null:(Number(data.km_cloture)||null);
    if(data.autres_couts!==undefined) o.autres_couts=Number(data.autres_couts)||0;
    if(Array.isArray(data.pieces)) o.pieces=data.pieces.map(normaliserPieceMO);
    if(data.main_oeuvre){
      const mo=data.main_oeuvre;
      o.main_oeuvre={
        mecanicien:(mo.mecanicien!==undefined?mo.mecanicien:o.main_oeuvre.mecanicien||'').trim(),
        heures:mo.heures!==undefined?(Number(mo.heures)||0):o.main_oeuvre.heures,
        taux_horaire:mo.taux_horaire!==undefined?(Number(mo.taux_horaire)||0):o.main_oeuvre.taux_horaire,
        cout:0,
        commentaire:(mo.commentaire!==undefined?mo.commentaire:o.main_oeuvre.commentaire||'').trim()
      };
      o.main_oeuvre.cout=o.main_oeuvre.heures*o.main_oeuvre.taux_horaire;
    }
    o.cout_total=calculerCoutMO(o);
    o.updated_at=new Date().toISOString();
    if((o.statut==='TERMINE'||o.statut==='ANNULE') && !o.date_cloture) o.date_cloture=today();
    // Ne repasse le véhicule à 'actif' que si c'est bien CET ordre qui l'avait mis en
    // maintenance, et seulement s'il n'y a pas d'AUTRE ordre encore ouvert sur ce véhicule
    // (n'écrase jamais un 'en_panne' saisi indépendamment entre-temps).
    if(veh){
      if(STATUTS_MO_OUVERTS.includes(o.statut) && veh.statut!=='archive'){
        veh.statut='en_maintenance';
      } else if(!STATUTS_MO_OUVERTS.includes(o.statut) && veh.statut==='en_maintenance'){
        const autreOuvert=db.ordres_maintenance.some(x=>x.id!==o.id&&x.vehicule_id===o.vehicule_id&&STATUTS_MO_OUVERTS.includes(x.statut));
        if(!autreOuvert) veh.statut='actif';
      }
    }
    if(ancienStatut!==o.statut){
      db.historique=(db.historique||[]);
      db.historique.push({id:uid(),type:'maintenance_mise_a_jour',objet:'ordre_maintenance',objet_id:o.id,
        ref_nom:o.numero+(veh?' — '+veh.immatriculation:''),
        auteur:isGest?auth.gest.nom:'Manager',auteur_id:isGest?auth.gest.id:null,role:auth.role,date:new Date().toISOString(),
        changements:{statut:{avant:ancienStatut,apres:o.statut}}});
    }
    saveDB(db);
    return res.end(JSON.stringify({message:'Mis à jour',cout_total:o.cout_total}));
  }
  if(moM&&method==='DELETE'){
    if(!isManager){res.writeHead(403);return res.end(JSON.stringify({detail:'Refusé'}));}
    const o=db.ordres_maintenance.find(x=>x.id===moM[1]);
    if(!o){res.writeHead(404);return res.end(JSON.stringify({detail:'Ordre de maintenance introuvable'}));}
    if(o.depense_id) return res.end(JSON.stringify({detail:'Impossible : une dépense est déjà liée à cet ordre. Supprimez d\'abord la dépense si nécessaire.'}));
    db.ordres_maintenance=db.ordres_maintenance.filter(x=>x.id!==moM[1]);
    saveDB(db);
    return res.end(JSON.stringify({message:'Ordre de maintenance supprimé'}));
  }
  const moDepM=p.match(/^\/api\/ordres_maintenance\/([^/]+)\/enregistrer_depense$/);
  if(moDepM&&method==='POST'){
    if(!canWrite){res.writeHead(403);return res.end(JSON.stringify({detail:'Refusé'}));}
    const o=db.ordres_maintenance.find(x=>x.id===moDepM[1]);
    if(!o){res.writeHead(404);return res.end(JSON.stringify({detail:'Ordre de maintenance introuvable'}));}
    if(isGest&&!gestPeutVoirVehicule(db,auth,o.vehicule_id)){res.writeHead(403);return res.end(JSON.stringify({detail:'Véhicule non assigné'}));}
    if(o.depense_id) return res.end(JSON.stringify({detail:'Cette maintenance est déjà enregistrée comme dépense.'}));
    const d={id:uid(),vehicule_id:o.vehicule_id,categorie:'reparation',montant:o.cout_total,
      description:'Maintenance '+o.numero+(o.sous_type?' — '+o.sous_type:'')+(o.probleme?' — '+o.probleme:''),
      justificatif:null,date_facture:null,payeur:'gestionnaire',tiers_nom:null,tiers_statut:null,
      ordre_maintenance_id:o.id,
      date_depense:today(),created_at:new Date().toISOString()};
    db.depenses.push(d);
    o.depense_id=d.id;
    o.depense_montant_enregistre=o.cout_total;
    o.updated_at=new Date().toISOString();
    saveDB(db);
    return res.end(JSON.stringify({message:'Dépense enregistrée',depense_id:d.id,montant:d.montant}));
  }

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

  // ── FRAIS DE GESTION MOTO (frais fixe/jour facturé + commission % — tags concernés) ──
  if(p==='/api/config_frais_moto'&&method==='GET'){
    return res.end(JSON.stringify(db.config_frais_moto));
  }
  if(p==='/api/config_frais_moto'&&method==='PATCH'){
    if(!isManager){res.writeHead(403);return res.end(JSON.stringify({detail:'Refusé'}));}
    if(data.frais_gestion_jour!==undefined) db.config_frais_moto.frais_gestion_jour=Number(data.frais_gestion_jour)||0;
    if(data.commission_pct!==undefined) db.config_frais_moto.commission_pct=Number(data.commission_pct)||0;
    if(Array.isArray(data.tags)) db.config_frais_moto.tags=data.tags.map(t=>String(t).trim()).filter(Boolean);
    saveDB(db);return res.end(JSON.stringify({message:'Configuration mise à jour',config:db.config_frais_moto}));
  }
  // Resynchronise commission/frais de gestion sur TOUT l'historique des facturations
  // (utile après un changement de taux, de tags, ou pour rattraper des facturations
  // créées via un point d'entrée qui ne générait pas encore les frais).
  if(p==='/api/config_frais_moto/resync'&&method==='POST'){
    if(!isManager){res.writeHead(403);return res.end(JSON.stringify({detail:'Refusé'}));}
    let n=0;
    for(const f of db.facturations){ genererFraisMoto(db,f); n++; }
    saveDB(db);
    return res.end(JSON.stringify({message:'Resynchronisation terminée',facturations_traitees:n}));
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

  // ── CHAUFFEURS (tous, pas seulement livreurs) — régénérer le code PIN d'accès ──
  const regenPinChM=p.match(/^\/api\/chauffeurs\/([^/]+)\/regen_pin$/);
  if(regenPinChM&&method==='POST'){
    if(!canWrite){res.writeHead(403);return res.end(JSON.stringify({detail:'Refusé'}));}
    const idx=db.chauffeurs.findIndex(c=>c.id===regenPinChM[1]);
    if(idx===-1){res.writeHead(404);return res.end(JSON.stringify({detail:'Chauffeur introuvable'}));}
    if(isGest){
      const myVehs=vehsVisibles(db,auth).map(v=>v.id);
      const affVeh=db.affectations.filter(a=>myVehs.includes(a.vehicule_id)&&!a.date_fin).map(a=>a.chauffeur_id);
      const estAMoi=affVeh.includes(regenPinChM[1])||db.chauffeurs[idx].cree_par===auth.gest.id;
      if(!estAMoi){res.writeHead(403);return res.end(JSON.stringify({detail:'Refusé'}));}
    }
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

  // ── CHAT — messagerie gestionnaire ↔ chauffeur ────────────
  if(p==='/api/livreur/chat'&&method==='GET'){
    if(auth.role!=='livreur'){res.writeHead(403);return res.end(JSON.stringify({detail:'Refusé'}));}
    const lvId=auth.livreur.id;
    db.chat_messages.forEach(m=>{ if(m.chauffeur_id===lvId&&m.expediteur==='gestionnaire') m.lu_chauffeur=true; });
    saveDB(db);
    const list=db.chat_messages.filter(m=>m.chauffeur_id===lvId).sort((a,b)=>a.created_at.localeCompare(b.created_at));
    return res.end(JSON.stringify(list.slice(-200)));
  }
  if(p==='/api/livreur/chat'&&method==='POST'){
    if(auth.role!=='livreur'){res.writeHead(403);return res.end(JSON.stringify({detail:'Refusé'}));}
    if((!data.texte||!data.texte.trim())&&!data.piece_jointe) return res.end(JSON.stringify({detail:'Message vide'}));
    const m={id:uid(),chauffeur_id:auth.livreur.id,expediteur:'chauffeur',
      auteur_nom:auth.livreur.prenom+' '+auth.livreur.nom,texte:(data.texte||'').trim(),
      piece_jointe:data.piece_jointe||null,lu_gestionnaire:false,lu_chauffeur:true,
      created_at:new Date().toISOString()};
    db.chat_messages.push(m);saveDB(db);
    return res.end(JSON.stringify({id:m.id,message:'Message envoyé'}));
  }
  if(p==='/api/chat/unread'&&method==='GET'){
    if(!isManager&&!isGest){res.writeHead(403);return res.end(JSON.stringify({detail:'Refusé'}));}
    const myIds=isGest?chauffeursVisiblesIds(db,auth):null;
    const counts={};
    db.chat_messages.forEach(m=>{
      if(m.expediteur!=='chauffeur'||m.lu_gestionnaire) return;
      if(myIds&&!myIds.includes(m.chauffeur_id)) return;
      counts[m.chauffeur_id]=(counts[m.chauffeur_id]||0)+1;
    });
    return res.end(JSON.stringify(counts));
  }
  if(p==='/api/chat/conversations'&&method==='GET'){
    if(!isManager&&!isGest){res.writeHead(403);return res.end(JSON.stringify({detail:'Refusé'}));}
    const myIds=isGest?chauffeursVisiblesIds(db,auth):db.chauffeurs.filter(c=>c.statut==='actif').map(c=>c.id);
    const list=myIds.map(chId=>{
      const ch=db.chauffeurs.find(c=>c.id===chId);
      const msgs=db.chat_messages.filter(m=>m.chauffeur_id===chId).sort((a,b)=>b.created_at.localeCompare(a.created_at));
      const dernier=msgs[0]||null;
      const nonLus=msgs.filter(m=>m.expediteur==='chauffeur'&&!m.lu_gestionnaire).length;
      return {
        chauffeur_id:chId,
        chauffeur:ch?ch.prenom+' '+ch.nom:'?',
        categorie:ch?ch.categorie:'',
        dernier_message:dernier?{texte:dernier.texte,a_piece_jointe:!!dernier.piece_jointe,expediteur:dernier.expediteur,created_at:dernier.created_at}:null,
        non_lus:nonLus
      };
    });
    list.sort((a,b)=>{
      if(!a.dernier_message&&!b.dernier_message) return (a.chauffeur||'').localeCompare(b.chauffeur||'');
      if(!a.dernier_message) return 1;
      if(!b.dernier_message) return -1;
      return b.dernier_message.created_at.localeCompare(a.dernier_message.created_at);
    });
    return res.end(JSON.stringify(list));
  }
  const chatGetM=p.match(/^\/api\/chat\/([^/]+)$/);
  if(chatGetM&&method==='GET'){
    if(!isManager&&!isGest){res.writeHead(403);return res.end(JSON.stringify({detail:'Refusé'}));}
    const chId=chatGetM[1];
    if(isGest&&!chauffeursVisiblesIds(db,auth).includes(chId)){res.writeHead(403);return res.end(JSON.stringify({detail:'Chauffeur non assigné'}));}
    db.chat_messages.forEach(m=>{ if(m.chauffeur_id===chId&&m.expediteur==='chauffeur') m.lu_gestionnaire=true; });
    saveDB(db);
    const list=db.chat_messages.filter(m=>m.chauffeur_id===chId).sort((a,b)=>a.created_at.localeCompare(b.created_at));
    return res.end(JSON.stringify(list.slice(-200)));
  }
  if(chatGetM&&method==='POST'){
    if(!isManager&&!isGest){res.writeHead(403);return res.end(JSON.stringify({detail:'Refusé'}));}
    const chId=chatGetM[1];
    if(isGest&&!chauffeursVisiblesIds(db,auth).includes(chId)){res.writeHead(403);return res.end(JSON.stringify({detail:'Chauffeur non assigné'}));}
    if((!data.texte||!data.texte.trim())&&!data.piece_jointe) return res.end(JSON.stringify({detail:'Message vide'}));
    const m={id:uid(),chauffeur_id:chId,expediteur:'gestionnaire',
      auteur_nom:isGest?auth.gest.nom:'Manager',texte:(data.texte||'').trim(),
      piece_jointe:data.piece_jointe||null,lu_gestionnaire:true,lu_chauffeur:false,
      created_at:new Date().toISOString()};
    db.chat_messages.push(m);saveDB(db);
    return res.end(JSON.stringify({id:m.id,message:'Message envoyé'}));
  }

  // ── CRÉDIT VÉHICULES — traites mensuelles ───────────────────
  if(p==='/api/traites'&&method==='GET'){
    const myVehs=vehsVisibles(db,auth).map(v=>v.id);
    let list=db.traites.filter(t=>myVehs.includes(t.vehicule_id));
    if(q.vehicule_id) list=list.filter(t=>t.vehicule_id===q.vehicule_id);
    return res.end(JSON.stringify(list.slice(-500).reverse()));
  }
  // Recalcule l'état d'une échéance à partir des traites (non annulées) qui lui
  // sont rattachées. Une seule implémentation du rapprochement, réutilisée par le
  // POST (nouvelle traite) et le DELETE (annulation) — même règle qu'à la migration
  // (Phase Financement 1, migrate_financement.js) : un paiement unique exact ->
  // PAYEE, un paiement unique partiel -> PARTIELLE, plusieurs paiements sur la même
  // échéance -> toujours revue_requise, quel que soit le total (jamais deviné).
  // Le montant dû original (echeance.montant) n'est JAMAIS modifié ici.
  function recalculerEcheance(db,echeanceId){
    const ech=db.echeances.find(e=>e.id===echeanceId);
    if(!ech) return;
    const traitesLiees=db.traites.filter(t=>t.echeance_id===echeanceId&&!t.annule);
    const montantPaye=traitesLiees.reduce((s,t)=>s+(Number(t.montant)||0),0);
    ech.traites_ids=traitesLiees.map(t=>t.id);
    ech.montant_paye=montantPaye;

    // Phase Financement 2C : avances (non annulées) rattachées à cette échéance.
    // Si aucune avance n'est rattachée, le comportement ci-dessous est strictement
    // identique à la Phase 2B (branches inchangées) — non-régression garantie.
    const avancesLiees=(db.avances||[]).filter(a=>a.echeance_id===echeanceId&&!a.annule);
    const montantComplete=avancesLiees.reduce((s,a)=>s+(Number(a.montant)||0),0);
    ech.avances_ids=avancesLiees.map(a=>a.id);
    ech.montant_complete=montantComplete;

    if(montantComplete>0){
      const ambiguTraite=traitesLiees.length>1;
      const totalCouvert=montantPaye+montantComplete;
      if(totalCouvert>=ech.montant){ech.statut='COMPLETEE_PAR_AVANCE';ech.revue_requise=ambiguTraite;}
      else {ech.statut='PARTIELLE';ech.revue_requise=ambiguTraite;}
      ech.raison_ambiguite=ambiguTraite?'plusieurs_paiements_meme_echeance':null;
    } else if(traitesLiees.length===0){
      ech.statut=ech.date_echeance<=today()?'EN_RETARD':'A_VENIR';
      ech.revue_requise=false;ech.raison_ambiguite=null;
    } else if(traitesLiees.length===1){
      if(montantPaye===ech.montant){ech.statut='PAYEE';ech.revue_requise=false;ech.raison_ambiguite=null;}
      else if(montantPaye<ech.montant){ech.statut='PARTIELLE';ech.revue_requise=false;ech.raison_ambiguite=null;}
      else {ech.statut='PARTIELLE';ech.revue_requise=true;ech.raison_ambiguite='montant_paye_superieur_au_montant_attendu';}
    } else {
      ech.statut='PARTIELLE';ech.revue_requise=true;ech.raison_ambiguite='plusieurs_paiements_meme_echeance';
    }
  }

  // Validation des liens véhicule/financement/échéance — une seule implémentation,
  // réutilisée par la création de traite (2B) ET la création d'avance (2C).
  // Rejette toute incohérence (Véhicule A + Financement A + Échéance B, etc.)
  // avant toute écriture.
  function validerLienEcheance(db,vehiculeId,financementId,echeanceId){
    const echeance=db.echeances.find(e=>e.id===echeanceId);
    if(!echeance) return {ok:false,detail:'Échéance introuvable'};
    const financement=db.financements.find(f=>f.id===financementId);
    if(!financement) return {ok:false,detail:'Financement introuvable'};
    if(echeance.financement_id!==financement.id) return {ok:false,detail:'Cette échéance n\'appartient pas à ce financement'};
    if(financement.vehicule_id!==vehiculeId) return {ok:false,detail:'Ce financement ne correspond pas à ce véhicule'};
    if(echeance.vehicule_id!==vehiculeId) return {ok:false,detail:'Cette échéance ne correspond pas à ce véhicule'};
    return {ok:true,echeance,financement};
  }

  // Recettes imputées (FIFO, imputation.js — logique unique partagée) pour un
  // véhicule sur une période donnée (YYYY-MM). Même appel que la fiche véhicule.
  function calculerRecettesPeriode(db,vehiculeId,periode){
    const vFacsAll=db.facturations.filter(f=>f.vehicule_id===vehiculeId);
    const vAffIds=db.affectations.filter(a=>a.vehicule_id===vehiculeId).map(a=>a.id);
    const vVersAll=db.versements.filter(vs=>vAffIds.includes(vs.affectation_id));
    const facsPeriode=vFacsAll.filter(f=>(f.date||'').slice(0,7)===periode).map(f=>f.id);
    return imputerVersements(vFacsAll,vVersAll,facsPeriode,null).encImpute;
  }

  // Complément potentiel pour UNE échéance donnée (pas seulement le mois courant) —
  // Phase Financement 2C. Purement informatif : ne crée jamais d'écriture.
  // max(0, montant_restant_echeance - recettes_disponibles), §3 du feu vert.
  function calculerComplementEcheance(db,echeanceId){
    const echeance=db.echeances.find(e=>e.id===echeanceId);
    if(!echeance) return null;
    const recettesPeriode=calculerRecettesPeriode(db,echeance.vehicule_id,echeance.periode);
    // Recettes déjà "consommées" par une vraie traite ne doivent pas réduire le
    // complément une seconde fois — sinon une échéance déjà partiellement payée
    // par traite semblerait n'avoir besoin d'aucune avance alors qu'elle en a
    // encore besoin (les recettes ne sont comptées qu'une fois : soit via la
    // traite réellement enregistrée, soit via le complément proposé, jamais les deux).
    const recettesDisponibles=Math.max(0,recettesPeriode-echeance.montant_paye);
    const montantRestant=Math.max(0,echeance.montant-echeance.montant_paye-echeance.montant_complete);
    const complementPotentiel=Math.max(0,montantRestant-recettesDisponibles);
    return {echeance_id:echeance.id,periode:echeance.periode,montant_du:echeance.montant,
      montant_restant:montantRestant,recettes_periode:recettesPeriode,complement_potentiel:complementPotentiel};
  }

  // Recalcule les compteurs agrégés d'un financement à partir des traites (non
  // annulées) qui lui sont rattachées. Mêmes formules qu'à la migration
  // (migrate_financement.js) : solde = montant_finance - Σ traites payées, statut
  // SOLDE si solde<=0, EN_RETARD si la date de fin est dépassée, sinon EN_COURS.
  // Nécessaire pour que la fiche de consultation (Phase 2A), qui lit ces champs
  // directement, reste exacte une fois que de vraies traites commencent à arriver.
  function recalculerFinancement(db,financementId){
    const fin=db.financements.find(f=>f.id===financementId);
    if(!fin) return;
    const traitesLiees=db.traites.filter(t=>t.financement_id===financementId&&!t.annule);
    const totalPaye=traitesLiees.reduce((s,t)=>s+(Number(t.montant)||0),0);
    fin.solde_financement_restant=Math.max(0,fin.montant_finance-totalPaye);
    const echeancesFin=db.echeances.filter(e=>e.financement_id===financementId);
    fin.traites_payees=echeancesFin.filter(e=>e.statut==='PAYEE'||e.statut==='COMPLETEE_PAR_AVANCE').length;
    fin.traites_restantes=Math.max(0,fin.nombre_traites-fin.traites_payees);
    if(fin.solde_financement_restant<=0) fin.statut='SOLDE';
    else if(today()>fin.date_fin) fin.statut='EN_RETARD';
    else fin.statut='EN_COURS';
    fin.updated_at=new Date().toISOString();
  }

  if(p==='/api/traites'&&method==='POST'){
    if(!canWrite){res.writeHead(403);return res.end(JSON.stringify({detail:'Refusé'}));}
    if(!data.vehicule_id) return res.end(JSON.stringify({detail:'Véhicule obligatoire'}));
    if(isGest&&!gestPeutVoirVehicule(db,auth,data.vehicule_id)){res.writeHead(403);return res.end(JSON.stringify({detail:'Véhicule non assigné'}));}
    const montant=Number(data.montant)||0;
    if(!montant) return res.end(JSON.stringify({detail:'Montant obligatoire'}));

    // Idempotence : rejouer le même operation_id renvoie le résultat déjà obtenu,
    // sans rien créer de plus. Vérifié avant toute validation/mutation.
    if(data.operation_id){
      const existant=db.traites.find(t=>t.operation_id===data.operation_id);
      if(existant) return res.end(JSON.stringify({id:existant.id,message:'Traite déjà enregistrée (opération rejouée)',rejoue:true}));
    }

    // Lien financement/échéance (facultatif) — validation complète AVANT toute
    // écriture : si une incohérence est détectée, rien n'est jamais muté ni
    // sauvegardé ("rollback" = ne rien écrire tant que tout n'est pas validé).
    let financement=null,echeance=null;
    if(data.echeance_id||data.financement_id){
      if(!data.echeance_id||!data.financement_id) return res.end(JSON.stringify({detail:'echeance_id et financement_id doivent être fournis ensemble'}));
      const v=validerLienEcheance(db,data.vehicule_id,data.financement_id,data.echeance_id);
      if(!v.ok) return res.end(JSON.stringify({detail:v.detail}));
      echeance=v.echeance;financement=v.financement;
    }

    // Écriture — tout ou rien : un seul saveDB() en fin de bloc, aucun `await`
    // entre ce point et saveDB, donc rien ne peut interrompre ce bloc au milieu
    // (event loop mono-thread) : deux requêtes ne peuvent jamais s'entrelacer ici.
    const t={id:uid(),vehicule_id:data.vehicule_id,mois:data.mois||today().slice(0,7),montant,
      date_paiement:data.date_paiement||today(),note:data.note||'',
      auteur:isGest?auth.gest.nom:'Manager',created_at:new Date().toISOString()};
    if(data.operation_id) t.operation_id=data.operation_id;
    if(financement) t.financement_id=financement.id;
    if(echeance) t.echeance_id=echeance.id;
    db.traites.push(t);
    if(echeance){recalculerEcheance(db,echeance.id);recalculerFinancement(db,financement.id);}
    saveDB(db);
    return res.end(JSON.stringify({id:t.id,message:'Traite enregistrée',
      echeance:echeance?db.echeances.find(e=>e.id===echeance.id):null}));
  }
  const trM=p.match(/^\/api\/traites\/([^/]+)$/);
  if(trM&&method==='DELETE'){
    if(!canWrite){res.writeHead(403);return res.end(JSON.stringify({detail:'Refusé'}));}
    const tExist=db.traites.find(t=>t.id===trM[1]);
    if(!tExist){res.writeHead(404);return res.end(JSON.stringify({detail:'Introuvable'}));}
    if(isGest&&!vehsVisibles(db,auth).map(v=>v.id).includes(tExist.vehicule_id)){res.writeHead(403);return res.end(JSON.stringify({detail:'Refusé'}));}
    if(tExist.echeance_id){
      // Traite rattachée à une échéance (Phase Financement 2B) : jamais de
      // suppression physique — annulation auditable, conservée pour l'historique.
      if(tExist.annule) return res.end(JSON.stringify({detail:'Déjà annulée'}));
      tExist.annule=true;tExist.annule_par=isGest?auth.gest.nom:'Manager';
      tExist.annule_le=new Date().toISOString();tExist.annule_motif=data.motif||'';
      recalculerEcheance(db,tExist.echeance_id);
      if(tExist.financement_id) recalculerFinancement(db,tExist.financement_id);
      saveDB(db);
      return res.end(JSON.stringify({message:'Traite annulée (conservée pour l\'historique)',annule:true,
        echeance:db.echeances.find(e=>e.id===tExist.echeance_id)}));
    }
    // Traite "ancien style" (non rattachée à une échéance) : suppression physique inchangée.
    db.traites=db.traites.filter(t=>t.id!==trM[1]);
    saveDB(db);return res.end(JSON.stringify({message:'Supprimé'}));
  }

  // ── CALCUL CRÉDIT (solde restant, retard) ───────────────────
  const creditM=p.match(/^\/api\/vehicules\/([^/]+)\/credit_calcul$/);
  if(creditM&&method==='GET'){
    const veh=db.vehicules.find(v=>v.id===creditM[1]);
    if(!veh){res.writeHead(404);return res.end(JSON.stringify({detail:'Introuvable'}));}
    if(!vehsVisibles(db,auth).map(v=>v.id).includes(creditM[1])){res.writeHead(403);return res.end(JSON.stringify({detail:'Refusé'}));}
    if(!veh.achat_credit) return res.end(JSON.stringify({detail:'Ce véhicule n\'est pas à crédit'}));
    const prixTotal=Number(veh.credit_prix_total)||0;
    const apportPct=Number(veh.credit_apport_pct)||0;
    const dureeMois=Number(veh.credit_duree_mois)||0;
    const traiteMensuelle=Number(veh.credit_traite_mensuelle)||0;
    const apportMontant=Math.round(prixTotal*apportPct/100);
    const montantFinance=prixTotal-apportMontant;
    const traites=db.traites.filter(t=>t.vehicule_id===creditM[1]);
    const totalPaye=traites.reduce((s,t)=>s+t.montant,0);
    let moisEcoules=0;
    if(veh.credit_date_debut){
      const debut=new Date(veh.credit_date_debut);
      const now=new Date();
      moisEcoules=(now.getFullYear()-debut.getFullYear())*12+(now.getMonth()-debut.getMonth())+1;
      moisEcoules=Math.max(0,Math.min(moisEcoules,dureeMois||moisEcoules));
    }
    const totalAttendu=Math.min(montantFinance,moisEcoules*traiteMensuelle);
    const retard=Math.max(0,totalAttendu-totalPaye);
    const soldeRestant=Math.max(0,montantFinance-totalPaye);
    const nbTraitesPayees=traites.length;
    return res.end(JSON.stringify({vehicule_id:creditM[1],prix_total:prixTotal,apport_montant:apportMontant,montant_finance:montantFinance,
      duree_mois:dureeMois,traite_mensuelle:traiteMensuelle,mois_ecoules:moisEcoules,nb_traites_payees:nbTraitesPayees,
      total_paye:totalPaye,total_attendu:totalAttendu,retard,solde_restant:soldeRestant,
      solde_avant_apport:prixTotal-apportMontant}));
  }

  // ── FINANCEMENT — fiche + échéancier (Phase Financement 2A, LECTURE SEULE) ──
  // N'écrit jamais db.financements/db.echeances : affiche uniquement ce que la
  // migration (ou une future étape d'écriture) y a déjà placé. Les recettes sont
  // calculées via imputation.js, la même logique partagée que la fiche véhicule —
  // aucune deuxième implémentation, aucun recalcul du rapprochement traites/échéances ici.
  const financementM=p.match(/^\/api\/vehicules\/([^/]+)\/financement$/);
  if(financementM&&method==='GET'){
    const veh=db.vehicules.find(v=>v.id===financementM[1]);
    if(!veh){res.writeHead(404);return res.end(JSON.stringify({detail:'Introuvable'}));}
    if(!vehsVisibles(db,auth).map(v=>v.id).includes(financementM[1])){res.writeHead(403);return res.end(JSON.stringify({detail:'Refusé'}));}
    const finsVeh=(db.financements||[]).filter(f=>f.vehicule_id===financementM[1]);
    const fin=finsVeh.find(f=>f.statut==='EN_COURS')||finsVeh.find(f=>f.statut==='EN_RETARD')||
      finsVeh.slice().sort((a,b)=>(b.date_debut||'').localeCompare(a.date_debut||''))[0]||null;
    if(!fin){
      return res.end(JSON.stringify({vehicule_id:financementM[1],immatriculation:veh.immatriculation,financement:null,
        message:'Aucun financement pour ce véhicule'}));
    }
    const echeances=(db.echeances||[]).filter(e=>e.financement_id===fin.id).sort((a,b)=>a.periode.localeCompare(b.periode));
    const echeancesPayees=echeances.filter(e=>e.statut==='PAYEE'||e.statut==='COMPLETEE_PAR_AVANCE').length;
    const echeancesEnRetard=echeances.filter(e=>e.statut==='EN_RETARD').length;
    const echeancesAVenir=echeances.filter(e=>e.statut==='A_VENIR').length;
    const echeancesRestantes=echeances.length-echeancesPayees;

    const moisActuel=today().slice(0,7);
    const echeanceCourante=echeances.find(e=>e.periode===moisActuel)||null;
    // Calcul partagé (Phase Financement 2C) : la fiche véhicule (mois courant)
    // et la création d'avance (n'importe quelle échéance) utilisent la même
    // fonction — aucune deuxième implémentation du complément potentiel.
    const echeanceCouranteInfo=echeanceCourante?calculerComplementEcheance(db,echeanceCourante.id):null;

    return res.end(JSON.stringify({
      vehicule_id:financementM[1],immatriculation:veh.immatriculation,
      financement:{
        id:fin.id,financeur:fin.financeur,prix_achat:fin.prix_achat,apport_pct:fin.apport_pct,apport_montant:fin.apport_montant,
        montant_finance:fin.montant_finance,nombre_traites:fin.nombre_traites,montant_traite:fin.montant_traite,
        date_debut:fin.date_debut,date_fin:fin.date_fin,solde_financement_restant:fin.solde_financement_restant,statut:fin.statut,
        echeances_payees:echeancesPayees,echeances_restantes:echeancesRestantes,
        echeances_en_retard:echeancesEnRetard,echeances_a_venir:echeancesAVenir
      },
      echeances:echeances.map(e=>({id:e.id,periode:e.periode,date_echeance:e.date_echeance,montant:e.montant,
        montant_paye:e.montant_paye,montant_complete:e.montant_complete,
        reste:Math.max(0,e.montant-e.montant_paye-e.montant_complete),statut:e.statut,revue_requise:!!e.revue_requise})),
      echeance_courante:echeanceCouranteInfo
    }));
  }

  // ── COMPLÉMENT D'ÉCHÉANCE — Phase Financement 2C, LECTURE SEULE ──
  // Généralise echeance_courante (2A, limité au mois en cours) à N'IMPORTE QUELLE
  // échéance : nécessaire pour proposer un montant avant de créer une avance.
  // Purement informatif — ne crée jamais d'écriture.
  const complementM=p.match(/^\/api\/echeances\/([^/]+)\/complement$/);
  if(complementM&&method==='GET'){
    const echeance=db.echeances.find(e=>e.id===complementM[1]);
    if(!echeance){res.writeHead(404);return res.end(JSON.stringify({detail:'Introuvable'}));}
    if(!vehsVisibles(db,auth).map(v=>v.id).includes(echeance.vehicule_id)){res.writeHead(403);return res.end(JSON.stringify({detail:'Refusé'}));}
    return res.end(JSON.stringify(calculerComplementEcheance(db,echeance.id)));
  }

  // ── AVANCES DE FINANCEMENT — Phase Financement 2C ──
  // Une avance : argent que l'entreprise avance à la place du véhicule/chauffeur
  // pour compléter une échéance quand les recettes ne suffisent pas. TOUJOURS une
  // action manuelle explicite — jamais créée automatiquement. N'est ni une dépense,
  // ni une recette, ni une facturation : reste entièrement dans db.avances[].
  if(p==='/api/avances'&&method==='GET'){
    const myVehs=vehsVisibles(db,auth).map(v=>v.id);
    let list=(db.avances||[]).filter(a=>myVehs.includes(a.vehicule_id));
    if(q.vehicule_id) list=list.filter(a=>a.vehicule_id===q.vehicule_id);
    // Enrichissement en LECTURE SEULE (période de l'échéance) — jamais stocké sur
    // l'avance elle-même, uniquement calculé à l'affichage pour éviter toute
    // deuxième source de vérité.
    const withReste=list.map(a=>{
      const ech=db.echeances.find(e=>e.id===a.echeance_id);
      return Object.assign({},a,{reste_a_rembourser:Math.max(0,a.montant-(a.montant_rembourse||0)),periode:ech?ech.periode:null});
    });
    return res.end(JSON.stringify(withReste.slice(-500).reverse()));
  }
  if(p==='/api/avances'&&method==='POST'){
    if(!canWrite){res.writeHead(403);return res.end(JSON.stringify({detail:'Refusé'}));}
    if(!data.vehicule_id) return res.end(JSON.stringify({detail:'Véhicule obligatoire'}));
    if(isGest&&!gestPeutVoirVehicule(db,auth,data.vehicule_id)){res.writeHead(403);return res.end(JSON.stringify({detail:'Véhicule non assigné'}));}
    if(!data.financement_id||!data.echeance_id) return res.end(JSON.stringify({detail:'financement_id et echeance_id obligatoires pour une avance'}));
    const montant=Number(data.montant)||0;
    if(montant<=0) return res.end(JSON.stringify({detail:'Le montant doit être supérieur à 0'}));
    const MOTIFS_AVANCE=['RECETTES_INSUFFISANTES','PANNE_PROLONGEE','IMMOBILISATION','RETARD_ACTIVITE','AUTRE'];
    if(!MOTIFS_AVANCE.includes(data.motif)) return res.end(JSON.stringify({detail:'Motif invalide ou manquant'}));
    if(data.motif==='AUTRE'&&!(data.commentaire||'').trim()) return res.end(JSON.stringify({detail:'Commentaire obligatoire si motif = AUTRE'}));

    // Idempotence : rejouer le même operation_id renvoie le résultat déjà obtenu.
    if(data.operation_id){
      const existante=(db.avances||[]).find(a=>a.operation_id===data.operation_id);
      if(existante) return res.end(JSON.stringify({id:existante.id,message:'Avance déjà enregistrée (opération rejouée)',rejoue:true}));
    }

    // Lien véhicule/financement/échéance — même validation que les traites (2B),
    // une seule implémentation (validerLienEcheance). Rejet avant toute écriture.
    const lien=validerLienEcheance(db,data.vehicule_id,data.financement_id,data.echeance_id);
    if(!lien.ok) return res.end(JSON.stringify({detail:lien.detail}));
    const {echeance,financement}=lien;

    // Plafond métier : une avance ne peut jamais dépasser le complément réellement
    // nécessaire à CET INSTANT (dû restant − recettes déjà disponibles). C'est ce
    // plafond, recalculé à chaque nouvelle avance, qui empêche mécaniquement un
    // double comptage du même déficit (§10 du feu vert) sans avoir besoin d'une
    // règle de "doublon" séparée : dès que le déficit réel est couvert, le plafond
    // suivant vaut 0 et toute nouvelle avance positive est refusée.
    const complement=calculerComplementEcheance(db,echeance.id);
    if(montant>complement.complement_potentiel){
      return res.end(JSON.stringify({detail:'Montant supérieur au complément nécessaire ('+complement.complement_potentiel+' F restant à couvrir sur cette échéance)'}));
    }

    const a={id:uid(),vehicule_id:data.vehicule_id,financement_id:financement.id,echeance_id:echeance.id,
      montant,date:data.date||today(),motif:data.motif,commentaire:data.commentaire||'',
      statut:'EN_COURS',montant_rembourse:0,
      cree_par:isGest?auth.gest.nom:'Manager',auteur:isGest?auth.gest.nom:'Manager',
      created_at:new Date().toISOString()};
    if(data.operation_id) a.operation_id=data.operation_id;
    db.avances.push(a);
    recalculerEcheance(db,echeance.id);
    recalculerFinancement(db,financement.id);
    saveDB(db);
    return res.end(JSON.stringify({id:a.id,message:'Avance enregistrée',avance:a,
      echeance:db.echeances.find(e=>e.id===echeance.id)}));
  }
  const avM=p.match(/^\/api\/avances\/([^/]+)$/);
  if(avM&&method==='DELETE'){
    if(!canWrite){res.writeHead(403);return res.end(JSON.stringify({detail:'Refusé'}));}
    const aExist=(db.avances||[]).find(a=>a.id===avM[1]);
    if(!aExist){res.writeHead(404);return res.end(JSON.stringify({detail:'Introuvable'}));}
    if(isGest&&!vehsVisibles(db,auth).map(v=>v.id).includes(aExist.vehicule_id)){res.writeHead(403);return res.end(JSON.stringify({detail:'Refusé'}));}
    if(aExist.annule) return res.end(JSON.stringify({detail:'Déjà annulée'}));
    if(aExist.statut==='PARTIELLEMENT_REMBOURSEE'||aExist.statut==='REMBOURSEE'){
      return res.end(JSON.stringify({detail:'Impossible d\'annuler une avance déjà (partiellement) remboursée'}));
    }
    // Jamais de suppression physique — annulation auditable, conservée pour l'historique.
    aExist.annule=true;aExist.statut='ANNULEE';
    aExist.annule_par=isGest?auth.gest.nom:'Manager';aExist.annule_le=new Date().toISOString();
    aExist.annule_motif=data.motif||'';
    recalculerEcheance(db,aExist.echeance_id);
    recalculerFinancement(db,aExist.financement_id);
    saveDB(db);
    return res.end(JSON.stringify({message:'Avance annulée (conservée pour l\'historique)',annule:true,
      echeance:db.echeances.find(e=>e.id===aExist.echeance_id)}));
  }

  // ── REMBOURSEMENTS D'AVANCE — Phase Financement 2D ──
  // Un remboursement est l'argent que le véhicule/chauffeur rend à l'entreprise
  // pour solder une avance. Ce n'est ni une traite, ni une recette, ni une
  // facturation, ni une dépense — il ne touche QUE db.avances/db.remboursements_avance,
  // jamais db.echeances (echeance.montant reste inchangé, montant_paye n'est
  // jamais confondu avec un remboursement).
  //
  // Recalcule montant_rembourse/statut d'une avance à partir de la somme de ses
  // remboursements. Ne touche jamais echeance.montant ni montant_paye.
  function recalculerAvance(db,avanceId){
    const av=(db.avances||[]).find(a=>a.id===avanceId);
    if(!av||av.annule) return;
    const rembs=(db.remboursements_avance||[]).filter(r=>r.avance_id===avanceId);
    const montantRembourse=rembs.reduce((s,r)=>s+(Number(r.montant)||0),0);
    av.montant_rembourse=montantRembourse;
    const reste=Math.max(0,av.montant-montantRembourse);
    if(reste<=0) av.statut='REMBOURSEE';
    else if(montantRembourse>0) av.statut='PARTIELLEMENT_REMBOURSEE';
    else av.statut='EN_COURS';
  }

  if(p==='/api/remboursements_avance'&&method==='GET'){
    const myVehs=vehsVisibles(db,auth).map(v=>v.id);
    let list=(db.remboursements_avance||[]).filter(r=>myVehs.includes(r.vehicule_id));
    if(q.avance_id) list=list.filter(r=>r.avance_id===q.avance_id);
    if(q.vehicule_id) list=list.filter(r=>r.vehicule_id===q.vehicule_id);
    return res.end(JSON.stringify(list.slice(-500).reverse()));
  }
  if(p==='/api/remboursements_avance'&&method==='POST'){
    if(!canWrite){res.writeHead(403);return res.end(JSON.stringify({detail:'Refusé'}));}
    if(!data.avance_id) return res.end(JSON.stringify({detail:'avance_id obligatoire'}));
    const av=(db.avances||[]).find(a=>a.id===data.avance_id);
    if(!av){res.writeHead(404);return res.end(JSON.stringify({detail:'Avance introuvable'}));}
    if(isGest&&!gestPeutVoirVehicule(db,auth,av.vehicule_id)){res.writeHead(403);return res.end(JSON.stringify({detail:'Véhicule non assigné'}));}
    const montant=Number(data.montant)||0;
    if(montant<=0) return res.end(JSON.stringify({detail:'Le montant doit être supérieur à 0'}));
    if(av.annule) return res.end(JSON.stringify({detail:'Cette avance est annulée'}));
    if(av.statut==='REMBOURSEE') return res.end(JSON.stringify({detail:'Cette avance est déjà entièrement remboursée'}));

    // Idempotence : rejouer le même operation_id renvoie le résultat déjà obtenu.
    if(data.operation_id){
      const existant=(db.remboursements_avance||[]).find(r=>r.operation_id===data.operation_id);
      if(existant) return res.end(JSON.stringify({id:existant.id,message:'Remboursement déjà enregistré (opération rejouée)',rejoue:true}));
    }

    // Plafond, recalculé à l'instant (jamais depuis une valeur mise en cache) :
    // même garantie qu'en 2B/2C — aucun `await` entre cette lecture et saveDB,
    // donc deux requêtes concurrentes ne peuvent jamais s'entrelacer ici.
    const resteActuel=Math.max(0,av.montant-(av.montant_rembourse||0));
    if(montant>resteActuel){
      return res.end(JSON.stringify({detail:'Montant supérieur au reste à rembourser ('+resteActuel+' F restant)'}));
    }

    const r={id:uid(),avance_id:av.id,vehicule_id:av.vehicule_id,montant,
      date:data.date||today(),mode_paiement:data.mode_paiement||'especes',commentaire:data.commentaire||'',
      cree_par:isGest?auth.gest.nom:'Manager',auteur:isGest?auth.gest.nom:'Manager',created_at:new Date().toISOString()};
    if(data.operation_id) r.operation_id=data.operation_id;
    db.remboursements_avance.push(r);
    recalculerAvance(db,av.id);
    saveDB(db);
    return res.end(JSON.stringify({id:r.id,message:'Remboursement enregistré',remboursement:r,
      avance:db.avances.find(a=>a.id===av.id)}));
  }

  // ── RENTABILITÉ — Phase Financement 2E-1 ────────────────────────────────
  // Couche analytique STRICTEMENT en lecture : ces fonctions ne mutent jamais
  // `db` et n'appellent jamais saveDB(). Elles ne recalculent rien qui existe
  // déjà ailleurs (recettes réutilise imputation.js tel quel) et ne créent
  // aucune nouvelle collection. Trois niveaux, jamais mélangés :
  //   1. Résultat opérationnel      = recettes − dépenses (identique à l'existant)
  //   2. Résultat après financement = niveau 1 − traites RÉELLEMENT payées
  //   3. Trésorerie / créance       = avances / remboursements — jamais dans 1 ou 2

  function calculerRentabiliteVehicule(db,vehiculeId,dateDebut,dateFin){
    const vFacsAll=db.facturations.filter(f=>f.vehicule_id===vehiculeId);
    const vAffIds=db.affectations.filter(a=>a.vehicule_id===vehiculeId).map(a=>a.id);
    const vVersAll=db.versements.filter(vs=>vAffIds.includes(vs.affectation_id));
    const facsPeriodeIds=vFacsAll.filter(f=>(f.date||'')>=dateDebut&&(f.date||'')<=dateFin).map(f=>f.id);
    const recettes=imputerVersements(vFacsAll,vVersAll,facsPeriodeIds,null).encImpute;

    const depensesPeriode=db.depenses.filter(d=>d.vehicule_id===vehiculeId&&(d.date_depense||'')>=dateDebut&&(d.date_depense||'')<=dateFin);
    const depenses=depensesPeriode.reduce((s,d)=>s+(Number(d.montant)||0),0);
    const resultatOperationnel=recettes-depenses;

    const traitesPeriode=(db.traites||[]).filter(t=>t.vehicule_id===vehiculeId&&!t.annule&&(t.date_paiement||'')>=dateDebut&&(t.date_paiement||'')<=dateFin);
    const traitesMontant=traitesPeriode.reduce((s,t)=>s+(Number(t.montant)||0),0);
    const resultatApresFinancement=resultatOperationnel-traitesMontant;

    const avancesVeh=(db.avances||[]).filter(a=>a.vehicule_id===vehiculeId&&!a.annule);
    const avancesAccordeesPeriode=avancesVeh.filter(a=>(a.date||'')>=dateDebut&&(a.date||'')<=dateFin).reduce((s,a)=>s+(Number(a.montant)||0),0);
    const rembVeh=(db.remboursements_avance||[]).filter(r=>r.vehicule_id===vehiculeId);
    const remboursementsRecusPeriode=rembVeh.filter(r=>(r.date||'')>=dateDebut&&(r.date||'')<=dateFin).reduce((s,r)=>s+(Number(r.montant)||0),0);
    const creanceRestanteCumulative=avancesVeh.reduce((s,a)=>s+Math.max(0,(Number(a.montant)||0)-(Number(a.montant_rembourse)||0)),0);

    const finsVeh=(db.financements||[]).filter(f=>f.vehicule_id===vehiculeId);
    const finVeh=finsVeh.find(f=>f.statut==='EN_COURS')||finsVeh.find(f=>f.statut==='EN_RETARD')||
      finsVeh.slice().sort((a,b)=>(b.date_debut||'').localeCompare(a.date_debut||''))[0]||null;

    return {vehicule_id:vehiculeId,periode:{debut:dateDebut,fin:dateFin},
      recettes,depenses,resultat_operationnel:resultatOperationnel,
      traites_periode:traitesMontant,resultat_apres_financement:resultatApresFinancement,
      avances_accordees_periode:avancesAccordeesPeriode,remboursements_recus_periode:remboursementsRecusPeriode,
      creance_restante_cumulative:creanceRestanteCumulative,
      financement:finVeh?{id:finVeh.id,statut:finVeh.statut,montant_traite:finVeh.montant_traite,
        solde_financement_restant:finVeh.solde_financement_restant}:null};
  }

  function calculerRentabiliteFinancement(db,financementId){
    const fin=(db.financements||[]).find(f=>f.id===financementId);
    if(!fin) return null;
    const echeancesFin=(db.echeances||[]).filter(e=>e.financement_id===financementId);
    const totalTraites=(db.traites||[]).filter(t=>t.financement_id===financementId&&!t.annule).reduce((s,t)=>s+(Number(t.montant)||0),0);
    const avancesFin=(db.avances||[]).filter(a=>a.financement_id===financementId&&!a.annule);
    const totalAvances=avancesFin.reduce((s,a)=>s+(Number(a.montant)||0),0);
    const totalRemboursements=avancesFin.reduce((s,a)=>s+(Number(a.montant_rembourse)||0),0);
    const avanceEncoreDue=avancesFin.reduce((s,a)=>s+Math.max(0,(Number(a.montant)||0)-(Number(a.montant_rembourse)||0)),0);
    return {financement:{id:fin.id,vehicule_id:fin.vehicule_id,prix_achat:fin.prix_achat,apport_montant:fin.apport_montant,
        montant_finance:fin.montant_finance,nombre_traites:fin.nombre_traites,montant_traite:fin.montant_traite,statut:fin.statut},
      echeances_payees:echeancesFin.filter(e=>e.statut==='PAYEE').length,
      echeances_partielles:echeancesFin.filter(e=>e.statut==='PARTIELLE').length,
      echeances_completees_par_avance:echeancesFin.filter(e=>e.statut==='COMPLETEE_PAR_AVANCE').length,
      total_traites:totalTraites,total_avances:totalAvances,total_remboursements:totalRemboursements,
      avance_encore_due:avanceEncoreDue,solde_financement_restant:fin.solde_financement_restant};
  }

  function calculerRentabiliteFlotte(db,auth,dateDebut,dateFin){
    const vehs=vehsVisibles(db,auth);
    const vehicules=vehs.map(v=>Object.assign({immatriculation:v.immatriculation},calculerRentabiliteVehicule(db,v.id,dateDebut,dateFin)));
    const kpis=vehicules.reduce((acc,l)=>{
      acc.ca+=l.recettes;acc.depenses+=l.depenses;acc.resultat_operationnel+=l.resultat_operationnel;
      acc.echeances+=l.traites_periode;acc.avances_accordees+=l.avances_accordees_periode;
      acc.remboursements_recus+=l.remboursements_recus_periode;acc.avances_dues+=l.creance_restante_cumulative;
      return acc;
    },{ca:0,depenses:0,resultat_operationnel:0,echeances:0,avances_accordees:0,remboursements_recus:0,avances_dues:0});
    return {kpis,vehicules};
  }

  // Diagnostic de cohérence — vérifie STRUCTURELLEMENT (pas juste en test) que le
  // moteur de rentabilité ne mélange jamais avance/dépense, remboursement/recette,
  // échéance/dépense, ou ne double-compte rien. Recalculé à la demande, jamais mis en cache.
  function diagnostiquerCoherenceRentabilite(db,vehiculeId,dateDebut,dateFin){
    const r=calculerRentabiliteVehicule(db,vehiculeId,dateDebut,dateFin);

    const idsAvances=new Set((db.avances||[]).filter(a=>a.vehicule_id===vehiculeId).map(a=>a.id));
    const depensesPeriode=db.depenses.filter(d=>d.vehicule_id===vehiculeId&&(d.date_depense||'')>=dateDebut&&(d.date_depense||'')<=dateFin);
    const avanceCompteeCommeDepense=depensesPeriode.some(d=>idsAvances.has(d.id)||idsAvances.has(d.avance_id));

    const idsRemb=new Set((db.remboursements_avance||[]).filter(rb=>rb.vehicule_id===vehiculeId).map(rb=>rb.id));
    const vFacsAll=db.facturations.filter(f=>f.vehicule_id===vehiculeId);
    const vAffIds=db.affectations.filter(a=>a.vehicule_id===vehiculeId).map(a=>a.id);
    const vVersAll=db.versements.filter(vs=>vAffIds.includes(vs.affectation_id));
    const remboursementCompteCommeRecette=vFacsAll.some(f=>idsRemb.has(f.id))||vVersAll.some(vs=>idsRemb.has(vs.id));

    const echeancesVeh=(db.echeances||[]).filter(e=>e.vehicule_id===vehiculeId);
    const echeanceModifiee=echeancesVeh.some(e=>{
      const fin=(db.financements||[]).find(f=>f.id===e.financement_id);
      return fin&&e.montant!==fin.montant_traite;
    });
    const doubleComptageDetecte=echeancesVeh.some(e=>(Number(e.montant_paye)||0)+(Number(e.montant_complete)||0)>e.montant);

    return {vehicule_id:vehiculeId,periode:{debut:dateDebut,fin:dateFin},
      recettes:r.recettes,depenses_operationnelles:r.depenses,
      financement:{echeance:r.financement?r.financement.montant_traite:null,traites_periode:r.traites_periode},
      avances:{avance_periode:r.avances_accordees_periode,rembourse_periode:r.remboursements_recus_periode,creance_a_date:r.creance_restante_cumulative},
      controle:{avance_comptee_comme_depense:avanceCompteeCommeDepense,
        remboursement_compte_comme_recette:remboursementCompteCommeRecette,
        echeance_modifiee:echeanceModifiee,double_comptage_detecte:doubleComptageDetecte}};
  }

  if(p==='/api/rentabilite/flotte'&&method==='GET'){
    return res.end(JSON.stringify(calculerRentabiliteFlotte(db,auth,q.date_debut||'0000-00-00',q.date_fin||'9999-99-99')));
  }
  const rentVehM=p.match(/^\/api\/vehicules\/([^/]+)\/rentabilite$/);
  if(rentVehM&&method==='GET'){
    const veh=db.vehicules.find(v=>v.id===rentVehM[1]);
    if(!veh){res.writeHead(404);return res.end(JSON.stringify({detail:'Introuvable'}));}
    if(!vehsVisibles(db,auth).map(v=>v.id).includes(rentVehM[1])){res.writeHead(403);return res.end(JSON.stringify({detail:'Refusé'}));}
    return res.end(JSON.stringify(calculerRentabiliteVehicule(db,rentVehM[1],q.date_debut||'0000-00-00',q.date_fin||'9999-99-99')));
  }
  const rentDiagM=p.match(/^\/api\/vehicules\/([^/]+)\/rentabilite\/diagnostic$/);
  if(rentDiagM&&method==='GET'){
    const veh=db.vehicules.find(v=>v.id===rentDiagM[1]);
    if(!veh){res.writeHead(404);return res.end(JSON.stringify({detail:'Introuvable'}));}
    if(!vehsVisibles(db,auth).map(v=>v.id).includes(rentDiagM[1])){res.writeHead(403);return res.end(JSON.stringify({detail:'Refusé'}));}
    return res.end(JSON.stringify(diagnostiquerCoherenceRentabilite(db,rentDiagM[1],q.date_debut||'0000-00-00',q.date_fin||'9999-99-99')));
  }
  const rentFinM=p.match(/^\/api\/financements\/([^/]+)\/rentabilite$/);
  if(rentFinM&&method==='GET'){
    const fin=(db.financements||[]).find(f=>f.id===rentFinM[1]);
    if(!fin){res.writeHead(404);return res.end(JSON.stringify({detail:'Introuvable'}));}
    if(!vehsVisibles(db,auth).map(v=>v.id).includes(fin.vehicule_id)){res.writeHead(403);return res.end(JSON.stringify({detail:'Refusé'}));}
    return res.end(JSON.stringify(calculerRentabiliteFinancement(db,rentFinM[1])));
  }

  // Génération (idempotente) des frais de gestion moto (commission + frais fixe/jour)
  // pour une facturation donnée, selon le tag du véhicule. Appelée à chaque création
  // OU mise à jour de facturation, quel que soit le point d'entrée (facturation simple,
  // facturation multiple, auto-facturation par statut) — recalcule proprement si le
  // montant ou le statut change, sans jamais dupliquer.
  function genererFraisMoto(db,f){
    db.depenses=db.depenses.filter(d=>!(d.facturation_id===f.id&&(d.categorie==='commission_yango'||d.categorie==='frais_gestion')));
    const vFrais=db.vehicules.find(v=>v.id===f.vehicule_id);
    const fraisCfg=db.config_frais_moto||{frais_gestion_jour:0,commission_pct:0,tags:[]};
    if(!vFrais||!(fraisCfg.tags||[]).includes(vFrais.tag)) return;
    const montantFac=Number(f.montant_facture)||0;
    const commission=Math.round(montantFac*(fraisCfg.commission_pct||0)/100);
    const fraisFixe=Number(fraisCfg.frais_gestion_jour)||0;
    if(commission>0){
      db.depenses.push({id:uid(),vehicule_id:f.vehicule_id,categorie:'commission_yango',montant:commission,
        description:'Commission de service auto ('+(fraisCfg.commission_pct||0)+'%) — facturation du '+f.date,
        auto_genere:true,facturation_id:f.id,payeur:'gestionnaire',date_depense:f.date,created_at:new Date().toISOString()});
    }
    if(fraisFixe>0){
      db.depenses.push({id:uid(),vehicule_id:f.vehicule_id,categorie:'frais_gestion',montant:fraisFixe,
        description:'Frais de gestion fixe (moto) — facturation du '+f.date,
        auto_genere:true,facturation_id:f.id,payeur:'gestionnaire',date_depense:f.date,created_at:new Date().toISOString()});
    }
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
    if(!peutFacturer(db,auth,data.vehicule_id)){res.writeHead(403);return res.end(JSON.stringify({detail:'Vous n\'avez pas la permission de facturer'}));}
    // Gestionnaire : vérifier que le véhicule lui est assigné (via tags ou ids)
    if(isGest){
      const myVehs=vehsVisibles(db,auth).map(v=>v.id);
      if(!myVehs.includes(data.vehicule_id)){res.writeHead(403);return res.end(JSON.stringify({detail:'Véhicule non assigné à votre compte'}));}
    }
    const existing=db.facturations.findIndex(f=>f.vehicule_id===data.vehicule_id&&f.date===data.date);
    if(existing!==-1){
      // Mise à jour si même véhicule/date (pas un vrai doublon — c'est une correction)
      db.facturations[existing]={...db.facturations[existing],...data,updated_at:new Date().toISOString()};
      genererFraisMoto(db,db.facturations[existing]);
      saveDB(db);
      return res.end(JSON.stringify({message:'Facturation mise à jour',id:db.facturations[existing].id,updated:true}));
    }
    const f={id:uid(),...data,created_at:new Date().toISOString()};
    db.facturations.push(f);
    genererFraisMoto(db,f);
    saveDB(db);return res.end(JSON.stringify({id:f.id,message:'Facturation enregistrée',updated:false}));
  }
  // MODIFIER une facturation
  const facM=p.match(/^\/api\/facturations\/([^/]+)$/);
  if(facM&&method==='PATCH'){
    if(!canWrite){res.writeHead(403);return res.end(JSON.stringify({detail:'Refus\u00e9'}));}
    const idx=db.facturations.findIndex(f=>f.id===facM[1]);
    if(idx===-1){res.writeHead(404);return res.end(JSON.stringify({detail:'Facturation introuvable'}));}
    if(!peutFacturer(db,auth,db.facturations[idx].vehicule_id)){res.writeHead(403);return res.end(JSON.stringify({detail:'Vous n\'avez pas la permission de facturer'}));}
    if(isGest&&!gestPeutVoirVehicule(db,auth,db.facturations[idx].vehicule_id)){res.writeHead(403);return res.end(JSON.stringify({detail:'V\u00e9hicule non assign\u00e9'}));}
    const old=db.facturations[idx];
    db.facturations[idx]={...old,...data,updated_at:new Date().toISOString()};
    genererFraisMoto(db,db.facturations[idx]);
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
    const fac=db.facturations.find(f=>f.id===facM[1]);
    if(!fac){res.writeHead(404);return res.end(JSON.stringify({detail:'Facturation introuvable'}));}
    if(!peutFacturer(db,auth,fac.vehicule_id)){res.writeHead(403);return res.end(JSON.stringify({detail:'Vous n\'avez pas la permission de facturer'}));}
    if(isGest&&!gestPeutVoirVehicule(db,auth,fac.vehicule_id)){res.writeHead(403);return res.end(JSON.stringify({detail:'V\u00e9hicule non assign\u00e9'}));}
    db.facturations=db.facturations.filter(f=>f.id!==facM[1]);
    db.depenses=db.depenses.filter(d=>!(d.facturation_id===facM[1]&&(d.categorie==='commission_yango'||d.categorie==='frais_gestion')));
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
    if(!peutFacturer(db,auth)){res.writeHead(403);return res.end(JSON.stringify({detail:'Vous n\'avez pas la permission de facturer'}));}
    const {vehicules_ids, type_journee, date} = data;
    if(!vehicules_ids||!vehicules_ids.length) return res.end(JSON.stringify({detail:'Aucun véhicule sélectionné'}));
    const results=[];
    for(const vid of vehicules_ids){
      if(isGest&&!gestPeutVoirVehicule(db,auth,vid)) continue;
      if(!peutFacturer(db,auth,vid)) continue;
      const aff=db.affectations.find(a=>a.vehicule_id===vid&&!a.date_fin);
      if(!aff) continue;
      const montant_base=aff.montant_journalier;
      const montant_facture=type_journee==='complet'?montant_base:type_journee==='demi_panne'?Math.round(montant_base/2):0;
      const existing=db.facturations.findIndex(f=>f.vehicule_id===vid&&f.date===date);
      const fac={id:existing!==-1?db.facturations[existing].id:uid(),vehicule_id:vid,chauffeur_id:aff.chauffeur_id,date,type_journee,montant_facture,montant_base,created_at:new Date().toISOString()};
      if(existing!==-1)db.facturations[existing]=fac;else db.facturations.push(fac);
      genererFraisMoto(db,fac);
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
    if(!peutEncaisser(db,auth,aff_active.vehicule_id)){res.writeHead(403);return res.end(JSON.stringify({detail:'Vous n\'avez pas la permission d\'encaisser'}));}
    if(isGest&&!gestPeutVoirVehicule(db,auth,aff_active.vehicule_id)){res.writeHead(403);return res.end(JSON.stringify({detail:'Véhicule non assigné'}));}
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
      // Un gestionnaire ne voit que sa propre fiche (mot de passe et clé Wave masqués)
      const g=db.gestionnaires.find(x=>x.id===auth.gest.id);
      if(!g) return res.end(JSON.stringify([]));
      const safe={...g, password:undefined, wave_api_key: g.wave_api_key?'***CONFIGUREE***':''};
      return res.end(JSON.stringify([safe]));
    }
    // Manager voit tout mais jamais le mot de passe (hash ou clair) ni les clés Wave en clair
    const list=db.gestionnaires.map(g=>({...g,password:undefined,wave_api_key:g.wave_api_key?'***CONFIGUREE***':''}));
    return res.end(JSON.stringify(list));
  }
  if(p==='/api/gestionnaires'&&method==='POST'){
    if(!isManager){res.writeHead(403);return res.end(JSON.stringify({detail:'Refusé'}));}
    const pwdChoisi=data.password||uid().slice(0,8);
    if(db.gestionnaires.find(g=>verifyPassword(pwdChoisi,g.password))) return res.end(JSON.stringify({detail:'Ce mot de passe est déjà utilisé'}));
    const scopesValides=['tous','moto','voiture','aucun'];
    const g={id:uid(),nom:data.nom,telephone:data.telephone||'',email:data.email||'',password:hashPassword(pwdChoisi),vehicules_ids:data.vehicules_ids||[],tags:normalizeTags(data.tags||[]),tag:data.tag||'',proprio_id:data.proprio_id||null,
      facturer_scope:scopesValides.includes(data.facturer_scope)?data.facturer_scope:'tous',
      encaisser_scope:scopesValides.includes(data.encaisser_scope)?data.encaisser_scope:'tous'};
    db.gestionnaires.push(g);saveDB(db);
    // Le mot de passe en clair n'est renvoyé qu'une seule fois, à la création — jamais depuis GET.
    return res.end(JSON.stringify({id:g.id,password:pwdChoisi,message:'Gestionnaire créé'}));
  }
  const gM=p.match(/^\/api\/gestionnaires\/([^/]+)$/);
  if(gM&&method==='PATCH'){
    // Manager peut tout modifier. Gestionnaire peut modifier sa PROPRE clé Wave uniquement.
    if(!isManager&&!(isGest&&auth.gest.id===gM[1])){
      res.writeHead(403);return res.end(JSON.stringify({detail:'Refusé'}));
    }
    const idx=db.gestionnaires.findIndex(g=>g.id===gM[1]);
    if(idx===-1) return res.end(JSON.stringify({message:'Mis à jour'}));
    // Le mot de passe étant haché (irréversible), il n'est plus jamais consultable après
    // coup — seul le manager peut le RÉINITIALISER (nouveau mot de passe généré, montré
    // une seule fois, comme à la création), pas le "récupérer" en clair.
    let nouveauPassword=null;
    if(isManager&&data.reset_password===true){
      nouveauPassword=uid().slice(0,8);
      db.gestionnaires[idx].password=hashPassword(nouveauPassword);
    }
    if(isGest&&!isManager){
      // Gestionnaire : ne peut modifier que sa clé Wave et ses infos personnelles
      const allowed={wave_api_key:data.wave_api_key,nom:data.nom,telephone:data.telephone,email:data.email};
      Object.keys(allowed).forEach(k=>{if(allowed[k]!==undefined)db.gestionnaires[idx][k]=allowed[k];});
    } else if(isManager){
      const {password,reset_password,...reste}=data;
      db.gestionnaires[idx]={...db.gestionnaires[idx],...reste};
      if(typeof password==='string'&&password&&!nouveauPassword) db.gestionnaires[idx].password=hashPassword(password);
    }
    saveDB(db);
    return res.end(JSON.stringify(nouveauPassword?{message:'Mis à jour',password:nouveauPassword}:{message:'Mis à jour'}));
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
      return res.end(JSON.stringify(myProps.map(pr=>({...pr,password:undefined}))));
    }
    return res.end(JSON.stringify(db.proprietaires.map(pr=>({...pr,password:undefined}))));
  }
  if(p==='/api/proprietaires'&&method==='POST'){
    if(!isManager&&!isGest){res.writeHead(403);return res.end(JSON.stringify({detail:'Refusé'}));}
    const pwdChoisi=data.password||uid().slice(0,8);
    if(db.proprietaires.find(pr=>verifyPassword(pwdChoisi,pr.password))) return res.end(JSON.stringify({detail:'Ce mot de passe est déjà utilisé'}));
    // Gestionnaire : ne peut créer un proprio que pour ses propres véhicules
    let vehicules_ids = data.vehicules_ids||[];
    if(isGest){
      const myVehIds=auth.gest.vehicules_ids||[];
      vehicules_ids=vehicules_ids.filter(vid=>myVehIds.includes(vid));
      if(!vehicules_ids.length) vehicules_ids=[];
    }
    const pr={id:uid(),nom:data.nom,email:data.email||'',telephone:data.telephone||'',
               password:hashPassword(pwdChoisi),vehicules_ids,
               cree_par:isGest?auth.gest.id:'manager'};
    db.proprietaires.push(pr);saveDB(db);
    return res.end(JSON.stringify({id:pr.id,password:pwdChoisi,message:'Propriétaire créé'}));
  }
  const prM=p.match(/^\/api\/proprietaires\/([^/]+)$/);
  if(prM&&method==='PATCH'){
    if(!isManager&&!isGest){res.writeHead(403);return res.end(JSON.stringify({detail:'Refusé'}));}
    const idx=db.proprietaires.findIndex(pr=>pr.id===prM[1]);
    if(idx===-1) return res.end(JSON.stringify({message:'Mis à jour'}));
    // Gestionnaire : ne peut modifier que les propriétaires liés à ses véhicules
    if(isGest){
      const myVehIds=auth.gest.vehicules_ids||[];
      const prVehs=db.proprietaires[idx].vehicules_ids||[];
      if(!prVehs.some(vid=>myVehIds.includes(vid))){res.writeHead(403);return res.end(JSON.stringify({detail:'Refusé'}));}
      // Filtrer les vehicules_ids dans la mise à jour
      if(data.vehicules_ids) data.vehicules_ids=data.vehicules_ids.filter(vid=>myVehIds.includes(vid));
    }
    // Mot de passe haché (irréversible) : réinitialisable (nouveau mot de passe généré,
    // montré une seule fois) mais plus jamais "récupérable" en clair après coup.
    let nouveauPassword=null;
    if(data.reset_password===true){
      nouveauPassword=uid().slice(0,8);
      db.proprietaires[idx].password=hashPassword(nouveauPassword);
    }
    const {password,reset_password,...reste}=data;
    db.proprietaires[idx]={...db.proprietaires[idx],...reste};
    if(typeof password==='string'&&password&&!nouveauPassword) db.proprietaires[idx].password=hashPassword(password);
    saveDB(db);
    return res.end(JSON.stringify(nouveauPassword?{message:'Mis à jour',password:nouveauPassword}:{message:'Mis à jour'}));
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
    if(!peutFacturer(db,auth,data.vehicule_id)){res.writeHead(403);return res.end(JSON.stringify({detail:'Vous n\'avez pas la permission de facturer'}));}
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
    genererFraisMoto(db,fac);

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
    // Recharger la base ICI, après l'attente réseau : createWavePayment() est un await
    // réel (aller-retour vers l'API Wave) pendant lequel une autre requête a pu modifier
    // et sauvegarder la base. On applique notre écriture sur l'état le plus récent plutôt
    // que sur la copie chargée avant l'attente, pour réduire la fenêtre de perte de mise
    // à jour (voir audit F-11). Ne remplace pas un vrai verrou, mais réduit la fenêtre de
    // risque de "toute la durée de l'appel Wave" à "un accès mémoire synchrone".
    const dbFrais=loadDB();
    dbFrais.wave_pending=(dbFrais.wave_pending||{});
    dbFrais.wave_pending[reference]={chauffeur_id,montant:Number(montant),created_at:new Date().toISOString()};
    saveDB(dbFrais);
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
    if(isGest&&!gestPeutVoirVehicule(db,auth,data.vehicule_id)){
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
    // Gestionnaire voit seulement son historique — par identifiant unique quand disponible
    // (entrées récentes), sinon par nom exact pour les entrées historiques qui n'avaient
    // pas encore ce champ. Ne JAMAIS élargir sur h.role==='gestionnaire' seul : ça
    // fait fuiter l'historique de tous les gestionnaires entre eux.
    if(isGest) list=list.filter(h=> h.auteur_id ? h.auteur_id===auth.gest.id : h.auteur===auth.gest.nom);
    if(q.limit) list=list.slice(-parseInt(q.limit));
    return res.end(JSON.stringify(list.slice(-100).reverse()));
  }

  // ── EZZLOC GPS ────────────────────────────────────────────
  // Position temps réel de tous les traceurs + rattachement au véhicule SyNdongo
  // correspondant (par plaque normalisée, ou via db.ezzloc_mapping si saisi à la main).
  if (p === '/api/ezzloc/vehicules' && method === 'GET') {
    if (!isManager && !isGest) { res.writeHead(403); return res.end(JSON.stringify({ detail: 'Refusé' })); }
    if (!EZZLOC_ACCOUNTS.length) return res.end(JSON.stringify({ detail: 'Aucun compte EZZloc configuré' }));
    const devices = await ezzlocCallAllAccounts('getVehicleLocationByGroup', { Type: 0 });
    const mapping = db.ezzloc_mapping || {};
    const myVehs = vehsVisibles(db, auth);
    const list = devices.map(d => {
      let veh = null;
      const mappedId = mapping[String(d.VehicleID)];
      const dissocieManuel = mappedId === '__none__';
      if (mappedId && !dissocieManuel) veh = db.vehicules.find(v => v.id === mappedId);
      if (!veh && !dissocieManuel) {
        const nreg = ezzlocNorm(d.RegName);
        veh = db.vehicules.find(v => v.immatriculation && nreg.includes(ezzlocNorm(v.immatriculation)));
      }
      const lat = parseFloat(d.Lat) || null, lon = parseFloat(d.Lon) || null;
      const distanceDakarKm = (lat && lon) ? Math.round(distanceKm(DAKAR_CENTRE.lat, DAKAR_CENTRE.lon, lat, lon)) : null;
      return {
        ezzloc_id: d.VehicleID, reg_name: (d.RegName || '').trim(),
        vehicule_id: veh ? veh.id : null, immatriculation: veh ? veh.immatriculation : null,
        lat, lon,
        speed: parseFloat(d.Speed) || 0, direction: parseInt(d.Direction) || 0,
        run_status: d.RunStatus || '', online_type: d.OnlineType, is_online: d.IsOnline === 1,
        odometer: parseFloat(d.Odometer) || 0, gps_time: d.GpsTime ? parseInt(d.GpsTime) : null,
        distance_dakar_km: distanceDakarKm,
        hors_zone_dakar: distanceDakarKm !== null && distanceDakarKm > DAKAR_RAYON_KM
      };
    }).filter(x => !myVehs.length || !x.vehicule_id || myVehs.some(v => v.id === x.vehicule_id));
    return res.end(JSON.stringify(list));
  }

  if (p === '/api/ezzloc/track' && method === 'GET') {
    if (!isManager && !isGest) { res.writeHead(403); return res.end(JSON.stringify({ detail: 'Refusé' })); }
    if (!q.ezzloc_id || !q.debut || !q.fin) return res.end(JSON.stringify({ detail: 'ezzloc_id, debut et fin requis' }));
    const acc = await ezzlocAccountForDevice(parseInt(q.ezzloc_id));
    if (!acc) return res.end(JSON.stringify({ detail: 'Compte EZZloc introuvable pour cet appareil' }));
    const r = await ezzlocCallOn(acc, 'getTrackData', { VehicleID: parseInt(q.ezzloc_id), BeginTime: q.debut, EndTime: q.fin });
    if (r.result !== 1) return res.end(JSON.stringify({ detail: r.resultNote || 'Erreur EZZloc' }));
    return res.end(JSON.stringify(r.detail || []));
  }

  if (p === '/api/ezzloc/mapping' && method === 'GET') {
    if (!isManager) { res.writeHead(403); return res.end(JSON.stringify({ detail: 'Refusé' })); }
    return res.end(JSON.stringify(db.ezzloc_mapping || {}));
  }
  if (p === '/api/ezzloc/mapping' && method === 'PATCH') {
    if (!isManager) { res.writeHead(403); return res.end(JSON.stringify({ detail: 'Refusé' })); }
    if (!data.ezzloc_id || !data.vehicule_id) return res.end(JSON.stringify({ detail: 'ezzloc_id et vehicule_id requis' }));
    db.ezzloc_mapping = db.ezzloc_mapping || {};
    // '__none__' = dissociation explicite et durable — on ne se contente pas de retirer
    // l'entrée, sinon la correspondance automatique par plaque la recréerait aussitôt.
    if (data.vehicule_id === '__clear__') db.ezzloc_mapping[String(data.ezzloc_id)] = '__none__';
    else db.ezzloc_mapping[String(data.ezzloc_id)] = data.vehicule_id;
    saveDB(db);
    // Une association véhicule↔traceur a changé (dans un sens ou dans l'autre) : on ne
    // sait pas facilement quel(s) véhicule(s) étaient concernés avant/après, donc on vide
    // tout le cache d'analyse par prudence — c'est une action manuelle rare, pas un coût.
    Object.keys(_analyse24hCache).forEach(function(k){ delete _analyse24hCache[k]; });
    return res.end(JSON.stringify({ message: 'Association enregistrée' }));
  }

  // ── YANGO — IMPORT CSV ───────────────────────────────────
  if (p === '/api/yango/import' && method === 'POST') {
    if (!isManager && !isGest) { res.writeHead(403); return res.end(JSON.stringify({ detail: 'Refusé' })); }
    if (!data.csv) return res.end(JSON.stringify({ detail: 'Fichier CSV vide ou manquant' }));
    const parsed = parseYangoCSV(data.csv);
    if (!parsed.length) return res.end(JSON.stringify({ detail: 'Aucune commande lisible dans ce fichier (vérifiez le format)' }));
    db.yango_commandes = db.yango_commandes || [];
    const byId = {};
    db.yango_commandes.forEach(function(c, idx){ byId[c.identifiant] = idx; });
    let nbAjoutes = 0, nbMiseAJour = 0, nbMatches = 0;
    parsed.forEach(cmd => {
      const match = matchYangoCommande(cmd, db);
      if (match.vehicule_id) nbMatches++;
      const record = Object.assign({}, cmd, match);
      if (byId[cmd.identifiant] !== undefined) {
        db.yango_commandes[byId[cmd.identifiant]] = record; // ré-import : on rafraîchit les données (montants, statut…)
        nbMiseAJour++;
      } else {
        db.yango_commandes.push(record);
        byId[cmd.identifiant] = db.yango_commandes.length - 1;
        nbAjoutes++;
      }
    });
    saveDB(db);
    // Nouvelles commandes Yango importées : le cache d'analyse des véhicules concernés
    // (potentiellement sur des dates déjà en cache) doit être recalculé.
    Object.keys(_analyse24hCache).forEach(function(k){ delete _analyse24hCache[k]; });
    return res.end(JSON.stringify({ message: 'Import terminé', total_lignes: parsed.length, nb_ajoutees: nbAjoutes, nb_mises_a_jour: nbMiseAJour, nb_associees: nbMatches }));
  }

  if (p === '/api/yango/commandes' && method === 'GET') {
    if (!isManager && !isGest) { res.writeHead(403); return res.end(JSON.stringify({ detail: 'Refusé' })); }
    let list = db.yango_commandes || [];
    if (q.vehicule_id) list = list.filter(c => c.vehicule_id === q.vehicule_id);
    if (q.debut && q.fin) {
      const bornDebut = parseInt(q.debut), bornFin = parseInt(q.fin);
      list = list.filter(c => (c.debut && c.debut >= bornDebut && c.debut <= bornFin) || (c.fin && c.fin >= bornDebut && c.fin <= bornFin));
    }
    return res.end(JSON.stringify(list));
  }

  // ── ANALYSE 24H — Croisement GPS EZZloc / Commandes Yango ────
  if (p === '/api/analyse24h' && method === 'GET') {
    if (!isManager && !isGest) { res.writeHead(403); return res.end(JSON.stringify({ detail: 'Refusé' })); }
    if (!q.vehicule_id || !q.date) return res.end(JSON.stringify({ detail: 'vehicule_id et date (AAAA-MM-JJ) requis' }));
    if (!/^\d{4}-\d{2}-\d{2}$/.test(q.date)) return res.end(JSON.stringify({ detail: 'Format de date invalide (AAAA-MM-JJ)' }));
    const r = await calculerAnalyse24h(db, q.vehicule_id, q.date);
    if (r.detail) return res.end(JSON.stringify(r));
    return res.end(JSON.stringify(r));
  }

  // ── ANALYSE PÉRIODE — plage de dates avec total agrégé ───────
  if (p === '/api/analyse-periode' && method === 'GET') {
    if (!isManager && !isGest) { res.writeHead(403); return res.end(JSON.stringify({ detail: 'Refusé' })); }
    if (!q.vehicule_id || !q.debut || !q.fin) return res.end(JSON.stringify({ detail: 'vehicule_id, debut et fin (AAAA-MM-JJ) requis' }));
    if (!/^\d{4}-\d{2}-\d{2}$/.test(q.debut) || !/^\d{4}-\d{2}-\d{2}$/.test(q.fin)) return res.end(JSON.stringify({ detail: 'Format de date invalide (AAAA-MM-JJ)' }));
    const dDebut = new Date(q.debut + 'T00:00:00Z'), dFin = new Date(q.fin + 'T00:00:00Z');
    const nbJours = Math.round((dFin - dDebut) / (24*3600*1000)) + 1;
    if (nbJours < 1 || nbJours > 62) return res.end(JSON.stringify({ detail: 'Période invalide (max 62 jours)' }));

    // Un jour de la période est indépendant des autres — on les calcule tous en parallèle
    // (chacun profite du cache pour les journées déjà consultées) au lieu de les enchaîner
    // un par un, ce qui rendait une période de plusieurs jours plusieurs fois plus lente
    // qu'un jour seul.
    const dates = [];
    for (let i = 0; i < nbJours; i++) {
      const d = new Date(dDebut); d.setUTCDate(d.getUTCDate() + i);
      dates.push(d.toISOString().split('T')[0]);
    }
    const resultats = await Promise.all(dates.map(function(dateStr){ return calculerAnalyse24h(db, q.vehicule_id, dateStr); }));

    const jours = [];
    let totKm = 0, totGagne = 0, totTermine = 0, totAnnuleClient = 0, totAnnuleChauffeur = 0, totAnomalies = 0, totPointsGps = 0;
    resultats.forEach(function(r, i){
      if (r.detail) return;
      const nbAnomaliesJour = r.heures.filter(function(h){ return h.anomalie; }).length;
      jours.push({
        date: dates[i], km_parcourus: r.km_parcourus, montant_gagne: r.montant_gagne,
        nb_termine_jour: r.nb_termine_jour, nb_annule_client: r.nb_annule_client,
        nb_annule_chauffeur: r.nb_annule_chauffeur, nb_anomalies: nbAnomaliesJour
      });
      totKm += r.km_parcourus; totGagne += r.montant_gagne; totTermine += r.nb_termine_jour;
      totAnnuleClient += r.nb_annule_client; totAnnuleChauffeur += r.nb_annule_chauffeur;
      totAnomalies += nbAnomaliesJour; totPointsGps += r.nb_points_gps;
    });
    return res.end(JSON.stringify({
      vehicule_id: q.vehicule_id, debut: q.debut, fin: q.fin, nb_jours: nbJours,
      km_parcourus: Math.round(totKm * 10) / 10, montant_gagne: totGagne, nb_termine_jour: totTermine,
      nb_annule_client: totAnnuleClient, nb_annule_chauffeur: totAnnuleChauffeur, nb_anomalies: totAnomalies,
      nb_points_gps: totPointsGps, jours: jours
    }));
  }

  // ── HISTORIQUE DES ANALYSES — sauvegarde/consultation ────────
  if (p === '/api/historique-analyse' && method === 'GET') {
    if (!isManager && !isGest) { res.writeHead(403); return res.end(JSON.stringify({ detail: 'Refusé' })); }
    let list = db.historique_analyse24h || [];
    if (q.vehicule_id) list = list.filter(h => h.vehicule_id === q.vehicule_id);
    if (q.date) list = list.filter(h => h.date === q.date);
    if (q.debut && q.fin) list = list.filter(h => h.date >= q.debut && h.date <= q.fin);
    return res.end(JSON.stringify(list.sort((a, b) => b.date.localeCompare(a.date))));
  }
  if (p === '/api/historique-analyse/snapshot' && method === 'POST') {
    if (!isManager) { res.writeHead(403); return res.end(JSON.stringify({ detail: 'Refusé' })); }
    const dateSnap = data.date || (function(){ const h = new Date(); h.setUTCDate(h.getUTCDate() - 1); return h.toISOString().split('T')[0]; })();
    const resSnap = await snapshotAnalyse24hToutesMotos(db, dateSnap);
    return res.end(JSON.stringify(resSnap));
  }

  res.writeHead(404);res.end(JSON.stringify({detail:'Route introuvable'}));
}

const server=http.createServer((req,res)=>{
  // ── Compression gzip transparente (réponses JSON/HTML souvent volumineuses) ──
  if ((req.headers['accept-encoding']||'').includes('gzip')) {
    res.setHeader('Content-Encoding', 'gzip');
    res.setHeader('Vary', 'Accept-Encoding');
    const origEnd = res.end.bind(res);
    res.end = function(chunk, encoding, cb) {
      if (!chunk || typeof chunk === 'function') return origEnd(chunk, encoding, cb);
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, typeof encoding === 'string' ? encoding : 'utf8');
      try { return origEnd(zlib.gzipSync(buf)); }
      catch (e) { res.removeHeader('Content-Encoding'); return origEnd(buf); }
    };
  }
  cors(res);
  if(req.method==='OPTIONS'){res.writeHead(204);res.end();return;}
  if(req.url.startsWith('/api/')){let body='';req.on('data',c=>body+=c);req.on('end',()=>handleAPI(req,res,body));return;}
  if(req.url==='/'||req.url.startsWith('/index')){res.setHeader('Content-Type','text/html; charset=utf-8');res.setHeader('Cache-Control','no-cache, must-revalidate');res.end(fs.readFileSync(path.join(__dirname,'index.html'),'utf8'));return;}
  if(req.url==='/imputation.js'){res.setHeader('Content-Type','application/javascript; charset=utf-8');res.setHeader('Cache-Control','no-cache, must-revalidate');res.end(fs.readFileSync(path.join(__dirname,'imputation.js'),'utf8'));return;}
  res.writeHead(404);res.end('Not found');
});
server.listen(PORT,()=>console.log('\n  SyNdongo v9 — port '+PORT+'\n  DB: '+DB_FILE+'\n'));
planifierSnapshotAutomatique();
