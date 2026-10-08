'use strict';
// Pruebas de extremo a extremo: levanta el servidor y simula jugadores reales por WebSocket.
const { spawn } = require('child_process');
const assert = require('assert');
const WebSocket = require('ws');

const PORT = 39000 + Math.floor(Math.random() * 500);
const URL = `ws://localhost:${PORT}/ws`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Client {
  constructor(name) {
    this.name = name;
    this.state = null;
    this.session = null;
    this.errors = [];
    this.history = [];
    this.waiters = [];
    this.auto = null;
    this.open();
  }
  open() {
    this.ws = new WebSocket(URL);
    this.ready = new Promise((r) => this.ws.on('open', r));
    this.ws.on('message', (d) => this.onMsg(JSON.parse(d.toString())));
  }
  onMsg(m) {
    if (m.type === 'joined') this.session = m;
    if (m.type === 'error') this.errors.push(m);
    if (m.type === 'state') {
      this.state = m;
      this.history.push(m);
      if (this.auto) this.auto(this, m);
    }
    this.waiters = this.waiters.filter((w) => {
      if (w.pred(m, this)) {
        w.resolve(m);
        return false;
      }
      return true;
    });
  }
  send(o) {
    this.ws.send(JSON.stringify(o));
  }
  wait(pred, ms = 10000) {
    return new Promise((resolve, reject) => {
      if (this.state && pred({ type: 'state', ...this.state }, this) && pred.checkCurrent !== false) {
        // el estado actual ya cumple
        if (this.state) return resolve(this.state);
      }
      const t = setTimeout(() => reject(new Error(`timeout esperando (${this.name})`)), ms);
      this.waiters.push({ pred, resolve: (m) => { clearTimeout(t); resolve(m); } });
    });
  }
  waitMsg(type, ms = 5000) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`timeout esperando ${type} (${this.name})`)), ms);
      this.waiters.push({ pred: (m) => m.type === type, resolve: (m) => { clearTimeout(t); resolve(m); } });
    });
  }
  close() {
    try { this.ws.close(); } catch {}
  }
}

async function makeRoom(n, tag) {
  const clients = [];
  const host = new Client(`${tag}0`);
  await host.ready;
  const joined = host.waitMsg('joined');
  host.send({ type: 'create', name: `${tag}0`, settings: { public: true } });
  const { code } = await joined;
  clients.push(host);
  for (let i = 1; i < n; i++) {
    const c = new Client(`${tag}${i}`);
    await c.ready;
    const j = c.waitMsg('joined');
    c.send({ type: 'join', name: `${tag}${i}`, code });
    await j;
    clients.push(c);
  }
  await sleep(100);
  return { clients, host, code };
}

async function startServer() {
  const child = spawn('node', ['server.js'], {
    cwd: __dirname,
    env: { ...process.env, PORT: String(PORT), RESULT_SECONDS: '1', CLUE_SECONDS: '20', VOTE_SECONDS: '20' },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('el servidor no arrancó')), 5000);
    child.stdout.on('data', (d) => {
      if (String(d).includes('escuchando')) {
        clearTimeout(t);
        resolve();
      }
    });
  });
  return child;
}

const winStates = (c) => c.history.filter((s) => s.phase === 'end').pop();

async function test16Players() {
  console.log('\n▶ Partida completa con 16 jugadores');
  const { clients, host, code } = await makeRoom(16, 'A');
  assert.strictEqual(host.state.players.length, 16, 'deben ser 16 jugadores');

  // el 17 debe ser rechazado
  const extra = new Client('extra');
  await extra.ready;
  extra.send({ type: 'join', name: 'extra', code });
  await sleep(300);
  assert(extra.errors.some((e) => e.code === 'ROOM_FULL'), 'el jugador 17 debe ser rechazado');
  console.log('  ✓ el jugador 17 es rechazado (ROOM_FULL)');
  extra.close();

  // sala pública visible
  const probe = new Client('probe');
  await probe.ready;
  probe.send({ type: 'list' });
  // (no está en la lista porque está llena; se verifica con otra sala más abajo)
  probe.close();

  // no puede empezar quien no es anfitrión
  clients[1].send({ type: 'start' });
  await sleep(200);
  assert(clients[1].errors.some((e) => e.code === 'FORBIDDEN'), 'solo el anfitrión empieza');
  console.log('  ✓ solo el anfitrión puede empezar');

  const roles = new Map();
  const leaks = [];
  let secretWord = null;

  for (const c of clients) {
    c.auto = (cl, s) => {
      const me = s.you;
      if (s.phase !== 'lobby' && s.phase !== 'end') roles.set(me.id, me.role);
      if (me.role === 'civil' && me.word) secretWord = me.word;
      if (me.role === 'impostor' && s.phase !== 'end' && secretWord && JSON.stringify(s).includes(secretWord)) leaks.push(cl.name);
      if (s.phase === 'clue' && s.turnId === me.id && me.alive) {
        cl.send({ type: 'clue', text: `pista${Math.floor(Math.random() * 1e4)}` });
      }
      if (s.phase === 'vote' && me.alive && !s.votedIds.includes(me.id)) {
        const others = s.players.filter((p) => p.alive && p.id !== me.id);
        const imps = others.filter((p) => roles.get(p.id) === 'impostor');
        const civs = others.filter((p) => roles.get(p.id) === 'civil');
        let pool = others;
        if (me.role === 'civil' && imps.length && Math.random() < 0.6) pool = imps;
        if (me.role === 'impostor' && civs.length) pool = civs;
        cl.send({ type: 'vote', target: pool[Math.floor(Math.random() * pool.length)].id });
      }
    };
  }

  host.send({ type: 'start' });
  await sleep(300);
  const first = host.state;
  assert(['clue', 'vote'].includes(first.phase), 'la partida debe empezar');
  const impCount = [...roles.values()].filter((r) => r === 'impostor').length;
  assert.strictEqual(impCount, 3, 'con 16 jugadores automático = 3 impostores');
  console.log('  ✓ empezó con 3 impostores');

  await host.wait((m) => m.type === 'state' && m.phase === 'end', 90000);
  await sleep(300);
  const end = winStates(host);
  assert(['civiles', 'impostores'].includes(end.end.winner));
  assert.strictEqual(end.end.word, secretWord, 'la palabra final debe coincidir');
  assert.deepStrictEqual(leaks, [], 'los impostores nunca deben recibir la palabra antes del final');
  const civWords = new Set();
  for (const c of clients) for (const s of c.history) if (s.you.role === 'civil' && s.you.word) civWords.add(s.you.word);
  assert.strictEqual(civWords.size, 1, 'todos los civiles ven la misma palabra');
  console.log(`  ✓ terminó: ganan ${end.end.winner} (${end.end.reason}), palabra "${end.end.word}"`);
  console.log('  ✓ la palabra nunca se filtró a los impostores');

  // volver a jugar
  host.send({ type: 'again' });
  await sleep(300);
  assert.strictEqual(host.state.phase, 'lobby');
  assert.strictEqual(host.state.players.length, 16);
  console.log('  ✓ "jugar otra vez" regresa al lobby con los 16');
  clients.forEach((c) => c.close());
}

