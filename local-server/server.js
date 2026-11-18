// 搖搖賽馬：多人連線伺服器
// 不需安裝任何套件，Node.js 18 以上直接執行：node server.js
// 手機頁面：http://<電腦IP>:3000/
// 大螢幕頁面：http://<電腦IP>:3000/screen?key=<主持人密碼>

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

// ===== 可調整的設定 =====
const PORT = Number(process.env.PORT) || 3000;
// 枱數：預設 4 枱，名稱由頁面按語言顯示（第 1 枱／Table 1）。
// 想自訂名稱可設 TABLES="市場部,財務部,..."（自訂名稱不會翻譯）。
const CUSTOM_NAMES = process.env.TABLES
  ? process.env.TABLES.split(',').map(s => s.trim()).filter(Boolean).slice(0, 8)
  : null;
const TABLE_COUNT = CUSTOM_NAMES ? CUSTOM_NAMES.length
  : Math.max(2, Math.min(8, Number(process.env.TABLE_COUNT) || 5));
const TABLES = Array.from({ length: TABLE_COUNT }, (_, i) => (CUSTOM_NAMES ? CUSTOM_NAMES[i] : null));
const RACE_SECONDS = Number(process.env.RACE_SECONDS) || 20; // 平均手速下大約跑幾秒
const AVG_TAPS = 6.5;               // 一般人每秒大約按 6.5 下
const STEP = 100 / (AVG_TAPS * RACE_SECONDS);
const MAX_TAPS_PER_SEC = 16;        // 防止連點器作弊：每人每秒最多計 16 下
const COUNTDOWN_MS = 3000;
const RACE_TIMEOUT_MS = 90000;      // 保險：90 秒後強制完場
const HOST_KEY = process.env.HOST_KEY || crypto.randomBytes(3).toString('hex');

// ===== 狀態 =====
const players = new Map(); // id -> { table, name, taps, conns, lastSeen, sec, secN }
const streams = new Set(); // SSE 連線
let raceNo = 0;
let race = freshRace();

function freshRace() {
  raceNo += 1;
  return {
    no: raceNo,
    phase: 'idle',               // idle | count | race | done
    countdownEnd: 0,
    startAt: 0,
    endAt: 0,
    prog: TABLES.map(() => 0),
    rate: TABLES.map(() => 0),
    finish: TABLES.map(() => null),
    pending: TABLES.map(() => 0),
    entered: TABLES.map(() => false),
    top: [],
  };
}

const now = () => Date.now();
function isActive(p) { return p.conns > 0 || now() - p.lastSeen < 8000; }
function tableCounts() {
  const c = TABLES.map(() => 0);
  for (const p of players.values()) if (p.table != null && isActive(p)) c[p.table]++;
  return c;
}

// ===== 比賽邏輯（每 50 毫秒）=====
setInterval(() => {
  const t = now();
  if (race.phase === 'count' && t >= race.countdownEnd) {
    race.phase = 'race';
    race.startAt = t;
    race.pending = TABLES.map(() => 0);
    const counts = tableCounts();
    race.entered = counts.map(n => n > 0);
    for (const p of players.values()) p.taps = 0;
  }
  if (race.phase !== 'race') return;

  const counts = tableCounts();
  const dt = 0.05;
  const elapsed = (t - race.startAt) / 1000;
  TABLES.forEach((_, i) => {
    if (race.finish[i] != null) { race.pending[i] = 0; return; }
    if (counts[i] > 0) race.entered[i] = true;
    const n = Math.max(1, counts[i]);
    const per = race.pending[i] / n;
    race.pending[i] = 0;
    race.rate[i] = race.rate[i] * 0.92 + (per / dt) * 0.08;
    race.prog[i] = Math.min(100, race.prog[i] + per * STEP);
    if (race.prog[i] >= 100) race.finish[i] = elapsed;
  });

  const runners = TABLES.map((_, i) => i).filter(i => race.entered[i]);
  const allDone = runners.length > 0 && runners.every(i => race.finish[i] != null);
  if (allDone || t - race.startAt > RACE_TIMEOUT_MS) endRace();
}, 50);

