const T = tiedyer;
const btn = [...document.querySelectorAll('button')].find(b => b.textContent === 'Twist');
const t0 = performance.now();
btn.click();
await new Promise(r => { const id = setInterval(() => { if (T.bundle && 'cloth' in T.bundle) { clearInterval(id); r(); } }, 200); });
const ms = performance.now() - t0;
const b = T.bundle; let top = 0, bot = 0, nc = 0;
for (let i = 0; i < b.n; i++) { top += b.surfaceTop[i]; bot += b.surfaceBot[i]; for (let k = 0; k < 8; k++) if (b.contacts[i*8+k] >= 0) nc++; }
const bb = b.bbox();
// squirt 3 colours in 3 sectors around the centre, top side
const c = T.plan.twist.c;
for (let s = 0; s < 6; s++) { const a = s * Math.PI / 3 + 0.3; for (let r = 1.5; r < 11; r += 2.5) T.addStroke({kind:'brush', p:{x: c.x + r*Math.cos(a), y: c.y + r*Math.sin(a)}, r: 2.2, dye: s % 3, amount: 0.9, side: 'top', pen: 8}); }
T.step(100);
return { ms: ms.toFixed(0), n: b.n, top, bot, avgContacts: (nc / b.n).toFixed(2), bbox: [bb.minX, bb.minY, bb.maxX, bb.maxY].map(v => +v.toFixed(1)), status: document.getElementById('status').textContent };
