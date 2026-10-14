/* compute.js — reads ASR workbooks and turns a pile of daily files into movement.
 *
 * Two shapes of export are recognised automatically:
 *   daily  — "From 02-Oct-2026 To 02-Oct-2026". TotIn/TotOut are that day's
 *            movement, BalQty is stock on hand at that moment.
 *   master — any wider period. Carries the Supplier column, which the daily
 *            export does not, so it supplies the design-to-seller map.
 */
(function (global) {
  'use strict';

  var MONTHS = { jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11 };
  var MIN_DAILY_DAYS = 4;   // below this, pace falls back to the full-period export

  function normKey(s) { return String(s == null ? '' : s).toUpperCase().replace(/[^A-Z0-9]/g, ''); }
  function num(v) {
    if (v == null || v === '') return 0;
    var n = typeof v === 'number' ? v : parseFloat(String(v).replace(/[, ]/g, ''));
    return isFinite(n) ? Math.round(n) : 0;
  }
  function iso(d) {
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') +
           '-' + String(d.getDate()).padStart(2, '0');
  }
  function parseDate(txt) {
    var m = String(txt).match(/(\d{1,2})[-\/\s]([A-Za-z]{3,})[-\/\s](\d{4})/);
    if (m && MONTHS[m[2].slice(0, 3).toLowerCase()] !== undefined) {
      return iso(new Date(+m[3], MONTHS[m[2].slice(0, 3).toLowerCase()], +m[1]));
    }
    m = String(txt).match(/(\d{4})-(\d{2})-(\d{2})/);
    return m ? m[0] : null;
  }
  function todayISO() { return iso(new Date()); }
  // "ASR_GS__S_05.10.26_1.xlsx" -> 2026-10-05. The full-period export runs to the
  // end of the financial year, so its own header cannot say when it was taken.
  function dateFromName(name) {
    var m = String(name || '').match(/(\d{2})[._-](\d{2})[._-](\d{2})(?!\d)/);
    if (!m) return null;
    var d = +m[1], mo = +m[2], y = 2000 + (+m[3]);
    if (d < 1 || d > 31 || mo < 1 || mo > 12) return null;
    return iso(new Date(y, mo - 1, d));
  }
  function daysBetween(a, b) {
    return Math.round((new Date(b + 'T00:00:00') - new Date(a + 'T00:00:00')) / 86400000);
  }

  /* ---------- workbook -> sheets ---------- */
  function parseWorkbook(data, filename) {
    var wb = XLSX.read(data, { type: 'array' });
    var out = [];
    wb.SheetNames.forEach(function (name) {
      var grid = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: true, defval: '' });
      var hdrRow = -1, col = {};
      for (var i = 0; i < Math.min(grid.length, 15); i++) {
        var cells = (grid[i] || []).map(function (c) { return normKey(c); });
        if (cells.indexOf('CREF') >= 0 && cells.indexOf('TOTOUT') >= 0) { hdrRow = i; break; }
      }
      if (hdrRow < 0) return;                       // not an ASR sheet, skip quietly
      (grid[hdrRow] || []).forEach(function (c, j) { col[normKey(c)] = j; });

      var from = null, to = null;
      for (var k = 0; k < hdrRow; k++) {
        var line = (grid[k] || []).join(' ');
        if (/from/i.test(line) && /to/i.test(line)) {
          var parts = line.split(/\bto\b/i);
          from = parseDate(parts[0]); to = parseDate(parts[1] || '');
          if (from && to) break;
        }
      }
      if (!from) return;

      var rows = [], tin = 0, tout = 0;
      for (var r = hdrRow + 1; r < grid.length; r++) {
        var g = grid[r] || [];
        var ref = g[col.CREF];
        if (ref == null || String(ref).trim() === '') continue;
        var o = {
          key: normKey(ref),
          ref: String(ref).trim(),
          seller: col.SUPPLIER !== undefined ? String(g[col.SUPPLIER] || '').trim() : '',
          tin: num(g[col.TOTIN]), tout: num(g[col.TOTOUT]), bal: num(g[col.BALQTY])
        };
        if (!o.key) continue;
        rows.push(o); tin += o.tin; tout += o.tout;
      }
      if (!rows.length) return;

      out.push({
        sheet: name, from: from, to: to,
        kind: from === to ? 'daily' : 'master',
        hasSeller: col.SUPPLIER !== undefined,
        rows: rows, totalIn: tin, totalOut: tout, lines: rows.length
      });
    });
    return out;
  }

  /* ---------- fold a parsed sheet into saved state ---------- */
  function ingest(state, sheet, fileMeta) {
    var i, o;
    if (sheet.kind === 'daily') {
      var mv = {}, bal = {};
      for (i = 0; i < sheet.rows.length; i++) {
        o = sheet.rows[i];
        // the same design appears once per buying city - add the rows up
        if (o.tin || o.tout) {
          var m = mv[o.key] || (mv[o.key] = [0, 0]);
          m[0] += o.tin; m[1] += o.tout;
        }
        if (o.bal) bal[o.key] = (bal[o.key] || 0) + o.bal;
        if (!state.refs[o.key]) state.refs[o.key] = o.ref;
      }
      state.days[sheet.from] = { mv: mv, tot: [sheet.totalIn, sheet.totalOut], lines: sheet.lines };
      if (!state.latest || sheet.from >= state.latest.date) {
        state.latest = { date: sheet.from, bal: bal };
      }
    } else {
      var rows = {};
      for (i = 0; i < sheet.rows.length; i++) {
        o = sheet.rows[i];
        var cur = rows[o.key] || (rows[o.key] = { tin: 0, tout: 0, bal: 0 });
        cur.tin += o.tin; cur.tout += o.tout; cur.bal += o.bal;
        if (!state.refs[o.key]) state.refs[o.key] = o.ref;
        if (o.seller) state.sellers[o.key] = o.seller;   // the seller map lives here
      }
      // the header's end date is the end of the financial year, not the day the
      // report was run, so take the date from the filename and never run past today
      var today = todayISO();
      var asOf = dateFromName(fileMeta.name) || (sheet.to > today ? today : sheet.to);
      if (asOf > today) asOf = today;
      if (asOf < sheet.from) asOf = sheet.to > today ? today : sheet.to;
      var newer = !state.cumulative || asOf > state.cumulative.asOf ||
                  (asOf === state.cumulative.asOf && sheet.to > state.cumulative.to);
      if (newer) {
        state.cumulative = { from: sheet.from, to: sheet.to, asOf: asOf, rows: rows };
      }
      if (!state.latest || asOf > state.latest.date) {
        var b = {};
        Object.keys(rows).forEach(function (k) { if (rows[k].bal) b[k] = rows[k].bal; });
        state.latest = { date: asOf, bal: b };
      }
    }
    state.files.push({
      id: fileMeta.id, name: fileMeta.name, size: fileMeta.size, sheet: sheet.sheet,
      rawId: fileMeta.rawId || null,       // where the workbook itself is kept
      kind: sheet.kind, from: sheet.from, to: sheet.to,
      asOf: sheet.kind === 'daily' ? sheet.from
            : (state.cumulative && state.cumulative.to === sheet.to ? state.cumulative.asOf : sheet.to),
      lines: sheet.lines,
      totalIn: sheet.totalIn, totalOut: sheet.totalOut,
      hasSeller: sheet.hasSeller, addedAt: new Date().toISOString()
    });
    return state;
  }

  /* ---------- state -> everything the page draws ---------- */
  function analyse(state, opts) {
    var slowWeeks = (opts && opts.slowAfterWeeks) || 26;
    var fastWeeks = (opts && opts.fastUnderWeeks) || 8;
    var dates = Object.keys(state.days).sort();
    var nDays = dates.length;
    var asOf = state.latest ? state.latest.date : (dates[nDays - 1] || null);
    var cum = state.cumulative;
    var basis = nDays >= MIN_DAILY_DAYS ? 'daily' : (cum ? 'period' : 'daily');

    // every design we know of
    var keys = {};
    if (state.latest) Object.keys(state.latest.bal).forEach(function (k) { keys[k] = 1; });
    dates.forEach(function (d) { Object.keys(state.days[d].mv).forEach(function (k) { keys[k] = 1; }); });
    if (cum) Object.keys(cum.rows).forEach(function (k) { keys[k] = 1; });
    // a design that is in no current book and holds no stock is last year's, not today's

    var spark = dates.slice(-14);
    var periodWeeks = cum ? Math.max(1, daysBetween(cum.from, cum.asOf || cum.to) / 7) : null;

    var lines = Object.keys(keys).map(function (k) {
      var soldObs = 0, inObs = 0, last = null, series = [];
      for (var i = 0; i < dates.length; i++) {
        var m = state.days[dates[i]].mv[k];
        var sold = m ? m[1] : 0;
        soldObs += sold; inObs += m ? m[0] : 0;
        if (sold > 0) last = dates[i];
      }
      for (var j = 0; j < spark.length; j++) {
        var mm = state.days[spark[j]].mv[k];
        series.push(mm ? mm[1] : 0);
      }
      var bal = (state.latest && state.latest.bal[k]) || 0;
      var c = cum && cum.rows[k];

      var ratePerDay;
      if (basis === 'daily' && nDays) ratePerDay = soldObs / nDays;
      else if (c && periodWeeks) ratePerDay = c.tout / (periodWeeks * 7);
      else ratePerDay = nDays ? soldObs / nDays : 0;

      var cover = ratePerDay > 0 ? (bal / ratePerDay) / 7 : null;   // weeks
      var everSold = soldObs > 0 || (c && c.tout > 0);
      var status = bal <= 0 ? 'soldout'
                 : !everSold ? 'dead'
                 : cover == null ? 'dead'
                 : cover > slowWeeks ? 'slow'
                 : cover > fastWeeks ? 'steady' : 'fast';

      return {
        key: k, ref: state.refs[k] || k, seller: state.sellers[k] || '',
        bal: bal, soldObs: soldObs, inObs: inObs,
        soldCum: c ? c.tout : null, inCum: c ? c.tin : null,
        rate: ratePerDay, cover: cover, series: series,
        lastSale: last, idle: last && asOf ? daysBetween(last, asOf) : null,
        status: status
      };
    });

    // seller rollup
    var byS = {};
    lines.forEach(function (l) {
      var nm = l.seller || 'Not yet mapped';
      var s = byS[nm] || (byS[nm] = {
        seller: nm, lines: 0, bal: 0, soldObs: 0, rate: 0,
        series: spark.map(function () { return 0; })
      });
      s.lines++; s.bal += l.bal; s.soldObs += l.soldObs; s.rate += l.rate;
      for (var i = 0; i < s.series.length; i++) s.series[i] += l.series[i] || 0;
    });
    var sellers = Object.keys(byS).map(function (nm) {
      var s = byS[nm];
      s.cover = s.rate > 0 ? (s.bal / s.rate) / 7 : null;
      s.status = s.bal <= 0 ? 'soldout' : s.cover == null ? 'dead'
               : s.cover > slowWeeks ? 'slow' : s.cover > fastWeeks ? 'steady' : 'fast';
      return s;
    }).sort(function (a, b) { return b.soldObs - a.soldObs || b.bal - a.bal; });

    var tot = { fast: 0, steady: 0, slow: 0, dead: 0, soldout: 0 };
    var pcs = { fast: 0, steady: 0, slow: 0, dead: 0, soldout: 0 };
    lines.forEach(function (l) { tot[l.status]++; pcs[l.status] += l.bal; });

    var trend = dates.map(function (d) {
      return { date: d, out: state.days[d].tot[1], in: state.days[d].tot[0] };
    });

    return {
      asOf: asOf, basis: basis, observedDays: nDays, dates: dates, sparkDates: spark,
      lines: lines, sellers: sellers, counts: tot, pieces: pcs, trend: trend,
      onHand: lines.reduce(function (a, l) { return a + l.bal; }, 0),
      soldObs: lines.reduce(function (a, l) { return a + l.soldObs; }, 0),
      cumulative: cum ? { from: cum.from, to: cum.to, asOf: cum.asOf || cum.to,
                          weeks: periodWeeks ? Math.round(periodWeeks * 10) / 10 : null } : null,
      mappedSellers: Object.keys(state.sellers).length,
      slowWeeks: slowWeeks, fastWeeks: fastWeeks
    };
  }

  global.Compute = {
    parseWorkbook: parseWorkbook,
    dateFromName: dateFromName,
    ingest: ingest,
    analyse: analyse,
    normKey: normKey,
    daysBetween: daysBetween,
    MIN_DAILY_DAYS: MIN_DAILY_DAYS
  };
})(window);
