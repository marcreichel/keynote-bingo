import http from 'node:http';
import fs from 'node:fs';
import { randomInt } from 'node:crypto';

const PORT = process.env.PORT || 3000;
const MODEL = process.env.OLLAMA_MODEL || 'gemma4';
const OLLAMA = process.env.OLLAMA_URL || 'http://localhost:11434';
const DB = new URL('./rooms.json', import.meta.url);
const INDEX = new URL('./index.html', import.meta.url);
const FEEDS = [
  'https://feeds.macrumors.com/MacRumors-All',
  'https://9to5mac.com/feed/',
  'https://appleinsider.com/rss/news/',
];
const MEMES = [
  'One more thing…',
  'Tim Cook: "Good morning!"',
  'Drone shot of Apple Park',
  '"Our best ___ ever"',
  '"We think you\'re going to love it"',
  'Price stays the same',
  'Price goes up',
  'Environment / carbon neutral segment',
  'Someone jogs through Apple Park',
  '"Available today"',
  'Craig Federighi hair moment',
  'New color is some shade of blue',
  'Titanium mentioned',
  '"Magical"',
  'Emotional health story',
  'Apple Intelligence mentioned',
  'Exploded-view product shot',
  'Comparison to an old Intel Mac',
  'Siri gets smarter',
  'New accessibility feature',
];
const PROMPT = `Below are recent Apple news headlines and rumors. Write 30 short bingo cells (max 6 words each) predicting concrete things that could be announced or shown at the upcoming Apple keynote: products, features, specs, prices. No duplicates, no question marks.
Respond as JSON: {"topics": ["...", "..."]}

Headlines:
`;

// ---- pure game logic (tested in bingo.test.js) ----

const R = [0, 1, 2, 3, 4];
export const LINES = [
  ...R.map(r => R.map(c => r * 5 + c)),
  ...R.map(c => R.map(r => r * 5 + c)),
  R.map(i => i * 6),
  R.map(i => i * 4 + 4),
];

export const completedLines = (card, marked) =>
  LINES.filter(l => l.every(i => i === 12 || marked.has(card[i])));

