/* Narsingh Stock Desk — the cloud service.
 *
 * Two jobs, and only these two:
 *
 *   1. Read the text off a tag photograph. PaddleOCR's PP-OCRv4 models — the
 *      same files the browser version ran — on ONNX Runtime's native engine.
 *      The service returns the lines of text; deciding which design code they
 *      name stays in the page, which has the workbook.
 *
 *   2. Keep the shop's files and history in Google Cloud Storage, so the page
 *      needs no Google sign-in: this service holds the storage permission, the
 *      page only ever talks to this service.
 *
 * Endpoints (all under /api):
 *   GET  ping                     what is running, and where things are kept
 *   POST read          image body  -> { lines, ms }
 *   POST read?id=ID               read a photograph already stored here
 *   GET  state / PUT state         the computed history, one JSON document
 *   GET  blob/ID / PUT blob/ID     tag photographs
 *   GET  raw/ID  / PUT raw/ID      workbooks exactly as uploaded
 *   POST wipe                      delete everything
 *   GET  selftest                  read a known tag; used after every deploy
 *   POST process      {ids}       read these photographs in the background
 *   POST task/read?id=ID          one background read (called by Cloud Tasks)
 *   GET  reads                    every reading done so far, for the page
 *   POST similar       image body  -> photographs that look most like it
 *   POST task/looks?id=ID         describe one stored photograph's look
 *   POST looks/backfill           queue every photograph not yet described
 *
 * Reading does not need anyone on the page. The page stores the photographs
 * and asks for them to be read; this service puts one Cloud Tasks task per
 * photograph on a queue, and Cloud Tasks calls back here for each, several at
 * once, retrying any that fail. Each result lands in reads/ID.json. The page,
 * whenever it is next opened, turns those lines into design codes (a moment's
 * work) and saves them in the history. The history itself is only ever
 * written by the page, so the two never overwrite each other.
 *
 * There is no sign-in: anyone who knows this service's address can read and
 * change what it keeps. Fine for a demo; ALLOWED_ORIGINS stops other websites
 * from using it from a browser, but not a determined person.
 *
 * Settings, as environment variables:
 *   BUCKET           Cloud Storage bucket. Unset: files go to ./data (testing).
 *   PREFIX           folder inside the bucket (default "stock/")
 *   ALLOWED_ORIGINS  comma-separated sites allowed to call this service
 *                    (default: the GitHub Pages site and localhost)
 *   PORT             set by Cloud Run
 *   TASKS_QUEUE      projects/P/locations/R/queues/Q for background reading.
 *                    Unset: photographs are read one by one inside this process
 *                    (fine on one machine; on Cloud Run, set it).
 */
import http from 'node:http';
import zlib from 'node:zlib';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { InferenceSession, Tensor } from 'onnxruntime-node';
import BaseOcr, { registerBackend, ImageRawBase, FileUtilsBase } from '@gutenye/ocr-common';
import { splitIntoLineImages } from '@gutenye/ocr-common/splitIntoLineImages';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MODELS = path.join(HERE, 'models');
const PORT = +(process.env.PORT || 8080);
const BUCKET = process.env.BUCKET || '';
const PREFIX = (process.env.PREFIX ?? 'stock/').replace(/^\/+/, '');
const ORIGINS = (process.env.ALLOWED_ORIGINS ||
  'https://prdurgam-edu.github.io,http://localhost:8080,http://127.0.0.1:8080,http://localhost:8787,http://127.0.0.1:8787')
  .split(',').map(s => s.trim()).filter(Boolean);
const MAX_BODY = 30 * 1024 * 1024;
const TASKS_QUEUE = process.env.TASKS_QUEUE || '';

/* ---------------- the reader ---------------- */

/* The page's version of this pipeline stretched each image to the size the
   detector wants; the stock Node version letterboxes it instead. This copy
   stretches, so the service reads tags the way the page was measured to. */
