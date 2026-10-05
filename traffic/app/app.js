// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KeyValueStore.com
//
// Page logic for the Traffic Analyzer. The analysis lives in ../traffic.js;
// this file reads a capture in steps and draws the results.

(function () {
  'use strict';
  const T = window.KVTraffic;
  const $ = (id) => document.getElementById(id);
  const fmt = (n) => Number(n).toLocaleString('en-US');
  const fmt1 = (n) => Number(n).toLocaleString('en-US', { maximumFractionDigits: 1 });
  const pct = (x) => (100 * x).toFixed(1) + '%';
  const plural = (n, one, many) => fmt(n) + ' ' + (n === 1 ? one : many);
  const CHUNK = 2 * 1024 * 1024;
  const tick = () => new Promise((r) => setTimeout(r, 0));

  function el(tag, attrs, children) {
    const n = document.createElement(tag);
    if (attrs) for (const k of Object.keys(attrs)) {
      if (k === 'class') n.className = attrs[k];
      else if (k === 'text') n.textContent = attrs[k];
      else n.setAttribute(k, attrs[k]);
    }
    for (const c of [].concat(children || [])) if (c != null) n.append(c.nodeType ? c : document.createTextNode(String(c)));
    return n;
  }
  const ICONS = {
    warn: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 2l9 16H1z" fill="currentColor" opacity=".15"/><path d="M10 8v4.5M10 15.2v.3" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
    bad: '<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="9" fill="currentColor" opacity=".15"/><path d="M6.5 6.5l7 7M13.5 6.5l-7 7" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
    ok: '<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="9" fill="currentColor" opacity=".15"/><path d="M5.5 10.5l3 3 6-7" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    info: '<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="9" fill="currentColor" opacity=".15"/><path d="M10 9v5M10 6.2v.3" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>'
  };
  function verdict(kind, title, body) {
    const box = el('div', { class: 'verdict ' + kind, role: 'status' });
    box.innerHTML = ICONS[kind];
    const p = el('div');
    p.append(el('p', null, [el('strong', { text: title })]));
    for (const line of [].concat(body || [])) p.append(line.nodeType && line.tagName !== 'SPAN' ? line : el('p', null, [line]));
    box.append(p);
    return box;
  }
  function figure(value, label) {
    return el('div', { class: 'figure' }, [el('span', { class: 'value', text: value }), el('span', { class: 'label', text: label })]);
  }
  function table(headers, rows, numeric, cls) {
    const wrap = el('div', { class: 'table-wrap' + (cls ? ' ' + cls : '') });
    const t = el('table');
    t.append(el('thead', null, [el('tr', null, headers.map((h, i) => el('th', { class: numeric && numeric.includes(i) ? 'num' : '', text: h })))]));
    const body = el('tbody');
    for (const r of rows) body.append(el('tr', null, r.map((c, i) => (c && c.tagName === 'TD' ? c : el('td', { class: numeric && numeric.includes(i) ? 'num' : '' }, [c])))));
    t.append(body); wrap.append(t);
    return wrap;
  }
  function keyCell(text) { return el('td', { class: 'key' }, [text]); }
  // A share as a bar and a number. The biggest share in the table gets the
  // longest bar.
  function shareCell(x, max) {
    return el('td', { class: 'share-cell' }, [el('span', { class: 'share', style: 'width:' + Math.max(2, Math.round(80 * x / (max || 1))) + 'px' }), pct(x)]);
  }
  function download(name, parts, type) {
    const url = URL.createObjectURL(new Blob(parts, { type: type }));
    const a = el('a', { href: url, download: name });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function csvCell(s) { return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }
  const strict = new TextDecoder('utf-8', { fatal: true });
  function csvKey(bytes) { try { return csvCell(strict.decode(bytes)); } catch (e) { return csvCell(T.showKey(bytes)); } }
  const clock = (sec) => new Date(sec * 1000).toISOString().slice(11, 19);
  const stamp = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
  function duration(s) {
    if (s < 1) return fmt(Math.round(s * 1000)) + ' ms';
    if (s < 120) return fmt1(s) + ' s';
    if (s < 7200) return fmt1(s / 60) + ' min';
    return fmt1(s / 3600) + ' h';
  }

  // ---- Charts ----

  const SVGNS = 'http://www.w3.org/2000/svg';
  function svg(tag, attrs, text) {
    const n = document.createElementNS(SVGNS, tag);
    for (const k of Object.keys(attrs || {})) n.setAttribute(k, attrs[k]);
    if (text !== undefined) n.textContent = text;
    return n;
  }
  function niceStep(max, count) {
    const raw = max / count, mag = Math.pow(10, Math.floor(Math.log10(raw)));
    for (const m of [1, 2, 2.5, 5, 10]) if (m * mag >= raw) return m * mag;
    return 10 * mag;
  }
  function barPath(x, y, w, h) { const r = Math.min(4, w, h / 2); return `M${x},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h - r}Q${x + w},${y + h} ${x + w - r},${y + h}H${x}Z`; }

  // Charts are drawn at the width of their holder, so text keeps its size on
  // any screen, and drawn again when the width changes.
  let charts = [];
  function sized(holder, draw) {
    const paint = () => {
      const w = Math.round(holder.clientWidth);
      if (!w || w === holder.drawnAt) return;
      holder.drawnAt = w;
      holder.textContent = '';
      holder.append(draw(w));
    };
    paint.redraw = () => { holder.drawnAt = 0; paint(); };
    charts.push(paint);
    return paint;
  }
  let resizeTimer = null;
  window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => charts.forEach((p) => p()), 150); });
  const compact = (k) => (k >= 1e6 ? k / 1e6 + 'M' : k >= 1e3 ? k / 1e3 + 'k' : String(k));

  // A crosshair and a tooltip that follow the pointer to the nearest point.
  // px, py: the points in chart units, px rising; text(i): the tooltip lines.
  function hover(wrap, s, W, H, pad, px, py, text) {
    const cursor = svg('line', { class: 'cursor', y1: pad.t, y2: H - pad.b, visibility: 'hidden' });
    const dot = svg('circle', { class: 'dot', r: 4, visibility: 'hidden' });
    const hit = svg('rect', { class: 'hit', x: pad.l, y: 0, width: W - pad.l - pad.r, height: H - pad.b });
    const tip = el('div', { class: 'tip', hidden: '' });
    s.append(cursor, dot, hit);
    wrap.append(tip);
    const show = (clientX) => {
      const r = s.getBoundingClientRect();
      const x = (clientX - r.left) * W / r.width;
      let lo = 0, hi = px.length - 1;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (px[mid] < x) lo = mid + 1; else hi = mid; }
      if (lo > 0 && x - px[lo - 1] < px[lo] - x) lo--;
      cursor.setAttribute('x1', px[lo]); cursor.setAttribute('x2', px[lo]);
      dot.setAttribute('cx', px[lo]); dot.setAttribute('cy', py[lo]);
      cursor.setAttribute('visibility', 'visible'); dot.setAttribute('visibility', 'visible');
      tip.textContent = '';
      text(lo).forEach((line, i) => { if (i) tip.append(el('br'), line); else tip.append(el('strong', { text: line })); });
      tip.hidden = false;
      const left = px[lo] * r.width / W;
      tip.style.left = left + 'px';
      tip.style.top = (py[lo] * r.height / H) + 'px';
      tip.style.transform = `translate(${left < 80 ? '-10%' : left > r.width - 80 ? '-90%' : '-50%'}, -100%)`;
    };
    const hide = () => { cursor.setAttribute('visibility', 'hidden'); dot.setAttribute('visibility', 'hidden'); tip.hidden = true; };
    hit.addEventListener('pointermove', (e) => show(e.clientX));
    hit.addEventListener('pointerdown', (e) => show(e.clientX));
    hit.addEventListener('pointerleave', hide);
  }

  // Commands per second over the capture.
  function seriesChart(r, W) {
    const step = r.series.step, start = r.series.start;
    const ys = r.series.counts.map((c) => c / step);
    const n = ys.length;
    const H = W < 560 ? 200 : 250, pad = { l: 48, r: 12, t: 22, b: 30 };
    const plotW = W - pad.l - pad.r, plotH = H - pad.t - pad.b;
    let top = 1, peakAt = 0;
    ys.forEach((v, i) => { if (v > top) top = v; if (v > ys[peakAt]) peakAt = i; });
    const yStep = niceStep(top, 4), yMax = Math.ceil(top / yStep) * yStep;
    const x = (i) => pad.l + i * plotW / (n - 1);
    const y = (v) => pad.t + plotH * (1 - v / yMax);
    const s = svg('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': `Commands per second from ${clock(start)} to ${clock(start + (n - 1) * step)} UTC, peaking at ${fmt1(ys[peakAt])}` });
    for (let v = 0; v <= yMax + 1e-9; v += yStep) {
      s.append(svg('line', { x1: pad.l, x2: W - pad.r, y1: y(v), y2: y(v), class: 'grid' }));
      s.append(svg('text', { x: pad.l - 8, y: y(v) + 4, 'text-anchor': 'end' }, fmt(v)));
    }
    const span = (n - 1) * step;
    let every = 1;
    const most = Math.max(3, Math.floor(plotW / 100));
    for (const t of [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 10800, 21600, 43200, 86400]) { every = t; if (span / t <= most) break; }
    for (let t = Math.ceil(start / every) * every; t <= start + span; t += every) {
      const xi = pad.l + (t - start) / span * plotW;
      s.append(svg('line', { x1: xi, x2: xi, y1: H - pad.b, y2: H - pad.b + 4, class: 'axis' }));
      s.append(svg('text', { x: xi, y: H - pad.b + 18, 'text-anchor': 'middle' }, every >= 60 ? clock(t).slice(0, 5) : clock(t)));
    }
    s.append(svg('line', { x1: pad.l, x2: W - pad.r, y1: y(0), y2: y(0), class: 'axis' }));
    let d = '';
    ys.forEach((v, i) => { d += (i ? 'L' : 'M') + x(i).toFixed(1) + ',' + y(v).toFixed(1); });
    s.append(svg('path', { d: d + `L${x(n - 1).toFixed(1)},${y(0)}L${x(0).toFixed(1)},${y(0)}Z`, class: 'area' }));
    s.append(svg('path', { d: d, class: 'line' }));
    const px = ys.map((_, i) => x(i)), py = ys.map((v) => y(v));
    s.append(svg('circle', { cx: px[peakAt], cy: py[peakAt], r: 4, class: 'dot' }));
    const right = px[peakAt] > W - 90;
    s.append(svg('text', { x: px[peakAt] + (right ? -8 : 8), y: py[peakAt] - 6, 'text-anchor': right ? 'end' : 'start', class: 'label' }, 'Peak ' + fmt1(ys[peakAt])));
    const wrap = el('div', { class: 'chart' }, [s]);
    hover(wrap, s, W, H, pad, px, py, (i) => [
      step === 1 ? clock(start + i) : clock(start + i * step) + ' to ' + clock(start + (i + 1) * step),
      step === 1 ? plural(r.series.counts[i], 'command', 'commands') : fmt1(ys[i]) + ' a second on average'
    ]);
    return wrap;
  }

  // Share of reads an LRU cache serves, by the number of keys it holds.
  function curveChart(c, mark, W) {
    const H = W < 560 ? 220 : 270, pad = { l: 48, r: 12, t: 22, b: 36 };
    const plotW = W - pad.l - pad.r, plotH = H - pad.t - pad.b;
    const max = Math.max(1, c.keys), logX = max >= 20;
    const pts = c.points.filter((p) => !logX || p[0] >= 1);
    const x = (k) => pad.l + plotW * (logX ? Math.log(Math.max(1, k)) / Math.log(max) : k / max);
    const y = (h) => pad.t + plotH * (1 - h);
    const s = svg('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': `LRU cache hit rate by cache size, up to ${pct(c.best)} with all ${fmt(c.keys)} keys` });
    for (const h of [0, 0.25, 0.5, 0.75, 1]) {
      s.append(svg('line', { x1: pad.l, x2: W - pad.r, y1: y(h), y2: y(h), class: 'grid' }));
      s.append(svg('text', { x: pad.l - 8, y: y(h) + 4, 'text-anchor': 'end' }, Math.round(h * 100) + '%'));
    }
    const ticks = [];
    if (logX) { for (let k = 1; k <= max; k *= 10) ticks.push(k); }
    else { const st = niceStep(max, 5); for (let k = 0; k <= max; k += st) ticks.push(k); }
    for (const k of ticks) {
      s.append(svg('line', { x1: x(k), x2: x(k), y1: H - pad.b, y2: H - pad.b + 4, class: 'axis' }));
      s.append(svg('text', { x: x(k), y: H - pad.b + 18, 'text-anchor': 'middle' }, logX ? compact(k) : fmt(k)));
    }
    s.append(svg('text', { x: W - pad.r, y: H - 2, 'text-anchor': 'end' }, 'keys in the cache' + (logX ? ' (log scale)' : '')));
    s.append(svg('line', { x1: pad.l, x2: W - pad.r, y1: y(0), y2: y(0), class: 'axis' }));
    s.append(svg('line', { x1: pad.l, x2: W - pad.r, y1: y(c.best), y2: y(c.best), class: 'ref' }));
    s.append(svg('text', { x: pad.l + 6, y: y(c.best) - 6 }, 'All keys held: ' + pct(c.best)));
    let d = '';
    pts.forEach((p, i) => { d += (i ? 'L' : 'M') + x(p[0]).toFixed(1) + ',' + y(p[1]).toFixed(1); });
    s.append(svg('path', { d: d, class: 'line' }));
    if (mark !== null && mark !== undefined && mark >= (logX ? 1 : 0)) s.append(svg('circle', { cx: x(Math.min(mark, max)), cy: y(c.hitRate(mark)), r: 5, class: 'dot' }));
    const wrap = el('div', { class: 'chart' }, [s]);
    hover(wrap, s, W, H, pad, pts.map((p) => x(p[0])), pts.map((p) => y(p[1])), (i) => [plural(pts[i][0], 'key', 'keys'), pct(pts[i][1]) + ' of reads served']);
    return wrap;
  }

  // Key accesses per primary, as horizontal bars.
  function spreadChart(sp, total, W) {
    const narrow = W < 560;
    const rowH = narrow ? 46 : 30, labelW = narrow ? 0 : 190, H = sp.ranges.length * rowH + 4;
    const max = Math.max(1, ...sp.perPrimary);
    const plotW = narrow ? W - 4 : W - labelW - 200;
    const s = svg('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: 'img', 'aria-label': 'Key accesses per primary' });
    sp.ranges.forEach(([a, b], i) => {
      const yy = i * rowH + 2, v = sp.perPrimary[i];
      const name = `Primary ${i + 1}, slots ${a} to ${b}`, value = `${pct(total ? v / total : 0)}, ${plural(v, 'access', 'accesses')}`;
      const w = Math.max(2, plotW * v / max);
      const bar = svg('path', { d: barPath(labelW, yy + (narrow ? 22 : 5), w, narrow ? 16 : rowH - 12), class: 'bar' });
      bar.append(svg('title', {}, `Primary ${i + 1}: ${plural(v, 'key access', 'key accesses')}`));
      if (narrow) s.append(svg('text', { x: 0, y: yy + 14 }, name + ': ' + value));
      else {
        s.append(svg('text', { x: labelW - 10, y: yy + 18, 'text-anchor': 'end' }, name));
        s.append(svg('text', { x: labelW + w + 8, y: yy + 18 }, value));
      }
      s.append(bar);
    });
    if (!narrow) s.append(svg('line', { x1: labelW, y1: 0, x2: labelW, y2: H, class: 'axis' }));
    return el('div', { class: 'chart' }, [s]);
  }

  // ---- Reading ----

  let an = null, res = null, curve = null, busy = false;

  async function run(feed, name) {
    if (busy) return;
    busy = true;
    $('result').textContent = '';
    const status = $('status');
    status.textContent = '';
    const bar = el('span');
    const msg = el('p', { class: 'muted small', text: 'Reading ' + name + '...' });
    status.append(msg, el('div', { class: 'progress' }, [bar]));
    try {
      an = T.analyzer();
      await feed(an, (f) => { bar.style.width = (100 * f).toFixed(1) + '%'; });
      res = an.result({ top: 25 });
      if (!res.commands) {
        status.textContent = '';
        status.append(verdict('bad', 'No MONITOR lines found', [
          'A capture has one line per command, like this:',
          el('pre', { class: 'out', text: '1791218550.753456 [0 10.0.0.12:54650] "GET" "user:42"' }),
          res.unparsedExamples.length ? 'The first line of this one reads: ' + res.unparsedExamples[0] : 'This one is empty.'
        ]));
        return;
      }
      msg.textContent = 'Working out the cache hit rates...';
      await tick();
      curve = an.curve();
      status.textContent = '';
      render(name);
    } catch (e) {
      status.textContent = '';
      status.append(verdict('bad', 'Could not read the capture', e.message));
    } finally {
      busy = false;
    }
  }

  function readFile(file) {
    run(async (a, progress) => {
      const dec = new TextDecoder('utf-8');
      for (let pos = 0; pos < file.size; pos += CHUNK) {
        const buf = await file.slice(pos, pos + CHUNK).arrayBuffer();
        a.addChunk(dec.decode(new Uint8Array(buf), { stream: true }), false);
        progress(Math.min(1, (pos + CHUNK) / file.size));
        await tick();
      }
      a.addChunk(dec.decode(), true);
    }, file.name);
  }
  function readText(text, name) {
    run(async (a, progress) => {
      const STEP = 2000000;
      for (let i = 0; i < text.length; i += STEP) {
        a.addChunk(text.slice(i, i + STEP), false);
        progress(Math.min(1, (i + STEP) / text.length));
        await tick();
      }
      a.addChunk('', true);
    }, name);
  }
  function loadExample() {
    return new Promise((resolve, reject) => {
      if (typeof window.KVTrafficExample === 'string') { resolve(window.KVTrafficExample); return; }
      const s = document.createElement('script');
      s.src = 'example.js';
      s.onload = () => resolve(window.KVTrafficExample);
      s.onerror = () => reject(new Error('The example could not be loaded.'));
      document.head.append(s);
    });
  }

  // ---- Results ----

  function block(id, title, lede) {
    const b = el('div', { class: 'block', id: id }, [el('h3', { text: title })]);
    if (lede) b.append(el('p', { class: 'lede' }, lede));
    return b;
  }
  const code = (t) => el('code', { text: t });

  function render(name) {
    const out = $('result');
    out.textContent = '';
    charts = [];
    const r = res;
    out.append(el('h2', { text: 'What the traffic is made of' }));
    out.append(el('p', { class: 'muted small', text: `${name}: from ${stamp(r.start)} to ${stamp(r.end).slice(11)} UTC` }));
    out.append(el('div', { class: 'figures' }, [
      figure(fmt(r.commands), 'commands'),
      figure(duration(r.duration), 'captured'),
      figure(fmt1(r.average), 'a second on average'),
      figure(fmt(r.peak.count), 'in the busiest second'),
      figure(fmt(r.keys.distinct), r.keys.distinct === 1 ? 'key' : 'keys'),
      figure(fmt(r.connections), r.connections === 1 ? 'connection' : 'connections')
    ]));
    const k = r.kinds;
    const facts = el('dl', { class: 'facts' });
    const fact = (t, v) => facts.append(el('dt', { text: t }), el('dd', null, [v]));
    fact('Kinds', `Reads ${pct(k.read / r.commands)}, writes ${pct(k.write / r.commands)}, scripts ${pct(k.script / r.commands)}, pub/sub ${pct(k.pubsub / r.commands)}, other ${pct(k.other / r.commands)}`);
    fact('Key accesses', `${fmt(r.keys.accesses)}: ${plural(r.keys.reads, 'read', 'reads')}, ${plural(r.keys.writes, 'write', 'writes')}, ${plural(r.keys.deletes, 'delete', 'deletes')}`);
    if (r.byDb.length > 1 || r.byDb[0].db !== 0) fact('Databases', r.byDb.map((d) => `db${d.db} ${fmt(d.count)}`).join(', '));
    if (r.multi) fact('Transactions', plural(r.multi, 'MULTI', 'MULTIs'));
    if (r.scripts || r.luaLines) fact('Scripts', `${plural(r.scripts, 'call', 'calls')}, which ran ${plural(r.luaLines, 'command', 'commands')}`);
    fact('Bytes sent', `${fmt(r.bytes)} in arguments`);
    if (r.unparsed) fact('Skipped', `${plural(r.unparsed, 'line', 'lines')} that weren't MONITOR lines, such as: ${r.unparsedExamples[0]}`);
    out.append(facts);

    // Commands per second.
    const sec = block('b-series', 'Commands per second', r.series.step > 1 ? `Averaged over steps of ${duration(r.series.step)}.` : null);
    if (r.series.counts.length > 1) { const holder = el('div'); sec.append(holder); sized(holder, (w) => seriesChart(r, w)); }
    else sec.append(el('p', { text: `All ${plural(r.commands, 'command', 'commands')} came within one second.` }));
    out.append(sec);

    // Command mix.
    const mix = block('b-mix', 'Command mix', null);
    const mixRows = (list) => list.map((c) => [el('td', { class: 'key', text: c.name }), el('td', { class: 'kind', text: c.kind }), fmt(c.count), shareCell(c.count / r.commands, r.byCommand[0].count / r.commands)]);
    const mixTable = table(['Command', 'Kind', 'Count', 'Share'], mixRows(r.byCommand.slice(0, 15)), [2], 'mix-table');
    mix.append(mixTable);
    if (r.byCommand.length > 15) {
      const more = el('button', { type: 'button', class: 'btn', text: `Show all ${fmt(r.byCommand.length)}` });
      more.addEventListener('click', () => { mixTable.replaceWith(table(['Command', 'Kind', 'Count', 'Share'], mixRows(r.byCommand), [2], 'mix-table')); more.remove(); });
      mix.append(more);
    }
    out.append(mix);

    // Keys and patterns.
    if (r.keys.distinct) {
      const keys = block('b-keys', 'Busiest keys', 'Reads, writes and deletes per key. Commands that scripts run count, the scripts themselves don\'t.');
      keys.append(table(['Key', 'Reads', 'Writes', 'Deletes', 'Share'],
        r.keys.top.map((x) => [keyCell((x.db ? 'db' + x.db + ' ' : '') + T.showKey(x.key)), fmt(x.reads), fmt(x.writes), fmt(x.deletes), shareCell(x.total / r.keys.accesses, r.keys.top[0].total / r.keys.accesses)]),
        [1, 2, 3], 'keys-table'));
      out.append(keys);
      const pats = block('b-patterns', 'Key patterns', `${plural(r.patternCount, 'pattern', 'patterns')}${r.separator ? ', with keys split at "' + r.separator + '"' : ''}. Numbers, IDs, dates and the like are folded into placeholders such as <id>.`);
      pats.append(table(['Pattern', 'Keys', 'Reads', 'Writes', 'Share'],
        r.patterns.map((p) => [keyCell(p.pattern), fmt(p.keys), fmt(p.reads), fmt(p.writes), shareCell(p.accesses / r.keys.accesses, r.patterns[0].accesses / r.keys.accesses)]),
        [1, 2, 3], 'pattern-table'));
      out.append(pats);
    }

    // Clients.
    const cl = block('b-clients', 'Clients', 'By address. Commands that scripts run show up as lua.');
    cl.append(table(['Address', 'Commands', 'Connections', 'Most sent'],
      r.hosts.map((h) => [keyCell(h.host === 'lua' ? 'lua (scripts)' : h.host), fmt(h.count), h.host === 'lua' ? '' : fmt(h.connections), h.top.map((t) => t[0] + ' ' + fmt(t[1])).join(', ')]),
      [1, 2], 'client-table'));
    out.append(cl);

    // Cluster spread.
    if (r.cluster.keyAccesses) {
      const cs = block('b-cluster', 'Spread over a cluster', ['How the key accesses would land on a new cluster, with slots split the way ', code('redis-cli --cluster create'), ' splits them. Keys in one slot always live on the same primary.']);
      const sel = el('select', { id: 'primaries' });
      for (let n = 1; n <= 16; n++) sel.append(el('option', { value: n, text: n }));
      sel.value = '3';
      const row = el('div', { class: 'row' }, [el('div', { class: 'field' }, [el('label', { for: 'primaries', text: 'Primaries' }), sel])]);
      const holder = el('div');
      const paint = sized(holder, (w) => spreadChart(an.spread(+sel.value), r.cluster.keyAccesses, w));
      sel.addEventListener('change', paint.redraw);
      cs.append(row, holder, el('p', { class: 'small muted', text: `${plural(r.cluster.slotsUsed, 'slot', 'slots')} in use. Busiest: ${r.cluster.hotSlots.slice(0, 5).map((s) => `${s.slot} (${plural(s.accesses, 'access', 'accesses')})`).join(', ')}.` }));
      out.append(cs);
    }

    // Findings.
    const fi = block('b-findings', 'Worth a look', null);
    if (!r.findings.length) fi.append(verdict('ok', 'Nothing stood out', 'No KEYS, flushes, large values, cross-slot commands or hot keys in this capture.'));
    for (const f of r.findings) {
      const body = [f.text];
      if (f.examples.length) body.push(el('ul', { class: 'examples' }, f.examples.map((x) => el('li', { text: x }))));
      fi.append(verdict(f.level, `${f.title} (${plural(f.count, 'time', 'times')})`, body));
    }
    out.append(fi);

    // Cache hit rate.
    out.append(renderCurve());

    // Downloads.
    const dl = block('b-downloads', 'Take it with you', null);
    const btn = (text, fn) => { const b = el('button', { type: 'button', class: 'btn', text: text }); b.addEventListener('click', fn); return b; };
    dl.append(el('div', { class: 'downloads' }, [
      btn('Keys as CSV', () => {
        const parts = ['db,key,reads,writes,deletes\n'];
        let chunk = [];
        an.eachKey((db, key, rd, wr, de) => {
          chunk.push(db + ',' + csvKey(T.fromLatin1(key)) + ',' + rd + ',' + wr + ',' + de);
          if (chunk.length === 10000) { parts.push(chunk.join('\n') + '\n'); chunk = []; }
        });
        if (chunk.length) parts.push(chunk.join('\n') + '\n');
        download('keys.csv', parts, 'text/csv');
      }),
      btn('Commands per second as CSV', () => {
        const step = r.series.step;
        const lines = [step === 1 ? 'time,commands' : `time,commands in ${step} s`];
        r.series.counts.forEach((n, i) => lines.push(stamp((r.series.start + i * step) * 1000) + ',' + n));
        download('commands-per-second.csv', [lines.join('\n') + '\n'], 'text/csv');
      }),
      btn('Hit-rate curve as CSV', () => {
        download('hit-rate.csv', ['keys,hit_rate\n' + curve.points.map((p) => p[0] + ',' + p[1].toFixed(6)).join('\n') + '\n'], 'text/csv');
      })
    ]));
    out.append(dl);
    charts.forEach((p) => p());
  }

  function renderCurve() {
    const c = curve;
    const b = block('b-curve', 'Cache hit rate', 'The share of reads a least-recently-used cache would serve, by how many keys it holds. The first read of each key misses in any cache. Writes count as uses, deletes free their slot, and a key that is read but not there is loaded.');
    if (!c.reads) { b.append(el('p', { text: 'There are no reads of keys in this capture.' })); return b; }
    const need = c.sizes.find((s) => s.share === 0.9);
    b.append(el('div', { class: 'figures' }, [
      figure(fmt(c.reads), 'reads of keys'),
      figure(fmt(c.coldReads), 'first reads, which always miss'),
      figure(pct(c.best), 'best possible, with every key held'),
      figure(need && need.keys !== null ? fmt(need.keys) : 'none', 'keys for 90% of the best')
    ]));
    if (c.partial) b.append(verdict('info', 'The curve covers part of the capture', `It uses the first ${fmt(c.accesses)} key accesses.`));
    const holder = el('div');
    const input = el('input', { type: 'number', id: 'cache', min: '1', step: '1', value: String(need && need.keys ? need.keys : Math.max(1, Math.round(c.keys / 10))) });
    const answer = el('p', { 'aria-live': 'polite' });
    const size = () => Math.max(0, Math.floor(+input.value || 0));
    const paint = sized(holder, (w) => curveChart(c, size(), w));
    const update = () => {
      const n = size();
      paint.redraw();
      const hr = c.hitRate(n);
      answer.textContent = `A cache of ${plural(n, 'key', 'keys')} would serve ${pct(hr)} of the reads${c.best ? `, ${pct(hr / c.best)} of the best possible` : ''}.`;
    };
    input.addEventListener('input', update);
    b.append(holder, el('div', { class: 'row' }, [el('div', { class: 'field' }, [el('label', { for: 'cache', text: 'Cache size in keys' }), input])]), answer);
    update();
    b.append(table(['Share of the best hit rate', 'Keys needed', 'Hit rate'],
      c.sizes.filter((s) => s.keys !== null).map((s) => [Math.round(s.share * 100) + '%', fmt(s.keys), pct(c.hitRate(s.keys))]), [1, 2]));
    return b;
  }

  // ---- Wiring ----

  $('file').addEventListener('change', (e) => { const f = e.target.files[0]; if (f) readFile(f); e.target.value = ''; });
  const drop = $('drop');
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); const f = e.dataTransfer.files[0]; if (f) readFile(f); });
  $('example').addEventListener('click', () => {
    loadExample().then((text) => readText(text, 'the example (45 seconds of a test workload on Valkey 9.1.2)'), (e) => { $('status').textContent = ''; $('status').append(verdict('bad', 'Could not load the example', e.message)); });
  });
  $('analyze').addEventListener('click', () => readText($('paste').value, 'the pasted lines'));
})();
