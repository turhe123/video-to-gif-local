// app.js — Video to GIF Converter. Everything runs on this device: the browser decodes the video,
// frames are captured by seeking a <video> and drawing it on a canvas, and gif.js (vendored) encodes
// them in Web Workers. No network requests; fixtures are only loaded by window.__demo.
import { toast, downloadBlob, formatBytes, wireDropzone } from './site.js';

const $ = (id) => document.getElementById(id);
const zone = $('dropzone');
const input = $('file-input');
const results = $('results');
const editor = $('editor');
const preview = $('preview');
const fileInfo = $('file-info');
const startRange = $('start-range');
const endRange = $('end-range');
const startInput = $('start');
const endInput = $('end');
const trimFill = $('trim-fill');
const clipLength = $('clip-length');
const lengthWarning = $('length-warning');
const lengthWarningText = $('length-warning-text');
const allowLong = $('allow-long');
const widthSel = $('width');
const fpsSel = $('fps');
const qualitySel = $('quality');
const loopSel = $('loop');
const estimateEl = $('estimate');
const makeBtn = $('make');
const cancelBtn = $('cancel');
const progressWrap = $('progress-wrap');
const progressEl = $('progress');
const progressBar = $('progress-bar');
const progressText = $('progress-text');
const emptyState = $('empty-state');

const MAX_SECONDS = 20; // default hard cap; longer needs explicit confirmation
const MAX_OUTPUT_WIDTH = 800;
const MAX_PIXELS = 300 * 800 * 450; // ~300 frames at 800 px wide (16:9); beyond this memory gets risky
const VIDEO_EXT = /\.(mp4|m4v|webm|mov|mkv|ogv|ogg|avi|3gp)$/i;
const CODEC_HINT = 'Your browser could not decode this video. Try an MP4 with H.264 video, which plays in every browser.';

const state = {
  file: null,
  url: '',
  baseName: 'video',
  duration: 0,
  vw: 0,
  vh: 0,
  busy: false,
  cancel: null,
  resultUrl: '',
};

// ---------- small helpers ----------
const round1 = (n) => Math.round(n * 10) / 10;
const fmtTime = (s) => `${round1(s).toFixed(1)} s`;
const isVideoFile = (f) => f.type.startsWith('video/') || ((!f.type || f.type === 'application/octet-stream') && VIDEO_EXT.test(f.name));

function once(target, okEvents, failEvents = ['error'], timeoutMs = 0) {
  return new Promise((resolve, reject) => {
    let timer;
    const done = (fn, arg) => { clearTimeout(timer); okEvents.concat(failEvents).forEach((e) => target.removeEventListener(e, handlers[e])); fn(arg); };
    const handlers = {};
    okEvents.forEach((e) => { handlers[e] = (ev) => done(resolve, ev); });
    failEvents.forEach((e) => { handlers[e] = (ev) => done(reject, ev); });
    Object.entries(handlers).forEach(([e, h]) => target.addEventListener(e, h));
    if (timeoutMs) timer = setTimeout(() => done(reject, new Error('timeout')), timeoutMs);
  });
}

function showError(message) {
  results.querySelectorAll('.alert--error').forEach((a) => a.remove());
  const el = document.createElement('div');
  el.className = 'alert alert--error';
  el.setAttribute('role', 'alert');
  el.textContent = message;
  results.prepend(el);
  el.scrollIntoView({ block: 'nearest' });
}

function clearErrors() { results.querySelectorAll('.alert--error').forEach((a) => a.remove()); }

// ---------- loading a video ----------
async function handleFiles(files) {
  if (state.busy) { toast('A GIF is being made. Cancel it first to load another video.'); return; }
  clearErrors();
  const videos = files.filter(isVideoFile);
  const rejected = files.filter((f) => !isVideoFile(f));
  if (rejected.length) {
    const names = rejected.map((f) => f.name).join(', ');
    showError(`${names} ${rejected.length > 1 ? 'are not videos' : 'is not a video'}. Choose an MP4, WebM or MOV file.`);
  }
  if (!videos.length) return;
  if (videos.length > 1) toast(`One video at a time: using ${videos[0].name}`);
  await loadVideo(videos[0]);
}

