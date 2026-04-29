#!/usr/bin/env node
/**
 * SCRIPT DE DIAGNOSTIC AUTH
 * Teste la connexion à l'API et liste les véhicules visibles.
 *
 * Usage:
 *   node test_auth.js <URL> <PASSWORD>
 *
 * Exemple:
 *   node test_auth.js https://syndongoflotte.onrender.com 766240622
 */

const http = require('http');
const https = require('https');
const { URL } = require('url');

const baseUrl = process.argv[2];
const password = process.argv[3];

if (!baseUrl || !password) {
  console.log('Usage: node test_auth.js <URL> <PASSWORD>');
  console.log('Exemple: node test_auth.js https://syndongoflotte.onrender.com 766240622');
  process.exit(1);
}

function apiCall(method, path, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(path, baseUrl);
    const lib = u.protocol === 'https:' ? https : http;
    const opts = {
      method,
      headers: {
        'Content-Type': 'application/json',
        'X-Token': password
      },
      timeout: 60000
    };
    const req = lib.request(u, opts, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: data
        });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

(async () => {
  console.log('\n══════════════════════════════════════════════════════');
  console.log('  TEST DE CONNEXION');
  console.log('══════════════════════════════════════════════════════');
  console.log('  URL      :', baseUrl);
  console.log('  Password :', password.replace(/./g, '*').slice(0, 4) + ' (masqué)');
  console.log('══════════════════════════════════════════════════════\n');

  // Test 1 : ping serveur
  try {
    console.log('[Test 1] Ping serveur...');
    const r = await apiCall('GET', '/', null);
    console.log(`         Status: ${r.status} (${r.body.length} bytes)`);
  } catch (e) {
    console.log(`         ❌ Erreur: ${e.message}`);
    console.log('         Render gratuit = 30-60s pour réveiller le serveur. Ré-essayez.');
    process.exit(1);
  }

  // Test 2 : auth via /api/me
  try {
    console.log('\n[Test 2] Authentification /api/me...');
    const r = await apiCall('POST', '/api/login', { password });
    console.log(`         Status: ${r.status}`);
    if (r.status === 200) {
      try {
        const j = JSON.parse(r.body);
        console.log(`         ✅ Connecté en tant que : ${j.role}`);
        if (j.nom) console.log(`         Nom : ${j.nom}`);
        if (j.affiche_comme) console.log(`         Affiché comme : ${j.affiche_comme}`);
      } catch(e) { console.log(`         Body: ${r.body.slice(0,200)}`); }
    } else {
      console.log(`         ❌ Échec : ${r.body.slice(0,200)}`);
    }
  } catch (e) {
    console.log(`         ❌ Erreur: ${e.message}`);
  }

  // Test 3 : véhicules
  try {
    console.log('\n[Test 3] GET /api/vehicules...');
    const r = await apiCall('GET', '/api/vehicules', null);
    console.log(`         Status: ${r.status}`);
    if (r.status === 200) {
      const j = JSON.parse(r.body);
      console.log(`         ✅ ${j.length} véhicule(s) visible(s)`);
      if (j.length > 0) {
        console.log(`         Premiers : ${j.slice(0,5).map(v => v.immatriculation).join(', ')}${j.length>5?', ...':''}`);
      } else {
        console.log(`         ⚠️  AUCUN véhicule. Causes possibles :`);
        console.log(`            - Mot de passe invalide (auth = public, donc 0 véhicule)`);
        console.log(`            - Compte gestionnaire sans véhicule assigné`);
        console.log(`            - Tags du gestionnaire vides`);
      }
    } else {
      console.log(`         ❌ Body: ${r.body.slice(0,200)}`);
    }
  } catch (e) {
    console.log(`         ❌ Erreur: ${e.message}`);
  }

  // Test 4 : gestionnaires (manager only)
  try {
    console.log('\n[Test 4] GET /api/gestionnaires (Manager seulement)...');
    const r = await apiCall('GET', '/api/gestionnaires', null);
    console.log(`         Status: ${r.status}`);
    if (r.status === 200) {
      const j = JSON.parse(r.body);
      console.log(`         ✅ ${j.length} gestionnaire(s) au total`);
      const adama = j.find(g => (g.nom||'').toUpperCase().includes('ADAMA'));
      if (adama) {
        console.log(`         ADAMA trouvé : id=${adama.id}, password=${adama.password}, ${(adama.vehicules_ids||[]).length} véhicules assignés, tags=${(adama.tags||[adama.tag]).filter(Boolean).join(',')}`);
      } else {
        console.log(`         Liste : ${j.map(g=>g.nom||'?').join(', ')}`);
      }
    } else {
      console.log(`         ⚠️  Pas autorisé (vous n'êtes pas Manager). C'est normal si vous êtes ADAMA.`);
    }
  } catch (e) {
    console.log(`         ❌ Erreur: ${e.message}`);
  }

  console.log('\n══════════════════════════════════════════════════════\n');
})();
