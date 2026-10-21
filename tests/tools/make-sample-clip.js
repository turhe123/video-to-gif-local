// make-sample-clip.js — generates tests/fixtures/sample-clip.mp4: a five second, fictional clip of a
// bouncing coloured ball on a grey background (640x360, 25 fps, VP9 in an MP4 container).
// Frames are drawn on a canvas and encoded with WebCodecs inside headless Chromium; this script then
// writes a plain (non-fragmented, fast-start) MP4 so every browser can seek in it.
// Run: node tests/tools/make-sample-clip.js   (needs @playwright/test, same as the test suite)
const fs = require('fs');
const path = require('path');

function loadChromium() {
  const roots = [process.env.WEBFACTORY_HOME, process.cwd()].filter(Boolean);
  for (const r of roots) {
    for (const mod of ['playwright', '@playwright/test']) {
      try { return require(require.resolve(mod, { paths: [r] })).chromium; } catch { /* try next */ }
    }
  }
  throw new Error('Playwright not found (set WEBFACTORY_HOME or install @playwright/test)');
}

const W = 640, H = 360, FPS = 25, SECONDS = 5, CODEC = 'vp09.00.21.08';

const PAGE = `<!doctype html><canvas id="c" width="${W}" height="${H}"></canvas><script>
window.encode = async () => {
  const W = ${W}, H = ${H}, FPS = ${FPS}, N = ${FPS * SECONDS};
  const c = document.getElementById('c'); const ctx = c.getContext('2d');
  const chunks = [];
  const enc = new VideoEncoder({
    output: (chunk) => { const b = new Uint8Array(chunk.byteLength); chunk.copyTo(b); chunks.push({ key: chunk.type === 'key', data: Array.from(b) }); },
    error: (e) => { throw e; },
  });
  enc.configure({ codec: '${CODEC}', width: W, height: H, bitrate: 900000, framerate: FPS, latencyMode: 'quality' });
  const R = 34;
  for (let i = 0; i < N; i++) {
    const t = i / N; // 0..1, periodic so the clip loops seamlessly
    ctx.fillStyle = '#8a8d93'; ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#6f7278'; ctx.fillRect(0, H - 40, W, 40);
    const x = R + (W - 2 * R) * (0.5 - 0.5 * Math.cos(2 * Math.PI * t));
    const y = (H - 40 - R) - (H - 40 - 2 * R) * Math.abs(Math.sin(3 * Math.PI * t));
    ctx.fillStyle = 'rgba(0,0,0,0.25)'; ctx.beginPath(); ctx.ellipse(x, H - 36, R, 7, 0, 0, 2 * Math.PI); ctx.fill();
    ctx.fillStyle = 'hsl(' + Math.round(360 * t) + ' 85% 55%)';
    ctx.beginPath(); ctx.arc(x, y, R, 0, 2 * Math.PI); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.45)'; ctx.beginPath(); ctx.arc(x - 10, y - 10, 9, 0, 2 * Math.PI); ctx.fill();
    const frame = new VideoFrame(c, { timestamp: Math.round(i * 1e6 / FPS), duration: Math.round(1e6 / FPS) });
    enc.encode(frame, { keyFrame: i % FPS === 0 });
    frame.close();
  }
  await enc.flush();
  return chunks;
};
</script>`;

// ---- minimal MP4 writer ----
const u8 = (n) => Buffer.from([n & 255]);
const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16BE(n); return b; };
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0); return b; };
const str = (s) => Buffer.from(s, 'latin1');
const box = (type, ...parts) => { const body = Buffer.concat(parts); return Buffer.concat([u32(body.length + 8), str(type), body]); };
const full = (type, version, flags, ...parts) => box(type, u8(version), Buffer.from([(flags >> 16) & 255, (flags >> 8) & 255, flags & 255]), ...parts);
const MATRIX = Buffer.concat([0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000].map(u32));

function mp4(samples) {
  const N = samples.length, TS = 12800, DELTA = TS / FPS, durMs = Math.round(N * 1000 / FPS);
  const ftyp = box('ftyp', str('isom'), u32(512), str('isom'), str('iso2'), str('iso6'), str('mp41'));
  const vpcC = full('vpcC', 1, 0, u8(0), u8(21), u8((8 << 4) | (1 << 1) | 0), u8(1), u8(1), u8(1), u16(0));
  const vp09 = box('vp09', Buffer.alloc(6), u16(1), u16(0), u16(0), Buffer.alloc(12), u16(W), u16(H),
    u32(0x00480000), u32(0x00480000), u32(0), u16(1), Buffer.alloc(32), u16(0x18), u16(0xffff), vpcC);
  const build = (offset) => {
    const stbl = box('stbl',
      full('stsd', 0, 0, u32(1), vp09),
      full('stts', 0, 0, u32(1), u32(N), u32(DELTA)),
      full('stss', 0, 0, u32(samples.filter((s) => s.key).length), ...samples.map((s, i) => (s.key ? u32(i + 1) : null)).filter(Boolean)),
      full('stsc', 0, 0, u32(1), u32(1), u32(N), u32(1)),
      full('stsz', 0, 0, u32(0), u32(N), ...samples.map((s) => u32(s.data.length))),
      full('stco', 0, 0, u32(1), u32(offset)));
    const minf = box('minf', full('vmhd', 0, 1, u16(0), u16(0), u16(0), u16(0)),
      box('dinf', full('dref', 0, 0, u32(1), full('url ', 0, 1))), stbl);
    const mdia = box('mdia',
      full('mdhd', 0, 0, u32(0), u32(0), u32(TS), u32(N * DELTA), u16(0x55c4), u16(0)),
      full('hdlr', 0, 0, u32(0), str('vide'), Buffer.alloc(12), str('VideoHandler\0')), minf);
    const tkhd = full('tkhd', 0, 3, u32(0), u32(0), u32(1), u32(0), u32(durMs), Buffer.alloc(8), u16(0), u16(0), u16(0), u16(0), MATRIX, u32(W << 16), u32(H << 16));
    const mvhd = full('mvhd', 0, 0, u32(0), u32(0), u32(1000), u32(durMs), u32(0x00010000), u16(0x0100), Buffer.alloc(10), MATRIX, Buffer.alloc(24), u32(2));
    return box('moov', mvhd, box('trak', tkhd, mdia));
  };
  const moovSize = build(0).length;
  const moov = build(ftyp.length + moovSize + 8);
  const mdat = box('mdat', ...samples.map((s) => s.data));
  return Buffer.concat([ftyp, moov, mdat]);
}

(async () => {
  const chromium = loadChromium();
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.route('http://localhost/gen', (r) => r.fulfill({ contentType: 'text/html', body: PAGE }));
  await page.goto('http://localhost/gen'); // localhost is a secure context, so WebCodecs is available
  const chunks = await page.evaluate(() => window.encode());
  await browser.close();
  const out = path.join(__dirname, '..', 'fixtures', 'sample-clip.mp4');
  const buf = mp4(chunks.map((c) => ({ key: c.key, data: Buffer.from(c.data) })));
  fs.writeFileSync(out, buf);
  console.log(`wrote ${out} (${buf.length} bytes, ${chunks.length} frames)`);
})().catch((e) => { console.error(e); process.exit(1); });
