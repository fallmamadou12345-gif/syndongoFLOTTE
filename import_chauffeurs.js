#!/usr/bin/env node
// SyNdongo — Import chauffeurs depuis Wave
const fs = require('fs');
const DB_FILE = process.env.DATA_PATH || './syndongo_data.json';

let db = {};
try {
  if (fs.existsSync(DB_FILE)) {
    db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    console.log('Base existante chargee');
  }
} catch(e) { console.log('Nouvelle base'); }

if (!db.chauffeurs) db.chauffeurs = [];

const CHAUFFEURS = [
  {
    "prenom": "Aliou",
    "nom": "Diallo",
    "telephone": "+221766387351",
    "telephone_wave": "+221766387351",
    "numeros_wave": [
      "+221766387351"
    ],
    "id": "19d516cc16f6d1d",
    "statut": "actif",
    "date_embauche": "2026-01-01",
    "cree_par": "manager"
  },
  {
    "prenom": "Elhadji",
    "nom": "Malick Sow",
    "telephone": "+221775765091",
    "telephone_wave": "+221775765091",
    "numeros_wave": [
      "+221775765091"
    ],
    "id": "19d516cc1705cb0",
    "statut": "actif",
    "date_embauche": "2026-01-01",
    "cree_par": "manager"
  },
  {
    "prenom": "Papa",
    "nom": "CHEIKH Fall",
    "telephone": "+221776565916",
    "telephone_wave": "+221776565916",
    "numeros_wave": [
      "+221776565916"
    ],
    "id": "19d516cc1728cf0",
    "statut": "actif",
    "date_embauche": "2026-01-01",
    "cree_par": "manager"
  },
  {
    "prenom": "Daouda",
    "nom": "Diop",
    "telephone": "+221763716635",
    "telephone_wave": "+221763716635",
    "numeros_wave": [
      "+221763716635"
    ],
    "id": "19d516cc173efd3",
    "statut": "actif",
    "date_embauche": "2026-01-01",
    "cree_par": "manager"
  },
  {
    "prenom": "Ousmane",
    "nom": "Diao",
    "telephone": "+221761238872",
    "telephone_wave": "+221761238872",
    "numeros_wave": [
      "+221761238872"
    ],
    "id": "19d516cc1743bcb",
    "statut": "actif",
    "date_embauche": "2026-01-01",
    "cree_par": "manager"
  },
  {
    "prenom": "Cheikh",
    "nom": "Sarr",
    "telephone": "+221773024158",
    "telephone_wave": "+221773024158",
    "numeros_wave": [
      "+221773024158"
    ],
    "id": "19d516cc175f29e",
    "statut": "actif",
    "date_embauche": "2026-01-01",
    "cree_par": "manager"
  },
  {
    "prenom": "Mor",
    "nom": "Diop",
    "telephone": "+221765887012",
    "telephone_wave": "+221765887012",
    "numeros_wave": [
      "+221765887012"
    ],
    "id": "19d516cc176c9ba",
    "statut": "actif",
    "date_embauche": "2026-01-01",
    "cree_par": "manager"
  },
  {
    "prenom": "Thierno",
    "nom": "Fall",
    "telephone": "+221773800761",
    "telephone_wave": "+221773800761",
    "numeros_wave": [
      "+221773800761"
    ],
    "id": "19d516cc178b1d2",
    "statut": "actif",
    "date_embauche": "2026-01-01",
    "cree_par": "manager"
  },
  {
    "prenom": "Boubacar",
    "nom": "Gueye",
    "telephone": "+221764631513",
    "telephone_wave": "+221764631513",
    "numeros_wave": [
      "+221764631513"
    ],
    "id": "19d516cc179dbaa",
    "statut": "actif",
    "date_embauche": "2026-01-01",
    "cree_par": "manager"
  },
  {
    "prenom": "El",
    "nom": "Hadji Barry",
    "telephone": "+221775385846",
    "telephone_wave": "+221775385846",
    "numeros_wave": [
      "+221775385846"
    ],
    "id": "19d516cc17af09",
    "statut": "actif",
    "date_embauche": "2026-01-01",
    "cree_par": "manager"
  },
  {
    "prenom": "Souberou",
    "nom": "Kane",
    "telephone": "+221777173999",
    "telephone_wave": "+221777173999",
    "numeros_wave": [
      "+221777173999"
    ],
    "id": "19d516cc17bdf5",
    "statut": "actif",
    "date_embauche": "2026-01-01",
    "cree_par": "manager"
  },
  {
    "prenom": "Aliou",
    "nom": "Gueye",
    "telephone": "+221773368392",
    "telephone_wave": "+221773368392",
    "numeros_wave": [
      "+221773368392"
    ],
    "id": "19d516cc17cee0a",
    "statut": "actif",
    "date_embauche": "2026-01-01",
    "cree_par": "manager"
  },
  {
    "prenom": "Ousmane",
    "nom": "Fall",
    "telephone": "+221775544556",
    "telephone_wave": "+221775544556",
    "numeros_wave": [
      "+221775544556"
    ],
    "id": "19d516cc17d7221",
    "statut": "actif",
    "date_embauche": "2026-01-01",
    "cree_par": "manager"
  },
  {
    "prenom": "Andoye",
    "nom": "Ndoye",
    "telephone": "+221766862859",
    "telephone_wave": "+221766862859",
    "numeros_wave": [
      "+221766862859"
    ],
    "id": "19d516cc17e4ed3",
    "statut": "actif",
    "date_embauche": "2026-01-01",
    "cree_par": "manager"
  },
  {
    "prenom": "Thierno",
    "nom": "Sadou Balde",
    "telephone": "+221775145484",
    "telephone_wave": "+221775145484",
    "numeros_wave": [
      "+221775145484"
    ],
    "id": "19d516cc17f4079",
    "statut": "actif",
    "date_embauche": "2026-01-01",
    "cree_par": "manager"
  },
  {
    "prenom": "Ablaye",
    "nom": "Gueye",
    "telephone": "+221771408239",
    "telephone_wave": "+221771408239",
    "numeros_wave": [
      "+221771408239"
    ],
    "id": "19d516cc1818de4",
    "statut": "actif",
    "date_embauche": "2026-01-01",
    "cree_par": "manager"
  },
  {
    "prenom": "Mouhamadou",
    "nom": "Lamine NDIAYE",
    "telephone": "+221766577664",
    "telephone_wave": "+221766577664",
    "numeros_wave": [
      "+221766577664"
    ],
    "id": "19d516cc182de21",
    "statut": "actif",
    "date_embauche": "2026-01-01",
    "cree_par": "manager"
  },
  {
    "prenom": "Papa",
    "nom": "Salla Dieng",
    "telephone": "+221771842063",
    "telephone_wave": "+221771842063",
    "numeros_wave": [
      "+221771842063"
    ],
    "id": "19d516cc183174e",
    "statut": "actif",
    "date_embauche": "2026-01-01",
    "cree_par": "manager"
  },
  {
    "prenom": "Masayér.",
    "nom": "Wad",
    "telephone": "+221766387200",
    "telephone_wave": "+221766387200",
    "numeros_wave": [
      "+221766387200"
    ],
    "id": "19d516cc184eaa7",
    "statut": "actif",
    "date_embauche": "2026-01-01",
    "cree_par": "manager"
  },
  {
    "prenom": "Massaer",
    "nom": "Baly Wade",
    "telephone": "+221768723564",
    "telephone_wave": "+221768723564",
    "numeros_wave": [
      "+221768723564"
    ],
    "id": "19d516cc1856133",
    "statut": "actif",
    "date_embauche": "2026-01-01",
    "cree_par": "manager"
  },
  {
    "prenom": "Sering",
    "nom": "Moutafa Diaw",
    "telephone": "+221774237118",
    "telephone_wave": "+221774237118",
    "numeros_wave": [
      "+221774237118"
    ],
    "id": "19d516cc186f699",
    "statut": "actif",
    "date_embauche": "2026-01-01",
    "cree_par": "manager"
  },
  {
    "prenom": "Gassa",
    "nom": "Ka",
    "telephone": "+221751087331",
    "telephone_wave": "+221751087331",
    "numeros_wave": [
      "+221751087331"
    ],
    "id": "19d516cc1879b24",
    "statut": "actif",
    "date_embauche": "2026-01-01",
    "cree_par": "manager"
  },
  {
    "prenom": "Abdou",
    "nom": "Aziz mbaye",
    "telephone": "+221775782262",
    "telephone_wave": "+221775782262",
    "numeros_wave": [
      "+221775782262"
    ],
    "id": "19d516cc188cd74",
    "statut": "actif",
    "date_embauche": "2026-01-01",
    "cree_par": "manager"
  },
  {
    "prenom": "cheikh",
    "nom": "seye",
    "telephone": "+221710292996",
    "telephone_wave": "+221710292996",
    "numeros_wave": [
      "+221710292996"
    ],
    "id": "19d516cc1899cec",
    "statut": "actif",
    "date_embauche": "2026-01-01",
    "cree_par": "manager"
  },
  {
    "prenom": "Math",
    "nom": "Mbaye",
    "telephone": "+221782245101",
    "telephone_wave": "+221782245101",
    "numeros_wave": [
      "+221782245101"
    ],
    "id": "19d516cc18b1508",
    "statut": "actif",
    "date_embauche": "2026-01-01",
    "cree_par": "manager"
  },
  {
    "prenom": "Mbaye",
    "nom": "Diop",
    "telephone": "+221761329425",
    "telephone_wave": "+221761329425",
    "numeros_wave": [
      "+221761329425"
    ],
    "id": "19d516cc18cf1ec",
    "statut": "actif",
    "date_embauche": "2026-01-01",
    "cree_par": "manager"
  },
  {
    "prenom": "Abdoulay",
    "nom": "Sarr",
    "telephone": "+221781031620",
    "telephone_wave": "+221781031620",
    "numeros_wave": [
      "+221781031620"
    ],
    "id": "19d516cc18dea29",
    "statut": "actif",
    "date_embauche": "2026-01-01",
    "cree_par": "manager"
  },
  {
    "prenom": "Ousseynou",
    "nom": "Sene",
    "telephone": "+221772720928",
    "telephone_wave": "+221772720928",
    "numeros_wave": [
      "+221772720928"
    ],
    "id": "19d516cc18eb9f6",
    "statut": "actif",
    "date_embauche": "2026-01-01",
    "cree_par": "manager"
  },
  {
    "prenom": "Babacar",
    "nom": "Niang",
    "telephone": "+221779385626",
    "telephone_wave": "+221779385626",
    "numeros_wave": [
      "+221779385626"
    ],
    "id": "19d516cc18fce8a",
    "statut": "actif",
    "date_embauche": "2026-01-01",
    "cree_par": "manager"
  },
  {
    "prenom": "Cheikhou",
    "nom": "Wade",
    "telephone": "+221782080730",
    "telephone_wave": "+221782080730",
    "numeros_wave": [
      "+221782080730"
    ],
    "id": "19d516cc1901ea3",
    "statut": "actif",
    "date_embauche": "2026-01-01",
    "cree_par": "manager"
  },
  {
    "prenom": "Mor",
    "nom": "Ndong",
    "telephone": "+221781721220",
    "telephone_wave": "+221781721220",
    "numeros_wave": [
      "+221781721220"
    ],
    "id": "19d516cc19153ff",
    "statut": "actif",
    "date_embauche": "2026-01-01",
    "cree_par": "manager"
  },
  {
    "prenom": "Mansor",
    "nom": "Kane",
    "telephone": "+221783125277",
    "telephone_wave": "+221783125277",
    "numeros_wave": [
      "+221783125277"
    ],
    "id": "19d516cc1927cdb",
    "statut": "actif",
    "date_embauche": "2026-01-01",
    "cree_par": "manager"
  },
  {
    "prenom": "Demba",
    "nom": "Kholle",
    "telephone": "+221779892962",
    "telephone_wave": "+221779892962",
    "numeros_wave": [
      "+221779892962"
    ],
    "id": "19d516cc193514b",
    "statut": "actif",
    "date_embauche": "2026-01-01",
    "cree_par": "manager"
  },
  {
    "prenom": "Adama",
    "nom": "Mbaye",
    "telephone": "+221766240622",
    "telephone_wave": "+221766240622",
    "numeros_wave": [
      "+221766240622"
    ],
    "id": "19d516cc1943966",
    "statut": "actif",
    "date_embauche": "2026-01-01",
    "cree_par": "manager"
  },
  {
    "prenom": "Assane",
    "nom": "Thioune",
    "telephone": "+221763470812",
    "telephone_wave": "+221763470812",
    "numeros_wave": [
      "+221763470812"
    ],
    "id": "19d516cc196420a",
    "statut": "actif",
    "date_embauche": "2026-01-01",
    "cree_par": "manager"
  },
  {
    "prenom": "Ndiaga",
    "nom": "Diop",
    "telephone": "+221772413924",
    "telephone_wave": "+221772413924",
    "numeros_wave": [
      "+221772413924"
    ],
    "id": "19d516cc197fb8c",
    "statut": "actif",
    "date_embauche": "2026-01-01",
    "cree_par": "manager"
  },
  {
    "prenom": "Magatte",
    "nom": "Diop",
    "telephone": "+221765191673",
    "telephone_wave": "+221765191673",
    "numeros_wave": [
      "+221765191673"
    ],
    "id": "19d516cc1985f3c",
    "statut": "actif",
    "date_embauche": "2026-01-01",
    "cree_par": "manager"
  },
  {
    "prenom": "Babacar",
    "nom": "Gueye",
    "telephone": "+221773198704",
    "telephone_wave": "+221773198704",
    "numeros_wave": [
      "+221773198704"
    ],
    "id": "19d516cc199169e",
    "statut": "actif",
    "date_embauche": "2026-01-01",
    "cree_par": "manager"
  }
];

let ajoutes = 0, ignores = 0, doublons = 0;

for (const c of CHAUFFEURS) {
  // Vérifier doublon par téléphone
  if (db.chauffeurs.find(x => x.telephone === c.telephone)) {
    // Mettre à jour les numéros Wave si manquants
    const idx = db.chauffeurs.findIndex(x => x.telephone === c.telephone);
    if (!db.chauffeurs[idx].numeros_wave || !db.chauffeurs[idx].numeros_wave.length) {
      db.chauffeurs[idx].numeros_wave = c.numeros_wave;
      db.chauffeurs[idx].telephone_wave = c.telephone_wave;
      console.log('  Wave mis à jour:', c.prenom, c.nom);
    }
    doublons++;
    continue;
  }
  db.chauffeurs.push(c);
  ajoutes++;
}

fs.writeFileSync(DB_FILE, JSON.stringify(db));
console.log('');
console.log('Import termine !');
console.log('  Chauffeurs ajoutes  :', ajoutes);
console.log('  Deja existants      :', doublons);
console.log('  Total chauffeurs    :', db.chauffeurs.length);
console.log('');
console.log('Liste des chauffeurs importes:');
CHAUFFEURS.forEach(c => console.log(' ', c.prenom, c.nom, '-', c.telephone));
