/* pieces.js — several photographs of one piece, most of them without a legible tag.
 *
 * How the shop sends photographs, as the WhatsApp export shows it:
 *
 *   12:33:19  a shot of the whole stack, every colour of one design
 *   12:33:31  a close-up of the tag on one of them
 *    ...      the next design, the same way, a minute or more later
 *    1:33:15  "Tulsi fabrics India private limited"   <- the seller, closing the batch
 *    1:33:16  "."
 *
 * The stack shot is the better picture of the saree, and it never carries a
 * readable code: the tag is a centimetre across in it. So this module links
 * each photograph that has no code to the close-up sent beside it, using three
 * things the export already holds:
 *
 *   timing  — the close-up of the same piece is sent within a minute, and the
 *             next piece's close-up is further away than that
 *   sender  — only photographs from the same phone are paired
 *   seller  — the caption that closes a batch names the seller; a pairing whose
 *             design belongs to a different seller is held back for a person
 *
 * A pairing is made on its own only when it is clear: one close-up within the
 * minute, or one at least twice as near as any other. Everything else is
 * offered as a choice. A pairing a person rejected is never made again, and a
 * stack shot follows its close-up — unlink the close-up and the stack shot
 * goes back for review with it.
 *
 * No dependencies. Runs the same in Node, which is how it is tested.
 */
