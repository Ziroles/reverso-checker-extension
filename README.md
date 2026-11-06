# Reverso Checker (non officiel)

Extension Chrome / Edge / Brave (Manifest V3) qui souligne les fautes d'orthographe, de grammaire et de ponctuation dans les champs de texte, comme LanguageTool, avec le correcteur en ligne de Reverso.

> Projet personnel, **non affilié à Reverso**. Voir [À savoir](#à-savoir) avant de l'utiliser.

## Installation

1. Récupérer le dossier `reverso-checker` (le décompresser si besoin).
2. Ouvrir `chrome://extensions` (ou `edge://extensions`, `brave://extensions`).
3. Activer le **mode développeur** (en haut à droite).
4. Cliquer sur **Charger l'extension non empaquetée** et choisir le dossier `reverso-checker`.
5. Recharger les onglets déjà ouverts : le script n'est injecté que dans les pages chargées après l'installation.

Après une modification du code : bouton ⟳ de l'extension dans `chrome://extensions`, puis recharger la page testée.

## Utilisation

1. Cliquer dans un champ de texte et écrire. Le texte est vérifié après une courte pause de frappe (900 ms par défaut).
2. Les fautes sont soulignées par une vague de couleur :

   | Couleur | Catégorie   |
   |---------|-------------|
   | Rouge   | Orthographe |
   | Bleu    | Grammaire   |
   | Jaune   | Ponctuation |

3. Cliquer sur un mot souligné (ou y placer le curseur avec les flèches) ouvre sa carte :
   - **Corriger** applique la suggestion principale ;
   - les **alternatives** en dessous appliquent une autre suggestion ;
   - **Pourquoi ?** affiche l'explication de Reverso ;
   - **Ignorer** masque cette faute pour la session (jusqu'au rechargement de la page) ;
   - **Ajouter au dictionnaire** l'ignore définitivement (mots d'un seul tenant uniquement).
4. La pastille en bas à droite du champ résume l'état :

   | Pastille     | Signification                                  |
   |--------------|------------------------------------------------|
   | ✓ verte      | aucune faute                                   |
   | nombre rouge | nombre de fautes, cliquer pour la liste        |
   | … grise      | vérification en cours                          |
   | ! jaune      | erreur (survoler pour le détail)               |

5. La liste ouverte par la pastille montre toutes les fautes du champ :
   - cliquer sur une ligne applique sa première suggestion ;
   - **Tout corriger** applique toutes les premières suggestions ;
   - les boutons **Orthographe (n)**, **Grammaire (n)**, **Ponctuation (n)** ne corrigent que cette catégorie (affichés quand plusieurs catégories sont présentes).

Après une correction, les soulignements des autres fautes restent en place. Seule la phrase modifiée est revérifiée, et ses soulignements sont mis à jour à l'arrivée de la réponse.

## Raccourcis clavier

Actifs quand le curseur est dans un champ surveillé.

| Raccourci            | Action                                                   |
|----------------------|----------------------------------------------------------|
| `Alt+Entrée`         | Appliquer la suggestion principale de la carte ouverte   |
| `Alt+Maj+Entrée`     | Tout corriger dans le champ                              |
| `Alt+Maj+O`          | Corriger seulement l'**o**rthographe                     |
| `Alt+Maj+G`          | Corriger seulement la **g**rammaire                      |
| `Alt+Maj+P`          | Corriger seulement la **p**onctuation                    |
| `Échap`              | Fermer la carte ou la liste                              |

Les lettres sont lues par position physique de touche (`KeyboardEvent.code`) : `O`, `G` et `P` sont au même endroit en AZERTY et en QWERTY.

## Réglages

**Popup** (icône de l'extension dans la barre d'outils) :
- activer ou désactiver la correction partout ;
- choisir le comportement **par défaut** :
  - **Actif** : correction partout, sauf sur les sites exclus (liste noire) ;
  - **Inactif** : correction nulle part, sauf sur les sites autorisés (liste blanche) ;
- activer ou couper le site courant (ajoute ou retire le site de la liste du mode choisi) ;
- choisir la langue : Auto, FR ou EN.

**Page d'options** (lien « Dictionnaire et options » dans la popup) :
- langue par défaut (la détection automatique choisit le français en cas de doute) ;
- délai avant vérification, de 300 à 5000 ms (plus long = moins de requêtes) ;
- dictionnaire personnel, un mot par ligne ;
- mode par défaut et listes de sites, un domaine par ligne. `example.com` vise ce domaine exact, `*.example.com` vise aussi ses sous-domaines. Les deux listes sont conservées quand on change de mode ;
- diagnostic : dernière réponse brute de Reverso et statistiques du cache.

Les réglages sont stockés dans `chrome.storage.sync` et suivent le compte du navigateur.

## Champs et éditeurs pris en charge

- `<textarea>` et `<input type="text">` / `type="search"` : un calque transparent reproduit le texte par-dessus le champ et porte les soulignements.
- Zones `contenteditable` (Discord, Gmail, Messenger, Notion, ChatGPT…) : soulignements via l'API CSS Custom Highlight, sans modifier le DOM de la page. Un `MutationObserver` reconstruit les soulignements quand l'éditeur re-rend son contenu.
- Pour appliquer une correction dans un éditeur riche (Slate, Lexical, Draft, ProseMirror…), l'extension essaie dans l'ordre :
  1. un événement `beforeinput` avec la plage exacte à remplacer (`targetRanges`) ;
  2. `document.execCommand('insertText')` ;
  3. un collage simulé ;
  4. en dernier recours, la faute est sélectionnée et la correction copiée : faire `Ctrl+V`.

Champs ignorés : mots de passe, e-mail, téléphone, adresse, codes à usage unique, champs en lecture seule et champs marqués `spellcheck="false"`.

## Google Docs

Google Docs dessine le texte dans un `<canvas>` : le correcteur des champs ordinaires n'y voit rien. Les documents Google Docs passent donc par un chemin à part :

- **lecture et correction par l'API Google Docs** officielle (`documents.get`, `documents.batchUpdate`), après connexion à votre compte Google ;
- **panneau latéral** : liste des fautes avec leur contexte, suggestions, « Tout corriger », filtre par catégorie, « Ignorer », « Ajouter au dictionnaire » ;
- **soulignements dans la page**, par-dessus le canvas. Cliquer sur un soulignement ouvre une carte de correction.

Les soulignements reposent sur un hack : `gdocs-main.js` demande à Docs son mode « canvas annoté » (texte doublé en SVG) en se faisant passer pour une extension que Google autorise. Ce mode peut disparaître à tout moment. Dans ce cas, seuls les soulignements manquent : le panneau continue de fonctionner. Pour vérifier qu'il est actif, dans la console de la page Docs : `document.querySelectorAll('rect[aria-label]').length` doit être supérieur à 0.

Fonctionne uniquement avec **Chrome** : `chrome.identity.getAuthToken` n'existe pas dans Edge ni Brave.

### Configuration (une fois, environ 10 minutes)

1. Charger l'extension (voir [Installation](#installation)), puis copier son **ID** affiché dans `chrome://extensions`.
2. Sur <https://console.cloud.google.com>, créer un projet.
3. **API et services > Bibliothèque** : activer **Google Docs API**.
4. **Écran de consentement OAuth** (Google Auth Platform) :
   - type **Externe**, nom de l'application et e-mail au choix ;
   - **Audience > Utilisateurs test** : ajouter votre propre adresse Gmail ;
   - **Accès aux données** : ajouter le scope `https://www.googleapis.com/auth/documents`.
5. **Identifiants > Créer des identifiants > ID client OAuth** :
   - type d'application **Extension Chrome** ;
   - **ID de l'article** : l'ID copié à l'étape 1.
6. Copier l'ID client (`….apps.googleusercontent.com`) dans `manifest.json`, champ `oauth2.client_id`, à la place de `REMPLACER_PAR_VOTRE_CLIENT_ID.apps.googleusercontent.com`.
7. Recharger l'extension (⟳) et la page Docs.

L'ID d'une extension non empaquetée dépend du chemin du dossier : si vous déplacez le dossier, l'ID change et il faut refaire l'étape 5.

### Utilisation

1. Ouvrir un document, cliquer sur l'icône de l'extension, puis sur **Panneau**.
2. Première fois : **Se connecter et vérifier**, puis accepter l'accès à vos documents. Google affiche un avertissement « application non validée » : c'est normal pour un projet en mode test, cliquer sur **Continuer**.
3. Ensuite, la vérification se relance seule quelques secondes après la fin de la frappe : l'extension interroge la révision du document toutes les 5 s et ne revérifie que si elle a changé.

Fonctionnement :

- Le document est découpé en lots de 6000 caractères, envoyés à Reverso à la suite. Le cache par phrase évite de renvoyer le texte inchangé : sur un gros document, seule la première vérification est longue. Sur HTTP 429, l'extension attend puis réessaie.
- Avant chaque correction, le document est relu. La faute est retrouvée à sa position ou, si le texte a bougé, par son contexte. La modification est envoyée avec `requiredRevisionId` : si quelqu'un modifie le document au même moment, elle est refusée puis retentée une fois.
- Seul le corps de l'onglet affiché (`?tab=`) est vérifié. En-têtes, pieds de page, notes de bas de page et tables des matières sont ignorés.
- Une faute qui contient une image ou un saut de paragraphe est signalée mais pas corrigée automatiquement.
- Le scope `documents` donne à l'extension un accès en lecture et en écriture à tous vos Google Docs. Le jeton reste dans Chrome et ne sert qu'aux appels vers `docs.googleapis.com`. Le texte du document part chez Reverso, comme pour les autres champs.

## Fonctionnement

```
content.js  (chaque page)                    background.js  (service worker)
──────────────────────────                   ───────────────────────────────
détecte le champ actif          ──message──▶ découpe le texte en phrases
souligne, cartes, raccourcis                 cache par phrase (800 max)
recale les fautes à la frappe   ◀─réponse─── n'envoie que les phrases modifiées
                                             à orthographe.reverso.net
```

- Seules les phrases nouvelles ou modifiées partent à l'API, par requêtes de 3000 caractères max. Les autres sortent du cache.
- Requêtes identiques en cours dédupliquées, 2 en parallèle max. Sur HTTP 429 ou 5xx : pause exponentielle (jusqu'à 60 s), puis nouvel essai automatique.
- Entre deux réponses, les fautes avant ou après la zone modifiée sont décalées ; celles qui la chevauchent sont retirées.
- Langue auto : comptage de mots-outils et d'accents français ou anglais.
- Limite : 10 000 caractères par vérification.

| Fichier        | Rôle                                                        |
|----------------|-------------------------------------------------------------|
| `manifest.json`| Déclaration MV3, permissions                                |
| `background.js`| Appels API, découpage, cache, file d'attente                |
| `common.js`    | Réglages par défaut, règles de sites, langue (partagé)      |
| `gdocs-bg.js`  | Google Docs : OAuth, API Docs, vérification, corrections    |
| `gdocs-main.js`| Google Docs : active le canvas annoté (monde de la page)    |
| `gdocs.js`     | Google Docs : soulignements et carte dans la page           |
| `sidepanel.*`  | Panneau latéral Google Docs                                 |
| `content.js`   | Détection des champs, soulignement, carte, liste, raccourcis|
| `content.css`  | Couleurs des soulignements `contenteditable`                |
| `popup.*`      | Popup de la barre d'outils                                  |
| `options.*`    | Page d'options et diagnostic                                |

`background.js` exporte `check`, `splitChunks`, `normalizeRange` et `mapCorrections` sous Node, pour les tester hors navigateur :

```sh
node -e "const b = require('./background.js'); console.log(b.splitChunks('Bonjour. Ça va ?'))"
```

## Dépannage

| Problème | Piste |
|----------|-------|
| Rien n'est souligné | Recharger la page après l'installation ou la mise à jour. Vérifier dans la popup que le site est actif (en mode « Inactif par défaut », il doit être dans la liste blanche). |
| Pastille `!` jaune | Survoler pour lire l'erreur. « Trop de requêtes » : l'extension fait une pause puis réessaie seule. « Extension rechargée » : recharger la page. |
| Une faute n'est pas détectée | Options, section Diagnostic : voir ce que Reverso a renvoyé. |
| La correction ne s'applique pas | Le site bloque la modification. La correction est copiée dans le presse-papiers : `Ctrl+V`. |
| Mauvaise langue | Forcer FR ou EN dans la popup. |

## À savoir

- L'extension appelle `https://orthographe.reverso.net/api/v1/Spelling`, l'API privée du site de Reverso. Reverso peut la modifier, la limiter ou la bloquer à tout moment, et l'utiliser hors de leur site peut contrevenir à leurs conditions d'utilisation. Usage personnel uniquement.
- Le texte tapé dans les champs surveillés part sur les serveurs de Reverso. Désactiver l'extension sur les sites sensibles (messagerie pro, banque, santé…) via la popup ou la page d'options.
- Langues : français et anglais uniquement (`fra` / `eng`).
