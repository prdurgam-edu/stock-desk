/* app.js — intake, compute, and everything the page draws. */
(function () {
  'use strict';

  var CFG = window.NARSINGH_CONFIG || {};
  var $ = function (id) { return document.getElementById(id); };
  var state = null, A = null, queue = { xlsx: [], photo: [] };
  var validCodes = {};        // every design code the workbook knows, normalised
  var engineNote = false;
  var thumbByDesign = {};     // designKey -> photo id, for the Saree column
  var filter = { q: '', seller: '', status: '', sort: 'sold', dir: -1, photo: false };
  var linesRows = [], linesShown = 0, linesPhoto = 0, moreObs = null, PAGE = 300;
  var BUILD = '2026-10-14d';   // shown in the footer, so you can tell what is live
  var sellerNames = [];        // every seller in the workbook, for reading batch captions
  var picsByDesign = {};       // designKey -> photo ids, the picture of the goods first
  var photoUrls = {};
  var MDASH = String.fromCharCode(8212);

  /* ---------------- helpers ---------------- */
  function n(v) { return (v == null ? 0 : Math.round(v)).toLocaleString('en-IN'); }
  function n1(v) { return v == null ? MDASH : v.toFixed(1); }
  // no pace at all is not missing data: at this rate the stock never clears
  function wks(v, bal) { return v == null ? (bal > 0 ? 'never' : MDASH) : v > 520 ? '520+' : Math.round(v); }
  function cover(l) { return l.cover == null ? (l.bal > 0 ? 'never clears at this pace' : MDASH)
                                             : wks(l.cover, l.bal) + 'w to clear'; }
  function esc(t) { var d = document.createElement('div'); d.textContent = t == null ? '' : t; return d.innerHTML; }
  function fmtDate(d) {
    if (!d) return MDASH;
    var p = d.split('-'), m = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    return String(+p[2]) + ' ' + m[+p[1] - 1];
  }
  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
  function status(msg, kind) {
    $('statusText').textContent = msg;
    $('statusDot').className = 'dot' + (kind ? ' ' + kind : '');
  }
  function progress(frac) {
    var w = $('progWrap');
    if (frac == null) { w.classList.add('hidden'); return; }
    w.classList.remove('hidden');
    $('progBar').style.width = Math.round(frac * 100) + '%';
  }

  /* ---------------- tooltip ---------------- */
  var tip = $('tip');
  function showTip(html, x, y) {
    tip.innerHTML = html; tip.classList.add('on');
    var r = tip.getBoundingClientRect();
    tip.style.left = Math.min(Math.max(8, x - r.width / 2), innerWidth - r.width - 8) + 'px';
    tip.style.top = Math.max(8, y - r.height - 12) + 'px';
  }
  function hideTip() { tip.classList.remove('on'); }

  /* ---------------- charts ---------------- */
  function lineChart(host, pts) {
    if (!pts.length) { host.innerHTML = '<p class="muted">No daily files yet.</p>'; return; }
    var W = Math.max(320, host.clientWidth || 560), H = 230;
    var padL = 42, padR = 12, padT = 14, padB = 30;
    var iw = W - padL - padR, ih = H - padT - padB;
    var max = Math.max.apply(null, pts.map(function (p) { return p.out; })) || 1;
    max = Math.ceil(max / 4) * 4 || 4;
    var x = function (i) { return padL + (pts.length === 1 ? iw / 2 : i / (pts.length - 1) * iw); };
    var y = function (v) { return padT + ih - (v / max) * ih; };

    var d = pts.map(function (p, i) { return (i ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(p.out).toFixed(1); }).join(' ');
    var area = d + ' L' + x(pts.length - 1).toFixed(1) + ' ' + (padT + ih) + ' L' + x(0).toFixed(1) + ' ' + (padT + ih) + ' Z';

    var ticks = [0, max / 2, max].map(function (v) {
      return '<line class="grid" x1="' + padL + '" x2="' + (W - padR) + '" y1="' + y(v) + '" y2="' + y(v) + '"/>' +
             '<text class="axis" x="' + (padL - 7) + '" y="' + (y(v) + 3.5) + '" text-anchor="end">' + n(v) + '</text>';
    }).join('');

    var every = Math.max(1, Math.ceil(pts.length / 7));
    var xlab = pts.map(function (p, i) {
      return (i % every === 0 || i === pts.length - 1)
        ? '<text class="axis" x="' + x(i) + '" y="' + (H - 9) + '" text-anchor="middle">' + fmtDate(p.date) + '</text>' : '';
    }).join('');

    var dots = pts.map(function (p, i) {
      return '<circle class="pt" cx="' + x(i) + '" cy="' + y(p.out) + '" r="' + (pts.length > 40 ? 2 : 3.6) + '"/>';
    }).join('');

    var hits = pts.map(function (p, i) {
      var w = pts.length === 1 ? iw : iw / (pts.length - 1);
      return '<rect class="hit" x="' + (x(i) - w / 2) + '" y="' + padT + '" width="' + w + '" height="' + ih +
             '" data-i="' + i + '"/>';
    }).join('');

    host.innerHTML = '<svg class="chart" viewBox="0 0 ' + W + ' ' + H + '" role="img" ' +
      'aria-label="Pieces sold per day across ' + pts.length + ' recorded days">' +
      ticks + '<path class="area" d="' + area + '"/><path class="line" d="' + d + '"/>' +
      dots + xlab + hits + '</svg>';

    host.querySelectorAll('.hit').forEach(function (el) {
      el.addEventListener('mouseenter', function (e) {
        var p = pts[+el.dataset.i], r = el.getBoundingClientRect();
        showTip('<b>' + fmtDate(p.date) + '</b><br>' + n(p.out) + ' pieces out' +
                (p.in ? '<br>' + n(p.in) + ' in' : ''), r.left + r.width / 2, r.top + 40);
      });
      el.addEventListener('mouseleave', hideTip);
    });
  }

  function sparkline(series) {
    if (!series || !series.length) return '';
    var W = 74, H = 22, max = Math.max.apply(null, series) || 1;
    var x = function (i) { return series.length === 1 ? W / 2 : i / (series.length - 1) * W; };
    var y = function (v) { return H - 2 - (v / max) * (H - 5); };
    var d = series.map(function (v, i) { return (i ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(v).toFixed(1); }).join(' ');
    var fill = d + ' L' + W + ' ' + H + ' L0 ' + H + ' Z';
    return '<svg class="spark" width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H +
      '" preserveAspectRatio="none" aria-hidden="true">' +
      '<path class="fillp" d="' + fill + '"/><path d="' + d + '"/></svg>';
  }

  /* ---------------- rendering ---------------- */
  var LBL = { fast: 'Fast', steady: 'Steady', slow: 'Slow', dead: 'Dead', soldout: 'Sold out' };

  function render() {
    if (!A || !A.lines.length) {
      $('results').classList.add('hidden'); $('blank').classList.remove('hidden'); return;
    }
    $('blank').classList.add('hidden'); $('results').classList.remove('hidden');

    var stuck = A.pieces.slow + A.pieces.dead;
    $('headline').innerHTML = [
      ['Stock on hand', n(A.onHand), n(A.lines.length) + ' design lines'],
      ['Sold in the days recorded', n(A.soldObs), A.observedDays + (A.observedDays === 1 ? ' day' : ' days') + ' of files'],
      ['Clearing fast', n(A.pieces.fast), 'under ' + A.fastWeeks + ' weeks'],
      ['Slow or dead', n(stuck), A.onHand ? Math.round(stuck / A.onHand * 100) + '% of the floor' : '', 'alarm'],
      ['As of', fmtDate(A.asOf), A.asOf ? A.asOf.slice(0, 4) : '']
    ].map(function (h) {
      return '<div class="hl' + (h[3] ? ' ' + h[3] : '') + '"><div class="k">' + h[0] + '</div>' +
        '<div class="v num">' + h[1] + '</div><div class="n">' + esc(h[2]) + '</div></div>';
    }).join('');

    $('trendQual').textContent = A.observedDays + ' day' + (A.observedDays === 1 ? '' : 's') + ' recorded';
    lineChart($('trendChart'), A.trend);

    $('tiles').innerHTML = ['fast', 'steady', 'slow', 'dead'].map(function (k) {
      return '<button class="tile ' + k + '" type="button" data-s="' + k + '" aria-pressed="' +
        (filter.status === k) + '"><div class="v num">' + n(A.pieces[k]) + '</div>' +
        '<div class="k">' + LBL[k] + ' &middot; ' + n(A.counts[k]) + ' lines</div></button>';
    }).join('');
    $('tiles').querySelectorAll('.tile').forEach(function (b) {
      b.addEventListener('click', function () {
        filter.status = filter.status === b.dataset.s ? '' : b.dataset.s;
        render();
      });
    });
    $('tilesNote').textContent = A.basis === 'daily'
      ? 'Pace is measured from the ' + A.observedDays + ' daily files on record.'
      : 'Pace still comes from the full-period export. Upload ' + (Compute.MIN_DAILY_DAYS - A.observedDays) +
        ' more daily file(s) and it switches to real daily movement.';

    $('linesQual').textContent = A.basis === 'daily' ? 'daily pace' : 'period pace';

    var sel = $('sellerFilter'), cur = sel.value;
    sel.innerHTML = '<option value="">Every seller</option>' + A.sellers.map(function (s) {
      return '<option value="' + esc(s.seller) + '">' + esc(s.seller) + '</option>';
    }).join('');
    sel.value = cur;

    buildThumbIndex();      // must precede renderLines, which reads it
    renderLines();
    renderSellers();
    renderPhotos();

    $('foot').innerHTML =
      esc(CFG.shopName || '') + ' &middot; ' + esc(CFG.shopPlace || '') + '<br>' +
      state.files.length + ' file(s) on record &middot; history kept in ' + esc(Store.label) +
      ' &middot; seller map covers ' + n(A.mappedSellers) + ' designs<br>' +
      'Build ' + BUILD + ' &middot; tags read by ' + esc(Matcher.engine || 'hand') + '<br>' +
      'Slow means stock needs more than ' + A.slowWeeks + ' weeks to clear at its current pace. Fast means under ' + A.fastWeeks + '.';
  }

  function visibleLines() {
    var q = filter.q.trim().toLowerCase();
    var rows = A.lines.filter(function (l) {
      if (filter.status && l.status !== filter.status) return false;
      if (filter.seller && (l.seller || 'Not yet mapped') !== filter.seller) return false;
      if (filter.photo && !thumbByDesign[l.key]) return false;
      if (q && (l.ref + ' ' + l.seller).toLowerCase().indexOf(q) < 0) return false;
      return true;
    });
    var k = filter.sort, dir = filter.dir;
    if (k === 'all') { k = 'ref'; dir = 1; }      // every line, in design-code order
    rows.sort(function (a, b) {
      var va, vb;
      if (k === 'ref' || k === 'seller') {
        va = (a[k] || '').toLowerCase(); vb = (b[k] || '').toLowerCase();
        return va < vb ? -dir : va > vb ? dir : 0;
      }
      if (k === 'sold') { va = a.soldObs; vb = b.soldObs; }
      else if (k === 'idle') { va = a.idle == null ? 1e9 : a.idle; vb = b.idle == null ? 1e9 : b.idle; }
      else if (k === 'cover') { va = a.cover == null ? 1e9 : a.cover; vb = b.cover == null ? 1e9 : b.cover; }
      else { va = a[k] || 0; vb = b[k] || 0; }
      return (va - vb) * dir;
    });
    return rows;
  }

  function renderLines() {
    var withPhoto = A.lines.filter(function (l) { return thumbByDesign[l.key]; }).length;
    var pb = $('photoOnly');
    pb.classList.toggle('hidden', !withPhoto);
    pb.setAttribute('aria-pressed', String(filter.photo));
    pb.querySelector('.count').textContent = withPhoto;
    linesRows = visibleLines();
    linesShown = 0;
    linesPhoto = withPhoto;
    $('linesBody').innerHTML = '';
    appendLines();
  }

  function lineRow(l) {
    var pid = thumbByDesign[l.key];
    // design and seller sit under the photograph, which leaves the picture the
    // width two columns of text used to take
    var more = pid ? (picsByDesign[l.key] || []).length - 1 : 0;
    return '<tr class="' + l.status + (pid ? ' haspic' : '') + '">' +
      '<td class="thumb">' + (pid
        ? '<span class="pic"><img data-pid="' + esc(pid) + '" data-big="1" data-design="' + esc(l.key) +
          '" alt="' + esc(l.ref) + '">' +
          (more > 0 ? '<span class="morepics" aria-hidden="true">+' + more + '</span>' : '') + '</span>'
        : '<span class="none" title="No photograph linked yet"></span>') +
        '<span class="ref">' + esc(l.ref) + '</span>' +
        '<span class="sell">' + esc(l.seller || 'seller not mapped') + '</span></td>' +
      '<td>' + sparkline(l.series) + '</td>' +
      '<td class="r m">' + n(l.bal) + '</td>' +
      '<td class="r m">' + n(l.soldObs) + '</td>' +
      '<td class="r m">' + n1(l.rate) + '</td>' +
      '<td class="r m">' + wks(l.cover, l.bal) + '</td>' +
      '<td class="r m">' + (l.idle == null ? MDASH : l.idle) + '</td>' +
      '<td><span class="pill ' + l.status + '">' + LBL[l.status] + '</span></td></tr>';
  }

  /* Fourteen thousand rows at once would lock the page for seconds, so they
     arrive a page at a time \u2014 on their own as you reach the end of what is
     there, or on the button if you would rather not scroll. */
  function appendLines() {
    var body = $('linesBody'), old = document.getElementById('moreRow');
    if (old) old.remove();
    if (moreObs) { moreObs.disconnect(); moreObs = null; }

    // the first page stays small so the table appears at once; later ones grow,
    // so reaching the end of fourteen thousand lines is a few scrolls, not fifty
    var step = linesShown ? Math.min(linesShown * 2, 2400) : PAGE;
    var next = linesRows.slice(linesShown, linesShown + step);
    if (next.length) {
      body.insertAdjacentHTML('beforeend', next.map(lineRow).join(''));
      linesShown += next.length;
    }

    var left = linesRows.length - linesShown;
    if (left > 0) {
      body.insertAdjacentHTML('beforeend',
        '<tr id="moreRow"><td colspan="8" class="morecell">' +
        '<button type="button" class="iconbtn" id="moreBtn">Show more' +
        ' <span class="count">' + n(left) + ' left</span></button></td></tr>');
      document.getElementById('moreBtn').addEventListener('click', appendLines);
      if (window.IntersectionObserver) {
        moreObs = new IntersectionObserver(function (es) {
          if (es.some(function (e) { return e.isIntersecting; })) appendLines();
        }, { rootMargin: '600px' });
        moreObs.observe(document.getElementById('moreRow'));
      }
    }

    $('lineCount').textContent = (left > 0
      ? 'showing ' + n(linesShown) + ' of ' + n(linesRows.length) + ' lines'
      : n(linesRows.length) + ' line' + (linesRows.length === 1 ? '' : 's')) +
      (linesPhoto && !filter.photo ? ' ' + MDASH + ' ' + linesPhoto + ' with a photograph' : '');

    hydrate(body);
  }

  /* fill every <img data-pid> from storage, once per photo */
  function hydrate(root) {
    root.querySelectorAll('img[data-pid]').forEach(function (img) {
      var id = img.dataset.pid;
      if (photoUrls[id]) { img.src = photoUrls[id]; return; }
      Store.backend.getBlobUrl(id).then(function (u) {
        if (u) { photoUrls[id] = u; img.src = u; }
      }).catch(function () {});
    });
  }

  function renderSellers() {
    $('sellerBody').innerHTML = A.sellers.slice(0, 60).map(function (s) {
      return '<tr class="' + s.status + '">' +
        '<td class="m">' + esc(s.seller) + '</td>' +
        '<td>' + sparkline(s.series) + '</td>' +
        '<td class="r m">' + n(s.lines) + '</td>' +
        '<td class="r m">' + n(s.bal) + '</td>' +
        '<td class="r m">' + n(s.soldObs) + '</td>' +
        '<td class="r m">' + n1(s.rate) + '</td>' +
        '<td class="r m">' + wks(s.cover, s.bal) + '</td>' +
        '<td><span class="pill ' + s.status + '">' + LBL[s.status] + '</span></td></tr>';
    }).join('');
  }

  /* A photograph is resolved when it carries a design code, whether the reader
     read it or a person typed it. Resolved ones leave Tag photographs: the
     automatic ones show in the Saree column, the hand-linked ones in
     Manually mapped, where a wrong one can be undone. */
  function isManual(p) { return p.designKey && p.source === 'manual'; }
  function isAuto(p) { return p.designKey && p.source !== 'manual'; }
  // a label a person removed is theirs to decide: it waits in Manually
  // unmapped, and nothing automatic reads it again or links it elsewhere
  function isUnmapped(p) { return !p.designKey && !!p.unmapped; }
  function isPending(p) { return !p.designKey && !p.unmapped; }

  var ST_LABEL = { match: 'Read off the tag', check: 'Check', ambiguous: 'Ambiguous',
                   nomatch: 'No match', error: 'Error', manual: 'Linked by hand', unmapped: 'Unmapped by you' };
  // how an automatic label was arrived at, as the card's badge says it
  var HOW_LABEL = { timing: 'Same piece', barcode: 'Same barcode', 'read+seller': 'Read + caption' };

  function photoCard(p, mode) {
    var l = p.designKey && A.lines.filter(function (x) { return x.key === p.designKey; })[0];
    var st = mode === 'mapped' ? 'manual' : mode === 'auto' ? 'match' : (p.status || 'nomatch');
    if (mode === 'unmapped') st = 'unmapped';
    var badge = mode === 'auto' && HOW_LABEL[p.how] ? HOW_LABEL[p.how] : (ST_LABEL[st] || st);
    var body;

    if (mode === 'auto') {
      // a stack shot carries no tag of its own, so show the close-up it was
      // matched to: the check is whether the two are the same cloth
      var partner = p.how === 'timing' && p.linkedTo && photoById(p.linkedTo);
      body = '<div class="d">' + esc(l ? l.ref : p.designKey) + '</div>' +
        '<div class="s">' + (l ? n(l.bal) + ' on hand ' + MDASH + ' ' + cover(l)
                               : 'not in the current workbook') + '</div>' +
        (partner ? '<div class="partner"><img data-pid="' + esc(partner.id) + '" data-big="1" alt="close-up">' +
                   '<span>The close-up it was matched to. Same cloth?</span></div>' : '') +
        (p.message ? '<div class="why">' + esc(p.message) + '</div>' : '') +
        (p.conf != null ? '<div class="why">Reader confidence ' + Math.round(p.conf * 100) + '%.</div>' : '') +
        '<div class="row"><button class="unlink" data-unlink="' + esc(p.id) + '" type="button">Wrong ' + MDASH + ' unmap it</button></div>';
    } else if (mode === 'unmapped') {
      var u = p.unmapped, was = (state.refs || {})[u.code] || u.code;
      var gone = !validCodes[u.code];
      var buddy = u.how === 'timing' && u.linkedTo && photoById(u.linkedTo);
      body = '<div class="d">Was ' + esc(was) + '</div>' +
        '<div class="s">Removed from ' + (u.was === 'manual' ? 'Manually mapped' : 'System labeled') +
          (u.at ? ' &middot; ' + esc(when(u.at)) : '') + '</div>' +
        (buddy ? '<div class="partner"><img data-pid="' + esc(buddy.id) + '" data-big="1" alt="close-up">' +
                 '<span>It had been matched to this close-up.</span></div>' : '') +
        '<div class="row"><button class="mapback" data-mapback="' + esc(p.id) + '" type="button"' +
          (gone ? ' disabled title="' + esc(was) + ' is not in the current workbook"' : '') + '>Map back to ' + esc(was) + '</button></div>' +
        '<div class="row"><input type="text" list="designList" placeholder="Other code" ' +
          'data-code-for="' + esc(p.id) + '" autocomplete="off" spellcheck="false">' +
          '<button class="link" data-link="' + esc(p.id) + '" type="button" disabled>Link</button></div>';
    } else if (mode === 'mapped') {
      body = '<div class="d">' + esc(l ? l.ref : p.designKey) + '</div>' +
        '<div class="s">' + (l ? n(l.bal) + ' on hand &middot; ' + cover(l)
                               : 'not in the current workbook') + '</div>' +
        '<div class="row"><button class="unlink" data-unlink="' + esc(p.id) + '" type="button">Remove this mapping</button></div>';
    } else {
      var cands = (p.candidates || []).filter(function (c) { return validCodes[Compute.normKey(c)]; });
      // when the choice is between close-ups sent beside this photograph, show
      // them on the buttons: picking is then a matter of matching the cloth
      var face = {};
      (p.linkCands || []).forEach(function (x) { if (!face[x.code]) face[x.code] = x.id; });
      body = '<div class="d">' + esc(p.name.replace(/\.[a-z]+$/i, '').slice(0, 30)) + '</div>' +
        (p.message ? '<div class="why">' + esc(p.message) + '</div>' : '') +
        (cands.length ? '<div class="cand">' + cands.slice(0, 4).map(function (c) {
            var ref = (state.refs || {})[Compute.normKey(c)] || c;
            return '<button type="button" data-use="' + esc(p.id) + '" data-code="' + esc(c) + '"' +
              (face[c] ? ' class="withpic"' : '') + '>' +
              (face[c] ? '<img data-pid="' + esc(face[c]) + '" alt="">' : '') + esc(ref) + '</button>';
          }).join('') + '</div>' : '') +
        '<div class="row"><input type="text" list="designList" placeholder="Design code" ' +
          'data-code-for="' + esc(p.id) + '" autocomplete="off" spellcheck="false">' +
          '<button class="link" data-link="' + esc(p.id) + '" type="button" disabled>Link</button></div>';
    }
    return '<figure class="ph" style="margin:0">' +
      '<img data-pid="' + esc(p.id) + '" data-big="1" alt="' + esc(p.name) + '">' +
      '<figcaption class="cap"><span class="st ' + st + '">' + esc(badge) + '</span>' +
      body + '</figcaption></figure>';
  }

  function buildThumbIndex() {
    thumbByDesign = {}; picsByDesign = {};
    var groups = {};
    (state.photos || []).forEach(function (p) {
      if (p.designKey) (groups[p.designKey] || (groups[p.designKey] = [])).push(p);
    });
    Object.keys(groups).forEach(function (k) {
      var ordered = window.Pieces ? Pieces.order(groups[k]) : groups[k];
      picsByDesign[k] = ordered.map(function (p) { return p.id; });
      thumbByDesign[k] = picsByDesign[k][0];
    });
  }

  function renderPhotos() {
    var list = state.photos || [];
    var pending = list.filter(isPending), mapped = list.filter(isManual), auto = list.filter(isAuto);
    var unmapped = list.filter(isUnmapped);
    buildThumbIndex();

    if (!document.getElementById('designList')) {
      var dl = document.createElement('datalist');
      dl.id = 'designList';
      document.body.appendChild(dl);
    }
    document.getElementById('designList').innerHTML = A.lines.slice(0, 4000)
      .map(function (l) { return '<option value="' + esc(l.ref) + '">'; }).join('');

    $('photoHead').innerHTML = 'Tag photographs <span class="qual">' + pending.length + ' awaiting a code</span>';
    $('photoNote').textContent = !list.length
      ? 'No photographs yet. Drop a WhatsApp zip above.'
      : Matcher.configured
        ? 'Only the undecided ones are here. The rest are below, under System labeled and Manually mapped.'
        : 'No tag reader is available, so codes are typed in here.';
    $('photoControls').classList.toggle('hidden', !pending.length || !Matcher.configured);
    if (Matcher.configured && !engineNote) {
      engineNote = true;
      Matcher.ping().then(function (p) {
        if (!p) return;
        $('matchProg').textContent = p.engine + '.';
      });
    }
    $('photos').innerHTML = pending.length
      ? pending.slice(0, 60).map(function (p) { return photoCard(p, 'pending'); }).join('')
      : (list.length ? '<p class="muted">' + (unmapped.length
          ? 'Nothing undecided. The photographs you unmapped are below, under Manually unmapped.'
          : 'Every photograph has a design code.') + '</p>' : '');

    $('autoHead').innerHTML = 'System labeled <span class="qual">' + auto.length + '</span>';
    $('autoNote').textContent = auto.length
      ? 'Tagged by the reader without anyone confirming it. A code read confidently but wrongly would hide here, so these are the ones worth spot-checking against the photograph.'
      : (Matcher.configured ? 'Nothing has been tagged automatically yet.'
                            : 'The tag reader is not available, so nothing can be tagged automatically.');
    $('autolist').innerHTML = auto.length
      ? auto.slice(-60).reverse().map(function (p) { return photoCard(p, 'auto'); }).join('')
      : '';

    var restorable = list.filter(function (p) { return !p.designKey && p.prev && p.prev.designKey; }).length;
    $('restoreCount').textContent = restorable;
    $('refreshAuto').title = restorable
      ? restorable + ' removed label(s) can be put back exactly as the reader left them'
      : 'Read the undecided tags again';
    $('autoControls').classList.toggle('hidden', !list.length);

    $('mappedHead').innerHTML = 'Manually mapped <span class="qual">' + mapped.length + '</span>';
    $('mappedNote').textContent = mapped.length
      ? 'Linked by hand rather than read off the tag. Remove one if it went to the wrong design; the photograph returns to Tag photographs.'
      : 'Nothing has been linked by hand yet.';
    $('mapped').innerHTML = mapped.length
      ? mapped.slice(-60).reverse().map(function (p) { return photoCard(p, 'mapped'); }).join('')
      : '';

    $('unmappedHead').innerHTML = 'Manually unmapped <span class="qual">' + unmapped.length + '</span>';
    $('unmappedNote').textContent = unmapped.length
      ? 'Labels you removed. Nothing automatic reads these again or links them elsewhere. ' +
        'Map one back if removing it was a mistake, or give it the right code.'
      : 'Nothing unmapped. Remove a label in System labeled or Manually mapped and it waits here.';
    // the most recently unmapped first
    $('unmapped').innerHTML = unmapped.slice().sort(function (a, b) {
        return (b.unmapped.at || '') < (a.unmapped.at || '') ? -1 : 1;
      }).slice(0, 60).map(function (p) { return photoCard(p, 'unmapped'); }).join('');

    wirePhotoCards();
    hydrate($('photos')); hydrate($('autolist')); hydrate($('mapped')); hydrate($('unmapped'));
  }

  function photoById(id) {
    return (state.photos || []).filter(function (x) { return x.id === id; })[0];
  }
  /* Refresh: put back anything the reader had labelled and someone removed.
     A remembered tag is restored as it was; a photograph with nothing
     remembered is read again. */
  function refreshAuto() {
    var list = state.photos || [];
    var restorable = list.filter(function (p) { return !p.designKey && p.prev && p.prev.designKey; });
    var unread = list.filter(function (p) { return isPending(p) && !(p.prev && p.prev.designKey); });

    restorable.forEach(function (p) {
      p.designKey = p.prev.designKey; p.source = 'ocr';
      p.status = p.prev.status || 'match'; p.message = p.prev.message; p.conf = p.prev.conf;
      p.how = p.prev.how || null; p.linkedTo = p.prev.linkedTo || null; p.linkDt = p.prev.linkDt || null;
      if (window.Pieces) Pieces.unreject(p, p.designKey);   // putting it back is a change of mind
      delete p.prev; delete p.unmapped;
    });
    linkPieces();

    var done = function () {
      return Store.backend.save(state).then(function () {
        renderPhotos(); renderLines();
        var bits = [];
        if (restorable.length) bits.push(restorable.length + ' put back');
        if (Matcher.configured && unread.length) bits.push(unread.length + ' re-read');
        status(bits.length ? 'Refreshed ' + MDASH + ' ' + bits.join(', ') + '.'
                           : 'Nothing to put back.', 'ok');
        $('autoProg').textContent = '';
        $('refreshAuto').disabled = false;
      });
    };

    $('refreshAuto').disabled = true;
    if (restorable.length) {
      renderPhotos(); renderLines();
      // what was put back is saved now, not after the slower re-reading below
      Store.backend.save(state).catch(function () {});
    }
    if (!Matcher.configured || !unread.length) return done();

    Matcher.retry();
    $('autoProg').textContent = 'Reading ' + unread.length + ' tag(s) again...';
    status('Reading ' + unread.length + ' tag(s) again...', 'busy');
    return runMatcher(unread).then(done);
  }

  function assign(id, code) {
    var p = photoById(id); if (!p) return;
    var key = Compute.normKey(code);
    if (!validCodes[key]) return;
    p.designKey = key; p.source = 'manual'; p.status = 'manual'; p.how = 'manual';
    p.linkedTo = null; p.linkCands = null; p.linkNote = false;
    delete p.unmapped; delete p.prev;
    p.message = null; p.candidates = null;
    if (window.Pieces) Pieces.unreject(p, key);
    // a close-up confirmed by hand brings the stack shot sent beside it along
    linkPieces();
    Store.backend.save(state).then(function () { renderPhotos(); renderLines(); });
  }
  function unassign(id) {
    var p = photoById(id); if (!p) return;
    var wasAuto = p.source === 'ocr', code = p.designKey;
    // keep what the reader decided: restoring it later costs nothing and
    // gives back the same answer, where re-reading the tag might not
    if (wasAuto) {
      p.prev = { designKey: p.designKey, status: p.status, message: p.message, conf: p.conf,
                 how: p.how || null, linkedTo: p.linkedTo || null, linkDt: p.linkDt || null };
    }
    // and never make the same pairing again on its own
    if (window.Pieces) Pieces.reject(p, code);
    // what it was, so it can be mapped straight back from Manually unmapped
    p.unmapped = { code: code, was: wasAuto ? 'auto' : 'manual', how: p.how || null,
                   linkedTo: p.linkedTo || null, linkDt: p.linkDt || null,
                   status: p.status, message: p.message, conf: p.conf == null ? null : p.conf,
                   at: new Date().toISOString() };
    p.designKey = null; p.source = null; p.status = 'nomatch'; p.how = null; p.linkedTo = null;
    p.linkNote = false; p.linkCands = null; p.candidates = null;
    p.message = wasAuto
      ? 'Rejected after review. Type the right code, or read the codes again.'
      : 'Mapping removed. Link it again or read the codes once more.';
    p.ocr = { status: p.status, message: p.message, candidates: null, conf: null };
    // a stack shot linked to this close-up goes back for review with it
    linkPieces();
    Store.backend.save(state).then(function () { renderPhotos(); renderLines(); });
  }

  /* Undo an unmapping: the label comes back exactly as it was — read, twinned,
     confirmed by caption, linked to its close-up, or typed by hand — and the
     photograph returns to the section it came from. */
  function mapBack(id) {
    var p = photoById(id), u = p && p.unmapped;
    if (!u || !validCodes[u.code]) return;
    if (window.Pieces) Pieces.unreject(p, u.code);
    var partner = u.how === 'timing' && u.linkedTo && photoById(u.linkedTo);
    // a stack shot whose close-up no longer carries this code cannot be a
    // timing link any more; mapping it back is then a person's decision
    var asManual = u.was === 'manual' || (u.how === 'timing' && !(partner && partner.designKey === u.code));
    p.designKey = u.code; p.candidates = null; p.linkCands = null; p.linkNote = false;
    if (asManual) {
      p.source = 'manual'; p.status = 'manual'; p.how = 'manual'; p.linkedTo = null; p.linkDt = null;
      p.message = null;
    } else {
      p.source = 'ocr'; p.how = u.how || 'read'; p.linkedTo = u.linkedTo || null; p.linkDt = u.linkDt || null;
      p.status = u.status || 'match'; p.message = u.message || null; p.conf = u.conf == null ? null : u.conf;
    }
    delete p.unmapped; delete p.prev;
    linkPieces();   // a close-up mapped back brings its stack shot with it
    Store.backend.save(state).then(function () { renderPhotos(); renderLines(); });
    status((state.refs[u.code] || u.code) + ' mapped back' + (asManual ? ', under Manually mapped.' : ', under System labeled.'), 'ok');
  }
  function when(iso) {
    var d = new Date(iso);
    if (isNaN(d)) return '';
    var m = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    return d.getDate() + ' ' + m[d.getMonth()] + ', ' + String(d.getHours()).padStart(2, '0') + ':' +
           String(d.getMinutes()).padStart(2, '0');
  }

  function wirePhotoCards() {
    document.querySelectorAll('[data-use]').forEach(function (b) {
      b.addEventListener('click', function () { assign(b.dataset.use, b.dataset.code); });
    });
    document.querySelectorAll('[data-unlink]').forEach(function (b) {
      b.addEventListener('click', function () { unassign(b.dataset.unlink); });
    });
    document.querySelectorAll('[data-mapback]').forEach(function (b) {
      b.addEventListener('click', function () { mapBack(b.dataset.mapback); });
    });
    document.querySelectorAll('[data-code-for]').forEach(function (inp) {
      var btn = document.querySelector('[data-link="' + inp.dataset.codeFor + '"]');
      function check() {
        var ok = !!validCodes[Compute.normKey(inp.value)];
        btn.disabled = !ok;
        inp.classList.toggle('bad', inp.value.length > 2 && !ok);
      }
      inp.addEventListener('input', check);
      inp.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' && !btn.disabled) assign(inp.dataset.codeFor, inp.value);
      });
      btn.addEventListener('click', function () { assign(inp.dataset.codeFor, inp.value); });
    });
  }

  /* ---------------- automatic tagging ---------------- */
  function runMatcher(photos) {
    if (!Matcher.configured || !photos.length) return Promise.resolve();
    $('matchProg').textContent = 'Reading 0 of ' + photos.length + '...';
    return Matcher.matchMany(photos, getBlobFor, validCodes,
      function (i, total, p, res) {
        // the reader reports its own first-time load through the same callback
        if (!p) { $('matchProg').textContent = res.loading || ''; status(res.loading || '', 'busy'); return; }
        $('matchProg').textContent = 'Reading ' + i + ' of ' + total + '...';
        p.status = res.status;
        p.barcode = res.barcode || null;   // reliable, and useful the day a barcode-to-design list exists
        p.message = res.message || null;
        p.candidates = res.candidates || null;
        p.conf = res.confidence == null ? null : res.confidence;
        // the reader's own verdict, kept apart from anything linking adds later
        p.ocr = { status: p.status, message: p.message, candidates: p.candidates, conf: p.conf };
        p.linkNote = false; p.linkCands = null;
        if (res.status === Matcher.STATUS.MATCH && res.code && validCodes[res.code] &&
            !(p.rejected || []).some(function (k) { return k === res.code; })) {
          p.designKey = res.code; p.source = 'ocr'; p.how = 'read';
        }
      }, getBook).then(function () {
        $('matchProg').textContent = '';
        byBarcode();
        linkPieces();
        return Store.backend.save(state);
      });
  }

  /* The same piece usually gets photographed twice: once showing the goods and
     once up close. The 11-digit barcode under the design code is large, printed
     in a clean font, and comes out right far more often than the code itself \u2014
     so when a photograph carries a barcode that another, already-tagged
     photograph carries too, it is the same piece and takes the same code. This
     is an identity, not a guess. */
  function byBarcode() {
    var list = state.photos || [], known = {}, i, p;
    for (i = 0; i < list.length; i++) {
      p = list[i];
      if (p.barcode && p.designKey && !known[p.barcode]) known[p.barcode] = p.designKey;
    }
    for (i = 0; i < list.length; i++) {
      p = list[i];
      if (p.designKey || p.unmapped || !p.barcode || !known[p.barcode]) continue;
      if ((p.rejected || []).indexOf(known[p.barcode]) >= 0) continue;
      p.designKey = known[p.barcode];
      p.source = 'ocr';
      p.how = 'barcode';
      p.status = Matcher.STATUS.MATCH;
      p.conf = 1;
      p.candidates = null;
      p.message = 'Code ' + p.designKey + ' \u2014 same barcode (' + p.barcode +
                  ') as another photograph of this piece.';
    }
  }
  function getBook() {
    if (!state.bookFile) return null;
    return getBlobFor('bookfile').then(function (blob) {
      return blob ? { blob: blob, name: state.bookFile.name } : null;
    });
  }
  function getBlobFor(id) {
    return Store.backend.getBlobUrl(id).then(function (u) {
      return u ? fetch(u).then(function (r) { return r.blob(); }) : null;
    }).catch(function () { return null; });
  }

  function renderFiles() {
    var f = (state.files || []).slice().sort(function (a, b) { return a.addedAt < b.addedAt ? 1 : -1; });
    $('fileCount').textContent = f.length;
    $('filesBody').innerHTML = f.length ? f.map(function (x) {
      return '<tr><td class="m">' + esc(x.name) + (x.sheet && x.sheet !== 'ASR GS'
          ? ' <span class="muted">(' + esc(x.sheet) + ')</span>' : '') + '</td>' +
        '<td><span class="kind ' + x.kind + '">' + (x.kind === 'daily' ? 'Daily' : 'Full period') + '</span></td>' +
        '<td class="m">' + (x.kind === 'daily' ? fmtDate(x.from)
            : fmtDate(x.from) + ' to ' + fmtDate(x.asOf || x.to) +
              (x.to && x.asOf && x.to !== x.asOf ? ' <span class="muted">(book ends ' + fmtDate(x.to) + ')</span>' : '')) + '</td>' +
        '<td class="r m">' + n(x.lines) + '</td>' +
        '<td class="r m">' + n(x.totalIn) + '</td>' +
        '<td class="r m">' + n(x.totalOut) + '</td>' +
        '<td class="m">' + esc(x.addedAt.slice(0, 10)) + '</td>' +
        '<td class="rmcell"><button class="linkbtn" data-rm="' + esc(x.id) + '" type="button">Remove</button></td></tr>';
    }).join('') : '<tr><td colspan="8" class="empty">No files uploaded yet.</td></tr>';

    $('filesFoot').textContent = f.length
      ? f.filter(function (x) { return x.kind === 'daily'; }).length + ' daily, ' +
        f.filter(function (x) { return x.kind === 'master'; }).length + ' full-period. Stored in ' + Store.label + '.'
      : 'Stored in ' + Store.label + '.';

    // Asked on the page, not with the browser's confirm box: that box is
    // blocked inside embedded previews, where the click then did nothing.
    $('filesBody').querySelectorAll('[data-rm]').forEach(function (b) {
      b.addEventListener('click', function () {
        var cell = b.parentNode, id = b.dataset.rm;
        cell.innerHTML = '<span class="rmask">Remove? ' +
          '<button type="button" class="linkbtn" data-yes>Yes</button> ' +
          '<button type="button" class="linkbtn keep" data-no>Keep</button></span>';
        cell.querySelector('[data-yes]').addEventListener('click', function () { removeFile(id); });
        cell.querySelector('[data-no]').addEventListener('click', renderFiles);
      });
    });
  }

  /* ---------------- rebuild after a removal ---------------- */
  /* Removing a file rebuilds everything from the workbooks that remain, read
     again exactly as they were uploaded. Totals, the balance snapshot and the
     seller map then come out as if the removed file had never been loaded —
     which merged totals alone cannot do, since they no longer know which file
     contributed what. */
  function removeFile(id) {
    var f = state.files.filter(function (x) { return x.id === id; })[0];
    if (!f) return;
    $('filesFoot').textContent = 'Removing ' + f.name + ' and recomputing from the files that remain' + MDASH;
    status('Removing ' + f.name + ' and recomputing from the files that remain...', 'busy');
    rebuildWithout(id).then(function (fresh) {
      if (!fresh) return legacyRemove(f);
      state = fresh;
      return persistAndDraw().then(function () {
        status('Removed ' + f.name + '. Everything recomputed from the ' + state.files.length +
               ' file(s) that remain.', 'ok');
      });
    }).catch(function () { return legacyRemove(f); });
  }

  function rebuildWithout(id) {
    var keep = state.files.filter(function (x) { return x.id !== id; });
    if (!Store.backend.getRaw || keep.some(function (x) { return !x.rawId; })) return Promise.resolve(null);

    // one workbook can have given several sheets; read each workbook once, in upload order
    var groups = [], byRaw = {};
    keep.slice().sort(function (a, b) { return a.addedAt < b.addedAt ? -1 : a.addedAt > b.addedAt ? 1 : 0; })
      .forEach(function (x) {
        if (!byRaw[x.rawId]) { byRaw[x.rawId] = { rawId: x.rawId, name: x.name, recs: [] }; groups.push(byRaw[x.rawId]); }
        byRaw[x.rawId].recs.push(x);
      });

    var fresh = Store.blankState();
    // what was not taken from a workbook carries over untouched: the
    // photographs, and anything else kept beside the computed history
    fresh.photos = state.photos || [];
    Object.keys(state).forEach(function (k) { if (!(k in fresh)) fresh[k] = state[k]; });
    fresh.photos.forEach(function (p) { p.batchIsSeller = null; });   // the seller list may change

    return groups.reduce(function (chain, g) {
      return chain.then(function () {
        return Store.backend.getRaw(g.rawId, g.name).then(function (blob) {
          if (!blob) throw new Error('missing');
          return new Response(blob).arrayBuffer();
        }).then(function (buf) {
          var sheets = Compute.parseWorkbook(new Uint8Array(buf), g.name);
          g.recs.forEach(function (rec) {
            var sh = sheets.filter(function (x) {
              return x.sheet === rec.sheet && x.kind === rec.kind && x.from === rec.from && x.to === rec.to;
            })[0];
            if (!sh) throw new Error('sheet');
            Compute.ingest(fresh, sh, { id: rec.id, name: rec.name, size: rec.size, rawId: rec.rawId });
            fresh.files[fresh.files.length - 1].addedAt = rec.addedAt;   // still uploaded when it was
          });
        });
      });
    }, Promise.resolve()).then(function () { return fresh; });
  }

  /* Files uploaded before workbooks were kept against their record cannot be
     read again, so for those the removal works on the merged totals instead —
     never wiping more than the removed file could have contributed. */
  function legacyRemove(f) {
    var msg = 'Removed ' + f.name + '.', kind = 'ok';
    state.files = state.files.filter(function (x) { return x.id !== f.id; });
    if (f.kind === 'daily') {
      delete state.days[f.from];
      var ds = Object.keys(state.days).sort();
      if (state.latest && state.latest.date === f.from) {
        state.latest = ds.length ? { date: ds[ds.length - 1], bal: {} } : null;
        msg += ' The stock-on-hand figures came from that file ' + MDASH + ' upload the latest day again.'; kind = 'err';
      }
    } else {
      var others = state.files.filter(function (x) { return x.kind === 'master'; });
      if (!others.length) {
        state.cumulative = null; state.sellers = {};
        msg += ' Upload a full-period export again to restore the seller map.'; kind = 'err';
      } else if (state.cumulative && state.cumulative.to === f.to &&
                 (state.cumulative.asOf || state.cumulative.to) === (f.asOf || f.to)) {
        // the seller map is shared between the exports, so it stays; the totals were this file's
        state.cumulative = null;
        msg += ' Its full-period totals are gone ' + MDASH + ' upload ' + others[0].name +
               ' again to bring that export’s totals back.'; kind = 'err';
      }
    }
    return persistAndDraw().then(function () { status(msg, kind); });
  }

  /* ---------------- intake ---------------- */
  function wireDrop(dropId, inputId, bucket, accept) {
    var drop = $(dropId), input = $(inputId);
    input.addEventListener('change', function () { take(input.files, bucket, accept); input.value = ''; });
    ['dragenter', 'dragover'].forEach(function (ev) {
      drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.add('over'); });
    });
    ['dragleave', 'drop'].forEach(function (ev) {
      drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.remove('over'); });
    });
    drop.addEventListener('drop', function (e) { take(e.dataTransfer.files, bucket, accept); });
  }
  function take(files, bucket, accept) {
    Array.prototype.forEach.call(files, function (f) {
      if (accept.test(f.name)) queue[bucket].push(f);
    });
    showQueue();
  }
  function showQueue() {
    $('qXlsx').textContent = queue.xlsx.length ? queue.xlsx.map(function (f) { return f.name; }).join(', ') : '';
    $('qZip').textContent = queue.photo.length ? queue.photo.map(function (f) { return f.name; }).join(', ') : '';
    $('computeBtn').disabled = !(queue.xlsx.length || queue.photo.length);
  }

  function readFile(f) {
    return new Promise(function (res, rej) {
      var r = new FileReader();
      r.onload = function () { res(r.result); };
      r.onerror = function () { rej(new Error('Could not read ' + f.name)); };
      r.readAsArrayBuffer(f);
    });
  }

  /* ---------------- compute ---------------- */
  function compute() {
    var btn = $('computeBtn');
    btn.disabled = true;
    var total = queue.xlsx.length + queue.photo.length, done = 0, added = 0, skipped = [];
    status('Reading files...', 'busy'); progress(0);

    var chain = Promise.resolve();

    queue.xlsx.forEach(function (f) {
      chain = chain.then(function () {
        status('Reading ' + f.name + '...', 'busy');
        return readFile(f).then(function (buf) {
          var sheets = Compute.parseWorkbook(new Uint8Array(buf), f.name);
          if (!sheets.length) { skipped.push(f.name + ' (not an ASR stock report)'); return; }
          if (sheets.some(function (sh) { return sh.kind === 'master'; })) {
            state.bookFile = { name: f.name, at: new Date().toISOString() };
            Store.backend.putBlob('bookfile', f).catch(function () {});
          }
          // one id for the workbook itself, carried by every sheet taken from it,
          // so removing a file later can rebuild from the workbooks that remain
          var rawId = uid(), took = 0;
          sheets.forEach(function (sh) {
            var dup = state.files.filter(function (x) {
              return x.kind === sh.kind && x.from === sh.from && x.to === sh.to && x.sheet === sh.sheet;
            })[0];
            if (dup) { skipped.push(f.name + ' ' + sh.sheet + ' (already loaded)'); return; }
            Compute.ingest(state, sh, { id: uid(), name: f.name, size: f.size, rawId: rawId });
            added++; took++;
          });
          if (!took) return;
          return Store.backend.putRaw(rawId, f.name, f).catch(function () {});
        }).then(function () { progress(++done / total); });
      });
    });

    queue.photo.forEach(function (f) {
      chain = chain.then(function () {
        status('Storing photographs from ' + f.name + '...', 'busy');
        var step = /\.zip$/i.test(f.name) ? addZip(f) : addImage(f);
        return step.then(function () { progress(++done / total); });
      });
    });

    chain.then(function () {
      status('Computing...', 'busy');
      queue = { xlsx: [], photo: [] }; showQueue();
      return persistAndDraw();
    }).then(function () {
      var pending = (state.photos || []).filter(isPending);
      if (!Matcher.configured || !pending.length) return;
      status('Reading design codes off the tags...', 'busy');
      return runMatcher(pending).then(function () { renderPhotos(); renderLines(); });
    }).then(function () {
      progress(null);
      var msg = added ? 'Computed. ' + added + ' sheet(s) added.' : 'Nothing new to add.';
      if (skipped.length) msg += ' Skipped: ' + skipped.join('; ') + '.';
      // a tagged photograph is no use if its line sits past row three hundred
      var lit = A.lines.filter(function (l) { return thumbByDesign[l.key]; }).length;
      if (lit) msg += ' ' + lit + ' line' + (lit === 1 ? ' has' : 's have') +
                      ' a photograph \u2014 press With photo above the table to see just those.';
      status(msg, skipped.length && !added ? 'err' : 'ok');
    }).catch(function (e) {
      progress(null);
      status(e.message || String(e), 'err');
      btn.disabled = false;
    });
  }

  function addImage(file) {
    var id = uid();
    return Store.backend.putBlob(id, file).then(function () {
      state.photos.push({ id: id, name: file.name, designKey: null, addedAt: new Date().toISOString() });
    });
  }
  function addZip(file) {
    return readFile(file).then(function (buf) { return JSZip.loadAsync(buf); }).then(function (zip) {
      // The chat that came with the photographs says when each was sent, by
      // whom, and which seller's batch it belonged to. Read it first.
      var chatEntry = null;
      zip.forEach(function (path, entry) {
        if (!entry.dir && !/__MACOSX/.test(path) && /(^|\/)_?chat\.txt$|whatsapp chat.*\.txt$/i.test(path)) chatEntry = entry;
      });
      var chatRead = chatEntry && window.Pieces
        ? chatEntry.async('string').then(function (t) { return Pieces.chatIndex(t); }).catch(function () { return {}; })
        : Promise.resolve({});

      return chatRead.then(function (chat) {
        var jobs = [];
        zip.forEach(function (path, entry) {
          if (entry.dir || !/\.(jpe?g|png|webp)$/i.test(path)) return;
          if (/__MACOSX/.test(path)) return;
          var base = path.split('/').pop();
          var known = (state.photos || []).filter(function (p) { return p.name === base; })[0];
          var info = chat[base];
          if (known) {
            // the same photograph again, perhaps now with its chat: keep the photo, learn the context
            if (info && !known.sender) { Object.assign(known, chatFields(info)); known.batchIsSeller = null; }
            return;
          }
          jobs.push(entry.async('blob').then(function (b) {
            var id = uid();
            return Store.backend.putBlob(id, b).then(function () {
              state.photos.push(Object.assign({ id: id, name: base, designKey: null,
                addedAt: new Date().toISOString() }, info ? chatFields(info) : {}));
            });
          }));
        });
        return Promise.all(jobs);
      });
    });
  }
  function chatFields(info) {
    return { sentAt: info.sentAt, seq: info.seq, sender: info.sender,
             caption: info.caption || null, batchCaption: info.batchCaption || null };
  }

  function rebuildCodes() {
    validCodes = {};
    A.lines.forEach(function (l) { validCodes[l.key] = true; });
    var seen = {};
    sellerNames = [];
    Object.keys(state.sellers || {}).forEach(function (k) {
      var s = state.sellers[k];
      if (s && !seen[s]) { seen[s] = 1; sellerNames.push(s); }
    });
  }

  /* Several photographs of one piece: the stack shot, which shows every
     colour but never a readable tag, is linked to the close-up sent beside it.
     pieces.js has the rules; this is where they are applied, after anything
     that could have changed a code. */
  function linkPieces() {
    if (!window.Pieces) return 0;
    return Pieces.link(state.photos || [], {
      sellerOf: function (k) { return (state.sellers || {})[k] || ''; },
      refOf: function (k) { return (state.refs || {})[k] || k; },
      sellers: sellerNames
    });
  }

  function persistAndDraw() {
    A = Compute.analyse(state, {
      slowAfterWeeks: CFG.slowAfterWeeks || 26,
      fastUnderWeeks: CFG.fastUnderWeeks || 8
    });
    rebuildCodes();
    linkPieces();
    renderFiles();
    render();
    return Store.backend.save(state);
  }

  /* ---------------- boot ---------------- */
  function boot() {
    $('brandName').textContent = 'Narsingh Stock Desk';
    $('brandPlace').textContent = CFG.shopPlace || '';
    document.title = (CFG.shopName || 'Narsingh') + ' ' + MDASH + ' Stock Desk';

    wireDrop('dropXlsx', 'inXlsx', 'xlsx', /\.(xlsx|xlsm|xls)$/i);
    wireDrop('dropZip', 'inZip', 'photo', /\.(zip|jpe?g|png|webp)$/i);
    $('computeBtn').addEventListener('click', compute);

    $('filesBtn').addEventListener('click', function () { renderFiles(); $('filesDlg').showModal(); });
    $('filesClose').addEventListener('click', function () { $('filesDlg').close(); });
    // two presses, four seconds apart at most: no confirm box, which embedded
    // previews block
    var wipeArmed = null;
    $('wipeBtn').addEventListener('click', function () {
      var btn = $('wipeBtn');
      if (!wipeArmed) {
        btn.textContent = 'Press again to delete everything';
        btn.classList.add('armed');
        wipeArmed = setTimeout(function () {
          wipeArmed = null; btn.textContent = 'Clear everything'; btn.classList.remove('armed');
        }, 4000);
        return;
      }
      clearTimeout(wipeArmed); wipeArmed = null;
      btn.textContent = 'Clear everything'; btn.classList.remove('armed');
      Store.backend.wipe().then(function () {
        state = Store.blankState(); photoUrls = {};
        return persistAndDraw();
      }).then(function () { $('filesDlg').close(); status('Everything cleared.', 'ok'); });
    });
    $('exportBtn').addEventListener('click', function () {
      var blob = new Blob([JSON.stringify(state, null, 1)], { type: 'application/json' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'narsingh-history-' + (A && A.asOf ? A.asOf : 'export') + '.json';
      a.click();
    });

    $('themeBtn').addEventListener('click', function () {
      var cur = document.documentElement.getAttribute('data-theme');
      var dark = cur ? cur === 'dark'
        : matchMedia('(prefers-color-scheme: dark)').matches;
      document.documentElement.setAttribute('data-theme', dark ? 'light' : 'dark');
      try { localStorage.setItem('narsingh-theme', dark ? 'light' : 'dark'); } catch (e) {}
      if (A) render();
    });
    try {
      var saved = localStorage.getItem('narsingh-theme');
      if (saved) document.documentElement.setAttribute('data-theme', saved);
    } catch (e) {}

    $('refreshAuto').addEventListener('click', refreshAuto);

    $('rematchBtn').addEventListener('click', function () {
      var pending = (state.photos || []).filter(isPending);
      if (!pending.length) return;
      $('rematchBtn').disabled = true;
      Matcher.retry();           // a new press is a fresh attempt at the reader too
      status('Reading design codes off ' + pending.length + ' tag(s)...', 'busy');
      runMatcher(pending).then(function () {
        renderPhotos(); renderLines();
        var left = (state.photos || []).filter(isPending).length;
        status(left ? left + ' photograph(s) still need a code by hand.' : 'Every photograph now has a code.',
               left ? 'err' : 'ok');
        $('rematchBtn').disabled = false;
      });
    });

    // tap any photograph to see it full size; in Lines, every photograph of
    // that design, the stack shot first and the close-up after it
    var lb = document.createElement('dialog');
    lb.className = 'lightbox';
    lb.innerHTML =
      '<img alt="">' +
      '<div class="lbbar hidden">' +
        '<button type="button" class="lbnav" data-step="-1" aria-label="Previous photograph">&#8249;</button>' +
        '<span class="lbcap"></span>' +
        '<button type="button" class="lbnav" data-step="1" aria-label="Next photograph">&#8250;</button>' +
      '</div>';
    document.body.appendChild(lb);
    var gal = [], at = 0;
    function lbShow() {
      var id = gal[at], p = photoById(id), im = lb.querySelector('img');
      im.removeAttribute('src');
      var put = function (u) { if (u) im.src = u; };
      if (photoUrls[id]) put(photoUrls[id]);
      else Store.backend.getBlobUrl(id).then(function (u) { if (u) { photoUrls[id] = u; put(u); } });
      var what = !p ? '' : p.how === 'timing' ? 'The stack ' + MDASH + ' every colour of this design'
        : p.how === 'manual' ? 'Linked by hand' : 'The tag';
      lb.querySelector('.lbcap').textContent = (at + 1) + ' of ' + gal.length + (what ? '  \u00b7  ' + what : '');
    }
    lb.addEventListener('click', function (e) {
      var b = e.target.closest('.lbnav');
      if (b) { at = (at + (+b.dataset.step) + gal.length) % gal.length; lbShow(); return; }
      lb.close();
    });
    lb.addEventListener('keydown', function (e) {
      if (gal.length < 2) return;
      if (e.key === 'ArrowRight') { at = (at + 1) % gal.length; lbShow(); }
      if (e.key === 'ArrowLeft') { at = (at - 1 + gal.length) % gal.length; lbShow(); }
    });
    document.addEventListener('click', function (e) {
      var img = e.target.closest && e.target.closest('img[data-big]');
      if (!img || !img.src) return;
      var key = img.dataset.design, set = key && picsByDesign[key];
      if (set && set.length > 1) {
        gal = set.slice(); at = Math.max(0, gal.indexOf(img.dataset.pid));
        lb.querySelector('.lbbar').classList.remove('hidden');
        lbShow();
      } else {
        gal = [];
        lb.querySelector('.lbbar').classList.add('hidden');
        lb.querySelector('img').src = img.src;
      }
      lb.querySelector('img').alt = img.alt || '';
      lb.showModal();
    });

    $('photoOnly').addEventListener('click', function () {
      filter.photo = !filter.photo;
      renderLines();
    });
    $('q').addEventListener('input', function () { filter.q = this.value; renderLines(); });
    $('sellerFilter').addEventListener('change', function () { filter.seller = this.value; renderLines(); });
    $('sortBy').addEventListener('change', function () {
      filter.sort = this.value;
      // the two alphabetical choices read forwards; the rest are biggest first
      filter.dir = (this.value === 'seller' || this.value === 'all') ? 1 : -1;
      renderLines();
    });
    document.querySelectorAll('#linesTable th[data-k]').forEach(function (th) {
      th.addEventListener('click', function () {
        var k = th.dataset.k;
        filter.dir = (filter.sort === k) ? -filter.dir : -1;
        filter.sort = k;
        // keep the chooser honest, but leave it alone for columns it cannot name
        if ($('sortBy').querySelector('option[value="' + k + '"]')) $('sortBy').value = k;
        document.querySelectorAll('#linesTable th').forEach(function (o) { o.removeAttribute('aria-sort'); });
        th.setAttribute('aria-sort', filter.dir < 0 ? 'descending' : 'ascending');
        renderLines();
      });
    });

    var rt;
    addEventListener('resize', function () {
      clearTimeout(rt);
      rt = setTimeout(function () { if (A) lineChart($('trendChart'), A.trend); }, 180);
    });

    Store.backend.load().then(function (s) {
      state = s && s.version ? s : Store.blankState();
      ['files', 'photos'].forEach(function (k) { if (!Array.isArray(state[k])) state[k] = []; });
      ['days', 'sellers', 'refs'].forEach(function (k) { if (!state[k]) state[k] = {}; });
      A = Compute.analyse(state, {
        slowAfterWeeks: CFG.slowAfterWeeks || 26, fastUnderWeeks: CFG.fastUnderWeeks || 8
      });
      rebuildCodes();
      // labels removed before Manually unmapped existed: find them, so they
      // appear there rather than among the undecided
      var found = 0;
      (state.photos || []).forEach(function (p) {
        if (p.designKey || p.unmapped) return;
        if (p.prev && p.prev.designKey) {
          p.unmapped = { code: p.prev.designKey, was: 'auto', how: p.prev.how || null,
            linkedTo: p.prev.linkedTo || null, linkDt: p.prev.linkDt || null, status: p.prev.status,
            message: p.prev.message, conf: p.prev.conf == null ? null : p.prev.conf, at: null };
          found++;
        } else if (/^Mapping removed/.test(p.message || '') && (p.rejected || []).length) {
          p.unmapped = { code: p.rejected[p.rejected.length - 1], was: 'manual', at: null };
          found++;
        }
      });
      // photographs tagged before linking existed pick up their stack shots
      // here, from filename times alone, without reading anything again
      if (linkPieces() || found) Store.backend.save(state).catch(function () {});
      renderFiles(); render();
      status(state.files.length
        ? 'Ready. ' + state.files.length + ' file(s) on record in ' + Store.label + '.'
        : 'Ready. Add today\'s stock report to begin.', 'ok');
    }).catch(function (e) {
      state = Store.blankState();
      renderFiles(); render();
      status('Could not reach storage: ' + (e.message || e) + ' Working in this browser for now.', 'err');
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
