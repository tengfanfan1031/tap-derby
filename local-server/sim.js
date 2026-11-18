// 綵排用：模擬多位同事加入並狂按
// 用法：node sim.js [人數=39] [伺服器網址=http://localhost:3000]
const N = Number(process.argv[2]) || 39;
const BASE = process.argv[3] || 'http://localhost:3000';
const names = ['阿明', 'Karen', '小芳', 'Jason', '阿傑', 'Mandy', '大衛', 'Ivy', '阿強', 'Tom'];

async function post(path, body) {
  try {
    await fetch(BASE + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  } catch { /* 忽略 */ }
}

(async () => {
  const info = await (await fetch(BASE + '/info')).json();
  const T = info.tables.length;
  const bots = Array.from({ length: N }, (_, i) => ({
    id: 'bot' + i + 'x' + Math.random().toString(36).slice(2, 8),
    table: i % T,
    speed: 4 + Math.random() * 5, // 每秒按幾下
    buf: 0,
  }));
  for (const b of bots) await post('/join', { id: b.id, table: b.table, name: names[Math.floor(Math.random() * names.length)] + (Math.random() * 100 | 0) });
  console.log(`已加入 ${N} 位模擬玩家，等待比賽開始…（Ctrl+C 結束）`);

  let phase = '';
  setInterval(async () => {
    try { phase = (await (await fetch(BASE + '/state')).json()).phase; } catch { }
  }, 300);

  setInterval(() => {
    for (const b of bots) {
      if (phase === 'race') {
        b.buf += b.speed * 0.2 * (0.6 + Math.random() * 0.8);
        const n = Math.floor(b.buf); b.buf -= n;
        post('/tap', { id: b.id, n });
      } else if (Math.random() < 0.15) {
        post('/tap', { id: b.id, n: 0 });
      }
    }
  }, 200);
})();
