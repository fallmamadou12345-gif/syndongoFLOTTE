#!/usr/bin/env node
/**
 * COMPLEMENT D'IMPORT ADAMA — 7 PLAQUES RESTANTES
 *
 * Cible UNIQUEMENT les 7 plaques manquantes du premier import :
 *   - 5 plaques absentes du parc ADAMA (à créer/affecter d'abord)
 *   - 2 plaques sans chauffeur actif (à affecter d'abord)
 *
 * À LANCER UNIQUEMENT APRÈS avoir ajouté manuellement :
 *   - les 5 plaques au parc d'ADAMA dans l'app
 *   - un chauffeur actif aux 2 plaques (AA510SF, AA530MB)
 *
 * Usage :
 *   node import_adama_complement.js --url URL --password MDP [--date YYYY-MM-DD] [--dry-run]
 *
 * Total attendu : 653 500 F facturé + 653 500 F encaissé
 */

const http = require('http');
const https = require('https');
const { URL } = require('url');

// ──────────────────────────────────────────────────────
// LES 7 PLAQUES MANQUANTES
// ──────────────────────────────────────────────────────
const DATA = [
  // Plaques qui étaient absentes du parc ADAMA
  ['AA536LG', 0,      0,      0],
  ['TH7629C', 180000, 180000, 0],
  ['AB370BD', 273000, 273000, 0],
  ['AA153HF', 70000,  70000,  0],
  ['AA063QK', 48000,  48000,  0],
  // Plaques qui étaient sans chauffeur actif
  ['AA510SF', 52500,  52500,  0],
  ['AA530MB', 30000,  30000,  0]
];

const TOTAL_FAC_ATTENDU = 653500;
const TOTAL_ENC_ATTENDU = 653500;

// ──────────────────────────────────────────────────────
function parseArgs() {
  const args = { url: null, password: null, date: '2026-04-25', dryRun: false };
  for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (a === '--url') args.url = process.argv[++i];
    else if (a === '--password') args.password = process.argv[++i];
    else if (a === '--date') args.date = process.argv[++i];
    else if (a === '--dry-run') args.dryRun = true;
  }
  return args;
}

function _rawApiCall(baseUrl, password, method, path, body) {
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
        try {
          const json = data ? JSON.parse(data) : {};
          if (res.statusCode >= 400) reject(new Error(`HTTP ${res.statusCode}: ${json.detail || data}`));
          else resolve(json);
        } catch (e) {
          if (res.statusCode >= 400) reject(new Error(`HTTP ${res.statusCode}: ${data}`));
          else resolve(data);
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// Retry automatique : 3 essais avec backoff (2s, 5s, 10s) sur erreurs réseau ou 502/503/504
async function apiCall(baseUrl, password, method, path, body) {
  const delays = [2000, 5000, 10000];
  let lastErr;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      return await _rawApiCall(baseUrl, password, method, path, body);
    } catch (e) {
      lastErr = e;
      const msg = (e && e.message) || '';
      const code = (e && e.code) || '';
      const isRetryable =
        code === 'ECONNRESET' ||
        code === 'ETIMEDOUT' ||
        code === 'ENOTFOUND' ||
        code === 'EAI_AGAIN' ||
        msg.includes('socket hang up') ||
        msg.includes('Timeout') ||
        msg.includes('HTTP 502') ||
        msg.includes('HTTP 503') ||
        msg.includes('HTTP 504');
      if (!isRetryable || attempt === delays.length) throw e;
      const wait = delays[attempt];
      console.log(`      ⏳ Erreur réseau (${msg.slice(0, 80)}) — nouvelle tentative dans ${wait/1000}s...`);
      await new Promise(r => setTimeout(r, wait));
    }
  }
  throw lastErr;
}

