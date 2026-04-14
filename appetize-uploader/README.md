# Appetize.io APK Manager

Upload et supprime des APKs sur Appetize.io depuis des artefacts GitHub Actions.

## Setup (une seule fois)

```bash
cd appetize-uploader
npm install
npx playwright install chromium
```

## Commandes

### Upload un APK depuis GitHub Actions

```bash
GITHUB_PAT=ghp_xxx node script.js upload <owner/repo> <run_id> <artifact_name>
```

Exemple (ton artefact):
```bash
GITHUB_PAT=ghp_xxx node script.js upload ferelking242/watchtower 24347257733 app-arm64-profile
```

### Supprimer une app

```bash
node script.js delete [nom_ou_partie_du_nom]
```

Exemple:
```bash
node script.js delete watchtower
node script.js delete           # supprime la première app trouvée
```

### Lister les apps

```bash
node script.js list
```

## Première utilisation — Connexion manuelle

Au premier lancement, le navigateur s'ouvre sur Appetize.io.  
Connecte-toi manuellement. Le script détecte la connexion et sauvegarde la session dans `cookies.json`.  
Tous les lancements suivants se connectent automatiquement.

## Variables d'environnement

| Variable | Description |
|----------|-------------|
| `GITHUB_PAT` | Personal Access Token GitHub (requis pour les artefacts privés) |

Le PAT est aussi lu depuis les secrets Replit si défini comme `GITHUB_PAT`.

## Fichiers générés

| Fichier | Description |
|---------|-------------|
| `cookies.json` | Session Appetize.io (auto-généré après 1er login) |
| `app.apk` | APK téléchargé (écrasé à chaque run) |
| `artifact_extracted/` | Contenu extrait du ZIP GitHub |
| `screenshots/` | Screenshots d'erreur pour debug |

## Configuration

Édite le bloc `CONFIG` en haut de `script.js` :

| Option | Défaut | Description |
|--------|--------|-------------|
| `headless` | `false` | `true` = pas de fenêtre navigateur |
| `timeouts.uploadConfirmation` | 180s | Attente max upload |
| `timeouts.manualLogin` | 180s | Temps pour login manuel |
| `retries.upload` | 3 | Tentatives en cas d'échec |
| `retries.download` | 3 | Tentatives téléchargement |

## Dépannage

- **Session expirée** → Supprime `cookies.json` et relance
- **Bouton Delete introuvable** → Consulte `screenshots/delete-button-not-found-*.png`
- **APK introuvable dans ZIP** → L'artefact ne contient pas de `.apk` — vérifie le run GitHub Actions
- **403 GitHub** → Ton PAT n'a pas les droits `actions:read` — regénère-le
