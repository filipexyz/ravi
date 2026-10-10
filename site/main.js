/* ===== 00-core.js ===== */
/* ravi.bot "One Loop" — core: boot + gating, motion vocabulary, helpers, section registry,
   pins + beat chips, header menu, copy buttons, anchors, generic reveals. */
(function (w, d) {
'use strict';
var html = d.documentElement;
var $ = function (s, r) { return (r || d).querySelector(s); };
var $$ = function (s, r) { return Array.prototype.slice.call((r || d).querySelectorAll(s)); };

/* ---------- motion vocabulary (spec 1.5) ---------- */
var E = { rise: 'expo.out', exit: 'power3.in', enter: 'power2.out', wipe: 'power2.inOut', cut: 'power3.inOut',
  pop: 'back.out(2)', popSoft: 'back.out(1.6)', popHard: 'back.out(3)', refuse: 'elastic.out(1,0.5)',
  hold: 'sine.inOut', travel: 'none' };
var D = { rise: .65, exit: .25, enter: .45, wipe: .6, pop: .45, type: .02 };

var gsap = null, ST = null;
var registry = [];          // { id, def }
var pins = [];              // { wrap, st, tl, ctx, beats }
var scrollBeats = [];       // beat buttons owned by a pin in the current mode
var samplers = [];          // { path, pts, n, d } resampled on refresh when the path's d changed
var focusReveals = [];      // { el, tl }: on-enter timelines that finish at once when focus lands inside el
var pendingReveals = typeof WeakSet === 'function' ? new WeakSet() : null;   // [data-reveal] still at its hidden start
/* hardFrames: ?frames or no clip-path (for the whole visit). driftFrames: the Safari pin-drift check failed;
   it is cleared on the next breakpoint change, so a forced frames mode is never permanent. */
var state = { mode: null, hardFrames: false, driftFrames: false, driftKey: '', driftTimer: 0, kbAt: -1e9, jumpAt: -1e9,
  resizeAt: -1e9, layoutAt: -1e9, scrollAt: -1e9, inputAt: -1e9, hashDone: false, built: false, building: false, staged: true, mm: null, refreshQueued: false };
var nativeRAF = w.requestAnimationFrame;

function now() { return (w.performance && performance.now()) || Date.now(); }
function kbRecent() { return now() - state.kbAt < 1500; }
function jumpRecent() { return now() - state.jumpAt < 2500; }
function isMotion() { return html.classList.contains('motion'); }
function resolve(x, ctx) { if (!x) return null; if (typeof x === 'string') return (ctx && ctx.el.querySelector(x)) || d.querySelector(x); return x; }
function err(id, e) { try { console.error('[section ' + id + ']', e); } catch (_) {} }
/* WebKit (Safari, and every browser on iOS/iPadOS), the only engine the pin-drift check is for */
function isWebKit() {
  var ua = navigator.userAgent || '';
  if (/iP(hone|ad|od)/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return true;
  return /AppleWebKit/.test(ua) && !/(Chrome|Chromium|Edg|OPR|SamsungBrowser)\//.test(ua) && !/Android/.test(ua);
}
/* beats are live controls only while a desk pin owns them; everywhere else they are a numbered list */
/* Beats are plain text (the scene's narration) everywhere, and buttons only while a desk pin owns them. */
function inertBeat(b) { b.removeAttribute('role'); b.removeAttribute('tabindex'); b.removeAttribute('aria-disabled'); }
function liveBeat(b) { b.setAttribute('role', 'button'); b.setAttribute('tabindex', '0'); b.removeAttribute('aria-disabled'); }

/* ---------- helper module (spec 1.8) ---------- */
function maskIn(tl, lines, at) {
  var v = { yPercent: 0, y: 0, ease: E.rise, duration: D.rise, stagger: .12 };
  return tl ? tl.fromTo(lines, { yPercent: 110, y: 0 }, v, at) : gsap.fromTo(lines, { yPercent: 110, y: 0 }, v);
}
var GLYPHS = '/—_#0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
var scrCache = new WeakMap();
function textNodes(root) {
  var out = [], tw = d.createTreeWalker(root, NodeFilter.SHOW_TEXT, null), n;
  while ((n = tw.nextNode())) if (n.nodeValue.length) out.push(n);
  return out;
}
/* scramble(el, finalText?, dur): settles left to right, pure in tween progress (scrub-safe).
   Works on nested markup (e.g. eyebrow <b>01</b>): it scrambles text nodes in place. */
function scramble(el, finalText, dur) {
  dur = dur == null ? .4 : dur;
  var root = el.querySelector('[aria-hidden="true"]') || el;
  var nodes = scrCache.get(root);
  if (!nodes) { nodes = textNodes(root).map(function (n) { return { n: n, t: n.nodeValue }; }); scrCache.set(root, nodes); }
  if (finalText && nodes.length === 1) nodes[0].t = finalText;
  var total = nodes.reduce(function (a, x) { return a + x.t.length; }, 0), o = { p: 0 };
  function paint() {
    var k = Math.floor(o.p * total);
    for (var i = 0; i < nodes.length; i++) {
      var x = nodes[i], L = x.t.length, n = Math.max(0, Math.min(L, k)), tail = '';
      for (var j = n; j < L; j++) { var c = x.t[j]; tail += (c === ' ' || c === ' ') ? c : GLYPHS[(Math.random() * GLYPHS.length) | 0]; }
      x.n.nodeValue = x.t.slice(0, n) + tail; k -= L;
    }
  }
  return gsap.to(o, { p: 1, duration: dur, ease: 'none', onUpdate: paint, onStart: paint,
    onComplete: restore, onInterrupt: restore });
  function restore() { nodes.forEach(function (x) { x.n.nodeValue = x.t; }); }
}
/* typeLine(el): clip-path reveal stepped by character count (desktop .type lines). */
function typeLine(el, maxDur) {
  var n = Math.max(1, el.textContent.length);
  el.style.setProperty('--n', n);
  return gsap.fromTo(el, { clipPath: 'inset(0 100% 0 0)' },
    { clipPath: 'inset(0 0% 0 0)', ease: 'steps(' + n + ')', duration: Math.min(n * D.type, maxDur || .9) });
}
function count(el, to, dur, fmt) {
  var o = { v: 0 };
  fmt = fmt || function (v) { return Math.round(v).toLocaleString('en-US'); };
  return gsap.to(o, { v: to, duration: dur == null ? .55 : dur, ease: 'power2.out', onUpdate: function () { el.textContent = fmt(o.v); } });
}
function blink(el) { return gsap.fromTo(el, { opacity: 1 }, { opacity: 0, repeat: -1, yoyo: true, duration: .5, ease: 'steps(1)' }); }
function wipeIn(el, from, dur) {
  var m = { left: 'inset(0 100% 0 0)', right: 'inset(0 0 0 100%)', top: 'inset(0 0 100% 0)', bottom: 'inset(100% 0 0 0)' }[from || 'left'];
  return gsap.fromTo(el, { clipPath: m }, { clipPath: 'inset(0% 0% 0% 0%)', ease: E.wipe, duration: dur || D.wipe });
}
function wipeOut(el, to, dur) {
  var m = { left: 'inset(0 100% 0 0)', right: 'inset(0 0 0 100%)', top: 'inset(0 0 100% 0)', bottom: 'inset(100% 0 0 0)' }[to || 'top'];
  return gsap.fromTo(el, { clipPath: 'inset(0% 0% 0% 0%)' }, { clipPath: m, ease: E.wipe, duration: dur || D.wipe });
}
function press(btn) { return gsap.timeline().to(btn, { scale: .96, duration: .09 }).to(btn, { scale: 1, duration: .12, ease: E.enter }); }
function ripple(cur) {
  var r = cur.querySelector('.cur-ripple');
  return gsap.fromTo(r, { scale: .2, opacity: 1 }, { scale: 1.6, opacity: 0, duration: .5, ease: E.enter });
}
function center(el, stage) {
  var r = el.getBoundingClientRect(), s = stage.getBoundingClientRect();
  return { x: r.left - s.left + r.width / 2, y: r.top - s.top + r.height / 2 };
}
/* cursorTo: function-based values, so invalidateOnRefresh re-measures the target. */
function cursorTo(cur, target, stage, dur) {
  return gsap.to(cur, { x: function () { var r = resolve(target).getBoundingClientRect(), s = stage.getBoundingClientRect(); return r.left - s.left + r.width * .6; },
    y: function () { var r = resolve(target).getBoundingClientRect(), s = stage.getBoundingClientRect(); return r.top - s.top + r.height * .55; },
    ease: E.cut, duration: dur || .7 });
}
function samplePath(path, n) {
  n = n || 64;
  var L = path.getTotalLength(), out = [];
  for (var i = 0; i <= n; i++) { var p = path.getPointAtLength(L * i / n); out.push({ x: p.x, y: p.y }); }
  return out;
}
/* sampler(path): a points array that core refills after a ScrollTrigger refresh whenever the path's d changed
   (points are in the path's own user units, so only a rewritten d moves them). */
function sampler(path, n) {
  var rec = { path: path, pts: [], n: n || 64, d: path.getAttribute('d') };
  try { rec.pts.push.apply(rec.pts, samplePath(path, rec.n)); } catch (e) {}
  samplers.push(rec);
  return rec.pts;
}
function resample() {
  samplers = samplers.filter(function (r) { return r.path.isConnected; });
  samplers.forEach(function (r) {
    var dd = r.path.getAttribute('d'); if (dd === r.d && r.pts.length) return;
    try { var p = samplePath(r.path, r.n); r.pts.length = 0; r.pts.push.apply(r.pts, p); r.d = dd; } catch (e) {}
  });
}
/* packet(dot, pts|path, dur, ease): moves an HTML/SVG dot along sampled points with quickSetter. */
function packet(dot, src, dur, ease, from, to) {
  var pts = (src && src.getTotalLength) ? sampler(src) : src;
  var sx = gsap.quickSetter(dot, 'x', 'px'), sy = gsap.quickSetter(dot, 'y', 'px'), o = { t: from || 0 };
  function place() {
    var P = typeof pts === 'function' ? pts() : pts; if (!P || P.length < 2) return;
    var f = Math.max(0, Math.min(1, o.t)) * (P.length - 1), i = Math.min(f | 0, P.length - 2), k = f - i;
    sx(P[i].x + (P[i + 1].x - P[i].x) * k); sy(P[i].y + (P[i + 1].y - P[i].y) * k);
  }
  return gsap.fromTo(o, { t: from || 0 }, { t: to == null ? 1 : to, duration: dur == null ? .8 : dur, ease: ease || E.travel, onUpdate: place, onStart: place });
}
function packetRefuse(dot, src, dur) {
  var pts = (src && src.getTotalLength) ? sampler(src) : src;
  return gsap.timeline().add(packet(dot, pts, (dur || .8) * .85, E.travel, 0, .85)).add(packet(dot, pts, (dur || .8) * .6, E.refuse, .85, .6));
}
/* pt(el, frame, fx, fy): a point on el (fractions of its box, default the center) in frame's coordinates */
function pt(el, frame, fx, fy) {
  var r = resolve(el).getBoundingClientRect(), s = frame.getBoundingClientRect();
  return { x: r.left - s.left + r.width * (fx == null ? .5 : fx), y: r.top - s.top + r.height * (fy == null ? .5 : fy) };
}
/* arc(a, b, lift, n): points on a short hop from a to b: a quadratic curve that bows lift px off the straight line
   (default a third of the distance, 16 to 80 px), upward, or to the left when the hop is straight up or down.
   Feed it to packet(): packet(dot, arc(a, b), .45), or a function that returns it to re-measure on refresh. */
function arc(a, b, lift, n) {
  n = n || 24;
  var dx = b.x - a.x, dy = b.y - a.y, dist = Math.sqrt(dx * dx + dy * dy) || 1;
  if (lift == null) lift = Math.max(16, Math.min(80, dist * .35));
  var nx = -dy / dist, ny = dx / dist;
  if (ny > 1e-6 || (Math.abs(ny) <= 1e-6 && nx > 0)) { nx = -nx; ny = -ny; }
  var cx = (a.x + b.x) / 2 + nx * lift * 2, cy = (a.y + b.y) / 2 + ny * lift * 2, out = [];
  for (var i = 0; i <= n; i++) { var t = i / n, u = 1 - t; out.push({ x: u * u * a.x + 2 * u * t * cx + t * t * b.x, y: u * u * a.y + 2 * u * t * cy + t * t * b.y }); }
  return out;
}
/* breathe(pk, el, ctx): the packet token's idle glow (.pkt.is-breathing, a CSS pulse). It runs only while the
   packet rests (rest(true)) and el is on screen; ctx (optional) removes it on rebuild. Returns {rest(on), st}. */
function breathe(pk, el, ctx) {
  var resting = false, inView = false;
  function sync() { pk.classList.toggle('is-breathing', resting && inView); }
  var st = ST.create({ trigger: el || pk, start: 'top bottom', end: 'bottom top', onToggle: function (s) { inView = s.isActive; sync(); } });
  if (ctx) ctx.add(function () { pk.classList.remove('is-breathing'); });
  return { st: st, rest: function (on) { resting = on !== false; sync(); } };
}
function lit(chip, on, dur) { return gsap.to(chip, { '--lit': on === false ? 0 : 1, duration: dur || .3, ease: E.enter }); }
/* hold(tl, el, from, to, release?): slow push 1 → 1.02 over a hold's range; pass release (timeline units) to tween back to 1 after `to`. */
function hold(tl, el, from, to, release) {
  tl.fromTo(el, { scale: 1 }, { scale: 1.02, ease: E.hold, duration: to - from, immediateRender: false }, from);
  if (release) tl.to(el, { scale: 1, ease: E.exit, duration: Math.min(release, 1 - to) }, to);
  return tl;
}
/* pauseOffscreen(anim, el): play only while el is on screen. */
function pauseOffscreen(anim, el) {
  anim.pause();
  return ST.create({ trigger: el, start: 'top bottom', end: 'bottom top', onToggle: function (s) { s.isActive ? anim.play() : anim.pause(); } });
}
/* caretOn(caret, tl, at, scope): hide the caret until `at`, then blink while scope is on screen. */
function caretOn(caret, tl, at, scope) {
  var bl = blink(caret).pause(), ready = !tl, inView = false;
  if (tl) tl.fromTo(caret, { opacity: 0 }, { opacity: 1, duration: .01, immediateRender: true }, at).call(function () { ready = true; if (inView) bl.restart(); }, null, at);
  ST.create({ trigger: scope || caret, start: 'top bottom', end: 'bottom top', onToggle: function (s) { inView = s.isActive; if (inView && ready) bl.play(); else bl.pause(); } });
  return bl;
}
function scrollToY(y, label) {
  /* label jumps: no snap while the smooth scroll runs (setBeats tolerates 1.5px), so the target label is where it rests */
  if (label) state.jumpAt = now();
  state.scrollAt = now();   /* counts as scrolling from now, so a queued refresh() cannot cut it off before its first frame */
  w.scrollTo({ top: Math.max(0, label ? Math.ceil(y) : Math.round(y)), behavior: isMotion() ? 'smooth' : 'auto' });
}
/* an anchor's offset is the one the browser uses for a plain #link: scroll-padding-top plus scroll-margin-top */
function anchorOffset(t) { return (parseFloat(getComputedStyle(html).scrollPaddingTop) || 0) + (parseFloat(getComputedStyle(t).scrollMarginTop) || 0); }
/* once the page is still, the landing is measured again and nudged onto the target: a demo above it can change
   height while a smooth scroll runs, and a link followed during the first build lands before the pins above
   the target have added their length. Any wheel, touch or key from the reader cancels it (initChrome). */
var landing = null;
function settleAnchor(t) {
  var f = landing = { start: now() };
  function check() {
    if (landing !== f) return;
    if ((state.building || now() - state.scrollAt < 150) && now() - f.start < (state.building ? 10000 : 4000)) { setTimeout(check, 100); return; }
    landing = null;
    var dy = t.getBoundingClientRect().top - anchorOffset(t);
    if (Math.abs(dy) > 2) scrollToY(w.pageYOffset + dy);
  }
  setTimeout(check, 150);
}
/* a page opened on a #link lands before the pins add their spacing above the target; after the first build it
   lands again, unless the reader has already moved or the browser is restoring a reload or back/forward */
/* old anchors from the long page land on the section that took their place */
var HASH_ALIAS = { ask: 'top', build: 'tools', share: 'tools', wake: 'slack', click: 'slack', blockkit: 'slack', install: 'end' };
function alias(id) { return id && !d.getElementById(id) && HASH_ALIAS[id] ? HASH_ALIAS[id] : id; }
/* tells the target section that the reader is arriving through an anchor (a click on an in-page link, or a page
   opened on a #hash): a scrubbed scene can play itself instead of resting half-built where the jump lands */
function anchored(t, how) {
  try { t.dispatchEvent(new CustomEvent('ravi:anchor', { detail: { how: how } })); } catch (e) {}
}
/* the section a page opened on a #hash is about to land on (aliases resolved), or '' when there is no landing:
   no hash, #top, a reload or back/forward (the browser restores the place), or the reader has already moved */
function arrivalId() {
  var id = ''; try { id = alias(decodeURIComponent(location.hash.slice(1))); } catch (e) {}
  if (!id || id === 'top' || !d.getElementById(id) || state.inputAt > 0) return '';
  var nav = w.performance && performance.getEntriesByType ? performance.getEntriesByType('navigation')[0] : null;
  return nav && nav.type !== 'navigate' ? '' : id;
}
function hashLanding() {
  if (state.hashDone) return;
  state.hashDone = true;
  var id = arrivalId(), t = id ? d.getElementById(id) : null;
  if (!t) return;
  state.jumpAt = now();
  w.scrollTo(0, Math.max(0, Math.round(t.getBoundingClientRect().top + w.pageYOffset - anchorOffset(t))));
  settleAnchor(t);
  anchored(t, 'hash');
}
function refresh() {
  if (!ST || !state.built || state.refreshQueued) return;
  state.refreshQueued = true;
  /* a refresh resets the scroll position for a moment: mid-scroll it would cut a smooth anchor scroll short and
     stop a flick, so it waits until the page has been still for 200 ms */
  requestAnimationFrame(function run() {
    if (!state.built) { state.refreshQueued = false; return; }
    if (now() - state.scrollAt < 200) { setTimeout(function () { requestAnimationFrame(run); }, 100); return; }
    state.refreshQueued = false; ST.refresh();
  });
}
function announce(text) {
  var a = d.getElementById('announcer'); if (!a) return;
  a.textContent = ''; setTimeout(function () { a.textContent = text; }, 30);
}

/* ---------- reading place across a rebuild ---------- */
/* A breakpoint flip (a tablet turned, a window resized across 1024 or 1280px) reverts every pin and rebuilds the
   page at a new height, so a raw scrollY would drop the reader sections away. Core keeps the last settled place:
   the top-level section crossing 30% of the viewport, and the fraction of it above that line. It is read when
   scrolling stops and after each refresh, never while the page is being relaid out. When the context reverts,
   that place is held; once the rebuild has refreshed, the page is put back on it, and again after each refresh
   that follows (ScrollTrigger refreshes after a media change and after a resize), until the page has been still
   for about a second or the reader moves. */
var place = { last: null, held: null, at: 0, timer: 0 };
function readPlace() {
  if (w.pageYOffset < 2) return { top: true };
  var line = w.innerHeight * .3, secs = $$('main > section[id], body > footer[id]');
  for (var i = 0; i < secs.length; i++) {
    var r = secs[i].getBoundingClientRect();
    if (r.top <= line && r.bottom > line) return { el: secs[i], f: (line - r.top) / Math.max(1, r.height) };
  }
  return null;
}
function notePlace() {
  if (!state.built || place.held || now() - state.layoutAt < 700) return;
  var p = readPlace(); if (p) place.last = p;
}
function holdPlace() {
  /* a text field has focus: the flip is most likely an on-screen keyboard, and the browser keeps the field in view */
  var a = d.activeElement, typing = a && (a.tagName === 'TEXTAREA' || a.isContentEditable ||
    (a.tagName === 'INPUT' && !/^(radio|checkbox|button|submit|reset|range|color|file|image)$/.test(a.type)));
  if (!place.last || typing) return;
  place.held = place.last; place.at = now();
}
function applyPlace() {
  var p = place.held; if (!p) return;
  if (state.inputAt > place.at) { place.held = null; return; }   /* the reader has moved on: their position wins */
  var y = 0;
  if (!p.top) {
    if (!p.el.isConnected) { place.held = null; return; }
    var r = p.el.getBoundingClientRect();
    y = r.top + w.pageYOffset + p.f * r.height - w.innerHeight * .3;
  }
  y = Math.max(0, Math.round(y));
  if (Math.abs(y - w.pageYOffset) < 2) return;
  state.jumpAt = now();   /* no label snap pulls the restored position onto a beat */
  w.scrollTo(0, y);
}
function keepPlace() {
  clearTimeout(place.timer);
  (function tick() {
    if (!place.held) return;
    if (state.inputAt > place.at) { place.held = null; return; }
    if (now() - state.layoutAt > 1000 && now() - place.at > 1000 && !state.refreshQueued && !state.building) {
      applyPlace(); place.held = null; notePlace(); return;
    }
    place.timer = setTimeout(tick, 150);
  })();
}
function placeOnRefresh() { if (place.held) applyPlace(); else notePlace(); }

/* ---------- section transitions (spec 1.7) ---------- */
/* spot(el, target): circle geometry in el's px. target = element | selector | fn(el) → element or {x,y}.
   A hidden or missing target falls back to el's center; the center is clamped into the box and
   r reaches the farthest corner plus 120px, so an open circle always covers the whole box. */
function spot(el, target) {
  var W = el.offsetWidth, H = el.offsetHeight, x = W / 2, y = H / 2;
  var t = typeof target === 'function' ? target(el) : target;
  if (typeof t === 'string') t = el.querySelector(t) || d.querySelector(t);
  if (t && t.getBoundingClientRect) { var r = t.getBoundingClientRect(); if (r.width || r.height) { var q = center(t, el); x = q.x; y = q.y; } }
  else if (t && t.x != null) { x = t.x; y = t.y; }
  x = Math.max(0, Math.min(W, x)); y = Math.max(0, Math.min(H, y));
  return { x: x, y: y, r: Math.ceil(Math.sqrt(Math.pow(Math.max(x, W - x), 2) + Math.pow(Math.max(y, H - y), 2))) + 120 };
}
function circ(c, open) { return 'circle(' + (open ? c.r : 0) + 'px at ' + c.x.toFixed(1) + 'px ' + c.y.toFixed(1) + 'px)'; }
/* iris(ctx, {stage, at, trigger, start, end}): the stage opens from a point while the stage-wrap
   approaches (scrubbed, before the pin), so the visitor never scrolls through a blank stage. */
function iris(ctx, o) {
  o = o || {};
  var stage = resolve(o.stage, ctx) || ctx.$('.stage'), wrap = resolve(o.trigger, ctx) || ctx.$('.stage-wrap'), c = null;
  return gsap.fromTo(stage, { clipPath: function () { c = spot(stage, o.at); return circ(c, false); } },
    { clipPath: function () { return circ(c || spot(stage, o.at), true); }, ease: E.wipe,
      scrollTrigger: { trigger: wrap, start: o.start || 'top 70%', end: o.end || 'top top', scrub: .6, invalidateOnRefresh: true } });
}
/* irisIn(tl, el, target, at, dur): in-timeline iris (light → dark inside a scene). */
function irisIn(tl, el, target, at, dur) {
  var c = null;
  return tl.fromTo(el, { clipPath: function () { c = spot(el, target); return circ(c, false); } },
    { clipPath: function () { return circ(c || spot(el, target), true); }, ease: E.wipe, duration: dur || .08, immediateRender: false }, at || 0);
}
/* draw(path, dur, from, to): stroke draw for pathLength="1" paths. autoRound:false matters:
   GSAP rounds px CSS values, which would turn a 0→1 dashoffset into a jump. */
function draw(path, dur, from, to) {
  return gsap.fromTo(path, { strokeDashoffset: from == null ? 1 : from }, { strokeDashoffset: to == null ? 0 : to, duration: dur == null ? D.wipe : dur, ease: E.wipe, autoRound: false });
}

/* ---------- pins + beat chips ---------- */
/* ScrollTrigger queues a full refresh of every trigger for the next frame whenever a pin is created. The first
   build paints a frame between sections, so that refresh would run once per pinned section, each one as long as
   the final refresh (0.5-0.9 s at 4x CPU). While a pin is created during the first build, that one queued
   callback is dropped: the pin still measures itself on the next tick, and finish() refreshes everything once.
   Every other frame callback passes straight through, and nothing changes after the first build. */
function gateRAF(cb) { return /Mt\(!0\)|_refreshAll\(/.test(String(cb)) ? 0 : nativeRAF.call(w, cb); }
function quietPin(make) {
  if (!state.building || !nativeRAF) return make();
  w.requestAnimationFrame = gateRAF;
  try { return make(); } finally { w.requestAnimationFrame = nativeRAF; }
}
/* pin(ctx, {labels, end, start, trigger, beats, snap, scrub, pinType, onUpdate, onToggle, onRefresh}) → {tl, st}
   One timeline unit = the whole pin. Labels are fractions. Keep every tween inside [0, 1].
   Snap points: 0 and every label (out included), never an implicit 1. Past the last point in the direction
   of travel there is no snap, so an exit plays under free scroll and the pin is never pulled back.
   Beat i is lit once the timeline is a small gap past beat i-1's label (its own action has begun); beat 0
   shortly after the start. At rest on a label (snap or click), that label's beat is the lit one. */
function pin(ctx, o) {
  o = o || {};
  var wrap = resolve(o.trigger, ctx) || ctx.$('.stage-wrap');
  var labels = o.labels || { 'in': 0, out: .94 };
  var beatsEl = o.beats === false ? null : (resolve(o.beats, ctx) || ctx.$('.beats'));
  var beats = beatsEl ? $$('.beat', beatsEl) : [];
  var copy = beatsEl ? beatsEl.closest('.scene-copy') : null;
  var stage = ctx.$('.stage');
  var coarse = !!(w.matchMedia && w.matchMedia('(pointer: coarse)').matches);
  var snapOn = o.snap != null ? o.snap : (ctx.mode === 'desk' && !coarse);   // no label snap under a finger (it fights momentum)
  var snapPts = [0], cur = -2, tl;
  /* a label that is not a beat's ('in', 'out') is left out when it sits within about one wheel notch of a beat
     label: otherwise a notch back up from 'out' passes the last beat and lands one beat too far */
  function computeSnap() {
    var dur = tl.duration() || 1, s = tl.scrollTrigger, px = s ? Math.max(1, s.end - s.start) : 1e4, near = 140 / px;
    var keys = beats.map(function (b) { return b.getAttribute('data-label'); });
    var fr = function (k) { return Math.max(0, Math.min(1, tl.labels[k] / dur)); };
    var main = [0].concat(Object.keys(tl.labels).filter(function (k) { return keys.indexOf(k) >= 0; }).map(fr));
    var pts = main.concat(Object.keys(tl.labels).filter(function (k) { return keys.indexOf(k) < 0; }).map(fr)
      .filter(function (v) { return !main.some(function (m) { return Math.abs(m - v) < near && m !== v; }); }));
    snapPts = pts.filter(function (v, i, a) { return a.indexOf(v) === i; }).sort(function (a, b) { return a - b; });
  }
  function snapTo(v, self) {
    if (kbRecent() || jumpRecent()) return v;
    var dir = self.direction, n = snapPts.length, e = 1e-4;
    if (dir > 0 && v >= snapPts[n - 1] - e) return v;
    if (dir < 0 && v <= snapPts[0] + e) return v;
    return ST.snapDirectional(snapPts)(v, dir);
  }
  function setBeats() {
    if (!beats.length) return;
    var t = tl.time(), dur = tl.duration() || 1, s = tl.scrollTrigger, px = s ? Math.max(1, s.end - s.start) : 1e4;
    var gap = Math.max(dur * .01, dur * 8 / px), c = -1, prev = 0;
    beats.forEach(function (b, i) {
      var lt = tl.labels[b.getAttribute('data-label')]; if (lt == null) return;
      if (t > prev + Math.min(gap, Math.max(0, lt - prev) / 2)) c = i;
      prev = lt;
    });
    if (c === cur) return;
    cur = c;
    beatsEl.classList.toggle('has-current', c >= 0);
    beats.forEach(function (b, i) {
      var on = i === c; b.classList.toggle('is-current', on);
      if (on) { b.setAttribute('aria-current', 'step'); var tx = b.querySelector('.beat-t'); if (tx && isMotion()) gsap.fromTo(tx, { y: 10 }, { y: 0, duration: .5, ease: E.rise, overwrite: true }); }
      else b.removeAttribute('aria-current');
    });
  }
  function dense() {
    if (!copy) return;
    copy.classList.remove('scene-copy--dense');
    if (!(ctx.mode === 'desk' && ctx.wide)) return;
    var over = copy.scrollHeight > copy.clientHeight + 2;
    if (!over && beats.length) {
      var cs = getComputedStyle(copy), last = beats[beats.length - 1].getBoundingClientRect(), box = copy.getBoundingClientRect();
      over = last.bottom > box.bottom - (parseFloat(cs.paddingBottom) || 0) + 1;
    }
    if (over) copy.classList.add('scene-copy--dense');
  }
  function wc(on) { if (o.wc === false) return; [stage].concat($$('.wc', wrap)).forEach(function (el) { if (el) el.classList.toggle('wc-on', on); }); }
  if (beats.length) beats[0].classList.add('is-first');
  beats.forEach(liveBeat);
  scrollBeats = scrollBeats.concat(beats);
  var stv = {
    trigger: wrap, pin: o.pin ? resolve(o.pin, ctx) : true, start: o.start || 'top top', end: o.end || '+=240%',
    scrub: o.scrub == null ? .6 : o.scrub, anticipatePin: 1, pinSpacing: true, invalidateOnRefresh: true,
    snap: snapOn ? { snapTo: snapTo, duration: { min: .2, max: .5 }, delay: .15, ease: 'power1.inOut', inertia: false } : false,
    onToggle: function (self) { wc(self.isActive); ctx.el.classList.toggle('is-pinned', self.isActive); if (o.onToggle) o.onToggle(self); },
    onUpdate: o.onUpdate,
    onRefresh: function (self) { computeSnap(); dense(); if (o.onRefresh) o.onRefresh(self); }
  };
  if (o.pinType) stv.pinType = o.pinType;
  tl = quietPin(function () { return gsap.timeline({ defaults: { ease: 'none' }, onUpdate: function () { setBeats(); }, scrollTrigger: stv }); });
  tl.to({}, { duration: 1 }, 0);
  Object.keys(labels).forEach(function (k) { tl.addLabel(k, labels[k]); });
  var st = tl.scrollTrigger, rec = { wrap: wrap, st: st, tl: tl, ctx: ctx, beats: beats };
  pins.push(rec);
  /* beat chips only scroll */
  beats.forEach(function (b) {
    ctx.on(b, 'click', function () { var l = b.getAttribute('data-label'); if (tl.labels[l] != null) scrollToY(st.labelToScroll(l), true); });
  });
  /* compact rail title, generated from the section head when the builder did not write one */
  if (copy && !copy.querySelector('.scene-title')) {
    var eb = ctx.$('.sec-head .eyebrow'), hl = ctx.$('.sec-head .hl');
    if (eb && hl) {
      var p = d.createElement('p'); p.className = 'scene-title'; p.setAttribute('aria-hidden', 'true');
      var vis = eb.querySelector('[aria-hidden="true"]') || eb;
      var lab = (eb.getAttribute('aria-label') || vis.textContent || '').replace(/^\s*\/\s*/, '').split('—');
      var b = d.createElement('b'); b.textContent = (lab[0] || '').trim();
      p.appendChild(b); p.appendChild(d.createTextNode(' ' + (lab[1] || '').trim() + ' · ' + $$('.in', hl).map(function (x) { return x.textContent.trim(); }).join(' ')));
      copy.insertBefore(p, copy.firstChild);
    }
  }
  ctx.add(function () {
    pins = pins.filter(function (x) { return x !== rec; });
    beats.forEach(function (b) { b.classList.remove('is-current'); b.removeAttribute('aria-current'); inertBeat(b); });
    if (beatsEl) beatsEl.classList.remove('has-current');
    if (copy) copy.classList.remove('scene-copy--dense');
    wc(false);
  });
  computeSnap();
  return { tl: tl, st: st, labels: labels, at: function (l) { return tl.labels[l]; } };
}

/* ---------- section registry ---------- */
function makeCtx(rec, el, mode, k, cleanups) {
  var ctx = {
    id: rec.id, el: el, mode: mode, conditions: k || {},
    desk: mode === 'desk', touch: mode === 'touch', frames: mode === 'frames', reduce: mode === 'reduce',
    wide: !!(k && k.wide), compact: mode === 'desk' && !(k && k.wide), narrow: !!(k && k.narrow), phone: w.innerWidth < 600,
    $: function (s) { return el.querySelector(s); },
    $$: function (s) { return $$(s, el); },
    add: function (fn) { cleanups.push(fn); },
    on: function (t, type, fn, opt) { t.addEventListener(type, fn, opt); cleanups.push(function () { t.removeEventListener(type, fn, opt); }); },
    onRefresh: function (fn) { ST.addEventListener('refresh', fn); cleanups.push(function () { ST.removeEventListener('refresh', fn); }); },
    pin: function (o) { return pin(ctx, o); },
    iris: function (o) { return iris(ctx, o); }
  };
  return ctx;
}
function ordered() {
  return registry.map(function (r) { return { r: r, el: d.getElementById(r.id) }; })
    .filter(function (x) { return x.el; })
    .sort(function (a, b) { return a.el.compareDocumentPosition(b.el) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1; });
}
function runAlways() {
  ordered().forEach(function (x) {
    if (!x.r.def.always) return;
    try { x.r.def.always.call(x.r.def, { id: x.r.id, el: x.el, $: function (s) { return x.el.querySelector(s); }, $$: function (s) { return $$(s, x.el); },
      motion: isMotion, get gsap() { return gsap; }, on: function (t, ty, fn, op) { t.addEventListener(ty, fn, op); } }); }
    catch (e) { err(x.r.id, e); }
  });
}

/* ---------- generic reveals (spec 1.7, unpinned grammar) ---------- */
/* Keyboard focus never lands on something still hidden: an on-enter timeline that holds the focused element
   finishes at once (heads, footer), and a [data-reveal] block still at its hidden start shows at once. */
function onFocusReveal(el, tl, cleanups) {
  var rec = { el: el, tl: tl };
  focusReveals.push(rec);
  cleanups.push(function () { focusReveals = focusReveals.filter(function (x) { return x !== rec; }); });
}
var REVEAL_KINDS = {
  '': [{ opacity: 0, y: 24 }, { opacity: 1, y: 0, ease: E.rise }], fade: [{ opacity: 0 }, { opacity: 1, ease: E.enter }],
  wipe: [{ clipPath: 'inset(0 100% 0 0)' }, { clipPath: 'inset(0 0% 0 0)', ease: E.wipe }], pop: [{ opacity: 0, scale: .9 }, { opacity: 1, scale: 1, ease: E.pop }]
};
function revealFor(t) {
  if (!gsap || !t || !t.closest) return;
  focusReveals.forEach(function (r) { if (r.el.contains(t) && r.tl.progress() < 1) r.tl.progress(1); });
  if (!pendingReveals) return;
  for (var el = t.closest('[data-reveal]'); el; el = el.parentElement && el.parentElement.closest('[data-reveal]')) {
    if (!pendingReveals.has(el)) continue;
    pendingReveals.delete(el); markRevealed(el);
    var k = REVEAL_KINDS[el.getAttribute('data-reveal') || ''] || REVEAL_KINDS[''];
    gsap.to(el, Object.assign({ duration: .2, overwrite: true }, k[1]));
  }
}
/* Each head (and the footer) reveals once. A rebuild (a breakpoint flip, an iPad turned) after its reveal has
   started puts it straight at its end state instead of replaying it: revealed remembers which ones have run. */
var revealed = typeof WeakSet === 'function' ? new WeakSet() : null;
function wasRevealed(el) { return !!(revealed && revealed.has(el)); }
function markRevealed(el) { if (revealed) revealed.add(el); }
/* puts a scrambled eyebrow back to its text (a rebuild can cut a scramble short) */
function unscramble(el) {
  var nodes = el && scrCache.get(el.querySelector('[aria-hidden="true"]') || el);
  if (nodes) nodes.forEach(function (x) { x.n.nodeValue = x.t; });
}
function headReveals(mode, cleanups) {
  $$('.sec').forEach(function (sec) {
    if (sec.getAttribute('data-auto') === 'none') return;
    var head = sec.querySelector('.sec-head'); if (!head) return;
    var eb = head.querySelector('.eyebrow'), ls = $$('.hl .in', head), rv = $$('[data-reveal]', head);
    if (wasRevealed(head)) {
      unscramble(eb);
      if (ls.length) gsap.set(ls, { yPercent: 0, y: 0 });
      if (rv.length) gsap.set(rv, { opacity: 1, y: 0 });
      return;
    }
    var tl = gsap.timeline({ scrollTrigger: { trigger: head, start: 'top 75%', toggleActions: 'play none none none' },
      onStart: function () { markRevealed(head); } });
    if (eb) tl.add(scramble(eb), 0);
    if (ls.length) maskIn(tl, ls, .05);
    if (rv.length) tl.fromTo(rv, { opacity: 0, y: 24 }, { opacity: 1, y: 0, ease: E.rise, duration: D.rise, stagger: .06 }, .3);
    onFocusReveal(head, tl, cleanups);
  });
}
function batchReveals(mode, cleanups) {
  var all = $$('[data-reveal]').filter(function (el) {
    if (el.closest('.sec-head') || wasRevealed(el)) return false;
    var sec = el.closest('.sec'); if (sec && sec.getAttribute('data-auto') === 'none') return false;
    if (mode === 'desk' && el.closest('.sec--pin .stage-wrap')) return false;   // the pin owns it
    return true;
  });
  Object.keys(REVEAL_KINDS).forEach(function (k) {
    var els = all.filter(function (el) { return (el.getAttribute('data-reveal') || '') === k; });
    if (!els.length) return;
    gsap.set(els, REVEAL_KINDS[k][0]);
    if (pendingReveals) els.forEach(function (el) { pendingReveals.add(el); });
    ST.batch(els, { start: 'top 85%', once: true, onEnter: function (b) {
      b.forEach(function (el) { markRevealed(el); if (pendingReveals) pendingReveals.delete(el); });
      gsap.to(b, Object.assign({ duration: D.rise, stagger: .06, overwrite: true }, REVEAL_KINDS[k][1]));
    } });
  });
  cleanups.push(function () { if (pendingReveals) all.forEach(function (el) { pendingReveals.delete(el); }); });
}

/* ---------- footer ---------- */
function footer(ctx) {
  var eb = ctx.$('.eyebrow'), sq = ctx.$('.foot-sq'), ls = ctx.$$('.hl .in'), rest = ctx.$$('.foot-say, .foot-ins, .foot-btns, .foot-small');
  if (wasRevealed(ctx.el)) {
    unscramble(eb);
    if (sq) gsap.set(sq, { scale: 1 });
    if (ls.length) gsap.set(ls, { yPercent: 0, y: 0 });
    if (rest.length) gsap.set(rest, { opacity: 1, y: 0 });
    return;
  }
  var tl = gsap.timeline({ scrollTrigger: { trigger: ctx.el, start: 'top 75%', toggleActions: 'play none none none' },
    onStart: function () { markRevealed(ctx.el); } });
  if (eb) tl.add(scramble(eb), 0);
  if (sq) tl.fromTo(sq, { scale: 0 }, { scale: 1, ease: E.pop, duration: D.pop }, 0);
  if (ls.length) maskIn(tl, ls, .1);
  if (rest.length) tl.fromTo(rest, { opacity: 0, y: 12 }, { opacity: 1, y: 0, ease: E.enter, duration: D.enter, stagger: .08 }, .7);
  var rec = { el: ctx.el, tl: tl };
  focusReveals.push(rec);
  ctx.add(function () { focusReveals = focusReveals.filter(function (x) { return x !== rec; }); });
}
/* motion modes only: frames, like reduced, shows the footer as authored (static, complete) */
registry.push({ id: 'end', def: { desk: footer, touch: footer } });

/* ---------- build (spec 1.4) ---------- */
var CONDITIONS = {
  desk: '(min-width:1024px) and (min-height:640px) and (prefers-reduced-motion:no-preference)',
  touch: '(max-width:1023px) and (prefers-reduced-motion:no-preference)',
  short: '(min-width:1024px) and (max-height:639px) and (prefers-reduced-motion:no-preference)',
  reduce: '(prefers-reduced-motion:reduce)',
  wide: '(min-width:1280px)',
  narrow: '(max-width:719px)'
};
function setMode(mode) {
  state.mode = mode;
  html.classList.toggle('motion', mode === 'desk' || mode === 'touch');
  html.classList.toggle('frames-mode', mode === 'frames');
  html.setAttribute('data-mode', mode);
  Ravi.mode = mode;
}
/* runs fn after the next frame has painted (rAF, then a task); a timer covers tabs that do not paint */
function afterPaint(fn, timers) {
  var done = false;
  function run() { if (done) return; done = true; fn(); }
  timers.push(setTimeout(run, 120));
  requestAnimationFrame(function () { timers.push(setTimeout(run, 0)); });
}
/* The first build is staged so the hero shows at once and no task runs long: the first section (#top) builds
   and a frame paints, then one section per task in DOM order (so ScrollTriggers are still created top to
   bottom), then the generic reveals, then one ScrollTrigger.refresh(). Later rebuilds
   (a breakpoint flips) run in one go. Pending steps are cancelled when the context reverts. */
function build() {
  state.mm = gsap.matchMedia();
  state.mm.add(CONDITIONS, function (mm) {
    var k = mm.conditions, key = ['desk', 'touch', 'short', 'reduce', 'wide', 'narrow'].map(function (c) { return k[c] ? 1 : 0; }).join('');
    if (state.driftFrames && key !== state.driftKey) state.driftFrames = false;
    var mode = k.reduce ? 'reduce' : (state.hardFrames || state.driftFrames || k.short) ? 'frames' : k.desk ? 'desk' : 'touch';
    setMode(mode);
    var cleanups = [], timers = [], dead = false, list = ordered();
    state.built = false;
    function one(x) {
      var fn = x.r.def[mode]; if (!fn) return;
      var ctx = makeCtx(x.r, x.el, mode, k, cleanups), before = pins.length;
      try { var r = fn.call(x.r.def, ctx); if (typeof r === 'function') cleanups.push(r); } catch (e) { err(x.r.id, e); }
      pins.slice(before).forEach(function (p) {
        var dd = p.tl.duration();
        if (dd > 1.001) try { console.warn('[section ' + x.r.id + '] pin timeline runs to ' + dd.toFixed(3) + '; keep every tween inside 0..1 or labels drift from their scroll positions'); } catch (e) {}
      });
    }
    function finish() {
      state.building = false;
      /* beat buttons with no pin in this mode (reduce, frames, touch) stay a plain list */
      $$('.beat').forEach(function (bt) { if (scrollBeats.indexOf(bt) < 0) inertBeat(bt); });
      cleanups.push(function () { scrollBeats = []; });
      /* the generic reveals run in the motion modes only: frames, like reduced, is complete and static */
      if (mode === 'desk' || mode === 'touch') { headReveals(mode, cleanups); batchReveals(mode, cleanups); }
      /* resample (and read the reading place) after every builder's own refresh listener has run */
      ST.removeEventListener('refresh', resample); ST.addEventListener('refresh', resample);
      ST.removeEventListener('refresh', placeOnRefresh); ST.addEventListener('refresh', placeOnRefresh);
      state.built = true;
      ST.refresh();
      hashLanding();
      if (place.held) { applyPlace(); keepPlace(); }
      if (mode === 'desk' || mode === 'touch') scheduleDrift(key);
    }
    if (!state.staged || list.length < 2) { list.forEach(one); finish(); }
    else {
      /* first build: the hero, then one section per task with a painted frame in between */
      state.staged = false; state.building = true;
      var queue = list.slice(1);
      var step = function () {
        if (dead) return;
        var x = queue.shift();
        if (!x) { mm.add(finish); return; }
        mm.add(function () { one(x); });
        afterPaint(step, timers);
      };
      one(list[0]);
      afterPaint(step, timers);
    }
    return function () {
      /* the context reverts (a breakpoint flipped): hold the reader's place for the rebuild */
      if (!dead) holdPlace();
      dead = true; state.building = false;
      timers.forEach(clearTimeout);
      clearTimeout(state.driftTimer);
      cleanups.forEach(function (f) { try { f(); } catch (e) {} });
    };
  });
}
/* Safari drift check (spec 1.9): pins must be stable across a refresh one frame later. WebKit only, and only
   once the page has been still for a moment: never during or right after a resize, nor mid-scroll. */
function scheduleDrift(key) {
  if (!isWebKit()) return;
  clearTimeout(state.driftTimer);
  state.driftTimer = setTimeout(function attempt() {
    if (state.driftFrames || (state.mode !== 'desk' && state.mode !== 'touch')) return;
    var t = now();
    if (t - state.resizeAt < 700 || t - state.scrollAt < 300) { state.driftTimer = setTimeout(attempt, 400); return; }
    driftCheck(key);
  }, 700);
}
function driftCheck(key) {
  requestAnimationFrame(function () {
    var ps = ST.getAll().filter(function (t) { return t.pin; });
    if (!ps.length) return;
    var r0 = state.resizeAt;
    ST.refresh();
    var before = ps.map(function (t) { return [t.start, t.end]; });
    requestAnimationFrame(function () {
      if (state.resizeAt !== r0) { scheduleDrift(key); return; }   // a resize came in between: measure again later
      ST.refresh();
      var bad = ps.some(function (t, i) { return Math.abs(t.start - before[i][0]) > 2 || Math.abs(t.end - before[i][1]) > 2; });
      if (bad) forceFrames('pin drift', key);
    });
  });
}
function forceFrames(why, key) {
  try { console.warn('[ravi] frames mode: ' + why); } catch (e) {}
  state.driftFrames = true; state.driftKey = key;
  if (state.mm) state.mm.revert();
  ST.getAll().forEach(function (t) { t.kill(); });
  build();
}

/* ---------- chrome: header menu, copy, anchors, keyboard, details ---------- */
/* None of this needs GSAP: it runs first, so the menu, copy buttons and anchors work whether or not motion boots. */
function initChrome() {
  d.addEventListener('keydown', function (e) {
    var b = e.target && e.target.closest && e.target.closest('.beat[role="button"]');
    if (b && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); b.click(); }
  });
  var btn = $('.hdr-menu'), sheet = d.getElementById('sheet');
  function focusables() { return [btn].concat($$('a', sheet)); }
  function openSheet() {
    sheet.hidden = false; btn.setAttribute('aria-expanded', 'true'); btn.textContent = 'Close';
    if (gsap && isMotion()) gsap.fromTo(sheet, { clipPath: 'inset(0 0 100% 0)' }, { clipPath: 'inset(0 0 0% 0)', duration: .3, ease: E.wipe });
    /* the header is fixed and never needs scrolling into view: opening and closing the menu leaves the page where it is */
    var f = $('a', sheet); if (f) f.focus({ preventScroll: true });
  }
  function closeSheet(refocus) {
    if (!sheet || sheet.hidden) return;
    sheet.hidden = true; btn.setAttribute('aria-expanded', 'false'); btn.textContent = 'Menu';
    if (refocus) btn.focus({ preventScroll: true });
  }
  Ravi.closeMenu = closeSheet;
  if (btn && sheet) {
    btn.addEventListener('click', function () { sheet.hidden ? openSheet() : closeSheet(true); });
    d.addEventListener('keydown', function (e) {
      if (sheet.hidden) return;
      if (e.key === 'Escape') { e.preventDefault(); closeSheet(true); return; }
      if (e.key === 'Tab') {
        var f = focusables(), i = f.indexOf(d.activeElement);
        if (e.shiftKey && (i <= 0)) { e.preventDefault(); f[f.length - 1].focus({ preventScroll: true }); }
        else if (!e.shiftKey && i === f.length - 1) { e.preventDefault(); f[0].focus({ preventScroll: true }); }
      }
    });
    d.addEventListener('click', function (e) { if (!sheet.hidden && !e.target.closest('.hdr')) closeSheet(false); });
    w.addEventListener('resize', function () { if (w.innerWidth >= 1024) closeSheet(false); });
  }
  /* a resize that relays the page out (not a phone's toolbar sliding in or out) holds back place readings */
  var lastW = w.innerWidth, lastH = w.innerHeight, coarse = !!(w.matchMedia && w.matchMedia('(pointer: coarse)').matches);
  w.addEventListener('resize', function () {
    state.resizeAt = now();
    var dh = Math.abs(w.innerHeight - lastH);
    if (w.innerWidth !== lastW || (dh && !coarse) || dh > .25 * lastH) state.layoutAt = now();
    lastW = w.innerWidth; lastH = w.innerHeight;
  }, { passive: true });
  var noteT = 0;
  w.addEventListener('scroll', function () { state.scrollAt = now(); clearTimeout(noteT); noteT = setTimeout(notePlace, 160); }, { passive: true });

  /* copy buttons: the label turns [COPIED] (or Copied) for 1.6 s; when the button has a .toast beside it, the
     toast says Copied instead and the label stays */
  function fallbackCopy(text, btn) {
    var ok = false, ta = d.createElement('textarea');
    ta.value = text; ta.setAttribute('readonly', ''); ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none';
    d.body.appendChild(ta); ta.select();
    try { ok = d.execCommand('copy'); } catch (e) {}
    d.body.removeChild(ta);
    if (!ok) {
      var box = btn.closest('.ln') || btn.parentNode, code = box && box.querySelector('code');
      if (code) { var r = d.createRange(); r.selectNodeContents(code); var s = w.getSelection(); s.removeAllRanges(); s.addRange(r); }
    }
    return ok;
  }
  d.addEventListener('click', function (e) {
    var b = e.target.closest('button.copy'); if (!b) return;
    var ln = b.closest('.ln') || b.parentNode, code = ln && ln.querySelector('code');
    var text = b.getAttribute('data-copy') || (code ? code.textContent : '');
    if (b._label == null) b._label = b.textContent;
    var toast = b.parentNode && b.parentNode.querySelector('.toast');
    function done(ok) {
      announce(ok ? 'Copied' : 'Selected, press Command or Control and C to copy');
      clearTimeout(b._t);
      if (toast) {
        toast.hidden = !ok;
        if (ok && gsap && isMotion()) gsap.fromTo(toast, { opacity: 0, y: 6 }, { opacity: 1, y: 0, duration: .25, ease: E.enter, overwrite: true });
        b._t = setTimeout(function () { toast.hidden = true; }, 1600);
        return;
      }
      b.textContent = ok ? (/^\[/.test(b._label) ? '[COPIED]' : 'Copied') : b._label; b.classList.toggle('is-done', ok);
      b._t = setTimeout(function () { b.textContent = b._label; b.classList.remove('is-done'); }, 1600);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { done(true); }, function () { done(fallbackCopy(text, b)); });
    } else done(fallbackCopy(text, b));
  });

  /* any wheel, touch or key from the reader cancels a pending landing correction (see settleAnchor) */
  ['wheel', 'touchstart', 'keydown'].forEach(function (ev) { d.addEventListener(ev, function () { landing = null; state.inputAt = now(); }, { passive: true, capture: true }); });

  /* in-page anchors: smooth only in html.motion; focus moves to the target. The offset is the same one the
     browser uses for a plain #link: the page's scroll-padding-top plus the target's scroll-margin-top. */
  d.addEventListener('click', function (e) {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    var a = e.target.closest('a[href^="#"]'); if (!a) return;
    var id = ''; try { id = alias(decodeURIComponent(a.getAttribute('href').slice(1))); } catch (e2) {}
    var t = id ? d.getElementById(id) : null; if (!t) return;
    e.preventDefault();
    if (Ravi.closeMenu) Ravi.closeMenu(false);
    var y = id === 'top' ? 0 : t.getBoundingClientRect().top + w.pageYOffset - anchorOffset(t);
    scrollToY(y);
    if (id !== 'top') settleAnchor(t);
    anchored(t, 'click');
    if (!t.hasAttribute('tabindex') && !/^(A|BUTTON|INPUT|SELECT|TEXTAREA)$/.test(t.tagName)) t.setAttribute('tabindex', '-1');
    t.focus({ preventScroll: true });
    if (history.pushState) history.pushState(null, '', '#' + id);
  });

  /* keyboard: suppress snap for 1.5 s after any key (spec 0) */
  d.addEventListener('keydown', function () { state.kbAt = now(); }, true);

  /* focus: never on something hidden. Inside a pinned stage, focus scrolls to the beat its element belongs
     to; a beat chip that gets focus while its scene is closed (past 'out', or before 'in') opens the scene
     on that beat. Progress is read from scrollY, since focus has just scrolled the page. */
  d.addEventListener('focusin', function (e) {
    var t = e.target; if (!t || !t.closest) return;
    revealFor(t);
    if (!isMotion() || !pins.length) return;
    for (var i = 0; i < pins.length; i++) {
      var p = pins[i]; if (!p.wrap.contains(t)) continue;
      if (t.classList.contains('beat')) {
        var l = t.getAttribute('data-label'), tl = p.tl, dur = tl.duration() || 1, s = p.st;
        if (p.beats.indexOf(t) < 0 || tl.labels[l] == null) break;
        var pr = (w.pageYOffset - s.start) / Math.max(1, s.end - s.start);
        var inF = (tl.labels['in'] || 0) / dur, outF = tl.labels.out != null ? tl.labels.out / dur : 1;
        if (pr <= inF + 1e-3 || pr >= outF - 1e-3) scrollToY(s.labelToScroll(l), true);
        break;
      }
      var h = t.closest('[data-beat]'), lb = h && h.getAttribute('data-beat');
      if (lb && p.tl.labels[lb] != null) scrollToY(p.st.labelToScroll(lb), true);
      break;
    }
  });

  /* any <details> toggle can change layout outside a pin */
  d.addEventListener('toggle', function (e) { if (e.target && e.target.tagName === 'DETAILS') refresh(); }, true);
}

/* ---------- public API ---------- */
var Ravi = w.Ravi = {
  E: E, D: D, $: $, $$: $$, booted: false, mode: null,
  section: function (id, def) { registry.push({ id: id, def: def || {} }); },
  get motion() { return isMotion(); },
  get gsap() { return gsap; }, get ST() { return ST; }, get built() { return state.built; },
  maskIn: maskIn, scramble: scramble, typeLine: typeLine, count: count, blink: blink,
  wipeIn: wipeIn, wipeOut: wipeOut, press: press, ripple: ripple, cursorTo: cursorTo, samplePath: samplePath, sampler: sampler,
  packet: packet, packetRefuse: packetRefuse, pt: pt, arc: arc, breathe: breathe, lit: lit, hold: hold, center: center,
  pauseOffscreen: pauseOffscreen, caretOn: caretOn, irisIn: irisIn, spot: spot, draw: draw,
  scrollToY: scrollToY, refresh: refresh, announce: announce, kbRecent: kbRecent,
  /* the section id a page opened on a #hash will land on during the first build ('' otherwise): a scrubbed scene
     there can skip its scrub instead of resting half-built at the landing. Arrivals by click send 'ravi:anchor'. */
  arrival: function () { return state.hashDone ? '' : arrivalId(); },
  pins: function () { return pins.slice(); }
};

/* ---------- boot (spec 1.3) ---------- */
function waitFonts(ms) {
  return new Promise(function (res) {
    var t = setTimeout(res, ms);
    if (d.fonts && d.fonts.ready) d.fonts.ready.then(function () { clearTimeout(t); res(); }, res); else { clearTimeout(t); res(); }
  });
}
/* no GSAP (or the head's 4 s fallback already fired): the authored HTML is the final state */
function staticPage() {
  html.classList.remove('motion');
  html.setAttribute('data-fallback', '1');
  $$('.beat').forEach(inertBeat);
}
var booting = false;
function boot() {
  if (booting) return; booting = true;
  gsap = w.gsap || null; ST = w.ScrollTrigger || null;
  var fallback = html.getAttribute('data-fallback') === '1';
  var clipOK = !!(w.CSS && CSS.supports && CSS.supports('clip-path', 'circle(10% at 50% 50%)'));
  var motionOK = !!(gsap && ST) && !fallback;
  if (/[?&]frames\b/.test(location.search) || !clipOK) state.hardFrames = true;
  if (motionOK && !state.hardFrames && w.matchMedia('(prefers-reduced-motion: no-preference)').matches && !w.matchMedia(CONDITIONS.short).matches) html.classList.add('motion');
  else html.classList.remove('motion');
  Ravi.booted = true;
  if (!motionOK) { staticPage(); runAlways(); return; }
  runAlways();
  gsap.registerPlugin(ST);
  ST.config({ ignoreMobileResize: true });
  ST.addEventListener('refresh', resample);
  /* the hero waits for the web fonts only briefly; fonts that arrive later trigger one refresh */
  if (d.fonts && d.fonts.addEventListener) d.fonts.addEventListener('loadingdone', function () { refresh(); });
  waitFonts(600).then(function () {
    try { build(); }
    catch (e) { err('core', e); try { if (state.mm) state.mm.revert(); ST.getAll().forEach(function (t) { t.kill(); }); } catch (e2) {} staticPage(); }
  });
}
/* main.js is deferred: the core runs before the section scripts below it have registered, so boot waits a
   tick (or for DOMContentLoaded). The chrome starts at once; motion starts when GSAP is there. If a GSAP
   script is still on its way (placed after main.js, or async), core waits for DOMContentLoaded or for the
   head's 4 s fallback, whichever comes first. */
var started = false, dclDone = d.readyState === 'complete';
d.addEventListener('DOMContentLoaded', function () { dclDone = true; });
function whenGsap() {
  if ((w.gsap && w.ScrollTrigger) || dclDone || html.getAttribute('data-fallback') === '1') { boot(); return; }
  var mo = null;
  function again() {
    if (mo) mo.disconnect();
    d.removeEventListener('DOMContentLoaded', again);
    boot();
  }
  d.addEventListener('DOMContentLoaded', again);
  if (w.MutationObserver) {
    mo = new MutationObserver(function () { if (html.getAttribute('data-fallback') === '1') again(); });
    mo.observe(html, { attributes: true, attributeFilter: ['data-fallback'] });
  }
}
function go() {
  if (started) return; started = true;
  try { initChrome(); } catch (e) { err('core', e); }
  whenGsap();
}
d.addEventListener('DOMContentLoaded', go);
if (d.readyState !== 'loading') setTimeout(go, 0);
})(window, document);

/* ---- section top (00-top.js) ---- */
(function(){
'use strict';
try {
/* 00 · #top hero: AGENTS FOR SLACK. No pin; two time-based parts.
   1. copy and window: CSS keyframes in css/00-top.css that start at first paint, so the first screen never waits
      for the scripts, the web fonts or the other sections' builds;
   2. the thread (about 5 s, once the figure is on screen): Ana's line types in and the packet appears on her
      avatar; it hops along short arcs to the reception chip, then dev, then ops. Each chip lights as the packet
      lands, and the message it posts shows three typing dots, then rises. The packet then rests on ops and breathes
      (Ravi.breathe: only while it is on screen).
      On touch the hops wait until the thread's last message is on screen (its bottom at 90% of the viewport): on a
      phone the window runs below the fold, and the hand-off would otherwise post out of sight. Ana's line still types
      in at once.
      Once the figure has left the screen, the thread replays when most of the window is back in view (never while
      only a sliver shows under the header). A rebuild (a breakpoint flip) shows the end state instead of replaying.
   Static views (reduced, frames, no JS) need nothing: the HTML is the end state and the packet is hidden. */
var played = false;                          /* across rebuilds */
var T0 = 1, HOP = .45, STEP = 1.2;            /* thread start (s after first paint), hop length, agent to agent */

/* seconds since the CSS entrance started (it starts with the first paint) */
function sinceEntrance() {
  var p = window.performance, e = p && p.getEntriesByName ? p.getEntriesByName('first-contentful-paint')[0] : null;
  return p ? Math.max(0, (p.now() - (e ? e.startTime : 0)) / 1000) : 99;
}

/* Ana's line types in: Ravi.typeLine when it sits on one line; when it wraps (phones), letter by letter */
function typeIn(ctx, tl, el, at) {
  var gsap = Ravi.gsap;
  tl.fromTo(el, { opacity: 0 }, { opacity: 1, duration: .01 }, at);
  if (el.getClientRects().length === 1 && el.offsetHeight < 30) { tl.add(Ravi.typeLine(el, .8), at); return; }
  var text = el.textContent;
  el.textContent = '';
  var chars = text.split('').map(function (ch) { var s = document.createElement('span'); s.textContent = ch; el.appendChild(s); return s; });
  ctx.add(function () { el.textContent = text; });
  tl.fromTo(chars, { opacity: 0 }, { opacity: 1, duration: .01, stagger: Math.min(.02, .8 / chars.length), ease: 'none' }, at);
}

function hero(ctx) {
  var gsap = Ravi.gsap, ST = Ravi.ST, E = Ravi.E, D = Ravi.D;
  var tv = ctx.$('.tv'), pk = ctx.$('.tv-pk'), ana = ctx.$('.tv-m--ana .av'), type = ctx.$('.tv-type');
  var chips = ctx.$$('.tv-ag'), msgs = ctx.$$('.tv-m[data-ag]');
  var dotsOf = msgs.map(function (m) { return m.querySelector('.tv-dots'); });

  /* geometry, in the figure's coordinates; measured once per refresh */
  var cache = {};
  ctx.onRefresh(function () { cache = {}; if (resting) placeOn(chips[2]); });
  function at(key, el, fx, fy) { return cache[key] || (cache[key] = Ravi.pt(el, tv, fx, fy)); }
  function anaPt() { return at('ana', ana, .9, .9); }
  function chipPt(i) { return at('c' + i, chips[i].querySelector('i')); }
  function hop(i) { return function () { return cache['h' + i] || (cache['h' + i] = Ravi.arc(i ? chipPt(i - 1) : anaPt(), chipPt(i))); }; }
  function placeOn(chip) { var p = chip ? chipPt(chips.indexOf(chip)) : anaPt(); gsap.set(pk, { x: p.x, y: p.y }); }

  var glow = Ravi.breathe(pk, tv, ctx), resting = false;
  function rest(on) { resting = on; glow.rest(on); }

  var tl = gsap.timeline({ paused: true, defaults: { overwrite: 'auto' } });
  typeIn(ctx, tl, type, T0);
  tl.call(function () { rest(false); placeOn(null); }, null, T0 + .8);
  tl.fromTo(pk, { opacity: 0, scale: 0 }, { opacity: 1, scale: 1, duration: .35, ease: E.pop }, T0 + .8);
  chips.forEach(function (chip, i) {
    var h = T0 + 1.2 + i * STEP, land = h + HOP;
    tl.add(Ravi.packet(pk, hop(i), HOP, E.travel), h);
    tl.add(Ravi.lit(chip, true, .3), land);
    tl.fromTo(chip, { scale: 1 }, { scale: 1.07, duration: .14, yoyo: true, repeat: 1, ease: 'power1.inOut', immediateRender: false }, land);
    var dots = dotsOf[i], msg = msgs[i];
    if (dots) {
      tl.fromTo(dots, { opacity: 0, y: 4 }, { opacity: 1, y: 0, duration: .15, ease: E.enter }, land + .05);
      tl.fromTo(dots.children, { y: 0 }, { y: -3, duration: .14, yoyo: true, repeat: 3, stagger: .07, ease: 'sine.inOut', immediateRender: false }, land + .08);
      tl.to(dots, { opacity: 0, duration: .12 }, land + .5);
    }
    tl.fromTo(msg, { opacity: 0, y: 12 }, { opacity: 1, y: 0, duration: D.rise, ease: E.rise }, land + .5);
  });
  tl.call(function () { rest(true); played = true; }, null, T0 + 1.2 + 2 * STEP + HOP + .6);

  /* the end state without the scene (a rebuild after it has played) */
  function end() { tl.progress(1); placeOn(chips[2]); rest(true); }

  /* touch: the hops wait at GATE (Ana has typed her line; the packet has not shown) until the last message is on screen.
     `near` is read from scrollY against a threshold measured on each refresh (layout boxes, so the window's CSS
     rise and the messages' hidden offset never skew it). */
  var GATE = T0 + .8, near = !ctx.touch, gateTw = null, nearY = 0, last = msgs[msgs.length - 1];
  function offIn(el, anc) { var y = 0; while (el && el !== anc) { y += el.offsetTop; el = el.offsetParent; } return y; }
  function measureNear() {
    if (near) return;
    nearY = tv.getBoundingClientRect().top + window.pageYOffset + offIn(last, tv) + last.offsetHeight - window.innerHeight * .9;
    checkNear();
  }
  function checkNear() {
    if (near || window.pageYOffset < nearY) return;
    near = true;
    if (gateTw) { gateTw.kill(); gateTw = null; if (tl.progress() < 1) tl.play(); }
  }
  if (!near) { ctx.onRefresh(measureNear); ctx.on(window, 'scroll', checkNear, { passive: true }); measureNear(); }

  /* plays from the start of the thread (the first time, from the CSS entrance's own clock) */
  function go(first) {
    rest(false);
    if (gateTw) { gateTw.kill(); gateTw = null; }
    tl.pause(0);
    var from = first ? Math.min(sinceEntrance(), T0) : T0 - .25;
    if (near) tl.play(from);
    else gateTw = tl.tweenFromTo(from, GATE);
  }
  if (played) end();

  /* first play: as soon as the figure is on screen. Replay: once it has left the screen entirely, the next time
     most of the window is back in view */
  var win = ctx.$('.tv-win'), gone = false, r0 = tv.getBoundingClientRect();
  /* built while the figure is off screen (a page opened on an anchor, or a rebuild further down): it waits for the
     window to be mostly in view, like a replay */
  if (!played && (r0.bottom <= 0 || r0.top >= window.innerHeight)) gone = true;
  function seen() {
    var r = win.getBoundingClientRect(), hdr = (document.getElementById('hdr') || win).offsetHeight || 0;
    var room = Math.max(1, window.innerHeight - hdr), vis = Math.min(r.bottom, window.innerHeight) - Math.max(r.top, hdr);
    return vis / Math.max(1, Math.min(r.height, room));
  }
  ST.create({ trigger: tv, start: 'top bottom', end: 'bottom top',
    onToggle: function (s) {
      if (!s.isActive) { if (tl.progress() > 0 || played) gone = true; return; }
      if (!gone && !played && tl.progress() === 0 && !tl.isActive() && !gateTw) go(true);
    },
    onUpdate: function () { if (gone && seen() >= .6) { gone = false; go(false); } } });
  ctx.add(function () { tl.kill(); if (gateTw) gateTw.kill(); });

  /* a quiet parallax on wide screens, as before */
  if (ctx.desk) {
    gsap.to(ctx.$('.top-vis'), { y: -60, ease: 'none', scrollTrigger: { trigger: ctx.el, start: 'top top', end: 'bottom top', scrub: true } });
    gsap.to(ctx.$('.top-copy'), { y: -30, ease: 'none', scrollTrigger: { trigger: ctx.el, start: 'top top', end: 'bottom top', scrub: true } });
  }
}

Ravi.section('top', { desk: hero, touch: hero });
} catch (err) { console.error('[section top]', err); }
})();

/* ---- section tools (01-tools.js) ---- */
(function(){
'use strict';
try {
/* 01 · #tools: Ravi Pages + Ravi Bases (prefix tl-). No pin.
   One timeline in fractions 0..1, used two ways:
     desk   scrubbed (1.2) while the figure crosses the viewport, 'top 80%' → 'bottom 35%' (about 890px at 1440×900, so
            a flight takes about 140px of scroll): it reverses with the scroll.
            A reader who arrives through an anchor (the Tools link, or a page opened on #tools) would land with the
            scrub resting mid-scene, so then the scrub lets go and the scene plays through once, time-based (2.4 s),
            as soon as the page is still;
     touch  played once (2.4 s) when the page reaches 75% of the viewport. Each teammate's card drops in only once
            its slot is on screen (its bottom at 90% of the viewport), so a phone never drops them below the fold.
   A rebuild after the scene has played through on its own shows the end state.
   The scene:
     0–.25    the page's outline draws itself around the empty board, then the page fills and its chrome fades in;
     .18–.62  each table row lights, its card lifts off it (y −8, a shadow) and flies on a short arc into its column;
              the flights overlap, each about .2 long, so a wheel notch never covers a whole flight. The packet leads
              the first flight. The table keeps its rows. Below 600 the ORDERED column is gone, so Headset stays in
              the table;
     .72–1    the three teammates' cards drop into REQUESTED one at a time, and each avatar bounces once.
   Static views (reduced, frames, no JS) need nothing: the HTML is the end state and the outline is the CSS border. */
var played = false;              /* the scene has played through on its own (touch, or an anchor arrival on desk); survives rebuilds */
var SCENE = 2.4;                 /* seconds, when the scene plays by itself */

/* ownDrops: the teammates' drops are separate timelines (touch), returned in .drops, instead of part of the scene */
function tlScene(ctx, ownDrops) {
  var gsap = Ravi.gsap, E = Ravi.E;
  var fig = ctx.$('.tl-fig'), br = ctx.$('.tl-br'), path = ctx.$('.tl-ol path'), pk = ctx.$('.tl-pk');

  /* the outline: a rounded rect on the browser's border box (the svg sits 1px out, over the transparent border) */
  function outline() {
    var W = br.offsetWidth, H = br.offsetHeight, r = 8, a = .75, x1 = W - a, y1 = H - a;
    /* the top-left corner is square: the RAVI PAGES tab sits on it */
    path.setAttribute('d', 'M' + a + ' ' + a + ' H' + (x1 - r) + ' A' + r + ' ' + r + ' 0 0 1 ' + x1 + ' ' + (a + r) +
      ' V' + (y1 - r) + ' A' + r + ' ' + r + ' 0 0 1 ' + (x1 - r) + ' ' + y1 + ' H' + (a + r) + ' A' + r + ' ' + r + ' 0 0 1 ' + a + ' ' + (y1 - r) + ' Z');
  }
  outline();

  /* the flights: one per row whose column is on screen (below 600 ORDERED is not) */
  var flights = [];
  ctx.$$('.tl-row').forEach(function (row) {
    var slot = ctx.$('.tl-slot[data-row="' + row.getAttribute('data-to') + '"]'), card = slot && slot.firstElementChild;
    if (!card) return;
    if (!slot.getClientRects().length) { gsap.set(card, { opacity: 1 }); ctx.add(function () { gsap.set(card, { clearProps: 'opacity' }); }); return; }
    flights.push({ row: row, slot: slot, card: card, hl: row.querySelector('.tl-hl') });
  });

  /* geometry in the figure's coordinates. A card starts over its row's left part, scaled .92; it lifts 8px, then
     flies to its slot. Card values are offsets from the slot's centre (where the card sits untransformed); the packet
     uses the same two points in the figure. Every value is a function, re-read when the scrub refreshes. */
  ctx.onRefresh(outline);
  function geo(i) {
    var f = flights[i], r = Ravi.pt(f.row, fig, 0, .5), e = Ravi.pt(f.slot, fig);
    var s = { x: r.x + 14 + f.slot.offsetWidth * .46, y: r.y }, dx = e.x - s.x, dy = e.y - s.y;
    return { s: s, e: e, ox: s.x - e.x, oy: s.y - e.y, lift: Math.max(16, Math.min(80, Math.sqrt(dx * dx + dy * dy) * .35)) };
  }
  function v(i, k, add) { return function () { return geo(i)[k] + (add || 0); }; }

  /* the hop is plain property tweens (never callbacks), so a scrub that jumps or a refresh always renders it: x and y
     travel together (sine.inOut: a gentle peak speed, so a scrubbed flight never reads as a jump), and a bump of `lift` px bows the path through the translate property
     (--by up on desk; --bx to the left when stacked, where the hop runs down). Ravi.arc's curve, without callbacks. */
  var TRAVEL = gsap.parseEase('sine.inOut'), side = !ctx.desk, bumpVar = side ? '--bx' : '--by';
  function bump(t) { var e = TRAVEL(t); return 4 * e * (1 - e); }
  function hop(el, i, x0, y0, x1, y1, at, dur) {
    var a = {}, b = { duration: dur, ease: 'sine.inOut', immediateRender: false };
    a.x = x0; a.y = y0; b.x = x1; b.y = y1;
    tl.fromTo(el, a, b, at);
    var c = {}, d = { duration: dur, ease: bump, immediateRender: false };
    c[bumpVar] = '0px';
    d[bumpVar] = function () { return -(side ? 24 : geo(i).lift) + 'px'; };
    tl.fromTo(el, c, d, at);
  }

  var tl = gsap.timeline({ paused: true, defaults: { ease: 'none' } });

  /* 0–.25: the outline draws around the empty board, then the page fills and the chrome fades in */
  tl.add(Ravi.draw(path, .17), 0);
  tl.fromTo(ctx.$('.tl-bg'), { opacity: 0 }, { opacity: 1, duration: .07, ease: E.enter }, .15);
  tl.fromTo(ctx.$('.tl-chrome'), { opacity: 0, y: -6 }, { opacity: 1, y: 0, duration: .07, ease: E.enter }, .17);
  tl.fromTo(ctx.$('.tl-title'), { opacity: 0, y: 6 }, { opacity: 1, y: 0, duration: .07, ease: E.enter }, .18);

  /* .18–.62: the rows' cards fly into their columns, overlapping; the packet leads the first */
  var FLY = .2, step = flights.length > 2 ? .12 : .14;
  flights.forEach(function (f, i) {
    var t0 = .18 + i * step, hopAt = t0 + .035, hopDur = FLY - .04;
    if (f.hl) {
      tl.fromTo(f.hl, { opacity: 0 }, { opacity: 1, duration: .03, ease: E.enter }, t0);
      tl.to(f.hl, { opacity: 0, duration: .05, ease: E.enter }, t0 + .08);
    }
    /* the card appears on its row, lifts 8px (with its shadow), flies to its slot and settles */
    tl.fromTo(f.card, { x: v(i, 'ox'), y: v(i, 'oy'), opacity: 0, scale: .92, '--shd': 0 },
      { x: v(i, 'ox'), y: v(i, 'oy', -8), opacity: 1, '--shd': 1, duration: .03, ease: E.enter }, t0 + .005);
    hop(f.card, i, v(i, 'ox'), v(i, 'oy', -8), 0, 0, hopAt, hopDur);
    tl.to(f.card, { scale: 1, duration: hopDur, ease: 'sine.inOut' }, hopAt);
    tl.to(f.card, { '--shd': 0, duration: .02, ease: E.enter }, hopAt + hopDur - .015);
    if (i === 0) {
      /* the packet leads: it pops on the row and lands on the slot a beat before the card does */
      var sx = function () { return geo(0).s.x; }, sy = function () { return geo(0).s.y - 8; };
      tl.fromTo(pk, { x: sx, y: sy, opacity: 0, scale: 0 }, { x: sx, y: sy, opacity: 1, scale: 1, duration: .02, ease: E.pop }, t0 - .015);
      hop(pk, 0, sx, sy, function () { return geo(0).e.x; }, function () { return geo(0).e.y; }, t0 + .01, hopDur - .01);
      tl.to(pk, { opacity: 0, scale: 0, duration: .025, ease: E.exit }, t0 + hopDur);
    }
  });

  /* .72–1: the teammates' cards drop into REQUESTED, each avatar bounces once */
  var drops = [];
  ctx.$$('.tl-new').forEach(function (card, i) {
    var t = .72 + i * .085, av = card.querySelector('.av'), d = ownDrops ? gsap.timeline({ paused: true }) : tl, at = ownDrops ? 0 : t;
    d.fromTo(card, { opacity: 0, y: -24 }, { opacity: 1, y: 0, duration: .07, ease: E.pop }, at);
    if (av) {
      d.fromTo(av, { y: 0 }, { y: -7, duration: .025, ease: E.enter, immediateRender: false }, at + .05);
      d.to(av, { y: 0, duration: .03, ease: 'power2.in' }, at + .075);
    }
    if (ownDrops) { d.timeScale(1 / SCENE); drops.push({ tl: d, at: t, slot: card.parentNode }); ctx.add(function () { d.kill(); }); }
  });
  tl.set({}, {}, 1);                                     /* the scene is exactly one unit long */
  ctx.add(function () { tl.kill(); });
  tl.drops = drops;
  return tl;
}

function tlDesk(ctx) {
  var gsap = Ravi.gsap, tl = tlScene(ctx), st = null, wait = null, lastScroll = 0;
  if (played) { tl.progress(1); return; }
  ctx.on(window, 'scroll', function () { lastScroll = performance.now(); }, { passive: true });
  ctx.add(function () { if (wait) wait.kill(); });

  /* an anchor arrival: the scrub lets go where it is and, once the page is built and still (a smooth scroll or the
     landing done), the rest of the scene plays through, time-based */
  function playThrough() {
    played = true;
    if (st) { var tw = st.getTween && st.getTween(); if (tw) tw.kill(); st.kill(false, true); st = null; }
    tl.pause();
    if (tl.progress() >= 1) return;
    var t0 = performance.now();
    lastScroll = t0;
    (function still() {
      var t = performance.now();
      if ((!Ravi.built || t - lastScroll < 160) && t - t0 < 2500) { wait = gsap.delayedCall(.1, still); return; }
      tl.timeScale(1 / SCENE).play();
    })();
  }
  /* a page opened on #tools starts from the empty board it first paints: no scrub at all */
  if (Ravi.arrival && Ravi.arrival() === ctx.id) { playThrough(); return; }
  st = Ravi.ST.create({ trigger: ctx.$('.tl-fig'), start: 'top 80%', end: 'bottom 35%', scrub: 1.2, animation: tl, invalidateOnRefresh: true });
  ctx.on(ctx.el, 'ravi:anchor', function () { if (!played) playThrough(); });
}

function tlTouch(ctx) {
  var gsap = Ravi.gsap, ST = Ravi.ST, tl = tlScene(ctx, true), drops = tl.drops;
  if (played) { tl.progress(1); drops.forEach(function (d) { d.tl.progress(1); }); return; }
  tl.timeScale(1 / SCENE);
  /* each drop waits for both its moment in the scene and its slot on screen; drops that come due together still
     land one after another */
  var nextAt = 0;
  drops.forEach(function (d) {
    var due = false, seen = false, done = false;
    function go() {
      if (done || !due || !seen) return;
      done = true;
      var now = gsap.ticker.time, at = Math.max(now, nextAt);
      nextAt = at + .2;
      gsap.delayedCall(at - now, function () { d.tl.play(0); });
    }
    tl.call(function () { due = true; go(); }, null, d.at);
    ST.create({ trigger: d.slot, start: 'bottom 90%', once: true, onEnter: function () { seen = true; go(); } });
  });
  ST.create({ trigger: ctx.$('.tl-br'), start: 'top 75%', once: true, onEnter: function () { played = true; tl.play(0); } });
}

Ravi.section('tools', { desk: tlDesk, touch: tlTouch });
} catch (err) { console.error('[section tools]', err); }
})();

/* ---- section slack (02-slack.js) ---- */
(function(){
'use strict';
try {
/* 02 · #slack: APPROVE IN SLACK. THE PAGE UPDATES. Unpinned: one on-enter scene and one real interaction.
   The authored HTML is the decided state. data-st (wait | done) picks the card's face, data-sb (req | out) the
   board card's column; css/02-slack.css says what shows when neither is set.
   always: Approve and Decline decide (Decline directly, no dialog). Focus moves to the stamp, the announcer says
     "Approved by Carla" (or "Declined by Carla").
   desk + touch:
     - the deal, when the stage enters: the Form and the Canvas slide up from behind the card and fan out;
       then the Form's Submit row slides up and the Canvas figure counts $2,970 → $3,450;
     - Approve breathes (scale 1 ↔ 1.04) while it waits and is on screen;
     - a press: Ravi.press, the card swaps to its stamp, the packet flies from the button to the board card, the card
       arcs from REQUESTED to APPROVED (or DECLINED), the counts update;
     - self-press: once the card's buttons and the board have been on screen together for 1.2 s, and the page has been
       still for .7 s, Carla's cursor glides in (.45 s) and presses Approve. Scrolling before her press cancels it (she
       tries again after the next pause); nothing self-presses after a touch or a keyboard focus on the stage;
     - reset: once the section has left the viewport, the card is back on its buttons.
   reduce (with JS): no motion, but the demo stays: the card waits on its buttons and a press decides at once.
   frames / no JS: the decided state, all static. */
var E = Ravi.E;
var SEC = null;
var S = { st: '', o: 'approve', motion: false, run: null, auto: null, decided: false, touched: false, dealt: false, breath: null, btnIn: false };
/* the self-press watch: since = when the stage came into view, still = when the page last scrolled */
var W = { since: 0, scrolled: -1e9, timer: 0 };
var DWELL = 1200, STILL = 700;

function G() { return Ravi.gsap; }
function q(s) { return SEC.querySelector(s); }
function qa(s) { return Array.prototype.slice.call(SEC.querySelectorAll(s)); }
function hdr() { return parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--hdr')) || 64; }

/* ---------- the faces ---------- */
function swapText(attr, o) {
  qa('[' + attr + ']').forEach(function (el) { var v = el.getAttribute(attr).split('|'); el.textContent = v[o === 'decline' ? 1 : 0] || v[0]; });
}
function stamp(o) { S.o = o; swapText('data-v', o); if (o === 'decline') SEC.setAttribute('data-o', 'decline'); else SEC.removeAttribute('data-o'); }
function board(o) { swapText('data-vb', o); if (o === 'decline') SEC.setAttribute('data-bo', 'decline'); else SEC.removeAttribute('data-bo'); }
function setSt(st) { S.st = st; SEC.setAttribute('data-st', st); syncBreath(); }
function setSb(sb) {
  SEC.setAttribute('data-sb', sb);
  q('.ck-nr').textContent = sb === 'req' ? '1' : '0';
  q('.ck-no').textContent = sb === 'req' ? '0' : '1';
}
function waitFace() { stamp('approve'); board('approve'); setSb('req'); setSt('wait'); }
function doneFace(o) { stamp(o); board(o); setSb('out'); setSt('done'); }
function said(o) { return (o === 'decline' ? 'Declined' : 'Approved') + ' by Carla'; }
/* the pressed button hides with its row: focus lands on the stamp that replaced it */
function focusStamp(had) { if (had) { var d = q('.ck-done'); if (d) d.focus({ preventScroll: true }); } }

/* ---------- deciding ---------- */
function decide(o, auto) {
  if (S.st !== 'wait' || S.run) return;
  var had = q('.ck-wait').contains(document.activeElement);
  if (!auto) stopAuto();
  if (S.motion && G()) { playPress(o, auto, had); return; }
  doneFace(o);
  focusStamp(had);
  Ravi.announce(said(o));
}

/* the press, the stamp, the packet's flight to the board card, the card's arc to its new column */
function playPress(o, auto, had) {
  var gsap = G(), stage = q('.ck-stage'), pk = q('.ck-pk'), done = q('.ck-done');
  var btn = q(o === 'decline' ? '.ck-decline' : '.ck-approve'), req = q('.ck-bc--req'), out = q('.ck-bc--out');
  var from = Ravi.pt(btn, stage), pts = null, lift = S.touch ? 26 : 44;
  var tl = S.run = gsap.timeline({ onComplete: function () { S.run = null; rest(); } });
  if (S.breath) S.breath.pause(0);
  if (!auto) tl.add(Ravi.press(btn), 0);
  /* the card's buttons give way to its stamp */
  tl.call(function () { stamp(o); setSt('done'); focusStamp(had); }, null, .2);
  tl.fromTo(done, { opacity: 0, scale: 1.18 }, { opacity: 1, scale: 1, duration: .45, ease: E.popHard, immediateRender: false }, .2);
  /* the packet leaves the button and reaches the card on the board */
  tl.call(function () { pts = Ravi.arc(from, Ravi.pt(req, stage)); }, null, .3);
  tl.fromTo(pk, { opacity: 0, scale: .4 }, { opacity: 1, scale: 1, duration: .18, ease: E.enter, immediateRender: false }, .3);
  tl.add(Ravi.packet(pk, function () { return pts; }, .6, E.travel), .3);
  /* the card arcs to its new column (a FLIP along a curve); the packet rides on it */
  var m = { p: 0 }, dx = 0, dy = 0, c = null;
  tl.call(function () {
    var a = req.getBoundingClientRect(), b = out.getBoundingClientRect();
    dx = a.left - b.left; dy = a.top - b.top; c = Ravi.pt(out, stage);
    SEC.setAttribute('data-sb', 'out');                            /* the counts change as the card lands */
  }, null, .9);
  tl.fromTo(m, { p: 0 }, { p: 1, duration: .7, ease: E.travel, immediateRender: false, onUpdate: function () {
    if (!c) return;
    var p = m.p, x = dx * (1 - p), y = dy * (1 - p) - lift * Math.sin(Math.PI * p);
    gsap.set(out, { x: x, y: y });
    gsap.set(pk, { x: c.x + x, y: c.y + y });
  } }, .9);
  tl.fromTo(out, { scale: 1 }, { keyframes: { scale: [1, 1.05, 1] }, duration: .7, ease: 'none', immediateRender: false }, .9);
  tl.call(function () { board(o); setSb('out'); Ravi.announce(said(o)); }, null, 1.6);
  tl.to(pk, { opacity: 0, scale: .4, duration: .3, ease: E.exit }, 1.62);
}
/* at rest: no inline motion styles left on the card, the stamp or the packet */
function rest() {
  var gsap = G(); if (!gsap) return;
  gsap.set([q('.ck-done'), q('.ck-bc--out'), q('.ck-pk'), q('.ck-approve'), q('.ck-decline')], { clearProps: 'opacity,transform' });
}

/* ---------- Approve breathes while it waits on screen ---------- */
function syncBreath() {
  var b = S.breath; if (!b) return;
  if (S.motion && S.st === 'wait' && S.btnIn && !S.run && !S.auto) { if (!b.isActive()) b.play(); }
  else b.pause(0);
}

/* ---------- self-press: Carla's cursor presses Approve ---------- */
function stopAuto(soft) {
  if (!S.auto) return;
  S.auto.kill(); S.auto = null;
  var g = G(), cur = q('.ck-cur');
  if (g && soft) g.to(cur, { autoAlpha: 0, duration: .2, ease: E.exit, onComplete: function () { g.set(cur, { clearProps: 'opacity,visibility,transform' }); } });
  else if (g) { g.killTweensOf(cur); g.set(cur, { clearProps: 'opacity,visibility,transform' }); }
  syncBreath();
}
/* the stage is in view when the card and the board are both on screen, clear of the header; on a screen too short
   for both, when the card's buttons and the board's columns are */
function inView() {
  var top = hdr() + 8, bot = innerHeight - 8;
  var w = q('.ck-win').getBoundingClientRect(), br = q('.ck-br').getBoundingClientRect();
  var a = w, b = br;
  if (Math.max(w.bottom, br.bottom) - Math.min(w.top, br.top) > bot - top) { a = q('.ck-act').getBoundingClientRect(); b = q('.ck-board').getBoundingClientRect(); }
  return Math.min(a.top, b.top) >= top && Math.max(a.bottom, b.bottom) <= bot;
}
function selfPress() {
  var gsap = G(), btn = q('.ck-approve'), cur = q('.ck-cur'), stage = q('.ck-stage');
  var b = Ravi.pt(btn, stage), wr = q('.ck-win').getBoundingClientRect(), sr = stage.getBoundingClientRect();
  var x0 = Math.min(b.x + 170, wr.right - sr.left - 40), y0 = b.y + 54;
  S.decided = false;
  var tl = S.auto = gsap.timeline({ onComplete: function () { S.auto = null; gsap.set(cur, { clearProps: 'opacity,visibility,transform' }); } });
  syncBreath();
  tl.set(cur, { x: x0, y: y0, autoAlpha: 0 });
  tl.to(cur, { autoAlpha: 1, duration: .2, ease: E.enter });
  tl.add(Ravi.cursorTo(cur, btn, stage, .45), .05);
  tl.add(Ravi.ripple(cur), .5);
  tl.add(Ravi.press(btn), .5);
  tl.call(function () { S.decided = true; decide('approve', true); }, null, .55);
  tl.to(cur, { autoAlpha: 0, duration: .3, ease: E.exit }, 1.4);
}
/* every 150 ms while the section is on screen: Carla presses once the stage has been in view for DWELL and the page
   has been still for STILL; scrolling before her press cancels it */
function tick() {
  if (!S.motion || S.st !== 'wait' || S.run || S.touched) { W.since = 0; return; }
  var now = performance.now(), iv = inView();
  if (S.auto) { if (!S.decided && (!iv || now - W.scrolled < 150)) { stopAuto(true); W.since = 0; } return; }
  if (!iv) { W.since = 0; return; }
  if (!W.since) W.since = now;
  if (now - W.since >= DWELL && now - W.scrolled >= STILL) selfPress();
}
function watch(on) {
  if (on && !W.timer) W.timer = setInterval(tick, 150);
  if (!on && W.timer) { clearInterval(W.timer); W.timer = 0; W.since = 0; }
}

/* ---------- reset: the card is back on its buttons ---------- */
function reset() {
  if (S.run) { S.run.kill(); S.run = null; }
  stopAuto();
  rest();
  S.touched = false; W.since = 0;
  if (S.st !== 'wait') waitFace();
}
function watchLeave(ctx) {
  var ST = Ravi.ST;
  var st = ST.create({ trigger: ctx.el, start: 'top bottom', end: 'bottom top', onLeave: reset, onLeaveBack: reset });
  ctx.add(function () { st.kill(); });
}

/* ---------- the deal: the Form and the Canvas come out from behind the card ---------- */
function deal(ctx) {
  var gsap = G(), gh = ctx.$$('.sl-ghost'), n = ctx.$('.sl-ghost--canvas .gk-n'), ft = ctx.$('.sl-ghost--form .gk-md-ft');
  var rot = gh.map(function (g) { return parseFloat(getComputedStyle(g).getPropertyValue('--rot')) || 0; });
  var fan = { y: 0, rotation: function (i) { return rot[i]; }, opacity: 1 };
  if (S.dealt) { gsap.set(gh, fan); return; }
  var tl = gsap.timeline({ paused: true, onComplete: function () { S.dealt = true; } });
  tl.fromTo(gh, { y: 40, rotation: 0, opacity: 0 }, Object.assign({ duration: .75, ease: E.pop, stagger: .12 }, fan), 0);
  tl.fromTo(ft, { y: 14, opacity: 0 }, { y: 0, opacity: 1, duration: .45, ease: E.rise }, .6);
  tl.add(Ravi.count(n, 480, .8, function (v) { return '$' + Math.round(2970 + v).toLocaleString('en-US'); }), .7);
  tl.fromTo(n, { '--fl': 0 }, { '--fl': 1, duration: .2, ease: E.enter, yoyo: true, repeat: 1, immediateRender: false }, 1.5);
  var st = Ravi.ST.create({ trigger: ctx.$('.ck-stage'), start: 'top 80%', end: 'max', once: true, onEnter: function () { tl.play(); } });
  ctx.add(function () {
    st.kill();
    if (tl.progress() > 0 && tl.progress() < 1) S.dealt = true;
    tl.kill(); gsap.set(ft, { clearProps: 'opacity,transform' }); n.textContent = '$3,450';
  });
}

/* ---------- builders ---------- */
function motionBuild(ctx) {
  var gsap = G(), ST = Ravi.ST, btn = ctx.$('.ck-approve');
  S.motion = true; S.touch = ctx.touch;
  if (S.st === 'done') doneFace(S.o); else waitFace();
  deal(ctx);

  S.breath = gsap.to(btn, { scale: 1.04, duration: .9, ease: E.hold, yoyo: true, repeat: -1, paused: true });
  var vis = ST.create({ trigger: btn, start: 'top bottom', end: 'bottom top', onToggle: function (s) { S.btnIn = s.isActive; syncBreath(); } });
  S.btnIn = vis.isActive; syncBreath();

  /* Carla's self-press: watched while the section is on screen (see tick) */
  ctx.on(window, 'scroll', function () { W.scrolled = performance.now(); }, { passive: true });
  var sp = ST.create({ trigger: ctx.el, start: 'top bottom', end: 'bottom top', onToggle: function (s) { watch(s.isActive); } });
  watch(sp.isActive);
  watchLeave(ctx);

  return function () {
    if (S.run) { S.run.kill(); S.run = null; doneFace(S.o); }
    stopAuto();
    watch(false);
    vis.kill(); sp.kill();
    if (S.breath) { S.breath.kill(); S.breath = null; }
    rest();
    S.motion = false;
  };
}
/* reduced motion keeps the demo with no motion: the card waits on its buttons and a press decides at once (decide()
   needs no motion). Frames shows the end state, as no JS does. A decision already made stays made. */
function stillBuild(ctx) {
  S.motion = false;
  if (S.run) { S.run.kill(); S.run = null; }
  stopAuto();
  if (ctx.reduce && S.st !== 'done') waitFace();
  else doneFace(S.st === 'done' ? S.o : 'approve');
}

/* ---------- always: the buttons decide in every JS mode ---------- */
function always(c) {
  SEC = c.el;
  c.on(c.$('.ck-approve'), 'click', function () { decide('approve'); });
  c.on(c.$('.ck-decline'), 'click', function () { decide('decline'); });
  /* a hand or keyboard focus on the stage holds Carla's self-press back until the next visit */
  var stage = c.$('.ck-stage');
  c.on(stage, 'pointerdown', function () { S.touched = true; if (!S.decided) stopAuto(); syncBreath(); });
  c.on(stage, 'focusin', function () { S.touched = true; if (!S.decided) stopAuto(); });
}

Ravi.section('slack', { always: always, desk: motionBuild, touch: motionBuild, frames: stillBuild, reduce: stillBuild });
} catch (err) { console.error('[section slack]', err); }
})();

/* ---- section scale (03-scale.js) ---- */
(function(){
'use strict';
try {
/* 03 · #scale: ONE PERSON OR THE WHOLE ORG. Unpinned; one timeline flips Just me to The whole org:
     .1 → .45  the thumb slides to The whole org (it lands as the view flips, at .5)
     .2 → .8   the counters roll up (People 1 → 40, Agents 1 → 6, Pages 1 → 12), through a proxy that scrubs both ways
     .2 → .38  the Calendar and Morning brief tiles shrink into the first slot and are gone by .38
     .2 → .32  the dashed slots the org tiles will fill show (they are hidden in Just me)
     .42 → 1   the four org tiles pop in, one at a time
   desk:  the timeline is scrubbed while the wall comes into view (no pin). It is done once the whole wall is on
          screen, and before the TEAMS link's landing (css/03-scale.css lands it with the block mid-screen), so
          every frame with the headline, the toggle and the wall all on screen shows the finished org wall;
   touch: it plays once, when the wall comes into view;
   any touch of the toggle unlinks it from the scroll for good: from then on a click plays or reverses it in .9 s,
   and the radios keep working from the keyboard. Past the middle the radios, .sc[data-view] and the panel that
   is exposed to screen readers follow the timeline. A rebuild (a breakpoint or mode flips) keeps the view.
   reduce / frames / no JS: the static layout, both panels with their own heading and counters (no toggle). */
var E = Ravi.E;
var root = null, ui = {};
/* lastP: the timeline's progress at the last update; burst/pStart: see sync() */
var S = { view: 'me', linked: true, played: false, M: null, lastP: 0, burst: false, pStart: 0 };

function q(s, r) { return (r || root).querySelector(s); }
function qa(s, r) { return Array.prototype.slice.call((r || root).querySelectorAll(s)); }

/* the radios, data-view and (in motion) which panel screen readers get follow the view */
function mirror(v) {
  S.view = v;
  root.setAttribute('data-view', v);
  (v === 'org' ? ui.rOrg : ui.rMe).checked = true;
  if (S.M) { ui.pMe.setAttribute('aria-hidden', v === 'org' ? 'true' : 'false'); ui.pOrg.setAttribute('aria-hidden', v === 'org' ? 'false' : 'true'); }
}
function setHud(v) { ui.hud.forEach(function (n) { n.textContent = n.getAttribute(v === 'org' ? 'data-org' : 'data-me'); }); }

/* the counters and the view follow where the timeline is: on every update, and after every refresh (ScrollTrigger
   puts a scrubbed timeline back in place with its callbacks suppressed).
   A context revert (a breakpoint or mode flips) renders the timeline back at 0 in one synchronous burst, before the
   builder's cleanup runs. sync() notes where the timeline stood when a burst began, so the cleanup can restore it. */
function sync(M) {
  M.prox.forEach(function (x) { x.n.textContent = String(Math.round(x.o.v)); });
  var p = M.tl.progress();
  if (!S.burst) { S.burst = true; S.pStart = S.lastP; Promise.resolve().then(function () { S.burst = false; }); }
  S.lastP = p;
  if (p >= .5) S.played = true;                    /* the org wall has been seen: a touch rebuild never replays it */
  var v = p >= .5 ? 'org' : 'me';
  if (v !== S.view) mirror(v);
}

/* ---------- the flip ---------- */
function flip(M) {
  var gsap = Ravi.gsap, tl = gsap.timeline({ paused: true, onUpdate: function () { sync(M); } });
  tl.set({}, {}, 1);                               /* the timeline is exactly one unit long */
  tl.fromTo(ui.thumb, { x: 0, xPercent: 0 }, { x: 0, xPercent: 100, duration: .35, ease: 'power2.inOut' }, .1);
  tl.fromTo(ui.thumbIn, { x: 0, xPercent: 0 }, { x: 0, xPercent: -50, duration: .35, ease: 'power2.inOut' }, .1);
  ui.hud.forEach(function (n) {
    var a = +n.getAttribute('data-me'), b = +n.getAttribute('data-org'), o = { v: a };
    M.prox.push({ n: n, o: o });
    tl.fromTo(o, { v: a }, { v: b, duration: .6, ease: 'power1.inOut' }, .2);
  });
  /* both personal tiles shrink into the first slot (measured from layout, so transforms never feed back) and are
     gone before the first org tile shows */
  var first = ui.meLis[0];
  ui.meLis.forEach(function (li) {
    tl.fromTo(li, { x: 0, y: 0, scale: 1 }, { x: function () { return first.offsetLeft - li.offsetLeft; }, y: function () { return first.offsetTop - li.offsetTop; },
      scale: .42, duration: .18, ease: 'power2.in' }, .2);
    tl.fromTo(li, { opacity: 1 }, { opacity: 0, duration: .08, ease: 'none' }, .3);
  });
  /* the empty slots only show while the wall changes (the org tiles cover them at the end) */
  tl.fromTo(ui.slots, { opacity: 0 }, { opacity: 1, duration: .12, ease: 'none' }, .2);
  ui.orgLis.forEach(function (li, i) {
    tl.fromTo(li, { opacity: 0, scale: .72, y: 24 }, { opacity: 1, scale: 1, y: 0, duration: .22, ease: E.pop }, .42 + i * .12);
  });
  return tl;
}

/* ---------- the toggle ---------- */
function unlink() {
  var M = S.M; S.linked = false;
  if (M && M.st) { M.st.kill(false, true); M.st = null; }
  if (M && M.enter) { M.enter.kill(); M.enter = null; }
}
function go(v) {
  var M = S.M;
  if (!M) { mirror(v); Ravi.refresh(); return; }
  unlink();
  S.played = true;
  M.tl.duration(.9);
  if (v === 'org') M.tl.play(); else M.tl.reverse();
}

/* ---------- motion builders ---------- */
/* where an in-page link (the TEAMS nav item) puts the section's top: the page's scroll-padding-top plus the
   section's own scroll-margin-top, as core and the browser compute it */
function landing(el) {
  return (parseFloat(getComputedStyle(document.documentElement).scrollPaddingTop) || 0) + (parseFloat(getComputedStyle(el).scrollMarginTop) || 0);
}
function build(ctx, desk) {
  var ST = Ravi.ST, M = S.M = { tl: null, st: null, enter: null, prox: [] };
  M.tl = flip(M);
  var at = S.view === 'org' ? 1 : 0;
  M.tl.progress(at); setHud(S.view); mirror(S.view);
  if (S.linked && desk) {
    /* scrubbed while the wall comes into view, and finished by the time the whole wall is on screen (its bottom 8px
       under the fold) or the TEAMS link's landing, whichever comes first: every frame that shows the headline, the
       toggle and the whole wall together shows the finished org wall. It starts about 15% of a screen earlier, a short
       stretch, so few resting places fall mid-flip. */
    var endY = function () {
      var y = scrollY, a = ui.panels.getBoundingClientRect().bottom + y - innerHeight + 8,
        b = ctx.el.getBoundingClientRect().top + y - landing(ctx.el) - 8;
      return Math.round(Math.min(a, b));
    };
    var span = function () { return Math.round(Math.min(170, Math.max(130, innerHeight * .15))); };
    M.st = ST.create({ trigger: ctx.el, start: function () { return endY() - span(); }, end: endY,
      scrub: .6, animation: M.tl, invalidateOnRefresh: true });
  }
  ctx.onRefresh(function () {
    if (!M.st) { var p = M.tl.progress(); M.tl.invalidate(); M.tl.progress(p); }
    sync(M);
  });
  if (!M.st && S.linked && !S.played && at === 0) {
    /* touch: once, when the wall comes into view */
    M.enter = ST.create({ trigger: ui.panels, start: 'top 58%', end: 'max', once: true, onEnter: function () {
      M.enter = null; S.played = true; M.tl.duration(1.6).play();
    } });
  }
  return function () {
    /* the context has already rendered the timeline back at 0 (see sync): keep the view it showed before that */
    var p = S.burst ? S.pStart : S.lastP, v = p >= .5 ? 'org' : 'me';
    if (M.st) M.st.kill(false, true);
    if (M.enter) M.enter.kill();
    M.tl.kill();
    S.M = null;
    [ui.pMe, ui.pOrg].forEach(function (p) { p.removeAttribute('aria-hidden'); });
    mirror(v); setHud(v);
    S.lastP = S.pStart = v === 'org' ? 1 : 0;
  };
}
function desk(ctx) { return build(ctx, true); }
function touch(ctx) { return build(ctx, false); }

/* ---------- always: the radios, in every JS mode ---------- */
function always(c) {
  root = c.$('.sc');
  if (!root) return;
  ui = {
    rMe: q('#sc-r-me'), rOrg: q('#sc-r-org'), seg: q('.sc-seg'), thumb: q('.sc-thumb'), thumbIn: q('.sc-thumb-in'),
    hud: qa('.sc-hud--bar .sc-n'), panels: q('.sc-panels'), slots: q('.sc-slots'), pMe: q('.sc-panel--me'), pOrg: q('.sc-panel--org'),
    meLis: qa('.sc-tiles--me>li'), orgLis: qa('.sc-tiles--org>li')
  };
  /* the browser may restore a checked radio on reload */
  if (ui.rOrg.checked) { S.view = 'org'; S.linked = false; }
  root.setAttribute('data-view', S.view);
  c.on(ui.seg, 'pointerdown', unlink);
  c.on(ui.seg, 'keydown', function (e) { if (/^(Arrow|Home|End|Enter| )/.test(e.key)) unlink(); });
  [ui.rMe, ui.rOrg].forEach(function (r) { c.on(r, 'change', function () { if (r.checked) go(r.value); }); });
}

Ravi.section('scale', { always: always, desk: desk, touch: touch });
} catch (err) { console.error('[section scale]', err); }
})();

/* ---- section sdk (04-sdk.js) ---- */
(function(){
'use strict';
try {
/* 04 · #sdk: for builders (unpinned). The figure only.
   always: draws the three wires from the hub to the apps (re-measured whenever the figure resizes), so reduced
           motion and frames get drawn wires too, and keeps their sampled points for the pulse.
   desk / touch, when the figure reaches 70% (75% on touch):
     0     the hub pops, its ports pop;
     .3    the wires draw out from the hub (stagger .12) and each app rises as its wire arrives. On the stacked
           phone layout every wire draws with the hub and each app rises when it reaches 85% of the viewport;
     1.4   the pulse: three packets leave the hub together with the same duration (1.1 s, linear), so they land in the
           three apps at the same moment; each app's language tag flashes mint. No data changes.
           After the first pulse, ZERO DRIFT stamps onto the hub (scale 1.6 → 1).
           The pulse repeats every 8 s, only while the figure is on screen (Ravi.pauseOffscreen).
   A rebuild (a breakpoint flip) after the entrance has started shows the figure whole at once (and the stamp, once it
   has landed) and starts the pulse loop right away, instead of blanking the apps and replaying the entrance.
   reduce / frames / no JS: nothing to do; the wires (or the .sd-nj lines) are drawn and the stamp shows. */

var played = false, stamped = false;   /* survive rebuilds: the entrance has started; the stamp has landed */

function sdArr(x) { return Array.prototype.slice.call(x); }
function sdLay(dia) { return (getComputedStyle(dia).getPropertyValue('--sd-lay') || 'wide').trim(); }
function sdCubic(a, b, vert) {
  var c1 = vert ? [a[0], (a[1] + b[1]) / 2] : [(a[0] + b[0]) / 2, a[1]];
  var c2 = vert ? [b[0], (a[1] + b[1]) / 2] : [(a[0] + b[0]) / 2, b[1]];
  return 'M' + a.join(' ') + ' C' + c1.join(' ') + ' ' + c2.join(' ') + ' ' + b.join(' ');
}

/* one wire per app, in DOM order (dash, mac, phone), each from the hub to the app */
function sdGeom(el) {
  var dia = el.querySelector('.sd-fig'), hub = el.querySelector('.sd-hub');
  if (!dia || !hub || !hub.offsetWidth) return;
  var wires = el.querySelectorAll('.sd-w'), apps = el.querySelectorAll('.sd-app'), lay = sdLay(dia);
  /* the hub may be mid-pop (scaled about its centre), and an app mid-rise: take centres from rects, sizes from layout */
  var D = dia.getBoundingClientRect(), H = hub.getBoundingClientRect(), hw = hub.offsetWidth, hh = hub.offsetHeight;
  var hx = H.left + H.width / 2 - D.left - hw / 2, hy = H.top + H.height / 2 - D.top - hh / 2, pts = el.sdPts || (el.sdPts = []);
  sdArr(apps).forEach(function (app, i) {
    var win = app.querySelector('.sd-win'), phone = app.classList.contains('sd-app--phone');
    /* layout boxes (offsets), so an app's rise (a transform) never bends its wire */
    var ax = app.offsetLeft, ay = app.offsetTop, rx = ax + win.offsetLeft, ry = ay + win.offsetTop, rw = win.offsetWidth, rh = win.offsetHeight, d;
    if (lay === 'wide') {
      if (app.classList.contains('sd-app--dash')) d = sdCubic([hx, hy + hh * .5], [rx + rw, ry + rh * .5]);
      else d = sdCubic([hx + hw, hy + hh * (phone ? .3 : .7)], [rx, ry + rh * (phone ? .3 : .5)]);
    } else if (lay === 'row') {
      d = sdCubic([hx + hw / 2, hy + hh], [ax + app.offsetWidth / 2, ay], true);
    } else {
      /* down from the hub, left to the spine, down the spine, right into the app */
      var x0 = hx + hw / 2, y0 = hy + hh, yb = y0 + 22, cx = 10, ty = ry + (phone ? 64 : 22), r = 8;
      d = 'M' + x0 + ' ' + y0 + ' V' + (yb - r) + ' Q' + x0 + ' ' + yb + ' ' + (x0 - r) + ' ' + yb + ' H' + (cx + r) +
        ' Q' + cx + ' ' + yb + ' ' + cx + ' ' + (yb + r) + ' V' + (ty - r) + ' Q' + cx + ' ' + ty + ' ' + (cx + r) + ' ' + ty + ' H' + rx;
    }
    /* unchanged geometry (most of the calls at boot: always, the first observation, fonts, the build, the refresh)
       keeps its sampled points: sampling is the costly part */
    if (pts[i] && wires[i].getAttribute('d') === d) return;
    wires[i].setAttribute('d', d);
    try { pts[i] = Ravi.samplePath(wires[i], 64); } catch (e) {}
  });
}

function sdAlways(c) {
  var el = c.el, dia = c.$('.sd-fig');
  el.classList.add('sd-js');
  el.sdGeom = function () { sdGeom(el); };
  /* with a ResizeObserver its first observation draws the wires right after the next layout, so boot never forces a
     layout of its own here (the section is below the fold); without one, draw now and on every resize */
  if (window.ResizeObserver) new ResizeObserver(function () { el.sdGeom(); }).observe(dia);
  else { el.sdGeom(); c.on(window, 'resize', el.sdGeom); }
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(function () { el.sdGeom(); });
}

function sdBuild(ctx) {
  var gsap = Ravi.gsap, E = Ravi.E, D = Ravi.D, el = ctx.el, $ = ctx.$, $$ = ctx.$$;
  var dia = $('.sd-fig'), lay = sdLay(dia), stack = lay === 'stack';
  if (el.sdGeom) el.sdGeom();
  ctx.onRefresh(function () { if (el.sdGeom) el.sdGeom(); });
  function pts(i) { return function () { return (el.sdPts || [])[i]; }; }

  var hub = $('.sd-hub'), stamp = $('.sd-stamp'), apps = $$('.sd-app'), wires = $$('.sd-w'), pks = $$('.sd-pk');
  var tags = apps.map(function (a) { return a.querySelector('.sd-tag'); });

  /* ---------- the entrance ---------- */
  var t1 = null;
  if (!played) {
    t1 = gsap.timeline({ scrollTrigger: { trigger: dia, start: ctx.touch ? 'top 75%' : 'top 70%', toggleActions: 'play none none none' },
      onStart: function () { played = true; } });
    t1.fromTo(hub, { opacity: 0, scale: .85 }, { opacity: 1, scale: 1, ease: E.popHard, duration: .5 }, 0);
    t1.fromTo($$('.sd-port'), { opacity: 0, scale: 0 }, { opacity: 1, scale: 1, ease: E.pop, duration: .3, stagger: .06 }, .25);
    apps.forEach(function (app, i) {
      var at = .3 + i * .12;
      t1.add(Ravi.draw(wires[i], .45), at);
      var rise = { opacity: 1, y: 0, ease: E.rise, duration: D.rise };
      if (!stack) { t1.fromTo(app, { opacity: 0, y: 24 }, rise, at + .3); return; }
      /* stacked: each app rises when it reaches 85% of the viewport */
      gsap.fromTo(app, { opacity: 0, y: 24 }, Object.assign({ scrollTrigger: { trigger: app, start: 'top 85%', toggleActions: 'play none none none' } }, rise));
    });
  }

  /* ---------- the pulse: same start, same duration, one landing ---------- */
  var FLY = 1.1, LAND = .05 + FLY;
  /* the stamp waits for the first pulse, unless it has already landed (a rebuild): then it simply shows */
  var stampTl = null;
  if (!stamped) {
    gsap.set(stamp, { opacity: 0 });
    stampTl = gsap.timeline({ paused: true });
    stampTl.fromTo(stamp, { opacity: 0, scale: 1.6, rotation: -5 }, { opacity: 1, scale: 1, rotation: -5, ease: E.popHard, duration: .45 }, 0);
    stampTl.fromTo(hub, { y: 0 }, { y: 3, duration: .08, ease: E.enter, immediateRender: false }, .3);
    stampTl.to(hub, { y: 0, duration: .5, ease: E.refuse }, .38);
  }

  var loop = gsap.timeline({ paused: true, repeat: -1, repeatDelay: 8 - 1.6 });
  loop.fromTo(hub, { scale: 1 }, { scale: 1.04, duration: .14, yoyo: true, repeat: 1, ease: E.hold, immediateRender: false }, 0);
  pks.forEach(function (pk, i) {
    loop.fromTo(pk, { opacity: 0, scale: .4 }, { opacity: 1, scale: 1, duration: .15, ease: E.enter, immediateRender: false }, .05);
    loop.add(Ravi.packet(pk, pts(i), FLY, E.travel), .05);
    loop.to(pk, { opacity: 0, scale: 0, duration: .2, ease: E.exit }, LAND);
    if (tags[i]) { loop.add(Ravi.lit(tags[i], true, .1), LAND); loop.add(Ravi.lit(tags[i], false, .28), LAND + .14); }
  });
  loop.call(function () { if (!stamped && stampTl) { stamped = true; stampTl.play(0); } }, null, LAND + .15);
  loop.set({}, {}, 1.6);

  /* it starts once the entrance is through (at once on a rebuild after it), then runs only while the figure is on screen */
  function startLoop() {
    var st = Ravi.pauseOffscreen(loop, dia);
    if (st.isActive) loop.play();
  }
  if (t1) t1.call(startLoop, null, 1.4);
  else startLoop();
  ctx.add(function () { loop.kill(); if (stampTl) stampTl.kill(); });
}

Ravi.section('sdk', { always: sdAlways, desk: sdBuild, touch: sdBuild });
} catch (err) { console.error('[section sdk]', err); }
})();

/* ---- section end (09-end.js) ---- */
(function(){
'use strict';
try {
/* 09 · #end: the closing. Core registers 'end' for the reveal (eyebrow, square, headline, then the sentence, the pill,
   the buttons and the small print rise). This second 'end' entry adds the packet and the caret (plan 1.6):
   when the footer's top reaches 70%, and once the pill has risen, the packet drops in from above along a short curve
   (.9 s; shorter on touch) and lands on the caret. The pill's border flashes mint once and the caret starts to blink
   (Ravi.caretOn: only while the pill is on screen). Nothing types itself out. It plays once; a rebuild after that
   shows the blinking caret at once.
   Reduced, frames and no JS: nothing runs; the caret is static and the packet is hidden (base CSS). */
var played = false;

function enBuild(ctx) {
  var gsap = Ravi.gsap, E = Ravi.E;
  var ins = ctx.$('.foot-ins'), caret = ctx.$('.en-caret'), pk = ctx.$('.en-pk'), flash = ctx.$('.en-flash');
  if (!ins || !caret || !pk) return;
  if (played) { Ravi.caretOn(caret, null, 0, ins); return; }

  /* the drop, in the pill's coordinates: it leaves up and to the left of the caret heading right, then falls onto it
     (a quadratic with its control level with the start, just short of the caret) */
  var dx = ctx.touch ? 44 : 96, dy = ctx.touch ? 76 : 128, cache = null;
  ctx.onRefresh(function () { cache = null; });
  function drop() {
    if (cache) return cache;
    var b = Ravi.pt(caret, ins), a = { x: b.x - dx, y: b.y - dy }, c = { x: b.x - dx * .12, y: a.y }, out = [];
    for (var i = 0; i <= 28; i++) {
      var t = i / 28, u = 1 - t;
      out.push({ x: u * u * a.x + 2 * u * t * c.x + t * t * b.x, y: u * u * a.y + 2 * u * t * c.y + t * t * b.y });
    }
    return (cache = out);
  }

  var tl = gsap.timeline({ paused: true });
  tl.fromTo(pk, { opacity: 0, scale: 0 }, { opacity: 1, scale: 1, duration: .2, ease: E.pop }, 0);
  tl.add(Ravi.packet(pk, drop, .9, 'power1.in'), 0);
  tl.to(pk, { opacity: 0, scale: 0, duration: .2, ease: E.exit }, .9);
  tl.fromTo(flash, { opacity: 0 }, { opacity: 1, duration: .12, ease: E.enter, immediateRender: false }, .9);
  tl.to(flash, { opacity: 0, duration: .6, ease: E.enter }, 1.02);
  Ravi.caretOn(caret, tl, .92, ins);
  tl.call(function () { played = true; }, null, .92);
  ctx.add(function () { tl.kill(); });

  /* after core's reveal has lifted the pill (it starts at the footer's top 75% and is in place about 1.2 s later) */
  var go = null;
  Ravi.ST.create({ trigger: ctx.el, start: 'top 70%', once: true, onEnter: function () {
    go = gsap.delayedCall(.9, function () { tl.play(); });
  } });
  /* a keyboard user who tabs into the footer gets the end state at once (core finishes the reveal the same way) */
  ctx.on(ctx.el, 'focusin', function () {
    if (!Ravi.kbRecent() || tl.progress() === 1) return;
    if (go) go.kill();
    tl.progress(1);
  });
}

Ravi.section('end', { desk: enBuild, touch: enBuild });
} catch (err) { console.error('[section end]', err); }
})();