function endRace() {
  race.phase = 'done';
  race.endAt = now();
  race.top = [...players.entries()]
    .filter(([, p]) => p.taps > 0)
    .sort((a, b) => b[1].taps - a[1].taps)
    .slice(0, 5)
    .map(([id, p]) => ({ id, name: p.name || '', table: p.table, taps: p.taps }));
}

function ranking() {
  return TABLES.map((_, i) => i)
    .filter(i => race.entered[i] || race.prog[i] > 0)
    .sort((a, b) => {
      const fa = race.finish[a], fb = race.finish[b];
      if (fa != null && fb != null) return fa - fb;
      if (fa != null) return -1;
      if (fb != null) return 1;
      return race.prog[b] - race.prog[a];
    });
}

function snapshot() {
  const counts = tableCounts();
  const t = now();
  return {
    no: race.no,
    phase: race.phase,
    countdown: race.phase === 'count' ? Math.max(0, Math.ceil((race.countdownEnd - t) / 1000)) : 0,
    elapsed: race.phase === 'race' ? (t - race.startAt) / 1000
      : race.phase === 'done' ? (race.endAt - race.startAt) / 1000 : 0,
    total: counts.reduce((a, b) => a + b, 0),
    tables: TABLES.map((name, i) => ({
      name, players: counts[i],
      prog: +race.prog[i].toFixed(2),
      rate: +race.rate[i].toFixed(2),
      finish: race.finish[i],
    })),
    ranking: race.phase === 'done' ? ranking() : null,
    top: race.phase === 'done' ? race.top.map(({ name, table, taps }) => ({ name, table, taps })) : null,
  };
}

// 每 100 毫秒推送一次狀態
setInterval(() => {
  if (!streams.size) return;
  const snap = snapshot();
  for (const s of streams) {
    const me = s.id && players.get(s.id);
    const mvp = me && race.phase === 'done' ? race.top.findIndex(t => t.id === s.id) : -1;
    const payload = me ? { ...snap, me: { table: me.table, taps: me.taps, name: me.name, mvp } } : snap;
    s.res.write(`data: ${JSON.stringify(payload)}\n\n`);
  }
}, 100);

// 保持連線（某些網絡會切斷閒置連線）
setInterval(() => { for (const s of streams) s.res.write(': ping\n\n'); }, 15000);

// ===== HTTP =====
function send(res, code, body, type = 'application/json; charset=utf-8') {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}
function readJson(req) {
  return new Promise(resolve => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > 2048) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}
