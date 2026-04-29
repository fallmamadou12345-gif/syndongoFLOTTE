#!/usr/bin/env node
/**
 * IMPORT DONNÉES ADAMA - PÉRIODE DU 30 MARS AU 25 AVRIL 2026
 *
 * Source : PDF "DU 30 AU 25 AVRIL - Feuille 1.pdf"
 * Total facturé attendu : 9 927 500 F
 * Total encaissé attendu : 9 673 000 F
 * Total retard attendu : 254 500 F
 *
 * Mode d'utilisation :
 *   node import_adama_avril.js [--url URL] [--password MDP] [--date YYYY-MM-DD] [--dry-run]
 *
 * Exemples :
 *   node import_adama_avril.js --dry-run                       (test sur DB locale)
 *   node import_adama_avril.js --url http://localhost:8000     (en local)
 *   node import_adama_avril.js --url https://syndongoflotte.up.railway.app --password <MDP_ADAMA>
 *
 * Si --password n'est pas fourni, le script utilisera une lecture interactive.
 * --dry-run : aucune écriture, affiche seulement ce qui serait fait
 */

const http = require('http');
const https = require('https');
const readline = require('readline');
const { URL } = require('url');

// ──────────────────────────────────────────────────────
// DONNÉES DU PDF (54 lignes)
// ──────────────────────────────────────────────────────
const DATA = [
  // [PLAQUE, FACTURE, ENCAISSE, RETARD]
  ['AA008SG', 300000, 300000, 0],
  ['AA113CQ', 300000, 300000, 0],
  ['AA170JF', 216000, 201000, 15000],
  ['AA245AT', 210000, 210000, 0],
  ['AA292RZ', 307500, 277500, 30000],
  ['AA511SF', 360000, 360000, 0],
  ['AA536LG', 0, 0, 0],
  ['AA812JE', 228000, 228000, 0],
  ['AA825JE', 0, 0, 0],
  ['AA997SC', 345000, 345000, 0],
  ['AA017JZ', 0, 0, 0],
  ['AA019JZ', 12000, 12000, 0],
  ['AA020JZ', 96000, 96000, 0],
  ['AA022JZ', 240000, 240000, 0],
  ['AA032JZ', 288000, 288000, 0],
  ['AA038JZ', 138000, 138000, 0],
  ['AA421TL', 110000, 110000, 0],
  ['AA070JZ', 246000, 246000, 0],
  ['AA081JZ', 12000, 12000, 0],
  ['AA087JZ', 174000, 132000, 42000],
  ['AA148MT', 180000, 180000, 0],
  ['AA149MT', 60000, 60000, 0],
  ['AA174MT', 0, 0, 0],
  ['AA315SJ', 274500, 274500, 0],
  ['AA375SJ', 352500, 345000, 7500],
  ['AA378SJ', 315000, 315000, 0],
  ['AA389SB', 300000, 300000, 0],
  ['AA399SB', 307500, 307500, 0],
  ['AA510SF', 52500, 52500, 0],
  ['AA518MB', 0, 0, 0],
  ['AA530MB', 30000, 30000, 0],
  ['AA532MB', 0, 0, 0],
  ['AA535MB', 157500, 157500, 0],
  ['AA695HE', 12000, 12000, 0],
  ['AA712HR', 102000, 102000, 0],
  ['AA719HR', 84000, 84000, 0],
  ['AA722HR', 102000, 102000, 0],
  ['AA725HR', 180000, 168000, 12000],
  ['AA727HR', 0, 0, 0],
  ['AA840SF', 330000, 300000, 30000],
  ['AA999SC', 300000, 270000, 30000],
  ['AA754TQ', 120000, 120000, 0],
  ['AB775BD', 138000, 126000, 12000],
  ['TH7629C', 180000, 180000, 0],
  ['AB771EH', 276000, 228000, 48000],
  ['AB327ET', 150000, 150000, 0],
  ['AA241QK', 134000, 134000, 0],
  ['AA615AN', 144000, 144000, 0],
  ['AB988FL', 174000, 174000, 0],
  ['AB943EF', 273000, 260000, 13000],
  ['AA987LA', 150000, 150000, 0],
  ['AB370BD', 273000, 273000, 0],
  ['AA341TQ', 322500, 322500, 0],
  ['AB091CA', 285000, 285000, 0],
  ['AA025JZ', 258000, 258000, 0],
  ['AA153HF', 70000, 70000, 0],
  ['AA063QK', 48000, 48000, 0],
  ['AA150MT', 210000, 195000, 15000]
];

