# Publicar el juego

El juego necesita un servidor Node.js **siempre encendido** (WebSockets + salas en memoria).
**No sirve Vercel/Netlify** (serverless). Sí sirven Render, Railway, Fly.io o cualquier VPS.

Variables de entorno: solo `PORT` (el host suele inyectarla). No hay secretos ni base de datos.

## Opción A: Render (gratis, la más sencilla)

1. Sube esta carpeta a un repositorio de GitHub.
2. En https://render.com → **New + → Blueprint** → elige el repo. Render lee `render.yaml`.
   (Alternativa manual: *New Web Service*, Build `npm ci --omit=dev`, Start `npm start`, Health check `/healthz`.)
3. Al terminar el despliegue te da una URL tipo `https://fantasmas-en-el-tejado.onrender.com`.
4. **Pásala a tus amigos.** Cada uno abre el enlace, escribe su nombre y entra con el código de sala o el enlace
   `https://TU-URL/sala/CÓDIGO` que genera el botón *Compartir enlace*.

Nota: el plan gratuito de Render se "duerme" tras ~15 min sin visitas y tarda ~30-60 s en despertar. Abre la web
unos minutos antes de jugar. Las salas se pierden si el servicio se reinicia.

## Opción B: Railway / Fly.io

- Railway: *New Project → Deploy from GitHub*, detecta Node y usa `npm start`.
- Fly.io: `fly launch` (usa el `Dockerfile` incluido); mantén **una sola instancia** (las salas viven en memoria).

## Opción C: tu propio ordenador (partida en casa)

```bash
npm install && npm start
```
Todos los móviles en la misma wifi abren `http://IP-DE-TU-PC:3000`. Para jugar fuera de casa, un túnel
(p. ej. `cloudflared tunnel --url http://localhost:3000`) da una URL pública https temporal.

## Comprobación tras publicar

1. Abre `https://TU-URL/healthz` → debe responder `ok`.
2. Crea una sala desde un móvil y únete desde otro con el enlace.

Importante: HTTPS es necesario para que el navegador permita *compartir* y mantener la pantalla encendida;
los hosts anteriores lo dan por defecto.
