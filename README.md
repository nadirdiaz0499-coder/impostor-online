# 🎭 Impostor online

Juego de deducción social para **3 a 16 jugadores**, directo en el navegador. Sin base de datos, sin registro, sin frameworks: solo Node.js y la librería `ws`.

## Correr localmente

```bash
npm install
npm start          # http://localhost:3000
npm test           # pruebas de extremo a extremo (16 jugadores simulados)
```

Requiere Node 18 o superior. Para jugar con amigos en tu red local, abre `http://TU_IP_LOCAL:3000` desde sus celulares.

## Cómo se juega

1. Alguien crea una sala (privada con código de 6 dígitos, o pública) y comparte el enlace.
2. El anfitrión ajusta impostores, categoría y pista, y pulsa **Empezar** (mínimo 3 jugadores).
3. Todos reciben la **misma palabra secreta**, menos los impostores.
4. Por turnos, cada quien da una **pista de una sola palabra** (20 s). Los civiles no pueden usar la palabra secreta.
5. Después todos **votan** (30 s). Gana el más votado; si hay empate, nadie sale.
6. Se repite hasta que:
   - **Ganan los civiles**: eliminan a todos los impostores.
   - **Ganan los impostores**: igualan en número a los civiles, o **adivinan la palabra en su turno** (victoria instantánea).
   - Si un impostor intenta adivinar y falla, **queda eliminado**.

Impostores en modo automático: 1 (hasta 6 jugadores), 2 (7–11), 3 (12–16). Siempre hay más civiles que impostores.

## Configuración (variables de entorno)

| Variable | Default | Descripción |
|---|---|---|
| `PORT` | 3000 | Puerto HTTP/WebSocket |
| `CLUE_SECONDS` | 20 | Tiempo por pista |
| `VOTE_SECONDS` | 30 | Tiempo de votación |
| `RESULT_SECONDS` | 7 | Pausa entre rondas |
| `DISCONNECT_GRACE_MS` | 60000 | Tiempo para reconectarse antes de contar como salida |

Para cambiar el límite de jugadores edita `MAX_PLAYERS` en `server.js`. Las palabras están en `words.js`: agrega categorías o palabras libremente.

## Despliegue

El estado de las salas vive en memoria, así que corre **una sola instancia** y necesitas un host que soporte WebSockets (Render, Railway, Fly.io, un VPS, etc.).

Con Docker:

```bash
docker build -t impostor .
docker run -p 3000:3000 impostor
```

Detrás de nginx, asegura el *upgrade* de WebSocket:

```nginx
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
}
```

## Notas de diseño

- **La palabra secreta nunca sale del servidor** hacia los impostores: cada jugador recibe solo la vista que le corresponde.
- Reconexión automática: si se cae la conexión (o recargas la página) vuelves a tu lugar con un token guardado en la pestaña.
- Si el anfitrión se va, el rol pasa a otro jugador.
- Un jugador desconectado pierde turnos automáticamente y, tras 60 s, cuenta como eliminado.
- Chat integrado (bloqueado para jugadores vivos durante la fase de pistas, para evitar trampas).

## Estructura

```
server.js        servidor HTTP + WebSocket y lógica del juego
words.js         categorías y palabras
public/          frontend (index.html, style.css, app.js)
test.js          pruebas de extremo a extremo
```
