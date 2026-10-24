/* storage.js — where the history lives.
 *
 * Three interchangeable backends behind one interface:
 *   service — the shop's own cloud service (NARSINGH_CONFIG.api), which keeps
 *             everything in Google Cloud Storage. No sign-in: the service
 *             holds the storage permission, the page only talks to it.
 *   gcs     — Cloud Storage directly, with a Google sign-in in the page.
 *   local   — IndexedDB in this browser. Works with no setup at all.
 *
 * The first one configured wins: api, then gcsBucket, else local.
 * Both expose: load(), save(state), putBlob(id, blob), getBlobUrl(id),
 *              putRaw(id, name, blob), getRaw(id, name), wipe(), label.
 */
(function (global) {
  'use strict';

  var CFG = global.NARSINGH_CONFIG || {};
  var EMPTY = {
    version: 1,
    files: [],          // one row per uploaded workbook
    days: {},           // date -> { mv: {designKey:[in,out]}, tot:[in,out], lines:n }
    latest: null,       // { date, bal: {designKey: pieces} }  newest balance snapshot
    sellers: {},        // designKey -> seller name   (from full-period exports)
    refs: {},           // designKey -> printed design code
    cumulative: null,   // { from, to, rows: {designKey:{tin,tout,bal}} } newest full export
    photos: []          // { id, name, designKey, addedAt }
  };

  function blankState() { return JSON.parse(JSON.stringify(EMPTY)); }

  /* ---------------- IndexedDB plumbing ---------------- */
  var DB_NAME = 'narsingh-stock', DB_VER = 1, dbp = null;
  function idb() {
    if (dbp) return dbp;
    dbp = new Promise(function (res, rej) {
      var rq = indexedDB.open(DB_NAME, DB_VER);
      rq.onupgradeneeded = function () {
        var db = rq.result;
        if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
        if (!db.objectStoreNames.contains('blobs')) db.createObjectStore('blobs');
      };
      rq.onsuccess = function () { res(rq.result); };
      rq.onerror = function () { rej(rq.error); };
    });
    return dbp;
  }
  function idbOp(store, mode, fn) {
    return idb().then(function (db) {
      return new Promise(function (res, rej) {
        var tx = db.transaction(store, mode), rq = fn(tx.objectStore(store));
        tx.oncomplete = function () { res(rq && rq.result); };
        tx.onerror = function () { rej(tx.error); };
      });
    });
  }

  var LocalBackend = {
    label: 'this browser',
    cloud: false,
    load: function () {
      return idbOp('kv', 'readonly', function (s) { return s.get('state'); })
        .then(function (v) { return v || blankState(); })
        .catch(function () { return blankState(); });
    },
    save: function (state) {
      return idbOp('kv', 'readwrite', function (s) { return s.put(state, 'state'); });
    },
    putBlob: function (id, blob) {
      return idbOp('blobs', 'readwrite', function (s) { return s.put(blob, id); });
    },
    getBlobUrl: function (id) {
      return idbOp('blobs', 'readonly', function (s) { return s.get(id); })
        .then(function (b) { return b ? URL.createObjectURL(b) : null; });
    },
    putRaw: function (id, name, blob) {
      return idbOp('blobs', 'readwrite', function (s) { return s.put(blob, 'raw:' + id); });
    },
    // the workbook exactly as uploaded, so removing a file can rebuild from the rest
    getRaw: function (id) {
      return idbOp('blobs', 'readonly', function (s) { return s.get('raw:' + id); })
        .then(function (b) { return b || null; });
    },
    wipe: function () {
      return Promise.all([
        idbOp('kv', 'readwrite', function (s) { return s.clear(); }),
        idbOp('blobs', 'readwrite', function (s) { return s.clear(); })
      ]);
    }
  };

  /* ---------------- Google Cloud Storage ---------------- */
  function GcsBackend(bucket, prefix, clientId) {
    var token = null, tokenExp = 0, tokenClient = null, urlCache = {};

    function gisReady() {
      return new Promise(function (res, rej) {
        if (global.google && global.google.accounts) return res();
        var s = document.createElement('script');
        s.src = 'https://accounts.google.com/gsi/client';
        s.async = true; s.defer = true;
        s.onload = res;
        s.onerror = function () { rej(new Error('Could not load Google sign-in. Check the network.')); };
        document.head.appendChild(s);
      });
    }

    function auth() {
      if (token && Date.now() < tokenExp - 60000) return Promise.resolve(token);
      return gisReady().then(function () {
        return new Promise(function (res, rej) {
          if (!tokenClient) {
            tokenClient = global.google.accounts.oauth2.initTokenClient({
              client_id: clientId,
              scope: 'https://www.googleapis.com/auth/devstorage.read_write',
              callback: function () {}
            });
          }
          tokenClient.callback = function (r) {
            if (r && r.access_token) {
              token = r.access_token;
              tokenExp = Date.now() + (r.expires_in || 3600) * 1000;
              res(token);
            } else {
              rej(new Error('Google sign-in was dismissed or refused.'));
            }
          };
          tokenClient.error_callback = function (e) {
            rej(new Error('Google sign-in failed: ' + ((e && e.type) || 'unknown')));
          };
          tokenClient.requestAccessToken({ prompt: token ? '' : 'consent' });
        });
      });
    }

    function objUrl(name, media) {
      return 'https://storage.googleapis.com/storage/v1/b/' + encodeURIComponent(bucket) +
             '/o/' + encodeURIComponent(prefix + name) + (media ? '?alt=media' : '');
    }
    function upUrl(name) {
      return 'https://storage.googleapis.com/upload/storage/v1/b/' + encodeURIComponent(bucket) +
             '/o?uploadType=media&name=' + encodeURIComponent(prefix + name);
    }
    function get(name) {
      return auth().then(function (t) {
        return fetch(objUrl(name, true), { headers: { Authorization: 'Bearer ' + t } });
      });
    }
    function put(name, body, type) {
      return auth().then(function (t) {
        return fetch(upUrl(name), {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + t, 'Content-Type': type },
          body: body
        });
      }).then(function (r) {
        if (!r.ok) {
          return r.text().then(function (txt) {
            throw new Error('Cloud write failed (' + r.status + '). ' +
              (r.status === 403 ? 'The signed-in account may not have Storage Object Admin on this bucket.' :
               r.status === 404 ? 'Bucket "' + bucket + '" was not found.' : txt.slice(0, 160)));
          });
        }
        return r.json();
      });
    }

    return {
      label: 'bucket ' + bucket,
      cloud: true,
      load: function () {
        return get('state.json').then(function (r) {
          if (r.status === 404) return blankState();
          if (!r.ok) throw new Error('Cloud read failed (' + r.status + ').');
          return r.json();
        });
      },
      save: function (state) {
        return put('state.json', JSON.stringify(state), 'application/json');
      },
      putBlob: function (id, blob) { return put('photos/' + id, blob, blob.type || 'image/jpeg'); },
      getBlobUrl: function (id) {
        if (urlCache[id]) return Promise.resolve(urlCache[id]);
        return get('photos/' + id).then(function (r) {
          if (!r.ok) return null;
          return r.blob().then(function (b) {
            return (urlCache[id] = URL.createObjectURL(b));
          });
        });
      },
      putRaw: function (id, name, blob) {
        return put('uploads/' + id + '-' + name.replace(/[^\w.\-]/g, '_'),
                   blob, blob.type || 'application/octet-stream');
      },
      getRaw: function (id, name) {
        return get('uploads/' + id + '-' + String(name || '').replace(/[^\w.\-]/g, '_'))
          .then(function (r) { return r.ok ? r.blob() : null; });
      },
      wipe: function () { return put('state.json', JSON.stringify(blankState()), 'application/json'); }
    };
  }

  /* ---------------- the shop's cloud service ---------------- */
  function ServiceBackend(base) {
    var loaded = false;
    function check(r, what) {
      if (!r.ok) throw new Error('The cloud service could not ' + what + ' (' + r.status + ').');
      return r;
    }
    // the history is a megabyte or two of JSON: squeeze it before sending
    function gz(text) {
      if (!global.CompressionStream) return Promise.resolve({ body: text, enc: null });
      var stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
      return new Response(stream).blob().then(function (b) { return { body: b, enc: 'gzip' }; });
    }
    return {
      label: 'Google Cloud',
      cloud: true,
      api: base,
      load: function () {
        return fetch(base + '/api/state', { cache: 'no-store' })
          .then(function (r) { return check(r, 'load the history').json(); })
          .then(function (s) { loaded = true; return s || blankState(); });
      },
      save: function (state) {
        // never write over the cloud copy unless it was read first: a page that
        // could not reach the service starts blank, and must not save that blank
        if (!loaded) return Promise.reject(new Error('Not saved: the cloud history was never loaded. Reload the page.'));
        return gz(JSON.stringify(state)).then(function (z) {
          var h = { 'Content-Type': 'application/json' };
          if (z.enc) h['Content-Encoding'] = z.enc;
          return fetch(base + '/api/state', { method: 'PUT', headers: h, body: z.body });
        }).then(function (r) { check(r, 'save the history'); });
      },
      putBlob: function (id, blob) {
        return fetch(base + '/api/blob/' + encodeURIComponent(id), {
          method: 'PUT', headers: { 'Content-Type': blob.type || 'image/jpeg' }, body: blob
        }).then(function (r) { check(r, 'store a photograph'); });
      },
      // photographs are shown straight from the service; the browser caches them
      getBlobUrl: function (id) {
        return Promise.resolve(base + '/api/blob/' + encodeURIComponent(id));
      },
      putRaw: function (id, name, blob) {
        return fetch(base + '/api/raw/' + encodeURIComponent(id), {
          method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: blob
        }).then(function (r) { check(r, 'store a workbook'); });
      },
      getRaw: function (id) {
        return fetch(base + '/api/raw/' + encodeURIComponent(id))
          .then(function (r) { return r.ok ? r.blob() : null; });
      },
      wipe: function () {
        return fetch(base + '/api/wipe', { method: 'POST' })
          .then(function (r) { check(r, 'clear the history'); });
      }
    };
  }

  var API = String(CFG.api || '').replace(/\/+$/, '');
  var backend = API ? ServiceBackend(API)
    : (CFG.gcsBucket && CFG.googleClientId)
    ? GcsBackend(CFG.gcsBucket, CFG.gcsPrefix || '', CFG.googleClientId)
    : LocalBackend;

  global.Store = {
    backend: backend,
    blankState: blankState,
    isCloud: backend.cloud,
    label: backend.label
  };
})(window);
