(() => {
  'use strict';

  const root = document.getElementById('app');
  const toastEl = document.getElementById('toast');
  const connEl = document.getElementById('conn');
  const chatBtn = document.getElementById('chat-btn');
  const chatPanel = document.getElementById('chat-panel');
  const chatLog = document.getElementById('chat-log');
  const chatForm = document.getElementById('chat-form');
  const chatInput = document.getElementById('chat-input');
  const chatBadge = document.getElementById('chat-badge');

  // ------------------------------------------------------------ utils
  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    if (props) {
      for (const [k, v] of Object.entries(props)) {
        if (v === false || v == null) continue;
        if (k === 'class') el.className = v;
        else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
        else if (k === 'value' || k === 'disabled' || k === 'checked' || k === 'selected') el[k] = v;
        else el.setAttribute(k, v === true ? '' : v);
      }
    }
    for (const kid of kids.flat(Infinity)) {
      if (kid == null || kid === false) continue;
      el.append(kid);
    }
    return el;
  }
  const readJSON = (store, key) => {
    try { return JSON.parse(store.getItem(key)); } catch { return null; }
  };

  let toastTimer = null;
  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2800);
  }

  // ------------------------------------------------------------ state
  let ws = null;
  let wsReady = false;
  let backoff = 500;
  const queue = [];
  let state = null;
  let offset = 0;
  let rooms = [];
  let session = readJSON(sessionStorage, 'impostor.session');
  let myName = localStorage.getItem('impostor.name') || '';
  let codeDraft = (location.pathname.match(/^\/sala\/(\d{6})/) || [])[1] || '';
  let guessMode = false;
  let chatMsgs = [];
  let unread = 0;
  let chatOpen = false;
  let lastTurnForMe = false;

  // ------------------------------------------------------------ network
  function rawSend(msg) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
  }
  function send(msg) {
    if (wsReady) rawSend(msg);
    else if (queue.length < 10) queue.push(msg);
  }

  function connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/ws`);
    ws.onopen = () => {
      wsReady = true;
      backoff = 500;
      connEl.hidden = true;
      if (session) rawSend({ type: 'rejoin', code: session.code, token: session.token });
      else rawSend({ type: 'list' });
      queue.splice(0).forEach(rawSend);
    };
    ws.onclose = () => {
      wsReady = false;
      connEl.hidden = false;
      setTimeout(connect, backoff);
      backoff = Math.min(backoff * 2, 8000);
    };
    ws.onmessage = (e) => {
      let m;
      try { m = JSON.parse(e.data); } catch { return; }
      onMessage(m);
    };
  }

  function leaveLocal(message) {
    session = null;
    sessionStorage.removeItem('impostor.session');
    state = null;
    chatMsgs = [];
    unread = 0;
    chatOpen = false;
    guessMode = false;
    history.replaceState(null, '', '/');
    render();
    renderChat();
    send({ type: 'list' });
    if (message) toast(message);
  }

  function onMessage(m) {
    switch (m.type) {
      case 'joined':
        session = { code: m.code, token: m.token, id: m.id };
        sessionStorage.setItem('impostor.session', JSON.stringify(session));
        history.replaceState(null, '', '/sala/' + m.code);
        return;
      case 'state': {
        const wasMine = lastTurnForMe;
        state = m;
        offset = m.serverNow - Date.now();
        lastTurnForMe = m.phase === 'clue' && m.turnId === m.you.id;
        if (!lastTurnForMe) guessMode = false;
        if (lastTurnForMe && !wasMine && navigator.vibrate) navigator.vibrate(200);
        render();
        return;
      }
      case 'rooms':
        rooms = m.rooms;
        if (!state) render();
        return;
      case 'chat_history':
        chatMsgs = m.items;
        renderChat();
        return;
      case 'chat':
        chatMsgs.push(m.item);
        if (chatMsgs.length > 100) chatMsgs.shift();
        if (!chatOpen && !m.item.system) unread++;
        renderChat();
        return;
      case 'left':
        return leaveLocal();
      case 'kicked':
        return leaveLocal('El anfitrión te sacó de la sala');
      case 'error':
        if (m.code === 'REJOIN_FAILED') return leaveLocal('Tu sala ya no existe');
        toast(m.message || 'Error');
        return;
    }
  }

  // ------------------------------------------------------------ helpers
  const P = (id) => state.players.find((p) => p.id === id);
  const nameOf = (id) => (P(id) ? P(id).name : '?');
  const isHost = () => state && state.hostId === state.you.id;

  function copyLink() {
    const url = `${location.origin}/sala/${state.code}`;
    if (navigator.share) {
      navigator.share({ title: 'Impostor online', text: `Únete a mi partida de Impostor (sala ${state.code})`, url }).catch(() => {});
      return;
    }
    const done = () => toast('Enlace copiado');
    if (navigator.clipboard) navigator.clipboard.writeText(url).then(done, () => toast(url));
    else toast(url);
  }

  function setSettings(patch) {
    send({ type: 'settings', settings: patch });
  }

  // ------------------------------------------------------------ views
  function viewHome() {
    const nameIn = h('input', {
      id: 'name-input', class: 'inp', maxlength: '16', placeholder: 'Tu nombre', value: myName, autocomplete: 'off',
      oninput: () => { myName = nameIn.value; localStorage.setItem('impostor.name', myName); },
    });
    const codeIn = h('input', {
      id: 'code-input', class: 'inp code', inputmode: 'numeric', maxlength: '6', placeholder: '000000', value: codeDraft, autocomplete: 'off',
      oninput: () => { codeIn.value = codeIn.value.replace(/\D/g, ''); codeDraft = codeIn.value; },
    });
    const need = () => {
      const n = myName.trim();
      if (!n) { toast('Escribe tu nombre primero'); nameIn.focus(); return null; }
      return n;
    };
    const join = (code) => {
      const n = need();
      if (!n) return;
      if (!/^\d{6}$/.test(code)) return toast('El código tiene 6 dígitos');
      send({ type: 'join', name: n, code });
    };

    return h('div', { class: 'stack' },
      h('div', { class: 'hero' },
        h('div', { class: 'logo' }, '🎭'),
        h('h1', null, 'Impostor'),
        h('p', null, 'De 3 a 16 jugadores · Sin descargas ni registro'),
      ),
      h('div', { class: 'card stack' },
        h('div', { class: 'field' }, h('label', null, 'Tu nombre'), nameIn),
        h('div', { class: 'row' },
          h('button', { class: 'btn primary grow', onclick: () => { const n = need(); if (n) send({ type: 'create', name: n, settings: { public: false } }); } }, '🔒 Sala privada'),
          h('button', { class: 'btn grow', onclick: () => { const n = need(); if (n) send({ type: 'create', name: n, settings: { public: true } }); } }, '🌍 Sala pública'),
        ),
      ),
      h('div', { class: 'card stack' },
        h('h2', null, 'Unirse con código'),
        h('div', { class: 'row' }, h('div', { class: 'grow' }, codeIn), h('button', { class: 'btn primary', onclick: () => join(codeDraft) }, 'Unirse')),
      ),
      h('div', { class: 'card stack' },
        h('div', { class: 'row between' },
          h('h2', null, 'Salas públicas'),
          h('button', { class: 'btn small ghost', onclick: () => send({ type: 'list' }) }, '↻'),
        ),
        rooms.length
          ? h('div', { class: 'room-list' }, rooms.map((r) =>
              h('div', { class: 'room-item' },
                h('div', null, h('strong', null, `Sala de ${r.host}`), h('div', { class: 'muted' }, `${r.count}/${r.max} · ${r.category}`)),
                h('button', { class: 'btn small primary', onclick: () => join(r.code) }, 'Entrar'),
              )))
          : h('p', { class: 'muted' }, 'No hay salas públicas ahora. ¡Crea la tuya!'),
      ),
    );
  }

  function playerChip(p, extra) {
    const s = state;
    return h('div', {
      class: ['player', p.id === s.you.id && 'me', !p.alive && 'dead', !p.connected && !p.left && 'offline', s.turnId === p.id && 'turn'].filter(Boolean).join(' '),
    },
      h('span', { class: 'name' }, p.name),
      p.host && h('span', { title: 'Anfitrión' }, '👑'),
      p.role === 'impostor' && h('span', { title: 'Impostor' }, '🎭'),
      extra,
    );
  }

  function viewLobby() {
    const s = state;
    const host = isHost();
    const connected = s.players.filter((p) => p.connected).length;
    const st = s.settings;
    const maxImp = Math.max(1, Math.floor((s.players.length - 1) / 2));

    const settingsCard = host
      ? h('div', { class: 'card stack' },
          h('h2', null, 'Ajustes'),
          h('div', { class: 'field' }, h('label', null, 'Impostores'),
            h('select', { class: 'inp', onchange: (e) => setSettings({ impostors: e.target.value === 'auto' ? 'auto' : Number(e.target.value) }) },
              h('option', { value: 'auto', selected: st.impostors === 'auto' }, 'Automático'),
              [1, 2, 3, 4, 5].map((n) => h('option', { value: String(n), selected: st.impostors === n }, String(n))),
            )),
          h('div', { class: 'field' }, h('label', null, 'Categoría'),
            h('select', { class: 'inp', onchange: (e) => setSettings({ category: e.target.value }) },
              h('option', { value: 'all', selected: st.category === 'all' }, '🎲 Todas'),
              s.categories.map((c) => h('option', { value: c.id, selected: st.category === c.id }, `${c.emoji} ${c.name}`)),
            )),
          h('label', { class: 'switch' }, h('span', null, 'Pista de categoría para el impostor'),
            h('input', { type: 'checkbox', checked: st.hint, onchange: (e) => setSettings({ hint: e.target.checked }) })),
          h('label', { class: 'switch' }, h('span', null, 'Sala pública'),
            h('input', { type: 'checkbox', checked: st.public, onchange: (e) => setSettings({ public: e.target.checked }) })),
          st.impostors !== 'auto' && st.impostors > maxImp && h('p', { class: 'muted' }, `Con ${s.players.length} jugadores habrá máximo ${maxImp} impostor(es).`),
        )
      : h('div', { class: 'card stack' },
          h('h2', null, 'Ajustes'),
          h('p', { class: 'muted' }, `Impostores: ${st.impostors === 'auto' ? 'automático' : st.impostors} · Categoría: ${st.category === 'all' ? 'todas' : (s.categories.find((c) => c.id === st.category) || {}).name} · Pista: ${st.hint ? 'sí' : 'no'}`),
        );

    return h('div', { class: 'stack' },
      h('div', { class: 'card stack' },
        h('p', { class: 'muted center' }, 'Código de la sala'),
        h('div', { class: 'code-big' }, s.code),
        h('button', { class: 'btn block', onclick: copyLink }, '🔗 Compartir enlace'),
      ),
      h('div', { class: 'card stack' },
        h('div', { class: 'row between' }, h('h2', null, 'Jugadores'), h('span', { class: 'chip' }, `${s.players.length}/${s.limits.max}`)),
        h('div', { class: 'players' }, s.players.map((p) =>
          playerChip(p, host && p.id !== s.you.id && h('button', { class: 'x', title: 'Expulsar', onclick: () => send({ type: 'kick', id: p.id }) }, '✕')))),
      ),
      settingsCard,
      host
        ? h('button', { class: 'btn primary block', disabled: connected < s.limits.min, onclick: () => send({ type: 'start' }) },
            connected < s.limits.min ? `Faltan ${s.limits.min - connected} jugador(es)` : '▶ Empezar partida')
        : h('p', { class: 'muted center' }, 'Esperando a que el anfitrión empiece…'),
      h('button', { class: 'btn ghost block', onclick: () => send({ type: 'leave' }) }, 'Salir de la sala'),
    );
  }

  function roleCard() {
    const you = state.you;
    if (!you.alive) {
      return h('div', { class: 'card role' },
        h('div', { class: 'small' }, 'Estás eliminado'),
        h('div', { class: 'word' }, you.role === 'impostor' ? '🎭 Eras impostor' : '😵 Eras civil'),
        h('p', { class: 'muted' }, 'Puedes seguir viendo la partida y usar el chat.'),
      );
    }
    if (you.role === 'impostor') {
      const mates = state.players.filter((p) => p.role === 'impostor' && p.id !== you.id && p.alive).map((p) => p.name);
      return h('div', { class: 'card role impostor' },
        h('div', { class: 'small' }, 'Tu rol'),
        h('div', { class: 'word' }, '🎭 Eres el IMPOSTOR'),
        you.category && h('p', null, `Pista: la categoría es ${you.category}`),
        mates.length > 0 && h('p', { class: 'muted' }, `Compañeros: ${mates.join(', ')}`),
        h('p', { class: 'muted' }, 'Disimula y descubre la palabra.'),
      );
    }
    return h('div', { class: 'card role' },
      h('div', { class: 'small' }, `Tu palabra secreta${you.category ? ' · ' + you.category : ''}`),
      h('div', { class: 'word' }, you.word),
      h('p', { class: 'muted' }, 'Da pistas sin que el impostor la descubra.'),
    );
  }

  function cluesCard() {
    const byRound = new Map();
    for (const c of state.clues) {
      if (!byRound.has(c.round)) byRound.set(c.round, []);
      byRound.get(c.round).push(c);
    }
    if (!byRound.size) return null;
    return h('div', { class: 'card' },
      h('h2', null, 'Pistas'),
      [...byRound].map(([round, list]) => h('div', null,
        h('h4', null, `Ronda ${round}`),
        list.map((c) => h('div', { class: 'clue' },
          h('span', { class: 'who' }, c.name),
          h('span', { class: 'txt' }, c.failedGuess ? '🎯 falló al adivinar' : c.text || '— (sin pista)'),
        )),
      )),
    );
  }

  function viewGame() {
    const s = state;
    const you = s.you;
    const parts = [];

    parts.push(h('div', { class: 'topbar' },
      h('div', null, h('strong', null, s.phase === 'end' ? 'Fin de la partida' : `Ronda ${s.round}`), h('div', { class: 'muted' }, phaseLabel())),
      s.deadline && h('span', { class: 'timer', id: 'timer' }, '…'),
    ));

    if (s.phase !== 'end') parts.push(roleCard());

    if (s.phase === 'clue') {
      const mine = s.turnId === you.id;
      parts.push(h('div', { class: ['turn-banner', mine && 'mine'].filter(Boolean).join(' ') },
        mine ? '👉 ¡Es tu turno!' : `Turno de ${nameOf(s.turnId)}`));
      if (mine && you.alive) parts.push(clueForm());
    }

    if (s.phase === 'vote') parts.push(voteCard());
    if (s.phase === 'results') parts.push(resultsCard());
    if (s.phase === 'end') parts.push(endCard());

    const clues = cluesCard();
    if (clues) parts.push(clues);

    parts.push(h('div', { class: 'card' },
      h('h2', null, 'Jugadores'),
      h('div', { class: 'players', style: 'margin-top:10px' }, s.players.map((p) =>
        playerChip(p, s.phase === 'vote' && s.votedIds.includes(p.id) && h('span', { title: 'Ya votó' }, '✅')))),
    ));

    parts.push(h('button', { class: 'btn ghost block', onclick: () => { if (confirm('¿Salir de la partida?')) send({ type: 'leave' }); } }, 'Salir de la sala'));
    return h('div', { class: 'stack' }, parts);
  }

  function phaseLabel() {
    switch (state.phase) {
      case 'clue': return 'Pistas';
      case 'vote': return 'Votación';
      case 'results': return 'Resultados';
      case 'end': return 'Resultado final';
      default: return '';
    }
  }

  function clueForm() {
    const impostor = state.you.role === 'impostor';
    const inp = h('input', {
      id: 'clue-input', class: 'inp', maxlength: '24', autocomplete: 'off', autocapitalize: 'none',
      placeholder: guessMode ? 'Escribe la palabra secreta' : 'Tu pista (una palabra)',
    });
    const form = h('form', {
      class: 'row',
      onsubmit: (ev) => {
        ev.preventDefault();
        const t = inp.value.trim();
        if (!t) return;
        send({ type: guessMode ? 'guess' : 'clue', text: t });
        inp.value = '';
      },
    }, h('div', { class: 'grow' }, inp), h('button', { class: 'btn primary', type: 'submit' }, guessMode ? 'Adivinar' : 'Enviar'));
    setTimeout(() => inp.isConnected && inp.focus(), 0);
    return h('div', { class: 'card stack' },
      form,
      impostor && h('button', { class: 'btn ghost', type: 'button', onclick: () => { guessMode = !guessMode; render(); } },
        guessMode ? '← Mejor doy una pista' : '🎯 Adivinar la palabra (si fallas, quedas eliminado)'),
    );
  }

  function voteCard() {
    const s = state;
    const me = s.you;
    if (!me.alive) {
      return h('div', { class: 'card' }, h('p', { class: 'muted' }, `Los jugadores están votando… (${s.votedIds.length} votos)`));
    }
    const targets = s.players.filter((p) => p.alive && p.id !== me.id);
    return h('div', { class: 'card stack' },
      h('h2', null, '¿Quién es el impostor?'),
      h('div', { class: 'vote-grid' }, targets.map((p) =>
        h('button', { class: ['btn', 'vote-btn', s.yourVote === p.id && 'sel'].filter(Boolean).join(' '), onclick: () => send({ type: 'vote', target: p.id }) },
          h('span', null, p.name), s.yourVote === p.id && h('span', null, '🗳️')))),
      h('button', { class: ['btn', s.yourVote === 'skip' && 'primary'].filter(Boolean).join(' '), onclick: () => send({ type: 'vote', target: null }) }, 'Saltar voto'),
      h('p', { class: 'muted center' }, `${s.votedIds.length} de ${s.players.filter((p) => p.alive && p.connected).length} han votado · puedes cambiar tu voto`),
    );
  }

  function ballotsList(res) {
    if (!res || !res.ballots.length) return null;
    return h('div', null,
      h('h4', null, 'Votos'),
      res.ballots.map((b) => h('div', { class: 'clue' },
        h('span', { class: 'who' }, nameOf(b.voter)),
        h('span', { class: 'txt' }, b.target ? `→ ${nameOf(b.target)}` : '→ (saltó)'))));
  }

  function resultsCard() {
    const res = state.lastResult;
    if (!res) return null;
    return h('div', { class: 'card stack' },
      h('h2', null, `Resultados de la ronda ${res.round}`),
      res.eliminatedId
        ? h('div', { class: ['banner', res.wasImpostor ? 'civ' : 'imp'].join(' ') },
            `${nameOf(res.eliminatedId)} fue eliminado`, h('div', { class: 'muted', style: 'font-size:1rem;font-weight:500' },
              res.wasImpostor ? '¡Era un IMPOSTOR! 🎭' : 'Era un civil inocente 😬'))
        : h('div', { class: 'banner' }, 'Empate: nadie fue eliminado'),
      ballotsList(res),
      h('p', { class: 'muted center' }, 'La siguiente ronda empieza pronto…'),
    );
  }

  function endCard() {
    const s = state;
    const e = s.end;
    const civ = e.winner === 'civiles';
    const reasons = {
      guess: `${nameOf(e.byId)} adivinó la palabra`,
      wrongguess: 'El último impostor falló al adivinar',
      vote: civ ? 'Todos los impostores fueron eliminados' : 'Los impostores igualaron a los civiles',
      abandon: 'Hubo jugadores que abandonaron',
    };
    return h('div', { class: 'stack' },
      h('div', { class: ['banner', civ ? 'civ' : 'imp'].join(' ') },
        civ ? '🎉 ¡Ganaron los civiles!' : '🎭 ¡Ganaron los impostores!',
        h('div', { class: 'muted', style: 'font-size:1rem;font-weight:500' }, reasons[e.reason] || '')),
      h('div', { class: 'card role' },
        h('div', { class: 'small' }, `La palabra secreta era · ${e.category}`),
        h('div', { class: 'word' }, e.word)),
      h('div', { class: 'card' },
        h('h2', null, 'Roles'),
        h('div', { class: 'players', style: 'margin-top:10px' }, s.players.map((p) =>
          h('div', { class: 'player' }, h('span', { class: 'name' }, p.name), h('span', null, p.role === 'impostor' ? '🎭' : '🙂'))))),
      ballotsList(s.lastResult),
      isHost()
        ? h('button', { class: 'btn primary block', onclick: () => send({ type: 'again' }) }, '🔁 Jugar otra vez')
        : h('p', { class: 'muted center' }, 'El anfitrión puede iniciar otra partida.'),
    );
  }

  // ------------------------------------------------------------ render
  function render() {
    const act = document.activeElement;
    const keep = act && act.tagName === 'INPUT' && act.type !== 'checkbox' && act.id && root.contains(act)
      ? { id: act.id, value: act.value, s: act.selectionStart, e: act.selectionEnd }
      : null;

    let view;
    if (!state) view = viewHome();
    else if (state.phase === 'lobby') view = viewLobby();
    else view = viewGame();
    root.replaceChildren(view);

    if (keep) {
      const el = document.getElementById(keep.id);
      if (el) {
        el.value = keep.value;
        el.focus();
        try { el.setSelectionRange(keep.s, keep.e); } catch {}
      }
    }
    chatBtn.hidden = !state;
    if (!state) chatPanel.hidden = true;
    tick();
  }

  function tick() {
    const el = document.getElementById('timer');
    if (!el || !state || !state.deadline) return;
    const left = Math.max(0, Math.ceil((state.deadline - (Date.now() + offset)) / 1000));
    el.textContent = `${left}s`;
    el.classList.toggle('urgent', left <= 5 && left > 0);
  }
  setInterval(tick, 250);

  // ------------------------------------------------------------ chat
  function renderChat() {
    chatLog.replaceChildren(...chatMsgs.map((m) =>
      m.system
        ? h('div', { class: 'msg sys' }, m.text)
        : h('div', { class: 'msg' }, h('b', null, m.name + ': '), m.text)));
    chatLog.scrollTop = chatLog.scrollHeight;
    chatBadge.hidden = unread === 0;
    chatBadge.textContent = String(unread);
  }
  chatBtn.addEventListener('click', () => {
    chatOpen = true;
    unread = 0;
    chatPanel.hidden = false;
    renderChat();
    chatInput.focus();
  });
  document.getElementById('chat-close').addEventListener('click', () => {
    chatOpen = false;
    chatPanel.hidden = true;
  });
  chatForm.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const t = chatInput.value.trim();
    if (!t) return;
    send({ type: 'chat', text: t });
    chatInput.value = '';
  });

  // ------------------------------------------------------------ boot
  render();
  renderChat();
  connect();
})();