export function deal(pool) {
  const a = [...pool];
  for (let i = a.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  const card = a.slice(0, 24);
  card.splice(12, 0, 'FREE');
  return card;
}

export function clean(list) {
  const seen = new Set();
  return list
    .map(t => (typeof t === 'string' ? t.trim().slice(0, 80) : ''))
    .filter(t => t && t !== 'FREE' && !seen.has(t.toLowerCase()) && seen.add(t.toLowerCase()));
}

// ---- state ----

let rooms = {};
const save = () => fs.writeFileSync(DB, JSON.stringify(rooms));
const fail = (status, msg) => { throw Object.assign(new Error(msg), { status }); };
const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

function getRoom(code) {
  return rooms[str(code, 6).toUpperCase()] || fail(404, 'Room not found');
}

function log(room, text, type = 'info') {
  room.feed.unshift({ id: room.nextFeedId++, text, type, at: Date.now() });
  room.feed.length = Math.min(room.feed.length, 50);
}

function updateWinners(room) {
  const m = new Set(room.marked);
  for (const [id, p] of Object.entries(room.players)) {
    if (!p.card) continue;
    const has = completedLines(p.card, m).length > 0;
    const i = room.winners.indexOf(id);
    if (has && i < 0) {
      room.winners.push(id);
      log(room, `🎉 ${p.name} got BINGO #${room.winners.length}!`, 'bingo');
    } else if (!has && i >= 0) {
      room.winners.splice(i, 1);
      log(room, `${p.name} lost their bingo`);
    }
  }
}

function view(room, pid) {
  const m = new Set(room.marked);
  const me = room.players[pid];
  return {
    code: room.code,
    status: room.status,
    isHost: room.host === pid,
    pool: room.pool,
    marked: room.marked,
    feed: room.feed,
    me: { name: me.name, card: me.card || null, lines: me.card ? completedLines(me.card, m) : [] },
    players: Object.entries(room.players).map(([id, p]) => ({
      name: p.name,
      you: id === pid,
      lines: p.card ? completedLines(p.card, m).length : 0,
      hits: p.card ? p.card.filter(t => t === 'FREE' || m.has(t)).length : 0,
      place: room.winners.indexOf(id) + 1 || null,
    })),
  };
}

// ---- topic generation ----

const decode = s => s
  .replace(/<!\[CDATA\[|\]\]>/g, '')
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(n))
  .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
  .replace(/&(amp|lt|gt|quot|apos);/g, (_, e) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" })[e])
  .trim();

const fetchTitles = url => fetch(url, { signal: AbortSignal.timeout(10_000) })
  .then(r => r.text())
  .then(xml => [...xml.matchAll(/<(?:item|entry)\b[\s\S]*?<title[^>]*>([\s\S]*?)<\/title>/g)]
    .slice(0, 15).map(m => decode(m[1])))
  .catch(e => (console.warn(`feed ${url}: ${e.message}`), []));

async function askLlm(headlines) {
  const r = await fetch(`${OLLAMA}/api/chat`, {
    method: 'POST',
    signal: AbortSignal.timeout(180_000),
    body: JSON.stringify({
      model: MODEL,
      stream: false,
      format: 'json',
      messages: [{ role: 'user', content: PROMPT + headlines.map(h => `- ${h}`).join('\n') }],
    }),
  });
  if (!r.ok) throw new Error(`ollama ${r.status}: ${await r.text()}`);
  const { topics } = JSON.parse((await r.json()).message.content);
  if (!Array.isArray(topics) || !topics.length) throw new Error('LLM returned no topics');
  return topics;
}

async function generate(code) {
  const headlines = (await Promise.all(FEEDS.map(fetchTitles))).flat();
  let topics;
  try {
    topics = await askLlm(headlines);
  } catch (e) {
    console.warn(`LLM failed: ${e.message}`);
    topics = headlines;
  }
  const room = rooms[code];
  if (!room) return;
  room.pool = clean([...topics, ...MEMES]);
  room.status = 'lobby';
  if (topics === headlines) log(room, 'LLM unavailable, using raw headlines. Host: trim them down!');
  save();
}

// ---- actions ----

const actions = {
  create({ name, playerId }) {
    name = str(name, 20) || fail(400, 'Nickname required');
    let code;
    do code = Array.from({ length: 6 }, () => 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'[randomInt(31)]).join('');
    while (rooms[code]);
    rooms[code] = {
      code, host: playerId, status: 'generating', pool: [], marked: [], winners: [],
      players: { [playerId]: { name } }, feed: [], nextFeedId: 1,
    };
    save();
    generate(code);
    return { code };
  },

  join({ code, name, playerId }, room) {
    name = str(name, 20) || fail(400, 'Nickname required');
    const p = room.players[playerId];
    if (p) p.name = name;
    else {
      room.players[playerId] = { name, card: room.status === 'playing' ? deal(room.pool) : undefined };
      log(room, `${name} joined`);
      updateWinners(room);
    }
    save();
  },

  start({ topics, playerId }, room) {
    if (room.host !== playerId) fail(403, 'Only the host can start');
    if (room.status !== 'lobby') fail(409, 'Game already started');
    const pool = clean(Array.isArray(topics) ? topics.slice(0, 300) : []);
    if (pool.length < 24) fail(400, `Need ${24 - pool.length} more topics`);
    room.pool = pool;
    room.status = 'playing';
    for (const p of Object.values(room.players)) p.card = deal(pool);
    log(room, 'Game started. Good luck!');
    save();
  },

  toggle({ topic, playerId }, room) {
    if (room.status !== 'playing') fail(409, 'Game not running');
    if (!room.pool.includes(topic)) fail(400, 'Unknown topic');
    const name = room.players[playerId].name;
    const i = room.marked.indexOf(topic);
    if (i < 0) room.marked.push(topic);
    else room.marked.splice(i, 1);
    log(room, i < 0 ? `${name} called “${topic}”` : `${name} unmarked “${topic}”`, i < 0 ? 'mark' : 'unmark');
    updateWinners(room);
    save();
  },
};

// ---- http ----

const json = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
};

const readBody = req => new Promise((ok, no) => {
  let d = '';
  req.on('data', c => {
    d += c;
    if (d.length > 100_000) { no(Object.assign(new Error('Body too large'), { status: 413 })); req.destroy(); }
  });
  req.on('end', () => {
    try { ok(JSON.parse(d || '{}')); } catch { no(Object.assign(new Error('Bad JSON'), { status: 400 })); }
  });
});

// ponytail: clients poll this every 1.5s. SSE got buffered by cloudflared quick tunnels; polling passes any proxy.
function state(url) {
  const room = getRoom(url.searchParams.get('code'));
  const pid = url.searchParams.get('playerId');
  if (!room.players[pid]) fail(404, 'Not in this room');
  return view(room, pid);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(fs.readFileSync(INDEX));
    }
    if (req.method === 'GET' && url.pathname === '/api/state') return json(res, 200, state(url));
    const action = req.method === 'POST' && url.pathname.startsWith('/api/') && actions[url.pathname.slice(5)];
    if (!action) return json(res, 404, { error: 'Not found' });
    const body = await readBody(req);
    body.playerId = str(body.playerId, 64) || fail(400, 'playerId required');
    let room;
    if (action !== actions.create) {
      room = getRoom(body.code);
      if (action !== actions.join && !room.players[body.playerId]) fail(403, 'Not in this room');
    }
    const out = action(body, room);
    json(res, 200, out ?? view(room, body.playerId)); // return fresh state so the actor sees it instantly
  } catch (e) {
    if (!e.status) console.error(e);
    json(res, e.status || 500, { error: e.message });
  }
});

if (import.meta.main) {
  try { rooms = JSON.parse(fs.readFileSync(DB, 'utf8')); } catch {}
  for (const r of Object.values(rooms)) if (r.status === 'generating') generate(r.code);
  server.listen(PORT, () => console.log(`Keynote Bingo on http://localhost:${PORT} (model: ${MODEL})`));
}
