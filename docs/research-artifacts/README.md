# Artefactos de investigación

Copia de los 38 artefactos de GitHub Actions del repositorio, descargados el 2026-10-24 antes de que vencieran (1 a 19 de enero de 2027). Son resultados de backtests y walk-forward de `main` y de las ramas `research/*` y `security/dependency-remediation`. Ninguno califica como estrategia; la lectura de cada rama está en [`../RESEARCH_BRANCHES.md`](../RESEARCH_BRANCHES.md).

- Estructura: `<rama>/<fecha>-<artifact_id>-<nombre>/`, con el contenido del zip sin modificar.
- [`manifest.tsv`](manifest.tsv): por cada archivo, artefacto, rama, commit (`head_sha`), ejecución (`run_id`), fecha y SHA-256.
- El código que produjo cada resultado está en el commit indicado. Para repetir una corrida, usar ese commit y su workflow, no estos archivos.