async function testGuessAndRejoin() {
  console.log('\n▶ Adivinar palabra (acierto) y reconexión');
  const { clients, host } = await makeRoom(4, 'B');

  // reconexión en lobby
  const c2 = clients[2];
  const token = c2.session.token;
  const id = c2.session.id;
  const code = c2.session.code;
  c2.close();
  await sleep(200);
  const back = new Client('B2-back');
  await back.ready;
  const jp = back.waitMsg('joined');
  back.send({ type: 'rejoin', code, token });
  const joined = await jp;
  assert.strictEqual(joined.id, id, 'rejoin conserva el id');
  clients[2] = back;
  await sleep(150);
  console.log('  ✓ reconexión con token conserva al jugador');

  let word = null;
  let impostor = null;
  for (const c of clients) {
    c.auto = (cl, s) => {
      const me = s.you;
      if (me.role === 'civil' && me.word) word = me.word;
      if (me.role === 'impostor') impostor = cl;
      if (s.phase === 'clue' && s.turnId === me.id) {
        if (me.role === 'impostor' && word) cl.send({ type: 'guess', text: word.toUpperCase() });
        else if (me.role === 'civil') cl.send({ type: 'clue', text: 'algo' });
      }
    };
  }
  host.send({ type: 'start' });
  const end = await host.wait((m) => m.type === 'state' && m.phase === 'end', 20000);
  assert.strictEqual(end.end.winner, 'impostores');
  assert.strictEqual(end.end.reason, 'guess');
  console.log('  ✓ el impostor adivina (ignorando mayúsculas) y gana al instante');
  clients.forEach((c) => c.close());
}

async function testWrongGuessAndSecret() {
  console.log('\n▶ Adivinar mal y usar la palabra como pista');
  const { clients, host } = await makeRoom(3, 'C');
  let word = null;
  let secretRejected = false;
  for (const c of clients) {
    c.auto = (cl, s) => {
      const me = s.you;
      if (me.role === 'civil' && me.word) word = me.word;
      if (s.phase === 'clue' && s.turnId === me.id) {
        if (me.role === 'impostor') cl.send({ type: 'guess', text: 'xyzzy' });
        else if (!secretRejected) {
          secretRejected = true;
          cl.send({ type: 'clue', text: me.word }); // debe rechazarse
          setTimeout(() => cl.send({ type: 'clue', text: 'otra' }), 100);
        } else cl.send({ type: 'clue', text: 'otra' });
      }
    };
  }
  host.send({ type: 'start' });
  const end = await host.wait((m) => m.type === 'state' && m.phase === 'end', 20000);
  assert.strictEqual(end.end.winner, 'civiles');
  assert.strictEqual(end.end.reason, 'wrongguess');
  assert(clients.some((c) => c.errors.some((e) => e.code === 'SECRET')), 'usar la palabra como pista se rechaza');
  console.log('  ✓ un civil no puede usar la palabra secreta como pista');
  console.log('  ✓ el impostor que falla al adivinar queda eliminado y ganan los civiles');
  clients.forEach((c) => c.close());
}

async function testPublicList() {
  console.log('\n▶ Lista de salas públicas y expulsar');
  const { clients, host, code } = await makeRoom(3, 'D');
  const probe = new Client('probe2');
  await probe.ready;
  const r = probe.waitMsg('rooms');
  probe.send({ type: 'list' });
  const list = await r;
  assert(list.rooms.some((x) => x.code === code && x.count === 3), 'la sala pública aparece en la lista');
  console.log('  ✓ la sala pública aparece en la lista');
  const kicked = clients[2].waitMsg('kicked');
  host.send({ type: 'kick', id: clients[2].session.id });
  await kicked;
  await sleep(150);
  assert.strictEqual(host.state.players.length, 2);
  console.log('  ✓ el anfitrión puede expulsar jugadores');
  probe.close();
  clients.forEach((c) => c.close());
}

(async () => {
  const child = await startServer();
  let failed = false;
  try {
    await test16Players();
    await testGuessAndRejoin();
    await testWrongGuessAndSecret();
    await testPublicList();
    console.log('\n✅ Todas las pruebas pasaron');
  } catch (e) {
    failed = true;
    console.error('\n❌ Falló:', e.message);
    console.error(e.stack);
  } finally {
    child.kill();
    process.exit(failed ? 1 : 0);
  }
})();
