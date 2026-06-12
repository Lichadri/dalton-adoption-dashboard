# Dalton DS — Adoption Dashboard

Dashboard automático que mide adopción de la librería Dalton en frames con anotación **Ready for Dev**.

## Estructura

```
dalton-adoption-dashboard/
├── adoption-script.js       ← script principal
├── files-config.json        ← lista de archivos a escanear (EDITAR AQUÍ)
├── adoption-history.json    ← historial por quarter (generado automáticamente)
├── docs/
│   ├── index.html           ← dashboard web
│   └── report.json          ← datos del último reporte (generado automáticamente)
└── .github/workflows/
    └── adoption-report.yml  ← GitHub Actions (corre L-V 10am y 4pm Lima)
```

## Setup inicial

### 1. Crear el repo en GitHub

1. Ve a github.com → New repository
2. Nombre: `dalton-adoption-dashboard`
3. Visibilidad: **Public** (necesario para GitHub Pages gratis)
4. No inicialices con README (ya tenemos uno)

### 2. Subir los archivos

```bash
cd dalton-adoption-dashboard
git init
git add .
git commit -m "feat: initial setup"
git remote add origin https://github.com/TU_USUARIO/dalton-adoption-dashboard.git
git push -u origin main
```

### 3. Agregar el secret de Figma

1. Ve al repo en GitHub → Settings → Secrets and variables → Actions
2. New repository secret:
   - Name: `FIGMA_TOKEN`
   - Value: tu token de Figma (`figd_...`)

### 4. Activar GitHub Pages

1. Settings → Pages
2. Source: **Deploy from a branch**
3. Branch: `main` / folder: `/docs`
4. Save

Tu dashboard estará en: `https://TU_USUARIO.github.io/dalton-adoption-dashboard/`

### 5. Primer reporte manual

Actions → Dalton Adoption Report → Run workflow

---

## Agregar un archivo nuevo

Edita `files-config.json` directamente en GitHub:

```json
{
  "teams": [
    {
      "name": "Modelo Día",
      "files": [
        {
          "key": "sDx9W33S6h0bwrHdGMBe00",
          "name": "Modelo Día 2026"
        },
        {
          "key": "NUEVO_KEY_AQUÍ",     ← agrega aquí
          "name": "Nombre del archivo"
        }
      ]
    },
    {
      "name": "Nuevo Equipo",          ← o un equipo nuevo
      "files": [
        {
          "key": "KEY_DEL_ARCHIVO",
          "name": "Nombre del archivo"
        }
      ]
    }
  ]
}
```

**Cómo extraer el key de un link de Figma:**
```
https://www.figma.com/design/sDx9W33S6h0bwrHdGMBe00/Nombre...
                              ^^^^^^^^^^^^^^^^^^^^^^^
                              ese es el key
```

---

## Cómo funciona el script

1. Lee `files-config.json`
2. Para cada archivo, llama a `/v1/files/:key/annotations` para encontrar nodos con "Ready for Dev"
3. Descarga los nodos anotados y cuenta instancias DS vs no-DS
4. Guarda el resultado en `docs/report.json` y el historial en `adoption-history.json`
5. El dashboard lee `report.json` y lo renderiza

## Target de adopción

**75%** — equipos en verde ≥75%, amarillo ≥50%, rojo <50%