class ImageRaw extends ImageRawBase {
  #s;
  static async open(src) { return new ImageRaw(await raw(sharp(src).rotate().ensureAlpha(1))); }
  constructor(d) { super(d); this.#s = fromRaw(d); }
  async resize({ width, height }) {
    const w = width || Math.round((this.width / this.height) * height);
    const h = height || Math.round((this.height / this.width) * width);
    const r = await raw(this.#s.resize({ width: w, height: h, fit: 'fill', kernel: 'linear' }));
    this.data = r.data; this.width = r.width; this.height = r.height; this.#s = fromRaw(r);
    return this;
  }
  async write() {}
  async drawBox() { return this; }
}
async function raw(s) {
  const r = await s.raw().toBuffer({ resolveWithObject: true });
  return { data: r.data, width: r.info.width, height: r.info.height };
}
function fromRaw(d) { return sharp(d.data, { raw: { width: d.width, height: d.height, channels: 4 } }); }
class FileUtils extends FileUtilsBase {
  static async read(p) { return fsp.readFile(p, 'utf8'); }
}
registerBackend({ FileUtils, ImageRaw, InferenceSession, splitIntoLineImages });

let ocrPromise = null;
function engine() {
  if (!ocrPromise) {
    ocrPromise = BaseOcr.create({
      models: {
        detectionPath: path.join(MODELS, 'ch_PP-OCRv4_det_infer.onnx'),
        recognitionPath: path.join(MODELS, 'ch_PP-OCRv4_rec_infer.onnx'),
        dictionaryPath: path.join(MODELS, 'ppocr_keys_v1.txt')
      }
    }).catch(e => { ocrPromise = null; throw e; });
  }
  return ocrPromise;
}

// one photograph at a time: the work is all CPU, and two at once only makes
// each slower while doubling the memory
let queue = Promise.resolve();
function read(buffer) {
  const job = queue.then(async () => {
    const t = Date.now();
    const ocr = await engine();
    const img = await ImageRaw.open(buffer);
    const r = await ocr.detect({ data: img.data, width: img.width, height: img.height });
    const lines = (r && r.texts || []).map(x => typeof x === 'string' ? x : (x && x.text) || '').filter(Boolean);
    return { lines, ms: Date.now() - t };
  });
  queue = job.catch(() => {});
  return job;
}

/* ---------------- what a saree looks like ----------------
   For "Should I buy?": every stored photograph is described by 2,048 numbers
   from ResNet-50 (cut at its pooling layer, built by make_features.py)
   plus a 21-bin colour histogram. A new photograph is described the same way
   and compared with all of them. Kept small: the numbers are stored as one
   byte each, so a description fits in an object's metadata and one listing
   brings back all of them. */
const LOOKS_MODEL = path.join(MODELS, 'looks.onnx');
const MEAN = [0.485, 0.456, 0.406], STD = [0.229, 0.224, 0.225];
let looksPromise = null;
function looksModel() {
  if (!looksPromise) looksPromise = InferenceSession.create(LOOKS_MODEL).catch(e => { looksPromise = null; throw e; });
  return looksPromise;
}
async function describe(buffer) {
  // upright pixels first, so every later step sees the photograph as taken
  const up = await sharp(buffer).rotate().removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const img = () => sharp(up.data, { raw: { width: up.info.width, height: up.info.height, channels: up.info.channels } });
  const w0 = up.info.width, h0 = up.info.height;
  // the model's own view: shortest side to 256, the middle 224 x 224
  const k = 256 / Math.min(w0, h0), w = Math.max(224, Math.round(w0 * k)), h = Math.max(224, Math.round(h0 * k));
  const px = await img().resize(w, h, { fit: 'fill', kernel: 'linear' })
    .extract({ left: (w - 224) >> 1, top: (h - 224) >> 1, width: 224, height: 224 })
    .raw().toBuffer();
  const x = new Float32Array(3 * 224 * 224);
  for (let i = 0; i < 224 * 224; i++) {
    for (let c = 0; c < 3; c++) x[c * 224 * 224 + i] = (px[i * 3 + c] / 255 - MEAN[c]) / STD[c];
  }
  const sess = await looksModel();
  const out = await sess.run({ [sess.inputNames[0]]: new Tensor('float32', x, [1, 3, 224, 224]) });
  const v = out[sess.outputNames[0]].data;
  let n = 0; for (let i = 0; i < v.length; i++) n += v[i] * v[i];
  n = Math.sqrt(n) || 1;
  // one signed byte per number, scaled to the largest
  let m = 0; for (let i = 0; i < v.length; i++) m = Math.max(m, Math.abs(v[i] / n));
  const q = new Int8Array(v.length);
  for (let i = 0; i < v.length; i++) q[i] = Math.round((v[i] / n) / (m || 1) * 127);
  // colour: hue weighted by saturation in 18 bins, and white / grey / black
  const sm = await img().resize(96, 96, { fit: 'fill' }).raw().toBuffer();
  const hist = new Array(21).fill(0);
  for (let i = 0; i < sm.length; i += 3) {
    const r = sm[i] / 255, g = sm[i + 1] / 255, b = sm[i + 2] / 255;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn, sat = mx ? d / mx : 0;
    if (sat > 0.2) {
      let hue = d === 0 ? 0 : mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
      hue = ((hue * 60) + 360) % 360;
      hist[Math.floor(hue / 20) % 18] += sat;
    } else hist[18 + Math.min(2, Math.floor(mx * 3))] += 1;
  }
  const tot = hist.reduce((a, b) => a + b, 0) || 1;
  return { q: Buffer.from(q.buffer).toString('base64'), c: hist.map(h => Math.round(h / tot * 1000)) };
}
// back to a unit vector, for comparing
function unpack(d) {
  const b = Buffer.from(d.q, 'base64'), q = new Int8Array(b.buffer, b.byteOffset, b.length);
  const v = new Float32Array(q.length); let n = 0;
  for (let i = 0; i < q.length; i++) { v[i] = q[i]; n += q[i] * q[i]; }
  n = Math.sqrt(n) || 1; for (let i = 0; i < v.length; i++) v[i] /= n;
  return { v, c: d.c.map(x => x / 1000) };
}
function likeness(a, b) {
  let dot = 0; for (let i = 0; i < a.v.length; i++) dot += a.v[i] * b.v[i];
  let col = 0; for (let i = 0; i < a.c.length; i++) col += Math.min(a.c[i], b.c[i]);
  return 0.8 * dot + 0.2 * col;     // weighed on the shop's own photographs
}

/* ---------------- where things are kept ---------------- */

class DiskStore {
  constructor(dir) { this.dir = dir; this.label = 'disk ' + dir; }
  p(k) { return path.join(this.dir, k.replace(/\.\./g, '')); }
  async get(k) {
    try {
      const body = await fsp.readFile(this.p(k));
      let type = 'application/octet-stream';
      try { type = (await fsp.readFile(this.p(k) + '.type', 'utf8')) || type; } catch {}
      return { body, type };
    } catch { return null; }
  }
  async put(k, body, type, meta) {
    await fsp.mkdir(path.dirname(this.p(k)), { recursive: true });
    await fsp.writeFile(this.p(k), body);
    await fsp.writeFile(this.p(k) + '.type', type || 'application/octet-stream');
    if (meta) await fsp.writeFile(this.p(k) + '.meta', JSON.stringify(meta));
  }
  async exists(k) { try { await fsp.access(this.p(k)); return true; } catch { return false; } }
  async list(prefix) {
    let names = [];
    try { names = await fsp.readdir(this.p(prefix)); } catch { return []; }
    const out = [];
    for (const n of names) {
      if (/\.(type|meta)$/.test(n)) continue;
      let meta = {};
      try { meta = JSON.parse(await fsp.readFile(this.p(prefix + n) + '.meta', 'utf8')); } catch {}
      out.push({ name: prefix + n, meta });
    }
    return out;
  }
  async wipe() { await fsp.rm(this.dir, { recursive: true, force: true }); }
}

class GcsStore {
  constructor(bucket, prefix) {
    this.prefix = prefix; this.label = 'gs://' + bucket + '/' + prefix;
    this.ready = import('@google-cloud/storage').then(m => new m.Storage().bucket(bucket));
  }
  async get(k) {
    const b = await this.ready, f = b.file(this.prefix + k);
    try {
      const [body] = await f.download();
      const [meta] = await f.getMetadata();
      return { body, type: meta.contentType || 'application/octet-stream' };
    } catch (e) { if (e.code === 404) return null; throw e; }
  }
  async put(k, body, type, meta) {
    const b = await this.ready;
    const opts = { contentType: type || 'application/octet-stream', resumable: false };
    if (meta) opts.metadata = { metadata: meta };
    await b.file(this.prefix + k).save(body, opts);
  }
  async exists(k) { const b = await this.ready; const [e] = await b.file(this.prefix + k).exists(); return e; }
  // one listing brings every object's own metadata, which is where a reading's
  // lines are kept, so the page can have all of them without two thousand fetches
  async list(prefix) {
    const b = await this.ready;
    const [files] = await b.getFiles({ prefix: this.prefix + prefix, autoPaginate: true });
    return files.map(f => ({ name: f.name.slice(this.prefix.length), meta: (f.metadata && f.metadata.metadata) || {} }));
  }
  async wipe() { const b = await this.ready; await b.deleteFiles({ prefix: this.prefix, force: true }); }
}

const store = BUCKET ? new GcsStore(BUCKET, PREFIX) : new DiskStore(path.join(HERE, 'data'));

/* ---------------- background reading ---------------- */

const readKey = id => 'reads/' + id + '.json';

// one photograph: read it, keep the lines. Throws only for what is worth
// trying again (the reader itself failing); a photograph that is missing or
// is not an image is recorded as such and never retried.
async function readTask(id) {
  if (await store.exists(readKey(id))) return { already: true };
  const got = await store.get('photos/' + id);
  if (!got) return { missing: true };
  let rec;
  try {
    const r = await read(got.body);
    rec = { lines: r.lines, ms: r.ms, at: new Date().toISOString() };
  } catch (e) {
    if (!/unsupported image|Input buffer|corrupt|VipsJpeg|Invalid/i.test(String(e && e.message))) throw e;
    rec = { lines: [], at: new Date().toISOString(), error: 'This file could not be opened as a photograph.' };
  }
  const json = JSON.stringify(rec);
  // Cloud Storage keeps up to 8 KB of metadata with an object: the lines fit
  // there almost always, and then one listing returns every reading
  const meta = json.length < 7000 ? { r: json } : { big: '1' };
  await store.put(readKey(id), Buffer.from(json), 'application/json', meta);
  // and its look, for "Should I buy?"; a failure here never fails the read
  await looksTask(id).catch(e => console.error('looks', id, e.message));
  return { read: true, lines: rec.lines.length };
}

const looksKey = id => 'looks/' + id + '.json';
async function looksTask(id) {
  if (await store.exists(looksKey(id))) return { already: true };
  const got = await store.get('photos/' + id);
  if (!got) return { missing: true };
  let d;
  try { d = await describe(got.body); }
  catch (e) {
    if (!/unsupported image|Input buffer|corrupt|VipsJpeg|Invalid/i.test(String(e && e.message))) throw e;
    return { unreadable: true };
  }
  const json = JSON.stringify(d);
  await store.put(looksKey(id), Buffer.from(json), 'application/json', { l: json });
  looksCache = null;
  return { described: true };
}
// every description, kept in memory for a minute: comparing is then instant
let looksCache = null;
async function allLooks() {
  if (looksCache && Date.now() - looksCache.at < 60000) return looksCache.list;
  const list = [];
  for (const f of await store.list('looks/')) {
    const id = f.name.replace(/^looks\//, '').replace(/\.json$/, '');
    let d = null;
    try { d = JSON.parse(f.meta && f.meta.l ? f.meta.l : (await store.get(f.name)).body.toString('utf8')); } catch {}
    if (d) list.push({ id, ...unpack(d) });
  }
  looksCache = { at: Date.now(), list };
  return list;
}

let tokenCache = null;
async function token() {
  if (tokenCache && tokenCache.until > Date.now() + 60000) return tokenCache.value;
  const r = await fetch('http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token',
                        { headers: { 'Metadata-Flavor': 'Google' } });
  if (!r.ok) throw new Error('No service account token (' + r.status + ')');
  const j = await r.json();
  tokenCache = { value: j.access_token, until: Date.now() + j.expires_in * 1000 };
  return tokenCache.value;
}

// one task per photograph. The name keeps a photograph from being queued twice
// in the same hour if the page asks again.
async function enqueue(base, id, kind) {
  const hour = new Date().toISOString().slice(0, 13).replace(/\D/g, '');
  const what = kind === 'looks' ? 'looks' : 'read';
  const name = TASKS_QUEUE + '/tasks/' + (what === 'looks' ? 'l-' : 'r-') + id.replace(/[^A-Za-z0-9_-]/g, '_') + '-' + hour;
  const r = await fetch('https://cloudtasks.googleapis.com/v2/' + TASKS_QUEUE + '/tasks', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + await token(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ task: { name, dispatchDeadline: '300s', httpRequest: {
      httpMethod: 'POST', url: base + '/api/task/' + what + '?id=' + encodeURIComponent(id) } } })
  });
  if (r.status === 409) return 'already';
  if (!r.ok) throw new Error('Cloud Tasks said ' + r.status + ': ' + (await r.text()).slice(0, 200));
  return 'queued';
}

// without a queue (testing on one machine): the same work, in this process
const localQueue = []; let localBusy = false;
function localEnqueue(id, kind) {
  const job = (kind === 'looks' ? 'looks:' : '') + id;
  if (!localQueue.includes(job)) localQueue.push(job);
  if (localBusy) return;
  localBusy = true;
  (async () => {
    while (localQueue.length) {
      const next = localQueue.shift();
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          if (next.startsWith('looks:')) await looksTask(next.slice(6)); else await readTask(next);
          break;
        } catch (e) { console.error('task', next, e.message); }
      }
    }
    localBusy = false;
  })();
}