(function (global) {
  'use strict';

  var WINDOW_S = 60;          // a close-up of the same piece comes within this
  var CLEAR_RATIO = 2;        // ... and at least this much nearer than any rival
  var CLEAR_MARGIN_S = 5;

  /* ---------------- when each photograph was sent ---------------- */

  // iOS export names: 00000763-PHOTO-2026-09-11-12-33-19.jpg
  function sentAtFromName(name) {
    var m = String(name || '').match(/(20\d\d)-(\d\d)-(\d\d)-(\d\d)-(\d\d)-(\d\d)/);
    if (!m) return null;
    return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime();
  }
  function seqFromName(name) {
    var m = String(name || '').match(/^(\d{5,})-/);
    return m ? +m[1] : null;
  }

  /* ---------------- the chat ---------------- */

  var LRM = /[\u200e\u200f\u202a-\u202e\ufeff]/g;

  // [11/09/26, 12:33:19 PM] Narsingh Tab 2: <attached: 00000763-PHOTO-....jpg>   (iOS)
  // 11/09/26, 12:33 pm - Narsingh Tab 2: IMG-20260911-WA0012.jpg (file attached) (Android)
  var IOS = /^\[(\d{1,2})\/(\d{1,2})\/(\d{2,4}),\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp]\.?\s?[Mm]\.?)?\]\s+([^:]+):\s?(.*)$/;
  var AND = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4}),\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp]\.?\s?[Mm]\.?)?\s+-\s+([^:]+):\s?(.*)$/;

  function when(d, mo, y, h, mi, s, ap) {
    y = +y; if (y < 100) y += 2000;
    h = +h;
    if (ap) {
      var pm = /p/i.test(ap);
      if (pm && h < 12) h += 12;
      if (!pm && h === 12) h = 0;
    }
    return new Date(y, +mo - 1, +d, h, +mi, +(s || 0)).getTime();
  }

  function parseChat(text) {
    var msgs = [], cur = null;
    String(text || '').split(/\r?\n/).forEach(function (raw) {
      var line = raw.replace(LRM, '');
      var m = line.match(IOS) || line.match(AND);
      if (m) {
        cur = { at: when(m[1], m[2], m[3], m[4], m[5], m[6], m[7]), sender: m[8].trim(), text: m[9] };
        msgs.push(cur);
      } else if (cur) {
        cur.text += '\n' + line;               // a message that runs over several lines
      }
    });
    msgs.forEach(function (msg, i) {
      msg.i = i;
      var a = msg.text.match(/<attached:\s*([^>]+)>/i) ||
              msg.text.match(/([\w.-]+\.(?:jpe?g|png|webp))\s*\(file attached\)/i);
      msg.file = a ? a[1].trim() : null;
      msg.caption = (a ? msg.text.replace(a[0], '') : msg.text).trim();
    });
    return msgs;
  }

  /* "2peac each c", "Each colour 6 pcs" — notes about quantity, not sellers */
  function isQuantityNote(t) {
    return /\d/.test(t) || /\b(pcs?|peac|piece|pieces|each|colou?rs?|set|sets)\b/i.test(t);
  }
  function isNoise(t) {
    return !t || /^[.\s\-_,]*$/.test(t) || /message was deleted|media omitted|null$/i.test(t);
  }

  /* For every photograph in the chat: when it was sent, by whom, and the
     caption that closed its batch (normally the seller). */
  function chatIndex(text) {
    var msgs = parseChat(text), out = {}, open = {};   // open[sender] = files awaiting a caption
    function close(sender, caption, at) {
      (open[sender] || []).forEach(function (f) {
        // a caption hours later, on another day, belongs to something else
        if (at - out[f].sentAt <= 3 * 3600e3) out[f].batchCaption = caption;
      });
      open[sender] = [];
    }
    msgs.forEach(function (msg) {
      if (msg.file) {
        out[msg.file] = { sentAt: msg.at, seq: msg.i, sender: msg.sender, caption: msg.caption || null };
        (open[msg.sender] || (open[msg.sender] = [])).push(msg.file);
        if (msg.caption && !isQuantityNote(msg.caption) && !isNoise(msg.caption)) close(msg.sender, msg.caption, msg.at);
        return;
      }
      if (isNoise(msg.caption) || isQuantityNote(msg.caption)) return;
      close(msg.sender, msg.caption, msg.at);
    });
    return out;
  }

  /* ---------------- is this caption that seller? ---------------- */

  var STOP = { NEW: 1, PVT: 1, PRIVATE: 1, LTD: 1, LIMITED: 1, LLP: 1, INDIA: 1, CO: 1,
               AND: 1, THE: 1, M: 1, S: 1, MS: 1, OF: 1 };
  /* Words half the trade has in its name. Two sellers sharing one of these
     are not the same seller \u2014 "Krishna creations" is not "Novelty creation". */
  var GENERIC = { FABRIC: 1, SILK: 1, SAREE: 1, SARI: 1, CREATION: 1, TEXTILE: 1, HANDLOOM: 1,
                  FASHION: 1, MILL: 1, HOUSE: 1, DESIGN: 1, COLLECTION: 1, ENTERPRISE: 1,
                  TRADER: 1, TRADING: 1, EXPORT: 1, IMPEX: 1, PRINT: 1, EMPORIUM: 1, GARMENT: 1,
                  CLOTH: 1, CENTRE: 1, CENTER: 1, STORE: 1, AGENCY: 1, AGENCIE: 1, INDUSTRIE: 1,
                  HANDICRAFT: 1, DUPATTA: 1, WEAVER: 1, KNIT: 1 };

  function tokens(s) {
    return String(s || '').toUpperCase().replace(/\([^)]*\)/g, ' ').replace(/[^A-Z0-9 ]/g, ' ')
      .split(/\s+/).filter(function (t) { return t && !STOP[t]; })
      .map(function (t) { return t.length > 3 ? t.replace(/S$/, '') : t; });   // FABRICS -> FABRIC
  }
  function distinctive(ts) { return ts.filter(function (t) { return !GENERIC[t]; }); }

  function dist(a, b) {
    var m = a.length, n = b.length, prev = [], cur = [], i, j;
    for (j = 0; j <= n; j++) prev[j] = j;
    for (i = 1; i <= m; i++) {
      cur[0] = i;
      for (j = 1; j <= n; j++) {
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      }
      for (j = 0; j <= n; j++) prev[j] = cur[j];
    }
    return prev[n];
  }
  // typed on a phone: "Kreation" for "Creation", "Ambadal" for "Ambadaal"
  function same(a, b) { return a === b || (Math.min(a.length, b.length) >= 5 && dist(a, b) <= 1); }
  function anyMatch(t, list) { return list.some(function (u) { return same(t, u); }); }

  /* true: same business; false: a different one; null: cannot tell */
  function sellerMatch(caption, seller) {
    var dc = distinctive(tokens(caption)), ds = distinctive(tokens(seller));
    if (!dc.length || !ds.length) return null;
    return dc.some(function (t) { return anyMatch(t, ds); });
  }
  /* Stricter: every word of the caption is in the seller's name, generic
     words included. Used where the caption is evidence for a code, not just a
     reason to hold one back. */
  function sellerStrong(caption, seller) {
    if (!sellerMatch(caption, seller)) return false;
    var tc = tokens(caption), ts = tokens(seller);
    return tc.every(function (t) { return anyMatch(t, ts); });
  }
  /* A caption only counts as a seller if it names one the workbook knows —
     "Reyna" might be a brand, a customer, or a note. */
  function namesASeller(caption, sellers) {
    if (!caption) return false;
    for (var i = 0; i < sellers.length; i++) if (sellerMatch(caption, sellers[i])) return true;
    return false;
  }

  /* ---------------- linking ---------------- */

  function secs(ms) { return Math.round(ms / 1000); }
  function ago(ms) {
    var s = secs(Math.abs(ms));
    return s < 90 ? s + (s === 1 ? ' second' : ' seconds') : Math.round(s / 60) + ' minutes';
  }

  /* The reader's own verdict, kept apart so that linking can be redone from
     scratch without the reader's opinion and the linker's being confused. */
  function readerVerdict(p) {
    if (!p.ocr) p.ocr = { status: p.status || 'nomatch',
                          message: p.message || (p.status ? null : 'Not read yet. Press Read codes again.'),
                          candidates: p.candidates || null, conf: p.conf == null ? null : p.conf };
    return p.ocr;
  }

  function sig(p) {
    return [p.designKey, p.how, p.linkedTo, p.status, p.message, (p.candidates || []).join(',')].join('|');
  }

  /*  photos  — the dashboard's photo records, changed in place
      opts.sellerOf(key)  -> the workbook's seller for a design, or ''
      opts.sellers        -> every seller name in the workbook
      opts.refOf(key)     -> the design code as printed, for messages
      Returns how many photographs changed.                                  */
  function link(photos, opts) {
    opts = opts || {};
    var W = (opts.window || WINDOW_S) * 1000;
    var sellerOf = opts.sellerOf || function () { return ''; };
    var refOf = opts.refOf || function (k) { return k; };
    var sellers = opts.sellers || [];
    var byId = {}, before = {};

    photos.forEach(function (p) {
      byId[p.id] = p;
      before[p.id] = sig(p);
      if (p.sentAt == null) p.sentAt = sentAtFromName(p.name);
      if (p.seq == null) p.seq = seqFromName(p.name);
      if (p.batchCaption && p.batchIsSeller == null && sellers.length) {
        p.batchIsSeller = namesASeller(p.batchCaption, sellers);
      }
    });

    /* what the caption that closed this photograph's batch says about a code:
       true \u2014 names its seller; false \u2014 names a different seller; null \u2014 silent */
    function captionSays(p, key) {
      if (!p.batchIsSeller || !key) return null;
      var seller = sellerOf(key);
      return seller ? sellerMatch(p.batchCaption, seller) : null;
    }

    // 1. a stack shot follows its close-up: if the close-up lost its code or
    //    changed it, the stack shot goes back for a person to look at
    photos.forEach(function (p) {
      if (p.how !== 'timing' || !p.designKey) return;
      var q = byId[p.linkedTo];
      if (q && q.designKey === p.designKey && q.how !== 'timing') return;
      p.designKey = null; p.source = null; p.how = null; p.linkedTo = null; p.linkDt = null;
      p.status = 'nomatch';
      p.message = 'Its close-up was unlinked, so this went back for review.';
      p.linkNote = true;
    });

    // every pending photograph starts from the reader's own verdict, so that
    // running this twice gives the same answer as running it once
    photos.forEach(function (p) {
      if (p.designKey || p.unmapped) return;
      var ocr = readerVerdict(p);
      if (p.linkNote) {
        p.status = ocr.status; p.message = ocr.message; p.candidates = ocr.candidates;
        p.linkCands = null; p.linkNote = false;
      }
    });

    // 2. a close-up the reader held back — a short code, or one it could only
    //    complete — is confirmed when the batch caption names that design's
    //    seller. Two independent sources agreeing, not one guessing.
    photos.forEach(function (p) {
      if (p.designKey || p.unmapped) return;   // a person removed it: theirs to decide
      var ocr = p.ocr, c = (ocr.candidates || []).map(String);
      if (ocr.status !== 'check' || c.length !== 1) return;
      if ((p.rejected || []).indexOf(c[0]) >= 0) return;
      var seller = sellerOf(c[0]);
      if (!p.batchIsSeller || !seller || !sellerStrong(p.batchCaption, seller)) return;
      p.designKey = c[0]; p.source = 'ocr'; p.how = 'read+seller';
      p.status = 'match'; p.candidates = null;
      p.message = 'Read ' + refOf(c[0]) + ' off the tag, and the batch was captioned "' +
        p.batchCaption + '" \u2014 its seller, ' + seller + '. The reader had asked for a check; the caption settles it.';
    });

    // 3. what a stack shot can be linked to: a code that was read, twinned by
    //    barcode, confirmed by caption or typed by a person — never one that
    //    was itself linked by timing
    var src = photos.filter(function (q) { return q.designKey && q.how !== 'timing' && q.sentAt != null; });

    photos.forEach(function (p) {
      if (p.designKey || p.unmapped || p.sentAt == null) return;
      var ocr = p.ocr, rej = p.rejected || [], best = {};

      src.forEach(function (q) {
        if (q === p || rej.indexOf(q.designKey) >= 0) return;
        if (p.sender && q.sender && p.sender !== q.sender) return;
        var dt = q.sentAt - p.sentAt;
        if (Math.abs(dt) > W) return;
        var cur = best[q.designKey];
        if (!cur || Math.abs(dt) < Math.abs(cur.dt)) best[q.designKey] = { q: q, dt: dt };
      });
      var c = Object.keys(best).map(function (k) { return best[k]; }).sort(function (a, b) {
        return Math.abs(a.dt) - Math.abs(b.dt) ||
               Math.abs((a.q.seq || 0) - (p.seq || 0)) - Math.abs((b.q.seq || 0) - (p.seq || 0));
      });
      if (!c.length) return;

      var first = c[0], second = c[1];
      var clear = !second ||
        Math.abs(second.dt) >= CLEAR_RATIO * Math.abs(first.dt) + CLEAR_MARGIN_S * 1000;
      var why = [];

      // the reader had its own idea about this photograph
      var ocrCands = (ocr.candidates || []).map(String);
      if (ocrCands.length && ocrCands.indexOf(first.q.designKey) < 0 &&
          (ocr.status === 'check' || ocr.status === 'ambiguous')) {
        clear = false;
        why.push('the reader suggested ' + ocrCands.map(refOf).join(' or ') + ' instead');
      }

      // the caption that closed this batch names the seller
      var says = captionSays(p, first.q.designKey);
      if (says === false) {
        clear = false;
        why.push('the batch was captioned "' + p.batchCaption + '" but ' + refOf(first.q.designKey) +
                 ' is from ' + sellerOf(first.q.designKey));
      }

      if (clear) {
        p.designKey = first.q.designKey;
        p.source = 'ocr';
        p.how = 'timing';
        p.linkedTo = first.q.id;
        p.linkDt = first.dt;
        p.status = 'match';
        p.conf = null;
        p.candidates = null; p.linkCands = null;
        p.message = 'Same piece as the close-up of ' + refOf(first.q.designKey) + ', sent ' +
          ago(first.dt) + ' ' + (first.dt > 0 ? 'before' : 'after') + ' it' +
          (says === true ? ', in the batch captioned "' + p.batchCaption + '"' : '') + '.';
        return;
      }

      // not clear enough to decide alone: offer the close-ups, nearest first
      var offer = c.slice(0, 4);
      p.linkCands = offer.map(function (x) { return { id: x.q.id, code: x.q.designKey, dt: x.dt }; });
      var codes = [];
      offer.forEach(function (x) { if (codes.indexOf(x.q.designKey) < 0) codes.push(x.q.designKey); });
      ocrCands.forEach(function (k) { if (codes.indexOf(k) < 0) codes.push(k); });
      p.candidates = codes;
      p.status = 'ambiguous';
      p.message = 'Sent ' + offer.map(function (x) {
          return ago(x.dt) + ' ' + (x.dt > 0 ? 'before' : 'after') + ' the close-up of ' + refOf(x.q.designKey);
        }).join(', and ') + '.' +
        (why.length ? ' Not linked on its own because ' + why.join('; ') + '.'
                    : ' Both are close enough in time that a person should pick.');
      p.linkNote = true;
    });

    var changed = 0;
    photos.forEach(function (p) { if (sig(p) !== before[p.id]) changed++; });
    return changed;
  }

  /* After a person rejects a label, the same pairing must not come back on its
     own the next time anything is computed. */
  function reject(p, code) {
    if (!code) return;
    p.rejected = p.rejected || [];
    if (p.rejected.indexOf(code) < 0) p.rejected.push(code);
  }
  function unreject(p, code) {
    if (!p.rejected) return;
    p.rejected = p.rejected.filter(function (k) { return k !== code; });
  }

  /* Photographs of one design, the picture of the goods first: the stack
     shot shows every colour, the close-up mostly shows a tag. */
  function order(list) {
    return list.slice().sort(function (a, b) {
      var ka = a.how === 'timing' ? 0 : 1, kb = b.how === 'timing' ? 0 : 1;
      return ka - kb || (a.sentAt || 0) - (b.sentAt || 0);
    });
  }

  global.Pieces = {
    chatIndex: chatIndex, parseChat: parseChat, sentAtFromName: sentAtFromName,
    sellerMatch: sellerMatch, sellerStrong: sellerStrong, namesASeller: namesASeller,
    link: link, reject: reject, unreject: unreject, order: order,
    WINDOW_S: WINDOW_S
  };
})(typeof window !== 'undefined' ? window : globalThis);
