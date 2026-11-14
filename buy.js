/* buy.js — the "Should I buy?" tab of the stock desk.
 *
 * At the market: photograph a saree, and see how sarees that look like it
 * have sold in this shop.
 *
 *   1. The photograph is shrunk here (a phone photo is several megabytes; the
 *      comparison needs far less) and sent to the cloud service, which
 *      describes its look (weave, print, embroidery, colour) the same way it
 *      has described every saree photographed in the shop, and returns the
 *      stored photographs that look most like it. The photograph is
 *      compared, never stored.
 *   2. Here, those photographs become designs, through the codes they carry,
 *      and each design brings its own sales: on hand, sold, pace, weeks to
 *      clear, movement. Up to five, the closest first.
 *   3. The verdict: how many of them are selling well (a vote, each counting
 *      by how closely it matches) and the pace they sell at on average, and
 *      from that, how long a given number of pieces would take to clear.
 */
(function () {
  'use strict';

  var CFG = window.NARSINGH_CONFIG || {};
  var API = String(CFG.api || '').replace(/\/+$/, '');
  var $ = function (id) { return document.getElementById(id); };
  var LBL = { fast: 'Fast', steady: 'Steady', slow: 'Slow', dead: 'Dead', soldout: 'Sold out' };
  var MAX = 5;            // designs shown
  var state = null, A = null, lines = {}, photos = {}, last = null, tagged = 0;

  function n(v) { return (v == null ? 0 : Math.round(v)).toLocaleString('en-IN'); }
  function n1(v) { return v == null ? '—' : (Math.round(v * 10) / 10).toLocaleString('en-IN'); }
  function esc(t) { var d = document.createElement('div'); d.textContent = t == null ? '' : t; return d.innerHTML; }
  function status(msg, kind) {
    $('buyStatus').textContent = msg;
    $('buyDot').className = 'dot' + (kind ? ' ' + kind : '');
  }

  /* ---------------- the shop's history ----------------
     The stock desk loads the history and works out every line's numbers; it
     hands them over each time it redraws, so this tab never loads anything
     twice and always shows today's figures. */
  var asked = false;
  function take_data(e) {
    var d = e.detail || {};
    state = d.state; A = d.A;
    if (!state || !A) return;
    lines = {}; photos = {};
    A.lines.forEach(function (l) { lines[l.key] = l; });
    (state.photos || []).forEach(function (p) { photos[p.id] = p; });
    tagged = (state.photos || []).filter(function (p) { return p.designKey && !p.unmapped; }).length;
    if (!API || !Store.backend.api) {
      status('This needs the shop’s cloud service (api in config.js): it is what compares photographs.', 'err');
      lock(true);
      return;
    }
    lock(false);
    if (!last) status(tagged
      ? 'Ready. ' + n(tagged) + ' photographs of your sarees to compare against.'
      : 'No photographs carry a design code yet, so there is nothing to compare against. Add the WhatsApp photographs on the Stock desk tab first.',
      tagged ? 'ok' : 'err');
    // any stored photograph not yet described is described in the background
    if (!asked) { asked = true; fetch(API + '/api/looks/backfill', { method: 'POST' }).catch(function () {}); }
  }

  /* ---------------- the two tabs ---------------- */
  function show(tab) {
    var buy = tab === 'buy';
    $('tabDesk').classList.toggle('hidden', buy);
    $('tabBuy').classList.toggle('hidden', !buy);
    $('tabBtnDesk').setAttribute('aria-selected', String(!buy));
    $('tabBtnBuy').setAttribute('aria-selected', String(buy));
    if (location.hash !== (buy ? '#buy' : '') && !(location.hash === '' && !buy)) {
      try { history.replaceState(null, '', buy ? '#buy' : location.pathname + location.search); } catch (e) {}
    }
  }
  function boot() {
    lock(true);
    document.querySelectorAll('.tabs [data-tab]').forEach(function (b) {
      b.addEventListener('click', function () { show(b.dataset.tab); window.scrollTo(0, 0); });
    });
    addEventListener('hashchange', function () { show(location.hash === '#buy' ? 'buy' : 'desk'); });
    show(location.hash === '#buy' ? 'buy' : 'desk');
  }
  function lock(on) {
    ['inCam', 'inGal'].forEach(function (id) { $(id).disabled = on; });
    document.querySelectorAll('#tabBuy .buy-pick label').forEach(function (l) { l.classList.toggle('off', on); });
  }

  /* ---------------- the photograph ---------------- */
  // shrink to 1024 px on the long side: quick to send on a market's mobile signal
  function shrink(file) {
    var url = URL.createObjectURL(file);
    return new Promise(function (ok, bad) {
      var im = new Image();
      im.onload = function () {
        var k = Math.min(1, 1024 / Math.max(im.naturalWidth, im.naturalHeight));
        var c = document.createElement('canvas');
        c.width = Math.round(im.naturalWidth * k); c.height = Math.round(im.naturalHeight * k);
        c.getContext('2d').drawImage(im, 0, 0, c.width, c.height);
        c.toBlob(function (b) { b ? ok({ blob: b, url: url }) : bad(new Error('Could not read that photograph.')); }, 'image/jpeg', 0.85);
      };
      im.onerror = function () { bad(new Error('That file is not a photograph this phone can open.')); };
      im.src = url;
    });
  }

  function compare(blob) {
    var tries = 0;
    function once() {
      return fetch(API + '/api/similar', { method: 'POST', headers: { 'Content-Type': 'image/jpeg' }, body: blob })
        .then(function (r) {
          if ((r.status === 429 || r.status >= 500) && tries < 3) throw { again: true };
          if (!r.ok) throw new Error('The cloud service answered ' + r.status + '.');
          return r.json();
        }, function () { if (tries < 3) throw { again: true }; throw new Error('No connection to the cloud service.'); })
        .catch(function (e) {
          if (!e || !e.again) throw e;
          return new Promise(function (ok) { setTimeout(ok, [1500, 4000, 9000][tries++]); }).then(once);
        });
    }
    return once();
  }

  function take(file) {
    if (!file || !state) return;
    lock(true);
    status('Comparing with your sarees…', 'busy');
    shrink(file).then(function (s) {
      $('queryImg').src = s.url;
      return compare(s.blob);
    }).then(function (j) {
      lock(false);
      if (!j.compared) {
        status('Your photographs are still being prepared for comparing. Try again in a few minutes.', 'err');
        return;
      }
      last = designsFrom(j.matches);
      draw(last, j.compared);
    }).catch(function (e) {
      lock(false);
      status(e.message || String(e), 'err');
    });
  }

  /* ---------------- photographs to designs ---------------- */
  /* A design is as close as its closest photograph. Close-ups of the tag are
     mostly white card and print, so a match on one counts for a little less
     than a match on the cloth itself. */
  var CLOSEUP = 0.03;
  function designsFrom(matches) {
    var by = {};
    matches.forEach(function (m) {
      var p = photos[m.id];
      if (!p || !p.designKey || p.unmapped) return;
      var l = lines[p.designKey];
      if (!l) return;
      var goods = p.how === 'timing' || p.how === 'manual';
      var s = m.score - (goods ? 0 : CLOSEUP);
      var d = by[p.designKey];
      if (!d || s > d.score) by[p.designKey] = { key: p.designKey, line: l, score: s, photo: m.id };
    });
    var list = Object.keys(by).map(function (k) { return by[k]; })
      .sort(function (a, b) { return b.score - a.score; });
    if (!list.length) return [];
    var best = list[0].score;
    // close company only: far behind the best, or simply unalike, is not "looks like it"
    return list.filter(function (d) { return d.score >= Math.max(best - 0.15, 0.6); }).slice(0, MAX);
  }

  /* ---------------- the verdict ---------------- */
  function good(l) { return l.status === 'fast' || l.status === 'steady' || (l.status === 'soldout' && l.sold > 0); }
  function verdictOf(ds) {
    var best = ds[0].score, wsum = 0, wgood = 0, pace = 0, wpace = 0, thru = 0, wthru = 0, votes = {};
    ds.forEach(function (d) {
      // each counts by how close it is: one twice as far behind counts far less
      var w = Math.exp((d.score - best) / 0.04), l = d.line;
      d.weight = w; wsum += w;
      if (good(l)) wgood += w;
      votes[l.status] = (votes[l.status] || 0) + 1;
      if (l.rate != null) { pace += w * l.rate * 7; wpace += w; }
      var cleared = l.sold + l.bal;
      if (cleared > 0) { thru += w * l.sold / cleared; wthru += w; }
    });
    var share = wgood / wsum;
    var count = ds.filter(function (d) { return good(d.line); }).length;
    return {
      share: share, count: count, of: ds.length, votes: votes,
      perWeek: wpace ? pace / wpace : null,
      sellThrough: wthru ? thru / wthru : null,
      close: best >= 0.78 ? 'close' : best >= 0.68 ? 'fair' : 'loose',
      call: share >= 0.6 ? 'buy' : share >= 0.35 ? 'some' : 'skip'
    };
  }

  var CALL = {
    buy: ['Looks like a good buy', 'Sarees like this sell well in your shop.'],
    some: ['Buy a few', 'Sarees like this sell, but not all of them quickly.'],
    skip: ['Think twice', 'Sarees like this have been slow to sell in your shop.']
  };

  function draw(ds, compared) {
    $('buyResult').classList.remove('hidden');
    if (!ds.length) {
      $('buyVerdict').innerHTML = '<div class="v-call loose">No match</div>' +
        '<p>None of the photographs it resembles carries a design code yet, so there are no sales to go on.</p>';
      $('qtyBox').classList.add('hidden');
      $('buyMatches').innerHTML = '';
      $('buyFoot').textContent = 'Compared with the ' + n(tagged) + ' photographs that carry a design code.';
      status('Compared. Nothing similar with sales history.', 'err');
      return;
    }
    var v = verdictOf(ds);
    var c = CALL[v.call];
    var mix = ['fast', 'steady', 'slow', 'dead', 'soldout'].filter(function (k) { return v.votes[k]; })
      .map(function (k) { return '<span class="pill ' + k + '">' + v.votes[k] + ' ' + LBL[k] + '</span>'; }).join(' ');
    $('buyVerdict').innerHTML =
      '<div class="v-call ' + v.call + '">' + c[0] + '</div>' +
      '<p class="v-why">' + c[1] + ' <b>' + v.count + ' of the ' + v.of + '</b> look-alike' + (v.of === 1 ? '' : 's') +
        ' sell' + (v.count === 1 ? 's' : '') + ' well (Fast, Steady or sold out)' +
        (v.of > 1 ? ', and the closest count the most.' : '.') + '</p>' +
      '<div class="v-mix">' + mix + '</div>' +
      '<dl class="v-nums">' +
        '<div><dt>Sell at about</dt><dd>' + (v.perWeek == null ? '—' : n1(v.perWeek)) + '<small> a week</small></dd></div>' +
        '<div><dt>Sold of what came in</dt><dd>' + (v.sellThrough == null ? '—' : Math.round(v.sellThrough * 100) + '%') + '</dd></div>' +
      '</dl>' +
      (v.close === 'loose'
        ? '<p class="v-warn">Nothing in your shop looks very much like this one, so take this as a rough guide only.</p>'
        : v.close === 'fair' ? '<p class="v-note">The matches are fair, not close: a guide, not a promise.</p>' : '');
    $('qtyBox').classList.remove('hidden');
    $('qtyBox').dataset.perWeek = v.perWeek || 0;
    qty();

    $('buyMatches').innerHTML = ds.map(function (d, i) {
      var l = d.line, w = l.cover == null ? (l.bal > 0 ? 'never at this pace' : '—') : Math.round(l.cover) + ' weeks';
      var strength = d.score >= 0.8 ? 'Very close' : d.score >= 0.72 ? 'Close' : 'Similar';
      return '<article class="bm ' + l.status + '">' +
        '<a class="bm-pic" href="' + API + '/api/blob/' + encodeURIComponent(d.photo) + '" target="_blank" rel="noopener">' +
          '<img src="' + API + '/api/blob/' + encodeURIComponent(d.photo) + '" alt="' + esc(l.ref) + '" loading="lazy"></a>' +
        '<div class="bm-body">' +
          '<div class="bm-top"><span class="bm-rank">' + (i + 1) + '</span><span class="bm-ref">' + esc(l.ref) + '</span>' +
            '<span class="pill ' + l.status + '">' + LBL[l.status] + '</span></div>' +
          '<div class="bm-sell">' + esc(l.seller || 'seller not mapped') + ' · <span class="bm-str">' + strength + '</span></div>' +
          '<dl class="bm-nums">' +
            '<div><dt>On hand</dt><dd>' + n(l.bal) + '</dd></div>' +
            '<div><dt>Sold</dt><dd>' + n(l.sold) + '</dd></div>' +
            '<div><dt>A week</dt><dd>' + n1(l.rate * 7) + '</dd></div>' +
            '<div><dt>To clear</dt><dd>' + w + '</dd></div>' +
          '</dl>' +
        '</div></article>';
    }).join('');
    $('buyFoot').textContent = 'Compared with the ' + n(tagged) + ' photographs of your sarees that carry a design code. ' +
      'Each saree’s numbers are its own design’s, from the stock desk. Your photograph was not saved.';
    status('Compared. ' + ds.length + ' similar saree' + (ds.length === 1 ? '' : 's') + ' found.', 'ok');
    $('buyResult').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function qty() {
    var per = +$('qtyBox').dataset.perWeek, q = Math.max(0, Math.round(+$('qty').value || 0));
    if (!q) { $('qtyNote').textContent = ''; return; }
    if (!per) {
      $('qtyNote').textContent = 'Sarees like this have barely sold, so ' + q + ' piece' + (q === 1 ? '' : 's') +
        ' could sit for a long time.';
      return;
    }
    var wk = q / per;
    $('qtyNote').innerHTML = 'At the pace sarees like this sell (about <b>' + n1(per) + ' a week</b>), ' + q +
      ' piece' + (q === 1 ? '' : 's') + ' would take about <b>' +
      (wk < 1.5 ? 'a week' : wk < 9 ? Math.round(wk) + ' weeks' : Math.round(wk / 4.3) + ' months') + '</b> to sell.';
  }

  document.addEventListener('desk:data', take_data);
  $('inCam').addEventListener('change', function () { take(this.files[0]); this.value = ''; });
  $('inGal').addEventListener('change', function () { take(this.files[0]); this.value = ''; });
  $('qty').addEventListener('input', qty);

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