(async () => {
  const args = parseArgs();
  if (!args.url || !args.password) {
    console.error('Usage: node import_adama_complement.js --url URL --password MDP [--date YYYY-MM-DD] [--dry-run]');
    process.exit(1);
  }

  console.log('\n══════════════════════════════════════════════════════');
  console.log('  COMPLEMENT IMPORT ADAMA — 7 PLAQUES MANQUANTES');
  console.log('══════════════════════════════════════════════════════');
  console.log(`  API     : ${args.url}`);
  console.log(`  Date    : ${args.date}`);
  console.log(`  Mode    : ${args.dryRun ? 'DRY-RUN (test)' : 'PRODUCTION'}`);
  console.log(`  Lignes  : ${DATA.length} plaques`);
  console.log('══════════════════════════════════════════════════════\n');

  // Récupération des données
  console.log('[1/3] Récupération des véhicules + affectations...');
  const vehs = await apiCall(args.url, args.password, 'GET', '/api/vehicules', null);
  const affs = await apiCall(args.url, args.password, 'GET', '/api/affectations', null);

  const byPlaque = {};
  vehs.forEach(v => { byPlaque[v.immatriculation.toUpperCase()] = v; });
  const activesByVeh = {};
  affs.forEach(a => { if (!a.date_fin) activesByVeh[a.vehicule_id] = a; });

  // Vérification de chaque plaque
  console.log('[2/3] Vérification du statut de chaque plaque...');
  const items = [];
  for (const [plaque, fac, enc] of DATA) {
    const v = byPlaque[plaque.toUpperCase()];
    if (!v) {
      console.log(`      ❌ ${plaque} : TOUJOURS introuvable dans le parc ADAMA`);
      continue;
    }
    const aff = activesByVeh[v.id];
    const status = aff ? '✓' : '⚠️ sans chauffeur';
    console.log(`      ${status} ${plaque} : véhicule trouvé${aff ? `, chauffeur OK` : ', PAS de chauffeur actif → fac seulement'}`);
    items.push({ plaque, vehicule_id: v.id, chauffeur_id: aff ? aff.chauffeur_id : null, fac, enc });
  }

  if (items.length === 0) {
    console.log('\n❌ Aucune plaque trouvée. Veuillez d\'abord ajouter les plaques au parc ADAMA.\n');
    process.exit(1);
  }

  // Import
  console.log(`\n[3/3] Import (${args.dryRun ? 'simulation' : 'écriture'}) au ${args.date}...`);
  let okFac = 0, okEnc = 0, errors = 0, totFac = 0, totEnc = 0;

  for (const item of items) {
    if (item.fac > 0) {
      totFac += item.fac;
      if (!args.dryRun) {
        try {
          await apiCall(args.url, args.password, 'POST', '/api/facturations', {
            vehicule_id: item.vehicule_id,
            chauffeur_id: item.chauffeur_id, // peut être null pour sans chauffeur
            date: args.date,
            type_journee: 'complet',
            montant_facture: item.fac,
            montant_base: item.fac,
            commentaire: 'Complement import PDF ADAMA 30/03-25/04'
          });
          okFac++;
        } catch (e) {
          console.log(`      ✗ Facturation ${item.plaque}: ${e.message}`);
          errors++;
        }
      } else {
        okFac++;
      }
    }

    // Encaissement seulement si chauffeur présent
    if (item.enc > 0 && item.chauffeur_id) {
      totEnc += item.enc;
      if (!args.dryRun) {
        try {
          await apiCall(args.url, args.password, 'POST', '/api/encaissements', {
            chauffeur_id: item.chauffeur_id,
            montant_recu: item.enc,
            mode_paiement: 'especes',
            date_encaissement: args.date,
            reference: 'Complement PDF ADAMA 30/03-25/04'
          });
          okEnc++;
        } catch (e) {
          console.log(`      ✗ Encaissement ${item.plaque}: ${e.message}`);
          errors++;
        }
      } else {
        okEnc++;
      }
    }
  }

  // Rapport
  console.log('\n══════════════════════════════════════════════════════');
  console.log('  RÉSULTAT COMPLEMENT');
  console.log('══════════════════════════════════════════════════════');
  console.log(`  Facturations créées : ${okFac}`);
  console.log(`  Encaissements créés : ${okEnc}`);
  console.log(`  Erreurs             : ${errors}`);
  console.log('  ─────────────────────────────────────────────────────');
  console.log(`  Total facturé : ${totFac.toLocaleString('fr-FR')} F (attendu : ${TOTAL_FAC_ATTENDU.toLocaleString('fr-FR')} F)`);
  console.log(`  Total encaissé: ${totEnc.toLocaleString('fr-FR')} F (attendu : ${TOTAL_ENC_ATTENDU.toLocaleString('fr-FR')} F)`);
  console.log('══════════════════════════════════════════════════════\n');

  if (totFac < TOTAL_FAC_ATTENDU || totEnc < TOTAL_ENC_ATTENDU) {
    const facDiff = TOTAL_FAC_ATTENDU - totFac;
    const encDiff = TOTAL_ENC_ATTENDU - totEnc;
    console.log(`⚠️  Manquant : ${facDiff.toLocaleString('fr-FR')} F facturé / ${encDiff.toLocaleString('fr-FR')} F encaissé`);
    console.log('   → Vérifiez que toutes les plaques sont bien dans le parc ADAMA et ont un chauffeur actif.\n');
  } else {
    console.log('✅ Complément réussi. Total ADAMA devrait maintenant correspondre au PDF.\n');
  }
})();
