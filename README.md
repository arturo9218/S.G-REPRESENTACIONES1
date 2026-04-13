# SgMonitor

This project was generated with [Angular CLI](https://github.com/angular/angular-cli) version 16.2.16.

## Comandos npm (carpeta correcta)

Los scripts (`npm run build`, `npm start`, `npm run manual:pdf`, etc.) deben ejecutarse **desde esta carpeta `FRONTEND`**, donde está el `package.json` principal:

```bash
cd FRONTEND
npm run manual:pdf
```

Si la terminal está abierta en la **carpeta padre** (la que contiene `FRONTEND`), podés usar `cd FRONTEND && npm run manual:pdf`, o bien `npm run manual:pdf` **desde esa carpeta padre** si allí existe un `package.json` con ese script (metapackage en la raíz del workspace).

## Servidor de desarrollo

`npm start` / `ng serve` escucha en **todas las interfaces** (`0.0.0.0:4200`). Desde **otra PC en la misma red** abrí `http://<IP-de-esta-PC>:4200/` (ej. `http://192.168.0.15:4200/`). Si no carga, revisá el firewall de Windows y que ambas máquinas estén en la misma WiFi/LAN.

### Error 404 al abrir una ruta (ej. `/dashboard`) en otra máquina

- **Build estático** (`ng build`): un servidor que solo sirve archivos (Python `http.server`, carpeta compartida sin reglas) devuelve **404** en rutas que no son archivos reales. Hay que usar **fallback a `index.html`**:
  - **Vercel** (404 al recargar `/dashboard` o abrir un enlace directo):
    1. Si el repo en Vercel usa la **raíz del proyecto** (sin “Root Directory”), debe existir **`vercel.json` en la raíz del repo** (junto a `FRONTEND/`) con `build` → `FRONTEND` y `outputDirectory` → `FRONTEND/dist/ar-monitor`. Ese archivo ya está en el workspace.
    2. Si en Vercel → Project → Settings → **Root Directory** = `FRONTEND`, entonces se usa solo **`FRONTEND/vercel.json`** (sin el de la raíz).
    3. Tras un push, **Redeploy** en Vercel para que tome la config.
  - **IIS**: `public/web.config` en el `dist` (vía `angular.json` → carpeta `public/`).
  - **Netlify**: `public/_redirects`.
- **Solo en esta PC**: `http://localhost:4200/`.

## Code scaffolding

Run `ng generate component component-name` to generate a new component. You can also use `ng generate directive|pipe|service|class|guard|interface|enum|module`.

## Build

Run `ng build` to build the project. The build artifacts will be stored in the `dist/` directory.

## Running unit tests

Run `ng test` to execute the unit tests via [Karma](https://karma-runner.github.io).

## Running end-to-end tests

Run `ng e2e` to execute the end-to-end tests via a platform of your choice. To use this command, you need to first add a package that implements end-to-end testing capabilities.

## Further help

To get more help on the Angular CLI use `ng help` or go check out the [Angular CLI Overview and Command Reference](https://angular.io/cli) page.
