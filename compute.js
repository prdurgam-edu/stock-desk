/* compute.js — reads ASR workbooks and turns a pile of daily files into movement.
 *
 * Two shapes of export are recognised automatically:
 *   daily  — "From 02-Oct-2026 To 02-Oct-2026". TotIn/TotOut are that day's
 *            movement, BalQty is stock on hand at that moment.
 *   master — any wider period. Carries the Supplier column, which the daily
 *            export does not, so it supplies the design-to-seller map.
 *
 * Pace (pieces sold a day) blends the two. The full-period export gives every
 * line a long-run pace; each daily file on record then pulls it toward what
 * actually sold that day, counting as one day against PRIOR_DAYS days of the
 * long run. Four days of files therefore nudge the verdicts instead of
 * overturning them (a line that happened not to sell in those four days is
 * not suddenly "dead"); after PRIOR_DAYS days of files the two weigh the same,
 * and from there the daily files lead.
 */
(function (global) {
  'use strict';

  var MONTHS = { jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11 };
  var MIN_DAILY_DAYS = 4;   // with no full-period export, pace needs at least this many days
  var PRIOR_DAYS = 28;      // how many days of daily files the full-period pace is worth
  var SELL_DAYS = 15;       // sell-through looks at this many days
  // movement, from the 15-day sell-through: 90%+ Fast, 75%+ Medium, 40%+ Steady, 20%+ Slow, under 20% Dead
  var BANDS = [[0.9, 'fast'], [0.75, 'medium'], [0.4, 'steady'], [0.2, 'slow']];
  function band(v) {
    for (var i = 0; i < BANDS.length; i++) if (v >= BANDS[i][0] - 1e-9) return BANDS[i][1];
    return 'dead';
  }

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
    // the day the export was made, as Excel recorded it: the fallback when a
    // full-period file's name carries no date
    var madeAt = wb.Props && (wb.Props.CreatedDate || wb.Props.ModifiedDate);
    var made = madeAt instanceof Date && !isNaN(madeAt) ? iso(madeAt) : null;
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
        sheet: name, from: from, to: to, made: made,
        kind: from === to ? 'daily' : 'master',
        hasSeller: col.SUPPLIER !== undefined,
        rows: rows, totalIn: tin, totalOut: tout, lines: rows.length
      });
    });
    return out;
  }

  /* The day a full-period export describes. Its header ends at the end of the
     financial year, not the day it was run: take the date from the filename,
     else the day Excel says the file was made, else the day the file was
     saved, and never past today. Last year's sheet in the same workbook ends
     at its own year end, so its balances are last year's closing stock, never
     today's. */
  function masterAsOf(sheet, fileMeta) {
    var today = todayISO();
    var asOf = dateFromName(fileMeta && fileMeta.name) || sheet.made ||
               (fileMeta && fileMeta.modified ? iso(new Date(fileMeta.modified)) : null) || today;
    if (asOf > today) asOf = today;
    if (asOf > sheet.to) asOf = sheet.to;
    if (asOf < sheet.from) asOf = sheet.to > today ? today : sheet.to;
    return asOf;
  }

  // is this sheet one already on record? A daily is the same day; a full-period
  // export is the same period run on the same day, so next week's export of the
  // same financial year is new, not a repeat
  function sameAs(rec, sheet, fileMeta) {
    if (rec.kind !== sheet.kind || rec.from !== sheet.from || rec.to !== sheet.to || rec.sheet !== sheet.sheet) return false;
    if (sheet.kind === 'daily') return true;
    return (rec.asOf || rec.to) === masterAsOf(sheet, fileMeta);
  }

  /* ---------- fold a parsed sheet into saved state ---------- */
  function ingest(state, sheet, fileMeta) {
    var i, o, asOf = null;
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
      asOf = masterAsOf(sheet, fileMeta);
      var prev = state.cumulative;
      var newer = !prev || asOf > prev.asOf ||
                  (asOf === prev.asOf && sheet.to > prev.to);
      var samePeriod = prev && prev.from === sheet.from && prev.to === sheet.to;
      /* Period exports sent day after day: what moved between the last one and
         this one is this one's totals less the last one's, line by line. It is
         kept like a daily file, dated this export's day and marked as spanning
         the days since the last, so sell-through and the charts can use it.
         (A real daily file for the same day is left as it is.) */
      if (newer && samePeriod && asOf > prev.asOf && !(state.days[asOf] && !state.days[asOf].p)) {
        var dmv = {}, dIn = 0, dOut = 0;
        Object.keys(rows).forEach(function (k) {
          var was = prev.rows[k] || { tin: 0, tout: 0 };
          var di = Math.max(0, rows[k].tin - was.tin), dO = Math.max(0, rows[k].tout - was.tout);
          if (di || dO) { dmv[k] = [di, dO]; dIn += di; dOut += dO; }
        });
        state.days[asOf] = { mv: dmv, tot: [dIn, dOut], lines: Object.keys(dmv).length, p: 1, span: daysBetween(prev.asOf, asOf) };
      }
      // an export older than one already in, for the same period: the gaps
      // either side of it can only be worked out by reading them all in order
      if (samePeriod && asOf < prev.asOf) state.outOfOrder = true;
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
      asOf: sheet.kind === 'daily' ? sheet.from : asOf,
      modified: fileMeta.modified || null,
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
    // real daily files, as against movement worked out between two period exports
    var realDates = dates.filter(function (d) { return !state.days[d].p; });
    var nDays = realDates.length;
    var asOf = state.latest ? state.latest.date : (dates[dates.length - 1] || null);
    var cum = state.cumulative;
    // period: the full-period export alone; blend: it and the daily files;
    // daily: daily files alone (no full-period export loaded)
    var basis = cum ? (nDays ? 'blend' : 'period') : 'daily';
    // the day before the first movement on record: a daily file covers its own
    // day, movement between two period exports the days since the earlier one
    var spanOf = function (d) { return state.days[d].p ? (state.days[d].span || 1) : 1; };
    var coverFrom = dates.length ? dates.reduce(function (m, d) {
      var b = iso(new Date(new Date(d + 'T00:00:00').getTime() - spanOf(d) * 86400000));
      return m && m < b ? m : b;
    }, null) : null;
    var cumAsOf = cum ? (cum.asOf || cum.to) : null;

    // every design we know of
    var keys = {};
    if (state.latest) Object.keys(state.latest.bal).forEach(function (k) { keys[k] = 1; });
    dates.forEach(function (d) { Object.keys(state.days[d].mv).forEach(function (k) { keys[k] = 1; }); });
    if (cum) Object.keys(cum.rows).forEach(function (k) { keys[k] = 1; });
    // a design that is in no current book and holds no stock is last year's, not today's

    var spark = dates.slice(-14);
    // sell-through looks at the last fifteen days up to the latest stock count
    var win = asOf ? dates.filter(function (d) { return d <= asOf && daysBetween(d, asOf) < SELL_DAYS; }) : [];
    // the movement groups need 15 days of movement behind the latest stock
    // count; until then every line waits under Others
    var ready15 = !!(win.length && coverFrom && daysBetween(coverFrom, asOf) >= SELL_DAYS);
    // the days the window really spans: movement between two period exports
    // counts whole, so it can reach back further than 15
    var winFrom = win.length ? win.reduce(function (m, d) {
      var b = iso(new Date(new Date(d + 'T00:00:00').getTime() - (spanOf(d) - 1) * 86400000));
      return m && m < b ? m : b;
    }, null) : null;
    var periodWeeks = cum ? Math.max(1, daysBetween(cum.from, cum.asOf || cum.to) / 7) : null;

    var lines = Object.keys(keys).map(function (k) {
      var soldObs = 0, inObs = 0, last = null, series = [], soldSince = 0, soldDaily = 0;
      for (var i = 0; i < dates.length; i++) {
        var day = state.days[dates[i]], m = day.mv[k];
        var sold = m ? m[1] : 0;
        soldObs += sold; inObs += m ? m[0] : 0;
        if (sold > 0) last = dates[i];
        if (day.p) continue;     // already inside the period export's own totals
        soldDaily += sold;
        // the full-period export was run on cumAsOf, before that day's sales:
        // daily files from then on are sales it does not yet hold
        if (cumAsOf && dates[i] >= cumAsOf) soldSince += sold;
      }
      for (var j = 0; j < spark.length; j++) {
        var mm = state.days[spark[j]].mv[k];
        series.push(mm ? mm[1] : 0);
      }
      var bal = (state.latest && state.latest.bal[k]) || 0;
      var c = cum && cum.rows[k];

      /* Sell-through over 15 days: pieces sold in those days, out of the pieces
         on hand when they began. That opening stock is today's, plus what sold,
         less what came in, in the daily files of those days. */
      var sold15 = 0, in15 = 0;
      for (var w = 0; w < win.length; w++) {
        var mw = state.days[win[w]].mv[k];
        if (mw) { in15 += mw[0]; sold15 += mw[1]; }
      }
      var open15 = Math.max(bal + sold15 - in15, sold15);

      var ratePerDay;
      // a design the full-period export has never seen (it arrived since) has
      // no long run to lean on: its daily files are all there is
      var periodRate = c && periodWeeks ? c.tout / (periodWeeks * 7) : null;
      if (periodRate != null && nDays) ratePerDay = (periodRate * PRIOR_DAYS + soldDaily) / (PRIOR_DAYS + nDays);
      else if (periodRate != null) ratePerDay = periodRate;
      else ratePerDay = nDays ? soldDaily / nDays : 0;

      var cover = ratePerDay > 0 ? (bal / ratePerDay) / 7 : null;   // weeks
      var everSold = soldObs > 0 || (c && c.tout > 0);
      // the pace-based verdict, kept for "Should I buy?" while the 15 days fill
      var paceStatus = bal <= 0 ? 'soldout'
                 : !everSold ? 'dead'
                 : cover == null ? 'dead'
                 : cover > slowWeeks ? 'slow'
                 : cover > fastWeeks ? 'steady' : 'fast';
      var st15 = win.length && open15 > 0 ? sold15 / open15 : null;
      var status = ready15 && st15 != null ? band(st15) : 'others';

      var soldShown = cum ? (c ? c.tout : 0) + soldSince : soldDaily;
      return {
        key: k, ref: state.refs[k] || k, seller: state.sellers[k] || '',
        // % sales: of every piece that came in, how many have sold
        pctSold: soldShown + bal > 0 ? soldShown / (soldShown + bal) : null,
        bal: bal, soldObs: soldObs, inObs: inObs,
        // what "Sold" means on the page: the year so far, from the full-period
        // export, plus the daily files that came after it; with no full-period
        // export, what the daily files recorded
        sold: cum ? (c ? c.tout : 0) + soldSince : soldDaily,
        soldCum: c ? c.tout : null, inCum: c ? c.tin : null,
        rate: ratePerDay, cover: cover, series: series,
        lastSale: last, idle: last && asOf ? daysBetween(last, asOf) : null,
        sold15: sold15, open15: open15,
        sellThrough15: st15,
        status: status, paceStatus: paceStatus
      };
    });

    // seller rollup
    var byS = {};
    lines.forEach(function (l) {
      var nm = l.seller || 'Not yet mapped';
      var s = byS[nm] || (byS[nm] = {
        seller: nm, lines: 0, bal: 0, soldObs: 0, sold: 0, rate: 0, sold15: 0, open15: 0,
        series: spark.map(function () { return 0; })
      });
      s.lines++; s.bal += l.bal; s.soldObs += l.soldObs; s.sold += l.sold; s.rate += l.rate;
      s.sold15 += l.sold15; s.open15 += l.open15;
      for (var i = 0; i < s.series.length; i++) s.series[i] += l.series[i] || 0;
    });
    var sellers = Object.keys(byS).map(function (nm) {
      var s = byS[nm];
      s.cover = s.rate > 0 ? (s.bal / s.rate) / 7 : null;
      s.pctSold = s.sold + s.bal > 0 ? s.sold / (s.sold + s.bal) : null;
      s.sellThrough15 = win.length && s.open15 > 0 ? s.sold15 / s.open15 : null;
      s.status = ready15 && s.sellThrough15 != null ? band(s.sellThrough15) : 'others';
      return s;
    }).sort(function (a, b) { return b.sold - a.sold || b.bal - a.bal; });

    var tot = { fast: 0, medium: 0, steady: 0, slow: 0, dead: 0, others: 0 };
    var pcs = { fast: 0, medium: 0, steady: 0, slow: 0, dead: 0, others: 0 };
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
      // the daily files the 15-day sell-through rests on
      sellWindow: { days: SELL_DAYS, files: win.length, from: winFrom, to: asOf, ready: ready15,
                    fromPeriods: win.some(function (d) { return state.days[d].p; }) },
      coverFrom: coverFrom, periodSteps: dates.length - realDates.length,
      slowWeeks: slowWeeks, fastWeeks: fastWeeks
    };
  }

  global.Compute = {
    parseWorkbook: parseWorkbook,
    dateFromName: dateFromName,
    ingest: ingest,
    masterAsOf: masterAsOf,
    sameAs: sameAs,
    analyse: analyse,
    normKey: normKey,
    daysBetween: daysBetween,
    MIN_DAILY_DAYS: MIN_DAILY_DAYS,
    PRIOR_DAYS: PRIOR_DAYS,
    SELL_DAYS: SELL_DAYS,
    BANDS: BANDS
  };
})(window);