async function loadVideo(file) {
  if (state.url) URL.revokeObjectURL(state.url);
  state.file = file;
  state.baseName = file.name.replace(/\.[^.]+$/, '') || 'video';
  state.url = URL.createObjectURL(file);
  editor.hidden = true;
  progressWrap.hidden = true;
  results.querySelectorAll('.gif-result').forEach((n) => n.remove());
  preview.pause();
  preview.src = state.url;
  preview.load(); // called inside the user's tap/drop so mobile Safari agrees to fetch data
  try {
    await once(preview, ['loadedmetadata'], ['error'], 20000);
    if (!preview.videoWidth || !preview.videoHeight) throw new Error('novideo');
    let duration = preview.duration;
    if (!Number.isFinite(duration)) {
      // Some recorded WebM files have no duration in the header: seek far to make the browser find it.
      preview.currentTime = 1e9;
      await once(preview, ['durationchange', 'seeked'], ['error'], 10000).catch(() => {});
      duration = preview.duration;
      preview.currentTime = 0;
    }
    if (!Number.isFinite(duration) || duration <= 0) throw new Error('noduration');
    if (preview.readyState < 2) await once(preview, ['loadeddata', 'canplay'], ['error'], 15000).catch(() => {});
    state.duration = duration;
    state.vw = preview.videoWidth;
    state.vh = preview.videoHeight;
  } catch (err) {
    preview.removeAttribute('src');
    preview.load();
    state.file = null;
    const novideo = err instanceof Error && err.message === 'novideo';
    showError(novideo
      ? `${file.name} has no video track (it may be audio only), so there is nothing to turn into a GIF.`
      : `${file.name} could not be opened. ${CODEC_HINT}`);
    return;
  }
  setupTrim();
  editor.hidden = false;
  emptyState.hidden = true;
  fileInfo.textContent = `${file.name} · ${formatBytes(file.size)} · ${state.vw}×${state.vh} · ${fmtTime(state.duration)} · the GIF will be silent`;
  updateEstimate();
  toast('Video loaded on this device, nothing was uploaded');
}

// ---------- start / end selection ----------
function setupTrim() {
  const d = round1Down(state.duration);
  for (const r of [startRange, endRange]) { r.max = String(d); r.step = d > 60 ? '0.1' : '0.05'; }
  startInput.max = endInput.max = String(d);
  setRange(0, Math.min(d, MAX_SECONDS));
}

function round1Down(n) { return Math.floor(n * 100) / 100; }

function getRange() { return [Number(startInput.value) || 0, Number(endInput.value) || 0]; }

function setRange(start, end, moved = null) {
  const d = round1Down(state.duration);
  start = Math.min(Math.max(0, start), d);
  end = Math.min(Math.max(0, end), d);
  const minLen = Math.min(0.1, d);
  if (end - start < minLen) {
    if (moved === 'end') start = Math.max(0, end - minLen);
    else end = Math.min(d, start + minLen);
    if (end - start < minLen) start = Math.max(0, end - minLen);
  }
  start = Math.round(start * 100) / 100;
  end = Math.round(end * 100) / 100;
  startRange.value = startInput.value = String(start);
  endRange.value = endInput.value = String(end);
  startRange.setAttribute('aria-valuetext', fmtTime(start));
  endRange.setAttribute('aria-valuetext', fmtTime(end));
  const pct = (v) => (d > 0 ? (v / d) * 100 : 0);
  trimFill.style.left = `${pct(start)}%`;
  trimFill.style.width = `${pct(end) - pct(start)}%`;
  const len = end - start;
  clipLength.textContent = `Clip length: ${fmtTime(len)}`;
  const tooLong = len > MAX_SECONDS + 1e-6;
  lengthWarning.hidden = !tooLong;
  if (tooLong) lengthWarningText.textContent = `This part is ${fmtTime(len)} long. GIFs over ${MAX_SECONDS} seconds get very large and slow to make; a shorter clip is usually better.`;
  else allowLong.checked = false;
  updateEstimate();
}

