'use strict';

// Tally — card scorekeeper. Lowest score wins; go past the max and you're out.
// State is kept in memory and mirrored to localStorage on every change.

const KEY = 'tally.v1';
const MAXP = 8;
const RULES = { requireWinner: true, autoEnd: true };

const MAX_SAVED = 100;
const digits = v => String(v).replace(/\D/g, '').slice(0, 4);
const eq = (a, b) => a.trim().toLowerCase() === b.trim().toLowerCase();
const esc = v => String(v).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);

// ---------- State & persistence ----------

let state = {
  screen: 'home', maxStr: '200', picked: [], newName: '',
  saved: [], game: null, sheet: null, entry: {}, winner: null, removeId: null,
};

function load() {
  let d = {};
  try { d = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch (e) {}
  const game = d.game && Array.isArray(d.game.players) && Array.isArray(d.game.rounds) ? d.game : null;
  const screen = game && (d.screen === 'game' || d.screen === 'over') ? d.screen : 'home';
  state = { ...state, saved: Array.isArray(d.saved) ? d.saved : [], game, screen };
}

function save() {
  const { saved, game, screen } = state;
  try { localStorage.setItem(KEY, JSON.stringify({ saved, game, screen: screen === 'setup' ? 'home' : screen })); } catch (e) {}
}

function setState(patch) {
  const p = typeof patch === 'function' ? patch(state) : patch;
  state = { ...state, ...p };
  save();
  render();
}

// ---------- Game rules ----------

function calc(g) {
  if (!g) return null;
  const run = {}, last = {}, outAt = {};
  g.players.forEach(p => { run[p.id] = 0; });
  g.rounds.forEach((r, ri) => {
    for (const id in r) {
      run[id] += r[id]; last[id] = r[id];
      if (run[id] > g.max && outAt[id] == null) outAt[id] = ri + 1;
    }
  });
  const ps = g.players.map(p => ({
    ...p, total: run[p.id], last: last[p.id], outAt: outAt[p.id],
    status: p.removed ? 'left' : run[p.id] > g.max ? 'out' : 'active',
  }));
  const active = ps.filter(p => p.status === 'active');
  const over = !!g.ended || active.length === 0 || (RULES.autoEnd && active.length <= 1);
  const pool = (active.length ? active : ps.filter(p => p.status !== 'left')).slice().sort((a, b) => a.total - b.total);
  const min = pool.length ? pool[0].total : 0;
  const winners = pool.filter(p => p.total === min);
  return { ps, active, over, winners, min };
}

function setGame(game, extra = {}) {
  const c = calc(game);
  setState({ game, sheet: null, ...extra, screen: c && c.over ? 'over' : (extra.screen || 'game') });
}

// Setup: players are chosen from the saved roster; picked order is seating order.
function togglePick(name) {
  const picked = state.picked.filter(n => !eq(n, name));
  if (picked.length === state.picked.length) {
    if (picked.length >= MAXP) return;
    picked.push(name);
  }
  setState({ picked });
}

function movePick(from, to) {
  if (to < 0 || to >= state.picked.length || to === from) return;
  const picked = state.picked.slice();
  picked.splice(to, 0, picked.splice(from, 1)[0]);
  setState({ picked });
}

function addPlayer() {
  const name = state.newName.trim().replace(/\s+/g, ' ');
  if (!name) return;
  const existing = state.saved.find(s => eq(s, name));
  const picked = state.picked.slice();
  if (!picked.some(n => eq(n, existing || name)) && picked.length < MAXP) picked.push(existing || name);
  const saved = existing ? state.saved : [name, ...state.saved].slice(0, MAX_SAVED);
  setState({ saved, picked, newName: '' });
}

function start() {
  const max = parseInt(state.maxStr, 10) || 0;
  if (max < 1 || state.picked.length < 2) return;
  const players = state.picked.map((name, i) => ({ id: i, name }));
  // Most recently played names float to the top of the roster.
  const saved = [...state.picked, ...state.saved.filter(s => !state.picked.some(n => eq(n, s)))].slice(0, MAX_SAVED);
  setGame({ max, players, rounds: [], ended: false }, { saved, screen: 'game' });
}

// ---------- Announce: read the standings aloud with the browser's speech synthesis ----------

const CAN_SPEAK = 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window;
let speaking = false;
let utterance = null;

function announceText(g) {
  const c = calc(g);
  const n = g.rounds.length;
  if (!n) return 'Round 1. No scores yet.';
  const byTotal = list => list.slice().sort((a, b) => a.total - b.total);
  const parts = [c.over ? `Final scores after ${n} round${n === 1 ? '' : 's'}.` : `Scores after round ${n}.`];
  if (c.over) parts.push(`${c.winners.map(w => w.name).join(' and ')} ${c.winners.length > 1 ? 'tie' : 'wins'} with ${c.min}.`);
  byTotal(c.active).filter(p => !(c.over && c.winners.includes(p))).forEach(p => parts.push(`${p.name}, ${p.total}.`));
  const out = byTotal(c.ps.filter(p => p.status === 'out'));
  if (out.length) parts.push('Out: ' + out.map(p => `${p.name}, ${p.total}`).join('. ') + '.');
  return parts.join(' ');
}

function announce() {
  const synth = window.speechSynthesis;
  synth.cancel();
  if (speaking) { speaking = false; utterance = null; render(); return; }
  const u = new SpeechSynthesisUtterance(announceText(state.game));
  u.rate = 0.95;
  // cancel() can fire end/error for an earlier utterance late, so only react to the current one.
  u.onend = u.onerror = () => { if (utterance === u) { speaking = false; utterance = null; render(); } };
  utterance = u;
  speaking = true;
  synth.speak(u);
  render();
}

// ---------- Actions (wired via data-click / data-input / data-focus) ----------

const num = v => parseInt(v, 10);
const maxNum = () => parseInt(state.maxStr, 10) || 0;

const actions = {
  goHome: () => setState({ screen: 'home', sheet: null }),
  goSetup: () => setState({ screen: 'setup', sheet: null, picked: [], newName: '', maxStr: state.game ? String(state.game.max) : '200' }),
  resume: () => setState({ screen: 'game', sheet: null }),
  forget: i => setState({ saved: state.saved.filter((_, k) => k !== num(i)) }),

  maxInput: (_, el) => setState({ maxStr: digits(el.value) }),
  maxUp: () => setState({ maxStr: String(maxNum() + 10) }),
  maxDown: () => setState({ maxStr: String(Math.max(10, maxNum() - 10)) }),
  preset: v => setState({ maxStr: String(v) }),
  togglePick: i => togglePick(state.saved[num(i)]),
  unpick: i => setState({ picked: state.picked.filter((_, k) => k !== num(i)) }),
  newNameInput: (_, el) => setState({ newName: el.value }),
  addPlayer,
  start,

  closeSheet: () => setState({ sheet: null }),
  openRound: () => setState({ sheet: 'round', entry: {}, winner: null }),
  askEnd: () => setState({ sheet: 'end' }),
  askRemove: id => setState({ sheet: 'remove', removeId: num(id) }),
  confirmRemove: () => {
    const g = state.game;
    setGame({ ...g, players: g.players.map(p => p.id === state.removeId ? { ...p, removed: true, removedAt: g.rounds.length } : p) });
  },
  endGame: () => setGame({ ...state.game, ended: true }),
  undo: () => {
    const g = state.game;
    setState({ game: { ...g, rounds: g.rounds.slice(0, -1), ended: false }, screen: 'game' });
  },

  entryInput: (id, el) => {
    id = num(id);
    const d = digits(el.value);
    setState(st => ({ entry: { ...st.entry, [id]: d }, winner: st.winner === id && d !== '0' ? null : st.winner }));
  },
  win: id => {
    id = num(id);
    setState(st => {
      const entry = { ...st.entry };
      if (st.winner === id) { entry[id] = ''; return { winner: null, entry }; }
      if (st.winner != null && entry[st.winner] === '0') entry[st.winner] = '';
      entry[id] = '0';
      return { winner: id, entry };
    });
  },
  saveRound: () => {
    const g = state.game, c = calc(g);
    if (!roundReady(c).ok) return;
    const r = {};
    c.active.forEach(p => { r[p.id] = parseInt(state.entry[p.id], 10) || 0; });
    setGame({ ...g, rounds: [...g.rounds, r] });
  },

  rematch: () => {
    const g = state.game;
    setGame({ max: g.max, players: g.players.map(p => ({ id: p.id, name: p.name })), rounds: [], ended: false }, { screen: 'game' });
  },
  newFromGame: () => {
    const picked = state.game.players.map(p => p.name);
    const missing = picked.filter(n => !state.saved.some(s => eq(s, n)));
    setState({ screen: 'setup', picked, newName: '', saved: [...missing, ...state.saved].slice(0, MAX_SAVED), maxStr: String(state.game.max) });
  },
  backToBoard: () => setState({ screen: 'game' }),
  showResults: () => setState({ screen: 'over' }),
  announce,
};

function roundReady(c) {
  const missing = c.active.filter(p => (state.entry[p.id] ?? '') === '').length;
  const noWinner = RULES.requireWinner && state.winner == null;
  return {
    ok: missing === 0 && !noWinner,
    hint: noWinner ? 'Pick the round winner' : `${missing} score${missing === 1 ? '' : 's'} missing`,
  };
}

// ---------- Views ----------

function viewHome() {
  const g = state.game, c = calc(g);
  const resume = g && !c.over
    ? `<button class="btn btn-outline btn-resume" data-click="resume">
        <span>Continue game</span>
        <span class="mono meta">Round ${g.rounds.length + 1} · ${c.active.length} players</span>
      </button>`
    : '';
  const saved = state.saved.length
    ? `<div class="stack" style="gap:14px">
        <div class="row-between"><div class="section-title">Saved players</div><div class="small-mono">${state.saved.length}</div></div>
        <div class="chips">${state.saved.map((name, i) => `
          <div class="saved-pill"><span>${esc(name)}</span><button data-click="forget" data-arg="${i}" aria-label="Forget ${esc(name)}">×</button></div>`).join('')}
        </div>
      </div>`
    : '';
  return `<main class="screen home" data-screen-label="Home">
    <header class="hero">
      <div class="eyebrow">Card scorekeeper</div>
      <h1 class="wordmark">Tally</h1>
      <p class="lede">Lowest score wins. Go past the max and you're out.</p>
    </header>
    <div class="stack" style="gap:12px">
      ${resume}
      <button class="btn btn-dark" data-click="goSetup">New game</button>
    </div>
    ${saved}
  </main>`;
}

const SPEAKER_ICON = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 5 6 9H3v6h3l5 4V5z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M18.5 5.5a9 9 0 0 1 0 13"/></svg>';
const STOP_ICON = '<svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor"/></svg>';
const GRIP ='<svg width="12" height="18" viewBox="0 0 12 18" aria-hidden="true"><g fill="currentColor">'
  + [3, 9, 15].map(y => `<circle cx="3" cy="${y}" r="1.6"/><circle cx="9" cy="${y}" r="1.6"/>`).join('') + '</g></svg>';

function viewSetup() {
  const m = maxNum();
  const n = state.picked.length;
  const full = n >= MAXP;
  // The add row stays first in the list so the morph never replaces its focused input.
  const roster = state.saved.map((name, i) => {
    const pos = state.picked.findIndex(x => eq(x, name));
    const on = pos >= 0;
    return `<button class="pick-row${on ? ' on' : full ? ' dim' : ''}" data-click="togglePick" data-arg="${i}" aria-pressed="${on}">
      <span class="ellipsis">${esc(name)}</span>
      <span class="pick-mark">${on ? '✓' : ''}</span>
    </button>`;
  }).join('');
  const order = state.picked.map((name, i) => `
    <div class="order-row">
      <button class="grip" data-drag="${i}" aria-label="Reorder ${esc(name)}, position ${i + 1} of ${n}. Use arrow keys to move.">${GRIP}</button>
      <div class="no">${i + 1}</div>
      <div class="n ellipsis">${esc(name)}</div>
      <button class="mini" data-click="unpick" data-arg="${i}" aria-label="Take ${esc(name)} out">×</button>
    </div>`).join('');
  const hint = state.saved.length ? 'Tap to pick who’s playing.' : 'Add at least 2 players to start.';
  return `<main class="screen" data-screen-label="New game">
    <div class="topbar">
      <button class="icon-btn" data-click="goHome" aria-label="Back">←</button>
      <h2 class="topbar-title">New game</h2>
    </div>
    <div class="setup-body">
      <section class="stack" style="gap:14px">
        <div class="row-between"><div class="section-title">Max score</div><div class="small-mono">Out at ${m + 1}</div></div>
        <div class="card stepper">
          <button data-click="maxDown" aria-label="Decrease max score">−</button>
          <input data-input="maxInput" value="${esc(state.maxStr)}" inputmode="numeric" aria-label="Max score">
          <button data-click="maxUp" aria-label="Increase max score">+</button>
        </div>
        <div class="presets">${[100, 150, 200, 250].map(p =>
          `<button class="preset${m === p ? ' on' : ''}" data-click="preset" data-arg="${p}">${p}</button>`).join('')}
        </div>
      </section>
      <section class="stack" style="gap:14px">
        <div class="row-between">
          <div class="section-title">Seating order</div>
          <div class="small-mono">${n} of ${MAXP} picked</div>
        </div>
        <div class="card list">${order || '<div class="order-empty">Pick players below</div>'}</div>
      </section>
      <section class="stack" style="gap:14px">
        <div class="section-title">Players</div>
        <div class="card list">
          <div class="add-row">
            <input data-input="newNameInput" data-enter="addPlayer" value="${esc(state.newName)}" placeholder="Add a new player" aria-label="New player name" autocomplete="off" maxlength="24" enterkeyhint="done">
            <button class="add-btn" data-click="addPlayer"${state.newName.trim() ? '' : ' disabled'}>Add</button>
          </div>
          ${roster}
        </div>
        <div class="hint">${hint}</div>
      </section>
    </div>
    <div class="sticky-cta">
      ${n >= 2
        ? `<button class="btn btn-red btn-full" data-click="start">Start game · ${n} players</button>`
        : `<button class="btn btn-disabled btn-full" disabled>Pick at least 2 players</button>`}
    </div>
  </main>`;
}

function viewGame() {
  const g = state.game, c = calc(g);
  const roundNo = g.rounds.length + 1;
  const leadId = g.rounds.length && c.active.length ? c.active.slice().sort((a, b) => a.total - b.total)[0].id : null;

  const cards = c.ps.map(p => {
    const ratio = Math.min(p.total / g.max, 1);
    const danger = p.status === 'active' && ratio >= 0.8;
    let note;
    if (p.status === 'out') note = `Out in round ${p.outAt}`;
    else if (p.status === 'left') note = `Removed after round ${p.removedAt}`;
    else note = `${g.max - p.total} to go` + (p.last == null ? '' : p.last === 0 ? ' · won last round' : ` · +${p.last} last round`);
    const badge = p.id === leadId ? '<div class="badge lead">Lead</div>'
      : p.status === 'out' ? '<div class="badge out">Out</div>'
      : p.status === 'left' ? '<div class="badge left">Removed</div>' : '';
    return `<div class="card pcard">
      <div class="pcard-top">
        <div class="pname-wrap">
          <div class="pname ellipsis${p.status !== 'active' ? ' gone' : ''}">${esc(p.name)}</div>
          ${badge}
        </div>
        <div class="ptotal">${p.total}</div>
      </div>
      <div class="bar"><div class="bar-fill${danger ? ' danger' : ''}" style="width:${(ratio * 100).toFixed(1)}%"></div></div>
      <div class="pcard-foot">
        <div class="pnote">${note}</div>
        ${p.status === 'active' && !c.over ? `<button class="link-btn" data-click="askRemove" data-arg="${p.id}">Remove</button>` : ''}
      </div>
    </div>`;
  }).join('');

  const history = g.rounds.length
    ? `<section class="history">
        <div class="history-head">
          <div class="section-title">History</div>
          <button class="link-btn" data-click="undo">Undo last round</button>
        </div>
        <div class="card table-wrap"><div class="table">
          <div class="trow head">
            <div class="tcell rno">R</div>
            ${c.ps.map(p => `<div class="tcell ellipsis" title="${esc(p.name)}">${esc(p.name)}</div>`).join('')}
          </div>
          ${g.rounds.map((r, i) => `<div class="trow">
            <div class="tcell rno">${i + 1}</div>
            ${g.players.map(p => {
              const x = r[p.id];
              return x == null ? '<div class="tcell none">·</div>' : `<div class="tcell${x === 0 ? ' zero' : ''}">${x}</div>`;
            }).join('')}
          </div>`).reverse().join('')}
          <div class="trow sum">
            <div class="tcell rno">Σ</div>
            ${c.ps.map(p => `<div class="tcell">${p.total}</div>`).join('')}
          </div>
        </div></div>
        <div class="hint">Red 0 = round winner</div>
      </section>`
    : '';

  const cta = c.over
    ? '<button class="btn btn-red btn-full" data-click="showResults">See results</button>'
    : `<button class="btn btn-red btn-full" data-click="openRound">Enter round ${roundNo} scores</button>`;

  return `<main class="screen" data-screen-label="Scoreboard">
    <div class="topbar split">
      <button class="icon-btn" data-click="goHome" aria-label="Home">←</button>
      <div class="topbar-actions">
        ${CAN_SPEAK ? `<button class="icon-btn speak${speaking ? ' on' : ''}" data-click="announce" aria-label="${speaking ? 'Stop announcing' : 'Announce scores'}" aria-pressed="${speaking}">${speaking ? STOP_ICON : SPEAKER_ICON}</button>` : ''}
        ${c.over ? '' : '<button class="text-btn" data-click="askEnd">End game</button>'}
      </div>
    </div>
    <div class="round-head">
      <h1 class="round-title">${c.over ? 'Final' : 'Round ' + roundNo}</h1>
      <div class="round-meta">Max ${g.max}<br>${c.active.length} in play</div>
    </div>
    <div class="players">${cards}</div>
    ${history}
    <div class="spacer"></div>
    <div class="sticky-cta" style="padding-left:16px;padding-right:16px">${cta}</div>
  </main>`;
}

function viewOver() {
  const g = state.game, c = calc(g);
  const order = { active: 0, out: 1, left: 2 };
  const standings = c.ps.slice().sort((a, b) =>
    order[a.status] - order[b.status] ||
    (a.status === 'out' ? (b.outAt - a.outAt) || a.total - b.total : a.total - b.total));
  return `<main class="screen over" data-screen-label="Game over">
    <header class="stack" style="gap:10px">
      <div class="over-eyebrow">${c.winners.length > 1 ? 'Tie' : 'Winner'} · ${g.rounds.length} round${g.rounds.length === 1 ? '' : 's'}</div>
      <h1 class="winner">${esc(c.winners.map(w => w.name).join(' & '))}</h1>
      <div class="over-sub">Lowest score: <span class="mono">${c.min}</span></div>
    </header>
    <div class="card list">${standings.map((p, i) => `
      <div class="stand-row">
        <div class="rank">${i + 1}</div>
        <div class="who">
          <div class="n ellipsis">${esc(p.name)}</div>
          <div class="s">${p.status === 'out' ? `Out in round ${p.outAt}` : p.status === 'left' ? `Removed after round ${p.removedAt}` : 'Still in'}</div>
        </div>
        <div class="t">${p.total}</div>
      </div>`).join('')}
    </div>
    <div class="over-actions">
      <button class="btn btn-red" data-click="rematch">Rematch, same players</button>
      <button class="btn btn-outline" data-click="newFromGame">New game</button>
      <button class="link-btn" data-click="backToBoard">View scoreboard</button>
    </div>
  </main>`;
}

function viewSheet() {
  const g = state.game;
  if (!state.sheet || !g) return '';
  const c = calc(g);
  let body = '';

  if (state.sheet === 'round') {
    const ready = roundReady(c);
    body = `<div class="stack" style="gap:16px">
      <div class="row-between">
        <h2 class="sheet-title" style="white-space:nowrap">Round ${g.rounds.length + 1}</h2>
        <div class="hint">Tap Won for the winner</div>
      </div>
      <div class="stack" style="gap:8px">${c.active.map(p => {
        const val = state.entry[p.id] ?? '';
        const n = parseInt(val, 10);
        const willOut = val !== '' && p.total + n > g.max;
        const proj = val === '' ? `Total ${p.total}` : `${p.total} → ${p.total + n}${willOut ? ' · out' : ''}`;
        const isWin = state.winner === p.id;
        return `<div class="entry">
          <div class="who">
            <div class="n ellipsis">${esc(p.name)}</div>
            <div class="proj${willOut ? ' out' : ''}">${proj}</div>
          </div>
          <button class="won${isWin ? ' on' : ''}" data-click="win" data-arg="${p.id}" aria-pressed="${isWin}">Won</button>
          <input data-input="entryInput" data-arg="${p.id}" value="${esc(val)}" inputmode="numeric" placeholder="–" aria-label="${esc(p.name)} score" autocomplete="off">
        </div>`;
      }).join('')}
      </div>
      ${ready.ok
        ? '<button class="btn btn-red" data-click="saveRound">Save round</button>'
        : `<button class="btn btn-disabled" disabled>${ready.hint}</button>`}
    </div>`;
  } else if (state.sheet === 'remove') {
    const name = (g.players.find(p => p.id === state.removeId) || {}).name || '';
    body = `<div class="stack" style="gap:20px;padding-top:4px">
      <div class="stack" style="gap:8px">
        <h2 class="sheet-title">Remove ${esc(name)}?</h2>
        <p class="sheet-text">They sit out every round from now on. Their past scores stay in the history.</p>
      </div>
      <div class="stack" style="gap:10px">
        <button class="btn btn-dark" data-click="confirmRemove">Remove player</button>
        <button class="cancel" data-click="closeSheet">Cancel</button>
      </div>
    </div>`;
  } else if (state.sheet === 'end') {
    const text = c.active.length ? `${c.winners.map(w => w.name).join(' & ')} wins with the lowest score (${c.min}).` : '';
    body = `<div class="stack" style="gap:20px;padding-top:4px">
      <div class="stack" style="gap:8px">
        <h2 class="sheet-title">End the game now?</h2>
        <p class="sheet-text">${esc(text)}</p>
      </div>
      <div class="stack" style="gap:10px">
        <button class="btn btn-dark" data-click="endGame">End game</button>
        <button class="cancel" data-click="closeSheet">Keep playing</button>
      </div>
    </div>`;
  }

  return `<div class="scrim" data-click="closeSheet"></div>
    <div class="sheet" role="dialog" aria-modal="true">
      <div class="handle"></div>
      ${body}
    </div>`;
}

function view() {
  const g = state.game;
  let screen;
  if (state.screen === 'setup') screen = viewSetup();
  else if (state.screen === 'game' && g) screen = viewGame();
  else if (state.screen === 'over' && g) screen = viewOver();
  else screen = viewHome();
  return screen + viewSheet();
}

// ---------- Rendering: morph new markup into the live DOM so focused inputs survive ----------

function syncAttrs(from, to) {
  for (const { name } of Array.from(from.attributes)) {
    if (!to.hasAttribute(name)) from.removeAttribute(name);
  }
  for (const { name, value } of Array.from(to.attributes)) {
    if (from.getAttribute(name) !== value) from.setAttribute(name, value);
  }
}

function morph(from, to) {
  const a = from.childNodes, b = to.childNodes;
  for (let i = 0; i < b.length; i++) {
    const n = b[i], o = a[i];
    if (!o) { from.appendChild(n.cloneNode(true)); continue; }
    if (o.nodeType !== n.nodeType || o.nodeName !== n.nodeName) { from.replaceChild(n.cloneNode(true), o); continue; }
    if (o.nodeType !== 1) { if (o.nodeValue !== n.nodeValue) o.nodeValue = n.nodeValue; continue; }
    syncAttrs(o, n);
    if (o.tagName === 'INPUT') {
      const v = n.getAttribute('value') ?? '';
      if (o.value !== v) o.value = v;
      continue;
    }
    morph(o, n);
  }
  while (a.length > b.length) from.removeChild(from.lastChild);
}

const root = document.getElementById('app');
let lastScreen = null;

function render() {
  if (speaking && state.screen !== 'game') { window.speechSynthesis.cancel(); speaking = false; utterance = null; }
  const tpl = document.createElement('template');
  tpl.innerHTML = view();
  morph(root, tpl.content);
  document.body.classList.toggle('locked', !!state.sheet);
  const screenKey = state.screen;
  if (screenKey !== lastScreen) { lastScreen = screenKey; window.scrollTo(0, 0); }
}

root.addEventListener('click', e => {
  const el = e.target.closest('[data-click]');
  if (!el || el.disabled) return;
  const fn = actions[el.dataset.click];
  if (fn) fn(el.dataset.arg, el);
});
root.addEventListener('input', e => {
  const el = e.target.closest('[data-input]');
  const fn = el && actions[el.dataset.input];
  if (fn) fn(el.dataset.arg, el);
});
root.addEventListener('focusin', e => {
  const el = e.target.closest('[data-focus]');
  const fn = el && actions[el.dataset.focus];
  if (fn) fn(el.dataset.arg, el);
});
root.addEventListener('keydown', e => {
  if (e.key !== 'Enter' || e.target.tagName !== 'INPUT') return;
  if (e.target.dataset.enter) { e.preventDefault(); actions[e.target.dataset.enter](); return; }
  // Enter moves to the next input, or saves the round / starts the game from the last one.
  const inputs = Array.from(root.querySelectorAll(state.sheet ? '.sheet input' : 'input'));
  const next = inputs[inputs.indexOf(e.target) + 1];
  e.preventDefault();
  if (next) next.focus();
  else if (state.sheet === 'round') actions.saveRound();
  else if (state.screen === 'setup') start();
});

// Drag to reorder the seating list. Rows move with inline transforms during the drag;
// state is only updated on drop, so the morph never runs mid-gesture.
let drag = null;
root.addEventListener('pointerdown', e => {
  const grip = e.target.closest('[data-drag]');
  if (!grip || e.button > 0) return;
  e.preventDefault();
  const row = grip.closest('.order-row');
  const rows = Array.from(row.parentNode.querySelectorAll('.order-row'));
  const from = rows.indexOf(row);
  drag = { id: e.pointerId, row, rows, from, to: from, startY: e.clientY, h: row.getBoundingClientRect().height };
  grip.setPointerCapture(e.pointerId);
  row.parentNode.classList.add('sorting');
  row.classList.add('dragging');
});
root.addEventListener('pointermove', e => {
  if (!drag || e.pointerId !== drag.id) return;
  const { rows, from, h } = drag;
  const dy = Math.max(-from * h, Math.min((rows.length - 1 - from) * h, e.clientY - drag.startY));
  const to = from + Math.round(dy / h);
  drag.to = to;
  drag.row.style.transform = `translateY(${dy}px)`;
  rows.forEach((r, i) => {
    if (i === from) return;
    const shift = i > from && i <= to ? -h : i < from && i >= to ? h : 0;
    r.style.transform = shift ? `translateY(${shift}px)` : '';
  });
});
function endDrag(e) {
  if (!drag || e.pointerId !== drag.id) return;
  const { rows, row, from, to } = drag;
  drag = null;
  row.parentNode.classList.remove('sorting');
  rows.forEach(r => { r.style.transform = ''; r.classList.remove('dragging'); });
  movePick(from, to);
}
root.addEventListener('pointerup', endDrag);
root.addEventListener('pointercancel', endDrag);
root.addEventListener('keydown', e => {
  const grip = e.target.closest('[data-drag]');
  if (!grip || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
  e.preventDefault();
  const from = num(grip.dataset.drag);
  const to = from + (e.key === 'ArrowUp' ? -1 : 1);
  movePick(from, to);
  const moved = root.querySelector(`[data-drag="${Math.max(0, Math.min(state.picked.length - 1, to))}"]`);
  if (moved) moved.focus();
});

document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && state.sheet) actions.closeSheet();
});
window.addEventListener('storage', e => {
  if (e.key === KEY) { load(); render(); }
});

load();
render();