const validId = id => typeof id === 'string' && /^[a-zA-Z0-9_-]{6,40}$/.test(id);
const PUBLIC = path.join(__dirname, 'public');
function serveFile(res, name) {
  fs.readFile(path.join(PUBLIC, name), (err, buf) => {
    if (err) return send(res, 404, 'Not found', 'text/plain; charset=utf-8');
    send(res, 200, buf, 'text/html; charset=utf-8');
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;

  if (req.method === 'GET' && (p === '/' || p === '/play')) return serveFile(res, 'play.html');
  if (req.method === 'GET' && p === '/screen') return serveFile(res, 'screen.html');
  if (req.method === 'GET' && p === '/state') {
    // 手機和大螢幕每 0.15 秒拎一次最新狀態（比串流更能穿過各種代理和通道）
    const id = url.searchParams.get('id');
    const snap = snapshot();
    const me = validId(id) && players.get(id);
    if (me) {
      me.lastSeen = now();
      const mvp = race.phase === 'done' ? race.top.findIndex(t => t.id === id) : -1;
      snap.me = { table: me.table, taps: me.taps, name: me.name, mvp };
    }
    return send(res, 200, snap);
  }
  if (req.method === 'GET' && p === '/healthz') return send(res, 200, { ok: true });
  if (req.method === 'GET' && p === '/info') return send(res, 200, { tables: TABLES });

  if (req.method === 'GET' && p === '/events') {
    const id = url.searchParams.get('id');
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 1500\n\n');
    const s = { res, id: validId(id) ? id : null };
    streams.add(s);
    const pl = s.id && players.get(s.id);
    if (pl) { pl.conns++; pl.lastSeen = now(); }
    req.on('close', () => {
      streams.delete(s);
      const q = s.id && players.get(s.id);
      if (q) { q.conns = Math.max(0, q.conns - 1); q.lastSeen = now(); }
    });
    return;
  }

  if (req.method === 'POST' && p === '/join') {
    const b = await readJson(req);
    if (!validId(b.id)) return send(res, 400, { error: '無效的玩家編號' });
    const table = Number(b.table);
    if (!Number.isInteger(table) || table < 0 || table >= TABLES.length) return send(res, 400, { error: '請選擇枱號' });
    if (race.phase === 'race' || race.phase === 'count') {
      const ex = players.get(b.id);
      if (ex && ex.table != null && ex.table !== table) return send(res, 409, { error: '比賽進行中，完場後先可以轉枱' });
    }
    const name = String(b.name || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 12);
    const ex = players.get(b.id);
    if (ex) { ex.table = table; ex.name = name; ex.lastSeen = now(); }
    else players.set(b.id, { table, name, taps: 0, conns: 0, lastSeen: now(), sec: 0, secN: 0 });
    return send(res, 200, { ok: true });
  }

  if (req.method === 'POST' && p === '/tap') {
    const b = await readJson(req);
    const pl = validId(b.id) && players.get(b.id);
    if (!pl) return send(res, 404, { error: '請先揀枱' });
    pl.lastSeen = now();
    let n = Math.max(0, Math.min(40, Math.floor(Number(b.n) || 0)));
    if (race.phase === 'race' && pl.table != null && race.finish[pl.table] == null && n > 0) {
      const sec = Math.floor(now() / 1000);
      if (pl.sec !== sec) { pl.sec = sec; pl.secN = 0; }
      n = Math.min(n, MAX_TAPS_PER_SEC - pl.secN);
      if (n > 0) { pl.secN += n; pl.taps += n; race.pending[pl.table] += n; }
    }
    return send(res, 200, { ok: true, taps: pl.taps });
  }

  if (req.method === 'POST' && p === '/admin') {
    const b = await readJson(req);
    if (b.key !== HOST_KEY) return send(res, 403, { error: '主持人密碼不正確' });
    if (b.action === 'start') {
      if (race.phase === 'count' || race.phase === 'race') return send(res, 409, { error: '比賽已經開始' });
      const keep = race.phase === 'idle' ? race.no : null;
      race = freshRace();
      if (keep) { raceNo = keep; race.no = keep; }
      race.phase = 'count';
      race.countdownEnd = now() + COUNTDOWN_MS;
      return send(res, 200, { ok: true });
    }
    if (b.action === 'reset') {
      const keep = race.no;
      raceNo = keep - 1;
      race = freshRace();
      return send(res, 200, { ok: true });
    }
    if (b.action === 'stop' && race.phase === 'race') { endRace(); return send(res, 200, { ok: true }); }
    return send(res, 400, { error: '未知的指令' });
  }

  send(res, 404, 'Not found', 'text/plain; charset=utf-8');
});

// 清走長時間離線的玩家
setInterval(() => {
  for (const [id, p] of players) if (p.conns === 0 && now() - p.lastSeen > 30 * 60 * 1000) players.delete(id);
}, 60000);

server.listen(PORT, '0.0.0.0', () => {
  const ips = [];
  for (const list of Object.values(os.networkInterfaces()))
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) ips.push(a.address);
  console.log('\n🏇 搖搖賽馬伺服器已啟動');
  console.log(`   主持人密碼：${HOST_KEY}`);
  console.log(`   本機大螢幕：http://localhost:${PORT}/screen?key=${HOST_KEY}`);
  for (const ip of ips) {
    console.log(`   同一 Wi-Fi 大螢幕：http://${ip}:${PORT}/screen?key=${HOST_KEY}`);
    console.log(`   同一 Wi-Fi 手機：  http://${ip}:${PORT}/`);
  }
  console.log('   用 cloudflared 通道時，請用通道網址開大螢幕（網址後面加 /screen?key=密碼）。\n');
});
