# Automatisation SyNdongo

Suite de scripts pour automatiser le deploiement, la sauvegarde et le lancement de SyNdongo sur votre PC Windows.

---

## Les 4 scripts disponibles

| Script | Role | Quand l'utiliser |
|---|---|---|
| `start.bat` | Lance le serveur Node.js localement | Pour travailler en local sur http://localhost:8000 |
| `deploy.bat` | Push manuel vers Railway en un clic | Quand vous avez fini une modification et voulez la deployer |
| `auto-deploy.bat` | Push automatique toutes les 5 minutes | A laisser tourner en arriere-plan pendant que vous codez |
| `backup.bat` | Sauvegarde les fichiers de donnees JSON | A planifier en tache quotidienne (voir plus bas) |

---

## 1. Demarrage rapide

### Lancer le serveur local
Double-cliquez sur `start.bat`. Le serveur ecoute sur http://localhost:8000.

### Deployer une modification vers Railway
1. Modifiez `index.html` ou autres fichiers.
2. Double-cliquez sur `deploy.bat`.
3. Saisissez un message de commit (ou Entree pour message automatique).
4. Le push se fait, Railway redeploie en 30s-2min.

---

## 2. Auto-deploiement permanent

Si vous voulez que **chaque modification** soit poussee automatiquement vers Railway sans intervention :

1. Double-cliquez sur `auto-deploy.bat`.
2. Laissez la fenetre ouverte en arriere-plan.
3. Toutes les 5 minutes, le script detecte vos changements, fait `git add/commit/push`.

**Pour arreter** : fermez la fenetre du script.

> Astuce : pour le lancer au demarrage de Windows, faites un raccourci de `auto-deploy.bat` dans le dossier `shell:startup` (Win+R puis tapez ce nom).

---

## 3. Sauvegarde quotidienne automatique

Le script `backup.bat` copie `syndongo_data.json` et `import_data_local.json` dans un dossier `backups/` avec horodatage. Il garde les 30 dernieres sauvegardes.

### Programmer une tache planifiee (Planificateur de taches Windows)

1. Appuyez sur **Win + R**, tapez `taskschd.msc`, Entree.
2. Dans le panneau de droite : **Creer une tache de base...**
3. **Nom** : `SyNdongo Backup quotidien`
4. **Declencheur** : Quotidien, choisir une heure (ex : 23h00).
5. **Action** : Demarrer un programme.
6. **Programme/script** : `C:\Users\USER\Downloads\syndongo_railway\syndongoFLOTTE\backup.bat`
7. **Ajouter des arguments** : `--silent`
8. **Demarrer dans** : `C:\Users\USER\Downloads\syndongo_railway\syndongoFLOTTE`
9. Terminer.

La sauvegarde se fera automatiquement chaque jour a l'heure choisie, meme PC verrouille (cocher "Executer meme si l'utilisateur n'est pas connecte" dans les proprietes avancees).

---

## 4. Workflow recommande

### En developpement (modifications frequentes)
```
1. Lancer start.bat (terminal 1) — serveur local
2. Lancer auto-deploy.bat (terminal 2) — push auto
3. Modifier vos fichiers, tester sur localhost:8000
4. Les changements sont deployes vers Railway toutes les 5 min
```

### En production stable (modifications ponctuelles)
```
1. Modifier vos fichiers
2. Tester avec start.bat
3. Quand pret : double-clic sur deploy.bat
```

### Securite des donnees
```
1. backup.bat programme tous les jours a 23h00
2. Verifier de temps en temps le dossier backups/
3. Copier backups/ sur un disque externe une fois par mois
```

---

## 5. Resolution de problemes

### "Git n'est pas installe"
Telechargez et installez Git : https://git-scm.com/download/win

### "Push echoue - authentification"
Configurez vos identifiants GitHub :
```
git config --global user.name "Votre Nom"
git config --global user.email "votre@email.com"
```
Pour le mot de passe : utilisez un **Personal Access Token** (PAT) GitHub (Settings > Developer settings > Tokens).

### "Node.js non trouve"
Installez Node.js 18+ : https://nodejs.org

### auto-deploy.bat ne pousse pas
- Verifiez que vous etes sur la branche `main` : `git branch`
- Verifiez le remote : `git remote -v`
- Faites un `deploy.bat` manuel pour tester l'authentification

---

## 6. Fichiers concernes

```
syndongoFLOTTE/
├── start.bat            ← Lance serveur local
├── deploy.bat           ← Push manuel Railway
├── auto-deploy.bat      ← Push automatique toutes les 5 min
├── backup.bat           ← Sauvegarde JSON (--silent pour tache planifiee)
├── backups/             ← Cree automatiquement, 30 dernieres sauvegardes
├── serveur.js           ← Backend Node.js
├── index.html           ← Frontend
├── syndongo_data.json   ← Donnees principales
└── import_data_local.json
```