const TOTAUX_ATTENDUS = { fac: 9927500, enc: 9673000, ret: 254500 };

// ──────────────────────────────────────────────────────
// PARSING ARGS
// ──────────────────────────────────────────────────────
function parseArgs() {
  const args = { url: null, password: null, date: '2026-04-25', dryRun: false };
  for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (a === '--url') args.url = process.argv[++i];
    else if (a === '--password') args.password = process.argv[++i];
    else if (a === '--date') args.date = process.argv[++i];
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--help' || a === '-h') {
      console.log(`
Usage: node import_adama_avril.js [options]

Options:
  --url URL           URL de l'API (ex: http://localhost:8000 ou Railway)
  --password MDP      Mot de passe Manager ou Gestionnaire ADAMA
  --date YYYY-MM-DD   Date à utiliser pour les facturations (défaut: 2026-04-25)
  --dry-run           Mode test, aucune écriture
  -h, --help          Afficher cette aide
`);
      process.exit(0);
    }
  }
  return args;
}

// ──────────────────────────────────────────────────────
// PROMPT INTERACTIF
// ──────────────────────────────────────────────────────
function prompt(question, hidden = false) {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    if (hidden) {
      const stdin = process.stdin;
      process.stdout.write(question);
      let pwd = '';
      stdin.setRawMode && stdin.setRawMode(true);
      stdin.resume();
      stdin.setEncoding('utf8');
      const onData = (ch) => {
        ch = String(ch);
        if (ch === '\n' || ch === '\r' || ch === '') {
          stdin.setRawMode && stdin.setRawMode(false);
          stdin.pause();
          stdin.removeListener('data', onData);
          process.stdout.write('\n');
          rl.close();
          resolve(pwd);
        } else if (ch === '') {
          process.exit();
        } else if (ch === '' || ch === '\b') {
          if (pwd.length > 0) { pwd = pwd.slice(0, -1); process.stdout.write('\b \b'); }
        } else {
          pwd += ch;
          process.stdout.write('*');
        }
      };
      stdin.on('data', onData);
    } else {
      rl.question(question, (ans) => { rl.close(); resolve(ans.trim()); });
    }
  });
}

