# appetize-deploy

Déploiement automatique d'APKs sur [Appetize.io](https://appetize.io) depuis des artefacts GitHub Actions.

Gère l'authentification via cookies de session persistants, télécharge l'APK depuis un run CI privé, et l'uploade via automatisation Playwright.

---

## Installation (une seule fois)

```bash
cd appetize-uploader
npm install
npx playwright install chromium
```

---

## Commandes

### Upload un APK depuis GitHub Actions

```bash
GITHUB_PAT=ghp_xxx node script.js upload <owner/repo> <run_id> <artifact_name>
```

Exemple :
```bash
GITHUB_PAT=ghp_xxx node script.js upload ferelking242/watchtower 24347257733 app-arm64-profile
```

### Upload l'APK déjà sur disque (sans téléchargement)

```bash
GITHUB_PAT=ghp_xxx node script.js upload-file
```

> Place ton APK dans `appetize-uploader/app.apk` avant de lancer.

### Supprimer une app

```bash
node script.js delete [nom_ou_partie_du_nom]
```

Exemples :
```bash
node script.js delete watchtower   # supprime l'app "watchtower"
node script.js delete              # supprime la première app trouvée
```

### Lister les apps

```bash
node script.js list
```

---

## Authentification & Session

### Première utilisation

Au premier lancement (aucun `cookies.json`), le navigateur s'ouvre sur Appetize.io.  
Connecte-toi manuellement. Le script détecte la connexion et sauvegarde la session dans `cookies.json`.  
Tous les lancements suivants utilisent cette session automatiquement.

### Session expirée

Le script **vérifie automatiquement** la validité de la session au démarrage.  
Si les cookies sont expirés, il les supprime et te demande de te reconnecter.  
Tu n'auras plus jamais d'upload silencieux qui échoue avec code 0.

Pour forcer une reconnexion manuellement :
```bash
rm appetize-uploader/cookies.json
node script.js upload ...
```

---

## Variables d'environnement

| Variable | Description |
|----------|-------------|
| `GITHUB_PAT` | Personal Access Token GitHub — requis pour accéder aux artefacts privés. Permissions requises : `actions:read` |

---

## Fichiers générés

| Fichier | Description |
|---------|-------------|
| `cookies.json` | Session Appetize.io (auto-généré après login, mis à jour après chaque run) |
| `app.apk` | APK téléchargé (écrasé à chaque run) |
| `artifact.zip` | Archive GitHub temporaire (supprimée automatiquement) |
| `screenshots/` | Screenshots automatiques en cas d'erreur (pour debug) |

---

## Configuration

Édite le bloc `CONFIG` en haut de `script.js` :

| Option | Défaut | Description |
|--------|--------|-------------|
| `headless` | `true` | `false` = affiche la fenêtre navigateur |
| `timeouts.uploadConfirmation` | 180s | Attente max confirmation upload |
| `timeouts.manualLogin` | 180s | Temps accordé pour le login manuel |
| `retries.upload` | 3 | Tentatives en cas d'échec upload |
| `retries.download` | 3 | Tentatives en cas d'échec téléchargement |

---

## Dépannage

| Symptôme | Solution |
|----------|----------|
| Session expirée / redirigé vers login | Supprime `cookies.json` et relance |
| `403 GitHub` sur téléchargement | Le PAT n'a pas les droits `actions:read` — regénère-le |
| APK introuvable dans le ZIP | L'artefact ne contient pas de `.apk` — vérifie le run GitHub Actions |
| Bouton Delete introuvable | Consulte `screenshots/delete-button-not-found-*.png` |
| Upload "réussi" mais app absente | Vérifie `screenshots/` — la page de login a peut-être été confondue avec un succès (corrigé en v2) |
