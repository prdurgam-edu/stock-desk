/* matcher.js — reads the design code off a tag photograph.
 *
 * Everything happens in this browser. PaddleOCR's PP-OCRv4 detection and
 * recognition models run on onnxruntime-web (WebAssembly), and the text they
 * return is matched against the design codes in your own workbook. There is no
 * server, no API key, no Gemini, and nothing leaves the machine.
 *
 * Assets, all served from your own host:
 *   ocr/ocr.bundle.js                   PP-OCR + onnxruntime-web, one file
 *   ocr/ort/ort-wasm-simd-threaded.wasm the WebAssembly runtime
 *   ocr/models/ch_PP-OCRv4_det_infer.onnx   finds the lines of text
 *   ocr/models/ch_PP-OCRv4_rec_infer.onnx   reads each line
 *   ocr/models/ppocr_keys_v1.txt            the character set
 *
 * About 21 MB gzipped, fetched once on the first photograph and then cached by
 * the browser. Single-threaded on purpose: no SharedArrayBuffer, so no
 * COOP/COEP headers are needed and any static host will do.
 *
 * The public surface is unchanged from the version that called a server, so
 * app.js does not care which one is in place.
 */
(function (global) {
  'use strict';

  var CFG = (global.NARSINGH_CONFIG || {}).ocr || {};
  var BASE = (CFG.path || 'ocr/').replace(/\/*$/, '/');
  var COLUMN = ((global.NARSINGH_CONFIG || {}).tagMatcher || {}).column || 'C. REF';
  var ENGINE = 'PaddleOCR PP-OCRv4, reading in this browser';
  // with the shop's cloud service configured, tags are read there instead:
  // the same models, natively, about three times faster, and nothing for the
  // shop computer to download. The in-browser reader stays as the fallback.
  var API = String((global.NARSINGH_CONFIG || {}).api || '').replace(/\/+$/, '');
  var CLOUD = 'PaddleOCR PP-OCRv4, reading in Google Cloud';
  var cloudDown = false;     // after a network failure, read locally for the rest of the batch

  var STATUS = { MATCH: 'match', CHECK: 'check', AMBIGUOUS: 'ambiguous', NOMATCH: 'nomatch', ERROR: 'error' };

  function norm(s) { return String(s == null ? '' : s).toUpperCase().replace(/[^A-Z0-9]/g, ''); }

  /* ---------------------------------------------------------------
     the reader
     --------------------------------------------------------------- */
  var enginePromise = null, engineErr = null, onLoad = null;

  function script(src) {
    return new Promise(function (ok, bad) {
      var s = document.createElement('script');
      s.src = src; s.async = true;
      s.onload = function () { ok(); };
      s.onerror = function () { bad(new Error('could not load ' + src)); };
      document.head.appendChild(s);
    });
  }

  /* Three of the reader's files are bigger than some ways of uploading a
     site allow (GitHub's web upload through a browser takes 10 MB at a time),
     so each is kept in two halves and joined here, in memory. The bytes the
     reader runs are exactly the same either way. */
  var SPLIT = {
    'ocr.bundle.js': 2,
    'ort/ort-wasm-simd-threaded.wasm': 2,
    'models/ch_PP-OCRv4_rec_infer.onnx': 2
  };
  function fetchBytes(rel) {
    function one(url) {
      return fetch(url).then(function (r) {
        if (!r.ok) throw new Error('could not load ' + url);
        return r.arrayBuffer();
      });
    }
    var n = SPLIT[rel], parts = [];
    if (!n) return one(BASE + rel).then(function (b) { return new Uint8Array(b); });
    for (var i = 1; i <= n; i++) parts.push(one(BASE + rel + '.part' + i));
    return Promise.all(parts).then(function (bufs) {
      var size = 0, at = 0;
      bufs.forEach(function (b) { size += b.byteLength; });
      var out = new Uint8Array(size);
      bufs.forEach(function (b) { out.set(new Uint8Array(b), at); at += b.byteLength; });
      return out;
    });
  }

  function loadEngine() {
    if (enginePromise) return enginePromise;
    if (onLoad) onLoad('Loading the tag reader, about 21 MB. This happens once.');
    var ort;
    enginePromise = fetchBytes('ocr.bundle.js').then(function (bytes) {
      var url = URL.createObjectURL(new Blob([bytes], { type: 'text/javascript' }));
      return script(url).then(function () { URL.revokeObjectURL(url); });
    }).then(function () {
      ort = global.ort;
      if (!ort || !global.GutenOcr) throw new Error('the tag reader did not start');
      // the bundle cannot work out its own URL, so it is told where the
      // runtime's loader sits; one thread keeps us off SharedArrayBuffer
      ort.env.wasm.wasmPaths = new URL(BASE + 'ort/', location.href).href;
      ort.env.wasm.numThreads = 1;
      ort.env.wasm.proxy = false;
      ort.env.logLevel = 'error';
      return Promise.all([fetchBytes('ort/ort-wasm-simd-threaded.wasm'),
                          fetchBytes('models/ch_PP-OCRv4_rec_infer.onnx')]);
    }).then(function (got) {
      ort.env.wasm.wasmBinary = got[0];          // the runtime, joined from its halves
      if (onLoad) onLoad('Starting the tag reader...');
      return global.GutenOcr.create({
        models: {
          detectionPath:   BASE + 'models/ch_PP-OCRv4_det_infer.onnx',
          recognitionPath: got[1],                // the recognition model, likewise
          dictionaryPath:  BASE + 'models/ppocr_keys_v1.txt'
        }
      });
    }).catch(function (e) {
      enginePromise = null; engineErr = e; throw e;
    });
    return enginePromise;
  }

  /* one photograph in, the lines of text out */
  function readTag(blob) {
    return loadEngine().then(function (ocr) {
      var url = URL.createObjectURL(blob);
      return Promise.resolve()
        .then(function () { return ocr.detect(url); })
        .then(function (r) {
          URL.revokeObjectURL(url);
          return (r && r.texts || []).map(function (t) {
            return typeof t === 'string' ? t : (t && t.text) || '';
          }).filter(Boolean);
        }, function (e) { URL.revokeObjectURL(url); throw e; });
    });
  }

  /* ---------------------------------------------------------------
     what the tag says -> which design code it is
     --------------------------------------------------------------- */

  /* Characters PP-OCR trades for one another on a printed tag. Folding both
     the reading and the workbook through this table turns RFDAS23K0TACHE into
     the one design code it can be, without inventing codes: a folded form is
     only accepted when exactly one real code folds to it. */
  var FOLD = { O: '0', Q: '0', D: 'D', I: '1', L: '1', S: '5', B: '8', Z: '2', G: '6' };
  function fold(s) {
    var out = '';
    for (var i = 0; i < s.length; i++) { var c = s.charAt(i); out += (FOLD[c] || c); }
    return out;
  }

  var NOISE = /^(NARSINGH|NARSINA|NARSING|NARSINH|DUPATTA|DUPPATA|SAREE|SARI|SINCE|SINCE1964|1964|MRP|PCS|MTRS|MTR|CM|INDIA|HYDERABAD)$/;

  function looksLikeNoise(t) {
    if (t.length < 3) return true;
    if (NOISE.test(t)) return true;
    if (/^MRP/.test(t)) return true;
    if (/^[LI]?NCLUSIVE/.test(t)) return true;         // "(Inclusive of all taxes)"
    if (/^\d{9,}$/.test(t)) return true;               // the barcode number
    if (/^\d{1,8}$/.test(t)) return true;              // item code, metres, price
    return false;
  }

  /* A couple of design codes in the workbook are two or three characters long
     ("19"). Left alone, the 19 in SINCE 1964 scores a perfect match and ties
     with the real fourteen-character reading, and nothing gets tagged. A short
     reading is therefore never allowed to win outright: it can suggest, not
     decide. */
  function ceilingFor(t) {
    if (/^\d+$/.test(t)) return t.length <= 3 ? 0 : 0.8;
    if (t.length <= 3) return 0;
    if (t.length === 4) return 0.68;
    if (t.length === 5) return 0.85;
    return 1;
  }

  function editDistance(a, b) {
    var m = a.length, n = b.length, prev = [], cur = [], i, j;
    for (j = 0; j <= n; j++) prev[j] = j;
    for (i = 1; i <= m; i++) {
      cur[0] = i;
      for (j = 1; j <= n; j++) {
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1,
                          prev[j - 1] + (a.charAt(i - 1) === b.charAt(j - 1) ? 0 : 1));
      }
      for (j = 0; j <= n; j++) prev[j] = cur[j];
    }
    return prev[n];
  }

  /* validCodes is the dashboard's own design-code set: { NORMALISEDCODE: true }.
     Built once per batch into something the five tests below can use quickly. */
  var idxFor = null, idxSrc = null;
  function index(validCodes) {
    if (idxSrc === validCodes && idxFor) return idxFor;
    var keys = Object.keys(validCodes || {});
    var byFold = {};
    keys.forEach(function (k) { (byFold[fold(k)] || (byFold[fold(k)] = [])).push(k); });
    idxSrc = validCodes;
    idxFor = { keys: keys, byFold: byFold, has: validCodes || {} };
    return idxFor;
  }

  /* every way one piece of text could name a design code, best first */
  function scoreCandidate(t, ix) {
    var out = [], ft = fold(t), i, k, hit;

    if (ix.has[t]) return [{ code: t, score: 1, why: 'read straight off the tag' }];

    hit = ix.byFold[ft];
    if (hit && hit.length === 1) {
      out.push({ code: hit[0], score: 0.93,
                 why: 'read as "' + t + '", and ' + hit[0] + ' is the only design code it can be' });
    } else if (hit && hit.length > 1) {
      hit.forEach(function (k2) {
        out.push({ code: k2, score: 0.88, why: 'read as "' + t + '", which fits more than one code' });
      });
    }

    if (t.length >= 6) {
      var pre = [];
      for (i = 0; i < ix.keys.length; i++) {
        k = ix.keys[i];
        if (k.length > t.length && (k.indexOf(t) === 0 || fold(k).indexOf(ft) === 0)) pre.push(k);
        if (pre.length > 4) break;
      }
      if (pre.length === 1) {
        out.push({ code: pre[0], score: 0.86,
                   why: 'read as "' + t + '", which only completes to ' + pre[0] });
      } else if (pre.length > 1) {
        pre.forEach(function (k2) {
          out.push({ code: k2, score: 0.76, why: '"' + t + '" is the start of several codes' });
        });
      }
    }

    if (t.length >= 7) {
      var inside = [];
      for (i = 0; i < ix.keys.length; i++) {
        k = ix.keys[i];
        if (k.length >= 7 && (t.indexOf(k) >= 0 || k.indexOf(t) >= 0)) inside.push(k);
        if (inside.length > 4) break;
      }
      if (inside.length === 1) {
        out.push({ code: inside[0], score: 0.8,
                   why: 'the tag reading contains ' + inside[0] });
      }

      var best = 99, who = [];
      for (i = 0; i < ix.keys.length; i++) {
        k = ix.keys[i];
        if (Math.abs(k.length - t.length) > 2) continue;
        var d = editDistance(ft, fold(k));
        if (d < best) { best = d; who = [k]; } else if (d === best) { who.push(k); }
        if (best === 0) break;
      }
      if (best <= 2 && best / t.length <= 0.25) {
        var sc = best === 0 ? 0.93 : (best === 1 ? 0.79 : 0.72);
        if (who.length > 1) sc = Math.min(sc, 0.74);
        who.slice(0, 4).forEach(function (k2) {
          out.push({ code: k2, score: sc,
                     why: 'read as "' + t + '", ' + (best === 1 ? 'one character' : best + ' characters') +
                          ' away from ' + k2 });
        });
      }
    }

    return out;
  }

  /* Every WhatsApp batch carries wide shots of the goods as well as close-ups
     of the tag. On a wide shot the tag is a few millimetres across and only the
     printed shop name survives, so say that rather than leaving the shopkeeper
     wondering what went wrong. */
  function noText(raw, anyText) {
    if (raw.length) return 'It read: ' + raw.slice(0, 6).join(', ') + '.';
    if (anyText) return 'Only the printed heading was legible \u2014 this looks like a photograph of the goods rather than a close-up of the tag.';
    return 'No text was found on it.';
  }

  function pickCode(lines, validCodes) {
    var ix = index(validCodes), barcode = null, seen = {}, all = [], raw = [], anyText = 0;

    lines.forEach(function (line) {
      // the "SINCE 1964" heading never holds the design code, and a misread
      // year ("1064") can happen to be one
      if (/SINCE/i.test(line)) { anyText++; return; }
      var pieces = String(line).split(/[\s,;|]+/);
      pieces.push(line);                                  // the line as one piece too
      pieces.forEach(function (piece) {
        var t = norm(piece);
        if (!t || seen[t]) return;
        seen[t] = 1;
        anyText++;
        if (/^\d{10,14}$/.test(t) && !barcode) barcode = t;
        if (looksLikeNoise(t) && !ix.has[t]) return;
        raw.push(t);
        var ceil = ceilingFor(t);
        if (!ceil) return;
        scoreCandidate(t, ix).forEach(function (c) {
          c.from = t;
          c.score = Math.min(c.score, ceil);
          all.push(c);
        });
      });
    });

    if (!all.length) {
      return { status: STATUS.NOMATCH, code: null, candidates: [], confidence: null, barcode: barcode,
               message: 'Nothing here matched the ' + COLUMN + ' column. ' + noText(raw, anyText) };
    }

    // best score per code
    var byCode = {};
    all.forEach(function (c) {
      if (!byCode[c.code] || byCode[c.code].score < c.score) byCode[c.code] = c;
    });
    var ranked = Object.keys(byCode).map(function (k) { return byCode[k]; })
      .sort(function (a, b) {
        return (b.score - a.score) || (b.from.length - a.from.length) ||
               (a.code.length - b.code.length);
      });

    var top = ranked[0];
    var rival = ranked[1] && ranked[1].score >= top.score - 0.06 ? ranked[1] : null;
    var alts = ranked.filter(function (c) { return c.score >= 0.7; })
      .slice(0, 4).map(function (c) { return c.code; });

    var st;
    if (rival)                   st = STATUS.AMBIGUOUS;
    else if (top.score >= 0.9)   st = STATUS.MATCH;
    else if (top.score >= 0.7)   st = STATUS.CHECK;
    else                         st = STATUS.NOMATCH;

    var msg;
    if (st === STATUS.MATCH)          msg = 'Code ' + top.code + ' \u2014 ' + top.why + '.';
    else if (st === STATUS.AMBIGUOUS) msg = 'Read as "' + top.from + '", which fits ' +
      (alts.length > 2 ? alts.slice(0, -1).join(', ') + ' or ' + alts[alts.length - 1]
                       : alts.join(' or ')) + ' equally well. Pick the right one.';
    else if (st === STATUS.CHECK)     msg = 'Probably ' + top.code + ' \u2014 ' + top.why + '. Worth a look at the photograph.';
    else                              msg = 'Nothing here matched the ' + COLUMN + ' column. ' + noText(raw, anyText);

    return {
      status: st,
      code: st === STATUS.MATCH ? top.code : null,
      raw: top.from, candidates: st === STATUS.MATCH ? [] : alts,
      confidence: Math.round(top.score * 100) / 100,
      foundAs: 'design code line', barcode: barcode,
      message: msg
    };
  }

  /* ---------------------------------------------------------------
     the surface app.js uses
     --------------------------------------------------------------- */
  function friendly(e) {
    var m = e && e.message || String(e);
    if (/could not load/.test(m)) {
      return 'The tag reader files are missing from this host. Upload the ocr/ folder next to index.html.';
    }
    if (/WebAssembly|wasm|backend/i.test(m)) {
      return 'This browser could not start the tag reader. Chrome, Edge or Firefox, reasonably current, is needed.';
    }
    return m;
  }

  /* ---------------- reading in the cloud ---------------- */
  function cloudLines(url, init) {
    return fetch(url, init).then(function (r) {
      if (!r.ok) {
        return r.json().catch(function () { return {}; }).then(function (j) {
          var e = new Error(j.error || ('The cloud reader answered ' + r.status + '.'));
          e.http = r.status; throw e;
        });
      }
      return r.json();
    }).then(function (j) { return j.lines || []; });
  }
  // the photograph already sits in the service's storage: read it there,
  // rather than downloading it here only to send it back
  function readCloudById(id) {
    return cloudLines(API + '/api/read?id=' + encodeURIComponent(id), { method: 'POST' });
  }
  function readCloud(blob) {
    return cloudLines(API + '/api/read', { method: 'POST', headers: { 'Content-Type': blob.type || 'image/jpeg' }, body: blob });
  }
  // a network failure (not a refusal) falls back to this browser
  function useLocal(e) {
    if (e && e.http) throw e;
    cloudDown = true;
    if (onLoad) onLoad('The cloud reader is not answering, so tags are being read in this browser instead.');
    return null;
  }

  function matchOne(blob, filename, validCodes) {
    if (engineErr && !API) {
      return Promise.resolve({ status: STATUS.ERROR, code: null, message: friendly(engineErr) });
    }
    var lines = API && !cloudDown
      ? readCloud(blob).catch(function (e) { useLocal(e); return readTag(blob); })
      : readTag(blob);
    return lines
      .then(function (ls) { return pickCode(ls, validCodes); })
      .catch(function (e) {
        return { status: STATUS.ERROR, code: null, message: friendly(e) };
      });
  }

  /* One photograph at a time: the work is all CPU, wherever it runs, so
     sending several at once only makes each one slower. */
  function matchMany(photos, getBlob, validCodes, onEach) {
    var out = [];
    cloudDown = false;
    onLoad = function (m) { if (onEach) onEach(0, photos.length, null, { loading: m }); };
    var cloudStore = !!(API && global.Store && Store.backend && Store.backend.api === API);
    return photos.reduce(function (chain, p, i) {
      return chain.then(function () {
        var job;
        if (cloudStore && !cloudDown) {
          job = readCloudById(p.id)
            .then(function (ls) { return pickCode(ls, validCodes); })
            .catch(function (e) {
              useLocal(e);
              return getBlob(p.id).then(function (blob) {
                return blob ? matchOne(blob, p.name, validCodes)
                            : { status: STATUS.ERROR, code: null, message: 'Photograph could not be read back.' };
              });
            })
            .catch(function (e) { return { status: STATUS.ERROR, code: null, message: friendly(e) }; });
        } else {
          job = getBlob(p.id).then(function (blob) {
            if (!blob) return { status: STATUS.ERROR, code: null, message: 'Photograph could not be read back.' };
            return matchOne(blob, p.name, validCodes);
          });
        }
        return job.then(function (res) {
          out.push({ photo: p, result: res });
          if (onEach) onEach(i + 1, photos.length, p, res);
        });
      });
    }, Promise.resolve()).then(function () { onLoad = null; return out; });
  }

  function ping() {
    if (API) {
      // also wakes the service, which sleeps when nobody is using it
      return fetch(API + '/api/ping', { cache: 'no-store' })
        .then(function (r) { return r.json(); })
        .then(function (j) { return { ok: true, engine: j.engine || CLOUD, gemini: false }; })
        .catch(function () {
          return { ok: false, engine: 'the cloud reader is not answering yet ' + String.fromCharCode(8212) +
                   ' it sleeps when unused and takes a few seconds to wake', gemini: false };
        });
    }
    // a cheap check that the ocr/ folder actually reached the host
    return fetch(BASE + 'models/ppocr_keys_v1.txt', { method: 'HEAD', cache: 'no-store' })
      .then(function (r) {
        return r.ok ? { ok: true, engine: ENGINE, gemini: false, book_loaded: true }
                    : { ok: false, engine: 'the tag reader files are not on this host (ocr/ is missing)', gemini: false };
      })
      .catch(function () {
        return { ok: false, engine: 'the tag reader files could not be reached', gemini: false };
      });
  }

  global.Matcher = {
    matchOne: matchOne, matchMany: matchMany, ping: ping, pickCode: pickCode, readTag: readTag,
    STATUS: STATUS, configured: true, url: API || null, column: COLUMN, engine: API ? CLOUD : ENGINE,
    forgetBook: function () {},
    retry: function () { engineErr = null; }
  };
})(window);
