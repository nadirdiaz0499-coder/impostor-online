'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const CATEGORIES = require('./words');

// ---------------------------------------------------------------- config
const PORT = Number(process.env.PORT) || 3000;
const MAX_PLAYERS = 16;
const MIN_PLAYERS = 3;
const CLUE_SECONDS = Number(process.env.CLUE_SECONDS) || 20;
const VOTE_SECONDS = Number(process.env.VOTE_SECONDS) || 30;
const RESULT_SECONDS = Number(process.env.RESULT_SECONDS) || 7;
const DISCONNECT_GRACE_MS = Number(process.env.DISCONNECT_GRACE_MS) || 60000;
const EMPTY_ROOM_TTL_MS = 5 * 60 * 1000;
const MAX_ROOMS = 1000;

// ---------------------------------------------------------------- static
const PUBLIC_DIR = path.join(__dirname, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

const server = http.createServer((req, res) => {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    res.writeHead(400);
    return res.end();
  }
  if (pathname === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end('ok');
  }
  if (pathname === '/' || pathname.startsWith('/sala/')) pathname = '/index.html';
  const file = path.join(PUBLIC_DIR, path.normalize(pathname));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403);
    return res.end();
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('No encontrado');
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
});

// ---------------------------------------------------------------- helpers
const rooms = new Map();
const rand = (n) => crypto.randomInt(0, n);
const pick = (arr) => arr[rand(arr.length)];
const shuffle = (arr) => {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = rand(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};
// Normaliza para comparar palabras: sin acentos, minúsculas, solo letras/números.
const norm = (s) =>
  String(s)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
const cleanName = (s) =>
  String(s || '')
    .replace(/[\u0000-\u001f\u007f<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 16);

const categoryList = Object.entries(CATEGORIES).map(([id, c]) => ({ id, name: c.name, emoji: c.emoji }));

function send(ws, obj) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
}
function err(ws, code, message) {
  send(ws, { type: 'error', code, message });
}
function makeCode() {
  let c;
  do {
    c = String(rand(1000000)).padStart(6, '0');
  } while (rooms.has(c));
  return c;
}

// ---------------------------------------------------------------- rooms
function createRoom(settings) {
  const room = {
    code: makeCode(),
    players: new Map(),
    hostId: null,
    phase: 'lobby', // lobby | clue | vote | results | end
    round: 0,
    word: null,
    category: null,
    lastWord: null,
    order: [],
    turnIdx: -1,
    turnId: null,
    clues: [],
    votes: new Map(),
    lastResult: null,
    end: null,
    deadline: null,
    timer: null,
    cleanup: null,
    chat: [],
    settings: { public: false, impostors: 'auto', hint: true, category: 'all' },
  };
  applySettings(room, settings || {});
  rooms.set(room.code, room);
  return room;
}

function applySettings(room, s) {
  if (s.public !== undefined) room.settings.public = !!s.public;
  if (s.hint !== undefined) room.settings.hint = !!s.hint;
  if (s.impostors !== undefined) {
    if (s.impostors === 'auto') room.settings.impostors = 'auto';
    else {
      const n = Number(s.impostors);
      if (Number.isInteger(n) && n >= 1 && n <= 5) room.settings.impostors = n;
    }
  }
  if (s.category !== undefined) {
    if (s.category === 'all' || CATEGORIES[s.category]) room.settings.category = s.category;
  }
}

function deleteRoom(room) {
  clearTimeout(room.timer);
  clearTimeout(room.cleanup);
  for (const p of room.players.values()) clearTimeout(p.grace);
  rooms.delete(room.code);
}

function scheduleCleanup(room) {
  clearTimeout(room.cleanup);
  room.cleanup = setTimeout(() => deleteRoom(room), EMPTY_ROOM_TTL_MS);
}

function addPlayer(room, rawName, ws) {
  let name = cleanName(rawName);
  const taken = new Set([...room.players.values()].map((p) => p.name.toLowerCase()));
  if (taken.has(name.toLowerCase())) {
    for (let i = 2; i < 30; i++) {
      const candidate = `${name.slice(0, 13)} ${i}`;
      if (!taken.has(candidate.toLowerCase())) {
        name = candidate;
        break;
      }
    }
  }
  const p = {
    id: crypto.randomBytes(6).toString('hex'),
    token: crypto.randomBytes(16).toString('hex'),
    name,
    ws: null,
    connected: false,
    alive: true,
    role: null,
    revealed: false,
    left: false,
    grace: null,
    lastChat: 0,
  };
  room.players.set(p.id, p);
  if (!room.hostId) room.hostId = p.id;
  attach(ws, room, p);
  return p;
}

function attach(ws, room, p) {
  if (p.ws && p.ws !== ws) {
    p.ws.room = null;
    p.ws.player = null;
    try { p.ws.close(); } catch {}
  }
  clearTimeout(p.grace);
  clearTimeout(room.cleanup);
  ws.room = room;
  ws.player = p;
  p.ws = ws;
  p.connected = true;
  send(ws, { type: 'joined', id: p.id, token: p.token, code: room.code });
  send(ws, { type: 'chat_history', items: room.chat });
  broadcast(room);
}

function reassignHost(room) {
  const list = [...room.players.values()];
  const next = list.find((p) => p.connected && !p.left) || list.find((p) => !p.left);
  if (next) room.hostId = next.id;
}

function dropPlayer(room, p) {
  clearTimeout(p.grace);
  const wasHost = room.hostId === p.id;
  if (p.ws) {
    p.ws.room = null;
    p.ws.player = null;
    p.ws = null;
  }
  p.connected = false;
  sysChat(room, `${p.name} salió de la partida`);
  if (room.phase === 'lobby' || room.phase === 'end') {
    room.players.delete(p.id);
  } else {
    p.alive = false;
    p.revealed = true;
    p.left = true;
  }
  if (room.players.size === 0) return deleteRoom(room);
  if (wasHost) reassignHost(room);
  if (['clue', 'vote', 'results'].includes(room.phase)) {
    const w = winner(room);
    if (w) return endGame(room, w, 'abandon');
    if (room.phase === 'clue' && room.turnId === p.id) return advanceTurn(room);
    if (room.phase === 'vote') {
      maybeFinishVote(room);
      if (room.phase === 'vote') broadcast(room);
      return;
    }
  }
  broadcast(room);
}

function onClose(ws) {
  const room = ws.room;
  const p = ws.player;
  if (!room || !p || p.ws !== ws) return;
  p.ws = null;
  p.connected = false;
  if (room.hostId === p.id) reassignHost(room);
  p.grace = setTimeout(() => {
    if (!p.connected && rooms.get(room.code) === room && room.players.get(p.id) === p) dropPlayer(room, p);
  }, DISCONNECT_GRACE_MS);
  if (![...room.players.values()].some((x) => x.connected)) scheduleCleanup(room);
  if (room.phase === 'vote') maybeFinishVote(room);
  broadcast(room);
}

// ---------------------------------------------------------------- views
function viewFor(room, p) {
  const inGame = room.phase !== 'lobby';
  const ended = room.phase === 'end';
  const amImpostor = p.role === 'impostor';
  const players = [...room.players.values()].map((o) => ({
    id: o.id,
    name: o.name,
    alive: o.alive,
    connected: o.connected,
    left: o.left,
    host: o.id === room.hostId,
    role: ended || o.revealed || (amImpostor && o.role === 'impostor') ? o.role : null,
  }));
  const view = {
    type: 'state',
    code: room.code,
    phase: room.phase,
    round: room.round,
    serverNow: Date.now(),
    deadline: room.deadline,
    hostId: room.hostId,
    settings: room.settings,
    limits: { min: MIN_PLAYERS, max: MAX_PLAYERS },
    categories: categoryList,
    you: {
      id: p.id,
      alive: p.alive,
      role: inGame ? p.role : null,
      word: inGame && p.role === 'civil' ? room.word : null,
      category: inGame && (p.role === 'civil' || room.settings.hint) ? room.category : null,
    },
    players,
    turnId: room.phase === 'clue' ? room.turnId : null,
    clues: room.clues,
    votedIds: room.phase === 'vote' ? [...room.votes.keys()] : [],
    yourVote: room.phase === 'vote' && room.votes.has(p.id) ? room.votes.get(p.id) || 'skip' : null,
    lastResult: room.phase === 'results' || ended ? room.lastResult : null,
    end: ended ? room.end : null,
  };
  return view;
}

function broadcast(room) {
  for (const p of room.players.values()) {
    if (p.ws) send(p.ws, viewFor(room, p));
  }
}

function sysChat(room, text) {
  pushChat(room, { system: true, text, ts: Date.now() });
}
function pushChat(room, item) {
  room.chat.push(item);
  if (room.chat.length > 60) room.chat.shift();
  for (const p of room.players.values()) if (p.ws) send(p.ws, { type: 'chat', item });
}

function publicRooms() {
  const out = [];
  for (const r of rooms.values()) {
    if (r.phase !== 'lobby' || !r.settings.public || r.players.size >= MAX_PLAYERS) continue;
    const host = r.players.get(r.hostId);
    out.push({
      code: r.code,
      count: r.players.size,
      max: MAX_PLAYERS,
      host: host ? host.name : '',
      category: r.settings.category === 'all' ? 'Todas' : CATEGORIES[r.settings.category].name,
    });
  }
  return out.sort((a, b) => b.count - a.count).slice(0, 30);
}

// ---------------------------------------------------------------- game flow
function setTimer(room, seconds, fn) {
  clearTimeout(room.timer);
  room.deadline = Date.now() + seconds * 1000;
  room.timer = setTimeout(fn, seconds * 1000);
}

function winner(room) {
  const alive = [...room.players.values()].filter((p) => p.alive);
  const imp = alive.filter((p) => p.role === 'impostor').length;
  const civ = alive.length - imp;
  if (imp === 0) return 'civiles';
  if (imp >= civ) return 'impostores';
  return null;
}

function startGame(room) {
  for (const p of [...room.players.values()]) if (!p.connected) dropPlayer(room, p);
  const ids = [...room.players.keys()];
  const n = ids.length;

  const catId = pick(room.settings.category === 'all' ? Object.keys(CATEGORIES) : [room.settings.category]);
  const cat = CATEGORIES[catId];
  let word;
  do {
    word = pick(cat.words);
  } while (word === room.lastWord && cat.words.length > 1);
  room.category = cat.name;
  room.word = word;
  room.lastWord = word;

  const maxImp = Math.max(1, Math.floor((n - 1) / 2));
  let k = room.settings.impostors === 'auto' ? (n <= 6 ? 1 : n <= 11 ? 2 : 3) : room.settings.impostors;
  k = Math.max(1, Math.min(k, maxImp));
  const imps = new Set(shuffle(ids).slice(0, k));
  for (const p of room.players.values()) {
    p.role = imps.has(p.id) ? 'impostor' : 'civil';
    p.alive = true;
    p.revealed = false;
    p.left = false;
  }

  room.round = 1;
  room.clues = [];
  room.lastResult = null;
  room.end = null;
  room.votes = new Map();
  room.phase = 'clue';
  room.order = shuffle(ids);
  room.turnIdx = -1;
  sysChat(room, `¡Empieza la partida! ${n} jugadores, ${k} impostor${k > 1 ? 'es' : ''}.`);
  advanceTurn(room);
}

function advanceTurn(room) {
  room.turnIdx++;
  while (room.turnIdx < room.order.length) {
    const cand = room.players.get(room.order[room.turnIdx]);
    if (cand && cand.alive) break;
    room.turnIdx++;
  }
  if (room.turnIdx >= room.order.length) return startVote(room);
  const p = room.players.get(room.order[room.turnIdx]);
  room.turnId = p.id;
  setTimer(room, p.connected ? CLUE_SECONDS : 3, () => onTurnTimeout(room, p.id));
  broadcast(room);
}

function onTurnTimeout(room, id) {
  if (room.phase !== 'clue' || room.turnId !== id) return;
  const p = room.players.get(id);
  room.clues.push({ round: room.round, id, name: p ? p.name : '?', text: null });
  advanceTurn(room);
}

function startVote(room) {
  room.phase = 'vote';
  room.turnId = null;
  room.votes = new Map();
  setTimer(room, VOTE_SECONDS, () => finishVote(room));
  broadcast(room);
}

function maybeFinishVote(room) {
  if (room.phase !== 'vote') return;
  const voters = [...room.players.values()].filter((p) => p.alive && p.connected);
  if (voters.length && voters.every((p) => room.votes.has(p.id))) finishVote(room);
}

function finishVote(room) {
  if (room.phase !== 'vote') return;
  clearTimeout(room.timer);
  const counts = new Map();
  const ballots = [];
  for (const [voter, target] of room.votes) {
    ballots.push({ voter, target });
    if (target) counts.set(target, (counts.get(target) || 0) + 1);
  }
  let max = 0;
  let top = [];
  for (const [id, c] of counts) {
    if (c > max) {
      max = c;
      top = [id];
    } else if (c === max) top.push(id);
  }
  const result = {
    round: room.round,
    eliminatedId: null,
    wasImpostor: null,
    tally: [...counts].map(([id, count]) => ({ id, count })).sort((a, b) => b.count - a.count),
    ballots,
  };
  if (top.length === 1) {
    const p = room.players.get(top[0]);
    if (p) {
      p.alive = false;
      p.revealed = true;
      result.eliminatedId = p.id;
      result.wasImpostor = p.role === 'impostor';
      sysChat(room, `${p.name} fue eliminado${p.role === 'impostor' ? ' y era IMPOSTOR 🎭' : ' pero era inocente 😬'}`);
    }
  } else {
    sysChat(room, 'Empate o sin votos: nadie fue eliminado.');
  }
  room.lastResult = result;
  const w = winner(room);
  if (w) return endGame(room, w, 'vote');
  room.phase = 'results';
  setTimer(room, RESULT_SECONDS, () => nextRound(room));
  broadcast(room);
}

function nextRound(room) {
  if (room.phase !== 'results') return;
  room.round++;
  room.phase = 'clue';
  room.order = shuffle([...room.players.values()].filter((p) => p.alive).map((p) => p.id));
  room.turnIdx = -1;
  advanceTurn(room);
}

function endGame(room, who, reason, byId) {
  clearTimeout(room.timer);
  room.phase = 'end';
  room.turnId = null;
  room.deadline = null;
  room.end = {
    winner: who,
    reason,
    byId: byId || null,
    word: room.word,
    category: room.category,
    impostorIds: [...room.players.values()].filter((p) => p.role === 'impostor').map((p) => p.id),
  };
  sysChat(room, who === 'civiles' ? '🎉 ¡Ganaron los civiles!' : '🎭 ¡Ganaron los impostores!');
  broadcast(room);
}

function resetToLobby(room) {
  clearTimeout(room.timer);
  for (const p of [...room.players.values()]) {
    if (p.left || !p.connected) {
      clearTimeout(p.grace);
      room.players.delete(p.id);
      continue;
    }
    p.role = null;
    p.alive = true;
    p.revealed = false;
  }
  if (room.players.size === 0) return deleteRoom(room);
  if (!room.players.has(room.hostId)) reassignHost(room);
  room.phase = 'lobby';
  room.round = 0;
  room.word = null;
  room.category = null;
  room.clues = [];
  room.votes = new Map();
  room.lastResult = null;
  room.end = null;
  room.deadline = null;
  room.turnId = null;
  broadcast(room);
}

// ---------------------------------------------------------------- messages
function handle(ws, msg) {
  switch (msg.type) {
    case 'list':
      return send(ws, { type: 'rooms', rooms: publicRooms() });

    case 'create': {
      if (ws.room) return err(ws, 'ALREADY', 'Ya estás en una sala');
      if (rooms.size >= MAX_ROOMS) return err(ws, 'SERVER_FULL', 'El servidor está lleno, intenta más tarde');
      if (!cleanName(msg.name)) return err(ws, 'NAME', 'Escribe tu nombre');
      const room = createRoom(msg.settings || { public: !!msg.public });
      sysChat(room, 'Sala creada. ¡Comparte el código!');
      addPlayer(room, msg.name, ws);
      return;
    }

    case 'join': {
      if (ws.room) return err(ws, 'ALREADY', 'Ya estás en una sala');
      if (!cleanName(msg.name)) return err(ws, 'NAME', 'Escribe tu nombre');
      const room = rooms.get(String(msg.code || ''));
      if (!room) return err(ws, 'NO_ROOM', 'No existe una sala con ese código');
      if (room.phase !== 'lobby') return err(ws, 'STARTED', 'La partida ya empezó');
      if (room.players.size >= MAX_PLAYERS) return err(ws, 'ROOM_FULL', `La sala está llena (máximo ${MAX_PLAYERS})`);
      const p = addPlayer(room, msg.name, ws);
      sysChat(room, `${p.name} se unió`);
      return;
    }

    case 'rejoin': {
      const room = rooms.get(String(msg.code || ''));
      const p = room && [...room.players.values()].find((x) => x.token === msg.token && !x.left);
      if (!room || !p) return err(ws, 'REJOIN_FAILED', 'La sala ya no existe');
      attach(ws, room, p);
      return;
    }
  }

  const room = ws.room;
  const p = ws.player;
  if (!room || !p) return err(ws, 'NO_ROOM', 'No estás en una sala');
  const isHost = room.hostId === p.id;

  switch (msg.type) {
    case 'settings':
      if (!isHost || room.phase !== 'lobby') return err(ws, 'FORBIDDEN', 'Solo el anfitrión puede cambiar esto en el lobby');
      applySettings(room, msg.settings || {});
      return broadcast(room);

    case 'kick': {
      if (!isHost || room.phase !== 'lobby') return err(ws, 'FORBIDDEN', 'No permitido');
      const target = room.players.get(String(msg.id));
      if (!target || target.id === p.id) return;
      const tws = target.ws;
      dropPlayer(room, target);
      send(tws, { type: 'kicked' });
      return;
    }

    case 'start': {
      if (!isHost || room.phase !== 'lobby') return err(ws, 'FORBIDDEN', 'Solo el anfitrión puede empezar');
      const connected = [...room.players.values()].filter((x) => x.connected).length;
      if (connected < MIN_PLAYERS) return err(ws, 'TOO_FEW', `Se necesitan al menos ${MIN_PLAYERS} jugadores conectados`);
      return startGame(room);
    }

    case 'again':
      if (!isHost || room.phase !== 'end') return err(ws, 'FORBIDDEN', 'No permitido');
      return resetToLobby(room);

    case 'clue': {
      if (room.phase !== 'clue' || room.turnId !== p.id || !p.alive) return err(ws, 'NOT_YOUR_TURN', 'No es tu turno');
      const text = String(msg.text || '').trim().split(/\s+/)[0].replace(/[<>]/g, '').slice(0, 24);
      if (!text) return err(ws, 'EMPTY', 'Escribe una pista');
      if (p.role === 'civil' && norm(text) === norm(room.word)) {
        return err(ws, 'SECRET', 'No puedes usar la palabra secreta como pista');
      }
      room.clues.push({ round: room.round, id: p.id, name: p.name, text });
      return advanceTurn(room);
    }

    case 'guess': {
      if (room.phase !== 'clue' || room.turnId !== p.id || p.role !== 'impostor' || !p.alive) {
        return err(ws, 'BAD_ACTION', 'No puedes adivinar ahora');
      }
      const g = norm(String(msg.text || ''));
      if (!g) return err(ws, 'EMPTY', 'Escribe una palabra');
      if (g === norm(room.word)) {
        sysChat(room, `${p.name} adivinó la palabra secreta`);
        return endGame(room, 'impostores', 'guess', p.id);
      }
      p.alive = false;
      p.revealed = true;
      room.clues.push({ round: room.round, id: p.id, name: p.name, text: null, failedGuess: true });
      sysChat(room, `${p.name} falló al adivinar la palabra y queda eliminado 🎭`);
      const w = winner(room);
      if (w) return endGame(room, w, 'wrongguess');
      return advanceTurn(room);
    }

    case 'vote': {
      if (room.phase !== 'vote' || !p.alive) return err(ws, 'BAD_ACTION', 'No puedes votar ahora');
      let target = null;
      if (msg.target) {
        const t = room.players.get(String(msg.target));
        if (!t || !t.alive || t.id === p.id) return err(ws, 'BAD_TARGET', 'Voto inválido');
        target = t.id;
      }
      room.votes.set(p.id, target);
      maybeFinishVote(room);
      if (room.phase === 'vote') broadcast(room);
      return;
    }

    case 'chat': {
      const text = String(msg.text || '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 200);
      if (!text) return;
      if (room.phase === 'clue' && p.alive) return err(ws, 'CHAT_LOCKED', 'El chat está bloqueado durante las pistas');
      const now = Date.now();
      if (now - p.lastChat < 400) return;
      p.lastChat = now;
      return pushChat(room, { id: p.id, name: p.name, text, ts: now });
    }

    case 'leave':
      dropPlayer(room, p);
      return send(ws, { type: 'left' });
  }
}

// ---------------------------------------------------------------- websocket
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 4096 });

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.msgCount = 0;
  ws.room = null;
  ws.player = null;
  ws.on('pong', () => {
    ws.isAlive = true;
  });
  ws.on('message', (data, isBinary) => {
    if (isBinary) return;
    if (++ws.msgCount > 40) return;
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (!msg || typeof msg.type !== 'string') return;
    try {
      handle(ws, msg);
    } catch (e) {
      console.error(e);
      err(ws, 'INTERNAL', 'Error del servidor');
    }
  });
  ws.on('close', () => onClose(ws));
  ws.on('error', () => {});
});

setInterval(() => {
  for (const ws of wss.clients) {
    ws.msgCount = 0;
    if (!ws.isAlive) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    try { ws.ping(); } catch {}
  }
}, 30000).unref();

server.listen(PORT, () => {
  console.log(`Impostor online escuchando en http://localhost:${PORT}`);
});