async function allReads() {
  const list = await store.list('reads/');
  const out = {};
  await Promise.all(list.map(async f => {
    const id = f.name.replace(/^reads\//, '').replace(/\.json$/, '');
    if (f.meta && f.meta.r) { try { out[id] = JSON.parse(f.meta.r); return; } catch {} }
    const got = await store.get(f.name);
    if (got) { try { out[id] = JSON.parse(got.body.toString('utf8')); } catch {} }
  }));
  return out;
}

/* ---------------- HTTP ---------------- */

function cors(req, res) {
  const o = req.headers.origin;
  // always, so a photograph cached by an <img> (no Origin) is not reused for a
  // fetch() that needs the CORS header
  res.setHeader('Vary', 'Origin');
  if (o && (ORIGINS.includes(o) || ORIGINS.includes('*'))) {
    res.setHeader('Access-Control-Allow-Origin', o);
    res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Content-Encoding');
    res.setHeader('Access-Control-Max-Age', '3600');
  }
}
function send(res, code, obj, type) {
  const body = Buffer.isBuffer(obj) ? obj : Buffer.from(typeof obj === 'string' ? obj : JSON.stringify(obj));
  res.writeHead(code, { 'Content-Type': type || 'application/json; charset=utf-8', 'Content-Length': body.length });
  res.end(body);
}
function body(req) {
  return new Promise((ok, bad) => {
    const parts = []; let n = 0;
    req.on('data', c => { n += c.length; if (n > MAX_BODY) { bad(Object.assign(new Error('too large'), { code: 413 })); req.destroy(); } else parts.push(c); });
    req.on('end', () => {
      const b = Buffer.concat(parts);
      // the page compresses the history before sending it
      if (/gzip/i.test(req.headers['content-encoding'] || '')) {
        zlib.gunzip(b, (e, out) => e ? bad(e) : ok(out));
      } else ok(b);
    });
    req.on('error', bad);
  });
}
function sendJsonGz(req, res, buf) {
  res.setHeader('Cache-Control', 'no-store');
  if (/gzip/i.test(req.headers['accept-encoding'] || '') && buf.length > 2048) {
    const z = zlib.gzipSync(buf);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Encoding': 'gzip', 'Content-Length': z.length });
    return res.end(z);
  }
  return send(res, 200, buf);
}
const ID = /^[A-Za-z0-9_.-]{1,120}$/;

const server = http.createServer(async (req, res) => {
  cors(req, res);
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  const url = new URL(req.url, 'http://x');
  const route = url.pathname.replace(/^\/api\/?/, '');
  try {
    if (route === 'ping') {
      return send(res, 200, { ok: true, engine: 'PaddleOCR PP-OCRv4, reading in Google Cloud',
        storage: BUCKET ? 'Google Cloud Storage' : 'local disk', warm: !!ocrPromise });
    }

    if (route === 'read' && req.method === 'POST') {
      let buf;
      const id = url.searchParams.get('id');
      if (id) {
        if (!ID.test(id)) return send(res, 400, { error: 'bad id' });
        const got = await store.get('photos/' + id);
        if (!got) return send(res, 404, { error: 'no such photograph' });
        buf = got.body;
      } else {
        buf = await body(req);
      }
      if (!buf.length) return send(res, 400, { error: 'no image' });
      return send(res, 200, await read(buf));
    }

    if (route === 'state') {
      if (req.method === 'GET') {
        const got = await store.get('state.json');
        return sendJsonGz(req, res, got ? got.body : Buffer.from('null'));
      }
      if (req.method === 'PUT') {
        const b = await body(req);
        JSON.parse(b.toString('utf8'));                 // refuse anything that is not JSON
        await store.put('state.json', b, 'application/json');
        return send(res, 200, { ok: true });
      }
    }

    const m = route.match(/^(blob|raw)\/(.+)$/);
    if (m) {
      const id = decodeURIComponent(m[2]);
      if (!ID.test(id)) return send(res, 400, { error: 'bad id' });
      const k = (m[1] === 'blob' ? 'photos/' : 'raw/') + id;
      if (req.method === 'GET') {
        const got = await store.get(k);
        if (!got) return send(res, 404, { error: 'not found' });
        // ids are never reused, so a browser may keep a photograph for good
        res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
        return send(res, 200, got.body, got.type);
      }
      if (req.method === 'PUT') {
        const b = await body(req);
        await store.put(k, b, req.headers['content-type'] || 'application/octet-stream');
        return send(res, 200, { ok: true });
      }
    }

    if (route === 'process' && req.method === 'POST') {
      const j = JSON.parse((await body(req)).toString('utf8') || '{}');
      const ids = (Array.isArray(j.ids) ? j.ids : []).filter(id => typeof id === 'string' && ID.test(id));
      const done = new Set(Object.keys(await allReads()));
      const todo = ids.filter(id => !done.has(id));
      let queued = 0, failed = 0;
      if (TASKS_QUEUE) {
        const base = process.env.SELF_URL || ('https://' + req.headers.host);
        for (let i = 0; i < todo.length; i += 60) {
          const res = await Promise.allSettled(todo.slice(i, i + 60).map(id => enqueue(base, id)));
          res.forEach(r => { if (r.status === 'fulfilled') queued++; else { failed++; console.error(r.reason); } });
        }
      } else {
        todo.forEach(localEnqueue); queued = todo.length;
      }
      return send(res, failed && !queued ? 502 : 200,
        { asked: ids.length, alreadyRead: ids.length - todo.length, queued, failed, background: TASKS_QUEUE ? 'cloud tasks' : 'in process' });
    }

    if (route === 'task/read' && req.method === 'POST') {
      const id = url.searchParams.get('id') || '';
      if (!ID.test(id)) return send(res, 200, { skipped: 'bad id' });   // 200: nothing to retry
      return send(res, 200, await readTask(id));
    }

    if (route === 'task/looks' && req.method === 'POST') {
      const id = url.searchParams.get('id') || '';
      if (!ID.test(id)) return send(res, 200, { skipped: 'bad id' });
      return send(res, 200, await looksTask(id));
    }

    // every stored photograph without a description gets one, in the background
    if (route === 'looks/backfill' && req.method === 'POST') {
      const photos = (await store.list('photos/')).map(f => f.name.replace(/^photos\//, '')).filter(id => ID.test(id));
      const have = new Set((await store.list('looks/')).map(f => f.name.replace(/^looks\//, '').replace(/\.json$/, '')));
      const todo = photos.filter(id => !have.has(id));
      let queued = 0, failed = 0;
      if (TASKS_QUEUE) {
        const base = process.env.SELF_URL || ('https://' + req.headers.host);
        for (let i = 0; i < todo.length; i += 60) {
          const r = await Promise.allSettled(todo.slice(i, i + 60).map(id => enqueue(base, id, 'looks')));
          r.forEach(x => { if (x.status === 'fulfilled') queued++; else { failed++; console.error(x.reason); } });
        }
      } else { todo.forEach(id => localEnqueue(id, 'looks')); queued = todo.length; }
      return send(res, 200, { photos: photos.length, described: have.size, queued, failed });
    }

    // a photograph taken at the market: which stored ones look most like it?
    // It is compared, never stored.
    if (route === 'similar' && req.method === 'POST') {
      const buf = await body(req);
      if (!buf.length) return send(res, 400, { error: 'no image' });
      const t = Date.now();
      const q = unpack(await describe(buf));
      const all = await allLooks();
      const scored = all.map(d => ({ id: d.id, score: Math.round(likeness(q, d) * 1000) / 1000 }))
        .sort((a, b) => b.score - a.score).slice(0, 80);
      return send(res, 200, { matches: scored, compared: all.length, ms: Date.now() - t });
    }

    if (route === 'reads' && req.method === 'GET') {
      const all = await allReads(), since = url.searchParams.get('since') || '';
      // only what is newer than the page already has
      const reads = {};
      Object.keys(all).forEach(id => { if (!since || (all[id].at || '') >= since) reads[id] = all[id]; });
      return sendJsonGz(req, res, Buffer.from(JSON.stringify({ reads, count: Object.keys(all).length,
        waitingLocally: localQueue.length })));
    }

    if (route === 'wipe' && req.method === 'POST') {
      await store.wipe();
      return send(res, 200, { ok: true });
    }

    if (route === 'selftest') {
      const buf = await fsp.readFile(path.join(HERE, 'selftest.jpg'));
      const r = await read(buf);
      // a made-up tag, so no shop photograph has to ship with the service
      const pass = r.lines.some(l => l.replace(/[^A-Z0-9]/gi, '').toUpperCase() === 'SELFTEST2026');
      return send(res, pass ? 200 : 500, { pass, expected: 'SELFTEST2026', ...r });
    }

    return send(res, 404, { error: 'unknown endpoint' });
  } catch (e) {
    console.error(e);
    return send(res, e.code === 413 ? 413 : 500, { error: e.message || String(e) });
  }
});

server.listen(PORT, () => {
  console.log(`stock-desk-api on :${PORT}, files in ${store.label}`);
  engine().then(() => console.log('reader ready')).catch(e => console.error('reader failed', e));
});