startRange.addEventListener('input', () => { setRange(Number(startRange.value), Number(endRange.value), 'start'); seekPreview(Number(startInput.value)); });
endRange.addEventListener('input', () => { setRange(Number(startRange.value), Number(endRange.value), 'end'); seekPreview(Number(endInput.value)); });
startInput.addEventListener('change', () => { setRange(Number(startInput.value), Number(endInput.value), 'start'); seekPreview(Number(startInput.value)); });
endInput.addEventListener('change', () => { setRange(Number(startInput.value), Number(endInput.value), 'end'); seekPreview(Number(endInput.value)); });
allowLong.addEventListener('change', updateEstimate);

// Keep the thumb that is on top the one nearest the pointer, so both handles stay reachable when they meet.
$('trim-track').addEventListener('pointerdown', (e) => {
  const rect = e.currentTarget.getBoundingClientRect();
  const t = ((e.clientX - rect.left) / rect.width) * Number(endRange.max);
  const [s, en] = getRange();
  const nearEnd = Math.abs(t - en) < Math.abs(t - s) || (s === en && t > s);
  endRange.style.zIndex = nearEnd ? '3' : '2';
  startRange.style.zIndex = nearEnd ? '2' : '3';
});

function seekPreview(t) {
  if (!state.file || state.busy) return;
  if (!preview.paused) return;
  preview.currentTime = t;
}

// The preview loops inside the chosen part so you can see what the GIF will show.
preview.addEventListener('timeupdate', () => {
  if (state.busy || preview.paused) return;
  const [s, e] = getRange();
  if (preview.currentTime >= e || preview.currentTime < s - 0.25) preview.currentTime = s;
});
preview.addEventListener('play', () => {
  const [s, e] = getRange();
  if (preview.currentTime >= e - 0.05 || preview.currentTime < s) preview.currentTime = s;
});

// ---------- options and estimate ----------
function outputSize() {
  const choice = widthSel.value;
  const target = choice === 'original' ? MAX_OUTPUT_WIDTH : Number(choice);
  const w = Math.max(2, Math.min(target, state.vw, MAX_OUTPUT_WIDTH)); // never upscale, never above 800
  const h = Math.max(2, Math.round((w * state.vh) / state.vw));
  return { w: Math.round(w), h };
}

function frameTimes() {
  const [s, e] = getRange();
  const fps = Number(fpsSel.value);
  const n = Math.max(1, Math.round((e - s) * fps));
  const last = Math.max(0, state.duration - 0.001);
  return Array.from({ length: n }, (_, i) => Math.min(s + i / fps, last));
}

// Rough model: LZW-compressed 8-bit pixels of camera footage take ~0.1–0.2 byte each (flat graphics less). Higher colour quality
// adds a little. It is an estimate; the real size is shown after encoding.
function estimateBytes(frames, w, h) {
  const q = Number(qualitySel.value);
  const perPixel = q <= 3 ? 0.17 : q <= 10 ? 0.15 : 0.13;
  return Math.round(frames * w * h * perPixel + 800 + frames * 20);
}

function check() {
  const { w, h } = outputSize();
  const frames = frameTimes().length;
  const [s, e] = getRange();
  const bytes = estimateBytes(frames, w, h);
  let problem = '';
  if (frames * w * h > MAX_PIXELS) problem = `That is ${frames} frames at ${w}×${h}, more than this page can safely hold in memory (about 300 frames at 800 px). Pick a shorter part, a smaller width or a lower frame rate.`;
  else if (e - s > MAX_SECONDS + 1e-6 && !allowLong.checked) problem = `Clips are limited to ${MAX_SECONDS} seconds by default. Shorten the part, or tick "Make it anyway".`;
  return { w, h, frames, bytes, problem };
}

function updateEstimate() {
  if (!state.file) return;
  const { w, h, frames, bytes, problem } = check();
  estimateEl.dataset.bytes = String(bytes);
  estimateEl.dataset.frames = String(frames);
  estimateEl.replaceChildren();
  const main = document.createElement('span');
  main.innerHTML = 'Estimated GIF: <strong class="stat"></strong> · <span class="stat"></span> frames · <span class="stat"></span>';
  const [a, b, c] = main.querySelectorAll('.stat');
  a.textContent = `about ${formatBytes(bytes)}`;
  b.textContent = String(frames);
  c.textContent = `${w}×${h}`;
  estimateEl.append(main);
  if (problem) {
    const p = document.createElement('span');
    p.className = 'estimate__problem stat--danger';
    p.textContent = problem;
    estimateEl.append(p);
  } else if (bytes > 8 * 1024 * 1024) {
    const p = document.createElement('span');
    p.className = 'estimate__problem stat--warn';
    p.textContent = 'That is a big GIF. Many sites cap uploads at 8 to 15 MB, and a WebM or MP4 of the same clip would be far smaller.';
    estimateEl.append(p);
  }
  makeBtn.disabled = state.busy;
}

