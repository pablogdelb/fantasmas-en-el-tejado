# 👻 Fantasmas en el Tejado

Juego web multijugador para **6-8 personas** (mínimo 3), pensado para jugar presencialmente con el móvil.
En cada ronda uno (o dos, con 7-8 jugadores) es **el fantasma** y el resto son **cazadores**. Todos los roles
rotan, hay puntuación individual y ranking final.

## Cómo se juega

- **Cazadores** (🔦): ven el plano de la casa pero, por la niebla, solo ven lo que hay a **2 casillas**.
  El móvil **late y vibra más rápido cuanto más cerca está el fantasma** (hasta 7 casillas de camino). El fantasma
  deja huellas que se desvanecen. Se captura entrando en su casilla. Habilidad: **DESTELLO** (durante 2 s ves a
  4 casillas; te deja cegado 0,8 s; recarga 18 s).
- **Fantasma** (👻): ve toda la casa y las linternas de los cazadores, y es más rápido. Habilidades: **SUSTO**
  (congela 4 s a los cazadores a ≤2 casillas; recarga 14 s) y **TRAMPA** (invisible; paraliza 3 s a quien la pise;
  máx. 2).
- **Los roles no son secretos**: todos saben quién es el fantasma. Lo secreto es *dónde está*. Hablad, coordinaos,
  repartid zonas… y mentid.
- **Puntos**: fantasma = 1 por segundo sobrevivido + 40 si sobrevive + 5 por cazador asustado + 10 por trampa.
  Cazador que captura = 100 + segundos restantes; todos los cazadores +20 si cae el fantasma.
- **Partida**: cada jugador será fantasma al menos una vez (1 vuelta = ⌈jugadores / fantasmas⌉ rondas).
  Con 5 jugadores: 5 rondas con 1 fantasma y 4 cazadores en una casa algo más pequeña (10×10) para que
  esté equilibrado. Con 6: 6 rondas. Con 8: 4 rondas con 2 fantasmas.

Controles: botones ◀▲▼▶ (mantener pulsado para seguir andando) o flechas / WASD en ordenador.
Habilidades: botones a la derecha o `Espacio` / `E`.

## Ejecutar en local

```bash
npm install
npm start          # http://localhost:3000
npm test           # 22 pruebas automáticas
```

Para probarlo con varios móviles en la misma red wifi, abre `http://IP-DE-TU-PC:3000` en cada uno.
Las salas privadas se crean con **CREAR SALA** (código de 5 caracteres) y se comparte el código o el enlace
`/sala/CÓDIGO`. No hay registro ni cuentas.

## Arquitectura (y por qué)

- **Node.js + Socket.IO**, un único proceso que sirve la web (HTML/JS/CSS puros, sin build) y el tiempo real.
  Se eligió frente a Supabase/Vercel porque el juego es de movimiento en tiempo real con un bucle de servidor
  autoritativo; Vercel es *serverless* y no puede mantener conexiones WebSocket ni salas en memoria.
- **El servidor decide todo**: movimientos, cooldowns, capturas, trampas, temporizador y puntuación.
- **Información por jugador** (`server/game.js → viewFor`): un cazador *nunca* recibe la posición del fantasma salvo
  que esté en su radio de visión o dentro de su destello; las trampas solo las recibe su dueño. No se oculta nada con CSS.
- **Reconexión**: cada jugador recibe un token de sesión privado (guardado en `localStorage`). Recargar o perder la
  conexión devuelve al mismo asiento y rol. Una segunda pestaña con el mismo token sustituye a la primera.
  Un fantasma desconectado >20 s se da por abandonado; el anfitrión se transfiere si se va.
- **Reloj del servidor**: el cliente solo pinta; el tiempo restante se calcula con la hora del servidor.
- Estado en **memoria**: si el servidor se reinicia, las salas se pierden (por diseño; son partidas de una sesión).

```
server/  game.js (reglas) · map.js (generador) · rooms.js (salas) · app.js (HTTP + Socket.IO) · index.js
public/  index.html · style.css · app.js (UI) · render.js (canvas) · audio.js (sonidos sintetizados)
test/    game.test.js (motor) · server.test.js (8 clientes reales por socket)
```

## Ajustar el equilibrio

Todas las constantes están en `CFG` (`server/game.js`): velocidades, visión, enfriamientos, alcance del calor…

Ver `DEPLOY.md` para publicarlo.