// ──────────────────────────────────────────────────────
// CLIENT HTTP API
// ──────────────────────────────────────────────────────
function apiCall(baseUrl, password, method, path, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(path, baseUrl);
    const lib = u.protocol === 'https:' ? https : http;
    const opts = {
      method,
      headers: {
        'Content-Type': 'application/json',
        'X-Token': password
      }
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
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// ──────────────────────────────────────────────────────
// IMPORT VIA API
// ──────────────────────────────────────────────────────
async function importViaApi(args) {
  const { url, password, date, dryRun } = args;

  console.log('\n══════════════════════════════════════════════════════');
  console.log('  IMPORT ADAMA — DU 30 MARS AU 25 AVRIL 2026');
  console.log('══════════════════════════════════════════════════════');
  console.log(`  API     : ${url}`);
  console.log(`  Date    : ${date}`);
  console.log(`  Mode    : ${dryRun ? 'DRY-RUN (test)' : 'PRODUCTION'}`);
  console.log(`  Lignes  : ${DATA.length} véhicules`);
  console.log('══════════════════════════════════════════════════════\n');

  // 1. Récupérer véhicules
  console.log('[1/4] Récupération des véhicules...');
  const vehs = await apiCall(url, password, 'GET', '/api/vehicules', null);
  console.log(`      ${vehs.length} véhicules visibles pour ce compte`);

  const byPlaque = {};
  vehs.forEach(v => { byPlaque[v.immatriculation.toUpperCase()] = v; });

  // 2. Récupérer affectations actives
  console.log('[2/4] Récupération des affectations actives...');
  const affs = await apiCall(url, password, 'GET', '/api/affectations', null);
  const activesByVeh = {};
  affs.forEach(a => { if (!a.date_fin) activesByVeh[a.vehicule_id] = a; });

  // 3. Vérifier les véhicules trouvés
  console.log('[3/4] Vérification des plaques...');
  const found = [], missing = [], noChauf = [];
  for (const [plaque, fac, enc, ret] of DATA) {
    const v = byPlaque[plaque.toUpperCase()];
    if (!v) { missing.push(plaque); continue; }
    const aff = activesByVeh[v.id];
    if (!aff && (fac > 0 || enc > 0)) { noChauf.push(plaque); continue; }
    found.push({ plaque, vehicule_id: v.id, chauffeur_id: aff ? aff.chauffeur_id : null, fac, enc, ret });
  }

  if (missing.length) {
    console.log(`      ⚠️  ${missing.length} plaques NON TROUVÉES : ${missing.join(', ')}`);
  }
  if (noChauf.length) {
    console.log(`      ⚠️  ${noChauf.length} plaques sans chauffeur actif : ${noChauf.join(', ')}`);
  }
  console.log(`      ✓ ${found.length} véhicules prêts pour l'import`);

  // 4. Import
  console.log(`[4/4] Import (${dryRun ? 'simulation' : 'écriture'}) au ${date}...`);
  let okFac = 0, okEnc = 0, errors = 0, totFac = 0, totEnc = 0;

  for (const item of found) {
    if (item.fac > 0) {
      totFac += item.fac;
      if (!dryRun) {
        try {
          await apiCall(url, password, 'POST', '/api/facturations', {
            vehicule_id: item.vehicule_id,
            chauffeur_id: item.chauffeur_id,
            date,
            type_journee: 'complet',
            montant_facture: item.fac,
            montant_base: item.fac,
            commentaire: 'Import PDF ADAMA 30/03-25/04'
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

    if (item.enc > 0 && item.chauffeur_id) {
      totEnc += item.enc;
      if (!dryRun) {
        try {
          await apiCall(url, password, 'POST', '/api/encaissements', {
            chauffeur_id: item.chauffeur_id,
            montant_recu: item.enc,
            mode_paiement: 'especes',
            date_encaissement: date,
            reference: 'Import PDF ADAMA 30/03-25/04'
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

    process.stdout.write(`\r      Progression: ${okFac + okEnc} opérations`);
  }

  // 5. Rapport
  console.log('\n\n══════════════════════════════════════════════════════');
  console.log('  RÉSULTAT');
  console.log('══════════════════════════════════════════════════════');
  console.log(`  Facturations : ${okFac} / ${found.filter(x => x.fac > 0).length}`);
  console.log(`  Encaissements: ${okEnc} / ${found.filter(x => x.enc > 0 && x.chauffeur_id).length}`);
  console.log(`  Erreurs      : ${errors}`);
  console.log('  ─────────────────────────────────────────────────────');
  console.log(`  Total facturé : ${totFac.toLocaleString('fr-FR')} F (attendu : ${TOTAUX_ATTENDUS.fac.toLocaleString('fr-FR')} F)`);
  console.log(`  Total encaissé: ${totEnc.toLocaleString('fr-FR')} F (attendu : ${TOTAUX_ATTENDUS.enc.toLocaleString('fr-FR')} F)`);
  console.log(`  Retard calculé: ${(totFac - totEnc).toLocaleString('fr-FR')} F (attendu : ${TOTAUX_ATTENDUS.ret.toLocaleString('fr-FR')} F)`);
  console.log('══════════════════════════════════════════════════════\n');

  if (totFac !== TOTAUX_ATTENDUS.fac || totEnc !== TOTAUX_ATTENDUS.enc) {
    console.log('⚠️  Les totaux ne correspondent pas exactement aux totaux du PDF.');
    console.log('   Cela peut être dû à des plaques non trouvées ou sans chauffeur.\n');
  } else {
    console.log('✅ Les totaux correspondent exactement au PDF.\n');
  }

  if (dryRun) {
    console.log('💡 Mode DRY-RUN : aucune donnée écrite. Relancez sans --dry-run pour importer.\n');
  } else if (errors === 0) {
    console.log('✅ Import terminé avec succès. Vérifiez sur l\'app : ' + url + '\n');
  }
}

// ──────────────────────────────────────────────────────
// MAIN
// ──────────────────────────────────────────────────────
(async () => {
  const args = parseArgs();

  if (!args.url) {
    args.url = await prompt('URL de l\'API (Entrée = http://localhost:8000) : ');
    if (!args.url) args.url = 'http://localhost:8000';
  }

  if (!args.password && !args.dryRun) {
    args.password = await prompt('Mot de passe (Manager ou Gestionnaire ADAMA) : ', true);
  } else if (!args.password) {
    args.password = 'dryrun';
  }

  try {
    await importViaApi(args);
  } catch (e) {
    console.error('\n❌ Erreur :', e.message);
    process.exit(1);
  }
})();