[widthSel, fpsSel, qualitySel, loopSel].forEach((el) => el.addEventListener('change', updateEstimate));

// ---------- making the GIF ----------
function setProgress(fraction, text) {
  const pct = Math.floor(Math.max(0, Math.min(1, fraction)) * 1000) / 10; // floor: 99.95% never shows as 100%
  progressBar.style.width = `${pct}%`;
  progressEl.setAttribute('aria-valuenow', String(pct));
  progressText.textContent = text;
}

async function makeGif() {
  if (state.busy) return null;
  clearErrors();
  if (!state.file) { showError('Choose a video first.'); return null; }
  if (typeof window.GIF !== 'function') { showError('The GIF encoder did not load. Reload the page and try again.'); return null; }
  const { w, h, frames, problem } = check();
  if (problem) { showError(problem); return null; }

  const times = frameTimes();
  const fps = Number(fpsSel.value);
  state.busy = true;
  makeBtn.disabled = true;
  cancelBtn.hidden = false;
  progressWrap.hidden = false;
  preview.pause();
  setProgress(0, `Capturing frame 0 of ${frames}`);

  // A separate, muted, inline video element is used for capturing so the preview stays untouched.
  const grab = document.createElement('video');
  grab.muted = true;
  grab.playsInline = true;
  grab.preload = 'auto';
  grab.src = state.url;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'high';

  const gif = new window.GIF({
    workers: Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 1)),
    workerScript: './vendor/gif.js/gif.worker.js',
    quality: Number(qualitySel.value),
    width: w,
    height: h,
    repeat: Number(loopSel.value),
    background: '#000000',
  });
  let cancelled = false;
  let ok = false;
  state.cancel = () => { cancelled = true; try { gif.abort(); } catch { /* not started */ } };

  try {
    grab.load();
    await once(grab, ['loadeddata'], ['error'], 20000);
    const delay = Math.round(1000 / fps);
    for (let i = 0; i < times.length; i++) {
      if (cancelled) throw new Error('cancelled');
      if (Math.abs(grab.currentTime - times[i]) > 1e-4 || i === 0) {
        const seeked = once(grab, ['seeked'], ['error'], 15000);
        grab.currentTime = times[i];
        await seeked;
      }
      // Drawing at the target size downscales big (e.g. 4K) frames right away; nothing is kept at full size.
      ctx.drawImage(grab, 0, 0, w, h);
      gif.addFrame(ctx.getImageData(0, 0, w, h), { delay });
      setProgress(((i + 1) / frames) * 0.5, `Capturing frame ${i + 1} of ${frames}`);
    }
    grab.removeAttribute('src');
    grab.load();
    setProgress(0.5, `Encoding colours: 0 of ${frames} frames`);
    const blob = await new Promise((resolve, reject) => {
      gif.on('progress', (p) => setProgress(0.5 + p * 0.5, `Encoding colours: ${Math.min(frames, Math.floor(p * frames))} of ${frames} frames`));
      gif.on('finished', resolve);
      gif.on('abort', () => reject(new Error('cancelled')));
      gif.render();
    });
    if (cancelled) throw new Error('cancelled');
    setProgress(1, `Done: ${frames} of ${frames} frames`);
    showResult(blob, { w, h, frames, fps });
    ok = true;
    return blob;
  } catch (err) {
    if (cancelled || (err instanceof Error && err.message === 'cancelled')) {
      toast('Cancelled');
    } else {
      console.warn('GIF conversion failed', err);
      showError(`The GIF could not be made. ${err instanceof Error && err.message === 'timeout' ? 'The video stopped responding while seeking. ' : ''}${CODEC_HINT}`);
    }
    return null;
  } finally {
    state.busy = false;
    state.cancel = null;
    makeBtn.disabled = false;
    cancelBtn.hidden = true;
    if (!ok) progressWrap.hidden = true;
    updateEstimate();
  }
}

