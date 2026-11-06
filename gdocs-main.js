// Exécuté dans la page Google Docs (world MAIN), avant les scripts de Docs.
// Demande à Docs de doubler son canvas d'éléments SVG <rect aria-label="texte"> lisibles.
// Docs ne le fait que pour les extensions qu'il autorise : on reprend l'ID de l'une d'elles.
// Hack non officiel, peut cesser de fonctionner. Seuls les soulignements en dépendent,
// la lecture et la correction passent par l'API Docs.
window._docs_annotate_canvas_by_ext = 'kbfnbcaeplbcioakkpcpgfkobkghlhen';