function showResult(blob, { w, h, frames, fps }) {
  if (state.resultUrl) URL.revokeObjectURL(state.resultUrl);
  state.resultUrl = URL.createObjectURL(blob);
  const name = `${state.baseName}.gif`;
  const estimate = Number(estimateEl.dataset.bytes) || 0;
  results.querySelectorAll('.gif-result').forEach((n) => n.remove());

  const card = document.createElement('article');
  card.className = 'result gif-result';
  card.innerHTML = `
    <div class="preview gif-result__preview"><img alt="" id="result-img"></div>
    <div class="result__meta">
      <div class="result__name"></div>
      <dl class="gif-stats">
        <div><dt>Frames</dt><dd class="stat" id="result-frames"></dd></div>
        <div><dt>Dimensions</dt><dd class="stat" id="result-dims"></dd></div>
        <div><dt>File size</dt><dd class="stat" id="result-size"></dd></div>
        <div><dt>Length</dt><dd class="stat" id="result-length"></dd></div>
      </dl>
      <p class="result__info" id="result-note"></p>
    </div>
    <div class="gif-result__actions"><button class="btn btn--primary" id="download" type="button"></button></div>`;
  const img = card.querySelector('#result-img');
  img.src = state.resultUrl;
  img.alt = `Animated GIF made from ${state.file.name}`;
  img.width = w;
  img.height = h;
  card.querySelector('.result__name').textContent = name;
  card.querySelector('#result-frames').textContent = `${frames} at ${fps} fps`;
  card.querySelector('#result-dims').textContent = `${w}×${h} px`;
  card.querySelector('#result-size').textContent = formatBytes(blob.size);
  card.querySelector('#result-size').dataset.bytes = String(blob.size);
  card.querySelector('#result-length').textContent = `${fmtTime(frames / fps)}, ${loopSel.value === '0' ? 'loops forever' : 'plays once'}`;
  card.querySelector('#result-note').textContent = `${estimate ? `Estimated ${formatBytes(estimate)}, real ${formatBytes(blob.size)}. ` : ''}No sound: GIF has no audio. For smaller files with sound, WebM or MP4 is the better format where it is accepted.`;
  const dl = card.querySelector('#download');
  dl.textContent = `Download ${name}`;
  dl.addEventListener('click', () => downloadBlob(blob, name));
  results.append(card);
  card.scrollIntoView({ block: 'nearest' });
  toast(`GIF ready: ${formatBytes(blob.size)}`);
}

makeBtn.addEventListener('click', () => { makeGif(); });
cancelBtn.addEventListener('click', () => { if (state.cancel) state.cancel(); });

// ---------- keyboard: Space plays/pauses the preview, Enter makes the GIF ----------
document.addEventListener('keydown', (e) => {
  if (editor.hidden || e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
  const el = document.activeElement;
  const tag = el ? el.tagName : '';
  const interactive = ['BUTTON', 'A', 'SELECT', 'TEXTAREA', 'SUMMARY', 'VIDEO'].includes(tag) || (el && el.getAttribute('role') === 'button');
  const typing = tag === 'INPUT' && !['range', 'checkbox'].includes(el.type);
  if (e.key === ' ' && !interactive && !typing && !(tag === 'INPUT' && el.type === 'checkbox')) {
    e.preventDefault();
    if (preview.paused) preview.play().catch(() => {}); else preview.pause();
  } else if (e.key === 'Enter' && !interactive && !(tag === 'INPUT' && el.type === 'checkbox')) {
    e.preventDefault();
    if (typing) el.dispatchEvent(new Event('change'));
    makeGif();
  }
});

wireDropzone(zone, input, handleFiles);

// Called by the factory's screenshot script: loads the bundled fictional clip and shows a finished GIF.
window.__demo = async () => {
  const res = await fetch('./tests/fixtures/sample-clip.mp4');
  const blob = await res.blob();
  await handleFiles([new File([blob], 'sample-clip.mp4', { type: 'video/mp4' })]);
  widthSel.value = '320';
  updateEstimate();
  await makeGif();
};

export { handleFiles, makeGif };
