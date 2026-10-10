/* ===== 00-core.js ===== */
/* ravi.bot "One Loop" — core: boot + gating, motion vocabulary, helpers, section registry,
   pins + beat chips, loop indicator, header menu, copy buttons, anchors, generic reveals. */
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
function hashLanding() {
  if (state.hashDone) return;
  state.hashDone = true;
  var id = ''; try { id = decodeURIComponent(location.hash.slice(1)); } catch (e) {}
  var t = id && id !== 'top' ? d.getElementById(id) : null;
  if (!t || state.inputAt > 0) return;
  var nav = w.performance && performance.getEntriesByType ? performance.getEntriesByType('navigation')[0] : null;
  if (nav && nav.type !== 'navigate') return;
  state.jumpAt = now();
  w.scrollTo(0, Math.max(0, Math.round(t.getBoundingClientRect().top + w.pageYOffset - anchorOffset(t))));
  settleAnchor(t);
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
    onToggle: function (self) { wc(self.isActive); ctx.el.classList.toggle('is-pinned', self.isActive); loopMini(); if (o.onToggle) o.onToggle(self); },
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
    pendingReveals.delete(el);
    var k = REVEAL_KINDS[el.getAttribute('data-reveal') || ''] || REVEAL_KINDS[''];
    gsap.to(el, Object.assign({ duration: .2, overwrite: true }, k[1]));
  }
}
function headReveals(mode, cleanups) {
  $$('.sec').forEach(function (sec) {
    if (sec.getAttribute('data-auto') === 'none') return;
    var head = sec.querySelector('.sec-head'); if (!head) return;
    var eb = head.querySelector('.eyebrow'), ls = $$('.hl .in', head), rv = $$('[data-reveal]', head);
    var tl = gsap.timeline({ scrollTrigger: { trigger: head, start: mode === 'frames' ? 'top 85%' : 'top 75%', toggleActions: 'play none none none' } });
    if (eb) tl.add(scramble(eb), 0);
    if (ls.length) maskIn(tl, ls, .05);
    if (rv.length) tl.fromTo(rv, { opacity: 0, y: 24 }, { opacity: 1, y: 0, ease: E.rise, duration: D.rise, stagger: .06 }, .3);
    onFocusReveal(head, tl, cleanups);
  });
}
function batchReveals(mode, cleanups) {
  var all = $$('[data-reveal]').filter(function (el) {
    if (el.closest('.sec-head')) return false;
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
      if (pendingReveals) b.forEach(function (el) { pendingReveals.delete(el); });
      gsap.to(b, Object.assign({ duration: D.rise, stagger: .06, overwrite: true }, REVEAL_KINDS[k][1]));
    } });
  });
  cleanups.push(function () { if (pendingReveals) all.forEach(function (el) { pendingReveals.delete(el); }); });
}

/* ---------- loop indicator (spec 1.6 #14) ---------- */
/* outside a pin there is no reserved corner, so the ring shrinks into the page gutter */
function loopMini() { var li = d.getElementById('loopind'); if (li) li.classList.toggle('is-mini', !d.querySelector('.sec.is-pinned')); }
var STATIONS = [['ask', '01', 'ASK'], ['build', '02', 'BUILD'], ['share', '03', 'SHARE'], ['wake', '04', 'PICK UP'], ['click', '05', 'APPROVE']];
function loopIndicator(mode, cleanups) {
  var li = d.getElementById('loopind'); if (!li) return;
  var present = STATIONS.filter(function (s) { return d.getElementById(s[0]); });
  STATIONS.forEach(function (s) { var a = li.querySelector('[data-st="' + s[0] + '"]'); if (a) a.parentNode.hidden = !d.getElementById(s[0]); });
  if (!present.length) return;
  li.classList.add('is-ready');
  loopMini();
  var first = d.getElementById(present[0][0]), last = d.getElementById(present[present.length - 1][0]);
  var bk = d.getElementById('blockkit'), name = li.querySelector('.li-name'), arc = li.querySelector('.li-arc'), prog = li.querySelector('.li-prog');
  var hdr = mode === 'touch' ? 52 : 64, n = present.length;
  function setCur(id) {
    var idx = -1;
    STATIONS.forEach(function (s, i) { if (s[0] === id) idx = i; });
    $$('.li-tick', li).forEach(function (a) {
      var i = -1; STATIONS.forEach(function (s, j) { if (s[0] === a.getAttribute('data-st')) i = j; });
      a.classList.toggle('is-current', i === idx); a.classList.toggle('is-done', i < idx);
      if (i === idx) a.setAttribute('aria-current', 'location'); else a.removeAttribute('aria-current');
    });
    if (idx >= 0 && name) { name.innerHTML = ''; var b = d.createElement('b'); b.textContent = STATIONS[idx][1]; name.appendChild(b); name.appendChild(d.createTextNode(' ' + STATIONS[idx][2])); }
  }
  setCur(present[0][0]);
  /* the ring's ticks sit at fixed, even angles (0, 72, 144…), so the last station never comes back round onto
     the first. The arc is piecewise: it reaches each tick as that station becomes current and closes the
     circle at the end of the last one. */
  present.forEach(function (s, i) { var a = li.querySelector('[data-st="' + s[0] + '"]'); if (a) a.style.setProperty('--a', (i * 360 / n).toFixed(1) + 'deg'); });
  var stations = present.map(function (s) {
    var el = d.getElementById(s[0]);
    return ST.create({ trigger: el, start: 'top 50%', end: 'bottom 50%', onToggle: function (self) { if (self.isActive) setCur(s[0]); } });
  });
  ST.create({ trigger: first, start: mode === 'desk' ? 'top 50%' : 'top ' + hdr + 'px',
    endTrigger: mode === 'desk' && bk ? bk : last, end: mode === 'desk' && bk ? 'top 50%' : 'bottom ' + (hdr + 36) + 'px',
    onToggle: function (self) { li.classList.toggle('is-on', self.isActive); } });
  var knots = [[0, 0], [1, 1]];
  function arcEase(p) {
    for (var i = 1; i < knots.length; i++) {
      var A = knots[i - 1], B = knots[i];
      if (p <= B[0]) return B[0] > A[0] ? A[1] + (B[1] - A[1]) * (p - A[0]) / (B[0] - A[0]) : B[1];
    }
    return 1;
  }
  var range = gsap.fromTo(arc, { strokeDashoffset: 1 }, { strokeDashoffset: 0, ease: arcEase, autoRound: false,
    scrollTrigger: { trigger: first, start: 'top top', endTrigger: last, end: 'bottom bottom', scrub: true,
      onRefresh: function (self) {
        var span = Math.max(1, self.end - self.start), k = [[0, 0]], lo = 0;
        stations.forEach(function (s, i) {
          var f = Math.max(lo, Math.min(1, (s.start + w.innerHeight / 2 - self.start) / span));
          k.push([f, i / n]); lo = f;
        });
        k.push([1, 1]);
        knots = k;
      } } });
  if (prog) gsap.fromTo(prog, { scaleX: 0 }, { scaleX: 1, ease: 'none', scrollTrigger: { trigger: first, start: 'top top', endTrigger: last, end: 'bottom bottom', scrub: true } });
  cleanups.push(function () { li.classList.remove('is-ready', 'is-on', 'is-mini'); });
  return range;
}

/* ---------- footer ---------- */
function footer(ctx) {
  var eb = ctx.$('.eyebrow'), sq = ctx.$('.foot-sq'), ls = ctx.$$('.hl .in'), rest = ctx.$$('.foot-links, .foot-small');
  var tl = gsap.timeline({ scrollTrigger: { trigger: ctx.el, start: ctx.frames ? 'top 85%' : 'top 75%', toggleActions: 'play none none none' } });
  if (eb) tl.add(scramble(eb), 0);
  if (sq) tl.fromTo(sq, { scale: 0 }, { scale: 1, ease: E.pop, duration: D.pop }, 0);
  if (ls.length) maskIn(tl, ls, .1);
  if (rest.length) tl.fromTo(rest, { opacity: 0, y: 12 }, { opacity: 1, y: 0, ease: E.enter, duration: D.enter, stagger: .08 }, .7);
  var rec = { el: ctx.el, tl: tl };
  focusReveals.push(rec);
  ctx.add(function () { focusReveals = focusReveals.filter(function (x) { return x !== rec; }); });
}
registry.push({ id: 'end', def: { desk: footer, touch: footer, frames: footer } });

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
   bottom), then the generic reveals and the loop indicator, then one ScrollTrigger.refresh(). Later rebuilds
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
      if (mode !== 'reduce') { headReveals(mode, cleanups); batchReveals(mode, cleanups); }
      if (mode === 'desk' || mode === 'touch') loopIndicator(mode, cleanups);
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

  /* copy buttons: [COPY] → [COPIED] for 1.6 s */
  function fallbackCopy(text, btn) {
    var ok = false, ta = d.createElement('textarea');
    ta.value = text; ta.setAttribute('readonly', ''); ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none';
    d.body.appendChild(ta); ta.select();
    try { ok = d.execCommand('copy'); } catch (e) {}
    d.body.removeChild(ta);
    if (!ok) {
      var code = btn.closest('.ln') && btn.closest('.ln').querySelector('code');
      if (code) { var r = d.createRange(); r.selectNodeContents(code); var s = w.getSelection(); s.removeAllRanges(); s.addRange(r); }
    }
    return ok;
  }
  d.addEventListener('click', function (e) {
    var b = e.target.closest('button.copy'); if (!b) return;
    var ln = b.closest('.ln'), code = ln && ln.querySelector('code');
    var text = b.getAttribute('data-copy') || (code ? code.textContent : '');
    function done(ok) {
      b.textContent = ok ? '[COPIED]' : '[COPY]'; b.classList.toggle('is-done', ok);
      announce(ok ? 'Copied' : 'Selected, press Command or Control and C to copy');
      clearTimeout(b._t); b._t = setTimeout(function () { b.textContent = '[COPY]'; b.classList.remove('is-done'); }, 1600);
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
    var id = decodeURIComponent(a.getAttribute('href').slice(1));
    var t = id ? d.getElementById(id) : null; if (!t) return;
    e.preventDefault();
    if (Ravi.closeMenu) Ravi.closeMenu(false);
    var y = id === 'top' ? 0 : t.getBoundingClientRect().top + w.pageYOffset - anchorOffset(t);
    scrollToY(y);
    if (id !== 'top') settleAnchor(t);
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
  packet: packet, packetRefuse: packetRefuse, lit: lit, hold: hold, center: center,
  pauseOffscreen: pauseOffscreen, caretOn: caretOn, irisIn: irisIn, spot: spot, draw: draw,
  scrollToY: scrollToY, refresh: refresh, announce: announce, kbRecent: kbRecent,
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
/* 00 · #top hero. Three time-based parts, no pin:
   1. copy: on load (headline, lead, the setup line, links, then the example chips pop). These are CSS keyframes
      in css/00-top.css that start at first paint, so the first screen never waits for the scripts, the web
      fonts or the other sections' builds;
   2. composition: when it scrolls into view (cards rise, agents strip wipes, loop draws, stations pop),
      then the packet waits on 01 ASK, breathing (a CSS pulse on an HTML glow, so it costs no layout);
   3. lap: once the agents strip is on screen, the packet goes round once and hands the work along:
      each agent's chip lights for its stretch of the loop, and the card at each station answers. */
var done = { vis: false, lap: false };

/* seconds since the CSS copy entrance started (it starts with the first paint) */
function sinceEntrance() {
  var p = window.performance, e = p && p.getEntriesByName ? p.getEntriesByName('first-contentful-paint')[0] : null;
  return p ? Math.max(0, (p.now() - (e ? e.startTime : 0)) / 1000) : 99;
}

function invWipe(p) { return p < .5 ? Math.sqrt(p / 2) : 1 - Math.sqrt((1 - p) * 2) / 2; } /* inverse of power2.inOut */

function buildVertical(tv, svg) {
  var W = tv.clientWidth, H = tv.clientHeight, r = 14, x0 = 8, y0 = 4.75, x1 = W - 4.75, y1 = H - 4.75;
  var st1 = tv.querySelector('.st--01'), sy = st1 ? st1.offsetTop : 28;
  svg.setAttribute('width', W); svg.setAttribute('height', H);
  svg.querySelector('.tv-path').setAttribute('d',
    'M' + x0 + ' ' + sy + ' V' + (y1 - r) + ' Q' + x0 + ' ' + y1 + ' ' + (x0 + r) + ' ' + y1 + ' H' + (x1 - r) +
    ' Q' + x1 + ' ' + y1 + ' ' + x1 + ' ' + (y1 - r) + ' V' + (y0 + r) + ' Q' + x1 + ' ' + y0 + ' ' + (x1 - r) + ' ' + y0 +
    ' H' + (x0 + r) + ' Q' + x0 + ' ' + y0 + ' ' + x0 + ' ' + (y0 + r) + ' Z');
  tv.classList.add('is-vbuilt');
}

/* fraction of the path length where each station sits (nearest of the packet's sampled points); 01 is the start */
function stationFractions(pts, stations) {
  return stations.map(function (st, i) {
    if (i === 0) return 0;
    var x = st.offsetLeft, y = st.offsetTop, best = 0, bd = 1e9;
    pts.forEach(function (p, j) { var dd = (p.x - x) * (p.x - x) + (p.y - y) * (p.y - y); if (dd < bd) { bd = dd; best = j; } });
    return best / (pts.length - 1);
  });
}

function hero(ctx, k) {
  var gsap = Ravi.gsap, ST = Ravi.ST, E = Ravi.E, D = Ravi.D;
  var el = ctx.el, tv = ctx.$('.tv'), bar = ctx.$('.tv-bar');
  var vertical = ctx.narrow;
  var svg = vertical ? ctx.$('.tv-loop--v') : ctx.$('.tv-loop--h');
  var path = svg.querySelector('.tv-path'), pk = svg.querySelector('.tv-pk'), glow = ctx.$('.tv-glow');
  if (vertical) {
    buildVertical(tv, svg);
    ctx.add(function () { tv.classList.remove('is-vbuilt'); });
  }
  var stations = ctx.$$('.st'), sqs = stations.map(function (s) { return s.querySelector('.st-sq'); }), labs = ctx.$$('.st-l');
  var cards = [ctx.$('.tv-slack'), ctx.$('.tv-base'), ctx.$('.tv-page')];
  var agents = ctx.$$('.tv-chips .chip');                                               /* reception, dev, ops */
  var answers = [ctx.$('.tv-slack .av'), ctx.$('.tv-tbl tbody .stc'), ctx.$('.tv-bc')]; /* at 01, 02, 03 */
  var pts = Ravi.sampler(path, 96);
  var fr = stationFractions(pts, stations);
  var start = pts[0] || { x: 0, y: 0 };
  gsap.set([pk, glow], { x: start.x, y: start.y });

  /* 1. copy: CSS (see the header note) */

  /* 2. composition (starts .5 s into the copy when it is already on screen at load) */
  var vd = .5 * k, t0 = vd + .5 * k, draw = 1.4 * k;
  var tv2 = gsap.timeline({ paused: true, defaults: { overwrite: 'auto' } });
  tv2.fromTo(cards, { y: 30, opacity: 0 }, { y: 0, opacity: 1, ease: E.rise, duration: D.rise * k, stagger: .1 * k }, vd);
  tv2.add(Ravi.wipeIn(bar, 'left', .6 * k), vd);
  tv2.add(Ravi.draw(path, draw), t0);
  sqs.forEach(function (sq, i) {
    var at = t0 + draw * invWipe(fr[i]);
    tv2.fromTo(sq, { scale: 0 }, { scale: 1, ease: E.pop, duration: D.pop * k }, at);
    tv2.fromTo(labs[i], { opacity: 0, x: -4 }, { opacity: 1, x: 0, ease: E.enter, duration: .35 * k }, at + .05);
  });
  tv2.fromTo([pk, glow], { opacity: 0 }, { opacity: 1, duration: .25 }, t0 + draw);
  tv2.fromTo(ctx.$('.tv-cap'), { opacity: 0, y: 6 }, { opacity: 1, y: 0, ease: E.enter, duration: .5 }, t0 + draw - .3);

  /* 3. the lap */
  var lap = vertical ? 2.4 : 2.6 * k, L0 = .45; /* L0: reception takes Ana's ask before the packet leaves 01 */
  var tl = gsap.timeline({ paused: true, defaults: { overwrite: 'auto' } });
  tl.add(Ravi.packet(pk, pts, lap, E.travel), L0);
  tl.add(Ravi.packet(glow, pts, lap, E.travel), L0);
  sqs.forEach(function (sq, i) {
    if (i === 0) return;
    var at = L0 + lap * fr[i];
    tl.to(sq, { scale: 1.5, duration: .14, yoyo: true, repeat: 1, ease: 'power1.inOut' }, at - .07);
    /* the square lights mint as the packet passes, then fades back */
    tl.fromTo(sq, { '--on': 0 }, { '--on': 1, duration: .12, ease: E.enter, immediateRender: false }, at - .08);
    tl.to(sq, { '--on': 0, duration: .6, ease: 'power1.out' }, at + .2);
  });
  tl.fromTo(sqs[0], { scale: 1 }, { scale: 1.45, duration: .16, yoyo: true, repeat: 1, ease: 'power1.inOut', immediateRender: false }, L0 + lap - .08);
  /* the card at each station answers as the packet arrives */
  answers.forEach(function (a, i) {
    if (a) tl.fromTo(a, { scale: 1 }, { scale: 1.16, duration: .16, yoyo: true, repeat: 1, ease: 'power1.inOut', immediateRender: false }, i ? L0 + lap * fr[i] - .04 : .05);
  });
  /* who holds the work: reception for 01, dev for 02 and 03, ops for 04 and 05 */
  var hand = [0, fr[1], fr[3]];
  agents.forEach(function (chip, i) {
    var on = i ? L0 + lap * hand[i] - .1 : 0, off = i < 2 ? L0 + lap * hand[i + 1] - .1 : L0 + lap + .1;
    tl.fromTo(chip, { '--lit': 0 }, { '--lit': 1, duration: .25, ease: E.enter, immediateRender: false }, on);
    tl.fromTo(chip, { scale: 1 }, { scale: 1.06, duration: .14, yoyo: true, repeat: 1, ease: 'power1.inOut', immediateRender: false }, on);
    tl.to(chip, { '--lit': 0, duration: .35, ease: E.enter }, off);
  });

  /* the packet breathes on 01 while it waits and after the lap, only while the picture is on screen.
     The pulse is a CSS animation (transform + opacity) on the glow's inner element: the compositor runs it,
     so an idle hero costs no style or layout work. Removing the class puts the glow back at rest. */
  var resting = false, onScreen = false;
  function sync() { glow.classList.toggle('is-breathing', resting && onScreen); }
  function rest(on) { resting = on; sync(); }
  ctx.add(function () { glow.classList.remove('is-breathing'); });
  ST.create({ trigger: tv, start: 'top bottom', end: 'bottom top', onToggle: function (s) { onScreen = s.isActive; sync(); } });

  var visDone = false, lapIn = false;
  function tryLap() {
    if (!visDone || !lapIn || done.lap) return;
    done.lap = true; rest(false); tl.play(0);
  }
  tv2.eventCallback('onComplete', function () { visDone = true; done.vis = true; rest(true); tryLap(); });
  tl.eventCallback('onComplete', function () { rest(true); });

  function showVis() {
    if (tv2.progress() > 0 || tv2.isActive()) return;
    tv2.play(Math.min(sinceEntrance(), vd));
  }
  function goLap() { lapIn = true; tryLap(); }

  if (done.lap) { tv2.progress(1); tl.progress(1); visDone = true; rest(true); }
  else {
    if (done.vis) tv2.progress(1);
    ST.create({ trigger: tv, start: 'top 85%', onEnter: showVis, onEnterBack: showVis });
    ST.create(vertical
      ? { trigger: tv, start: 'top 38%', onEnter: goLap, onEnterBack: goLap }
      : { trigger: bar, start: 'bottom bottom', onEnter: goLap, onEnterBack: goLap });
  }

  if (ctx.desk) {
    gsap.to(ctx.$('.top-vis'), { y: -60, ease: 'none', scrollTrigger: { trigger: el, start: 'top top', end: 'bottom top', scrub: true } });
    gsap.to(ctx.$('.top-copy'), { y: -30, ease: 'none', scrollTrigger: { trigger: el, start: 'top top', end: 'bottom top', scrub: true } });
  }
  if (vertical) ctx.onRefresh(function () {
    buildVertical(tv, svg);
    var p = Ravi.samplePath(path, 96); pts.length = 0; pts.push.apply(pts, p);
  });
}

Ravi.section('top', {
  desk: function (ctx) { hero(ctx, 1); },
  touch: function (ctx) { hero(ctx, .8); }
});
} catch (err) { console.error('[section top]', err); }
})();

/* ---- section ask (01-ask.js) ---- */
(function(){
'use strict';
try {
/* 01 · #ask (PIN 1): it starts as a Slack message.
   Desk: approach (iris + window chrome) → pinned scrub, labels at the end of each beat's action,
   so a snap or a beat click always lands on a finished frame. Touch: Ana on enter, a short pin on
   the card, then the agent strip (the handoff ticket) on enter. Static modes show the frames strip
   (HTML only). */
var E = Ravi.E;

/* layout box of el relative to root's padding box. Uses offsets, so it ignores transforms
   (window hold push, feed scroll, strip rise): every caller adds the transforms it knows about. */
function rel(el, root) {
  var x = 0, y = 0, n = el, w = el.offsetWidth, h = el.offsetHeight;
  while (n && n !== root) {
    x += n.offsetLeft; y += n.offsetTop;
    var p = n.offsetParent;
    if (!p) break;
    if (p !== root) { x += p.clientLeft; y += p.clientTop; }
    n = p;
  }
  return { x: x, y: y, w: w, h: h };
}
function cssPx(name, fb) {
  var v = parseFloat(getComputedStyle(document.documentElement).getPropertyValue(name));
  return isNaN(v) ? fb : v;
}

function parts(ctx) {
  /* every query is scoped to the stage: the frames strip carries static copies of the same mocks */
  var st = ctx.$('.ak-stage');
  var $ = function (q) { return st.querySelector(q); };
  var $$ = function (q) { return Array.prototype.slice.call(st.querySelectorAll(q)); };
  return {
    stage: st, scene: ctx.$('.scene'), wrap: ctx.$('.stage-wrap'),
    win: $('.ak-win'), rail: $('.ak-rail'), railRows: $$('.ak-rail .sk-ws, .ak-rail .sk-group, .ak-rail li'), msgs: $('.ak-msgs'), feed: $('.ak-feed'), note: $('.ak-note--stage'),
    ana: $('.ak-ana'), anaAv: $('.ak-ana-av'), anaMeta: $('.ak-ana-meta'), words: $$('.ak-words>span'),
    panel: $('.ak-panel'), pvp: $('.ak-pvp'), recm: $('.ak-recm'), recAv: $('.ak-rec-av'), recMeta: $('.ak-rec-meta'),
    card: $('.ak-card'), bg: $('.ak-card-bg'), btm: $('.ak-card-btm'),
    hdrBlock: $('.ak-req .bk-header'), head: $('.ak-req .bk-header .in'), plan: $('.ak-req .ak-plan'), lns: $$('.ak-req .ak-ln'),
    cx: $('.ak-req .bk-context'), acts: $('.ak-acts'), approve: $('.ak-approve'), reject: $('.ak-reject'), tagI: $('.ak-tag-ign'),
    fin: $('.ak-final'), finIn: $$('.ak-final .in'), tagOk: $('.ak-tag-ok'),
    caps: $$('.ak-cap'), curB: $('.ak-cur-b'), curC: $('.ak-cur-c'),
    rt: $('.ak-rt'), dia: $('.ak-dia'), chips: $('.ak-chips'), wireAll: $('.ak-wire-all'), wire: $('.ak-wire'), pk: $('.ak-pk'),
    ret: $('.ak-ret'), retMp: $('.ak-ret-mp'), retH: $('.ak-ret-h'), retL: $('.ak-ret-l'),
    cRec: $('.ak-c-rec'), cDev: $('.ak-c-dev'), cOps: $('.ak-c-ops'), st: $('.ak-st'), ticket: $('.ak-ticket'), tk: $('.ak-tk-in')
  };
}

/* y = the feed scroll that keeps the card's bottom in view. If it leaves a tab (Ana's message,
   reception's avatar, the card's header, a plan line) half cut at the top edge, show it whole when
   the buttons still fit, otherwise scroll it out whole, so the top edge never slices a line of text.
   Tabs go top to bottom, so each one only has to look at what the one above left. */
function tabSafe(y, tabs, card, root, vh) {
  var c = rel(card, root);
  tabs.forEach(function (tab) {
    var t = rel(tab, root), top = t.y + y;
    if (top >= 0 || top + t.h <= 0) return;
    if (c.y + c.h + y - top <= vh - 4) y = Math.min(0, Math.round(y - top));
    else y = -Math.round(t.y + t.h + 2);
  });
  return y;
}
/* the card shade is two pieces (a top piece and a 12px bottom edge), so it can end below any block
   without a height tween: the top piece clips from the bottom, the edge rides up by the same amount.
   shade(P, el) = how far the shade is cut back so that it ends just under el (0 = the whole card). */
function shade(P, el) {
  var padB = parseFloat(getComputedStyle(P.card).paddingBottom) || 16, r = rel(el, P.card);
  return Math.max(0, Math.round(P.card.offsetHeight - (r.y + r.h + padB)));
}
function cutBy(P) { return shade(P, P.fin); }
/* move the shade from ending under `a` to ending under `b` (elements or null for the whole card) */
function shadeTween(tl, P, a, b, at, dur, ease, first) {
  var A = function () { return a ? shade(P, a) : 0; }, B = function () { return b ? shade(P, b) : 0; };
  var o = { ease: ease || E.enter, duration: dur, immediateRender: !!first };
  tl.fromTo(P.bg, { clipPath: function () { return 'inset(0px 0px ' + A() + 'px 0px)'; } }, Object.assign({ clipPath: function () { return 'inset(0px 0px ' + B() + 'px 0px)'; } }, o), at);
  tl.fromTo(P.btm, { y: function () { return -A(); } }, Object.assign({ y: function () { return -B(); } }, o), at);
}
/* collapse onto the final message */
function collapse(tl, P, at, dur) { shadeTween(tl, P, null, P.fin, at, dur, E.wipe); }
/* ripple ring under a cursor: hidden until `at`, then one ring */
function rip(tl, cur, at, dur) {
  var r = cur.querySelector('.cur-ripple');
  tl.fromTo(r, { opacity: 0, scale: .2 }, { opacity: 1, duration: dur * .05 }, at);
  tl.to(r, { scale: 1.6, opacity: 0, ease: E.enter, duration: dur * .95 }, at + dur * .05);
}

/* ---------- typing that follows the line boxes ----------
   A plan line that wraps types row by row: a stepped clip polygon (one step per character)
   reveals the first row left to right, then the next. Rows are measured on every refresh. */
function rowsOf(el) {
  var R = document.createRange(); R.selectNodeContents(el);
  var er = el.getBoundingClientRect(), k = el.offsetWidth / (er.width || 1), rows = [];
  Array.prototype.forEach.call(R.getClientRects(), function (r) {
    if (!r.width) return;
    var t = (r.top - er.top) * k, b = (r.bottom - er.top) * k, x1 = (r.right - er.left) * k;
    var last = rows[rows.length - 1];
    if (last && Math.abs(last.t - t) < 3) { last.x1 = Math.max(last.x1, x1); last.b = Math.max(last.b, b); }
    else rows.push({ t: t, b: b, x1: x1 });
  });
  return rows;
}
function rowClip(rows, p) {
  if (p >= 1) return 'none';
  if (p <= 0 || !rows.length) return 'inset(0px 100% 0px 0px)';
  var tot = rows.reduce(function (a, r) { return a + r.x1; }, 0), pos = p * tot, acc = 0, vis = [];
  for (var i = 0; i < rows.length && pos > acc; i++) { vis.push({ x: Math.min(rows[i].x1, pos - acc), t: rows[i].t, b: rows[i].b }); acc += rows[i].x1; }
  var f = function (v) { return v.toFixed(1) + 'px'; }, pts = [f(-2) + ' ' + f(vis[0].t - 2)];
  vis.forEach(function (v, j) {
    pts.push(f(v.x) + ' ' + f(j ? v.t : v.t - 2));
    pts.push(f(v.x) + ' ' + f(j < vis.length - 1 ? vis[j + 1].t : v.b + 2));
  });
  pts.push(f(-2) + ' ' + f(vis[vis.length - 1].b + 2));
  return 'polygon(' + pts.join(',') + ')';
}
/* plan lines: one after another between from and to, constant typing speed */
function typePlan(ctx, tl, P, from, to, onLine) {
  var n = P.lns.map(function (l) { return Math.max(1, l.textContent.length); });
  var tot = n.reduce(function (a, b) { return a + b; }, 0), k = (to - from) / tot, t = from;
  var recs = P.lns.map(function (l) { return { el: l, rows: [], o: { p: 0 } }; });
  function paint(r) { r.el.style.clipPath = rowClip(r.rows, r.o.p); }
  function measure() { recs.forEach(function (r) { r.rows = rowsOf(r.el); paint(r); }); }
  measure();
  ctx.onRefresh(measure);
  ctx.add(function () { P.lns.forEach(function (l) { l.style.clipPath = ''; }); });
  recs.forEach(function (r, i) {
    var d = n[i] * k;
    tl.fromTo(r.o, { p: 0 }, { p: 1, ease: 'steps(' + n[i] + ')', duration: d, onUpdate: function () { paint(r); }, onStart: function () { paint(r); } }, t);
    if (onLine) onLine(r.el, t, d);
    t += d;
  });
}

/* ---------- the agent strip geometry (the stage copy; the frame copy is authored SVG) ---------- */
function setD(el, d) { if (el) el.setAttribute('d', d); }
/* desk: chips in a row; the ticket rides the wire above them; the return runs under them */
function geoH(P) {
  var a = rel(P.cRec, P.dia), b = rel(P.cDev, P.dia), c = rel(P.cOps, P.dia), s = rel(P.st, P.dia);
  var y = Math.round(a.y + a.h / 2) + .5;
  var x1 = a.x + a.w + 6, x2 = b.x - 6, x3 = b.x + b.w + 6, x4 = c.x - 6;
  setD(P.wireAll, 'M' + x1 + ' ' + y + ' H' + x2 + ' M' + x3 + ' ' + y + ' H' + x4);
  setD(P.wire, 'M' + x1 + ' ' + y + ' H' + x2);
  var sx = Math.round(Math.min(b.x + 16, s.x - 10)) + .5, sy = b.y + b.h + 4, yb = Math.round(b.y + b.h + 20) + .5;
  var ex = Math.round(a.x + a.w * .5) + .5, ey = a.y + a.h + 5;
  var d = 'M' + sx + ' ' + sy + ' V' + (yb - 8) + ' Q' + sx + ' ' + yb + ' ' + (sx - 8) + ' ' + yb +
    ' H' + (ex + 8) + ' Q' + ex + ' ' + yb + ' ' + ex + ' ' + (yb - 8) + ' V' + ey;
  setD(P.ret, d); setD(P.retMp, d);
  setD(P.retH, 'M' + (ex - 4.5) + ' ' + (ey + 5.5) + ' L' + ex + ' ' + ey + ' L' + (ex + 4.5) + ' ' + (ey + 5.5));
  P.retL.style.left = Math.round((sx + ex) / 2 - P.retL.offsetWidth / 2) + 'px';
  P.retL.style.top = Math.round(yb - P.retL.offsetHeight / 2) + 'px';
}
/* touch: chips in a column on a vertical wire; the return runs down their right side */
function geoV(P) {
  var a = rel(P.cRec, P.dia), b = rel(P.cDev, P.dia), c = rel(P.cOps, P.dia), k = rel(P.ticket, P.dia);
  var dot = rel(P.cRec.querySelector('i'), P.dia), x = Math.round(dot.x + dot.w / 2) + .5;
  var y1 = a.y + a.h + 4, y2 = b.y - 4;
  setD(P.wireAll, 'M' + x + ' ' + y1 + ' V' + y2 + ' M' + x + ' ' + (b.y + b.h + 4) + ' V' + (c.y - 4));
  setD(P.wire, 'M' + x + ' ' + y1 + ' V' + y2);
  var xr = Math.round(Math.max(a.x + a.w, b.x + b.w, k.x + k.w) + 6) + .5, ay = Math.round(a.y + a.h / 2) + .5, by = Math.round(b.y + b.h / 2) + .5;
  var sx = b.x + b.w + 6, ex = a.x + a.w + 7;
  var d = 'M' + sx + ' ' + by + ' H' + (xr - 8) + ' Q' + xr + ' ' + by + ' ' + xr + ' ' + (by - 8) +
    ' V' + (ay + 8) + ' Q' + xr + ' ' + ay + ' ' + (xr - 8) + ' ' + ay + ' H' + ex;
  setD(P.ret, d); setD(P.retMp, d);
  setD(P.retH, 'M' + (ex + 5.5) + ' ' + (ay - 4.5) + ' L' + ex + ' ' + ay + ' L' + (ex + 5.5) + ' ' + (ay + 4.5));
}
function clearGeo(P) {
  [P.wireAll, P.wire, P.ret, P.retMp, P.retH].forEach(function (p) { setD(p, 'M0 0'); });
  P.retL.style.left = ''; P.retL.style.top = '';
}

/* ================= desk ================= */
function desk(ctx) {
  var gsap = Ravi.gsap, P = parts(ctx), stage = P.stage;
  /* out = 1: the pin ends on the finished handoff (a whole frame, so the end snap rests on it);
     the scene closes into its lens only after the pin, while 02 · BUILD scrolls in under it */
  var L = { 'in': 0, ana: .10, plan: .30, bruno: .50, carla: .66, task: .86, out: 1 };

  /* feed auto-scroll (Slack keeps the newest line in view when the window is short) */
  function need(el, extra) {
    return function () {
      var r = rel(el, P.feed), vh = P.msgs.clientHeight;
      return -Math.max(0, Math.round(r.y + r.h + (extra || 14) - vh));
    };
  }
  var needCard = need(P.card, 8);
  var tabs = [P.ana, P.recAv, P.hdrBlock].concat(P.lns);
  function feedAtButtons() { return tabSafe(needCard(), tabs, P.card, P.feed, P.msgs.clientHeight); }
  function at(el, fx, fy, feedY) {
    return {
      x: function () { var r = rel(el, stage); return r.x + r.w * fx; },
      y: function () { var r = rel(el, stage); return r.y + r.h * fy + (feedY ? feedY() : 0); }
    };
  }
  /* cursor starts: empty card space right of a short row (the buttons, the context line), so a cursor
     never enters over text. dx = gap after the row's last element; the pill (64px) stays in the card. */
  function startRight(after, row, fy, dx) {
    return {
      x: function () { var a = rel(after, stage), c = rel(P.card, stage); return Math.round(Math.min(a.x + a.w + dx, c.x + c.w - 76)); },
      y: function () { var r = rel(row, stage); return Math.round(r.y + r.h * fy + feedAtButtons()); }
    };
  }
  /* dock: on short stages the window would leave the card too little room. Then the strip's
     bands above and below the chip row (empty until the handoff) fold away, clipped: the lower
     one first, the upper one too if that is not enough. Just before the handoff the window's
     bottom edge rises by both and the strip opens. Layout only, decided before every refresh measures. */
  var dockT = 0, dockB = 0, dockD = 0;
  function undock() {
    stage.classList.remove('ak-dock'); stage.style.removeProperty('--ak-dock'); stage.style.removeProperty('--ak-dock-t');
    dockT = dockB = dockD = 0;
  }
  function dock() {
    undock();
    var short = rel(P.recm, P.feed).y + P.recm.offsetHeight + 10 - P.msgs.clientHeight;
    if (short <= 0) return;
    var cy = rel(P.chips, P.rt).y;
    dockB = Math.max(0, Math.round(P.rt.offsetHeight - (cy + P.chips.offsetHeight) - 10));
    if (short > dockB) dockT = Math.max(0, Math.round(cy - 10));
    dockD = dockT + dockB;
    if (!dockD) return;
    stage.classList.add('ak-dock'); stage.style.setProperty('--ak-dock', dockB + 'px'); stage.style.setProperty('--ak-dock-t', dockT + 'px');
  }
  dock();
  geoH(P);
  Ravi.ST.addEventListener('refreshInit', dock);
  ctx.add(function () { Ravi.ST.removeEventListener('refreshInit', dock); undock(); clearGeo(P); });

  /* approach: the stage opens from where Ana's message will land; the window chrome settles in */
  ctx.iris({ at: function () { var r = rel(P.anaAv, stage); return { x: r.x + r.w / 2, y: r.y + r.h / 2 }; } });
  var ap = gsap.timeline({ defaults: { ease: 'none' },
    scrollTrigger: { trigger: P.wrap, start: 'top 70%', end: 'top top', scrub: .6, invalidateOnRefresh: true } });
  ap.to({}, { duration: 1 }, 0);
  ap.fromTo(P.rail, { x: -24, opacity: 0 }, { x: 0, opacity: 1, ease: E.enter, duration: .45 }, .2);
  ap.fromTo(P.railRows, { opacity: 0, x: -8 }, { opacity: 1, x: 0, ease: E.enter, duration: .25, stagger: .04 }, .3);
  ap.fromTo(P.rt, { y: 40, opacity: 0 }, { y: 0, opacity: 1, ease: E.rise, duration: .5 }, .38);
  ap.fromTo(P.note, { opacity: 0 }, { opacity: 1, duration: .3 }, .55);

  var p = ctx.pin({ end: '+=200%', labels: L, onRefresh: function () { geoH(P); } });
  var tl = p.tl;

  /* 01 ana · .01–.09 */
  tl.fromTo(P.ana, { opacity: 0 }, { opacity: 1, duration: .006 }, .01);
  tl.fromTo(P.anaAv, { scale: 0 }, { scale: 1, ease: E.pop, duration: .026 }, .01);
  tl.fromTo(P.anaMeta, { opacity: 0, y: 6 }, { opacity: 1, y: 0, ease: E.enter, duration: .02 }, .02);
  tl.fromTo(P.words, { opacity: 0, y: 4 }, { opacity: 1, y: 0, ease: E.enter, duration: .008, stagger: .0028 }, .03);

  /* 02 plan · .12–.30: the card rises, the nine lines type, the card's shade grows with them */
  tl.fromTo(P.recAv, { opacity: 0, scale: 0 }, { opacity: 1, scale: 1, ease: E.pop, duration: .02 }, .12);
  tl.fromTo(P.recMeta, { opacity: 0, y: 6 }, { opacity: 1, y: 0, ease: E.enter, duration: .02 }, .125);
  tl.fromTo(P.card, { opacity: 0, y: 14 }, { opacity: 1, y: 0, ease: E.rise, duration: .03 }, .13);
  tl.to(P.feed, { y: need(P.hdrBlock), ease: E.enter, duration: .02 }, .13);
  tl.fromTo(P.head, { yPercent: 110, y: 0 }, { yPercent: 0, y: 0, ease: E.rise, duration: .025 }, .14);
  shadeTween(tl, P, P.hdrBlock, P.hdrBlock, 0, .001, 'none', true);
  var prev = P.hdrBlock;
  typePlan(ctx, tl, P, .155, .265, function (l, t, d) {
    tl.to(P.feed, { y: need(l), ease: 'none', duration: d }, t);
    shadeTween(tl, P, prev, l, t, Math.min(d, .005)); prev = l;
  });
  tl.fromTo(P.cx, { opacity: 0 }, { opacity: 1, ease: E.enter, duration: .012 }, .268);
  shadeTween(tl, P, prev, P.cx, .266, .008);
  tl.to(P.feed, { y: feedAtButtons, ease: E.enter, duration: .02 }, .27);
  shadeTween(tl, P, P.cx, P.approve, .272, .01);
  tl.fromTo([P.approve, P.reject], { opacity: 0, scale: .6 }, { opacity: 1, scale: 1, ease: E.popSoft, duration: .02, stagger: .006 }, .274);
  /* hold · slow push on the window, released as Bruno's cursor enters */
  Ravi.hold(tl, P.win, .30, .34, .03);

  /* 03 bruno · .34–.50: glides in along the button row from the empty right of the card, presses,
     nothing changes */
  var tB = at(P.approve, .55, .62, feedAtButtons), sB = startRight(P.reject, P.approve, .62, 120);
  tl.fromTo(P.curB, { x: sB.x, y: sB.y }, { x: tB.x, y: tB.y, ease: E.cut, duration: .06 }, .34);
  tl.fromTo(P.curB, { opacity: 0 }, { opacity: 1, duration: .012 }, .34);
  tl.add(Ravi.press(P.approve).duration(.02), .42);
  rip(tl, P.curB, .42, .03);
  shadeTween(tl, P, P.approve, null, .43, .01);
  tl.fromTo(P.tagI, { opacity: 0, scale: .9 }, { opacity: 1, scale: 1, ease: E.popSoft, duration: .016 }, .435);
  tl.to(P.tagI, { keyframes: { x: [0, -6, 5, -3, 2, 0] }, ease: 'power1.out', duration: .035 }, .437);
  tl.to(P.tagI, { opacity: 0, ease: E.enter, duration: .018 }, .502);

  /* 04 carla · .52–.66: from the empty right of the context line, her click counts, the card
     collapses to the outcome */
  tl.to(P.curB, { x: '-=96', y: '-=12', opacity: .45, ease: E.enter, duration: .03 }, .505);
  var tC = at(P.approve, .32, .5, feedAtButtons), sC = startRight(P.cx, P.cx, .5, 400);
  tl.fromTo(P.curC, { x: sC.x, y: sC.y }, { x: tC.x, y: tC.y, ease: E.cut, duration: .055 }, .52);
  tl.fromTo(P.curC, { opacity: 0 }, { opacity: 1, duration: .012 }, .52);
  tl.add(Ravi.press(P.approve).duration(.02), .585);
  rip(tl, P.curC, .585, .03);
  tl.add(Ravi.wipeOut(P.acts, 'top', .022), .598);
  tl.to([P.hdrBlock, P.plan, P.cx], { opacity: 0, ease: E.enter, duration: .02 }, .6);
  collapse(tl, P, .605, .03);
  var needFin = need(P.fin, 30);
  tl.to(P.feed, { y: needFin, ease: E.cut, duration: .03 }, .607);
  tl.fromTo(P.finIn, { yPercent: 110, y: 0, opacity: 1 }, { yPercent: 0, y: 0, opacity: 1, ease: E.rise, duration: .025, stagger: .008 }, .615);
  tl.to([P.curB, P.curC], { opacity: 0, ease: E.enter, duration: .014 }, .61);
  tl.fromTo(P.tagOk, { opacity: 0, scale: .6 }, { opacity: 1, scale: 1, ease: E.pop, duration: .022 }, .635);

  /* 05 task · .662–.86 */
  /* (docked) the window's bottom edge rises (clipped, rounded) while its header, rail and messages
     stay put; the note and the strip move up into the room it frees, and the strip opens */
  var D = function () { return -dockD; };
  tl.to(P.note, { y: D, ease: E.cut, duration: .026 }, .662);
  /* the approach owns the strip's y (its rise), so the pan moves it by yPercent */
  tl.to(P.rt, { yPercent: function () { return -100 * dockB / (P.rt.offsetHeight || 1); }, ease: E.cut, duration: .026 }, .662);
  /* …and the feed keeps the outcome clear of the new bottom edge; if that would cut Ana's message
     at the top, her message leaves whole instead */
  tl.to(P.feed, { y: function () {
    if (!dockD) return needFin();
    var room = P.msgs.clientHeight - dockD, f = rel(P.fin, P.feed);
    var y = Math.min(needFin(), Math.round(room - (f.y + f.h) - 16));
    return tabSafe(y, [P.ana, P.recAv], P.fin, P.feed, room);
  }, ease: E.cut, duration: .026 }, .662);
  tl.fromTo(P.win, { clipPath: 'inset(0px 0px 0px 0px round 8px)' }, { clipPath: function () { return 'inset(0px 0px ' + dockD + 'px 0px round 8px)'; }, ease: E.cut, duration: .026, immediateRender: false }, .662);
  tl.fromTo(P.rt, { clipPath: function () { return 'inset(' + dockT + 'px 0px ' + dockB + 'px 0px round 8px)'; } }, { clipPath: 'inset(0px 0px 0px 0px round 8px)', ease: E.cut, duration: .026, immediateRender: false }, .662);

  /* .70 reception lights · .72 the ticket pops from it · .73–.80 it rides the wire to dev */
  tl.fromTo(P.cRec, { '--lit': 0 }, { '--lit': 1, ease: E.enter, duration: .02 }, .70);
  tl.to(P.cRec, { keyframes: { scale: [1, 1.06, 1] }, ease: 'none', duration: .018 }, .70);
  var tkX = function () { var a = rel(P.cRec, P.chips), b = rel(P.cDev, P.chips); return Math.round((a.x + a.w / 2) - (b.x + b.w / 2)); };
  tl.fromTo(P.ticket, { x: tkX, y: 0 }, { x: 0, y: 0, ease: E.travel, duration: .07 }, .73);
  tl.fromTo(P.ticket, { opacity: 0 }, { opacity: 1, duration: .004 }, .72);
  tl.fromTo(P.tk, { scale: .6, y: 6 }, { scale: 1, y: 0, ease: E.pop, duration: .02 }, .72);
  /* a small lift while it travels, set down on arrival */
  tl.to(P.tk, { y: -5, ease: 'sine.out', duration: .032 }, .74);
  tl.to(P.tk, { y: 0, ease: 'sine.in', duration: .03 }, .772);
  tl.fromTo(P.pk, { opacity: 0 }, { opacity: 1, duration: .004 }, .73);
  tl.add(Ravi.packet(P.pk, P.wire, .07, E.travel), .73);
  tl.fromTo(P.wire, { strokeDashoffset: 1 }, { strokeDashoffset: 0, ease: E.travel, duration: .07, autoRound: false }, .73);
  tl.to(P.pk, { opacity: 0, duration: .006 }, .80);
  /* .80 dev lights, the ticket docks · .81 the pill types · .83–.86 the return arrow draws */
  tl.fromTo(P.cDev, { '--lit': 0 }, { '--lit': 1, ease: E.enter, duration: .02 }, .80);
  tl.to(P.cDev, { keyframes: { scale: [1, 1.08, 1] }, ease: 'none', duration: .02 }, .80);
  tl.to(P.tk, { keyframes: { scaleY: [1, .94, 1] }, ease: 'none', duration: .014 }, .802);
  tl.fromTo(P.st, { clipPath: 'inset(0 100% 0 0)' }, { clipPath: 'inset(0 0% 0 0)', ease: 'steps(' + P.st.textContent.length + ')', duration: .022 }, .81);
  tl.add(Ravi.draw(P.retMp, .03), .83);
  tl.fromTo(P.retL, { opacity: 0, y: 4 }, { opacity: 1, y: 0, ease: E.enter, duration: .016 }, .838);
  tl.fromTo(P.retH, { opacity: 0 }, { opacity: 1, duration: .004 }, .856);
  Ravi.hold(tl, P.rt, .86, 1);

  /* exit, after the pin: the scene closes into a small lens on the docked ticket and dev, the match
     cut that 02 · BUILD opens with, while the stage-wrap scrolls away and 02 · BUILD comes up under
     it, so the hand-off stays on screen and no frame is an empty screen. The lens is an ellipse that
     stays inside the strip's box, so no edge or other text shows. Scrubbed over the first 45% of a
     screen after the pin; before that the scene carries no clip at all. */
  function focus() {
    var s = P.scene.getBoundingClientRect(), box = P.rt.getBoundingClientRect(), k = P.ticket.getBoundingClientRect(), c = P.st.getBoundingClientRect();
    var cx = (k.left + k.right) / 2, cy = (k.top + c.bottom) / 2;
    var ry = Math.max(20, Math.min((c.bottom - k.top) / 2 + 12, cy - box.top - 3, box.bottom - cy - 3));
    var dy = Math.min(cy - k.top, ry - 1), hw = (k.right - k.left) / 2 - 3;
    var rx = Math.round(Math.max(hw + 24, hw / Math.sqrt(1 - Math.pow(dy / ry, 2))));
    return { x: cx - s.left, y: cy - s.top, rx: rx, ry: Math.round(ry) };
  }
  var wipe = gsap.parseEase(E.wipe), ex = { p: 0 };
  function lens() {
    if (ex.p <= 0) { P.scene.style.clipPath = ''; return; }
    var f = focus(), R = Ravi.spot(P.scene, f).r, e = wipe(Math.min(1, ex.p));
    P.scene.style.clipPath = 'ellipse(' + (R + (f.rx - R) * e).toFixed(1) + 'px ' + (R + (f.ry - R) * e).toFixed(1) + 'px at ' + f.x.toFixed(1) + 'px ' + f.y.toFixed(1) + 'px)';
  }
  var xt = gsap.timeline({ defaults: { ease: 'none' },
    scrollTrigger: { trigger: P.wrap, start: function () { return p.st.end; }, end: function () { return p.st.end + Math.round(window.innerHeight * .45); }, scrub: .6, invalidateOnRefresh: true } });
  xt.to(ex, { p: 1, duration: 1, onUpdate: lens, onReverseComplete: lens }, 0);
  /* the note wipes away first, so the closing lens never cuts through a line of it. A clip, not
     opacity: the approach owns the note's opacity, and a scrolled-back rewind restores no clip */
  xt.fromTo(P.note, { clipPath: 'inset(0% 0% 0% 0%)' }, { clipPath: 'inset(0% 100% 0% 0%)', ease: E.wipe, duration: .18, immediateRender: false }, .02);
  ctx.onRefresh(lens);
  ctx.add(function () { P.scene.style.clipPath = ''; });

  /* keyboard: a beat or the skip link that gets focus once the pin is over (the scene closing or
     closed, as on Shift+Tab back from 02 · BUILD) brings the scene back: the page scrolls into the
     pin, to that beat's frame (the end frame for the skip link). It runs a frame later, after the
     browser's own scroll-into-view, which comes after focusin. */
  var fq = 0;
  ctx.on(P.scene, 'focusin', function (e) {
    var b = e.target && e.target.closest ? e.target.closest('.beat, .skip-scene') : null;
    if (!b) return;
    cancelAnimationFrame(fq);
    fq = requestAnimationFrame(function () {
      var st = p.st;
      if (!st || window.pageYOffset <= st.end + 1) return;
      var l = b.classList.contains('beat') ? b.getAttribute('data-label') : null;
      Ravi.scrollToY(l && p.tl.labels[l] != null ? st.labelToScroll(l) : st.end, true);
    });
  });
  ctx.add(function () { cancelAnimationFrame(fq); });
}

/* ================= touch ================= */
function touch(ctx) {
  var gsap = Ravi.gsap, P = parts(ctx), stage = P.stage;
  var top = cssPx('--hdr', 52) + cssPx('--bar', 36);
  [P.curB, P.curC].forEach(function (c) { P.panel.appendChild(c); });
  ctx.add(function () { [P.curB, P.curC].forEach(function (c) { stage.appendChild(c); }); });

  /* Ana's message plays on enter */
  var t1 = gsap.timeline({ scrollTrigger: { trigger: P.ana, start: 'top 80%', toggleActions: 'play none none none' } });
  t1.fromTo(P.ana, { opacity: 0 }, { opacity: 1, duration: .2 }, 0);
  t1.fromTo(P.anaAv, { scale: 0 }, { scale: 1, ease: E.pop, duration: .45 }, 0);
  t1.fromTo(P.anaMeta, { opacity: 0, y: 6 }, { opacity: 1, y: 0, ease: E.enter, duration: .35 }, .1);
  t1.fromTo(P.words, { opacity: 0, y: 4 }, { opacity: 1, y: 0, ease: E.enter, duration: .2, stagger: .02 }, .2);

  /* reception's message arrives as the panel comes up */
  var t2 = gsap.timeline({ scrollTrigger: { trigger: P.panel, start: 'top 85%', toggleActions: 'play none none none' } });
  t2.fromTo(P.recAv, { opacity: 0, scale: 0 }, { opacity: 1, scale: 1, ease: E.pop, duration: .45 }, 0);
  t2.fromTo(P.recMeta, { opacity: 0, y: 6 }, { opacity: 1, y: 0, ease: E.enter, duration: .35 }, .08);
  t2.fromTo(P.card, { opacity: 0, y: 14 }, { opacity: 1, y: 0, ease: E.rise, duration: .65 }, .12);
  t2.fromTo(P.head, { yPercent: 110, y: 0 }, { yPercent: 0, y: 0, ease: E.rise, duration: .65 }, .2);

  /* the short pin: the card holds while the plan, Bruno and Carla play */
  function need(el, extra) {
    return function () {
      var r = rel(el, P.recm), vh = P.pvp.clientHeight;
      return -Math.max(0, Math.round(r.y + r.h + (extra || 10) - vh));
    };
  }
  /* the buttons in view, and the card's header either whole or out of view. The card's bottom keeps
     the panel's bottom padding clear (600+ wide), so Bruno's name tag never reaches the caption */
  function padB() { return parseFloat(getComputedStyle(P.pvp).paddingBottom) || 0; }
  var needCard = function () { return need(P.card, Math.max(10, padB()))(); };
  var tabs = [P.recAv, P.hdrBlock].concat(P.lns);
  function atButtons() { return tabSafe(needCard(), tabs, P.card, P.recm, P.pvp.clientHeight - Math.max(0, padB() - 4)); }
  function at(el, fx, fy) {
    return {
      x: function () { var r = rel(el, P.panel); return r.x + r.w * fx; },
      y: function () { var r = rel(el, P.panel); return r.y + r.h * fy + atButtons(); }
    };
  }
  /* cursor starts: empty card space right of a short row (the buttons, the context line), never over
     the plan text or the caption */
  function startRight(after, row, fy, dx) {
    return {
      x: function () { var a = rel(after, P.panel), c = rel(P.card, P.panel); return Math.round(Math.max(c.x + 8, Math.min(a.x + a.w + dx, c.x + c.w - 76))); },
      y: function () { var r = rel(row, P.panel); return Math.round(r.y + r.h * fy + atButtons()); }
    };
  }
  /* 600+ wide (tablets, landscape phones) the panel is only as tall as its content: after the collapse it closes in
     on the outcome and its caption. fit() = where they gather, centred in the panel, and the clip that keeps them */
  var capsBox = stage.querySelector('.ak-caps');
  function tight() { return window.innerWidth >= 600; }
  function clipOf(t, b) { return tight() ? 'inset(' + t + 'px 0px ' + b + 'px 0px round 8px)' : 'inset(0px 0px 0px 0px round 0px)'; }
  function fit() {
    var Hp = P.panel.offsetHeight, vis = P.recm.offsetHeight - cutBy(P), hc = capsBox.offsetHeight, gap = 16;
    var G = vis + gap + hc, top = Math.max(0, Math.round((Hp - G) / 2));
    var y = Math.max(0, Math.min(top, P.pvp.clientHeight - vis)) - P.recm.offsetTop;
    var mTop = y + P.recm.offsetTop, capsY = Math.min(0, mTop + vis + gap - capsBox.offsetTop);
    return { y: y, capsY: capsY, ct: Math.max(0, mTop - 8), cb: Math.max(0, Math.round(Hp - (capsBox.offsetTop + capsY + hc) - 14)) };
  }
  /* phones pin the panel right under the loop bar (it fills the room); from 600 wide the panel is
     only as tall as the card and its caption, so it pins in the middle of the room under the bar */
  function pinTop() {
    var free = window.innerWidth < 600 ? 0 : window.innerHeight - top - P.panel.offsetHeight;
    return 'top ' + Math.round(top + Math.max(0, free / 2)) + 'px';
  }
  /* wc:false: the stage is an ancestor of the pinned panel, so it must never get will-change */
  var p = ctx.pin({ trigger: P.panel, start: pinTop, end: '+=130%', beats: false, snap: false, wc: false, labels: { 'in': 0, out: 1 } });
  var tl = p.tl;
  /* 0–.30 plan lines, one after another (they wrap on a phone, so they fade up); the shade grows with them */
  var each = .3 / P.lns.length, prev = P.hdrBlock;
  shadeTween(tl, P, P.hdrBlock, P.hdrBlock, 0, .001, 'none', true);
  P.lns.forEach(function (l, i) {
    var t = .01 + i * each * .92;
    tl.fromTo(l, { opacity: 0, y: 6 }, { opacity: 1, y: 0, ease: E.enter, duration: each * 1.4 }, t);
    tl.to(P.recm, { y: need(l), ease: 'none', duration: each }, t);
    shadeTween(tl, P, prev, l, t, each * .7); prev = l;
  });
  tl.fromTo(P.cx, { opacity: 0 }, { opacity: 1, ease: E.enter, duration: .02 }, .3);
  shadeTween(tl, P, prev, P.cx, .298, .012);
  tl.to(P.recm, { y: atButtons, ease: E.enter, duration: .03 }, .3);
  shadeTween(tl, P, P.cx, P.approve, .303, .015);
  tl.fromTo([P.approve, P.reject], { opacity: 0, scale: .6 }, { opacity: 1, scale: 1, ease: E.popSoft, duration: .025, stagger: .01 }, .305);
  /* captions 02 → 03 → 04 crossfade */
  tl.fromTo(P.caps[0], { opacity: 1 }, { opacity: 0, duration: .02 }, .35);
  tl.fromTo(P.caps[1], { opacity: 0, y: 6 }, { opacity: 1, y: 0, ease: E.enter, duration: .025 }, .355);
  tl.to(P.caps[1], { opacity: 0, duration: .02 }, .55);
  tl.fromTo(P.caps[2], { opacity: 0, y: 6 }, { opacity: 1, y: 0, ease: E.enter, duration: .025 }, .555);
  /* .36–.55 Bruno */
  var tB = at(P.approve, .55, .62), sB = startRight(P.reject, P.approve, .62, 90);
  tl.fromTo(P.curB, { x: sB.x, y: sB.y }, { x: tB.x, y: tB.y, ease: E.cut, duration: .08 }, .36);
  tl.fromTo(P.curB, { opacity: 0 }, { opacity: 1, duration: .02 }, .36);
  tl.add(Ravi.press(P.approve).duration(.03), .445);
  rip(tl, P.curB, .445, .04);
  shadeTween(tl, P, P.approve, null, .455, .02);
  /* when the tag wraps under the buttons (phone), Bruno steps aside, right of Reject, so his pill never
     covers it; when it sits beside Reject (tablet), he stays on Approve */
  function wrapped() { return rel(P.tagI, P.card).y > rel(P.approve, P.card).y + 4; }
  tl.to(P.curB, { x: function () { var r = rel(P.reject, P.panel); return wrapped() ? Math.min(P.panel.clientWidth - 72, r.x + r.w + 24) : tB.x(); },
    y: function () { var r = rel(P.reject, P.panel); return wrapped() ? r.y + atButtons() - 24 : tB.y(); }, ease: E.enter, duration: .04 }, .452);
  tl.fromTo(P.tagI, { opacity: 0, scale: .9 }, { opacity: 1, scale: 1, ease: E.popSoft, duration: .025 }, .46);
  tl.to(P.tagI, { keyframes: { x: [0, -6, 5, -3, 2, 0] }, ease: 'power1.out', duration: .05 }, .462);
  /* .55–.85 Carla, then the collapse */
  tl.to(P.curB, { y: '-=10', opacity: .4, ease: E.enter, duration: .04 }, .56);
  tl.to(P.tagI, { opacity: 0, ease: E.enter, duration: .03 }, .56);
  /* Carla starts at the right end of the card: with her name pill on the header row when that row is
     in view (on a phone Bruno has stepped aside right of the buttons), else with her arrow on the
     context line and the pill on the empty end of the button row. Never over the plan lines. */
  var tC = at(P.approve, .3, .5), sC = {
    x: function () { var c = rel(P.card, P.panel); return Math.round(c.x + c.w - 76); },
    y: function () {
      var f = atButtons(), h = rel(P.hdrBlock, P.panel), k = rel(P.cx, P.panel);
      return Math.round(h.y + f >= 4 ? Math.max(0, h.y + h.h * .5 + f - 40) : k.y + k.h * .5 + f);
    }
  };
  tl.fromTo(P.curC, { x: sC.x, y: sC.y }, { x: tC.x, y: tC.y, ease: E.cut, duration: .08 }, .565);
  tl.fromTo(P.curC, { opacity: 0 }, { opacity: 1, duration: .02 }, .565);
  tl.add(Ravi.press(P.approve).duration(.03), .65);
  rip(tl, P.curC, .65, .05);
  tl.add(Ravi.wipeOut(P.acts, 'top', .035), .67);
  tl.to([P.hdrBlock, P.plan, P.cx], { opacity: 0, ease: E.enter, duration: .03 }, .675);
  collapse(tl, P, .68, .045);
  /* the outcome settles in the middle of the panel */
  var finNeed = need(P.fin, 30);
  tl.to(P.recm, { y: function () {
    if (tight()) return fit().y;
    var vis = P.recm.offsetHeight - cutBy(P), vh = P.pvp.clientHeight;
    return vis < vh ? Math.round((vh - vis) / 2) : finNeed();
  }, ease: E.cut, duration: .045 }, .68);
  /* 600+ wide, where the panel is a white card on the dark page: the outcome and its caption gather in the middle
     and the panel closes in around them, so no empty white is left once the card has collapsed */
  tl.to(capsBox, { y: function () { return tight() ? fit().capsY : 0; }, ease: E.cut, duration: .045 }, .68);
  tl.fromTo(P.panel, { clipPath: function () { return clipOf(0, 0); } },
    { clipPath: function () { var f = fit(); return clipOf(f.ct, f.cb); }, ease: E.cut, duration: .045, immediateRender: false }, .68);
  /* the pin's revert restores the panel's style as it was at the last refresh: leave no clip or offset behind */
  ctx.add(function () { P.panel.style.clipPath = ''; capsBox.style.transform = ''; });
  tl.fromTo(P.finIn, { yPercent: 110, y: 0, opacity: 1 }, { yPercent: 0, y: 0, opacity: 1, ease: E.rise, duration: .04, stagger: .012 }, .7);
  tl.to([P.curB, P.curC], { opacity: 0, ease: E.enter, duration: .025 }, .685);
  tl.fromTo(P.tagOk, { opacity: 0, scale: .6 }, { opacity: 1, scale: 1, ease: E.pop, duration: .035 }, .74);
  /* .78–1 hold */

  /* after the pin: the handoff plays once, in 1.4 s, when the strip reaches 80% of the viewport.
     The ticket pops out of the reception chip and rides the vertical wire down to dev. */
  geoV(P);
  ctx.onRefresh(function () { geoV(P); });
  ctx.add(function () { clearGeo(P); });
  var tkY = function () { return Math.round(rel(P.cRec, P.dia).y - rel(P.ticket, P.dia).y); };
  var t3 = gsap.timeline({ scrollTrigger: { trigger: P.rt, start: 'top 80%', toggleActions: 'play none none none' } });
  t3.fromTo(P.cRec, { '--lit': 0 }, { '--lit': 1, ease: E.enter, duration: .25 }, 0);
  t3.fromTo(P.ticket, { opacity: 0, y: tkY }, { opacity: 1, y: tkY, duration: .06 }, .1);
  t3.fromTo(P.tk, { scale: .6 }, { scale: 1, ease: E.pop, duration: .3 }, .1);
  t3.to(P.ticket, { y: 0, ease: 'power2.inOut', duration: .45 }, .35);
  t3.fromTo(P.pk, { opacity: 0 }, { opacity: 1, duration: .06 }, .35);
  t3.add(Ravi.packet(P.pk, P.wire, .45, 'power2.inOut'), .35);
  t3.fromTo(P.wire, { strokeDashoffset: 1 }, { strokeDashoffset: 0, ease: 'power2.inOut', duration: .45, autoRound: false }, .35);
  t3.to(P.pk, { opacity: 0, duration: .08 }, .8);
  t3.fromTo(P.cDev, { '--lit': 0 }, { '--lit': 1, ease: E.enter, duration: .3 }, .8);
  t3.to(P.cDev, { keyframes: { scale: [1, 1.06, 1] }, ease: 'none', duration: .3 }, .8);
  t3.fromTo(P.st, { clipPath: 'inset(0 100% 0 0)' }, { clipPath: 'inset(0 0% 0 0)', ease: 'steps(' + P.st.textContent.length + ')', duration: .25 }, .86);
  t3.add(Ravi.draw(P.retMp, .32), 1.0);
  t3.fromTo(P.retL, { opacity: 0, y: 4 }, { opacity: 1, y: 0, ease: E.enter, duration: .2 }, 1.1);
  t3.fromTo(P.retH, { opacity: 0 }, { opacity: 1, duration: .08 }, 1.32);
}

Ravi.section('ask', { desk: desk, touch: touch });
} catch (err) { console.error('[section ask]', err); }
})();

/* ---- section build (02-build.js) ---- */
(function(){
'use strict';
try {
/* 02 · #build (pin 2): first the table, then the page.
   desk (pin 200%): dev's status card stays put on top; under it the table assembles, the rules type (with the
     NOBODY ghost), the two-way split sends a packet each way, the page draws itself (the public switch bounces),
     dev hands the news to reception, and the scene holds on reception's reply with its link lit.
   touch (no pin): each block plays once on enter; the status card is a sticky bar that updates as they play
     (phone: one compact row; the ticket lands beside the avatar before the name and the pill come in).
   frames: on-enter reveals. reduce / no JS: the authored HTML is final (frames + split). */

var G = function () { return Ravi.gsap; };
var E = Ravi.E, D = Ravi.D;
var STEPS = ['reading the plan', 'building the table', 'setting the rules', 'drawing the page', 'done'];

/* layout offset of el inside root (ignores transforms); falls back to rects if root is not an offset ancestor */
function off(el, root) {
  var x = 0, y = 0, n = el;
  while (n && n !== root) { x += n.offsetLeft; y += n.offsetTop; n = n.offsetParent; }
  if (n !== root) {
    var a = el.getBoundingClientRect(), b = root.getBoundingClientRect();
    return { x: a.left - b.left, y: a.top - b.top, w: el.offsetWidth, h: el.offsetHeight };
  }
  return { x: x, y: y, w: el.offsetWidth, h: el.offsetHeight };
}
/* centre of el relative to root, from rects (for elements placed with CSS transforms) */
function mid(el, root) {
  var a = el.getBoundingClientRect(), b = root.getBoundingClientRect();
  return { x: a.left - b.left + a.width / 2, y: a.top - b.top + a.height / 2 };
}
/* right end of the text actually set in el (its last glyph on the longest line), in root's untransformed px */
function textRight(el, root) {
  if (!el) return 0;
  var r = document.createRange(); r.selectNodeContents(el);
  var rs = r.getClientRects(), cb = root.getBoundingClientRect(), k = cb.width / (root.offsetWidth || cb.width) || 1, m = 0;
  for (var i = 0; i < rs.length; i++) m = Math.max(m, (rs[i].right - cb.left) / k);
  return m;
}
/* the pointer's click ring, hidden until the click (Ravi.ripple shows its small starting ring as soon as it is built)
   and scrub-safe: scrolling back before the click hides it again */
function ring(tl, cur, at, dur) {
  var r = cur.querySelector('.cur-ripple');
  tl.fromTo(r, { scale: .2, opacity: 0 }, { scale: .2, opacity: 1, duration: dur * .05, immediateRender: false }, at);
  tl.to(r, { scale: 1.6, opacity: 0, ease: E.enter, duration: dur * .95 }, at + dur * .05);
}
function refill(arr, pts) { arr.length = 0; Array.prototype.push.apply(arr, pts); }
function sample(path, n) { try { return Ravi.samplePath(path, n || 48); } catch (e) { return []; } }
function r1(v) { return Math.round(v * 10) / 10; }

/* status text: the old phrase lifts out and fades, then the new one rises in. Whole phrases only, so a frame
   frozen mid-scrub never shows a half-made string; pure in p, so scrubbing either way is exact */
function roll(el, a, b, p) {
  var t = b, y = 0, o = 1, q;
  if (p <= 0) t = a;
  else if (p < .5) { q = p / .5; q = q * q * (3 - 2 * q); t = a; y = -6 * q; o = 1 - q; }
  else if (p < 1) { q = (p - .5) / .5; q = q * q * (3 - 2 * q); y = 6 * (1 - q); o = q; }
  if (el.textContent !== t) el.textContent = t;
  el.style.transform = y ? 'translateY(' + r1(y) + 'px)' : '';
  el.style.opacity = o < 1 ? String(Math.round(o * 100) / 100) : '';
}
/* touch: the pill only ever moves forward (a fast scroll can finish a later block first); time-based, .35 s */
function stepper(P) {
  P.k = 0;
  return function (k) {
    if (k <= P.k) return;
    var a = STEPS[P.k], b = STEPS[k], o = { p: 0 };
    P.k = k;
    if (P.rollTw) P.rollTw.kill();
    function paint() { roll(P.stT, a, b, o.p); P.st.setAttribute('data-st', k === STEPS.length - 1 && o.p >= .5 ? 'done' : 'work'); }
    P.rollTw = G().to(o, { p: 1, duration: .35, ease: 'none', onStart: paint, onUpdate: paint, onComplete: paint });
  };
}
/* desk: the status pill as a function of the pin timeline's time (no callbacks to miss on refresh) */
function statusAt(P, sched) {
  return function (t) {
    var i = -1, k, p = 1;
    for (k = 0; k < sched.length; k++) if (t >= sched[k][0]) i = k;
    if (i >= 0) { p = Math.max(0, Math.min(1, (t - sched[i][0]) / sched[i][1])); roll(P.stT, STEPS[i], STEPS[i + 1], p); }
    else roll(P.stT, STEPS[0], STEPS[0], 1);
    var st = (i === sched.length - 1 && p >= .5) ? 'done' : 'work';
    if (P.st.getAttribute('data-st') !== st) P.st.setAttribute('data-st', st);
  };
}

/* every piece of the stage, plus the geometry the wires need */
function parts(ctx) {
  var stage = ctx.$('.stage');
  var q = function (s) { return stage.querySelector(s); };
  var qa = function (s) { return Array.prototype.slice.call(stage.querySelectorAll(s)); };
  var P = {
    stage: stage, board: q('.bd-board'), agent: q('.bd-agent'), av: q('.bd-av'), nm: q('.bd-agent .bd-nm'), tk: q('.bd-tk'),
    st: q('.bd-st'), stT: q('.bd-st-t'), cks: qa('.bd-ck path'), ckSvg: qa('.bd-ck'), prog: q('.bd-prog i'),
    cards: q('.bd-cards'), slots: qa('.bd-slot'), base: q('.bd-base'), ths: qa('.bd-th'), chips: qa('.bd-stcs .stc'), rows: q('.bd-rows'),
    byB: q('.bd-th--by > b'), supB: q('.bd-th--sup > b'), uls: qa('.bd-th--by, .bd-th--sup'),
    vcard: q('.bd-vcard'), vrs: qa('.bd-vr'), auto: q('.bd-vr--auto'), noRow: q('.bd-vr--no'), vfoot: q('.bd-vfoot'),
    rlns: qa('.bd-rln'), ghostAt: q('.bd-ghost-at'), ghost: q('.bd-ghost'), strike: q('.bd-strike path'),
    split: q('.bd-split'), splitIn: q('.bd-split-in'), sl: q('.bd-sl'), sr: q('.bd-sr'), seam: q('.bd-seam'),
    wR: q('.bd-seamw--r'), wW: q('.bd-seamw--w'), pkR: q('.bd-pk-r'), pkW: q('.bd-pk-w'),
    pwR: q('.bd-pillwrap--r'), pwW: q('.bd-pillwrap--w'), pillR: q('.bd-pillwrap--r .bd-pill'), pillW: q('.bd-pill--w'),
    br: q('.bd-br'), pg: q('.bd-pg'), cur: q('.bd-cur'), sw: q('.bd-sw'), urlT: q('.bd-urlt'), priv: q('.rb-private'), mark: q('.bd-ph .rb-mark'), titleIn: q('.bd-ph .rb-title .in'), sub: q('.bd-ph .rb-sub'),
    pubsw: q('.bd-pubsw'), swOn: q('.bd-sw-on'), swK: q('.bd-sw-k'), ptag: q('.bd-ptag'), newBtn: q('.bd-new'), cols: qa('.bd-col'),
    done: q('.bd-done'), hrow: q('.bd-hrow'), cDev: q('.bd-c-dev'), cRec: q('.bd-c-rec'), wAns: q('.bd-w-ans'),
    handAt: q('.bd-hand-at'), hand: q('.bd-hand'), pkA: q('.bd-pk-ans'), sk: q('.bd-sk'), ri: q('.bd-ri'), hl: qa('.bd-url-hl'), url: q('.bd-url')
  };
  P.ptsR = []; P.ptsW = []; P.ptsA = [];
  P.authored = { text: P.stT.textContent, st: P.st.getAttribute('data-st') };

  /* FILLED IN FOR YOU → the Requested by and Supervisor headers; horizontal table (desk) or one row per column (touch) */
  P.rulesWires = function () {
    var C = P.cards, wideTable = P.ths[1].offsetTop === P.ths[0].offsetTop, vr = off(P.auto, C), vc = off(P.vcard, C);
    /* the lane up the card's right margin: right of the longest text in the rows the wires pass (narrow desks leave
       only the card's padding there), Requested by on the left lane and Supervisor on the right so they never cross */
    var lane = vc.x + vc.w - 22, gap = 10;
    if (wideTable) {
      var tr = 0;
      P.vrs.slice(0, 3).forEach(function (v) { tr = Math.max(tr, textRight(v.querySelector('.bd-vd'), C)); });
      if (tr + 8 + gap > lane) { lane = Math.min(vc.x + vc.w - 5, tr + 8 + gap); gap = Math.max(4, Math.min(10, lane - tr - 8)); }
    }
    [P.byB, P.supB].forEach(function (b, i) {
      var th = off(b.parentNode, C), d;
      if (wideTable) {
        /* from the row's right end, up the card's empty right margin, into the column just under its hint */
        var x1 = lane - gap + i * gap, y1 = vr.y + vr.h / 2, x2 = th.x + th.w / 2, y2 = th.y + th.h + (P.rows && P.rows.offsetHeight ? 14 : -4);
        if (P.cut) y2 = off(b, C).y + b.offsetHeight + 3;
        d = 'M' + r1(x1) + ' ' + r1(y1) + ' C' + r1(x1) + ' ' + r1(y1 - (y1 - y2) * .62) + ' ' + r1(x2) + ' ' + r1(y2 + (y1 - y2) * .42) + ' ' + r1(x2) + ' ' + r1(y2);
      } else {
        /* one row per column: bow out past the cards' right edge */
        var xa = vr.x + vr.w, ya = vr.y + vr.h / 2, xb = th.x + th.w, yb = th.y + th.h / 2, bow = 14 + i * 5;
        d = 'M' + r1(xa) + ' ' + r1(ya) + ' C' + r1(xa + bow) + ' ' + r1(ya) + ' ' + r1(xb + bow) + ' ' + r1(yb) + ' ' + r1(xb) + ' ' + r1(yb);
      }
      P.rlns[i].setAttribute('d', d);
    });
  };
  /* short desk screens: when the table and the rules cannot both fit, the rules card sits over the table's hint
     row and the table folds to its header strip as the rules come in (P.cut = px folded away, 0 = no fold) */
  P.cut = 0;
  P.fold = function () {
    var s2 = P.slots[1];
    P.cut = 0; P.cards.classList.remove('bd-cards--fold'); s2.style.marginTop = '';
    if (!P.deskFold) return;
    var area = P.cards.parentNode.clientHeight;
    if (P.cards.offsetHeight <= area + 1) return;
    var c = off(P.byB, P.cards).y - off(P.base, P.cards).y + P.byB.offsetHeight;
    P.cut = Math.max(0, Math.round(P.base.offsetHeight - c));
    s2.style.marginTop = (-P.cut) + 'px';
    P.cards.classList.add('bd-cards--fold');
  };
  /* the NOBODY ghost: from the row toward the Requested by header */
  P.ghostFrom = function () {
    var a = off(P.noRow.querySelector('.bd-vd'), P.cards), c = P.cards.clientWidth, gw = P.ghost.offsetWidth;
    /* just after the row's words when they leave room, otherwise on the empty line under them (the footnote comes later) */
    if (a.x + a.w + 14 + gw <= c - 12) return { x: a.x + a.w + 14, y: a.y + a.h / 2 - 13 };
    return { x: Math.max(0, Math.min(a.x, c - gw - 12)), y: a.y + a.h + 8 };
  };
  P.ghostTo = function () {
    var b = off(P.byB, P.cards), f = P.ghostFrom();
    var wideTable = P.ths[1].offsetTop === P.ths[0].offsetTop;
    var t = wideTable ? { x: b.x, y: b.y + b.h + 6 } : { x: b.x + 12, y: b.y + b.h - 6 };
    /* it heads 60% of the way to the column; on touch, where the column has scrolled away, only a short lunge */
    var dx = (t.x - f.x) * .6, dy = (t.y - f.y) * .6, len = Math.sqrt(dx * dx + dy * dy), k = !P.deskFold && len > 140 ? 140 / len : 1;
    return { x: f.x + dx * k, y: f.y + dy * k };
  };
  /* the seam wires: one through each pill, across the seam (vertical seam → horizontal wires, and the other way round) */
  P.seamWires = function () {
    var R = P.splitIn, W = R.clientWidth, H = R.clientHeight, vertical = P.seam.offsetHeight > P.seam.offsetWidth;
    var a = mid(P.pwR, R), b = mid(P.pwW, R), dR, dW;
    if (vertical) {
      var L = Math.min(W * .3, 230), cx = W / 2;
      dR = 'M' + r1(cx - L) + ' ' + r1(a.y) + ' L' + r1(cx + L) + ' ' + r1(a.y);
      dW = 'M' + r1(cx + L) + ' ' + r1(b.y) + ' L' + r1(cx - L) + ' ' + r1(b.y);
    } else {
      /* stacked: the wires stay in the gap between the two headlines and never cross the letters */
      var cy = H / 2, hl = off(P.sl.querySelector('.bd-sh'), R), hr = off(P.sr.querySelector('.bd-sh'), R);
      var M = Math.max(24, Math.min(120, cy - (hl.y + hl.h) - 12, hr.y - 12 - cy));
      dR = 'M' + r1(a.x) + ' ' + r1(cy - M) + ' L' + r1(a.x) + ' ' + r1(cy + M);
      dW = 'M' + r1(b.x) + ' ' + r1(cy + M) + ' L' + r1(b.x) + ' ' + r1(cy - M);
    }
    P.wR.setAttribute('d', dR); P.wW.setAttribute('d', dW);
    refill(P.ptsR, sample(P.wR)); refill(P.ptsW, sample(P.wW));
  };
  /* dev → reception: an arc over the chips (same row) or a bend down to reception (phone, stacked) */
  P.handWire = function () {
    var a = off(P.cDev, P.hrow), b = off(P.cRec, P.hrow), d;
    if (Math.abs(a.y - b.y) < 8) {
      var s = [a.x + a.w / 2, a.y], e = [b.x + b.w / 2, b.y], h = Math.min(92, a.y - 4);
      d = 'M' + r1(s[0]) + ' ' + r1(s[1]) + ' C' + r1(s[0]) + ' ' + r1(s[1] - h) + ' ' + r1(e[0]) + ' ' + r1(e[1] - h) + ' ' + r1(e[0]) + ' ' + r1(e[1]);
    } else {
      var s2 = [a.x + a.w, a.y + a.h / 2], e2 = [b.x + b.w / 2, b.y];
      d = 'M' + r1(s2[0]) + ' ' + r1(s2[1]) + ' C' + r1(s2[0] + (e2[0] - s2[0]) * .85) + ' ' + r1(s2[1]) + ' ' + r1(e2[0]) + ' ' + r1(e2[1] - (e2[1] - s2[1]) * .6) + ' ' + r1(e2[0]) + ' ' + r1(e2[1]);
    }
    P.wAns.setAttribute('d', d);
    refill(P.ptsA, sample(P.wAns, 64));
  };
  P.measure = function () {
    try { P.fold(); } catch (e) {}
    try { P.rulesWires(); } catch (e) {}
    try { P.seamWires(); } catch (e) {}
    try { P.handWire(); } catch (e) {}
  };
  /* the pointer that tries "Make it public": it comes up from below the switch (from the side with room) and its
     tip lands on the switch's knob; page coordinates from layout offsets, so the hold's slow push does not skew them */
  P.curAt = function (k) {
    return function () {
      var s = off(P.sw, P.pg), W = P.pg.clientWidth, H = P.pg.clientHeight, tip = { x: s.x + 11, y: s.y + 11 };
      if (k === 'x0') return Math.max(12, Math.min(W - 40, tip.x + (tip.x > W / 2 ? -84 : 84)));
      if (k === 'y0') return Math.min(H - 44, tip.y + 104);
      if (k === 'x1') return tip.x - 18;
      if (k === 'y1') return tip.y + 26;
      return tip[k];
    };
  };
  /* the done packet with its tag riding above it; the tag is kept inside the row */
  P.ride = function (dur, ease) {
    var gsap = G(), o = { t: 0 };
    var dx = gsap.quickSetter(P.pkA, 'x', 'px'), dy = gsap.quickSetter(P.pkA, 'y', 'px');
    var hx = gsap.quickSetter(P.handAt, 'x', 'px'), hy = gsap.quickSetter(P.handAt, 'y', 'px'), tx = gsap.quickSetter(P.hand, 'x', 'px');
    function place() {
      var Q = P.ptsA; if (Q.length < 2) return;
      var f = Math.max(0, Math.min(1, o.t)) * (Q.length - 1), i = Math.min(f | 0, Q.length - 2), k = f - i;
      var x = Q[i].x + (Q[i + 1].x - Q[i].x) * k, y = Q[i].y + (Q[i + 1].y - Q[i].y) * k;
      var hw = P.hand.offsetWidth / 2, W = P.hrow.clientWidth;
      dx(x); dy(y); hx(x); hy(y);
      tx(Math.max(0, hw - x) + Math.min(0, W - x - hw));
    }
    return gsap.fromTo(o, { t: 0 }, { t: 1, duration: dur, ease: ease || 'power1.inOut', immediateRender: false, onStart: place, onUpdate: place, onComplete: place, onReverseComplete: place });
  };
  return P;
}

/* the opening state every motion mode starts from, and its cleanup */
function prime(ctx, P) {
  var gsap = G();
  P.stT.textContent = STEPS[0];
  P.st.setAttribute('data-st', 'work');
  gsap.set(P.hand, { xPercent: -50, x: 0 });
  gsap.set(P.wAns, { opacity: .85 });
  P.measure();
  /* the status dot breathes only while the card is on screen */
  var vis = Ravi.ST.create({ trigger: P.stage, start: 'top bottom', end: 'bottom top', onToggle: function (s) { P.agent.classList.toggle('is-vis', s.isActive); } });
  function remeasure() { P.measure(); }
  Ravi.ST.addEventListener('refreshInit', remeasure);
  ctx.onRefresh(remeasure);
  ctx.add(function () {
    Ravi.ST.removeEventListener('refreshInit', remeasure);
    vis.kill();
    P.agent.classList.remove('is-vis');
    if (P.rollTw) P.rollTw.kill();
    P.stT.style.transform = ''; P.stT.style.opacity = '';
    P.stT.textContent = P.authored.text;
    P.st.setAttribute('data-st', P.authored.st);
    P.deskFold = false; P.cut = 0; P.cards.classList.remove('bd-cards--fold'); P.slots[1].style.marginTop = '';
  });
}

/* ---------- desk: one 200% pin ---------- */
function desk(ctx) {
  var gsap = G(), P = parts(ctx);
  /* labels sit where each beat's action has finished (as #ask does), so a snap or a beat click rests on a
     complete frame, never on an empty slot: the table with check 1, the rules after the NOBODY refusal,
     the split with both pills, the page with "done", the #office reply with its link lit */
  var L = { table: .228, rules: .41, split: .535, page: .79, done: .93, out: .95 };

  ctx.iris({ at: function (s) { return s.querySelector('.bd-av'); } });
  /* the core's dense check compares scrollHeight to clientHeight, which misses beats that run into the
     copy column's 72px bottom padding (kept clear for the loop ring); measure that case too */
  var copy = ctx.$('.scene-copy'), beatsEl = ctx.$('.beats');
  function denseFix() {
    if (!copy || !beatsEl || !ctx.wide || copy.classList.contains('scene-copy--dense')) return;
    var last = beatsEl.lastElementChild; if (!last) return;
    var cb = copy.getBoundingClientRect(), pb = parseFloat(getComputedStyle(copy).paddingBottom) || 0;
    if (last.getBoundingClientRect().bottom > cb.bottom - pb + 1) copy.classList.add('scene-copy--dense');
  }
  P.deskFold = true;
  prime(ctx, P);
  /* each label is moved down to a whole pixel of scroll (under 1px earlier), so a snap or a beat click that the
     browser rounds to a whole pixel never stops a fraction short of it and leaves the caption unlit */
  function alignLabels() {
    if (!Pn) return;
    var st = Pn.st, len = st.end - st.start;
    if (!(len > 0)) return;
    Object.keys(L).forEach(function (k) { Pn.tl.addLabel(k, (Math.floor(st.start + L[k] * len) - st.start) / len); });
  }
  var Pn = ctx.pin({ end: '+=200%', labels: L, onRefresh: function () { denseFix(); alignLabels(); } });
  var tl = Pn.tl;

  /* starting picture: dev's card (checks open, bar empty) over two dashed slots */
  gsap.set(P.cks, { strokeDashoffset: 1 });
  gsap.set(P.prog, { scaleX: 0 });
  gsap.set(P.uls, { '--ul': 0 });
  gsap.set(P.rlns, { strokeDashoffset: 1 });
  gsap.set([P.split, P.br, P.done], { opacity: 0 });
  gsap.set(P.cRec, { '--lit': 0 });

  /* 0–.05: the card rises, the avatar pops, the #ask ticket lands on the card's top edge and slides into place */
  tl.fromTo(P.agent, { y: 26 }, { y: 0, ease: E.rise, duration: .045 }, 0);
  tl.fromTo(P.av, { scale: .55 }, { scale: 1, ease: E.pop, duration: .028 }, .004);
  var edge = function () { return -(P.tk.offsetTop + P.tk.offsetHeight / 2); };
  tl.fromTo(P.tk, { y: function () { return edge() - 40; }, opacity: 0, rotation: -4 }, { y: edge, opacity: 1, rotation: 0, ease: E.enter, duration: .018 }, .01);
  tl.to(P.tk, { y: 0, ease: E.cut, duration: .02 }, .03);

  /* .06–.22: the table */
  tl.fromTo(P.base, { clipPath: 'inset(-60px 100% -60px -60px)' }, { clipPath: 'inset(-60px -60px -60px -60px)', ease: E.wipe, duration: .03 }, .062);
  P.ths.forEach(function (th, i) {
    var t = .076 + i * .015, h = th.querySelector('.bd-hint');
    tl.fromTo(th, { clipPath: 'inset(0% 100% 0% 0%)' }, { clipPath: 'inset(0% 0% 0% 0%)', ease: E.wipe, duration: .02 }, t);
    if (h) tl.fromTo(h, { opacity: 0, y: 6 }, { opacity: 1, y: 0, ease: E.enter, duration: .014 }, t + .005);
  });
  tl.fromTo(P.chips, { scale: .4, opacity: 0 }, { scale: 1, opacity: 1, ease: E.pop, duration: .012, stagger: .005 }, .076 + 3 * .015 + .008);
  if (P.rows) tl.fromTo(P.rows, { clipPath: 'inset(0% 0% 100% 0%)' }, { clipPath: 'inset(0% 0% 0% 0%)', ease: E.wipe, duration: .02 }, .182);
  tl.add(Ravi.draw(P.cks[0], .015), .21);
  tl.fromTo(P.ckSvg[0], { scale: 1 }, { keyframes: { scale: [1, 1.3, 1] }, duration: .014, ease: 'none', immediateRender: false }, .21);
  tl.to(P.prog, { scaleX: 1 / 3, ease: E.wipe, duration: .02 }, .21);

  /* .24–.40: the rules (short screens: the table first folds to its header strip, see P.fold) */
  var full = 'inset(-60px -60px -60px -60px round 0px 0px 10px 10px)';
  tl.fromTo(P.base, { clipPath: full }, { clipPath: function () { return P.cut ? 'inset(-60px 0px ' + P.cut + 'px 0px round 0px 0px 10px 10px)' : full; },
    ease: E.cut, duration: .01, immediateRender: false }, .231);
  tl.fromTo(P.vcard, { y: 26, opacity: 0 }, { y: 0, opacity: 1, ease: E.rise, duration: .024 }, .241);
  P.vrs.forEach(function (vr, i) {
    var t = .255 + i * .017;
    tl.fromTo(vr.querySelector('.bd-lk'), { scale: 0, opacity: 0 }, { scale: 1, opacity: 1, ease: E.popSoft, duration: .008 }, t);
    tl.add(Ravi.typeLine(vr.querySelector('.bd-vk')).duration(.006), t + .002);
    tl.add(Ravi.typeLine(vr.querySelector('.bd-vd')).duration(.009), t + .007);
  });
  /* FILLED IN FOR YOU is done (.305): two teal lines run to the headers it fills, which get an underline */
  tl.fromTo(P.auto, { '--hi': 0 }, { '--hi': 1, ease: E.enter, duration: .008 }, .3);
  tl.add(Ravi.draw(P.rlns[0], .014), .305);
  tl.add(Ravi.draw(P.rlns[1], .014), .309);
  tl.to(P.uls, { '--ul': 1, ease: E.wipe, duration: .012, stagger: .004 }, .316);
  /* .34: the NOBODY ghost tries to file in Carla's name, stops short, snaps back and is struck through */
  var gf = function (k) { return function () { return P.ghostFrom()[k]; }; }, gt = function (k) { return function () { return P.ghostTo()[k]; }; };
  tl.fromTo(P.ghostAt, { x: gf('x'), y: gf('y'), opacity: 0, scale: .85 }, { x: gf('x'), y: gf('y'), opacity: 1, scale: 1, ease: E.pop, duration: .006, immediateRender: false }, .338);
  tl.to(P.ghostAt, { x: gt('x'), y: gt('y'), ease: E.cut, duration: .012 }, .344);
  tl.to(P.ghostAt, { x: gf('x'), y: gf('y'), ease: E.refuse, duration: .015 }, .356);
  tl.fromTo(P.ghost, { x: 0 }, { keyframes: { x: [0, -4, 3, -2, 0] }, duration: .012, ease: 'none', immediateRender: false }, .357);
  tl.add(Ravi.draw(P.strike, .008), .36);
  tl.to(P.ghostAt, { opacity: 0, ease: E.exit, duration: .006 }, .374);
  tl.fromTo(P.vfoot, { opacity: 0, y: 6 }, { opacity: 1, y: 0, ease: E.enter, duration: .012 }, .378);
  tl.add(Ravi.draw(P.cks[1], .015), .39);
  tl.fromTo(P.ckSvg[1], { scale: 1 }, { keyframes: { scale: [1, 1.3, 1] }, duration: .014, ease: 'none', immediateRender: false }, .39);
  tl.to(P.prog, { scaleX: 2 / 3, ease: E.wipe, duration: .02 }, .39);
  Ravi.hold(tl, P.cards, .372, .42);

  /* .42–.54: the cards leave; the split; a packet each way across the seam */
  tl.to(P.cards, { opacity: 0, y: -16, ease: E.exit, duration: .014 }, .42);
  tl.fromTo(P.split, { opacity: 0 }, { opacity: 1, ease: E.enter, duration: .008 }, .424);
  tl.fromTo(P.seam, { scale: 0 }, { scale: 1, ease: E.wipe, duration: .016 }, .426);
  var seamIn = function (el) { return mid(P.seam, el); };
  Ravi.irisIn(tl, P.sr, seamIn, .432, .03);
  tl.fromTo(P.sl.querySelectorAll('.in'), { yPercent: 110, y: 0 }, { yPercent: 0, y: 0, ease: E.rise, duration: .02, stagger: .006 }, .436);
  tl.fromTo(P.sr.querySelectorAll('.in'), { yPercent: 110, y: 0 }, { yPercent: 0, y: 0, ease: E.rise, duration: .02, stagger: .006 }, .448);
  tl.add(Ravi.draw(P.wR, .01), .454);
  tl.add(Ravi.draw(P.wW, .01), .458);
  tl.fromTo(P.pillR, { scale: .4, opacity: 0 }, { scale: 1, opacity: 1, ease: E.popHard, duration: .012 }, .474);
  tl.fromTo(P.pillW, { scale: .4, opacity: 0 }, { scale: 1, opacity: 1, ease: E.popHard, duration: .012 }, .514);
  tl.fromTo(P.pkR, { opacity: 0 }, { opacity: 1, duration: .003, immediateRender: false }, .46);
  tl.add(Ravi.packet(P.pkR, P.ptsR, .03, 'power1.inOut'), .46);
  tl.to(P.pkR, { opacity: 0, duration: .004 }, .489);
  tl.fromTo(P.pkW, { opacity: 0 }, { opacity: 1, duration: .003, immediateRender: false }, .50);
  tl.add(Ravi.packet(P.pkW, P.ptsW, .03, 'power1.inOut'), .50);
  tl.to(P.pkW, { opacity: 0, duration: .004 }, .529);

  /* .56–.80: the page draws itself, out of the seam */
  tl.to(P.split, { opacity: 0, ease: E.exit, duration: .01 }, .546);
  tl.fromTo(P.br, { opacity: 0 }, { opacity: 1, duration: .002, immediateRender: false }, .556);
  Ravi.irisIn(tl, P.br, seamIn, .556, .04);
  tl.add(Ravi.typeLine(P.urlT).duration(.03), .566);
  tl.fromTo(P.priv, { scale: .4, opacity: 0 }, { scale: 1, opacity: 1, ease: E.popHard, duration: .012 }, .6);
  tl.fromTo(P.mark, { scale: .5, opacity: 0 }, { scale: 1, opacity: 1, ease: E.pop, duration: .01 }, .603);
  tl.fromTo(P.titleIn, { yPercent: 110, y: 0 }, { yPercent: 0, y: 0, ease: E.rise, duration: .02 }, .607);
  tl.fromTo(P.sub, { opacity: 0, y: 6 }, { opacity: 1, y: 0, ease: E.enter, duration: .012 }, .615);
  tl.fromTo(P.pubsw, { opacity: 0, y: 6 }, { opacity: 1, y: 0, ease: E.enter, duration: .012 }, .62);
  P.cols.forEach(function (c, i) {
    tl.fromTo(c, { clipPath: 'inset(0% 100% 0% 0%)' }, { clipPath: 'inset(0% 0% 0% 0%)', ease: E.wipe, duration: .016 }, .626 + i * .01);
  });
  tl.fromTo(P.newBtn, { scale: .6, opacity: 0 }, { scale: 1, opacity: 1, ease: E.pop, duration: .012 }, .656);
  /* .68: someone tries to make it public: a pointer presses the switch, which slides on, snaps back and shakes;
     the pointer drifts off and the sand tag pops as the answer */
  var ca = P.curAt;
  tl.fromTo(P.cur, { x: ca('x0'), y: ca('y0'), opacity: 0 }, { x: ca('x0'), y: ca('y0'), opacity: 1, duration: .004, immediateRender: false }, .661);
  tl.to(P.cur, { x: ca('x'), y: ca('y'), ease: E.cut, duration: .015 }, .664);
  ring(tl, P.cur, .679, .012);
  tl.to(P.cur, { x: ca('x1'), y: ca('y1'), opacity: 0, ease: E.exit, duration: .009 }, .691);
  tl.to(P.swK, { x: 14, ease: E.cut, duration: .01 }, .68);
  tl.to(P.swOn, { opacity: 1, duration: .006, ease: E.enter }, .68);
  tl.to(P.swK, { x: 0, ease: E.refuse, duration: .015 }, .69);
  tl.to(P.swOn, { opacity: 0, duration: .006, ease: E.exit }, .69);
  tl.fromTo(P.pubsw, { x: 0 }, { keyframes: { x: [0, -4, 3, -2, 0] }, duration: .012, ease: 'none', immediateRender: false }, .69);
  tl.fromTo(P.ptag, { scale: .7, opacity: 0 }, { scale: 1, opacity: 1, ease: E.pop, duration: .012 }, .70);
  Ravi.hold(tl, P.br, .712, .796);
  tl.add(Ravi.draw(P.cks[2], .015), .76);
  tl.fromTo(P.ckSvg[2], { scale: 1 }, { keyframes: { scale: [1, 1.3, 1] }, duration: .014, ease: 'none', immediateRender: false }, .76);
  tl.to(P.prog, { scaleX: 1, ease: E.wipe, duration: .02 }, .76);
  tl.fromTo(P.st, { scale: 1 }, { keyframes: { scale: [1, 1.08, 1] }, duration: .014, ease: 'none', immediateRender: false }, .776);

  /* .82–.92: dev tells reception; the reply appears in #office; the link lights up */
  tl.to(P.br, { opacity: 0, y: -14, ease: E.exit, duration: .012 }, .802);
  tl.fromTo(P.done, { opacity: 0, y: 16 }, { opacity: 1, y: 0, ease: E.rise, duration: .014, immediateRender: false }, .815);
  tl.fromTo(P.cDev, { scale: .7 }, { scale: 1, ease: E.pop, duration: .01 }, .816);
  tl.fromTo(P.cRec, { scale: .7 }, { scale: 1, ease: E.pop, duration: .01 }, .821);
  tl.add(Ravi.draw(P.wAns, .01), .826);
  tl.fromTo([P.pkA, P.handAt], { opacity: 0 }, { opacity: 1, duration: .004, immediateRender: false }, .83);
  tl.add(P.ride(.03), .83);
  tl.to(P.pkA, { opacity: 0, duration: .004 }, .86);
  tl.to(P.wAns, { opacity: .3, duration: .01 }, .862);
  tl.add(Ravi.lit(P.cRec, true, .01), .86);
  tl.fromTo(P.sk, { opacity: 0, y: 22 }, { opacity: 1, y: 0, ease: E.rise, duration: .012 }, .864);
  tl.fromTo(P.ri, { yPercent: 110, y: 0 }, { yPercent: 0, y: 0, ease: E.rise, duration: .016 }, .872);
  tl.fromTo(P.hl, { scaleX: 0 }, { scaleX: 1, ease: 'power1.inOut', duration: .008, stagger: .007 }, .894);
  /* .92–1: hold, slow push; the reply with its link then scrolls away into #share (no wipe, no empty screen) */
  Ravi.hold(tl, P.done, .908, 1);

  /* the status pill follows the timeline's own time (no callbacks to miss): each change runs as its block arrives,
     and "done" settles before the page label */
  var status = statusAt(P, [[.044, .016], [.23, .01], [.542, .012], [.772, .014]]);
  var core = tl.eventCallback('onUpdate');
  tl.eventCallback('onUpdate', function () { if (core) core(); status(tl.time()); });
  ctx.onRefresh(function () { status(tl.time()); });
  status(tl.time());
}

/* ---------- touch (≤1023): no pin; each block plays once on enter ---------- */
function touch(ctx) {
  var gsap = G(), ST = Ravi.ST, P = parts(ctx), phone = window.innerWidth < 600;
  prime(ctx, P);
  var step = stepper(P);
  function onEnter(trigger, tl, start) {
    ST.create({ trigger: trigger, start: start || 'top 80%', once: true, onEnter: function () { tl.play(); } });
  }
  function check(tl, i, at) {
    tl.add(Ravi.draw(P.cks[i], .35), at);
    tl.fromTo(P.ckSvg[i], { scale: 1 }, { keyframes: { scale: [1, 1.3, 1] }, duration: .35, ease: 'none', immediateRender: false }, at);
    /* never backwards: a fast scroll can finish a later block first */
    tl.to(P.prog, { scaleX: function () { return Math.max(gsap.getProperty(P.prog, 'scaleX'), (i + 1) / 3); }, ease: E.wipe, duration: .5 }, at);
  }
  gsap.set(P.cks, { strokeDashoffset: 1 });
  gsap.set(P.prog, { scaleX: 0 });
  gsap.set(P.uls, { '--ul': 0 });
  gsap.set(P.rlns, { strokeDashoffset: 1 });
  gsap.set(P.cRec, { '--lit': 0 });

  /* dev's card: rises with its pill; the ticket lands. Phone: the ticket lands beside the avatar while the name and
     the pill are still out, rests long enough to read, drops into the avatar, and only then do they come in */
  var tA = gsap.timeline({ paused: true });
  tA.fromTo(P.agent, { opacity: 0, y: 20 }, { opacity: 1, y: 0, ease: E.rise, duration: D.rise }, 0);
  tA.fromTo(P.av, { scale: .55 }, { scale: 1, ease: E.pop, duration: D.pop }, .1);
  if (phone) {
    tA.fromTo(P.tk, { y: -30, opacity: 0, rotation: -4 }, { y: 0, opacity: 1, rotation: 0, ease: E.enter, duration: .45 }, .25);
    tA.to(P.tk, { x: function () { var a = mid(P.av, P.agent), t = off(P.tk, P.agent); return a.x - t.x - 8; },
      y: function () { var a = mid(P.av, P.agent), t = off(P.tk, P.agent); return a.y - t.y - 8; },
      scale: .15, opacity: 0, ease: E.cut, duration: .45 }, 1.3);
    tA.fromTo(P.av, { scale: 1 }, { keyframes: { scale: [1, 1.18, 1] }, duration: .35, ease: 'none', immediateRender: false }, 1.68);
    tA.fromTo(P.nm, { opacity: 0, x: -8 }, { opacity: 1, x: 0, ease: E.enter, duration: D.enter }, 1.62);
    tA.fromTo(P.st, { opacity: 0, x: 10 }, { opacity: 1, x: 0, ease: E.enter, duration: D.enter }, 1.72);
  } else {
    tA.fromTo(P.st, { opacity: 0, x: 10 }, { opacity: 1, x: 0, ease: E.enter, duration: D.enter }, .2);
    tA.fromTo(P.tk, { y: -30, opacity: 0, rotation: -3 }, { y: 0, opacity: 1, rotation: 0, ease: E.enter, duration: .45 }, .3);
  }
  onEnter(P.stage, tA, 'top 80%');
  /* the table waits for the card's entrance, so "reading the plan" is seen before it changes */
  function afterCard(tl) {
    return function () {
      if (tA.progress() >= 1) { tl.play(); return; }
      if (!tA.isActive()) tA.play();
      tA.eventCallback('onComplete', function () { tl.play(); });
    };
  }

  /* the table: the header row wipes in, the status chips pop, check 1 */
  var tT = gsap.timeline({ paused: true });
  if (phone) {
    /* phone: the card's entrance takes about 2 s, and the screen under the sticky card must never sit empty while it
       plays. So the table's frame, column names and hints are drawn at rest; its status chips pop as it comes into
       view, and once the card is in, the pill changes and check 1 ticks */
    var tT1 = gsap.timeline({ paused: true });
    tT1.call(step, [1], 0);
    check(tT1, 0, .6);
    tT.fromTo(P.chips, { scale: .4, opacity: 0 }, { scale: 1, opacity: 1, ease: E.pop, duration: D.pop, stagger: .06 }, .1);
    ST.create({ trigger: P.base, start: 'top 85%', once: true, onEnter: function () { tT.play(); afterCard(tT1)(); } });
  } else {
    tT.call(step, [1], 0);
    tT.fromTo(P.base, { clipPath: 'inset(-60px 100% -60px -60px)' }, { clipPath: 'inset(-60px -60px -60px -60px)', ease: E.wipe, duration: .5 }, 0);
    P.ths.forEach(function (th, i) {
      var h = th.querySelector('.bd-hint');
      tT.fromTo(th, { clipPath: 'inset(0% 100% 0% 0%)' }, { clipPath: 'inset(0% 0% 0% 0%)', ease: E.wipe, duration: .35 }, .2 + i * .05);
      if (h) tT.fromTo(h, { opacity: 0, y: 6 }, { opacity: 1, y: 0, ease: E.enter, duration: .3 }, .3 + i * .05);
    });
    tT.fromTo(P.chips, { scale: .4, opacity: 0 }, { scale: 1, opacity: 1, ease: E.pop, duration: D.pop, stagger: .06 }, .5);
    check(tT, 0, 1);
    ST.create({ trigger: P.base, start: 'top 80%', once: true, onEnter: afterCard(tT) });
  }

  /* the rules: rows fade up, the teal lines run to the headers, the NOBODY ghost plays once, check 2 */
  var tR = gsap.timeline({ paused: true });
  tR.call(step, [2], 0);
  tR.fromTo(P.vcard, { opacity: 0, y: 20 }, { opacity: 1, y: 0, ease: E.rise, duration: D.rise }, 0);
  tR.fromTo(P.vrs, { opacity: 0, y: 10 }, { opacity: 1, y: 0, ease: E.enter, duration: .35, stagger: .08 }, .15);
  tR.fromTo(P.vrs.map(function (v) { return v.querySelector('.bd-lk'); }), { scale: 0 }, { scale: 1, ease: E.popSoft, duration: .3, stagger: .08 }, .2);
  tR.fromTo(P.auto, { '--hi': 0 }, { '--hi': 1, ease: E.enter, duration: .3 }, .5);
  tR.add(Ravi.draw(P.rlns[0], .4), .6);
  tR.add(Ravi.draw(P.rlns[1], .4), .68);
  tR.to(P.uls, { '--ul': 1, ease: E.wipe, duration: .35, stagger: .08 }, .85);
  onEnter(P.vcard, tR);
  /* the NOBODY ghost waits until its row is on screen and the rows above have played, then check 2 */
  var gf = function (k) { return function () { return P.ghostFrom()[k]; }; }, gt = function (k) { return function () { return P.ghostTo()[k]; }; };
  var tG = gsap.timeline({ paused: true }), gReady = false, gSeen = false;
  /* the refusal itself takes .6 s; the struck tag rests a moment so it can be read, then fades */
  tG.fromTo(P.ghostAt, { x: gf('x'), y: gf('y'), opacity: 0, scale: .85 }, { x: gf('x'), y: gf('y'), opacity: 1, scale: 1, ease: E.pop, duration: .12 }, 0);
  tG.to(P.ghostAt, { x: gt('x'), y: gt('y'), ease: E.cut, duration: .18 }, .1);
  tG.to(P.ghostAt, { x: gf('x'), y: gf('y'), ease: E.refuse, duration: .3 }, .28);
  tG.fromTo(P.ghost, { x: 0 }, { keyframes: { x: [0, -4, 3, -2, 0] }, duration: .24, ease: 'none', immediateRender: false }, .3);
  tG.add(Ravi.draw(P.strike, .16), .34);
  tG.to(P.ghostAt, { opacity: 0, ease: E.exit, duration: .22 }, 1.0);
  tG.fromTo(P.vfoot, { opacity: 0, y: 6 }, { opacity: 1, y: 0, ease: E.enter, duration: .3 }, 1.15);
  check(tG, 1, 1.05);
  function ghostGo() { if (gReady && gSeen && tG.progress() === 0 && !tG.isActive()) tG.play(); }
  tR.eventCallback('onComplete', function () { gReady = true; ghostGo(); });
  ST.create({ trigger: P.noRow, start: 'bottom 90%', once: true, onEnter: function () { gSeen = true; ghostGo(); } });

  /* the split: the bands reveal, a packet crosses each way */
  var tS = gsap.timeline({ paused: true });
  gsap.set(P.sr, { clipPath: 'circle(0px at 50% 50%)' });
  var seamIn = function (el) { return mid(P.seam, el); };
  tS.fromTo(P.seam, { scale: 0 }, { scale: 1, ease: E.wipe, duration: .4 }, 0);
  Ravi.irisIn(tS, P.sr, seamIn, .1, .6);
  tS.fromTo(P.sl.querySelectorAll('.in'), { yPercent: 110, y: 0 }, { yPercent: 0, y: 0, ease: E.rise, duration: D.rise, stagger: .1 }, .1);
  tS.fromTo(P.sr.querySelectorAll('.in'), { yPercent: 110, y: 0 }, { yPercent: 0, y: 0, ease: E.rise, duration: D.rise, stagger: .1 }, .3);
  tS.add(Ravi.draw(P.wR, .3), .5);
  tS.add(Ravi.draw(P.wW, .3), .56);
  tS.fromTo(P.pkR, { opacity: 0 }, { opacity: 1, duration: .08, immediateRender: false }, .8);
  tS.add(Ravi.packet(P.pkR, P.ptsR, .5, 'power1.inOut'), .8);
  tS.to(P.pkR, { opacity: 0, duration: .1 }, 1.28);
  tS.fromTo(P.pillR, { scale: .4, opacity: 0 }, { scale: 1, opacity: 1, ease: E.popHard, duration: .35 }, 1.0);
  tS.fromTo(P.pkW, { opacity: 0 }, { opacity: 1, duration: .08, immediateRender: false }, 1.4);
  tS.add(Ravi.packet(P.pkW, P.ptsW, .5, 'power1.inOut'), 1.4);
  tS.to(P.pkW, { opacity: 0, duration: .1 }, 1.88);
  tS.fromTo(P.pillW, { scale: .4, opacity: 0 }, { scale: 1, opacity: 1, ease: E.popHard, duration: .35 }, 1.6);
  onEnter(P.split, tS);

  /* the page: one 1.6 s timeline (URL, Private, columns, the switch bounce, the tag), check 3, then done */
  var tB = gsap.timeline({ paused: true });
  tB.call(step, [3], 0);
  tB.fromTo(P.br, { opacity: 0, y: 20 }, { opacity: 1, y: 0, ease: E.rise, duration: .45 }, 0);
  tB.add(Ravi.typeLine(P.urlT, .4), .1);
  tB.fromTo(P.priv, { scale: .4, opacity: 0 }, { scale: 1, opacity: 1, ease: E.popHard, duration: .3 }, .45);
  tB.fromTo(P.mark, { scale: .5, opacity: 0 }, { scale: 1, opacity: 1, ease: E.pop, duration: .3 }, .4);
  tB.fromTo(P.titleIn, { yPercent: 110, y: 0 }, { yPercent: 0, y: 0, ease: E.rise, duration: .45 }, .45);
  tB.fromTo(P.sub, { opacity: 0 }, { opacity: 1, duration: .25 }, .55);
  tB.fromTo(P.cols, { clipPath: 'inset(0% 100% 0% 0%)' }, { clipPath: 'inset(0% 0% 0% 0%)', ease: E.wipe, duration: .3, stagger: .06 }, .6);
  tB.fromTo(P.newBtn, { scale: .6, opacity: 0 }, { scale: 1, opacity: 1, ease: E.pop, duration: .3 }, .75);
  tB.fromTo(P.pubsw, { opacity: 0 }, { opacity: 1, duration: .2 }, .8);
  /* someone tries the switch: the pointer presses it, drifts off as it snaps back, and the tag pops as the answer */
  var ca = P.curAt;
  tB.fromTo(P.cur, { x: ca('x0'), y: ca('y0'), opacity: 0 }, { x: ca('x0'), y: ca('y0'), opacity: 1, duration: .1 }, .7);
  tB.to(P.cur, { x: ca('x'), y: ca('y'), ease: E.cut, duration: .25 }, .75);
  ring(tB, P.cur, .98, .4);
  tB.to(P.cur, { x: ca('x1'), y: ca('y1'), opacity: 0, ease: E.exit, duration: .2 }, 1.2);
  tB.to(P.swK, { x: 14, ease: E.cut, duration: .18 }, 1.0);
  tB.to(P.swOn, { opacity: 1, duration: .12 }, 1.0);
  tB.to(P.swK, { x: 0, ease: E.refuse, duration: .35 }, 1.2);
  tB.to(P.swOn, { opacity: 0, duration: .12 }, 1.2);
  tB.fromTo(P.pubsw, { x: 0 }, { keyframes: { x: [0, -4, 3, -2, 0] }, duration: .28, ease: 'none', immediateRender: false }, 1.2);
  tB.fromTo(P.ptag, { scale: .7, opacity: 0 }, { scale: 1, opacity: 1, ease: E.pop, duration: .35 }, 1.3);
  check(tB, 2, 1.45);
  tB.call(step, [4], 1.75);
  tB.fromTo(P.st, { scale: 1 }, { keyframes: { scale: [1, 1.08, 1] }, duration: .3, ease: 'none', immediateRender: false }, 2.05);
  onEnter(P.br, tB);

  /* done: dev tells reception, the reply appears, the link lights up */
  var tD = gsap.timeline({ paused: true });
  tD.fromTo([P.cDev, P.cRec], { scale: .7, opacity: 0 }, { scale: 1, opacity: 1, ease: E.pop, duration: D.pop, stagger: .12 }, 0);
  tD.add(Ravi.draw(P.wAns, .4), .25);
  tD.fromTo([P.pkA, P.handAt], { opacity: 0 }, { opacity: 1, duration: .1, immediateRender: false }, .4);
  tD.add(P.ride(.8), .4);
  tD.to(P.pkA, { opacity: 0, duration: .1 }, 1.2);
  tD.to(P.wAns, { opacity: .3, duration: .3 }, 1.25);
  tD.add(Ravi.lit(P.cRec, true, .3), 1.2);
  tD.fromTo(P.sk, { opacity: 0, y: 22 }, { opacity: 1, y: 0, ease: E.rise, duration: D.rise }, 1.25);
  tD.fromTo(P.ri, { yPercent: 110, y: 0 }, { yPercent: 0, y: 0, ease: E.rise, duration: D.rise }, 1.4);
  tD.fromTo(P.hl, { scaleX: 0 }, { scaleX: 1, ease: 'power1.inOut', duration: .32, stagger: .28 }, 1.85);
  onEnter(P.done, tD);

  /* hidden until each block plays (set by the paused timelines' from-states above) */
  gsap.set([P.handAt, P.pkA], { opacity: 0 });
}

/* ---------- frames mode: time-based on-enter reveals, no pins ---------- */
function frames(ctx) {
  var gsap = G(), blocks = ctx.$$('.bd-frames > .frame, .bd-frames > .bd-split');
  gsap.set(blocks, { opacity: 0, y: 24 });
  Ravi.ST.batch(blocks, { start: 'top 85%', once: true, onEnter: function (b) {
    gsap.to(b, { opacity: 1, y: 0, ease: E.rise, duration: D.rise, stagger: .08, overwrite: true });
  } });
}

Ravi.section('build', { desk: desk, touch: touch, frames: frames });
} catch (err) { console.error('[section build]', err); }
})();

/* ---- section share (03-share.js) ---- */
(function(){
'use strict';
try {
/* 03 · #share: one link for the whole team (unpinned, scripted run + controls).
   always: the board's state and every control (every JS mode; without JS the CSS radios do the work).
   desk:   the URL pill opens into the browser; run A (gate, Ana's cursor signs in, the board loads, Ana's cards);
           run B (Ana → Bruno → Carla → Bruno files a request → the dial turns, Carla's window refreshes).
   touch:  the same story with the gate/loading mini strip and an inline form.
   frames / reduce: the authored final state (Bruno right after filing); the switch changes with no motion.
   End block (desk, touch): the recap chips pop and their checks draw, the bridge line rises, and a short
   wire draws down from its end with one packet riding it. */

var E = Ravi.E, D = Ravi.D;
function G() { return Ravi.gsap; }

var sec, root, ui = {}, S = null, M = null;          // M = active motion layer {layout:'desk'|'touch', ctx}
var fx = [];                                          // short transition tweens (settled on the next change)
var runs = { a: null, b: null, stopped: false, aDone: false, bDone: false, bSeen: false, entered: false, user: false };
var CANON = {};                                       // count spans' authored values
var FXT = [], LATER = '';                             // the filter chip's two texts and the tag, as authored
var insetT = 0, idle = null, idleST = null, endDone = false, bwPts = [{ x: 6, y: 0 }, { x: 6, y: 56 }];

function $(s) { return root.querySelector(s); }
function $$(s, r) { return Array.prototype.slice.call((r || root).querySelectorAll(s)); }
function anim() { return !!(M && Ravi.gsap); }
function track(t) { if (t) fx.push(t); return t; }

/* ---------------- state ---------------- */
function finalState() { return { viewer: 'bruno', filed: true, gate: false, inset: true, toast: true, load: false, phase: 'done' }; }
function preState() { return { viewer: 'ana', filed: false, gate: true, inset: false, toast: false, load: false, phase: 'pre' }; }
function copyS(over) { var n = {}; Object.keys(S).forEach(function (k) { n[k] = S[k]; }); Object.keys(over || {}).forEach(function (k) { n[k] = over[k]; }); return n; }
function cardsFor(st) {
  return ui.cards.filter(function (c) {
    var v = ' ' + c.getAttribute('data-v') + ' ';
    if (v.indexOf(' ' + st.viewer + ' ') < 0) return false;
    if (c.classList.contains('sh-card--new') && !st.filed) return false;
    return true;
  });
}
function countVal(col, st, k) {
  k = k || st.viewer;
  if (st.phase === 'pre') return 0;
  if (k === 'bruno' && col.getAttribute('data-st') === 'req') return st.filed ? 1 : 0;
  return CANON[col.getAttribute('data-st') + ':' + k] || 0;
}
function countSpan(col, k) { return col.querySelector('.n>[data-c="' + k + '"]'); }

function apply(keepPill) {
  root.setAttribute('data-viewer', S.viewer);
  root.setAttribute('data-filed', S.filed ? '1' : '0');
  root.setAttribute('data-gate', S.gate ? '1' : '0');
  root.setAttribute('data-inset', S.inset ? '1' : '0');
  root.setAttribute('data-toast', S.toast ? '1' : '0');
  root.setAttribute('data-load', S.load ? '1' : '0');
  root.setAttribute('data-phase', S.phase);
  ui.vIn[S.viewer].checked = true;
  ui.cols.forEach(function (col) {
    $$('.n>[data-c]', col).forEach(function (sp) { sp.textContent = String(countVal(col, S, sp.getAttribute('data-c'))); });
  });
  if (ui.newBtn) ui.newBtn.setAttribute('aria-expanded', ui.drawer.hidden ? 'false' : 'true');
  if (!keepPill) pills(false);
  /* the gate just closed around a focused Sign in: focus lands on the board, not on <body>, and is told why */
  if (!S.gate && ui.gate.contains(document.activeElement)) {
    ui.br.setAttribute('tabindex', '-1');
    ui.br.focus({ preventScroll: true });
    Ravi.announce('Signed in as ' + ui.vIn[S.viewer].nextElementSibling.textContent);
  }
}
function refreshTouch() { if (M && M.layout === 'touch') Ravi.refresh(); }
function shimmerPaused(on) { [ui.shimmer, ui.mshim].forEach(function (s) { if (s) s.classList.toggle('is-paused', !!on); }); }

/* ---------------- sliding pill under the checked segment (motion only) ---------------- */
function pillClip(seg) {
  var inp = seg.querySelector('input:checked'), lab = inp && inp.nextElementSibling;
  if (!lab) return null;
  var W = seg.clientWidth - 6, H = seg.clientHeight - 6, x = lab.offsetLeft - 3, y = lab.offsetTop - 3;
  var r = Math.max(0, W - x - lab.offsetWidth), b = Math.max(0, H - y - lab.offsetHeight);
  return 'inset(' + Math.max(0, y) + 'px ' + r + 'px ' + b + 'px ' + Math.max(0, x) + 'px round 4px)';
}
function pills(animate) {
  if (!M) return;
  var p = ui.seg.querySelector('.sh-pill'), c = pillClip(ui.seg); if (!p || !c) return;
  if (animate && anim()) track(G().to(p, { clipPath: c, duration: .35, ease: E.cut, overwrite: true }));
  else G().set(p, { clipPath: c });
}

/* ---------------- settle: finish every short transition, render S cleanly ---------------- */
var CLEAR = 'opacity,transform,clipPath,visibility';
function settle() {
  var gsap = G();
  fx.forEach(function (t) { try { t.kill(); } catch (e) {} });
  fx = [];
  if (gsap) {
    gsap.set(ui.cards.concat([ui.board, ui.inset, ui.inCard, ui.inTag, ui.inSkel, ui.toast, ui.gate, ui.gcard, ui.skel, ui.flash, ui.drawer, ui.filter, ui.hudO, ui.ownTag]).filter(Boolean), { clearProps: CLEAR });
    $$('.sh-ft').forEach(function (f) { gsap.set(f, { clearProps: 'clipPath' }); });
    gsap.set([ui.curA, ui.curB], { opacity: 0 });
  }
  restoreTexts();
  ui.shimmer.classList.remove('is-on');
}

/* a roll or a scramble cut short leaves the wrong words or glyphs behind: put the authored texts back */
function restoreTexts() {
  [ui.fxO, ui.fxT].forEach(function (el, i) { if (el && el.firstChild) el.firstChild.nodeValue = FXT[i]; });
  if (ui.fxW) { ui.fxW.style.transform = ''; ui.fxW.style.opacity = ''; }
  var lt = ui.later && ui.later.querySelector('[aria-hidden]');
  if (lt && lt.firstChild && LATER) lt.firstChild.nodeValue = LATER;
}

/* the filter chip re-reads in whole phrases: the old one lifts out and fades, then the new one rises in.
   Pure in p, so a frame caught anywhere shows real words, never a half-made string. The chip shows the span
   for the viewer already applied (data-viewer); for the first half that span carries the old phrase. */
function fxIdx(v) { return v === 'carla' ? 1 : 0; }
function rollFilter(fromV, toV, dur) {
  var el = toV === 'carla' ? ui.fxT : ui.fxO, w = ui.fxW, a = FXT[fxIdx(fromV)], b = FXT[fxIdx(toV)], o = { p: 0 };
  if (!el || !el.firstChild || !w) return null;
  function paint() {
    var p = o.p, t = b, y = 0, op = 1, k;
    if (p < .5) { k = p / .5; k = k * k * (3 - 2 * k); t = a; y = -6 * k; op = 1 - k; }
    else if (p < 1) { k = (p - .5) / .5; k = k * k * (3 - 2 * k); y = 6 * (1 - k); op = k; }
    if (el.firstChild.nodeValue !== t) el.firstChild.nodeValue = t;
    w.style.transform = y ? 'translateY(' + y.toFixed(1) + 'px)' : '';
    w.style.opacity = op < 1 ? op.toFixed(2) : '';
  }
  return G().to(o, { p: 1, duration: dur || .35, ease: 'none', onStart: paint, onUpdate: paint, onComplete: paint });
}

/* ---------------- transitions ---------------- */
/* change the board: cards that leave fade, cards that stay slide to their new place (FLIP),
   cards that arrive rise, the counts move and the filter chip re-reads */
function change(next) {
  var gsap = G();
  settle();
  var prev = S;
  S = next;
  if (!anim()) { apply(); refreshTouch(); return; }
  var before = cardsFor(prev), after = cardsFor(next);
  var out = before.filter(function (c) { return after.indexOf(c) < 0; });
  var inn = after.filter(function (c) { return before.indexOf(c) < 0; });
  var stay = after.filter(function (c) { return before.indexOf(c) >= 0; });
  var oldCounts = ui.cols.map(function (col) { return countVal(col, prev); });
  ui.vIn[next.viewer].checked = true;
  pills(true);
  track(gsap.fromTo(ui.filter, { scale: 1 }, { scale: 1.04, duration: .16, yoyo: true, repeat: 1, ease: E.enter }));
  track(gsap.fromTo(ui.hudO, { opacity: .35 }, { opacity: 1, duration: .5, ease: E.enter }));
  function commit() {
    var r0 = stay.map(function (c) { return c.getBoundingClientRect(); });
    if (out.length) gsap.set(out, { clearProps: 'opacity,transform' });
    apply(true);
    stay.forEach(function (c, i) {
      var r1 = c.getBoundingClientRect(), dx = r0[i].left - r1.left, dy = r0[i].top - r1.top;
      if (Math.abs(dx) > .5 || Math.abs(dy) > .5) track(gsap.fromTo(c, { x: dx, y: dy }, { x: 0, y: 0, duration: .55, ease: E.cut, clearProps: 'transform' }));
    });
    if (inn.length) track(gsap.fromTo(inn, { opacity: 0, y: 14 }, { opacity: 1, y: 0, duration: .5, ease: E.rise, stagger: .05, clearProps: 'transform' }));
    ui.cols.forEach(function (col, i) {
      var to = countVal(col, next), sp = countSpan(col, next.viewer);
      if (sp && to !== oldCounts[i]) countTo(sp, oldCounts[i], to, .45);
    });
    track(rollFilter(prev.viewer, next.viewer, .35));
    refreshTouch();
  }
  if (out.length) track(gsap.to(out, { opacity: 0, y: 10, duration: .22, ease: E.exit, onComplete: commit }));
  else commit();
}
function countTo(el, from, to, dur) {
  var o = { v: from };
  el.textContent = String(from);
  return track(G().to(o, { v: to, duration: dur || .5, ease: 'power2.out', onUpdate: function () { el.textContent = String(Math.round(o.v)); }, onComplete: function () { el.textContent = String(to); } }));
}
function setViewer(v) {
  if (S.viewer === v) { apply(); return; }
  closeDrawer(false, true);
  change(copyS({ viewer: v }));
}

/* opened by hand on a board that already shows Standing desk as filed: the board goes back to the moment
   before Bruno files (no card, no toast, no Carla window), so File request visibly adds it again */
var unfileT = null;
function unfile() {
  var gsap = G(), gone = [ui.desk, ui.toast, ui.inset].filter(function (e) { return e && e.offsetParent !== null; });
  clearTimeout(insetT);
  S = copyS({ filed: false, toast: false, inset: false });
  if (!anim() || !gone.length) { apply(); refreshTouch(); return; }
  var from = countVal(ui.cols[0], copyS({ filed: true }));
  unfileT = track(gsap.to(gone, { opacity: 0, duration: .22, ease: E.exit, onComplete: function () {
    unfileT = null;
    gsap.set(gone, { clearProps: 'opacity' });
    apply(); refreshTouch();
    if (!S.filed) countTo(countSpan(ui.cols[0], 'bruno'), from, countVal(ui.cols[0], S), .35);
  } }));
}
/* drawer: role=dialog, focus moves in, Esc closes */
function openDrawer(user) {
  if (user && S.filed && S.viewer === 'bruno') unfile();
  ui.drawer.hidden = false;
  ui.newBtn.setAttribute('aria-expanded', 'true');
  if (anim()) track(Ravi.wipeIn(ui.drawer, M.layout === 'desk' ? 'right' : 'top', .4));
  refreshTouch();
  if (user) setTimeout(function () { ui.file.focus({ preventScroll: true }); requestAnimationFrame(function () { requestAnimationFrame(drawerInView); }); }, 30);
}
/* opened by hand: the dialog's title shows just under the header (and the loop bar on touch), so the form is read
   from its top. Focus alone would centre File request and push the title under the bars. */
function drawerInView() {
  if (ui.drawer.hidden) return;
  var cs = getComputedStyle(document.documentElement);
  var top = (parseFloat(cs.getPropertyValue('--hdr')) || 0) + (parseFloat(cs.getPropertyValue('--bar')) || 0) + 12;
  var r = ui.drawer.getBoundingClientRect();
  if ((r.top < top || r.bottom > innerHeight - 12) && Math.abs(r.top - top) > 1) Ravi.scrollToY(scrollY + r.top - top);
}
function closeDrawer(user, instant) {
  if (ui.drawer.hidden) return;
  function done() {
    ui.drawer.hidden = true;
    if (G()) G().set(ui.drawer, { clearProps: CLEAR });
    $$('.sh-ft').forEach(function (f) { f.style.clipPath = ''; });
    ui.newBtn.setAttribute('aria-expanded', 'false');
    refreshTouch();
    if (user) ui.newBtn.focus();
  }
  if (anim() && !instant) track(G().to(ui.drawer, M.layout === 'desk' ? { x: 24, opacity: 0, duration: D.exit, ease: E.exit, onComplete: done } : { opacity: 0, duration: .2, ease: E.exit, onComplete: done }));
  else done();
}
/* File request: the drawer leaves, Standing desk drops into REQUESTED and flashes, its tag pops, the toast rises */
function fileRequest(user) {
  var gsap = G(), wasFiled = S.filed;
  if (unfileT) { unfileT.kill(); unfileT = null; gsap.set([ui.desk, ui.toast, ui.inset], { clearProps: 'opacity' }); }
  closeDrawer(false);
  var prevCount = countVal(ui.cols[0], S);
  S = copyS({ filed: true, toast: true });
  if (user) Ravi.announce('Request filed');
  if (!anim()) { apply(); refreshTouch(); if (user) ui.newBtn.focus(); afterFile(user); return; }
  var tl = gsap.timeline();
  tl.call(function () { gsap.set([ui.desk, ui.ownTag, ui.toast], { opacity: 0 }); apply(); refreshTouch(); }, null, .22);
  tl.fromTo(ui.desk, { opacity: 0, y: -16, scale: .96 }, { opacity: 1, y: 0, scale: 1, duration: .55, ease: E.popHard, immediateRender: false }, .24);
  tl.fromTo(ui.flash, { opacity: .95 }, { opacity: 0, duration: .9, ease: E.enter, immediateRender: false }, .42);
  tl.fromTo(ui.ownTag, { opacity: 0, scale: .6 }, { opacity: 1, scale: 1, duration: .45, ease: E.popHard, transformOrigin: '0% 50%', immediateRender: false }, .52);
  tl.fromTo(ui.toast, { opacity: 0, y: 12 }, { opacity: 1, y: 0, duration: D.enter, ease: E.enter, immediateRender: false }, .66);
  tl.call(function () { if (!wasFiled) countTo(countSpan(ui.cols[0], 'bruno'), prevCount, 1, .4); }, null, .3);
  track(tl);
  if (user) setTimeout(function () { ui.newBtn.focus(); }, 30);
  afterFile(user);
}
/* after a filing by hand, Carla's window refreshes too (once) */
function afterFile(user) {
  if (!user || S.inset) return;
  clearTimeout(insetT);
  insetT = setTimeout(function () { if (S.viewer === 'bruno') showInset(); }, 900);
}
/* the dial turns once; Carla's window slides in, refreshes, and still shows only Headset */
function showInset() {
  var gsap = G();
  S = copyS({ inset: true }); apply(); refreshTouch();
  if (!anim()) return null;
  stopIdle();
  var tl = gsap.timeline({ onComplete: idleDial });
  tl.fromTo(ui.dialA, { strokeDashoffset: 1 }, { strokeDashoffset: 0, duration: 1, ease: 'power1.inOut', autoRound: false }, 0);
  tl.fromTo(ui.dialH, { rotation: 0 }, { rotation: 360, svgOrigin: '10 10', duration: 1, ease: 'power1.inOut' }, 0);
  tl.fromTo(ui.dial, { scale: 1 }, { scale: 1.2, duration: .14, yoyo: true, repeat: 1, ease: E.enter, transformOrigin: '50% 50%' }, 1);
  tl.fromTo(ui.inset, { opacity: 0, x: 40 }, { opacity: 1, x: 0, duration: D.rise, ease: E.rise }, .15);
  tl.fromTo(ui.inSkel, { opacity: 0 }, { opacity: 1, duration: .15 }, 1.0);
  tl.to(ui.inSkel, { opacity: 0, duration: .2 }, 1.35);
  tl.fromTo(ui.inCard, { opacity: 0, scale: .9 }, { opacity: 1, scale: 1, duration: .4, ease: E.popSoft, immediateRender: false }, 1.35);
  tl.fromTo(ui.inTag, { opacity: 0, scale: .6 }, { opacity: 1, scale: 1, duration: .45, ease: E.pop, immediateRender: false }, 1.6);
  return track(tl);
}

/* the dial at rest: one honest 30-second sweep, again and again, only while the board is on screen */
function idleDial() {
  if (idle || !anim() || !runs.stopped && !runs.bDone) return;
  var gsap = G();
  idle = gsap.timeline({ repeat: -1 });
  idle.fromTo(ui.dialA, { strokeDashoffset: 1 }, { strokeDashoffset: 0, duration: 30, ease: 'none', autoRound: false }, 0);
  idle.fromTo(ui.dialH, { rotation: 0 }, { rotation: 360, svgOrigin: '10 10', duration: 30, ease: 'none' }, 0);
  idleST = Ravi.pauseOffscreen(idle, ui.br);
}
function stopIdle() {
  if (idleST) { idleST.kill(); idleST = null; }
  if (idle) { idle.kill(); idle = null; }
  if (G()) G().set([ui.dialA, ui.dialH, ui.dial], { clearProps: 'strokeDashoffset,transform' });
}

/* ---------------- the scripted runs ---------------- */
function stopRuns(keepDrawer) {
  runs.stopped = true;
  [runs.a, runs.b].forEach(function (t) { if (t) t.kill(); });
  runs.a = runs.b = null;
  clearTimeout(insetT);
  settle();
  if (!keepDrawer) closeDrawer(false, true);
  if (S.phase === 'pre' || S.gate || S.load) S = copyS({ phase: 'done', gate: false, load: false });
  root.setAttribute('data-capdim', '0');
  if (M && M.layout === 'touch') { G().set(ui.mini, { clearProps: 'opacity' }); G().set($$('.sh-mf'), { opacity: 1 }); ui.mshim.classList.remove('is-on'); }
  apply();
  idleDial();
}
function cap(n) {
  ui.caps.forEach(function (li) { li.classList.toggle('is-on', +li.getAttribute('data-cap') === n); });
}
/* A: the gate, Ana signs in, the board loads, Ana's two cards pop and the counts count up */
function runA(from) {
  var gsap = G(), desk = M.layout === 'desk', tl = gsap.timeline({ onComplete: endA }), tCards;
  runs.a = tl;
  S = copyS({ viewer: 'ana' }); apply();
  if (desk) {
    tl.fromTo(ui.gcard, { opacity: 0, y: 24 }, { opacity: 1, y: 0, duration: D.rise, ease: E.rise }, 0);
    tl.call(function () { ui.signin.removeAttribute('tabindex'); }, null, .3);   // the card is drawn by now
    tl.set(ui.curA, { x: function () { return ui.page.clientWidth * .74; }, y: function () { return ui.page.clientHeight * .82; } }, 0);
    tl.to(ui.curA, { opacity: 1, duration: .15 }, .08);
    tl.add(Ravi.cursorTo(ui.curA, ui.signin, ui.page, .45), .12);
    tl.add(Ravi.ripple(ui.curA), .6);
    tl.add(Ravi.press(ui.signin), .6);
    tl.addLabel('signed', .78);
    tl.to(ui.gcard, { opacity: 0, y: -16, duration: D.exit, ease: E.exit }, .78);
    /* the board starts loading under the gate as it fades */
    tl.call(function () { S = copyS({ load: true }); apply(); ui.shimmer.classList.add('is-on'); }, null, .86);
    tl.fromTo(ui.skel, { opacity: 0 }, { opacity: 1, duration: .2, ease: E.enter, immediateRender: false }, .86);
    tl.to(ui.gate, { opacity: 0, duration: .3, ease: E.exit }, .9);
    tl.to(ui.curA, { opacity: 0, duration: .2 }, .9);
    tl.call(function () { S = copyS({ gate: false }); apply(); gsap.set([ui.gate, ui.gcard], { clearProps: CLEAR }); }, null, 1.22);
    tl.to(ui.skel, { opacity: 0, duration: .22, ease: E.exit }, 1.55);
    tCards = 1.78;
  } else {
    var f = $$('.sh-mf');
    tl.fromTo(f[0], { opacity: 0, y: 12 }, { opacity: 1, y: 0, duration: .5, ease: E.rise }, 0);
    tl.fromTo(f[1], { opacity: 0, y: 12 }, { opacity: .3, y: 0, duration: .5, ease: E.rise }, .08);
    tl.addLabel('signed', .8);
    tl.to(f[0], { opacity: .35, duration: .4, ease: E.wipe }, .8);
    tl.to(f[1], { opacity: 1, duration: .4, ease: E.wipe }, .8);
    tl.call(function () { ui.mshim.classList.add('is-on'); S = copyS({ gate: false }); apply(); }, null, .9);
    tl.to(f, { opacity: 1, duration: .4 }, 1.9);
    tCards = 1.75;
  }
  tl.call(function () {
    ui.shimmer.classList.remove('is-on'); ui.mshim.classList.remove('is-on');
    var nx = copyS({ load: false, phase: 'done' }), list = cardsFor(nx);
    G().set(list, { opacity: 0 });
    S = nx; apply();
    G().set(ui.skel, { clearProps: 'opacity' });
    runs.a.add(G().fromTo(list, { opacity: 0, scale: .86, y: -6 }, { opacity: 1, scale: 1, y: 0, duration: .55, ease: E.popSoft, stagger: .07, clearProps: 'transform' }), runs.a.time());
    ui.cols.forEach(function (col) { var to = countVal(col, S); if (to) runs.a.add(countTw(countSpan(col, S.viewer), 0, to, .55), runs.a.time()); });
    var rf = rollFilter(S.viewer, S.viewer, .35); if (rf) runs.a.add(rf, runs.a.time());
    cap(1);
  }, null, tCards);
  tl.to({}, { duration: .6 }, tCards + .1);
  if (from) tl.seek(from, false);
  if (!onScreen) tl.pause();
  return tl;
}
function countTw(el, from, to, dur) {
  var o = { v: from };
  return G().to(o, { v: to, duration: dur, ease: 'power2.out', onStart: function () { el.textContent = String(from); }, onUpdate: function () { el.textContent = String(Math.round(o.v)); } });
}
function endA() {
  runs.a = null; runs.aDone = true;
  if (S.phase === 'pre') { S = copyS({ phase: 'done', gate: false, load: false }); apply(); }
  maybeB();
}
function maybeB() {
  if (runs.stopped || !runs.aDone || !runs.bSeen || runs.b || runs.bDone || !M) return;
  runs.b = G().delayedCall(.5, runB);
}
/* B: Ana → Bruno → Carla → Bruno files a request → the dial turns, Carla's window refreshes */
function runB() {
  var gsap = G(), desk = M.layout === 'desk', step = desk ? 1.2 : 1.4, tl = gsap.timeline({ onComplete: endB });
  runs.b = tl;
  cap(1);
  tl.call(function () { setViewer('bruno'); }, null, step);
  tl.call(function () { setViewer('carla'); cap(2); }, null, step * 2);
  tl.call(function () { setViewer('bruno'); cap(3); }, null, step * 3);
  var t = step * 3 + .45;
  if (desk) {
    tl.set(ui.curB, { x: function () { return ui.page.clientWidth * .55; }, y: function () { return ui.page.clientHeight * .62; } }, t - .3);
    tl.to(ui.curB, { opacity: 1, duration: .15 }, t - .3);
    tl.add(Ravi.cursorTo(ui.curB, ui.newBtn, ui.page, .35), t - .25);
    tl.add(Ravi.ripple(ui.curB), t + .1);
  }
  tl.add(Ravi.press(ui.newBtn), t + .1);
  tl.call(function () { openDrawer(false); }, null, t + .22);
  var fts = $$('.sh-ft'), tf = t + .6;
  fts.forEach(function (f, i) { tl.add(Ravi.typeLine(f, .28), tf + i * .3); });
  var tb = tf + fts.length * .3 + .1;
  if (desk) {
    tl.add(Ravi.cursorTo(ui.curB, ui.file, ui.page, .3), tb);
    tl.add(Ravi.ripple(ui.curB), tb + .32);
  }
  tl.add(Ravi.press(ui.file), tb + .32);
  tl.call(function () { fileRequest(false); }, null, tb + .45);
  if (desk) tl.to(ui.curB, { opacity: 0, duration: .25 }, tb + .7);
  tl.call(function () { var x = showInset(); if (x && runs.b) { fx.splice(fx.indexOf(x), 1); runs.b.add(x, runs.b.time()); } cap(4); }, null, tb + 1.5);
  tl.to({}, { duration: 2.2 }, tb + 1.55);
  if (!onScreen) tl.pause();
}
function endB() { runs.b = null; runs.bDone = true; root.setAttribute('data-capdim', '0'); idleDial(); }

/* a run plays only while the board is on screen */
var onScreen = true;

/* ---------------- the wire under the bridge line ---------------- */
/* it starts just past the line's last word and drops to the bottom of the section, toward 04 */
function layoutWire() {
  if (!ui.bw || !ui.bwEnd) return;
  var w = ui.bwWrap.getBoundingClientRect(), a = ui.bwEnd.getBoundingClientRect(), s = sec.getBoundingClientRect();
  var inn = ui.bwEnd.closest('.in'), mk = inn && inn.parentNode;
  var shift = (inn && mk) ? inn.getBoundingClientRect().top - mk.getBoundingClientRect().top : 0;   // the line may still sit lowered by its mask
  var x = Math.round(a.left - w.left + 6), y = Math.round(a.bottom - shift - w.top + 12);
  var L = Math.max(40, Math.round((s.bottom - w.top) - 18 - y));
  ui.bw.style.left = (x - 6) + 'px';
  ui.bw.style.top = y + 'px';
  ui.bw.style.height = L + 'px';
  ui.bwSvg.setAttribute('height', String(L + 6));
  ui.bwSvg.querySelectorAll('path').forEach(function (p) { p.setAttribute('d', 'M6 0V' + L); });
  ui.bwMask.setAttribute('height', String(L + 30));
  ui.bwDot.setAttribute('cy', String(L));
  bwPts.length = 0; bwPts.push({ x: 6, y: 0 }, { x: 6, y: L });
}
/* the end block: chips pop and their checks draw (recap row at top 85%); then the bridge rises and the wire
   draws with a packet. The second half also waits until the wire's end is on screen, so on a phone or a short
   screen the line and the wire are not drawn below the fold. */
function endBlock(ctx) {
  var gsap = G(), aAt = false, bIn = false, left = 2;
  function done() { if (--left === 0) endDone = true; }
  var tl = gsap.timeline({ paused: true, onComplete: done });
  tl.fromTo(ui.chips, { opacity: 0, scale: .8 }, { opacity: 1, scale: 1, duration: D.pop, ease: E.pop, stagger: .08 }, 0);
  ui.chks.forEach(function (p, i) { tl.add(Ravi.draw(p, .2), .16 + i * .08); });
  var tb = gsap.timeline({ paused: true, onComplete: done });
  Ravi.maskIn(tb, ui.bridgeIn, 0);
  tb.add(Ravi.draw(ui.bwM, .5), .63);
  tb.fromTo(ui.bwPk, { opacity: 0 }, { opacity: 1, duration: .1 }, .63);
  tb.add(Ravi.packet(ui.bwPk, bwPts, .5, E.wipe), .63);
  tb.fromTo(ui.bwDot, { opacity: 0, scale: 0, transformOrigin: '50% 50%', smoothOrigin: false }, { opacity: 1, scale: 1, duration: .35, ease: E.pop, transformOrigin: '50% 50%', smoothOrigin: false }, 1.08);
  tb.to(ui.bwPk, { opacity: 0, duration: .3, ease: E.exit }, 1.13);
  if (M) M.endT = [tl, tb];
  if (endDone) { tl.progress(1); tb.progress(1); gsap.set(ui.bwPk, { opacity: 0 }); return; }
  function goB() { if (aAt && bIn && tb.paused() && tb.progress() === 0) tb.play(); }
  tl.call(function () { aAt = true; goB(); }, null, .42);
  Ravi.ST.create({ trigger: ui.sum, start: 'top 85%', once: true, onEnter: function () { tl.play(); } });
  Ravi.ST.create({ trigger: ui.bw, start: 'bottom 96%', once: true, onEnter: function () { bIn = true; goB(); } });
  if (ctx) ctx.add(function () { tl.kill(); tb.kill(); });
}

/* ---------------- always: wire everything ---------------- */
function always(c) {
  sec = c.el; root = c.$('.sh-try');
  if (!root) return;
  ui = {
    cards: $$('.sh-card'), cols: $$('.sh-col'), board: $('.sh-board'), page: $('.sh-page'), br: $('.sh-br'),
    vIn: { ana: $('#sh-v-ana'), bruno: $('#sh-v-bruno'), carla: $('#sh-v-carla') },
    seg: $('.sh-vseg'), filter: $('.sh-filter'), fxW: $('.sh-fx'), fxO: $('.sh-fx-o'), fxT: $('.sh-fx-t'), hudO: $('.sh-hud-o'),
    newBtn: $('button.sh-new'), drawer: $('.sh-drawer'), file: $('.sh-file'), cancel: $('.sh-cancel'),
    desk: $('.sh-card--new'), ownTag: $('.sh-own'), flash: $('.sh-flash'), toast: $('.sh-toast'), skel: $('.sh-skel'), shimmer: $('.sh-skel .shimmer'),
    inset: $('.sh-inset'), inCard: $('.sh-in-card'), inTag: $('.sh-in-tag'), inSkel: $('.sh-in-skel'),
    dial: $('.sh-dial'), dialA: $('.sh-dial-a'), dialH: $('.sh-dial-h'),
    gate: $('.sh-gate'), gcard: $('.sh-gcard'), signin: $('.sh-signin'), curA: $('.sh-cur-a'), curB: $('.sh-cur-b'),
    mini: $('.sh-mini'), mshim: $('.sh-mini .shimmer'), caps: $$('.sh-caps li'), later: $('.sh-later'), hud: $$('.sh-hud li')
  };
  var end = sec.querySelector('.sh-end');
  ui.sum = end.querySelector('.sh-sum');
  ui.chips = Array.prototype.slice.call(end.querySelectorAll('.sh-chip'));
  ui.chks = Array.prototype.slice.call(end.querySelectorAll('.sh-chk path'));
  ui.bridgeIn = Array.prototype.slice.call(end.querySelectorAll('.sh-bridge .in'));
  ui.bwWrap = end.querySelector('.sh-bridge-w'); ui.bwEnd = end.querySelector('.sh-bw-end');
  ui.bw = end.querySelector('.sh-bw'); ui.bwSvg = end.querySelector('.sh-bw-svg'); ui.bwMask = end.querySelector('#sh-bw-mask');
  ui.bwM = end.querySelector('.sh-bw-m'); ui.bwDot = end.querySelector('.sh-bw-dot'); ui.bwPk = end.querySelector('.sh-bw-pk');

  FXT = [ui.fxO.textContent, ui.fxT.textContent];
  /* the visible (aria-hidden) text only: an sr-only copy beside it must not be pulled into the scramble's restore */
  LATER = (ui.later.querySelector('[aria-hidden]') || ui.later).textContent;
  ui.cols.forEach(function (col) {
    $$('.n>[data-c]', col).forEach(function (sp) { CANON[col.getAttribute('data-st') + ':' + sp.getAttribute('data-c')] = +sp.textContent; });
  });
  var pill = document.createElement('i'); pill.className = 'sh-pill'; pill.setAttribute('aria-hidden', 'true'); ui.seg.insertBefore(pill, ui.seg.firstChild);

  S = c.motion() ? preState() : finalState();
  /* captions dim only during the desk run, where they sit beside the board; on touch they sit under it */
  if (c.motion() && window.matchMedia('(min-width:1024px)').matches) root.setAttribute('data-capdim', '1');
  apply();

  /* any control the visitor touches stops the scripted runs for good; controls inside the drawer keep it open */
  function act(fn, keep) { return function (e) { runs.user = true; stopRuns(keep); fn(e); }; }
  Object.keys(ui.vIn).forEach(function (k) {
    c.on(ui.vIn[k], 'change', act(function () { setViewer(k); Ravi.announce('Viewing as ' + ui.vIn[k].nextElementSibling.textContent); }));
  });
  c.on(ui.newBtn, 'click', act(function () { if (ui.drawer.hidden) openDrawer(true); else closeDrawer(true); }, true));
  c.on(ui.file, 'click', act(function () { fileRequest(true); }, true));
  c.on(ui.cancel, 'click', act(function () { closeDrawer(true); }, true));
  c.on(ui.drawer, 'keydown', function (e) {
    if (e.key === 'Escape') { e.preventDefault(); stopRuns(true); closeDrawer(true); return; }
    if (e.key === 'Tab') {
      var f = [ui.file, ui.cancel], i = f.indexOf(document.activeElement);
      if (e.shiftKey && i <= 0) { e.preventDefault(); f[1].focus(); }
      else if (!e.shiftKey && i === f.length - 1) { e.preventDefault(); f[0].focus(); }
    }
  });
  /* Sign in by hand: the run continues from the press (or the gate just opens) */
  c.on(ui.signin, 'click', function () {
    if (runs.a && runs.a.labels.signed != null) { if (runs.a.time() < runs.a.labels.signed) runs.a.seek('signed'); runs.a.play(); return; }
    if (M && S.phase === 'pre' && !runs.stopped) { runA('signed'); return; }
    stopRuns();
  });
  c.on(window, 'resize', function () { layoutWire(); if (M) pills(false); });
  if (window.MutationObserver) new MutationObserver(function () {
    if (M && !document.documentElement.classList.contains('motion')) rescue();
  }).observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
}

/* the motion layer, set up by desk and touch. No gsap.context of its own: core's matchMedia context already
   records and reverts every tween and ScrollTrigger the builder makes, and a context nested in it ends up
   containing its parent after a rebuild (getTweens then recurses until the stack overflows). For rescue(),
   which runs without core's revert, the builder's ScrollTriggers are listed in M.sts. */
function startMotion(ctx, layout) {
  var ST = Ravi.ST, had = ST.getAll().slice();
  M = { layout: layout, ctx: ctx, sts: [] };
  var cleanup = buildMotion(ctx, layout);
  if (M) { M.cleanup = cleanup; M.sts = ST.getAll().filter(function (t) { return had.indexOf(t) < 0; }); }
  return function () { if (cleanup) cleanup(); };
}
function buildMotion(ctx, layout) {
  var gsap = G(), ST = Ravi.ST;
  ui.seg.classList.add('has-pill');
  pills(false);
  root.setAttribute('data-capdim', layout === 'desk' && !runs.stopped && !runs.bDone ? '1' : '0');
  var fresh = S.phase === 'pre' && !runs.stopped;
  /* the gate card is hidden until run A fades it in: its Sign in leaves the tab order until then (runA gives it back) */
  if (fresh && layout === 'desk') { gsap.set(ui.gcard, { opacity: 0 }); ui.signin.setAttribute('tabindex', '-1'); }
  if (fresh && layout === 'touch') gsap.set($$('.sh-mf'), { opacity: 0 });

  /* on screen or not: the runs pause while the board is mostly out of view, for example while the visitor reads
     the recap under it, and go on when it comes back (off until the first refresh says otherwise).
     Touch counts the gate/loading strip above the browser as part of the board. */
  onScreen = false;
  shimmerPaused(true);
  ST.create({ trigger: layout === 'touch' ? ui.mini : ui.br, start: layout === 'touch' ? 'top 92%' : 'top 85%', endTrigger: ui.br, end: layout === 'touch' ? 'bottom 35%' : 'bottom 45%', onToggle: function (self) {
    onScreen = self.isActive;
    [runs.a, runs.b].forEach(function (t) { if (t) { if (onScreen) t.resume(); else t.pause(); } });
    shimmerPaused(!onScreen);   // the loading shimmer is a CSS loop: it stops with the run (pauseOffscreen rule)
  } });

  /* entrance: the URL types, the browser opens out of the URL pill, the tag scrambles, the HUD rises */
  if (!runs.entered) {
    var url = ui.br.querySelector('.sh-urlt'), pill = ui.br.querySelector('.sh-url');
    gsap.timeline({ scrollTrigger: { trigger: ui.br, start: 'top 96%', toggleActions: 'play none none none' } }).add(Ravi.typeLine(url, .55));
    var en = gsap.timeline({ scrollTrigger: { trigger: ui.br, start: 'top 72%', toggleActions: 'play none none none' }, onComplete: function () {
      runs.entered = true;
      gsap.set(ui.br, { clearProps: 'clipPath' });
      if (layout === 'desk' && S.phase === 'pre' && !runs.stopped && !runs.a) runA();
    } });
    /* touch: the mini strip sits above the browser, so A starts when the strip comes into view */
    if (layout === 'touch') {
      var tin = gsap.timeline({ scrollTrigger: { trigger: ui.mini, start: 'top 88%', toggleActions: 'play none none none' }, onComplete: function () {
        if (S.phase === 'pre' && !runs.stopped && !runs.a) runA();
      } });
      tin.fromTo(ui.mini, { opacity: 0 }, { opacity: 1, duration: .3 }, 0);
      tin.add(Ravi.scramble(ui.later, null, .5), 0);
    }
    en.fromTo(ui.br, { clipPath: function () {
      var b = ui.br.getBoundingClientRect(), p = pill.getBoundingClientRect();
      return 'inset(' + (p.top - b.top).toFixed(1) + 'px ' + (b.right - p.right).toFixed(1) + 'px ' + (b.bottom - p.bottom).toFixed(1) + 'px ' + (p.left - b.left).toFixed(1) + 'px round 15px)';
    } }, { clipPath: 'inset(0px 0px 0px 0px round 8px)', duration: .7, ease: E.wipe }, 0);
    if (layout === 'desk') en.add(Ravi.scramble(ui.later, null, .5), 0);
    en.fromTo(ui.hud, { opacity: 0, y: 8 }, { opacity: 1, y: 0, duration: D.rise, ease: E.rise, stagger: .08 }, .3);
  } else if (S.phase === 'pre' && !runs.stopped && !runs.a) {
    runA();
  }

  /* B waits for the board to be in view and for A to finish */
  ST.create({ trigger: ui.board, start: 'top 65%', onEnter: function () { runs.bSeen = true; maybeB(); } });
  if (runs.aDone) maybeB();
  if (runs.stopped || runs.bDone) idleDial();

  layoutWire();
  ctx.onRefresh(function () { pills(false); layoutWire(); });
  endBlock(ctx);

  return function () {
    [runs.a, runs.b].forEach(function (t) { if (t) t.kill(); });
    runs.a = runs.b = null;
    stopIdle();
    settle();
    closeDrawer(false, true);
    if (S.phase === 'pre' && runs.entered) { S = copyS({ phase: 'done', gate: false, load: false }); runs.stopped = true; }
    gsap.set([ui.mini].concat($$('.sh-mf')), { clearProps: 'opacity,transform' });
    ui.mshim.classList.remove('is-on');
    shimmerPaused(false);
    ui.signin.removeAttribute('tabindex');
    ui.seg.classList.remove('has-pill');
    var p = ui.seg.querySelector('.sh-pill'); if (p) p.style.clipPath = '';
    restoreTexts();
    M = null;
    apply();
  };
}

/* inline styles the entrance and the end block leave behind (rescue only; a rebuild reverts them through core) */
function clearMotionProps() {
  var gsap = G(); if (!gsap) return;
  var els = [ui.br, ui.br.querySelector('.sh-urlt'), ui.mini, ui.bwM, ui.bwDot, ui.bwPk].concat(ui.hud, $$('.sh-mf'), ui.chips, ui.chks, ui.bridgeIn);
  gsap.set(els.filter(Boolean), { clearProps: 'opacity,transform,clipPath,strokeDashoffset,visibility' });
}

/* safety net: if motion is switched off without a rebuild (a boot error elsewhere on the page),
   undo every motion state and show the final picture, as reduced motion does */
function rescue() {
  var m = M; if (!m) return;
  try { if (m.cleanup) m.cleanup(); } catch (e) {}
  try { (m.endT || []).forEach(function (t) { t.kill(); }); } catch (e) {}
  /* the builder's own ScrollTriggers (entrance, on-screen, end block): revert what they animated, then kill them */
  (m.sts || []).forEach(function (t) {
    try { if (t.animation && t.animation.revert) t.animation.revert(); } catch (e) {}
    try { t.kill(); } catch (e) {}
  });
  try { clearMotionProps(); } catch (e) {}
  M = null;
  restoreTexts();
  if (!runs.user) S = finalState();
  runs.stopped = true;
  staticMode({});
}

function desk(ctx) { return startMotion(ctx, 'desk'); }
function touch(ctx) { return startMotion(ctx, 'touch'); }
/* frames / reduce: the authored final state; the switch changes with no transition */
function staticMode(ctx) {
  if (!root) return;
  if (S.phase === 'pre') S = finalState();
  S.gate = false; S.load = false;
  root.setAttribute('data-capdim', '0');
  apply();
  layoutWire();
  if (ctx.onRefresh) ctx.onRefresh(layoutWire);
  if (ctx.frames) {
    var gsap = G();
    gsap.fromTo(ui.br, { opacity: 0, y: 24 }, { opacity: 1, y: 0, duration: D.rise, ease: E.rise, scrollTrigger: { trigger: ui.br, start: 'top 85%', toggleActions: 'play none none none' } });
  }
}

Ravi.section('share', { always: always, desk: desk, touch: touch, frames: staticMode, reduce: staticMode });
} catch (err) { console.error('[section share]', err); }
})();

/* ---- section wake (04-wake.js) ---- */
(function(){
'use strict';
try {
/* 04 · #wake (PIN 3): nobody has to forward it.
   desk: one 180% pin. The four nodes wire up; Bruno's ticket pops out of the page and rides under the wire to
   Ravi (the dial turns) and on to what ops watches for; the three lines tick and ops lights. The camera pans down
   to the bottom row while the ticket drops into ops's work card as its top label. ops looks at what's waiting,
   adds Carla as supervisor, writes the card and posts it; a packet carries it to #finance, which comes to life.
   Hold with a slow push on #finance to the end of the pin; the finished scene then scrolls into #click.
   touch: a 150% pin on the vertical pipeline panel (the ticket rides down a lane beside the nodes and docks by the
   watch card), then the work card plays on enter as a 2 s timeline and #finance rises.
   frames: on-enter reveals. reduce / no JS: the authored HTML is final. */

var G = function () { return Ravi.gsap; };
var E = Ravi.E, D = Ravi.D;

/* layout offset of el inside root (ignores transforms); falls back to rects if root is not an offset ancestor */
function off(el, root) {
  var x = 0, y = 0, n = el;
  while (n && n !== root) { x += n.offsetLeft; y += n.offsetTop; n = n.offsetParent; }
  if (n !== root) {
    var a = el.getBoundingClientRect(), b = root.getBoundingClientRect();
    return { x: a.left - b.left, y: a.top - b.top, w: el.offsetWidth, h: el.offsetHeight };
  }
  return { x: x, y: y, w: el.offsetWidth, h: el.offsetHeight };
}
function hdrBar() {
  var cs = getComputedStyle(document.documentElement);
  return (parseFloat(cs.getPropertyValue('--hdr')) || 52) + (parseFloat(cs.getPropertyValue('--bar')) || 0);
}
function P(x, y) { return Math.round(x * 10) / 10 + ' ' + Math.round(y * 10) / 10; }
function lineD(a, b) { return 'M' + P(a[0], a[1]) + ' L' + P(b[0], b[1]); }
function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
function seg(t, a, b) { return clamp01((t - a) / (b - a)); }
function lerp(a, b, k) { return a + (b - a) * k; }
function quad(a, c, b, k) { var u = 1 - k; return u * u * a + 2 * u * k * c + k * k * b; }
/* an extra (unstroked) path inside the wires svg, used only to sample a packet route */
function routePath(svg) {
  var p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('class', 'wk-route'); p.style.fill = 'none'; p.style.stroke = 'none';
  svg.appendChild(p);
  return p;
}

/* status text: the old phrase lifts out and dims, then the new one rises in. Whole phrases only, and never under
   40% opacity, so a frame at rest (a scrub that stops mid-change) always shows real words; pure in p, so scrubbing
   either way is exact */
function r1(v) { return Math.round(v * 10) / 10; }
var DIM = .4;
function roll(el, a, b, p) {
  if (!el) return;
  var t = b, y = 0, o = 1, q;
  if (p <= 0) t = a;
  else if (p < .5) { q = p / .5; q = q * q * (3 - 2 * q); t = a; y = -6 * q; o = 1 - (1 - DIM) * q; }
  else if (p < 1) { q = (p - .5) / .5; q = q * q * (3 - 2 * q); y = 6 * (1 - q); o = DIM + (1 - DIM) * q; }
  if (el.textContent !== t) el.textContent = t;
  var tr = y ? 'translateY(' + r1(y) + 'px)' : '', op = o < 1 ? String(Math.round(o * 100) / 100) : '';
  if (el.style.transform !== tr) el.style.transform = tr;
  if (el.style.opacity !== op) el.style.opacity = op;
}
/* the phrase showing at p (the new one from the midpoint on) */
function rolled(a, b, p) { return p >= .5 ? b : a; }
function unroll(els) { els.forEach(function (el) { if (el) { el.style.transform = ''; el.style.opacity = ''; } }); }
/* time-based roll (touch): a .35 s tween of p; onSwitch(true) runs when the new phrase takes over */
function rollTw(el, a, b, dur, onSwitch) {
  var o = { p: 0 }, sw = false;
  function paint() { roll(el, a, b, o.p); var n = o.p >= .5; if (n !== sw) { sw = n; if (onSwitch) onSwitch(n); } }
  return G().fromTo(o, { p: 0 }, { p: 1, duration: dur || .35, ease: 'none', immediateRender: false, onStart: paint, onUpdate: paint, onComplete: paint });
}
/* ops's work card is drawn by two pieces (::before clipped from the bottom, ::after a 12px bottom edge that rides up
   by the same --cut), so the card can end just under any block without a height tween: cutAt(work, el) = the --cut
   that makes it end under el (0 = the whole card) */
function cutAt(work, el) {
  return function () {
    var pb = parseFloat(getComputedStyle(work).paddingBottom) || 16;
    return Math.max(0, Math.round(work.offsetHeight - (el.offsetTop + el.offsetHeight + pb))) + 'px';
  };
}
function setText(el, t) { if (el && el.textContent !== t) el.textContent = t; }
/* the ticket and the camera are driven by quickSetters, which a builder's revert does not undo (and the revert
   re-renders time 0, the ticket's hidden starting state): clear them so the static view shows the authored layout */
function clearDriven(els) { try { G().set(els, { clearProps: 'transform,opacity,visibility,zIndex' }); } catch (e) {} }
/* while the ticket is fully transparent it is also not rendered, so it never counts as a layout shift */
function tkShow(tk, o) { var v = o > 0 ? '' : 'hidden'; if (tk.style.visibility !== v) tk.style.visibility = v; }

var TXT = { look: "looking at what's waiting", add: 'adding a supervisor', write: 'writing the card', posted: 'posted',
  none: 'none', carla: 'Carla ✓', ready: 'ready ✓', postedOk: 'posted ✓' };

/* the authored final texts, restored whenever a builder is reverted */
function finalTexts(ctx) {
  setText(ctx.$('.wk-wst-t'), TXT.posted); ctx.$('.wk-wst').classList.add('is-done');
  setText(ctx.$('.wk-sv--new'), TXT.carla); ctx.$('.wk-sv--new').classList.remove('is-none');
  setText(ctx.$('.wk-wcs-t'), TXT.postedOk); ctx.$('.wk-wcs').classList.add('is-done');
}

/* the core's dense check misses beats that run into the copy column's bottom padding (kept for the loop ring) */
function denseFixer(ctx) {
  var copy = ctx.$('.scene-copy'), beatsEl = ctx.$('.beats');
  return function () {
    if (!copy || !beatsEl || !ctx.wide || copy.classList.contains('scene-copy--dense')) return;
    var last = beatsEl.lastElementChild; if (!last) return;
    var cb = copy.getBoundingClientRect(), pb = parseFloat(getComputedStyle(copy).paddingBottom) || 0;
    if (last.getBoundingClientRect().bottom > cb.bottom - pb + 1) copy.classList.add('scene-copy--dense');
  };
}

/* ---------- desk (≥1024 × ≥640) ---------- */
function desk(ctx) {
  var gsap = G(), ST = Ravi.ST;
  var stage = ctx.$('.stage'), cam = ctx.$('.wk-cam'), pipe = ctx.$('.wk-pipe'), cd = ctx.$('.wk-cd');
  /* labels sit where each beat's action has finished (as #ask and #build do), so a snap or a beat click rests on a
     complete frame: the ticket at Ravi after the dial's turn; the ticket docked in ops's card; Carla added and the
     note up; the card posted in #finance with its buttons */
  var L = { 'in': 0, arrive: .225, match: .482, supervisor: .66, card: .9, out: .95 };
  var N = { page: ctx.$('.wk-n-page'), ravi: ctx.$('.wk-n-ravi'), watch: ctx.$('.wk-watch'), ops: ctx.$('.wk-ops') };
  var svg = ctx.$('.wk-wires'), W = ctx.$$('.wk-w'), pk = ctx.$('.wk-pk'), tk = ctx.$('.wk-ticket');
  var work = ctx.$('.wk-work'), slot = ctx.$('.wk-wslot'), fin = ctx.$('.wk-fin'), wcard = ctx.$('.wk-wcard');
  var rF = routePath(svg), RF = [];
  var g = {};   /* geometry, in .wk-cam's layout space */
  function rel(el) { return off(el, cam); }

  function measure() {
    /* the dock slot is exactly one ticket tall (plus its inset) */
    slot.style.setProperty('--slot', (tk.offsetHeight + 16) + 'px');
    var pg = rel(N.page), rv = rel(N.ravi), wt = rel(N.watch), op = rel(N.ops), pp = rel(pipe), sl = rel(slot);
    var wy = pg.y + pg.h / 2, low = Math.max(pg.y + pg.h, rv.y + rv.h, wt.y + wt.h, op.y + op.h);
    g.wy = wy; g.tw = tk.offsetWidth; g.th = tk.offsetHeight;
    g.lane = low + 18;                                    /* the ticket's top while it hangs under the wire */
    g.xPage = pg.x + pg.w / 2; g.xRavi = rv.x + rv.w / 2; g.xWatch = wt.x + wt.w / 2; g.xOps = op.x + 12;
    g.yPop = pg.y + pg.h / 2 - g.th / 2;
    /* framing: the band alone is centred at first. If both rows do not fit, the bottom row first moves up into
       the lane the ticket has left, then the camera pans the rest */
    var sh = stage.clientHeight, cdp = rel(cd), over = (cdp.y + cdp.h) - pp.y - sh;
    g.lift = over > 0 ? Math.min(over, 96) : 0;
    g.cam0 = Math.max(0, Math.round((sh - (pp.h + 10)) / 2 - pp.y));
    g.cam1 = over > g.lift ? -Math.round(over - g.lift) - pp.y : 0;
    g.dock = { x: sl.x + 8, y: sl.y + 8 - g.lift };
    /* on a short screen the pan pushes the band's tops past the stage edge; the band then fades out as the
       ticket leaves it, so no half-cut node is left at the top. Its job is done by then. */
    g.bandOut = Math.min(pg.y, rv.y, wt.y, op.y) + g.cam1 < 0;
    W[0].setAttribute('d', lineD([pg.x + pg.w, wy], [rv.x, wy]));
    W[1].setAttribute('d', lineD([rv.x + rv.w, wy], [wt.x, wy]));
    W[2].setAttribute('d', lineD([wt.x + wt.w, wy], [op.x, wy]));
    /* the posted card: from the work card's card line across to #finance */
    var wc = rel(wcard), fn = rel(fin), msg = rel(ctx.$('.wk-fin .wk-bk'));
    var f0 = [wc.x + wc.w, wc.y + wc.h / 2 - g.lift], f1 = [fn.x + 18, msg.y + Math.min(msg.h / 2, 60) - g.lift], dx = (f1[0] - f0[0]) * .5;
    rF.setAttribute('d', 'M' + P(f0[0], f0[1]) + ' C' + P(f0[0] + dx, f0[1]) + ' ' + P(f1[0] - dx, f1[1]) + ' ' + P(f1[0], f1[1]));
    RF.length = 0; try { Array.prototype.push.apply(RF, Ravi.samplePath(rF, 48)); } catch (e) {}
    /* until the card is posted, #finance shows only its channel header */
    g.finClip = Math.max(0, fin.offsetHeight - ctx.$('.wk-fin .sk-hd').offsetHeight - 1);
  }
  measure();
  function finShut() { return 'inset(0px 0px ' + g.finClip + 'px 0px)'; }

  ctx.iris({ at: function () { var r = N.page.getBoundingClientRect(), s = stage.getBoundingClientRect(); return { x: r.left - s.left + r.width / 2, y: r.top - s.top + r.height / 2 }; } });
  var denseFix = denseFixer(ctx);
  var Pn = ctx.pin({ end: '+=180%', labels: L, onRefresh: denseFix });
  var tl = Pn.tl;
  /* a beat click scrolls 1–2px past its label; snapping downward from there skips to the next snap point
     (from card .76 that is the end of the pin). Core holds snap off for 1.5 s after any keydown, so a beat
     click sends an empty one (no key) to document, which every other handler ignores. */
  ctx.$$('.beat').forEach(function (b) {
    ctx.on(b, 'click', function () { try { document.dispatchEvent(new KeyboardEvent('keydown', { bubbles: false })); } catch (e) {} });
  });

  /* --- pieces and their starting states --- */
  var chks = ctx.$$('.wk-chk'), his = ctx.$$('.wk-cl-hi'), glow = ctx.$('.wk-glow');
  var hand = ctx.$('.wk-hand'), arc = ctx.$('.wk-dial-arc'), k1 = ctx.$('.wk-k1');
  var wchip = ctx.$('.wk-wchip'), wst = ctx.$('.wk-wst'), wstT = ctx.$('.wk-wst-t');
  var wlh = ctx.$('.wk-wlh'), rows = ctx.$$('.wk-wr'), newRow = ctx.$('.wk-wr--new'), newHi = ctx.$('.wk-wr--new .wk-wr-hi');
  var sv = ctx.$('.wk-sv--new'), svd = ctx.$('.wk-svd'), note = ctx.$('.wk-wnote');
  var mk = ctx.$('.wk-mk'), mi = ctx.$('.wk-mi'), wct = ctx.$('.wk-wct'), wcs = ctx.$('.wk-wcs'), wcsT = ctx.$('.wk-wcs-t');
  var fmsg = ctx.$('.wk-fin .sk-msg'), fav = ctx.$('.wk-fin .av'), meta = ctx.$('.wk-fin .sk-meta'), blocks = ctx.$$('.wk-b');
  var btns = ctx.$$('.wk-approve, .wk-decline');
  var band = [N.page, N.ravi, N.watch, ctx.$('.wk-n-ops'), W[0], W[1], W[2]], bandO = null;

  gsap.set(W, { strokeDashoffset: 1 });
  gsap.set(W[3], { opacity: 0 });              /* the touch-only tie between the watch card and the ticket */
  gsap.set(chks, { scale: 0, opacity: 0 });
  gsap.set(N.ops, { '--lit': 0, scale: .9 });
  gsap.set(arc, { strokeDashoffset: 1 });
  gsap.set(k1, { opacity: 0 });
  gsap.set(cd, { opacity: 0, y: 48 });
  gsap.set(wchip, { '--lit': 0 });
  gsap.set(wst, { opacity: 0, scale: .8 });
  gsap.set([wlh, note, wct, mi], { opacity: 0 });
  gsap.set(rows, { clipPath: 'inset(0% 100% 0% 0%)' });
  gsap.set(svd, { opacity: 1 });
  gsap.set(wcs, { opacity: 0, scale: .6 });
  gsap.set(mk, { strokeDashoffset: 1 });
  gsap.set(wcard, { opacity: 0 });              /* the card line (and its rule) arrives with "writing the card" */
  gsap.set(fin, { clipPath: finShut, opacity: 0 });   /* #finance stays out of the picture until the card is posted */
  gsap.set(fmsg, { opacity: 0 });
  gsap.set(pk, { opacity: 0 });
  wst.classList.remove('is-done'); wcs.classList.remove('is-done');

  /* 0–.04: the wires draw left to right */
  [[0, 0, .016], [1, .014, .014], [2, .026, .014]].forEach(function (w) { tl.add(Ravi.draw(W[w[0]], w[2], 1, 0), w[1]); });

  /* .03–.06: the page pulses and the ticket pops out of it (the ticket itself is driven by tick()) */
  function pulse(el, at, s) { tl.to(el, { scale: s || 1.04, duration: .006, ease: E.enter }, at).to(el, { scale: 1, duration: .012, ease: E.popSoft }, at + .006); }
  pulse(N.page, .032);

  /* .15–.23: the ticket reaches Ravi; the dial turns once and its label lights mint */
  pulse(N.ravi, .148);
  tl.fromTo(hand, { rotation: 0 }, { rotation: 360, svgOrigin: '11 11', ease: E.travel, duration: .06 }, .158);
  tl.fromTo(arc, { strokeDashoffset: 1 }, { strokeDashoffset: 0, ease: E.travel, duration: .06, autoRound: false, immediateRender: false }, .158);
  tl.to(k1, { opacity: 1, duration: .01, ease: E.enter }, .2);

  /* .28–.37: the three lines tick one by one; ops is handed the request and lights */
  chks.forEach(function (c, i) {
    var at = .285 + i * .025;
    tl.to(his[i], { opacity: 1, duration: .006, ease: E.enter }, at);
    tl.fromTo(c, { scale: 0, opacity: 0 }, { scale: 1, opacity: 1, ease: E.popHard, duration: .012, immediateRender: false }, at + .002);
  });
  tl.fromTo(glow, { opacity: 0 }, { opacity: 1, duration: .008, ease: E.enter, immediateRender: false }, .345).to(glow, { opacity: 0, duration: .03, ease: 'power1.in' }, .36);
  tl.to(his, { opacity: 0, duration: .012 }, .37);
  tl.to(N.ops, { scale: 1, '--lit': 1, ease: E.pop, duration: .014 }, .362);

  /* .36–.44: the bottom row comes up while the camera pans (tick()) */
  tl.to(cd, { opacity: 1, y: function () { return -g.lift; }, ease: E.rise, duration: .07 }, .385);

  /* .44–.48: as the card settles, ops is looking at what's waiting: the pill, the list and its Headset row; the
     Standing desk row wipes in as the ticket docks. The slot's outline gives way and ops's card lights as the ticket
     lands (.48, the match label), so that frame is complete. Until the note, the card ends just under the list. */
  var wl = ctx.$('.wk-wl');
  tl.fromTo(work, { '--cut': cutAt(work, wl) }, { '--cut': cutAt(work, note), ease: E.enter, duration: .012, immediateRender: true }, .628);
  tl.to(work, { '--cut': '0px', ease: E.enter, duration: .012 }, .734);
  tl.to(wst, { opacity: 1, scale: 1, ease: E.pop, duration: .014 }, .438);
  tl.to(wlh, { opacity: 1, duration: .01, ease: E.enter }, .444);
  rows.forEach(function (r, i) { tl.to(r, { clipPath: 'inset(0% 0% 0% 0%)', ease: E.wipe, duration: .014 }, .45 + i * .015); });
  tl.to(slot, { opacity: 0, duration: .01, ease: E.enter }, .468);
  tl.to(wchip, { '--lit': 1, duration: .01, ease: E.enter }, .47);

  /* .58–.66: "none" settles to "Carla ✓" (tick) with a mint flash on the row; the note fades up */
  tl.fromTo(newHi, { opacity: 0 }, { opacity: 1, duration: .006, ease: E.enter, immediateRender: false }, .58).to(newHi, { opacity: 0, duration: .03, ease: 'power1.in' }, .6);
  tl.to(svd, { opacity: 0, scale: .4, duration: .01, ease: E.exit }, .588);
  tl.fromTo(note, { opacity: 0, y: 8 }, { opacity: 1, y: 0, duration: .016, ease: E.rise, immediateRender: false }, .64);

  /* .74–.83: writing the card: the card opens onto its card line, the outline draws, ready ✓, posted */
  tl.to(wcard, { opacity: 1, duration: .008, ease: E.enter }, .741);
  tl.to(wct, { opacity: 1, duration: .01, ease: E.enter }, .748);
  tl.add(Ravi.draw(mk, .034, 1, 0), .752);
  tl.to(mi, { opacity: 1, duration: .012, ease: E.enter }, .776);
  tl.to(wcs, { opacity: 1, scale: 1, ease: E.pop, duration: .012 }, .79);
  tl.fromTo(wcs, { scale: 1 }, { keyframes: { scale: [1, 1.12, 1] }, duration: .012, ease: 'none', immediateRender: false }, .82);

  /* .82–.87: a packet carries the card to #finance; the channel appears as it lands and opens onto the card */
  tl.fromTo(pk, { opacity: 0 }, { opacity: 1, duration: .004, immediateRender: false }, .822);
  tl.add(Ravi.packet(pk, RF, .028, E.travel), .824);
  tl.to(pk, { opacity: 0, duration: .006, ease: E.exit }, .852);
  tl.fromTo(fin, { opacity: 0 }, { opacity: 1, duration: .01, ease: E.enter, immediateRender: false }, .838);
  tl.fromTo(fin, { clipPath: finShut }, { clipPath: 'inset(0px 0px 0px 0px)', duration: .02, ease: E.wipe, immediateRender: false }, .846);
  tl.fromTo(fmsg, { opacity: 0 }, { opacity: 1, duration: .004, immediateRender: false }, .85);
  tl.fromTo([fav, meta], { opacity: 0, y: 10 }, { opacity: 1, y: 0, ease: E.rise, duration: .014, immediateRender: true }, .85);
  tl.fromTo(blocks, { opacity: 0, y: 14 }, { opacity: 1, y: 0, ease: E.rise, duration: .016, stagger: .006, immediateRender: true }, .856);
  tl.fromTo(btns, { scale: .6 }, { scale: 1, ease: E.popHard, duration: .012, stagger: .01, immediateRender: true }, .872);

  /* .89–1: hold, a slow push on #finance. No exit wipe: the finished scene scrolls away into #click,
     whose card is this same message. */
  Ravi.hold(tl, fin, .892, 1);

  /* --- pure functions of the timeline's time: the ticket's ride, the camera, the swapped texts --- */
  /* the pill's phrase changes: [start, length, from, to] */
  var PILL = [[.58, .02, TXT.look, TXT.add], [.74, .016, TXT.add, TXT.write], [.82, .012, TXT.write, TXT.posted]];
  var tkx = gsap.quickSetter(tk, 'x', 'px'), tky = gsap.quickSetter(tk, 'y', 'px'), tsx = gsap.quickSetter(tk, 'scaleX'), tsy = gsap.quickSetter(tk, 'scaleY');
  var tks = function (v) { tsx(v); tsy(v); };
  var tko = gsap.quickSetter(tk, 'opacity'), camY = gsap.quickSetter(cam, 'y', 'px');
  var pkx = gsap.quickSetter(pk, 'x', 'px'), pky = gsap.quickSetter(pk, 'y', 'px');
  var easeIO = gsap.parseEase('sine.inOut'), easePop = gsap.parseEase(E.pop), easeCut = gsap.parseEase(E.cut), easeRise = gsap.parseEase(E.rise);
  function tick(t) {
    var x, y, s = 1, o = 1, str = 0;
    if (t < .04) { o = 0; x = g.xPage; y = g.yPop; s = .4; }
    else if (t < .058) { var k = seg(t, .04, .058); o = clamp01(k * 3); s = lerp(.4, 1, easePop(k)); x = g.xPage; y = lerp(g.yPop, g.lane, easeRise(k)); }
    else if (t < .27) {
      x = t < .07 ? g.xPage : t < .15 ? lerp(g.xPage, g.xRavi, easeIO(seg(t, .07, .15))) : t < .225 ? g.xRavi : lerp(g.xRavi, g.xWatch, easeIO(seg(t, .225, .27)));
      y = g.lane; str = clamp01(seg(t, .058, .068));
    }
    else if (t < .4) { x = g.xWatch; y = g.lane; str = 1 - seg(t, .338, .35); }
    else if (t < .48) {
      var q = easeCut(seg(t, .4, .48)), ax = g.xWatch, ay = g.lane, bx = g.dock.x + g.tw / 2, by = g.dock.y;
      x = quad(ax, ax, bx, q); y = quad(ay, by, by, q);
    }
    else { x = g.dock.x + g.tw / 2; y = g.dock.y; }
    tkx(x - g.tw / 2); tky(y); tks(s); tko(o); tkShow(tk, o);
    tk.style.setProperty('--str', Math.max(0, y - g.wy) + 'px');
    tk.style.setProperty('--stro', str.toFixed(3));
    /* the dot rides the wire above the hanging ticket, then is handed on to ops */
    if (t < .82) {
      var dO = t < .058 ? 0 : t < .338 ? clamp01(seg(t, .058, .066)) : t < .36 ? 1 : 1 - seg(t, .36, .368);
      var dx = t < .338 ? x : lerp(g.xWatch, g.xOps, easeIO(seg(t, .338, .36)));
      pkx(dx); pky(g.wy); pk.style.opacity = dO.toFixed(3);
    }
    /* on the wire the dot passes behind the nodes; carrying the card it travels over both cards */
    pk.style.zIndex = t >= .8 ? '5' : '';
    /* the hanging ticket (and its string) passes behind the nodes; dropping, it goes over the bottom row */
    tk.style.zIndex = t >= .4 ? '4' : '';
    /* camera */
    camY(Math.round(lerp(g.cam0, g.cam1, easeCut(seg(t, .36, .46)))));
    var bo = g.bandOut ? (1 - seg(t, .4, .44)).toFixed(3) : '';
    if (bo !== bandO) { bandO = bo; band.forEach(function (e) { e.style.opacity = bo; }); }
    /* texts: whole-phrase rolls keyed to the time; each one finishes before its label, so a snap or a beat click
       rests on a settled pill, and any other rest frame shows real words */
    var i, ph = -1, pp = 1;
    for (i = 0; i < PILL.length; i++) if (t >= PILL[i][0]) ph = i;
    if (ph < 0) roll(wstT, TXT.look, TXT.look, 1);
    else { pp = seg(t, PILL[ph][0], PILL[ph][0] + PILL[ph][1]); roll(wstT, PILL[ph][2], PILL[ph][3], pp); }
    /* the pill turns mint with "posted", the value turns mint with "Carla ✓" (when the new phrase takes over) */
    wst.classList.toggle('is-done', ph === PILL.length - 1 && rolled(false, true, pp));
    var sp = seg(t, .58, .6);
    roll(sv, TXT.none, TXT.carla, sp); sv.classList.toggle('is-none', !rolled(false, true, sp));
    setText(wcsT, t < .82 ? TXT.ready : TXT.postedOk); wcs.classList.toggle('is-done', t >= .82);
  }

  var cb = tl.eventCallback('onUpdate');
  tl.eventCallback('onUpdate', function () { if (cb) cb(); tick(tl.time()); });
  tick(tl.time());

  /* re-measure before ScrollTrigger re-renders (resize, fonts), then repaint the current frame */
  function remeasure() { gsap.set(cam, { y: 0 }); measure(); }
  ST.addEventListener('refreshInit', remeasure);
  ctx.add(function () { ST.removeEventListener('refreshInit', remeasure); });
  ctx.onRefresh(function () { var t = tl.time(); tl.time(Math.min(1, t + 1e-4)).time(t); tick(t); });

  ctx.add(function () {
    if (rF.parentNode) rF.parentNode.removeChild(rF);
    ['--str', '--stro'].forEach(function (p) { tk.style.removeProperty(p); });
    slot.style.removeProperty('--slot');
    pk.style.opacity = ''; pk.style.zIndex = ''; tk.style.zIndex = '';
    band.forEach(function (e) { e.style.opacity = ''; });
    clearDriven([tk, cam, pk]);
    unroll([wstT, sv]);
    finalTexts(ctx);
  });
}

/* ---------- touch (≤1023) ---------- */
function touch(ctx) {
  var gsap = G(), ST = Ravi.ST;
  var panel = ctx.$('.wk-ev');
  var N = { page: ctx.$('.wk-n-page'), ravi: ctx.$('.wk-n-ravi'), watch: ctx.$('.wk-watch'), ops: ctx.$('.wk-ops') };
  var W = ctx.$$('.wk-w'), tk = ctx.$('.wk-ticket');
  var g = {};
  function rel(el) { return off(el, panel); }
  function measure() {
    var pg = rel(N.page), rv = rel(N.ravi), wt = rel(N.watch), op = rel(N.ops), pw = panel.clientWidth;
    var cx = pg.x + pg.w / 2;
    g.tw = tk.offsetWidth; g.th = tk.offsetHeight;
    var lane = parseFloat(getComputedStyle(ctx.$('.wk-pipe')).paddingRight) || 150;
    g.lx = pw - lane + (lane - g.tw) / 2 + 2;                 /* the ticket's left edge in its lane */
    g.pop = { x: cx - g.tw / 2, y: pg.y + pg.h / 2 - g.th / 2 };
    g.yPage = Math.max(4, pg.y + pg.h / 2 - g.th / 2);
    g.yRavi = rv.y + rv.h / 2 - g.th / 2;
    g.yWatch = wt.y + wt.h / 2 - g.th / 2;
    W[0].setAttribute('d', lineD([cx, pg.y + pg.h], [rv.x + rv.w / 2, rv.y]));
    W[1].setAttribute('d', lineD([rv.x + rv.w / 2, rv.y + rv.h], [wt.x + wt.w / 2, wt.y]));
    W[2].setAttribute('d', lineD([wt.x + wt.w / 2, wt.y + wt.h], [op.x + op.w / 2, op.y]));
    /* the short tie between the watch card and the docked ticket */
    W[3].setAttribute('d', lineD([wt.x + wt.w, wt.y + wt.h / 2], [g.lx, wt.y + wt.h / 2]));
  }
  measure();

  /* above the pin the ticket is not shown, even while the scrub is still easing it back: Chrome counts a moving
     element inside a panel that is being unpinned as a layout shift (perf) */
  var Pn = ctx.pin({ trigger: panel, start: function () { return 'top ' + hdrBar() + 'px'; }, end: '+=150%', beats: false, snap: false, labels: { 'in': 0, out: 1 }, wc: false,
    onToggle: function () { if (tl) tick(tl.time()); } });
  function shown() { var s = Pn && Pn.st; return !s || s.isActive || s.progress >= 1; }
  var tl = Pn.tl;

  var chks = ctx.$$('.wk-chk'), his = ctx.$$('.wk-cl-hi'), glow = ctx.$('.wk-glow');
  var hand = ctx.$('.wk-hand'), arc = ctx.$('.wk-dial-arc'), k1 = ctx.$('.wk-k1');
  gsap.set(W, { strokeDashoffset: 1 });
  gsap.set(chks, { scale: 0, opacity: 0 });
  gsap.set(N.ops, { scale: .9, '--lit': 0 });
  gsap.set(arc, { strokeDashoffset: 1 });
  gsap.set(k1, { opacity: 0 });

  /* 0–.1: the wires draw downward; the page pulses */
  [[0, 0, .04], [1, .035, .035], [2, .065, .03]].forEach(function (w) { tl.add(Ravi.draw(W[w[0]], w[2], 1, 0), w[1]); });
  function pulse(el, at) { tl.to(el, { scale: 1.05, duration: .015, ease: E.enter }, at).to(el, { scale: 1, duration: .03, ease: E.popSoft }, at + .015); }
  pulse(N.page, .09);
  /* .29–.40: level with Ravi, the dial turns and its label lights */
  pulse(N.ravi, .285);
  tl.fromTo(hand, { rotation: 0 }, { rotation: 360, svgOrigin: '11 11', ease: E.travel, duration: .09 }, .3);
  tl.fromTo(arc, { strokeDashoffset: 1 }, { strokeDashoffset: 0, ease: E.travel, duration: .09, autoRound: false, immediateRender: false }, .3);
  tl.to(k1, { opacity: 1, duration: .02, ease: E.enter }, .37);
  /* .52–.56: docked beside the watch card; .57–.72: the three lines tick; .76: ops lights */
  tl.add(Ravi.draw(W[3], .04, 1, 0), .52);
  chks.forEach(function (c, i) {
    var at = .57 + i * .06;
    tl.to(his[i], { opacity: 1, duration: .015, ease: E.enter }, at);
    tl.fromTo(c, { scale: 0, opacity: 0 }, { scale: 1, opacity: 1, ease: E.popHard, duration: .035, immediateRender: false }, at + .005);
  });
  tl.fromTo(glow, { opacity: 0 }, { opacity: 1, duration: .02, ease: E.enter, immediateRender: false }, .74).to(glow, { opacity: 0, duration: .08, ease: 'power1.in' }, .77);
  tl.to(his, { opacity: 0, duration: .04 }, .78);
  tl.to(N.ops, { scale: 1, '--lit': 1, ease: E.pop, duration: .05 }, .76);
  tl.to({}, { duration: .01 }, .99);

  /* the ticket: pops out of the page, steps into its lane, rides down past Ravi and docks by the watch card */
  var tkx = gsap.quickSetter(tk, 'x', 'px'), tky = gsap.quickSetter(tk, 'y', 'px'), tsx = gsap.quickSetter(tk, 'scaleX'), tsy = gsap.quickSetter(tk, 'scaleY'), tko = gsap.quickSetter(tk, 'opacity');
  var tks = function (v) { tsx(v); tsy(v); };
  var easeIO = gsap.parseEase('sine.inOut'), easePop = gsap.parseEase(E.pop), easeCut = gsap.parseEase(E.cut);
  function tick(t) {
    var x, y, s = 1, o = 1;
    if (t < .1) { o = 0; s = .4; x = g.pop.x; y = g.pop.y; }
    else if (t < .16) { var k = seg(t, .1, .16); o = clamp01(k * 3); s = lerp(.4, 1, easePop(k)); x = lerp(g.pop.x, g.lx, easeCut(k)); y = lerp(g.pop.y, g.yPage, easeCut(k)); }
    else if (t < .27) { x = g.lx; y = lerp(g.yPage, g.yRavi, easeIO(seg(t, .17, .27))); }
    else if (t < .4) { x = g.lx; y = g.yRavi; }
    else { x = g.lx; y = lerp(g.yRavi, g.yWatch, easeIO(seg(t, .4, .5))); }
    tkx(x); tky(y); tks(s); tko(o); tkShow(tk, shown() ? o : 0);
  }
  var cb = tl.eventCallback('onUpdate');
  tl.eventCallback('onUpdate', function () { if (cb) cb(); tick(tl.time()); });
  tick(tl.time());
  function remeasure() { measure(); }
  ST.addEventListener('refreshInit', remeasure);
  ctx.onRefresh(function () { tick(tl.time()); });
  ctx.add(function () { ST.removeEventListener('refreshInit', remeasure); });

  /* after the pin: ops's work card plays once on enter (2 s), then #finance rises. While it scrolls in, the card
     already shows what ops is looking at (the pill, the list and both rows) and ends just under the list, so it is
     never an empty frame; the play adds Carla, opens onto the note, then onto the card line */
  var wst = ctx.$('.wk-wst'), wstT = ctx.$('.wk-wst-t'), wl = ctx.$('.wk-wl');
  var newHi = ctx.$('.wk-wr--new .wk-wr-hi'), sv = ctx.$('.wk-sv--new'), svd = ctx.$('.wk-svd'), note = ctx.$('.wk-wnote');
  var wcard = ctx.$('.wk-wcard'), wct = ctx.$('.wk-wct'), mk = ctx.$('.wk-mk'), mi = ctx.$('.wk-mi'), wcs = ctx.$('.wk-wcs'), wcsT = ctx.$('.wk-wcs-t');
  var wchip = ctx.$('.wk-wchip'), work = ctx.$('.wk-work');
  function startTexts() {
    setText(wstT, TXT.look); wst.classList.remove('is-done');
    setText(sv, TXT.none); sv.classList.add('is-none');
    setText(wcsT, TXT.ready); wcs.classList.remove('is-done');
  }
  startTexts();
  gsap.set(wchip, { '--lit': 0 });
  gsap.set([note, wcard, wct, mi], { opacity: 0 });
  gsap.set(svd, { opacity: 1 });
  gsap.set(mk, { strokeDashoffset: 1 });
  gsap.set(wcs, { opacity: 0, scale: .6 });
  gsap.set(work, { '--cut': cutAt(work, wl)() });
  var wt = gsap.timeline({ paused: true });
  wt.to(wchip, { '--lit': 1, duration: .3, ease: E.enter }, 0);
  wt.add(rollTw(wstT, TXT.look, TXT.add, .35), .25);
  wt.add(rollTw(sv, TXT.none, TXT.carla, .35, function (on) { sv.classList.toggle('is-none', !on); }), .3);
  wt.to(svd, { opacity: 0, scale: .4, duration: .2, ease: E.exit }, .3);
  wt.fromTo(newHi, { opacity: 0 }, { opacity: 1, duration: .12, ease: E.enter }, .3).to(newHi, { opacity: 0, duration: .5, ease: 'power1.in' }, .48);
  wt.to(work, { '--cut': cutAt(work, note), duration: .3, ease: E.enter }, .72);
  wt.fromTo(note, { opacity: 0, y: 8 }, { opacity: 1, y: 0, duration: .35, ease: E.rise }, .78);
  wt.add(rollTw(wstT, TXT.add, TXT.write, .35), 1.08);
  wt.to(work, { '--cut': '0px', duration: .3, ease: E.enter }, 1.08);
  wt.to(wcard, { opacity: 1, duration: .2, ease: E.enter }, 1.14);
  wt.to(wct, { opacity: 1, duration: .2, ease: E.enter }, 1.2);
  wt.add(Ravi.draw(mk, .4, 1, 0), 1.22);
  wt.to(mi, { opacity: 1, duration: .25, ease: E.enter }, 1.45);
  wt.to(wcs, { opacity: 1, scale: 1, ease: E.pop, duration: .3 }, 1.6);
  wt.add(rollTw(wstT, TXT.write, TXT.posted, .3, function (on) { wst.classList.toggle('is-done', on); }), 1.9);
  wt.call(function () { setText(wcsT, TXT.postedOk); wcs.classList.add('is-done'); }, null, 1.9);
  wt.fromTo(wcs, { scale: 1 }, { keyframes: { scale: [1, 1.12, 1] }, duration: .3, ease: 'none', immediateRender: false }, 1.9);
  /* a resize before the play re-measures where the card ends */
  ctx.onRefresh(function () { if (wt.progress() === 0 && !wt.isActive()) gsap.set(work, { '--cut': cutAt(work, wl)() }); });
  /* it plays once the whole card is on screen (its rows and the card line too), or, where the card is taller than
     the visible area (landscape phones), once its middle is */
  ST.create({ trigger: work, once: true, onEnter: function () { wt.play(); },
    start: function () { return work.offsetHeight <= innerHeight * .96 - hdrBar() - 8 ? 'bottom 96%' : 'center 55%'; } });

  var fin = ctx.$('.wk-fin');
  var ft = gsap.timeline({ paused: true });
  ft.fromTo(ctx.$$('.wk-fin .av, .wk-fin .sk-meta'), { opacity: 0, y: 12 }, { opacity: 1, y: 0, ease: E.rise, duration: D.rise }, 0);
  ft.fromTo(ctx.$$('.wk-b'), { opacity: 0, y: 16 }, { opacity: 1, y: 0, ease: E.rise, duration: D.rise, stagger: .08 }, .08);
  ft.fromTo(ctx.$$('.wk-approve, .wk-decline'), { scale: .6 }, { scale: 1, ease: E.popHard, duration: D.pop, stagger: .08 }, .4);
  ST.create({ trigger: fin, start: 'top 85%', once: true, onEnter: function () { ft.play(); } });

  ctx.add(function () { wt.kill(); ft.kill(); clearDriven(tk); unroll([wstT, sv]); finalTexts(ctx); });
}

/* ---------- frames mode: time-based on-enter reveals, no pins ---------- */
function frames(ctx) {
  var gsap = G(), blocks = ctx.$$('.wk-ev>figcaption, .wk-node, .wk-ticket, .wk-cd>figcaption, .wk-work, .wk-fin');
  gsap.set(blocks, { opacity: 0, y: 24 });
  Ravi.ST.batch(blocks, { start: 'top 85%', once: true, onEnter: function (b) {
    gsap.to(b, { opacity: 1, y: 0, ease: E.rise, duration: D.rise, stagger: .06, overwrite: true });
  } });
}

Ravi.section('wake', { desk: desk, touch: touch, frames: frames });
} catch (err) { console.error('[section wake]', err); }
})();

/* ---- section click (05-click.js) ---- */
(function(){
'use strict';
try {
/* 05 · #click: one click closes the loop (unpinned, interactive).
   always: Approve / Decline (with a confirm alertdialog), Play it again, the static RESULT swap.
   desk + touch: on-enter reveal, the waiting state (ops's pill breathes "waiting for a click"), a one-time autoplay
   (Carla's cursor presses Approve), and the ~6 s branch: the click travels to ops's card → ops works through its
   three lines → it updates the card in #finance (the card collapses to the result, the thread reply) → done →
   a packet reaches Bruno's page, the dial ticks, the card moves to APPROVED → LOOP CLOSED.
   Every beat waits for its own block to reach 85% of the viewport (on touch, and on short desk screens where the
   page or the end row sits below the fold).
   frames: on-enter reveals of the static frames. reduce / no JS: the authored HTML is final (the card decided).
   Static with JS (reduce, frames): Play it again brings back the card's buttons, ops waiting and the page before
   (#click.is-try); Approve or Decline then decides all three frames at once, with no motion. */
var E = Ravi.E;
var G = function () { return Ravi.gsap; };
var SEC = null;
var S = { phase: 'wait', outcome: 'approve', touched: false, autoplayed: false, revealed: false,
  cur: null, run: null, reveals: [], bob: null, breath: null, auto: null, autoTl: null };

function q(s) { return SEC.querySelector(s); }
function qa(s) { return Array.prototype.slice.call(SEC.querySelectorAll(s)); }
function cssPx(name, fb) { var v = parseFloat(getComputedStyle(document.documentElement).getPropertyValue(name)); return isNaN(v) ? fb : v; }
function shown(el) { return !!(el && el.getClientRects().length); }
function said(o) { return (o === 'decline' ? 'Declined' : 'Approved') + ' by @Carla'; }

/* ---------- state that both static and motion share ---------- */
function applyOutcome(o) {
  var i = o === 'decline' ? 1 : 0;
  qa('[data-v]').forEach(function (el) { var v = el.getAttribute('data-v').split('|'); el.textContent = v[i] || v[0]; });
  if (i) SEC.setAttribute('data-outcome', 'decline'); else SEC.removeAttribute('data-outcome');
  S.outcome = o;
}
function setCounts(done) {
  var nr = q('.ck-nr'), no = q('.ck-no');
  if (nr) nr.textContent = done ? '0' : '1';
  if (no) no.textContent = done ? '1' : '0';
}
/* ops's pill: wait | work | done (no attribute = the authored "done") */
function ost(v) { if (v) SEC.setAttribute('data-ost', v); else SEC.removeAttribute('data-ost'); }
/* the waiting card's buttons leave the tab order once the card has become the result (a11y) */
function waitInert(on) { var w = q('.ck-wait'); if (!w) return; if (on) w.setAttribute('inert', ''); else w.removeAttribute('inert'); }

/* ---------- typing over wrapped rows (clip-path polygon, pure in progress) ---------- */
function measureRows(T) {
  var el = T.el, rg = document.createRange();
  rg.selectNodeContents(el);
  var b = el.getBoundingClientRect(), s = el.offsetWidth ? b.width / el.offsetWidth : 1, rects = rg.getClientRects(), rows = [];
  if (!s) s = 1;
  for (var i = 0; i < rects.length; i++) {
    var r = rects[i]; if (r.width < .5) continue;
    var t = (r.top - b.top) / s, bt = (r.bottom - b.top) / s, l = (r.left - b.left) / s, rt = (r.right - b.left) / s, m = (t + bt) / 2, row = null;
    for (var j = 0; j < rows.length; j++) if (Math.abs(rows[j].m - m) < 6) { row = rows[j]; break; }
    if (row) { row.l = Math.min(row.l, l); row.r = Math.max(row.r, rt); row.t = Math.min(row.t, t); row.b = Math.max(row.b, bt); }
    else rows.push({ l: l, r: rt, t: t, b: bt, m: m });
  }
  rows.sort(function (a, c) { return a.t - c.t; });
  T.cw = (parseFloat(getComputedStyle(el).fontSize) || 14) * .55;
  var tot = 0;
  rows.forEach(function (r) { r.n = Math.max(1, Math.round((r.r - r.l) / T.cw)); r.c0 = tot; tot += r.n; });
  T.rows = rows; T.total = tot;
}
function typeHead(T, p) {
  if (!T.rows || !T.rows.length) measureRows(T);
  var R = T.rows; if (!R.length) return null;
  var n = Math.round(p * T.total), k = 0;
  while (k < R.length - 1 && n > R[k].c0 + R[k].n) k++;
  var r = R[k], x = n >= T.total ? r.r : r.l + Math.min(r.n, Math.max(0, n - r.c0)) * T.cw;
  return { k: k, x: x, t: r.t, b: r.b };
}
function applyType(T, p) {
  p = p < 0 ? 0 : p > 1 ? 1 : p;
  if (T.p === p) return;
  T.p = p;
  var st = T.el.style;
  if (p <= 0) { st.clipPath = 'inset(0 100% 0 0)'; return; }
  if (p >= 1) { st.clipPath = ''; return; }
  var h = typeHead(T, p); if (!h) { st.clipPath = ''; return; }
  var top = h.k === 0 ? -4 : h.t, x = h.x.toFixed(1);
  st.clipPath = 'polygon(-4px -4px, calc(100% + 4px) -4px, calc(100% + 4px) ' + top + 'px, ' + x + 'px ' + top + 'px, ' + x + 'px ' + (h.b + 2) + 'px, -4px ' + (h.b + 2) + 'px)';
}
/* one of ops's lines types at `at` over `dur`; its empty slot gives way as it starts */
function typeOl(tl, li, at, dur) {
  var el = li.querySelector('.ck-olt'); if (!el) return;
  var T = { el: el, rows: null, p: -1 }, o = { p: 0 };
  tl.call(function () { T.rows = null; T.p = -1; applyType(T, 0); }, null, at);
  tl.set(el, { opacity: 1 }, at);
  tl.fromTo(li, { '--ph': 1 }, { '--ph': 0, duration: .15, ease: E.exit, immediateRender: false }, at);
  tl.fromTo(o, { p: 0 }, { p: 1, duration: dur, ease: 'none', immediateRender: false,
    onUpdate: function () { applyType(T, o.p); }, onComplete: function () { applyType(T, 1); } }, at);
}

/* ---------- geometry: packets and the loop line ---------- */
function rel(el, S0) { var r = el.getBoundingClientRect(); return { l: r.left - S0.left, t: r.top - S0.top, r: r.right - S0.left, b: r.bottom - S0.top, w: r.width, h: r.height }; }
function rounded(pts, rad) {
  pts = pts.filter(function (p, i) { return !i || Math.abs(p.x - pts[i - 1].x) + Math.abs(p.y - pts[i - 1].y) > .5; });
  var d = 'M' + pts[0].x.toFixed(1) + ' ' + pts[0].y.toFixed(1);
  for (var i = 1; i < pts.length - 1; i++) {
    var a = pts[i - 1], b = pts[i], c = pts[i + 1];
    var l1 = Math.hypot(b.x - a.x, b.y - a.y), l2 = Math.hypot(c.x - b.x, c.y - b.y), k = Math.min(rad, l1 / 2, l2 / 2);
    var p1x = b.x + (a.x - b.x) / l1 * k, p1y = b.y + (a.y - b.y) / l1 * k, p2x = b.x + (c.x - b.x) / l2 * k, p2y = b.y + (c.y - b.y) / l2 * k;
    d += ' L' + p1x.toFixed(1) + ' ' + p1y.toFixed(1) + ' Q' + b.x.toFixed(1) + ' ' + b.y.toFixed(1) + ' ' + p2x.toFixed(1) + ' ' + p2y.toFixed(1);
  }
  var e = pts[pts.length - 1];
  return d + ' L' + e.x.toFixed(1) + ' ' + e.y.toFixed(1);
}
/* desk: Bruno's card ↓ end row ← gutter between the card column and ops's column ↑ result line ← into the Slack window */
function measureLoop() {
  var stage = q('.ck-stage'), path = q('.ck-wloop'), lc = q('.ck-lc'), sq = q('.ck-lsq');
  if (!S.cur || !S.cur.desk) { lc.style.left = lc.style.top = lc.style.width = lc.style.height = ''; return; }
  var S0 = stage.getBoundingClientRect();
  var out = rel(q('.ck-br .ck-bc-out'), S0), end = rel(q('.ck-end'), S0), c1 = rel(q('.ck-c1'), S0), c2 = rel(q('.ck-ops'), S0);
  var win = rel(q('.ck-win'), S0), res = rel(q('.ck-res-t'), S0);
  var ax = out.l + out.w / 2, ay = out.b, ye = end.t + end.h / 2, xg = (c1.r + c2.l) / 2, yr = res.t + res.h / 2, xw = win.r;
  path.setAttribute('d', rounded([{ x: ax, y: ay }, { x: ax, y: ye }, { x: xg, y: ye }, { x: xg, y: yr }, { x: xw, y: yr }], 14));
  /* the label sits centred on the line's bottom run, on whole pixels with a whole-pixel size: a fractional
     edge let the page grid show through as a hairline along its bottom and right */
  lc.style.width = lc.style.height = '';
  var lr = lc.getBoundingClientRect(), lw = Math.ceil(lr.width), lh = Math.ceil(lr.height), cx = (xg + ax) / 2;
  lc.style.width = lw + 'px'; lc.style.height = lh + 'px';
  lc.style.left = (Math.round(S0.left + cx - lw / 2) - S0.left).toFixed(3) + 'px';
  lc.style.top = (Math.round(S0.top + ye - lh / 2) - S0.top).toFixed(3) + 'px';
  sq.style.left = xw.toFixed(1) + 'px'; sq.style.top = yr.toFixed(1) + 'px';
}
function measure() { try { measureLoop(); } catch (e) {} }

/* ---------- the card's height: the result is shorter than the waiting card ----------
   #click.is-res takes the waiting blocks out of flow, so the #finance window fits the result. flipPlan measures
   (without painting) what toggling it does: how much the window's height changes and how far each block below
   it moves. The change itself is animated with clip-path on the window and transforms on the blocks. */
var MOVERS = '.ck-steps, .ck-ops, .ck-caut, .ck-br, .ck-end';
function flipPlan(on) {
  var win = q('.ck-win'), els = qa(MOVERS).filter(shown);
  var h0 = win.offsetHeight, t0 = els.map(function (e) { return e.getBoundingClientRect().top; });
  SEC.classList.toggle('is-res', on);
  var h1 = win.offsetHeight, t1 = els.map(function (e) { return e.getBoundingClientRect().top; });
  SEC.classList.toggle('is-res', !on);
  return { dh: h0 - h1, moves: els.map(function (e, i) { return { el: e, dy: t1[i] - t0[i] }; }).filter(function (m) { return Math.abs(m.dy) > .5; }) };
}
function winClip(px) { return 'inset(0px 0px ' + Math.max(0, px).toFixed(1) + 'px 0px round 8px)'; }
/* tween the window's bottom clip from a to b px. Through a number, not the string: the browser shortens
   inset(0px 0px 0px 0px …) to inset(0px …), and a string tween between different shapes only jumps at the end */
function clipTween(t, win, a, b, dur) {
  var o = { v: a };
  win.style.clipPath = winClip(a);
  t.to(o, { v: b, duration: dur, ease: E.wipe, onUpdate: function () { win.style.clipPath = winClip(o.v); } }, 0);
}
/* the window's bottom edge rises to the result's height and the blocks below glide up with it */
function shrinkCard(R, dur) {
  var gsap = G(), win = q('.ck-win'), P = flipPlan(true);
  if (P.dh < 1) { SEC.classList.add('is-res'); return; }
  var t = gsap.timeline({ onComplete: function () {
    SEC.classList.add('is-res');
    gsap.set(win, { clearProps: 'clipPath' });
    P.moves.forEach(function (m) { gsap.set(m.el, { clearProps: 'transform' }); });
    measure();
    Ravi.refresh();                         /* the page got shorter: later sections' triggers move up */
  } });
  clipTween(t, win, 0, P.dh, dur);
  P.moves.forEach(function (m) { t.fromTo(m.el, { y: 0 }, { y: m.dy, duration: dur, ease: E.wipe }, 0); });
  R.tls.push(t);
}
/* a packet route between two boxes: across when they sit side by side, down (or up) when stacked */
function route(a, b, ay) {
  var stage = q('.ck-stage'), path = q('.ck-wpk'), S0 = stage.getBoundingClientRect();
  var A = rel(a, S0), B = rel(b, S0), d, p0, p1;
  if (B.l > A.r - 4 || A.l > B.r - 4) {
    var right = B.l > A.r - 4;
    p0 = [right ? A.r : A.l, ay != null ? ay : A.t + A.h / 2];
    p1 = [right ? B.l : B.r, B.t + Math.min(B.h / 2, 44)];
    if (a.classList.contains('bk-btn')) p0 = [A.l + A.w / 2, A.t + A.h / 2];
    var dx = (p1[0] - p0[0]) * .5;
    d = 'M' + p0[0] + ' ' + p0[1] + ' C' + (p0[0] + dx) + ' ' + p0[1] + ' ' + (p1[0] - dx) + ' ' + p1[1] + ' ' + p1[0] + ' ' + p1[1];
  } else {
    var down = B.t > A.t;
    p0 = [A.l + Math.min(A.w / 2, 120), down ? A.b : A.t];
    p1 = [B.l + Math.min(B.w / 2, 120), down ? B.t : B.b];
    if (a.classList.contains('bk-btn')) p0 = [A.l + A.w / 2, A.b];
    var dy = (p1[1] - p0[1]) * .5;
    d = 'M' + p0[0] + ' ' + p0[1] + ' C' + p0[0] + ' ' + (p0[1] + dy) + ' ' + p1[0] + ' ' + (p1[1] - dy) + ' ' + p1[0] + ' ' + p1[1];
  }
  path.setAttribute('d', d);
  try { return Ravi.samplePath(path, 48); } catch (e) { return null; }
}

/* ---------- the branch ---------- */
var CLEAR = 'opacity,visibility,transform,clipPath,strokeDashoffset';
var VARS = ['--lit', '--on', '--ph', 'translate', 'rotate', 'scale'];
function clearAnim() {
  var g = G(); if (!g || !SEC) return;
  var els = qa('.ck-stage [style]').filter(function (el) { return !el.closest('.chip > i'); });
  if (els.length) g.set(els, { clearProps: CLEAR });
  els.forEach(function (el) { VARS.forEach(function (p) { el.style.removeProperty(p); }); if (!el.getAttribute('style')) el.removeAttribute('style'); });
  qa('.ck-olt').forEach(function (c) { c.style.clipPath = ''; });
}
/* a step lights: its mint rule draws, its text brightens; lit steps stay lit until Play it again */
function lightStep(tl, i, at) {
  var st = qa('.ck-step')[i]; if (!st) return;
  tl.call(function () { st.classList.add('is-lit'); }, null, at);
  tl.fromTo(st, { '--on': 0 }, { '--on': 1, duration: .45, ease: E.enter, immediateRender: false }, at);
}
function forceReveals() {
  S.reveals.forEach(function (t) { try { if (t.scrollTrigger) t.scrollTrigger.kill(); t.progress(1); } catch (e) {} });
  S.reveals = [];
  S.revealed = true;
}
function inGate(el) { return !el || (S.run && S.run.open) || el.getBoundingClientRect().top < innerHeight * .85; }
function watchGate(R) {
  if (R.onScroll) return;
  R.onScroll = function () {
    R.wait = R.wait.filter(function (w) { if (!inGate(w.el)) return true; w.fn(); return false; });
    if (!R.wait.length) unwatch(R);
  };
  addEventListener('scroll', R.onScroll, { passive: true });
  addEventListener('resize', R.onScroll);
}
function unwatch(R) {
  if (!R.onScroll) return;
  removeEventListener('scroll', R.onScroll); removeEventListener('resize', R.onScroll);
  R.onScroll = null;
}
/* one packet hop: the dashed route flashes, the dot travels, then fades */
function hop(tl, at, a, b, dur, ay) {
  var gsap = G(), pk = q('.ck-pk'), wpk = q('.ck-wpk'), pts = null;
  tl.call(function () { pts = route(a, b, ay); }, null, at);
  tl.set(pk, { autoAlpha: 1 }, at);
  tl.fromTo(wpk, { opacity: 0 }, { opacity: .8, duration: .12, ease: E.enter, immediateRender: false }, at)
    .to(wpk, { opacity: 0, duration: .25, ease: E.exit }, at + dur - .05);
  var o = { t: 0 }, sx = gsap.quickSetter(pk, 'x', 'px'), sy = gsap.quickSetter(pk, 'y', 'px');
  tl.fromTo(o, { t: 0 }, { t: 1, duration: dur, ease: E.cut, immediateRender: false, onUpdate: function () {
    if (!pts || pts.length < 2) return;
    var f = o.t * (pts.length - 1), i = Math.min(f | 0, pts.length - 2), k = f - i;
    sx(pts[i].x + (pts[i + 1].x - pts[i].x) * k); sy(pts[i].y + (pts[i + 1].y - pts[i].y) * k);
  } }, at);
  tl.to(pk, { autoAlpha: 0, duration: .15, ease: E.exit }, at + dur);
}

function runBranch(o, auto) {
  var gsap = G();
  S.phase = 'run';
  forceReveals();
  if (S.bob) S.bob.pause();
  if (S.breath) { S.breath.pause(); gsap.set(q('.ck-ost-d'), { clearProps: 'opacity' }); }
  measure();
  var R = S.run = { calls: [], tls: [], wait: [], onScroll: null, done: 0, dead: false, open: false };
  /* Play it again stays in the tab order while the branch plays (#click.is-run: no pointer, no paint until it has
     focus), so a keyboard visitor reaches it from the result card before the end row has been scrolled to */
  SEC.classList.add('is-run');

  var btn = q(o === 'decline' ? '.ck-decline' : '.ck-approve');
  var bub = q('.ck-bub'), ops = q('.ck-ops'), br = q('.ck-br'), win = q('.ck-win'), end = q('.ck-end');
  var ols = qa('.ck-ol'), glow = q('.ck-oglow'), chip = q('.ck-ochip'), pill = q('.ck-ost');

  var BEATS = [
    { t: 0, el: null, fn: function (tl) {                 /* 01 the click travels to ops */
      if (!auto) tl.add(Ravi.press(btn), 0);
      tl.to(bub, { opacity: 0, scale: .92, duration: .2, ease: E.exit }, 0);
      lightStep(tl, 0, 0);
      hop(tl, .05, btn, ops, .5);
    } },
    { t: .55, el: ops, fn: function (tl) {                /* 02 ops works through its three lines */
      tl.call(function () { ost('work'); }, null, 0);
      tl.fromTo(pill, { scale: .9 }, { scale: 1, duration: .35, ease: E.pop, immediateRender: false }, 0);
      tl.fromTo(glow, { opacity: 0 }, { opacity: 1, duration: .15, ease: E.enter }, 0).to(glow, { opacity: 0, duration: .6, ease: 'power1.in' }, .4);
      tl.fromTo(chip, { '--lit': 0, scale: .94 }, { '--lit': 1, scale: 1, duration: .35, ease: E.pop, immediateRender: false }, 0);
      typeOl(tl, ols[0], .1, .35);
      tl.fromTo(q('.ck-ok'), { opacity: 0, scale: .4 }, { opacity: 1, scale: 1, duration: .4, ease: E.pop, immediateRender: false }, .45);
      typeOl(tl, ols[1], .55, .35);
      typeOl(tl, ols[2], .95, .35);
      lightStep(tl, 1, .1);
    } },
    { t: 1.85, el: win, fn: function (tl) {               /* the card in #finance becomes the result; the thread reply */
      var wait = q('.ck-wait'), done = q('.ck-done');
      hop(tl, 0, ops, win, .4, ops.getBoundingClientRect().top - q('.ck-stage').getBoundingClientRect().top + ops.offsetHeight * .78);
      tl.set(done, { visibility: 'visible' }, .3);
      tl.fromTo(wait, { clipPath: 'inset(0% 0% 0% 0%)' }, { clipPath: 'inset(100% 0% 0% 0%)', duration: .45, ease: E.wipe, immediateRender: false }, .3);
      tl.call(function () { shrinkCard(R, .5); }, null, .4);
      tl.call(function () {
        if (wait.contains(document.activeElement)) done.focus({ preventScroll: true });
        waitInert(true);
        Ravi.announce(said(o));
      }, null, .5);
      tl.fromTo([q('.ck-res-t'), q('.ck-res-c')], { opacity: 0, y: 8 }, { opacity: 1, y: 0, duration: .45, ease: E.rise, stagger: .08 }, .5);
      tl.fromTo(q('.ck-done .ck-thr-l'), { opacity: 0, scale: .8 }, { opacity: 1, scale: 1, duration: .4, ease: E.pop }, .85);
      tl.fromTo(q('.ck-done .ck-reply'), { clipPath: 'inset(0% 0% 100% 0%)' }, { clipPath: 'inset(0% 0% 0% 0%)', duration: .4, ease: E.wipe }, 1.0);
    } },
    { t: 3.15, el: ops, fn: function (tl) {               /* ops is done */
      tl.call(function () { ost('done'); }, null, 0);
      tl.fromTo(pill, { scale: .85 }, { scale: 1, duration: .45, ease: E.popHard, immediateRender: false }, 0);
    } },
    { t: 3.35, el: br, fn: function (tl) {                /* 03 Bruno's page refreshes */
      var req = q('.ck-br .ck-bc-req'), out = q('.ck-br .ck-bc-out');
      hop(tl, 0, ops, br, .5);
      /* the page refreshes: a teal ring lights round the browser and fades (the page itself is never dimmed, so its
         text keeps its contrast while it waits) */
      var ring = q('.ck-br .ck-bring');
      if (ring) tl.fromTo(ring, { opacity: 0 }, { opacity: 1, duration: .2, ease: E.enter, immediateRender: false }, .4)
        .to(ring, { opacity: 0, duration: .7, ease: 'power1.in' }, 1.25);
      tl.fromTo(q('.ck-hand'), { rotation: 0 }, { rotation: 360, svgOrigin: '8 8', duration: .8, ease: 'power1.inOut' }, .45);
      /* the card moves from REQUESTED to APPROVED (or DECLINED): a FLIP from where it was */
      tl.call(function () { setCounts(true); }, null, 1.0);
      tl.set(req, { visibility: 'hidden' }, 1.0);
      tl.set(out, { visibility: 'visible' }, 1.0);
      tl.fromTo(out, {
        x: function () { return req.getBoundingClientRect().left - out.getBoundingClientRect().left; },
        y: function () { return req.getBoundingClientRect().top - out.getBoundingClientRect().top; }
      }, { x: 0, y: 0, duration: .6, ease: E.cut, immediateRender: false }, 1.0);
      tl.fromTo(out, { scale: 1 }, { keyframes: { scale: [1, 1.04, 1] }, duration: .6, ease: 'none', immediateRender: false }, 1.0);
      lightStep(tl, 2, 1.0);
    } },
    { t: 5.0, el: end, fn: function (tl) {                /* the loop closes */
      var lc = q('.ck-lc'), again = q('.ck-again'), desk = S.cur && S.cur.desk, lcAt = desk ? .4 : .05;
      measure();
      if (desk) {
        tl.add(Ravi.draw(q('.ck-wloop'), .8, 1, 0), 0);
        tl.fromTo(q('.ck-lsq'), { scale: 0 }, { scale: 1, duration: .4, ease: E.popHard, immediateRender: false }, .75);
      } else {
        tl.fromTo(q('.ck-ul'), { scaleX: 0 }, { scaleX: 1, duration: .5, ease: E.wipe, immediateRender: false }, .2);
      }
      tl.to(lc, { opacity: 1, duration: .2, ease: E.enter }, lcAt);
      tl.call(function () { Ravi.scramble(lc, null, .4); }, null, lcAt);
      tl.to(again, { autoAlpha: 1, duration: .35, ease: E.enter }, 1.0);
      tl.call(function () { SEC.classList.add('is-again'); }, null, 1.0);   /* takes a pointer as it shows */
      tl.call(function () { Ravi.announce('Loop closed'); }, null, 1.0);
      tl.to({}, { duration: .1 }, 1.25);
    } }
  ];

  function fin() { if (!R.dead && ++R.done === BEATS.length) commit(); }
  function runBeat(i) {
    var B = BEATS[i];
    function go() {
      if (R.dead) return;
      var tl = gsap.timeline({ onComplete: fin });
      R.tls.push(tl);
      try { B.fn(tl); } catch (e) { try { console.error('[section click]', e); } catch (_) {} }
      if (i + 1 < BEATS.length) R.calls.push(gsap.delayedCall(BEATS[i + 1].t - B.t, function () { runBeat(i + 1); }));
    }
    if (inGate(B.el)) go(); else { R.wait.push({ el: B.el, fn: go }); watchGate(R); }
  }
  runBeat(0);
}

/* end of the branch (or forced): rest on the authored final state, inline styles cleared */
function commit() {
  var R = S.run; if (!R) return;
  R.dead = true; S.run = null;
  R.calls.forEach(function (c) { c.kill(); });
  R.tls.forEach(function (t) { t.kill(); });
  unwatch(R);
  S.phase = 'done';
  SEC.classList.remove('is-run', 'is-again');
  var resized = !SEC.classList.contains('is-res');
  SEC.classList.add('is-done', 'is-res');
  ost('done');
  waitInert(true);
  setCounts(true);
  clearAnim();
  measure();
  if (resized) Ravi.refresh();
}

/* Play it again: a .4 s fade back to the waiting values, then the waiting state */
function reset() {
  var gsap = G();
  if (S.phase !== 'done' || !gsap || !S.cur) return;
  S.phase = 'resetting';
  /* the waiting blocks come back into flow: the window grows back from the result's height (clip-path) and
     the blocks below glide down to their new places */
  var P = flipPlan(false), win = q('.ck-win');
  SEC.classList.remove('is-res');
  var desk = S.cur.desk, tl = gsap.timeline({ onComplete: function () {
    SEC.classList.remove('is-done', 'is-res');
    clearAnim();
    applyOutcome('approve');
    setCounts(false);
    ost('wait');
    S.phase = 'wait';
    qa('.ck-step.is-lit').forEach(function (s) { s.classList.remove('is-lit'); });
    gsap.fromTo([q('.ck-wait'), q('.ck-br .ck-bc-req'), q('.ck-bub'), q('.ck-ost')], { opacity: 0 },
      { opacity: 1, duration: .25, ease: E.enter, clearProps: 'opacity' });
    if (S.bob) S.bob.play();
    if (S.breath) S.breath.play();
    measure();
    Ravi.refresh();                         /* the card is back to its waiting height */
    waitInert(false);
    var ap = q('.ck-approve'); if (ap) ap.focus({ preventScroll: true });
  } });
  var d = .4;
  if (P.dh < -1) {
    clipTween(tl, win, -P.dh, 0, d);
    P.moves.forEach(function (m) { tl.fromTo(m.el, { y: -m.dy }, { y: 0, duration: d, ease: E.wipe }, 0); });
  }
  tl.to([q('.ck-done'), q('.ck-br .ck-bc-out'), q('.ck-again'), q('.ck-lc'), q('.ck-ost')], { opacity: 0, duration: d * .6, ease: E.exit }, 0);
  tl.to(qa('.ck-olt'), { opacity: 0, duration: d * .6, ease: E.exit }, 0);
  tl.fromTo(qa('.ck-ol'), { '--ph': 0 }, { '--ph': 1, duration: d, ease: E.enter }, 0);
  tl.to(q('.ck-ok'), { opacity: 0, scale: .4, duration: d * .6, ease: E.exit }, 0);
  tl.fromTo(q('.ck-ochip'), { '--lit': 1 }, { '--lit': 0, duration: d, ease: E.enter }, 0);
  tl.fromTo(qa('.ck-step'), { '--on': 1 }, { '--on': 0, duration: d, ease: E.enter }, 0);
  if (desk) {
    tl.fromTo(q('.ck-wloop'), { strokeDashoffset: 0 }, { strokeDashoffset: 1, duration: d, ease: E.wipe, autoRound: false }, 0);
    tl.to(q('.ck-lsq'), { scale: 0, duration: d * .6, ease: E.exit }, 0);
  } else {
    tl.fromTo(q('.ck-ul'), { scaleX: 1 }, { scaleX: 0, duration: d, ease: E.wipe }, 0);
  }
}

/* ---------- autoplay: once, after a still look at the whole card ---------- */
function stopAuto() {
  if (S.auto) { S.auto.stop(); S.auto = null; }
  if (S.autoTl && S.phase === 'wait') { S.autoTl.kill(); S.autoTl = null; var g = G(); if (g) g.set(q('.ck-cur'), { clearProps: CLEAR }); }
}
function setupAuto(ctx) {
  if (S.autoplayed || S.touched || S.phase !== 'wait' || !('IntersectionObserver' in window)) return;
  var win = ctx.$('.ck-win'), timer = null, ms = ctx.desk ? 4000 : 2500;
  var top = cssPx('--hdr', ctx.desk ? 64 : 52) + cssPx('--bar', 0);
  var io = new IntersectionObserver(function (es) {
    var e = es[es.length - 1];
    if (e.intersectionRatio >= .9) { if (!timer) timer = setTimeout(fire, ms); }
    else { clearTimeout(timer); timer = null; }
  }, { rootMargin: '-' + Math.round(top) + 'px 0px 0px 0px', threshold: [0, .5, .9, 1] });
  io.observe(win);
  S.auto = { stop: function () { clearTimeout(timer); io.disconnect(); } };
}
/* where Carla's cursor appears: a spot inside the #finance window where the arrow and its name pill cover no
   words and no button (beside the header line, or right of the bubble), not too close to Approve so the move reads.
   Falls back to the window's top-right corner, clamped inside the window. */
function curStart(cur, stage, btn) {
  var S0 = stage.getBoundingClientRect(), W = rel(q('.ck-win'), S0), B = rel(btn, S0);
  var nm = cur.querySelector('.cur-name'), sv = cur.querySelector('svg');
  var cw = Math.max(sv ? sv.getBoundingClientRect().width : 24, nm ? 14 + nm.getBoundingClientRect().width : 64);
  var ch = Math.max(sv ? sv.getBoundingClientRect().height : 34, nm ? 30 + nm.getBoundingClientRect().height : 50);
  var hd = q('.ck-win .sk-hd'), top = W.t + (hd ? hd.offsetHeight : 40) + 8, pad = 6, boxes = [];
  var rg = document.createRange(), tw = document.createTreeWalker(q('.ck-win .sk-msgs'), NodeFilter.SHOW_TEXT);
  for (var n = tw.nextNode(); n; n = tw.nextNode()) {
    if (!n.nodeValue.trim() || !n.parentElement.getClientRects().length) continue;
    rg.selectNodeContents(n);
    Array.prototype.forEach.call(rg.getClientRects(), function (r) { if (r.width > .5) boxes.push(rel({ getBoundingClientRect: function () { return r; } }, S0)); });
  }
  qa('.ck-wait .bk-btn, .ck-bub-in, .ck-win .av').forEach(function (e) { if (shown(e)) boxes.push(rel(e, S0)); });
  var want = { x: B.r + 120, y: B.t - 70 }, best = null, bd = Infinity;
  for (var y = top; y <= W.b - ch - 8; y += 4) {
    for (var x = W.l + 12; x <= W.r - cw - 12; x += 4) {
      var hit = boxes.some(function (b) { return x < b.r + pad && x + cw > b.l - pad && y < b.b + pad && y + ch > b.t - pad; });
      if (hit || Math.hypot(x - B.l, y - B.t) < 110) continue;
      var d = Math.hypot(x - want.x, y - want.y);
      if (d < bd) { bd = d; best = { x: x, y: y }; }
    }
  }
  return best || { x: Math.max(W.l + 12, W.r - cw - 12), y: top };
}
function fire() {
  var gsap = G();
  if (S.auto) { S.auto.stop(); S.auto = null; }
  if (S.touched || S.phase !== 'wait' || S.autoplayed || !S.cur || !gsap) return;
  if (q('.ck-dlg') && !q('.ck-dlg').hidden) return;
  S.autoplayed = true;
  var cur = q('.ck-cur'), stage = q('.ck-stage'), btn = q('.ck-approve');
  var st0 = curStart(cur, stage, btn);
  var tl = S.autoTl = gsap.timeline({ onComplete: function () { gsap.set(cur, { clearProps: CLEAR }); S.autoTl = null; } });
  tl.set(cur, { x: st0.x, y: st0.y, autoAlpha: 0 });
  tl.to(cur, { autoAlpha: 1, duration: .25, ease: E.enter });
  tl.add(Ravi.cursorTo(cur, btn, stage, .7), .1);
  tl.add(Ravi.ripple(cur), .8);
  tl.add(Ravi.press(btn), .8);
  tl.call(function () { S.autoTl = null; act('approve', true); S.autoTl = tl; }, null, .86);
  tl.to(cur, { autoAlpha: 0, duration: .3, ease: E.exit }, 1.8);
}

/* ---------- static with JS: decide all three frames at once, or bring the buttons back ---------- */
function staticTry() {
  applyOutcome('approve');
  SEC.classList.add('is-try');
  waitInert(false);
  ost('wait');
  setCounts(false);
  /* on a phone the card is screens above this button: bring it under the header (an instant jump, no motion) */
  var win = q('.ck-win'), r = win.getBoundingClientRect(), top = cssPx('--hdr', 52) + cssPx('--bar', 0) + 16;
  if (r.top < top || r.bottom > innerHeight) Ravi.scrollToY(scrollY + r.top - top);
  var ap = q('.ck-approve'); if (ap) ap.focus({ preventScroll: true });
}
function staticDecide(o) {
  var win = q('.ck-win'), had = win.contains(document.activeElement);
  applyOutcome(o);
  SEC.classList.remove('is-try');
  ost(null);
  setCounts(true);
  /* the pressed button is gone: focus lands on the result that replaced it */
  if (had || document.activeElement === document.body) { var d = q('.ck-done'); if (d) d.focus({ preventScroll: true }); }
  Ravi.announce(said(o) + ". Bruno's page shows " + (o === 'decline' ? 'Declined.' : 'Approved.'));
}

/* ---------- actions ---------- */
function touched() { S.touched = true; stopAuto(); }
function act(o, auto) {
  if (!auto) touched();
  if (Ravi.motion && S.cur && G()) {
    if (S.phase !== 'wait') return;
    applyOutcome(o);
    runBranch(o, auto);
  } else staticDecide(o);
}
function again() {
  if (!(Ravi.motion && S.cur && G())) { staticTry(); return; }
  if (S.phase === 'run') commit();            /* pressed (by keyboard) before the branch ended: rest on its end first */
  reset();
}
/* Play it again got focus while the branch still plays: it shows at once, and the beats still waiting for their
   block to scroll into view play on their own clock from here (focus has just brought the end row near) */
function againFocus() {
  var R = S.run; if (!R || S.phase !== 'run') return;
  SEC.classList.add('is-again');
  R.open = true;
  if (R.onScroll) R.onScroll();
}
function openDlg() {
  if (Ravi.motion && S.cur && S.phase !== 'wait') return;
  touched();
  var win = q('.ck-win'), dlg = q('.ck-dlg'), main = q('.ck-win .sk-main'), g = G();
  dlg.hidden = false; win.classList.add('is-dlg');
  if (main) main.setAttribute('inert', '');
  if (Ravi.motion && g) {
    g.fromTo(dlg, { opacity: 0, scale: .96 }, { opacity: 1, scale: 1, duration: .3, ease: E.popSoft, clearProps: 'opacity,transform' });
    g.fromTo(q('.ck-dim'), { opacity: 0 }, { opacity: 1, duration: .25, ease: E.enter, clearProps: 'opacity' });
  }
  q('.ck-cancel').focus({ preventScroll: true });
}
function closeDlg(refocus) {
  var dlg = q('.ck-dlg'), main = q('.ck-win .sk-main');
  if (dlg.hidden) return;
  dlg.hidden = true; q('.ck-win').classList.remove('is-dlg');
  if (main) main.removeAttribute('inert');
  if (refocus) q('.ck-decline').focus({ preventScroll: true });
}

function always(c) {
  SEC = c.el;
  var stage = q('.ck-stage'), dlg = q('.ck-dlg');
  c.on(q('.ck-approve'), 'click', function () { act('approve'); });
  c.on(q('.ck-decline'), 'click', openDlg);
  c.on(q('.ck-cancel'), 'click', function () { closeDlg(true); });
  c.on(q('.ck-dim'), 'click', function () { closeDlg(true); });
  c.on(q('.ck-confirm'), 'click', function () { closeDlg(true); act('decline'); });
  c.on(dlg, 'keydown', function (e) {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeDlg(true); return; }
    if (e.key === 'Tab') {
      var f = [q('.ck-cancel'), q('.ck-confirm')], i = f.indexOf(document.activeElement);
      e.preventDefault();
      f[(i + (e.shiftKey ? -1 : 1) + f.length) % f.length].focus();
    }
  });
  c.on(q('.ck-again'), 'click', again);
  c.on(q('.ck-again'), 'focus', againFocus);
  /* the disabled "Open requests" explains itself; Esc dismisses the tip */
  var ow = q('.ck-open-w'), ob = q('.ck-open');
  c.on(ob, 'click', function (e) { e.preventDefault(); ow.classList.remove('is-off'); });
  c.on(ob, 'keydown', function (e) { if (e.key === 'Escape') ow.classList.add('is-off'); });
  c.on(ob, 'blur', function () { ow.classList.remove('is-off'); });
  c.on(ow, 'mouseleave', function () { ow.classList.remove('is-off'); });
  c.on(document, 'keydown', function (e) { if (e.key === 'Escape' && ow.matches(':hover')) ow.classList.add('is-off'); });
  /* any hand on the stage cancels the autoplay */
  c.on(stage, 'pointerdown', function () { if (!S.touched) touched(); });
  c.on(stage, 'focusin', function () { if (!S.touched) touched(); });
}

/* ---------- desk + touch ---------- */
function motionBuild(ctx) {
  var gsap = G();
  S.cur = { desk: ctx.desk, touch: ctx.touch };
  SEC.classList.remove('is-try');
  if (S.phase === 'resetting') { S.phase = 'done'; SEC.classList.add('is-res'); }
  if (S.phase === 'wait') { applyOutcome('approve'); setCounts(false); ost('wait'); waitInert(false); }
  else { ost('done'); waitInert(true); }
  ctx.onRefresh(measure);
  measure();

  /* on-enter reveal (once): the card's blocks rise, ops's card and Bruno's page follow, the bubble pops */
  var bub = ctx.$('.ck-bub');
  function bubPop(tl, at) { tl.fromTo(bub, { opacity: 0, scale: .6 }, { opacity: 1, scale: 1, duration: .45, ease: E.pop, clearProps: 'opacity' }, at); }
  if (!S.revealed && S.phase === 'wait') {
    var mark = function () { S.revealed = true; };
    if (ctx.desk) {
      var tl = gsap.timeline({ scrollTrigger: { trigger: ctx.$('.ck-stage'), start: 'top 65%', once: true, onEnter: mark } });
      tl.fromTo(ctx.$$('.ck-win .ck-b'), { opacity: 0, y: 24 }, { opacity: 1, y: 0, duration: .65, ease: E.rise, stagger: .06, clearProps: 'opacity,transform' }, 0);
      [['.ck-ops', .12], ['.ck-caut', .24], ['.ck-br', .3]].forEach(function (p) {
        var el = ctx.$(p[0]), to = parseFloat(getComputedStyle(el).opacity);
        tl.fromTo(el, { opacity: 0, y: 24 }, { opacity: isNaN(to) ? 1 : to, y: 0, duration: .65, ease: E.rise, clearProps: 'opacity,transform' }, p[1]);
      });
      tl.fromTo(ctx.$$('.ck-ol'), { '--ph': 0 }, { '--ph': 1, duration: .4, ease: E.enter, stagger: .08, clearProps: '--ph' }, .4);
      tl.fromTo(ctx.$('.ck-steps'), { opacity: 0, y: 24 }, { opacity: 1, y: 0, duration: .65, ease: E.rise, clearProps: 'opacity,transform' }, .3);
      bubPop(tl, .45);
      S.reveals.push(tl);
    } else {
      ['.ck-win', '.ck-ops', '.ck-br', '.ck-steps', '.ck-caut'].forEach(function (s) {
        var el = ctx.$(s); if (!el) return;
        var to = parseFloat(getComputedStyle(el).opacity) || 1;
        var t = gsap.timeline({ scrollTrigger: { trigger: el, start: 'top 85%', once: true, onEnter: s === '.ck-win' ? mark : null } });
        t.fromTo(el, { opacity: 0, y: 24 }, { opacity: to, y: 0, duration: .65, ease: E.rise, clearProps: 'opacity,transform' }, 0);
        if (s === '.ck-win') {
          t.fromTo(ctx.$$('.ck-win .ck-b'), { opacity: 0, y: 12 }, { opacity: 1, y: 0, duration: .5, ease: E.rise, stagger: .06, clearProps: 'opacity,transform' }, .1);
          bubPop(t, .45);
        }
        if (s === '.ck-ops') t.fromTo(ctx.$$('.ck-ol'), { '--ph': 0 }, { '--ph': 1, duration: .4, ease: E.enter, stagger: .08, clearProps: '--ph' }, .25);
        S.reveals.push(t);
      });
    }
  }

  /* the bubble bobs and ops's pill breathes while they are on screen */
  S.bob = gsap.fromTo(bub, { y: -3 }, { y: 3, duration: 1.6, ease: E.hold, yoyo: true, repeat: -1, paused: true, immediateRender: false });
  Ravi.pauseOffscreen(S.bob, ctx.$('.ck-win'));
  S.breath = gsap.fromTo(ctx.$('.ck-ost-d'), { opacity: 1 }, { opacity: .4, duration: 1.6, ease: E.hold, yoyo: true, repeat: -1, paused: true, immediateRender: false });
  Ravi.pauseOffscreen(S.breath, ctx.$('.ck-ops'));

  setupAuto(ctx);

  return function () {
    stopAuto();
    if (S.autoTl) { S.autoTl.kill(); S.autoTl = null; }
    if (S.run) commit();
    SEC.classList.remove('is-run', 'is-again');
    if (S.phase === 'resetting') { S.phase = 'done'; SEC.classList.add('is-res'); }
    if (S.bob) { S.bob.kill(); S.bob = null; }
    if (S.breath) { S.breath.kill(); S.breath = null; }
    S.reveals = [];
    S.cur = null;
    clearAnim();
    setCounts(true);
    ost(null);
    waitInert(false);
    var lc = q('.ck-lc'), sq = q('.ck-lsq');
    lc.style.left = lc.style.top = lc.style.width = lc.style.height = ''; sq.style.left = sq.style.top = '';
    qa('.ck-step.is-lit').forEach(function (s) { s.classList.remove('is-lit'); });
  };
}

/* ---------- frames: the static frames reveal on enter ---------- */
function frames(ctx) {
  var gsap = G(), ST = Ravi.ST;
  var blocks = ctx.$$('.ck-cap, .ck-win, .ck-ops, .ck-caut, .ck-br, .ck-res2, .ck-end, .ck-steps').filter(shown);
  gsap.set(blocks, { opacity: 0, y: 24 });
  ST.batch(blocks, { start: 'top 85%', once: true, onEnter: function (b) {
    gsap.to(b, { opacity: 1, y: 0, duration: .65, ease: E.rise, stagger: .06, overwrite: true, clearProps: 'opacity,transform' });
  } });
  return function () { gsap.set(blocks, { clearProps: 'opacity,transform' }); };
}

Ravi.section('click', { always: always, desk: motionBuild, touch: motionBuild, frames: frames });
} catch (err) { console.error('[section click]', err); }
})();

/* ---- section blockkit (06-blockkit.js) ---- */
(function(){
'use strict';
try {
/* 06 · #blockkit: Slack buttons, forms and cards (unpinned, hands-on).
   always(): every control, in every JS mode. With GSAP and no reduced motion a click presses, a packet runs
   along a wire to the agent in the "What happens next" panel, the avatar pulses, the pill turns to working, the
   log types line by line, and (where the agent answers in Slack) a second packet runs back to the window.
   Reduced motion or no GSAP: the pill, the log and the Slack window switch at once.
   desk/touch/frames: the on-enter reveal (tab rule draws, message blocks and the panel rise), once. */
var E = Ravi.E, D = Ravi.D;
var d = document, w = window, html = d.documentElement;
var RM = w.matchMedia('(prefers-reduced-motion: reduce)');
var root = null, gal = null, wire = null, wire2 = null, pk = null, pk2 = null, rip = null;
var played = false, enterTL = null, curTab = 'msg', swap = null;
var running = [];   /* transient timelines, finished when the tab changes */
var closers = [];   /* instant closers for menus, dialogs and the modal */
var panels = {};    /* one "What happens next" panel per tab */

var HINT = 'Press a button to see what happens.';
var HINTS = { appr: 'Pick who presses Approve.' };   /* the Approval card is played by picking a person */
var PILL = { waiting: 'waiting', working: 'working', done: 'done', still: 'still waiting', go: 'going ahead', stop: 'stopped' };

function G() { return Ravi.gsap; }
function anim() { return !!G() && !RM.matches && html.getAttribute('data-fallback') !== '1'; }
function q(s, r) { return (r || root).querySelector(s); }
function qa(s, r) { return Array.prototype.slice.call((r || root).querySelectorAll(s)); }
function vis(el) { return !!(el && el.getClientRects().length); }
function tabEl(id) { return q('.gk-tab--' + id); }
/* clear inline motion styles. GSAP measures a display:none element by moving it and re-inserting it before its next
   element sibling, which reorders inline spans that sit between text, so only rendered elements go through GSAP */
function clean(els, props) {
  els.forEach(function (el) {
    if (!el) return;
    if (G() && el.offsetParent) G().set(el, { clearProps: props || 'opacity,transform' });
    else { el.style.opacity = ''; el.style.transform = ''; el.style.clipPath = ''; }
  });
}
function track(t) { running.push(t); return t; }
function finishRunning() {
  for (var k = 0; k < 4 && running.length; k++) {
    var r = running; running = [];
    r.forEach(function (t) { try { t.progress(1); t.kill(); } catch (e) {} });
  }
}

/* ---------- typing over wrapped rows (clip-path polygon, so a log line that wraps types row by row) ---------- */
function measureRows(T) {
  var el = T.el, rg = d.createRange(), tw = d.createTreeWalker(el, 4), nd, rects = [];
  while ((nd = tw.nextNode())) { rg.selectNodeContents(nd); var rs = rg.getClientRects(); for (var ri = 0; ri < rs.length; ri++) rects.push(rs[ri]); }
  var b = el.getBoundingClientRect(), s = el.offsetWidth ? b.width / el.offsetWidth : 1, rows = [];
  if (!s) s = 1;
  for (var i = 0; i < rects.length; i++) {
    var r = rects[i]; if (r.width < .5) continue;
    var t = (r.top - b.top) / s, bt = (r.bottom - b.top) / s, l = (r.left - b.left) / s, rt = (r.right - b.left) / s, m = (t + bt) / 2, row = null;
    for (var j = 0; j < rows.length; j++) if (Math.abs(rows[j].m - m) < 6) { row = rows[j]; break; }
    if (row) { row.l = Math.min(row.l, l); row.r = Math.max(row.r, rt); row.t = Math.min(row.t, t); row.b = Math.max(row.b, bt); }
    else rows.push({ l: l, r: rt, t: t, b: bt, m: m });
  }
  rows.sort(function (a, c) { return a.t - c.t; });
  T.cw = (parseFloat(getComputedStyle(el).fontSize) || 13) * .6;
  var tot = 0;
  rows.forEach(function (r) { r.n = Math.max(1, Math.round((r.r - r.l) / T.cw)); r.c0 = tot; tot += r.n; });
  T.rows = rows; T.total = tot;
}
function applyType(T, p) {
  p = p < 0 ? 0 : p > 1 ? 1 : p;
  if (T.p === p) return;
  T.p = p;
  var st = T.el.style;
  if (p <= 0) { st.clipPath = 'inset(0 100% 0 0)'; return; }
  if (p >= 1) { st.clipPath = ''; return; }
  if (!T.rows) measureRows(T);
  var R = T.rows; if (!R.length) { st.clipPath = ''; return; }
  var n = Math.round(p * T.total), k = 0;
  while (k < R.length - 1 && n > R[k].c0 + R[k].n) k++;
  var r = R[k], x = (n >= T.total ? r.r : r.l + Math.min(r.n, Math.max(0, n - r.c0)) * T.cw).toFixed(1);
  var top = k === 0 ? -4 : r.t;
  st.clipPath = 'polygon(-4px -4px, calc(100% + 4px) -4px, calc(100% + 4px) ' + top + 'px, ' + x + 'px ' + top + 'px, ' + x + 'px ' + (r.b + 2) + 'px, -4px ' + (r.b + 2) + 'px)';
}
/* the tween hides the element when it starts and types it (cap in seconds; spec: .3s per log line) */
function typer(el, cap) {
  var T = { el: el, p: -1 }, o = { p: 0 }, n = Math.max(1, el.textContent.length);
  return G().fromTo(o, { p: 0 }, { p: 1, duration: Math.min(n * D.type, cap || .3), ease: 'none', immediateRender: false,
    onStart: function () { T.rows = null; applyType(T, 0); },
    onUpdate: function () { applyType(T, o.p); },
    onComplete: function () { el.style.clipPath = ''; },
    onInterrupt: function () { el.style.clipPath = ''; } });
}

/* ---------- the "What happens next" panel ---------- */
function panel(id) {
  if (panels[id]) return panels[id];
  var el = q('.gk-next', tabEl(id));
  var p = panels[id] = { id: id, el: el, st: q('.gk-nst', el), stT: q('.gk-nst-t', el), avw: q('.gk-avw', el), nav: q('.gk-nav', el),
    halo: q('.gk-halo', el), glow: q('.gk-glow', el), orb1: q('.gk-orb--1', el), orb2: q('.gk-orb--2', el), log: q('.gk-log', el), lis: qa('.gk-ll', el), seq: null };
  p.lts = p.lis.map(function (li) { return q('.gk-lt', li); });
  return p;
}
function setPill(p, st) { p.st.setAttribute('data-st', st); p.stT.textContent = PILL[st] || st; }
function pillTween(tl, p, st, at) {
  tl.call(function () { setPill(p, st); }, null, at);
  tl.fromTo(p.st, { scale: .82 }, { scale: 1, duration: .4, ease: E.pop, immediateRender: false }, at);
}
/* lines: up to three strings; '' leaves a slot empty. hint: the grey "press a button" line */
function setLines(p, lines, hint) {
  p.lis.forEach(function (li, i) {
    var t = lines[i] || '';
    p.lts[i].textContent = t;
    p.lts[i].style.clipPath = '';
    li.classList.toggle('is-empty', !t);
    li.classList.toggle('is-hint', !!hint && i === 0);
    li.classList.remove('is-old', 'is-cur');
  });
}
function waiting(p) { setPill(p, 'waiting'); setLines(p, [HINTS[p.id] || HINT], true); }
function stopSeq(p) { if (p.seq) { var s = p.seq; p.seq = null; s.progress(1); s.kill(); } }
function pulse(tl, p, at) {
  tl.fromTo(p.nav, { scale: 1 }, { scale: 1.14, duration: .14, ease: E.enter, immediateRender: false }, at)
    .to(p.nav, { scale: 1, duration: .45, ease: E.popSoft }, at + .14)
    .fromTo(p.halo, { opacity: .9, scale: .8 }, { opacity: 0, scale: 1.4, duration: .7, ease: E.enter, immediateRender: false }, at)
    .fromTo(p.glow, { opacity: 0 }, { opacity: 1, duration: .2, ease: E.enter, immediateRender: false }, at)
    .to(p.glow, { opacity: 0, duration: .9, ease: E.enter }, at + .3)
    .fromTo(p.orb1, { scale: 1.12 }, { scale: 1, duration: .55, ease: E.popSoft, immediateRender: false }, at)
    .fromTo(p.orb2, { scale: .9, opacity: .4 }, { scale: 1, opacity: 1, duration: .7, ease: E.popSoft, immediateRender: false }, at + .06);
}

/* ---------- wires: from the pressed control to the panel's avatar, and back to the Slack window ---------- */
function rel(el) { var r = el.getBoundingClientRect(), g = gal.getBoundingClientRect(); return { l: r.left - g.left, t: r.top - g.top, w: r.width, h: r.height }; }
function f1(v) { return (Math.round(v * 10) / 10).toString(); }
function roundPath(P, rad) {
  var out = 'M' + f1(P[0][0]) + ' ' + f1(P[0][1]);
  for (var i = 1; i < P.length - 1; i++) {
    var a = P[i - 1], b = P[i], c = P[i + 1];
    var l1 = Math.hypot(b[0] - a[0], b[1] - a[1]), l2 = Math.hypot(c[0] - b[0], c[1] - b[1]);
    if (l1 < .5 || l2 < .5) continue;
    var r = Math.min(rad, l1 / 2, l2 / 2);
    var s0 = [b[0] - (b[0] - a[0]) / l1 * r, b[1] - (b[1] - a[1]) / l1 * r], e0 = [b[0] + (c[0] - b[0]) / l2 * r, b[1] + (c[1] - b[1]) / l2 * r];
    out += ' L' + f1(s0[0]) + ' ' + f1(s0[1]) + ' Q' + f1(b[0]) + ' ' + f1(b[1]) + ' ' + f1(e0[0]) + ' ' + f1(e0[1]);
  }
  var z = P[P.length - 1];
  return out + ' L' + f1(z[0]) + ' ' + f1(z[1]);
}
function geo(tab) {
  var frEl = q('.gk-frame', tab), fr = rel(frEl), pn = rel(q('.gk-next', tab)), av = rel(q('.gk-avw', tab));
  return { frEl: frEl, fr: fr, pn: pn, av: av, frR: fr.l + fr.w, frB: fr.t + fr.h, stacked: pn.t >= fr.t + fr.h - 4,
    gx: (fr.l + fr.w + pn.l) / 2, by: av.t + av.h / 2, y2: (fr.t + fr.h + pn.t) / 2 };
}
function nextVis(el) { var n = el && el.nextElementSibling; while (n && !vis(n)) n = n.nextElementSibling; return n; }
/* the trace runs like a circuit and keeps off the message text: out of the control into the gap under it, down
   the gutter left of the blocks, through the free band under the messages, out of the window and into the avatar */
function outPath(src, tab) {
  var g = geo(tab), A = rel(src), ax = A.l + A.w / 2, ab = A.t + A.h, inFr = g.frEl.contains(src), P;
  var endL = g.av.l - 4;
  if (!inFr) {
    /* a control above the window (the Canvas button): side by side only */
    if (g.stacked) return null;
    var yc = (ab + Math.min(g.fr.t, g.pn.t)) / 2;
    P = [[ax, ab], [ax, yc], [g.gx, yc], [g.gx, g.by], [endL, g.by]];
  } else {
    var cp = q('.gk-compose', g.frEl), floor = vis(cp) ? rel(cp).t : g.frB - 4, cb = ab;
    qa('.sk-msgs > *', g.frEl).forEach(function (m) { if (vis(m) && !m.classList.contains('gk-modal')) { var r = rel(m); cb = Math.max(cb, r.t + r.h); } });
    var band = floor - cb >= 16, yd = Math.min(Math.max((cb + floor) / 2, ab + 10), floor - 4), ax0 = ax, lead = [[ax, ab]];
    var blk = src.closest('.bk-actions'), bk = src.closest('.gk-apcard, .bk'), nb = nextVis(blk);
    if (nb && bk && !src.closest('.gk-modal')) {
      var y0 = ab + Math.min(5, Math.max(2, (rel(nb).t - ab) / 2)), lx = rel(bk).l - 7;
      lead = [[ax, ab], [ax, y0], [lx, y0]]; ax = lx;
    }
    if (g.stacked) {
      var lane = vis(cp) || !bk ? g.fr.l + 9 : rel(bk).l - 7, yb = lead.length > 1 ? lead[1][1] : ab + 5, px = g.pn.l + 8;
      P = [[ax0, ab], [ax0, yb], [lane, yb], [lane, g.y2], [px, g.y2], [px, g.by], [endL, g.by]];
    } else if (band || src.closest('.gk-modal')) {
      P = lead.concat([[ax, yd], [g.gx, yd], [g.gx, g.by], [endL, g.by]]);
    } else {
      var bar = rel(q('.gk-tabbar')), y1 = (bar.t + bar.h + Math.min(g.fr.t, g.pn.t)) / 2;
      P = [[ax0, A.t], [ax0, y1], [g.gx, y1], [g.gx, g.by], [endL, g.by]];
    }
  }
  wire.setAttribute('d', roundPath(P, 14));
  return Ravi.samplePath(wire, 96);
}
/* the agent answers in Slack: from the avatar back into the window, ending just right of the target */
function textBox(el) {
  var rg = d.createRange(); rg.selectNodeContents(el);
  var r = rg.getBoundingClientRect(), g = gal.getBoundingClientRect();
  return r.width ? { l: r.left - g.left, t: r.top - g.top, w: r.width, h: r.height } : rel(el);
}
function backPath(target, tab) {
  var g = geo(tab), T = textBox(target), ty = T.t + Math.min(T.h / 2, 14), P, startL = g.av.l - 4;
  if (g.stacked) {
    var laneR = g.frR - 9, px = g.pn.l + 8, ex = Math.min(T.l + T.w + 8, laneR - 2);
    P = [[startL, g.by], [px, g.by], [px, g.y2], [laneR, g.y2], [laneR, ty], [ex, ty]];
  } else {
    P = [[startL, g.by], [g.gx, g.by], [g.gx, ty], [Math.min(T.l + T.w + 8, g.gx - 2), ty]];
  }
  wire2.setAttribute('d', roundPath(P, 14));
  return Ravi.samplePath(wire2, 96);
}
function ripAt(tl, src, at) {
  var A = rel(src);
  tl.set(rip, { x: A.l + A.w / 2, y: A.t + A.h / 2 }, at)
    .fromTo(rip, { opacity: 1, scale: .3 }, { opacity: 0, scale: 1.5, duration: .5, ease: E.enter, immediateRender: false }, at);
}
function hdr() { var cs = getComputedStyle(html); return (parseFloat(cs.getPropertyValue('--hdr')) || 52) + (parseFloat(cs.getPropertyValue('--bar')) || 0); }
/* bring an element in by its nearest edge (scroll-margin clears the header). The scroll waits two frames, so a
   ScrollTrigger refresh queued by the same click runs first and does not cut the smooth scroll short */
function inView(el) { var r = el.getBoundingClientRect(); return r.bottom <= w.innerHeight - 8 && r.top >= hdr(); }
function bring(el, smooth) {
  if (inView(el)) return false;
  requestAnimationFrame(function () { requestAnimationFrame(function () {
    try { el.scrollIntoView({ block: 'nearest', behavior: smooth && anim() ? 'smooth' : 'auto' }); } catch (e) { el.scrollIntoView(false); }
  }); });
  return true;
}
/* phone: the panel sits under the window; bring it in so the agent's side can be seen */
function bringPanel(p) { return bring(p.el, true) ? .5 : 0; }

/* ---------- one click, played out in the panel ----------
   o = { src, lines:[…], fin:'done', back:{ target, after:index, reveal(tl, at) → seconds, instant() }, refuse, quiet, say }
   refuse: the packet bounces back short of the avatar; quiet: no pulse and no "working" (nobody pressed anything) */
function run(id, o) {
  var p = panel(id), tab = tabEl(id);
  stopSeq(p);
  if (!anim()) {
    setLines(p, o.lines || []);
    setPill(p, o.fin || 'done');
    if (o.back && o.back.instant) o.back.instant();
    if (o.say) Ravi.announce(o.say);
    Ravi.refresh();
    return;
  }
  var g = G(), delay = o.src ? bringPanel(p) : 0;
  var tl = p.seq = track(g.timeline({ delay: delay, onComplete: function () { if (p.seq === tl) p.seq = null; } }));
  var lines = o.lines || [], t = 0;
  /* a new click clears the log with a quick fade */
  tl.to(p.lis, { opacity: 0, duration: .15, ease: E.exit }, 0)
    .call(function () { setLines(p, []); p.lts.forEach(function (lt, i) { if (lines[i]) lt.style.clipPath = 'inset(0 100% 0 0)'; }); }, null, .15)
    .call(function () { p.lis.forEach(function (li) { li.style.opacity = ''; }); }, null, .15);
  if (o.src && vis(o.src)) {
    ripAt(tl, o.src, 0);
    var pts = outPath(o.src, tab);
    if (pts) {
      tl.set(wire, { opacity: 1, strokeDashoffset: 1 }, 0)
        .to(wire, { strokeDashoffset: 0, duration: .35, ease: E.wipe, autoRound: false }, 0)
        .set(pk, { opacity: 1 }, 0);
      if (o.refuse) {
        tl.add(Ravi.packetRefuse(pk, pts, .7), .05)
          .to([pk, wire], { opacity: 0, duration: .3, ease: E.enter }, .8);
        t = .62;
        tl.fromTo(p.avw, { x: 0 }, { x: 4, duration: .06, ease: E.enter, yoyo: true, repeat: 3, immediateRender: false }, .55);
      } else {
        tl.add(Ravi.packet(pk, pts, .45, E.travel), .05)
          .to([pk, wire], { opacity: 0, duration: .3, ease: E.enter }, .52);
        t = .5;
      }
    }
  }
  var t0 = t;
  if (o.refuse || o.quiet) { if (o.refuse) pillTween(tl, p, o.fin || 'still', t); t += .2; }
  else { pulse(tl, p, t); pillTween(tl, p, 'working', t); t += .25; }
  lines.forEach(function (txt, i) {
    if (!txt) return;
    var lt = p.lts[i], li = p.lis[i];
    tl.call(function () {
      p.lis.forEach(function (x, j) { if (j < i && !x.classList.contains('is-empty')) { x.classList.add('is-old'); x.classList.remove('is-cur'); } });
      lt.textContent = txt; li.classList.remove('is-empty'); li.classList.add('is-cur');
    }, null, t);
    var ty = typer(lt, .3);
    tl.add(ty, t);
    t += ty.duration() + .12;
    tl.call(function () { li.classList.remove('is-cur'); }, null, t - .02);
    if (o.back && o.back.after === i) {
      var bpts = backPath(o.back.target, tab);
      tl.set(wire2, { opacity: 1, strokeDashoffset: 1 }, t)
        .to(wire2, { strokeDashoffset: 0, duration: .35, ease: E.wipe, autoRound: false }, t)
        .set(pk2, { opacity: 1 }, t)
        .add(Ravi.packet(pk2, bpts, .45, E.travel), t + .03)
        .to([pk2, wire2], { opacity: 0, duration: .3, ease: E.enter }, t + .5);
      t += .48;
      t += o.back.reveal(tl, t) || 0;
    }
  });
  /* while the agent works, its dashed ring turns */
  if (!o.refuse && !o.quiet) tl.to(p.orb1, { rotation: '+=120', duration: Math.max(.3, t - t0), ease: 'power1.inOut' }, t0);
  if (!o.refuse) {
    tl.call(function () { p.lis.forEach(function (x) { if (!x.classList.contains('is-empty')) x.classList.add('is-old'); }); var l = p.lis.filter(function (x) { return !x.classList.contains('is-empty'); }).pop(); if (l) l.classList.remove('is-old'); }, null, t);
    pillTween(tl, p, o.fin || 'done', t);
  }
  if (o.say) tl.call(function () { Ravi.announce(o.say); }, null, t);
}

/* focus stays inside an open dialog */
function trap(e, box, onEsc) {
  if (e.key === 'Escape') { e.preventDefault(); onEsc(); return; }
  if (e.key !== 'Tab') return;
  var f = qa('button:not([disabled]), input, select', box).filter(vis), i = f.indexOf(d.activeElement);
  if (!f.length) return;
  if (e.shiftKey && i <= 0) { e.preventDefault(); f[f.length - 1].focus(); }
  else if (!e.shiftKey && i === f.length - 1) { e.preventDefault(); f[0].focus(); }
}
/* a reply that has not been posted yet keeps its space (.gk-later), then rises in */
function postLater(el, tl, at, from) {
  tl.call(function () { el.classList.remove('gk-later'); Ravi.refresh(); }, null, at);
  tl.fromTo(el, from || { opacity: 0, y: 10 }, { opacity: 1, x: 0, y: 0, scaleX: 1, duration: .45, ease: E.rise, immediateRender: false, clearProps: 'opacity,transform' }, at);
  return .35;
}

/* ---------- tab 1: buttons ---------- */
function wireMsg() {
  var tab = tabEl('msg'), approve = q('[data-x="approve"]', tab), reject = q('[data-x="reject"]', tab), thr = q('.gk-thr', tab);
  var sel = q('.gk-selbtn', tab), selV = q('.gk-selv', sel), menu = q('#gk-menu', tab), opts = qa('.gk-opt', menu);
  var dim = q('.gk-dim', tab), dlg = q('.gk-confirm', tab), cfNo = q('.gk-cf-no', dlg), cfYes = q('.gk-cf-yes', dlg), cfTL = null;

  function reply() {
    return { target: thr, after: 2,
      reveal: function (tl, at) {
        if (thr.classList.contains('gk-later')) return postLater(thr, tl, at, { opacity: 0, scaleX: .6 });
        tl.fromTo(thr, { scale: 1 }, { scale: 1.08, duration: .12, ease: E.enter, yoyo: true, repeat: 1, immediateRender: false }, at);
        return .2;
      },
      instant: function () { thr.classList.remove('gk-later'); } };
  }
  function decide(kind, src) {
    var V = kind === 'approve' ? 'Approve' : 'Reject', done = kind === 'approve' ? 'Order approved.' : 'Order rejected.';
    run('msg', { src: src, lines: ['ops got your click: ' + V, 'Checking you can approve orders ✓', done + ' ops tells Ana in the thread.'],
      back: reply(), say: 'You pressed ' + V + '. ' + done + ' The ops agent tells Ana in the thread.' });
  }
  approve.addEventListener('click', function () {
    closeMenu(false);
    if (anim()) Ravi.press(approve);
    decide('approve', approve);
  });

  /* Reject opens Slack's confirm; Reject there goes ahead, Cancel does nothing */
  function hideConfirm() { clean([dim, dlg]); dim.hidden = true; dlg.hidden = true; }
  function openConfirm() {
    closeMenu(false);
    dim.hidden = false; dlg.hidden = false;
    if (anim()) {
      if (cfTL) cfTL.kill();
      cfTL = G().timeline();
      cfTL.fromTo(dim, { opacity: 0 }, { opacity: 1, duration: .25, ease: E.enter }, 0)
        .fromTo(dlg, { opacity: 0, scale: .96 }, { opacity: 1, scale: 1, duration: .25, ease: E.enter }, 0);
    }
    cfNo.focus({ preventScroll: true });
    bring(dlg, true);
  }
  function closeConfirm(go) {
    if (dlg.hidden) return;
    if (go) decide('reject', reject);
    if (anim()) {
      if (cfTL) cfTL.kill();
      cfTL = G().timeline({ onComplete: hideConfirm });
      cfTL.to(dlg, { opacity: 0, scale: .98, duration: .2, ease: E.exit }, 0).to(dim, { opacity: 0, duration: .2, ease: E.exit }, 0);
    } else hideConfirm();
    reject.focus({ preventScroll: true });
    if (!go) Ravi.announce('Cancelled. The order is unchanged.');
  }
  reject.addEventListener('click', openConfirm);
  cfNo.addEventListener('click', function () { closeConfirm(false); });
  cfYes.addEventListener('click', function () { if (anim()) Ravi.press(cfYes); closeConfirm(true); });
  dlg.addEventListener('keydown', function (e) { trap(e, dlg, function () { closeConfirm(false); }); });
  closers.push(function () { if (cfTL) cfTL.kill(); hideConfirm(); });

  /* the Priority select: a list that drops down; picking an option goes to ops */
  function openMenu(i) {
    menu.hidden = false; sel.setAttribute('aria-expanded', 'true');
    menu.classList.remove('is-up');
    var fr = q('.gk-frame', tab).getBoundingClientRect(), mr = menu.getBoundingClientRect(), up = mr.bottom > fr.bottom - 6 && mr.top - mr.height - 40 > fr.top;
    menu.classList.toggle('is-up', up);
    if (anim()) G().fromTo(menu, { clipPath: up ? 'inset(100% 0% 0% 0%)' : 'inset(0% 0% 100% 0%)' }, { clipPath: 'inset(0% 0% 0% 0%)', duration: .25, ease: E.wipe, clearProps: 'clipPath' });
    var k = i;
    if (k == null) { k = 0; opts.forEach(function (o, j) { if (o.getAttribute('aria-selected') === 'true') k = j; }); }
    opts[k].focus({ preventScroll: true });
    bring(menu, true);
  }
  function closeMenu(refocus) {
    if (menu.hidden) return;
    menu.hidden = true; sel.setAttribute('aria-expanded', 'false');
    if (refocus) sel.focus({ preventScroll: true });
  }
  function pick(o) {
    opts.forEach(function (x) { x.setAttribute('aria-selected', x === o ? 'true' : 'false'); });
    var v = o.getAttribute('data-v');
    selV.textContent = v; sel.classList.add('is-set'); sel.setAttribute('aria-label', 'Priority: ' + v);
    closeMenu(true);
    run('msg', { src: sel, lines: ['ops got your pick: ' + v, 'Order set to ' + v + ' priority.'], say: 'You picked ' + v + '. Order set to ' + v + ' priority.' });
  }
  sel.addEventListener('click', function () { if (menu.hidden) openMenu(); else closeMenu(true); });
  sel.addEventListener('keydown', function (e) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); openMenu(e.key === 'ArrowUp' ? opts.length - 1 : null); }
  });
  opts.forEach(function (o) { o.addEventListener('click', function () { pick(o); }); });
  menu.addEventListener('keydown', function (e) {
    var i = opts.indexOf(d.activeElement), k = e.key, n = opts.length;
    if (k === 'ArrowDown') { e.preventDefault(); opts[(i + 1) % n].focus(); }
    else if (k === 'ArrowUp') { e.preventDefault(); opts[(i - 1 + n) % n].focus(); }
    else if (k === 'Home') { e.preventDefault(); opts[0].focus(); }
    else if (k === 'End') { e.preventDefault(); opts[n - 1].focus(); }
    else if (k === 'Enter' || k === ' ') { e.preventDefault(); if (i >= 0) pick(opts[i]); }
    else if (k === 'Escape') { e.preventDefault(); closeMenu(true); }
    else if (k === 'Tab') closeMenu(false);
  });
  d.addEventListener('pointerdown', function (e) { if (!menu.hidden && !(e.target.closest && e.target.closest('.gk-sel'))) closeMenu(false); });
  closers.push(function () { closeMenu(false); });
}

/* ---------- tab 2: the form ---------- */
function wireModal() {
  var tab = tabEl('modal'), btn = q('[data-x="open"]', tab), dim = q('.gk-dim', tab), modal = q('.gk-modal', tab);
  var item = q('#gk-md-item', modal), amt = q('#gk-md-amt', modal), team = q('#gk-md-team', modal), no = q('.gk-md-no', modal), yes = q('.gk-md-yes', modal);
  var thx = q('.gk-thx', tab), thxV = q('.gk-thx-v', tab), mTL = null;

  function val(inp, dflt) { var v = (inp.value || '').replace(/\s+/g, ' ').trim(); return v || dflt; }
  function money(v) {
    var s = v.replace(/^\$/, '').replace(/,/g, '');
    return /^\d+(\.\d{1,2})?$/.test(s) ? '$' + Number(s).toLocaleString('en-US', { maximumFractionDigits: 2 }) : '$' + v.replace(/^\$/, '');
  }
  function isOpen() { return modal.classList.contains('is-open'); }
  /* authored as a plain group (with JS off it sits inline and traps nothing); it is a modal dialog only while open */
  function hide() { clean([dim, modal]); dim.hidden = true; modal.classList.remove('is-open'); modal.setAttribute('role', 'group'); modal.removeAttribute('aria-modal'); }
  /* the Item field types "Monitor" as the form opens (only while it still holds that value); a key press takes over */
  var typeTw = null, ITEM = 'Monitor';
  function endType(keep) { if (!typeTw) return; var t = typeTw; typeTw = null; if (!keep) t.progress(1); t.kill(); }
  function selectItem() { try { item.select(); } catch (e) {} }
  function open() {
    modal.setAttribute('role', 'dialog'); modal.setAttribute('aria-modal', 'true');
    dim.hidden = false; modal.classList.add('is-open');
    endType();
    if (anim()) {
      if (mTL) mTL.kill();
      mTL = G().timeline();
      mTL.fromTo(dim, { opacity: 0 }, { opacity: 1, duration: .25, ease: E.enter }, 0)
        .fromTo(modal, { opacity: 0, y: 24, scale: .96 }, { opacity: 1, y: 0, scale: 1, duration: .4, ease: E.popSoft }, .05);
      if (item.value === ITEM) {
        var o = { n: 0 };
        item.value = '';
        typeTw = G().to(o, { n: ITEM.length, duration: ITEM.length * .05, delay: .3, ease: 'none',
          onUpdate: function () { item.value = ITEM.slice(0, Math.round(o.n)); },
          onComplete: function () { typeTw = null; item.value = ITEM; if (d.activeElement === item) selectItem(); } });
      }
    }
    item.focus({ preventScroll: true });
    if (!typeTw) selectItem();
    bring(modal, true);
  }
  item.addEventListener('keydown', function (e) { if (typeTw && e.key.length === 1 && !e.ctrlKey && !e.metaKey) { endType(true); item.value = ''; } });
  item.addEventListener('pointerdown', function () { endType(); });
  function close(submit) {
    if (!isOpen()) return;
    endType();
    if (submit) {
      var it = val(item, 'Monitor'), am = money(val(amt, '230')), tm = team.value || 'Support';
      if (anim()) Ravi.press(yes);
      run('modal', { src: yes, lines: ['ops got the form: ' + it + ' · ' + am + ' · ' + tm, 'Adding it to the requests table', 'Filed. ops thanks you in the channel.'],
        back: { target: q('.gk-thx-t', tab), after: 2,
          reveal: function (tl, at) {
            tl.call(function () { thxV.textContent = it + ' · ' + am; }, null, at);
            if (thx.classList.contains('gk-later')) return postLater(thx, tl, at);
            tl.fromTo(thx, { opacity: .3 }, { opacity: 1, duration: .4, ease: E.enter, immediateRender: false }, at);
            return .3;
          },
          instant: function () { thxV.textContent = it + ' · ' + am; thx.classList.remove('gk-later'); } },
        say: 'Filed ' + it + ', ' + am + ', ' + tm + '. The ops agent thanks you in the channel.' });
    }
    if (anim()) {
      if (mTL) mTL.kill();
      mTL = G().timeline({ onComplete: hide });
      mTL.to(modal, { opacity: 0, scale: .98, duration: .2, ease: E.exit }, submit ? .08 : 0).to(dim, { opacity: 0, duration: .2, ease: E.exit }, '<');
    } else hide();
    btn.focus({ preventScroll: true });
    if (!submit) Ravi.announce('Form closed. Nothing was filed.');
  }
  btn.addEventListener('click', function () { if (anim()) Ravi.press(btn); open(); });
  no.addEventListener('click', function () { close(false); });
  yes.addEventListener('click', function () { close(true); });
  [item, amt, q('#gk-md-by', modal)].forEach(function (inp) { inp.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); close(true); } }); });
  modal.addEventListener('keydown', function (e) { trap(e, modal, function () { close(false); }); });
  closers.push(function () { endType(); if (mTL) mTL.kill(); hide(); });
}

/* ---------- tab 3: approval (reception's plan card) ---------- */
function wireAppr() {
  var tab = tabEl('appr'), frame = q('.gk-frame', tab), p = panel('appr');
  var who = qa('input[name="gk-who"]', tab), again = q('.gk-again', tab);
  var curs = { bruno: q('.gk-cur--b', tab), carla: q('.gk-cur--c', tab) }, tls = [];
  var c = q('.gk-apcard', tab), C = { pend: q('.gk-ap-pend', c), fin: q('.gk-ap-fin', c), ok: q('.gk-ap-ok', c), ign: q('.gk-ap-ign', c),
    ring: q('.gk-ring', c), arc: q('.gk-ring-a', c), num: q('.gk-ring-n', c), st: q('.gk-ap-st', c), okt: q('.gk-ap-okt', c), lines: qa('.gk-ap-fin>b, .gk-ap-st', c) };

  function apTrack(t) { tls.push(t); return track(t); }
  function persona() { var v = 'bruno'; who.forEach(function (i) { if (i.checked) v = i.value; }); return v; }
  function resetCard() {
    tls.forEach(function (t) { t.kill(); }); tls = [];
    stopSeq(p);
    clean([c, C.pend, C.ign, C.ring, C.okt].concat(C.lines));
    C.arc.style.strokeDashoffset = '';
    C.pend.hidden = false; C.fin.hidden = true; C.ign.hidden = true; C.ring.hidden = true;
    C.num.textContent = '5:00'; C.st.textContent = 'Approved'; C.okt.hidden = false; C.ok.removeAttribute('aria-disabled');
    if (G()) G().set([curs.bruno, curs.carla], { opacity: 0 });
    waiting(p);
  }
  function toFinal(tl, at) {
    if (!anim()) { C.pend.hidden = true; C.fin.hidden = false; Ravi.refresh(); return; }
    var g = G();
    tl.to(C.pend, { opacity: 0, y: -6, duration: .25, ease: E.exit }, at)
      .call(function () { clean([C.pend]); C.pend.hidden = true; C.fin.hidden = false; Ravi.refresh(); }, null, at + .25)
      .fromTo(C.lines, { opacity: 0, y: 10 }, { opacity: 1, y: 0, duration: .5, ease: E.rise, stagger: .08, immediateRender: false }, at + .26);
    if (!C.okt.hidden) tl.fromTo(C.okt, { opacity: 0, scale: .8 }, { opacity: 1, scale: 1, duration: .45, ease: E.pop, immediateRender: false }, at + .5);
  }
  function bruno() {
    C.ign.hidden = false;
    run('appr', { src: C.ok, refuse: true, fin: 'still', lines: ['Bruno can\'t approve plans, so the card keeps waiting.'], say: 'Bruno pressed Approve. Nothing happens: Bruno can\'t approve plans. The card is still waiting.' });
    if (!anim()) { Ravi.refresh(); return; }
    apTrack(G().timeline()
      .fromTo(c, { x: 10 }, { x: 0, duration: .8, ease: E.refuse }, 0)
      .fromTo(C.ign, { opacity: 0, scale: .8 }, { opacity: 1, scale: 1, duration: .45, ease: E.pop }, .4));
    Ravi.refresh();
  }
  function carla() {
    C.st.textContent = 'Approved'; C.okt.hidden = false;
    run('appr', { src: C.ok, fin: 'go', lines: ['reception goes ahead with the plan.'], say: 'Carla pressed Approve. The card reads Approved by Carla, and reception goes ahead with the plan.' });
    if (!anim()) { toFinal(); return; }
    toFinal(apTrack(G().timeline()), .55);
  }
  function nobody() {
    function done() { C.st.textContent = 'Expired — no decision in 5 minutes.'; C.okt.hidden = true; C.ok.removeAttribute('aria-disabled'); }
    var say = 'Nobody pressed anything for 5 minutes. The card expired, so nothing happens.';
    if (!anim()) {
      done(); toFinal();
      run('appr', { lines: ['Nobody decided, so nothing happens.'], fin: 'stop', say: say });
      return;
    }
    C.ok.setAttribute('aria-disabled', 'true');
    C.ring.hidden = false;
    /* someone chose "Nobody", so the "pick who presses" hint goes; the pill keeps waiting while the ring runs */
    setLines(p, []);
    /* phone: the ring wraps under the buttons; bring the card's foot into view so the countdown is seen */
    bring(c, true);
    Ravi.announce('Nobody presses Approve. The card waits 5 minutes, sped up.');
    var g = G(), o = { p: 0 }, tl = apTrack(g.timeline());
    tl.fromTo(C.ring, { opacity: 0, scale: .8 }, { opacity: 1, scale: 1, duration: .3, ease: E.pop })
      .fromTo(C.arc, { strokeDashoffset: 0 }, { strokeDashoffset: 1, duration: 2, ease: 'none', autoRound: false })
      .fromTo(o, { p: 0 }, { p: 1, duration: 2, ease: 'none', onUpdate: function () {
        var s = Math.round(300 * (1 - o.p)); C.num.textContent = Math.floor(s / 60) + ':' + ('0' + (s % 60)).slice(-2);
      } }, '<')
      .call(done, null, '+=.15');
    var at = tl.duration();
    toFinal(tl, at);
    tl.call(function () { run('appr', { quiet: true, lines: ['Nobody decided, so nothing happens.'], fin: 'stop', say: say }); }, null, at + .3);
  }
  function play(v) {
    resetCard();
    if (v === 'nobody') { nobody(); return; }
    var act = v === 'bruno' ? bruno : carla;
    if (!anim()) { act(); return; }
    var g = G(), cur = curs[v], B = Ravi.center(C.ok, frame);
    var sx = Math.min(B.x + 120, frame.clientWidth - 90), sy = Math.min(B.y + 90, frame.clientHeight - 50);
    apTrack(g.timeline()
      .set(cur, { x: sx, y: sy }, 0)
      .to(cur, { opacity: 1, duration: .2, ease: E.enter }, 0)
      .to(cur, { x: B.x - 2, y: B.y - 2, duration: .6, ease: E.cut }, .05)
      .fromTo(q('.cur-ripple', cur), { scale: .2, opacity: 1 }, { scale: 1.6, opacity: 0, duration: .5, ease: E.enter, immediateRender: false }, .65)
      .add(Ravi.press(C.ok), .65)
      .call(act, null, .7)
      .to(cur, { opacity: 0, duration: .25, ease: E.enter }, .95));
  }
  /* a click on a person (arrow keys click too) plays that outcome; Approve on the card plays the chosen one */
  who.forEach(function (i) { i.addEventListener('click', function () { play(i.value); }); });
  C.ok.addEventListener('click', function () {
    if (C.ok.getAttribute('aria-disabled') === 'true') return;
    var v = persona(); if (v !== 'nobody') play(v);
  });
  again.addEventListener('click', function () { play(persona()); });
  closers.push(function () { tls.forEach(function (t) { t.progress(1); }); });
  /* the authored HTML shows Carla's outcome for the no-JS example; with JS the card waits for a pick */
  C.pend.hidden = false; C.fin.hidden = true;
}

/* ---------- tab 4: the Canvas ---------- */
function fmt(n) { return Math.round(n).toLocaleString('en-US'); }
function wireCanvas() {
  var tab = tabEl('canvas'), btn = q('.gk-editbtn', tab), nums = qa('.gk-n', tab);
  var old = q('.gk-w-old', tab), nw = q('.gk-w-new', tab), wash = q('.gk-dwash', tab);
  /* old: Headset, Standing desk, Monitor. nw: Headset, Monitor (the desk is approved), as in #wake and #sdk */
  function before() {
    nums.forEach(function (n) { n.textContent = fmt(+n.getAttribute('data-a')); n.style.removeProperty('--fl'); });
    [old, nw, wash].forEach(function (el) { el.style.clipPath = ''; el.style.opacity = ''; el.style.visibility = ''; });
    old.hidden = false; nw.hidden = true;
  }
  /* with JS the old list keeps its row (visibility only), so the Canvas never shrinks under the reader */
  function after() { nums.forEach(function (n) { n.textContent = fmt(+n.getAttribute('data-b')); }); old.style.visibility = 'hidden'; nw.hidden = false; }
  before();
  btn.addEventListener('click', function () {
    if (anim()) Ravi.press(btn);
    var p = panel('canvas'); stopSeq(p);
    before();
    var g = geo(tab);
    /* stacked (phone): the button sits above the window, so bring the Waiting row in; every change is then on screen */
    if (g.stacked) bring(q('.gk-dsec', tab), true);
    run('canvas', { src: g.stacked ? null : btn, lines: ['ops updates the Canvas', 'Standing desk approved: Sales is now $2,850', 'Done. Slack shows the new version.'],
      back: { target: q('.gk-dp', tab), after: 0,
        reveal: function (tl, at) {
          tl.fromTo(wash, { opacity: 0 }, { opacity: 1, duration: .2, ease: E.enter, immediateRender: false }, at)
            .to(wash, { opacity: 0, duration: .9, ease: E.enter }, at + .7);
          nums.forEach(function (n, i) {
            var a = +n.getAttribute('data-a'), b = +n.getAttribute('data-b'), o = { v: a };
            tl.to(o, { v: b, duration: .55, ease: 'power2.out', onUpdate: function () { n.textContent = fmt(o.v); } }, at + i * .06)
              .fromTo(n, { '--fl': 1 }, { '--fl': 0, duration: .9, ease: E.enter, immediateRender: false }, at + i * .06);
          });
          tl.call(function () { nw.hidden = false; }, null, at + .2)
            .fromTo(nw, { clipPath: 'inset(0% 100% 0% 0%)' }, { clipPath: 'inset(0% 0% 0% 0%)', duration: .5, ease: E.wipe, immediateRender: false, clearProps: 'clipPath' }, at + .2)
            .fromTo(old, { clipPath: 'inset(0% 0% 0% 0%)' }, { clipPath: 'inset(0% 0% 0% 100%)', duration: .5, ease: E.wipe, immediateRender: false }, at + .2)
            .call(function () { old.style.visibility = 'hidden'; old.style.clipPath = ''; }, null, at + .72);
          return .7;
        },
        instant: after },
      say: 'The ops agent updated the Canvas: 7 requests approved, $3,450. Sales is now $2,850. Still waiting: Headset and Monitor.' });
  });
  closers.push(function () { var p = panel('canvas'); if (p.seq) stopSeq(p); });
}

/* ---------- tab 5: the task card (a tag shows its tooltip and its line in the panel) ---------- */
function wireWO() {
  var tab = tabEl('wo'), p = panel('wo'), wraps = qa('.gk-tagw', tab), first = p.lts[0].textContent;
  wraps.forEach(function (wr) {
    var b = q('.gk-wotag', wr), tip = q('.gk-tip', wr);
    b.addEventListener('click', function () {
      wraps.forEach(function (x) { x.classList.toggle('is-on', x === wr); });
      var txt = tip.textContent;
      stopSeq(p);
      Ravi.announce(txt);
      if (!anim()) { setLines(p, [first, txt]); p.lis[0].classList.add('is-old'); return; }
      var g = G(), lt = p.lts[1], li = p.lis[1];
      var tl = p.seq = track(g.timeline({ onComplete: function () { if (p.seq === tl) p.seq = null; } }));
      tl.fromTo(b, { scale: 1 }, { scale: 1.12, duration: .12, ease: E.enter, yoyo: true, repeat: 1 }, 0)
        .to(li, { opacity: 0, duration: .15, ease: E.exit }, 0)
        .call(function () { setLines(p, [first, txt]); p.lis[0].classList.add('is-old'); li.classList.add('is-cur'); lt.style.clipPath = 'inset(0 100% 0 0)'; }, null, .15)
        .call(function () { li.style.opacity = ''; }, null, .15)
        .add(typer(lt, .3), .16)
        .call(function () { li.classList.remove('is-cur'); }, null, .5);
    });
  });
  closers.push(function () { wraps.forEach(function (x) { x.classList.remove('is-on'); }); });
}

/* ---------- main tabs ---------- */
function indPos(animate) {
  var g = G(), ind = q('.gk-ind'), lab = q('#gk-tl-' + curTab);
  if (!g || !ind || !lab) return;
  var v = { x: lab.offsetLeft, scaleX: Math.max(.01, lab.offsetWidth / 100) };
  if (animate && anim()) g.to(ind, Object.assign(v, { duration: .35, ease: E.cut, overwrite: 'auto' }));
  else g.set(ind, v);
}
function stopEnter() {
  played = true;
  if (enterTL) { var t = enterTL; enterTL = null; t.progress(1); t.kill(); }
}
function entrance(tab) {
  var g = G(), id = tab.getAttribute('data-tab'), tl = g.timeline();
  var ctl = qa('.gk-ctrls', tab).filter(vis), nx = q('.gk-next', tab);
  if (ctl.length) tl.fromTo(ctl, { opacity: 0, y: 10 }, { opacity: 1, y: 0, duration: .4, ease: E.enter, clearProps: 'opacity,transform' }, 0);
  if (id === 'canvas') {
    tl.fromTo(q('.gk-doc', tab), { opacity: 0, y: 24 }, { opacity: 1, y: 0, duration: .45, ease: E.enter, clearProps: 'opacity,transform' }, .05);
  } else {
    var blks = qa('.gk-frame .gk-blk', tab).filter(vis);
    if (blks.length) tl.fromTo(blks, { opacity: 0, y: 10 }, { opacity: 1, y: 0, duration: .4, ease: E.enter, stagger: .07, clearProps: 'opacity,transform' }, .05);
    if (id === 'wo') {
      tl.fromTo(q('.gk-wo', tab), { clipPath: 'inset(0% 0% 100% 0%)' }, { clipPath: 'inset(0% 0% 0% 0%)', duration: .35, ease: E.wipe, clearProps: 'clipPath' }, .15)
        .fromTo(qa('.gk-wotag', tab), { opacity: 0, scale: .6 }, { opacity: 1, scale: 1, duration: .4, ease: E.pop, stagger: .08, clearProps: 'opacity,transform' }, .4);
    }
  }
  panelIn(tl, nx, .12);
  return tl;
}
/* the panel rises in after its window: heading, agent (the avatar pops), log */
function panelIn(tl, nx, at) {
  var kids = Array.prototype.slice.call(nx.children).filter(vis);
  tl.fromTo(kids, { opacity: 0, y: 10 }, { opacity: 1, y: 0, duration: .45, ease: E.enter, stagger: .08, clearProps: 'opacity,transform' }, at)
    .fromTo(q('.gk-nav', nx), { scale: .6 }, { scale: 1, duration: .5, ease: E.popSoft, clearProps: 'transform' }, at + .1)
    .fromTo(qa('.gk-orb', nx), { scale: .5, opacity: 0 }, { scale: 1, opacity: 1, duration: .8, ease: E.rise, stagger: .1, clearProps: 'opacity,transform' }, at + .12);
  return tl;
}
function finishSwap() {
  var s = swap; swap = null; if (!s) return;
  s.tl.kill();
  s.prev.classList.remove('is-on'); s.prev.style.clipPath = '';
  s.next.classList.add('is-on'); s.next.style.clipPath = '';
  if (s.ent) { s.ent.progress(1); s.ent.kill(); }
}
function showTab(id) {
  var next = tabEl(id); if (!next) return;
  finishSwap();
  var prev = q('.gk-tab.is-on') || next;
  curTab = id;
  if (prev === next) { indPos(true); return; }
  stopEnter();
  closers.forEach(function (f) { try { f(); } catch (e) {} });
  finishRunning();
  if (G()) G().set([pk, pk2, wire, wire2, rip], { opacity: 0 });
  indPos(true);
  if (!anim()) { prev.classList.remove('is-on'); next.classList.add('is-on'); Ravi.refresh(); return; }
  var g = G(), s = swap = { prev: prev, next: next, ent: null };
  s.tl = g.timeline({ onComplete: function () { if (swap === s) swap = null; } });
  s.tl.fromTo(prev, { clipPath: 'inset(0% 0% 0% 0%)' }, { clipPath: 'inset(0% 100% 0% 0%)', duration: .3, ease: E.wipe })
    .call(function () {
      prev.classList.remove('is-on'); prev.style.clipPath = '';
      next.style.clipPath = 'inset(0% 0% 0% 100%)'; next.classList.add('is-on');
      Ravi.refresh();
      s.ent = entrance(next);
    })
    .fromTo(next, { clipPath: 'inset(0% 0% 0% 100%)' }, { clipPath: 'inset(0% 0% 0% 0%)', duration: .35, ease: E.wipe, immediateRender: false })
    .call(function () { next.style.clipPath = ''; });
}

/* ---------- always: wiring for every JS mode ---------- */
function init(c) {
  root = c.el; gal = q('.gk-gal'); wire = q('.gk-wire'); wire2 = q('.gk-wire2'); pk = q('.gk-pk'); pk2 = q('.gk-pk2'); rip = q('.gk-rip');
  if (!gal) return;
  root.classList.add('gk-js');
  qa('.gk-x, .gk-ap-ok, .gk-md-no, .gk-md-yes').forEach(function (b) { b.disabled = false; });

  /* the checked radio wins (a browser may restore it on reload) */
  var chk = q('input[name="gk-tab"]:checked');
  curTab = chk ? chk.value : 'msg';
  qa('.gk-tab').forEach(function (t) { t.classList.toggle('is-on', t.getAttribute('data-tab') === curTab); });

  /* with JS the panels wait for a press (the authored HTML shows worked examples); replies not yet posted keep their space */
  ['msg', 'modal', 'appr', 'canvas'].forEach(function (id) { waiting(panel(id)); });
  panel('wo');
  qa('.gk-thr, .gk-thx').forEach(function (el) { el.classList.add('gk-later'); });

  wireMsg(); wireModal(); wireAppr(); wireCanvas(); wireWO();

  qa('input[name="gk-tab"]').forEach(function (i) { i.addEventListener('change', function () { if (i.checked) showTab(i.value); }); });

  /* the sliding indicator replaces the per-label underline when GSAP is here */
  if (G()) {
    root.classList.add('gk-indon');
    indPos(false);
    var raf = 0;
    w.addEventListener('resize', function () { cancelAnimationFrame(raf); raf = requestAnimationFrame(function () { indPos(false); }); });
    if (d.fonts && d.fonts.ready) d.fonts.ready.then(function () { indPos(false); });
  }
}

/* ---------- builders: the on-enter reveal, once ---------- */
function enter(ctx) {
  try {
    indPos(false);
    if (played || !gal) return;
    var g = G(), tab = tabEl('msg'), on = tab.classList.contains('is-on');
    var tl = g.timeline({ paused: true, onComplete: function () { if (enterTL === tl) enterTL = null; } });
    tl.fromTo(q('.gk-rule'), { scaleX: 0 }, { scaleX: 1, duration: D.wipe, ease: E.wipe }, 0)
      .fromTo(q('.gk-ind'), { opacity: 0 }, { opacity: 1, duration: .3, ease: E.enter }, .4);
    if (on) {
      tl.fromTo(qa('.gk-frame .gk-blk', tab), { opacity: 0, y: 10 }, { opacity: 1, y: 0, duration: .4, ease: E.enter, stagger: .08, clearProps: 'opacity,transform' }, .15);
      panelIn(tl, q('.gk-next', tab), .45);
    }
    enterTL = tl;
    var st = Ravi.ST.create({ trigger: gal, start: ctx.frames ? 'top 85%' : 'top 75%', once: true,
      onEnter: function () { if (enterTL === tl) { played = true; tl.play(); } } });
    ctx.add(function () {
      st.kill();
      if (enterTL === tl) enterTL = null;
      tl.kill();
    });
  } finally {
    if (root) root.classList.add('gk-in');
  }
}

Ravi.section('blockkit', { always: init, desk: enter, touch: enter, frames: enter });
} catch (err) { console.error('[section blockkit]', err); }
})();

/* ---- section scale (07-scale.js) ---- */
(function(){
'use strict';
try {
/* 07 · #scale: one person or the whole org (unpinned, toggle).
   always: the radios drive .sc[data-view]; any touch of the toggle stops the auto-switch for good.
   desk:   on enter the bar rises and Just me plays: Ana pops, her agent pops, the sign-in card rises, its
           button presses itself, the card turns to "Signed in as Ana" (check draws, chip pops), then the wire
           draws to the calendar tile, which wipes in with its three entries. 2.5 s later, unless the visitor
           touched the toggle, The whole org: the thumb slides, the counters count up, Ana's row splits into the
           channel map (six channels, six agents: dev has no channel of its own), six tiles fly out of Ana's node into the grid. When the dashboard is in view, the CSV
           chip pops on paragraph 04, counts its rows, flies into the dashboard and is absorbed; the bars grow
           with their totals and the chip docks under the tile. Switching back reverses in .5 s.
   touch:  the same Just me pieces on enter (0.8×); switching crossfades the panels and reveals the org blocks
           as they come into view (the CSV chip drops onto the dashboard, then its bars grow). Auto-switch 2 s.
   frames: static layout (both panels) with time-based on-enter reveals.  reduce / no JS: the authored HTML. */

var E = Ravi.E, D = Ravi.D;
function G() { return Ravi.gsap; }

var root = null, ui = {}, M = null;
var S = { view: 'me', played: false, touched: false };
var fx = [];                       // in-flight transitions (settled before the next one)
var later = [];                    // view-triggered reveals created after a switch: [{st, els}]
var auto = { call: null, pending: false };
var origin = null;                 // Ana's pill centre, relative to .sc, last time it was measured

function q(s, r) { return (r || root).querySelector(s); }
function qa(s, r) { return Array.prototype.slice.call((r || root).querySelectorAll(s)); }
function track(t) { if (t) fx.push(t); return t; }
function hdr() { return parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--hdr')) || 64; }
function cen(el, R) { var r = el.getBoundingClientRect(); return { x: r.left - R.left + r.width / 2, y: r.top - R.top + r.height / 2 }; }
function money(v) { return '$' + Math.round(v).toLocaleString('en-US'); }
/* layout box of el inside rootEl, ignoring transforms (entrances scale and move things) */
function box(el, rootEl) {
  var x = 0, y = 0, n = el;
  while (n && n !== rootEl) { x += n.offsetLeft; y += n.offsetTop; n = n.offsetParent; }
  return { x: x, y: y, w: el.offsetWidth, h: el.offsetHeight, ok: n === rootEl };
}
/* desk: the wire from the agent chip down to the calendar tile it made */
var mePts = [];
function wireMe() {
  var cw = ui.me && ui.me.cw; if (!cw) return;
  if (!M || M.layout !== 'desk' || S.view !== 'me' || !ui.pMe.offsetParent) return;
  var a = box(ui.me.chip, ui.pMe), b = box(ui.me.tileEl, ui.pMe);
  if (!a.ok || !b.ok || !a.w || !b.w) return;
  var x1 = a.x + a.w / 2, y1 = a.y + a.h + 4, x2 = b.x + b.w / 2, y2 = b.y - 2, k = (y2 - y1) * .55;
  cw.setAttribute('d', 'M' + x1 + ' ' + y1 + ' C' + x1 + ' ' + (y1 + k) + ' ' + x2 + ' ' + (y2 - k) + ' ' + x2 + ' ' + y2);
  try { mePts = Ravi.samplePath(cw, 40); } catch (e) { mePts = []; }
}

/* ---------- state ---------- */
function vals(v) { return ui.hud.map(function (n) { return +n.getAttribute(v === 'org' ? 'data-org' : 'data-me'); }); }
function setHud(v) { var a = vals(v); ui.hud.forEach(function (n, i) { n.textContent = String(a[i]); }); }
function hudTo(tl, from, to, dur, ease, at) {
  ui.hud.forEach(function (n, i) {
    var o = { v: from[i] };
    tl.to(o, { v: to[i], duration: dur, ease: ease || 'power2.out', onUpdate: function () { n.textContent = String(Math.round(o.v)); },
      onComplete: function () { n.textContent = String(to[i]); } }, at || 0);
  });
  return tl;
}
function syncRadios() { (S.view === 'org' ? ui.rOrg : ui.rMe).checked = true; }
function swap(v) {
  S.view = v;
  root.setAttribute('data-view', v);
  syncRadios();
  Ravi.refresh();
}
/* the numbers the entrances count from zero go back to their authored text */
function resetText() {
  var o = ui.org;
  o.snapN.textContent = '$2,970';
  o.bns.forEach(function (n, i) { n.textContent = String(o.bnv[i]); });
  if (o.ghostN) o.ghostN.textContent = '812';
}

/* every element any builder animates, per panel, so a switch or a rebuild can clear them */
function meEls() {
  var m = ui.me;
  return [ui.bar.seg].concat(ui.bar.ks, [m.copy, m.src, m.ln, m.dot, m.chip, m.login, m.lgA, m.lgB, m.lgOk, m.lgCk, m.lgChip, m.lgBtn, m.lgRip,
    m.tile, m.vis], m.ents, [ui.pMe, m.cw, m.pk, m.svg]).filter(Boolean);
}
function orgEls() {
  var o = ui.org;
  return [].concat(o.paras, o.rows, o.lns, o.dots, o.chips, o.own, [o.note], o.tiles, o.vis, o.bars, [o.foot, o.sheet, o.ghost, o.fw, o.dashCard],
    o.fun, o.funTx, [o.cv, o.kbCard, o.snapN, o.cap, ui.pOrg]).filter(Boolean);
}
function clear(els) {
  var gsap = G(), t = (els || []).filter(Boolean);
  if (!gsap || !t.length) return;            /* an empty list makes gsap.set warn "target not found" */
  gsap.set(t, { clearProps: 'opacity,transform,clipPath,visibility,strokeDashoffset' });
  t.forEach(function (el) { if (el.style) el.style.removeProperty('--lit'); });
}
function settle() {
  while (fx.length) { var t = fx.shift(); try { t.progress(1, false); t.kill(); } catch (e) {} }
}
function dropLater(reveal) {
  later.forEach(function (x) { try { x.st.kill(); } catch (e) {} if (reveal) clear(x.els); });
  later = [];
}
function cancelAuto() { if (auto.call) { auto.call.kill(); auto.call = null; } auto.pending = false; }

/* ---------- the Just me pieces (desk timeline, or touch segments; k scales the timings) ---------- */
function meNode(tl, at) {
  tl.fromTo(ui.me.src, { opacity: 0, scale: .6 }, { opacity: 1, scale: 1, duration: D.pop, ease: E.pop }, at);
  tl.fromTo(ui.me.ln, { scaleX: 0 }, { scaleX: 1, duration: .3, ease: E.wipe }, at + .25);
  dotRun(tl, ui.me.dot, ui.me.ln, at + .4, .35, 1);
  tl.fromTo(ui.me.chip, { opacity: 0, scale: .6 }, { opacity: 1, scale: 1, duration: D.pop, ease: E.pop }, at + .62);
  tl.fromTo(ui.me.chip, { '--lit': 0 }, { '--lit': 1, duration: .25, ease: E.enter, yoyo: true, repeat: 1, repeatDelay: .3 }, at + .7);
}
/* the sign-in card: rises, its button presses itself, the face turns to "Signed in as Ana" */
function meLogin(tl, at, k) {
  var m = ui.me; k = k || 1;
  tl.fromTo(m.login, { opacity: 0, y: 24 }, { opacity: 1, y: 0, duration: .4 * k, ease: E.rise }, at);
  tl.fromTo(m.lgA, { autoAlpha: 1 }, { autoAlpha: 0, duration: .2 * k, ease: E.exit }, at + .8 * k);
  tl.fromTo(m.lgBtn, { scale: 1 }, { scale: .95, duration: .1 * k, ease: E.exit, yoyo: true, repeat: 1 }, at + .5 * k);
  tl.fromTo(m.lgRip, { scale: .2, opacity: .9 }, { scale: 2.2, opacity: 0, duration: .45 * k, ease: E.enter, immediateRender: false }, at + .52 * k);
  tl.fromTo(m.lgB, { opacity: 0 }, { opacity: 1, duration: .25 * k, ease: E.enter }, at + .9 * k);
  tl.fromTo(m.lgOk, { y: 8 }, { y: 0, duration: .45 * k, ease: E.rise }, at + .9 * k);
  tl.add(Ravi.draw(m.lgCk, .3 * k), at + 1 * k);
  tl.fromTo(m.lgChip, { opacity: 0, scale: .5 }, { opacity: 1, scale: 1, duration: D.pop * k, ease: E.pop }, at + 1.2 * k);
}
function meTile(tl, at, wire, k) {
  var m = ui.me; k = k || 1;
  if (wire) {
    tl.add(Ravi.draw(m.cw, .35), at - .35);
    tl.add(Ravi.packet(m.pk, function () { return mePts; }, .35, E.cut), at - .25);
    tl.fromTo(m.pk, { opacity: 0 }, { opacity: 1, duration: .05, immediateRender: false }, at - .25);
    tl.to(m.pk, { opacity: 0, duration: .12, ease: E.exit }, at + .08);
  }
  /* the tile wipes in from the top; the clip is dropped afterwards so its shadow shows */
  tl.fromTo(m.tile, { clipPath: 'inset(0% 0% 100% 0%)' }, { clipPath: 'inset(0% 0% 0% 0%)', duration: D.wipe * k, ease: E.wipe }, at);
  tl.set(m.tile, { clearProps: 'clipPath' }, at + D.wipe * k);
  tl.fromTo(m.vis, { scale: 0 }, { scale: 1, duration: .35 * k, ease: E.popHard }, at + .3 * k);
  tl.fromTo(m.ents, { opacity: 0, scale: .7 }, { opacity: 1, scale: 1, duration: .35 * k, ease: E.pop, stagger: .08 }, at + .3 * k);
}
/* a dot runs along a wire (x in px of the wire's width) and fades at its end */
function dotRun(tl, dot, ln, at, dur, to) {
  tl.fromTo(dot, { x: 0, opacity: 0 }, { x: function () { return ln.parentNode.offsetWidth * (to == null ? 1 : to); }, opacity: 1, duration: dur, ease: E.cut, immediateRender: false }, at);
  tl.to(dot, { opacity: 0, duration: .15, ease: E.exit }, at + dur);
}
function barIn(tl, at) {
  tl.fromTo(ui.bar.seg, { opacity: 0, y: 16 }, { opacity: 1, y: 0, duration: D.rise, ease: E.rise }, at);
  tl.fromTo(ui.bar.ks, { opacity: 0, y: 12 }, { opacity: 1, y: 0, duration: D.rise, ease: E.rise, stagger: .08 }, at + .1);
}

/* ---------- whole-org entrance pieces ---------- */
function orgRest(t, at) {
  var o = ui.org;
  /* the tiles' own pieces settle after the fly-out (the dashboard waits for its CSV) */
  t.fromTo(o.vis, { scale: 0 }, { scale: 1, duration: .35, ease: E.popHard, stagger: .04 }, at);
  t.fromTo(o.fun, { scaleX: 0 }, { scaleX: 1, duration: .5, ease: E.enter, stagger: .08 }, at + .1);
  t.fromTo(o.funTx, { opacity: 0 }, { opacity: 1, duration: .25, ease: E.enter, stagger: .08 }, at + .35);
  t.fromTo(o.cv, { clipPath: 'inset(0% 0% 100% 0%)' }, { clipPath: 'inset(0% 0% 0% 0%)', duration: D.wipe, ease: E.wipe }, at + .05);
  t.fromTo(o.kbCard, { opacity: 0, y: 10, scale: .9 }, { opacity: 1, y: 0, scale: 1, duration: D.pop, ease: E.popSoft }, at + .15);
  var n = { v: 0 };
  t.fromTo(n, { v: 0 }, { v: 2970, duration: .8, ease: 'power2.out', onUpdate: function () { o.snapN.textContent = money(n.v); },
    onComplete: function () { o.snapN.textContent = '$2,970'; } }, at + .15);
}
/* the dashboard before its CSV arrives: empty bars, zero totals, no footnote, no chip */
function dashEmpty() {
  var o = ui.org, gsap = G();
  gsap.set(o.bars, { scaleX: 0 });
  gsap.set([o.foot, o.sheet], { opacity: 0 });
  o.bns.forEach(function (n) { n.textContent = '0'; });
}
/* the bars grow as their totals count up; the footnote comes last */
function dashFill(t, at) {
  var o = ui.org;
  t.fromTo(o.bars, { scaleX: 0 }, { scaleX: 1, duration: D.wipe, ease: E.wipe, stagger: .08 }, at);
  o.bns.forEach(function (n, i) { t.add(Ravi.count(n, o.bnv[i], .6), at + i * .08); });
  t.fromTo(o.foot, { opacity: 0, y: 6 }, { opacity: 1, y: 0, duration: .4, ease: E.enter }, at + .85);
}
function rowsIn(t, at, from) {
  var o = ui.org, R = root.getBoundingClientRect();
  o.rows.forEach(function (row, i) {
    var c = cen(row.querySelector('.sc-src'), R), k = at + i * .06;
    if (from) t.fromTo(row, { x: from.x - c.x, y: from.y - c.y, opacity: 0, scale: .9 }, { x: 0, y: 0, opacity: 1, scale: 1, duration: D.rise, ease: E.rise }, k);
    else t.fromTo(row, { x: -14, opacity: 0 }, { x: 0, opacity: 1, duration: .45, ease: E.rise }, k);
    t.fromTo(o.lns[i], { scaleX: 0 }, { scaleX: 1, duration: .3, ease: E.wipe }, k + .22);
    /* #random's message stops short (no agent); dev has no channel, so nothing runs along its wire */
    var un = row.classList.contains('sc-row--un');
    if (!row.classList.contains('sc-row--nc')) dotRun(t, o.dots[i], o.lns[i], k + .42, un ? .3 : .35, un ? .62 : 1);
    var ch = row.querySelector('.sc-chip');
    if (ch) t.fromTo(ch, { '--lit': 0 }, { '--lit': 1, duration: .2, ease: E.enter, yoyo: true, repeat: 1, repeatDelay: .25 }, k + .74);
    var own = row.querySelector('.sc-own');
    if (own) t.fromTo(own, { opacity: 0, scale: .7 }, { opacity: 1, scale: 1, duration: .35, ease: E.popSoft }, k + .5);
  });
  t.fromTo(o.note, { opacity: 0, y: 10 }, { opacity: 1, y: 0, duration: D.enter, ease: E.enter }, at + o.rows.length * .06 + .55);
}
/* reveal a block when it comes into view; if it is already in view, play now */
function onView(el, hide, make, start) {
  var gsap = G();
  if (hide.length) gsap.set(hide, { opacity: 0 });
  var rec = { els: hide, st: null };
  rec.st = Ravi.ST.create({ trigger: el, start: start || 'top 88%', once: true, onEnter: function () {
    if (hide.length) gsap.set(hide, { clearProps: 'opacity' });
    make();
  } });
  later.push(rec);
}

/* ---------- desk: the CSV chip flies from paragraph 04 into the dashboard ---------- */
function quad(a, c, b, n) {
  var out = [];
  for (var i = 0; i <= n; i++) {
    var s = i / n, u = 1 - s;
    out.push({ x: u * u * a.x + 2 * u * s * c.x + s * s * b.x, y: u * u * a.y + 2 * u * s * c.y + s * s * b.y });
  }
  return out;
}
function csvFlight() {
  var gsap = G(), o = ui.org, P = ui.pOrg;
  if (!o.ghost || !P.offsetParent) return;
  var p = box(o.p4, P), d = box(o.dashCard, P);
  if (!p.ok || !d.ok) return;
  var gw = o.ghost.offsetWidth || 200;
  /* the chip pops on paragraph 04's top right corner, kept inside the panel (on compact desks the paragraph
     ends at the panel's right edge) */
  var a = { x: Math.max(gw / 2, Math.min(p.x + p.w - gw / 2, P.clientWidth - gw / 2 - 4)), y: p.y };
  var b = { x: d.x + d.w / 2, y: d.y + d.h * .52 };
  var lift = b.y - a.y > 240 ? 40 : Math.max(90, Math.abs(b.x - a.x) * .22);
  var c = { x: (a.x + b.x) / 2, y: Math.min(a.y, b.y) - lift };
  var pts = quad(a, c, b, 48);
  o.fw.setAttribute('d', 'M' + a.x + ' ' + a.y + ' Q' + c.x + ' ' + c.y + ' ' + b.x + ' ' + b.y);
  o.ghostN.textContent = '0';
  var t = track(gsap.timeline());
  t.set(o.ghost, { xPercent: -50, yPercent: -50, x: a.x, y: a.y }, 0);
  t.fromTo(o.ghost, { autoAlpha: 0, scale: .5 }, { autoAlpha: 1, scale: 1, duration: D.pop, ease: E.pop }, 0);
  t.add(Ravi.count(o.ghostN, 812, .8), .12);
  t.fromTo(o.fw, { strokeDashoffset: 1, opacity: 1 }, { strokeDashoffset: 0, duration: .9, ease: 'none', autoRound: false }, 1);
  t.add(Ravi.packet(o.ghost, pts, .9, E.travel), 1);
  t.to(o.ghost, { scale: .6, autoAlpha: 0, duration: .25, ease: E.exit }, 1.88);
  t.to(o.fw, { opacity: 0, duration: .45, ease: E.exit }, 1.95);
  /* the dashboard fills where it can be seen: now, or (compact desks, where it sits far below paragraph 04)
     when it comes into view */
  t.call(function () { if (seen(o.dashCard, .9)) dashLand(); else onView(o.dashCard, [], dashLand, 'top 80%'); }, null, 1.9);
}
/* the chip is absorbed: the dashboard bumps, its bars grow with their totals, the chip docks under it */
function dashLand() {
  var o = ui.org, t = track(G().timeline());
  t.fromTo(o.dashCard, { scale: 1 }, { scale: 1.02, duration: .14, ease: E.enter, yoyo: true, repeat: 1 }, 0);
  dashFill(t, .12);
  t.fromTo(o.sheet, { opacity: 0, y: -10, scale: .92 }, { opacity: 1, y: 0, scale: 1, duration: D.pop, ease: E.popSoft }, .85);
}
function seen(el, k) { var r = el.getBoundingClientRect(); return r.top < window.innerHeight * k && r.bottom > hdr() + 20; }
/* wide desks: paragraph 04 sits beside the dashboard, so the flight waits for both. Compact desks stack the copy
   far above the tiles: the chip pops while paragraph 04 is on screen and the dashboard fills when it arrives. */
function compactDesk() { return !!(M && M.ctx && M.ctx.compact); }
function csvStart() {
  var o = ui.org;
  if (compactDesk()) { if (seen(o.p4, .85)) csvFlight(); else onView(o.p4, [], csvFlight, 'top 85%'); return; }
  if (seen(o.dashCard, .85) && seen(o.p4, .92)) csvFlight();
  else onView(o.dashCard, [], csvFlight, 'top 78%');
}

/* ---------- desk transitions ---------- */
/* the thumb slides under the labels; its inner copy of the labels slides back by the same distance,
   so the dark label text stays put and is revealed by the thumb (transform only, no colour tween) */
function thumbTo(t, v) {
  var a = v === 'org' ? [0, 100] : [100, 0];
  /* x: 0 drops the px offset GSAP would otherwise parse from the CSS end state (translateX(100%)) */
  t.fromTo(ui.thumb, { x: 0, xPercent: a[0] }, { x: 0, xPercent: a[1], duration: .35, ease: E.cut }, 0);
  t.fromTo(ui.thumbIn, { x: 0, xPercent: -a[0] / 2 }, { x: 0, xPercent: -a[1] / 2, duration: .35, ease: E.cut }, 0);
  t.set([ui.thumb, ui.thumbIn], { clearProps: 'transform' }, .36);
}
function deskToOrg() {
  var gsap = G(), m = ui.me;
  settle(); dropLater(true);
  var R = root.getBoundingClientRect();
  var o = cen(m.src, R);
  origin = { x: o.x, y: o.y, w: root.offsetWidth };
  var t = track(gsap.timeline());
  thumbTo(t, 'org');
  hudTo(t, vals('me'), vals('org'), .8, 'power2.out', .05);
  t.to([m.copy, m.login, m.tile, m.chip, m.ln], { opacity: 0, y: -8, duration: .2, ease: E.exit, stagger: .02 }, 0);
  t.to(m.svg, { opacity: 0, duration: .15, ease: E.exit }, 0);
  t.to(m.src, { scale: 1.08, duration: .2, ease: E.exit }, 0);
  t.call(function () { swap('org'); clear(meEls()); deskOrgIn(o); }, null, .22);
}
function deskOrgIn(from) {
  var gsap = G(), o = ui.org, R = root.getBoundingClientRect();
  dashEmpty();
  var t = track(gsap.timeline());
  t.fromTo(o.paras, { opacity: 0, y: 24 }, { opacity: 1, y: 0, duration: D.rise, ease: E.rise, stagger: .06 }, .08);
  rowsIn(t, 0, from);
  /* the six tiles fly out of Ana's node into the grid */
  o.tiles.forEach(function (li, i) {
    var c = cen(li, R);
    t.fromTo(li, { x: from.x - c.x, y: from.y - c.y, scale: .22 }, { x: 0, y: 0, scale: 1, duration: D.rise, ease: E.rise }, .3 + i * .06);
    t.fromTo(li, { opacity: 0 }, { opacity: 1, duration: .14, ease: 'none' }, .3 + i * .06);
  });
  orgRest(t, .85);
  t.fromTo(o.cap, { opacity: 0, y: 10 }, { opacity: 1, y: 0, duration: D.enter, ease: E.enter }, 1.25);
  /* then the spreadsheet: now if the dashboard and paragraph 04 are on screen, otherwise when they arrive */
  t.call(csvStart, null, 1.35);
}
function deskToMe() {
  var gsap = G(), o = ui.org, m = ui.me;
  settle(); dropLater(true);
  var R = root.getBoundingClientRect(), mp = o.map.getBoundingClientRect();
  var to = origin && origin.w === root.offsetWidth ? origin : { x: mp.left - R.left + 40, y: mp.top - R.top + 100 };
  var t = track(gsap.timeline());
  thumbTo(t, 'me');
  hudTo(t, vals('org'), vals('me'), .5, 'power2.out', 0);
  o.tiles.slice().reverse().forEach(function (li, i) {
    var c = cen(li, R);
    t.to(li, { x: to.x - c.x, y: to.y - c.y, scale: .22, opacity: 0, duration: .3, ease: E.exit }, i * .02);
  });
  o.rows.forEach(function (row, i) {
    var c = cen(row.querySelector('.sc-src'), R);
    t.to(row, { x: to.x - c.x, y: to.y - c.y, opacity: 0, scale: .9, duration: .28, ease: E.exit }, .02 + i * .02);
  });
  t.to(o.paras.concat([o.note, o.cap, o.ghost]), { opacity: 0, duration: .2, ease: E.exit }, 0);
  t.call(function () {
    swap('me'); clear(orgEls()); clear(meEls()); resetText(); wireMe();
    var u = track(gsap.timeline());
    u.fromTo(m.svg, { opacity: 0 }, { opacity: 1, duration: .2, ease: E.enter }, .05);
    u.fromTo(m.src, { scale: 1.08, opacity: 0 }, { scale: 1, opacity: 1, duration: .2, ease: E.popSoft }, 0);
    u.fromTo([m.chip, m.copy, m.login], { opacity: 0 }, { opacity: 1, duration: .18, ease: E.enter }, .02);
    u.fromTo(m.tile, { opacity: 0, scale: .9 }, { opacity: 1, scale: 1, duration: .2, ease: E.popSoft }, .02);
  }, null, .32);
}

/* ---------- touch transitions (crossfade .3, blocks reveal in view) ---------- */
function touchToOrg() {
  var gsap = G();
  settle(); dropLater(true);
  var t = track(gsap.timeline());
  thumbTo(t, 'org');
  hudTo(t, vals('me'), vals('org'), .8, 'power2.out', .05);
  t.to(ui.pMe, { opacity: 0, duration: .15, ease: E.exit }, 0);
  t.call(function () {
    swap('org'); clear(meEls());
    var o = ui.org, u = track(gsap.timeline());
    u.fromTo(ui.pOrg, { opacity: 0 }, { opacity: 1, duration: .3, ease: E.enter }, 0);
    u.fromTo(o.paras, { opacity: 0, y: 18 }, { opacity: 1, y: 0, duration: D.rise, ease: E.rise, stagger: .06 }, .05);
    touchOrgBlocks();
  }, null, .15);
}
function touchOrgBlocks() {
  var o = ui.org, gsap = G();
  onView(o.map, o.rows.concat([o.note]), function () { var t = track(gsap.timeline()); rowsIn(t, 0, null); });
  o.tiles.forEach(function (li, i) {
    onView(li, [li], function () {
      var t = track(gsap.timeline());
      t.fromTo(li, { opacity: 0, y: 24 }, { opacity: 1, y: 0, duration: D.rise, ease: E.rise }, (i % 2) * .05);
      tileBits(t, li, .3);
    });
  });
  onView(o.cap, [o.cap], function () { track(gsap.fromTo(o.cap, { opacity: 0, y: 10 }, { opacity: 1, y: 0, duration: D.enter, ease: E.enter })); });
}
/* the per-tile pieces, on their own (touch) */
function tileBits(t, li, at) {
  var o = ui.org;
  var v = li.querySelector('.sc-vis'); if (v) t.fromTo(v, { scale: 0 }, { scale: 1, duration: .35, ease: E.popHard }, at);
  if (li.contains(o.dashCard)) {
    /* the CSV chip drops onto the dashboard, then the bars grow with their totals */
    o.bns.forEach(function (n) { n.textContent = '0'; });
    t.fromTo(o.sheet, { opacity: 0, y: -24 }, { opacity: 1, y: 0, duration: D.enter, ease: E.enter }, at);
    dashFill(t, at + .35);
  }
  var f = qa('.sc-fun>li>i', li); if (f.length) { t.fromTo(f, { scaleX: 0 }, { scaleX: 1, duration: .5, ease: E.enter, stagger: .08 }, at); t.fromTo(qa('.sc-fun span', li), { opacity: 0 }, { opacity: 1, duration: .25, stagger: .08 }, at + .25); }
  var cv = li.querySelector('.sc-cv'); if (cv) t.fromTo(cv, { clipPath: 'inset(0% 0% 100% 0%)' }, { clipPath: 'inset(0% 0% 0% 0%)', duration: D.wipe, ease: E.wipe }, at);
  var k = li.querySelector('.sc-kb-card'); if (k) t.fromTo(k, { opacity: 0, y: 10, scale: .9 }, { opacity: 1, y: 0, scale: 1, duration: D.pop, ease: E.popSoft }, at);
  if (li.contains(o.snapN)) { var n = { v: 0 }; t.fromTo(n, { v: 0 }, { v: 2970, duration: .8, ease: 'power2.out', onUpdate: function () { o.snapN.textContent = money(n.v); }, onComplete: function () { o.snapN.textContent = '$2,970'; } }, at); }
}
function touchToMe() {
  var gsap = G();
  settle(); dropLater(true);
  var t = track(gsap.timeline());
  thumbTo(t, 'me');
  hudTo(t, vals('org'), vals('me'), .5, 'power2.out', 0);
  t.to(ui.pOrg, { opacity: 0, duration: .15, ease: E.exit }, 0);
  t.call(function () {
    swap('me'); clear(orgEls()); clear(meEls()); resetText();
    track(gsap.fromTo(ui.pMe, { opacity: 0 }, { opacity: 1, duration: .3, ease: E.enter }));
  }, null, .15);
}

/* ---------- switching ---------- */
function finishIntro() {
  if (!M) return;
  (M.intros || []).forEach(function (x) { try { if (x.st) x.st.kill(); x.tl.progress(1, false); x.tl.kill(); } catch (e) {} });
  M.intros = [];
  if (!S.played) { S.played = true; setHud(S.view); }
}
function go(v, user) {
  if (user) { S.touched = true; cancelAuto(); }
  if (v === S.view) { syncRadios(); return; }
  if (!M || !G()) { S.view = v; root.setAttribute('data-view', v); setHud(v); Ravi.refresh(); return; }
  finishIntro();
  if (M.layout === 'desk') (v === 'org' ? deskToOrg : deskToMe)();
  else (v === 'org' ? touchToOrg : touchToMe)();
}
function inView() {
  var r = root.getBoundingClientRect(), h = window.innerHeight;
  /* the section must hold the reading area (its bottom below 60% of the viewport): the org view is taller,
     so switching while the next section is being read would push that section down */
  return r.top < h * .8 && r.bottom > Math.max(h * .6, hdr() + 160);
}
function introDone() {
  S.played = true;
  if (S.touched || S.view !== 'me' || !M) return;
  scheduleAuto(M.layout === 'touch' ? 2 : 2.5);
}
function scheduleAuto(sec) {
  cancelAuto();
  auto.call = G().delayedCall(sec, function () {
    auto.call = null;
    if (!M || S.touched || S.view !== 'me') return;
    if (!inView()) { auto.pending = true; return; }
    go('org', false);
    Ravi.announce('The whole org');
  });
}

/* ---------- motion builders ---------- */
function start(ctx, layout) {
  if (!root) return;
  var gsap = G(), ST = Ravi.ST, m = ui.me;
  M = { layout: layout, ctx: ctx, intros: [] };
  if (S.view === 'org') { S.played = true; }
  gsap.set([ui.thumb, ui.thumbIn], { clearProps: 'transform' });
  wireMe();
  ctx.onRefresh(wireMe);

  /* come back into view with an auto-switch pending */
  ST.create({ trigger: root, start: 'top 80%', end: function () { return 'bottom ' + Math.max(Math.round(innerHeight * .6), hdr() + 160) + 'px'; }, onToggle: function (self) {
    if (self.isActive && auto.pending && !S.touched && S.view === 'me') { auto.pending = false; scheduleAuto(.8); }
  } });

  if (!S.played) {
    ui.hud.forEach(function (n) { n.textContent = '0'; });
    if (layout === 'desk') {
      var bar = gsap.timeline({ paused: true }); barIn(bar, 0);
      var bst = ST.create({ trigger: ui.bar.el, start: 'top 92%', once: true, onEnter: function () { bar.play(); } });
      M.intros.push({ tl: bar, st: bst });
      var tl = gsap.timeline({ paused: true, onComplete: introDone });
      meNode(tl, 0);
      tl.fromTo(m.copy, { opacity: 0, y: 24 }, { opacity: 1, y: 0, duration: D.rise, ease: E.rise }, .1);
      meLogin(tl, .45, 1);
      meTile(tl, 2.25, true, 1);
      hudTo(tl, [0, 0, 0, 0], vals('me'), .55, 'power2.out', 2.3);
      var st = ST.create({ trigger: root, start: 'top 70%', once: true, onEnter: function () { tl.play(); } });
      M.intros.push({ tl: tl, st: st });
    } else {
      var b = gsap.timeline({ paused: true }); barIn(b, 0); hudTo(b, [0, 0, 0, 0], vals('me'), .55, 'power2.out', .35);
      M.intros.push({ tl: b, st: ST.create({ trigger: ui.bar.el, start: 'top 88%', once: true, onEnter: function () { b.play(); } }) });
      var c = gsap.timeline({ paused: true }); c.fromTo(m.copy, { opacity: 0, y: 18 }, { opacity: 1, y: 0, duration: D.rise, ease: E.rise }, 0);
      M.intros.push({ tl: c, st: ST.create({ trigger: m.copy, start: 'top 88%', once: true, onEnter: function () { c.play(); } }) });
      var n = gsap.timeline({ paused: true }); meNode(n, 0);
      M.intros.push({ tl: n, st: ST.create({ trigger: m.node, start: 'top 88%', once: true, onEnter: function () { n.play(); } }) });
      /* the calendar comes after the sign-in: if the card is still playing when the tile enters, it waits for it */
      var lgOn = false, lgDone = false, tiWait = false;
      var ti = gsap.timeline({ paused: true, onComplete: introDone }); meTile(ti, 0, false, .8);
      var lg = gsap.timeline({ paused: true, onComplete: function () { lgDone = true; if (tiWait) { tiWait = false; ti.play(); } } }); meLogin(lg, 0, .8);
      M.intros.push({ tl: lg, st: ST.create({ trigger: m.login, start: 'top 85%', once: true, onEnter: function () { lgOn = true; lg.play(); } }) });
      M.intros.push({ tl: ti, st: ST.create({ trigger: m.tile, start: 'top 85%', once: true, onEnter: function () {
        if (lgOn && !lgDone) tiWait = true; else ti.play();
      } }) });
    }
  } else {
    setHud(S.view);
  }

  return function () {
    cancelAuto();
    (M && M.intros || []).forEach(function (x) { try { if (x.st) x.st.kill(); x.tl.kill(); } catch (e) {} });
    settle(); dropLater(false);
    clear(meEls().concat(orgEls(), [ui.thumb, ui.thumbIn]));
    resetText();
    setHud(S.view);
    M = null;
  };
}
function desk(ctx) { return start(ctx, 'desk'); }
function touch(ctx) { return start(ctx, 'touch'); }

/* frames: the static layout (both panels) with time-based on-enter reveals */
function frames(ctx) {
  if (!root) return;
  var gsap = G(), blocks = ctx.$$('.sc-seg, .sc-ph, .sc-hud--panel, .sc-copy, .sc-node, .sc-login, .sc-mapw, .sc-tiles>li, .sc-cap');
  gsap.set(blocks, { opacity: 0, y: 24 });
  Ravi.ST.batch(blocks, { start: 'top 85%', once: true, onEnter: function (b) {
    gsap.to(b, { opacity: 1, y: 0, duration: D.rise, ease: E.rise, stagger: .06, overwrite: true });
  } });
}

/* ---------- always: wire the toggle (every JS mode) ---------- */
function always(c) {
  root = c.$('.sc');
  if (!root) return;
  ui = {
    rMe: q('#sc-r-me'), rOrg: q('#sc-r-org'), seg: q('.sc-seg'), thumb: q('.sc-thumb'), thumbIn: q('.sc-thumb-in'),
    hud: qa('.sc-hud--bar .sc-n'), pMe: q('.sc-panel--me'), pOrg: q('.sc-panel--org'),
    bar: { el: q('.sc-bar'), seg: q('.sc-seg'), ks: qa('.sc-hud--bar .sc-k') }
  };
  var pm = ui.pMe, po = ui.pOrg;
  ui.me = {
    copy: q('.sc-copy--me', pm), node: q('.sc-node', pm), src: q('.sc-row--me .sc-src', pm), ln: q('.sc-row--me .sc-ln', pm), dot: q('.sc-row--me .sc-dot', pm),
    chip: q('.sc-row--me .sc-chip', pm),
    login: q('.sc-login', pm), lgA: q('.sc-lg-a', pm), lgB: q('.sc-lg-b', pm), lgOk: q('.sc-lg-ok', pm), lgCk: q('.sc-lg-ck path', pm),
    lgChip: q('.sc-lg-chip', pm), lgBtn: q('.sc-lg-btn', pm), lgRip: q('.sc-lg-btn .cur-ripple', pm),
    tile: q('.sc-tiles--me>li', pm), tileEl: q('.sc-tiles--me .sc-tile', pm), vis: q('.sc-tiles--me .sc-vis', pm), ents: qa('.sc-cal>li', pm),
    svg: q('.sc-cwires', pm), cw: q('.sc-cw', pm), pk: q('.sc-pk', pm)
  };
  ui.org = {
    paras: qa('.sc-copy--org>li', po), p4: q('.sc-p--csv', po), map: q('.sc-map', po), rows: qa('.sc-map>.sc-row', po), lns: qa('.sc-map .sc-ln', po), dots: qa('.sc-map .sc-dot', po),
    chips: qa('.sc-map .sc-chip', po), own: qa('.sc-map .sc-own', po), note: q('.sc-mapnote', po),
    tiles: qa('.sc-tiles--org>li', po), vis: qa('.sc-tiles--org .sc-vis', po),
    dashCard: q('.sc-t--dash', po), bars: qa('.sc-bt>i', po), bns: qa('.sc-bn', po), foot: q('.sc-foot', po), sheet: q('.sc-li--dash>.sc-sheet', po),
    fw: q('.sc-fw', po), fun: qa('.sc-fun>li>i', po), funTx: qa('.sc-fun span', po),
    cv: q('.sc-cv', po), kbCard: q('.sc-kb-card', po), snapN: q('.sc-snap-n', po), cap: q('.sc-cap', po)
  };
  ui.org.bnv = ui.org.bns.map(function (n) { return +n.textContent; });
  /* the flying copy of the CSV chip (desk only), outside the tile so it can travel over the panel */
  if (ui.org.sheet) {
    var g = ui.org.sheet.cloneNode(true);
    g.className = 'sc-sheet sc-sheet--fly';
    g.setAttribute('aria-hidden', 'true');
    po.appendChild(g);
    ui.org.ghost = g; ui.org.ghostN = q('.sc-rn', g);
  }

  /* the browser may restore a checked radio on reload */
  S.view = ui.rOrg.checked ? 'org' : 'me';
  if (S.view === 'org') S.touched = true;
  root.setAttribute('data-view', S.view);
  setHud(S.view);

  function touched() { S.touched = true; cancelAuto(); }
  c.on(ui.seg, 'pointerdown', touched);
  c.on(ui.seg, 'keydown', function (e) { if (/^(Arrow|Home|End| |Enter)/.test(e.key) || e.key === ' ') touched(); });
  [ui.rMe, ui.rOrg].forEach(function (r) {
    c.on(r, 'change', function () { if (r.checked) go(r.value, true); });
  });
}

Ravi.section('scale', { always: always, desk: desk, touch: touch, frames: frames });
} catch (err) { console.error('[section scale]', err); }
})();

/* ---- section skills (08-skills.js) ---- */
(function(){
'use strict';
try {
/* 08 · #skills: they show you the plan first (unpinned).
   always: the Canvas tile also opens the Canvas tab of the #blockkit gallery when that gallery is on the page.
   desk:   the plan card rises, its header masks in and the six empty tiles rise beside it; the six plan lines
           type one after another (1.4 s). When the tiles are on screen, each answer lifts off its line as a
           small card (the line dims to 66%, still above 4.5:1 on the card) and flies along an arc into its
           tile (E.travel, stagger .08). As a card lands, the tile's frame lights, its question masks in and
           its station chip pops. The note last.
   touch / frames: the card rises, its lines appear one after another (stagger .06); the tiles rise (stagger .05).
   reduce / no JS: the authored HTML is the final state. */

var E = Ravi.E, D = Ravi.D;
/* a plan line, once its answer has flown to its tile: receded, but ink at .66 on the card is still 5.3:1 (AA) */
var DIM = .66;

function pbAlways(c) {
  /* The page scroll to #blockkit is core's (in-page anchors). The tab switches once the scroll has arrived:
     the gallery re-measures the page when its tab changes, which would stop a smooth scroll halfway. */
  function offset(bk) { return bk.getBoundingClientRect().top - (parseFloat(getComputedStyle(bk).scrollMarginTop) || 0); }
  function pick(r) { if (!r.checked) { r.checked = true; r.dispatchEvent(new Event('change', { bubbles: true })); } }
  function arrive(bk, r, tries) {
    var done = false, timer = 0;
    function end() {
      if (done) return; done = true;
      window.removeEventListener('scrollend', end); clearTimeout(timer);
      var off = offset(bk);
      if (Math.abs(off) > 40 && tries > 0) { Ravi.scrollToY(window.pageYOffset + off); arrive(bk, r, tries - 1); return; }
      pick(r);
    }
    window.addEventListener('scrollend', end);
    timer = setTimeout(end, 1600);
  }
  c.$$('.pb-tile[data-tab]').forEach(function (a) {
    c.on(a, 'click', function (e) {
      if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      var bk = document.getElementById('blockkit'); if (!bk) return;
      var want = a.getAttribute('data-tab'), radios = bk.querySelectorAll('input[type="radio"]');
      for (var i = 0; i < radios.length; i++) {
        var r = radios[i], lab = r.id ? bk.querySelector('label[for="' + r.id + '"]') : null;
        if (lab && lab.textContent.trim() === want) {
          if (r.checked) return;
          if (Math.abs(offset(bk)) <= 40) pick(r); else arrive(bk, r, 1);
          return;
        }
      }
    });
  });
}

/* layout box of el inside rootEl, ignoring transforms */
function pbBox(el, rootEl) {
  var x = 0, y = 0, n = el;
  while (n && n !== rootEl) { x += n.offsetLeft; y += n.offsetTop; n = n.offsetParent; }
  return { x: x, y: y, w: el.offsetWidth, h: el.offsetHeight, ok: n === rootEl };
}
function pbArc(a, b, lift, n) {
  var c = { x: (a.x + b.x) / 2, y: Math.min(a.y, b.y) - lift }, out = [];
  for (var i = 0; i <= n; i++) {
    var s = i / n, u = 1 - s;
    out.push({ x: u * u * a.x + 2 * u * s * c.x + s * s * b.x, y: u * u * a.y + 2 * u * s * c.y + s * s * b.y });
  }
  return out;
}

/* ---- desk ---- */
function pbDesk(ctx) {
  var gsap = Ravi.gsap, ST = Ravi.ST;
  var grid = ctx.$('.pb-grid'), plan = ctx.$('.pb-plan'), head = ctx.$('.pb-ph-in'), note = ctx.$('.pb-note');
  var nums = ctx.$$('.pb-ln-n'), texts = ctx.$$('.pb-ln-t'), list = ctx.$('.pb-tiles'), lis = ctx.$$('.pb-tiles>li');
  var tiles = ctx.$$('.pb-tile');
  var qs = tiles.map(function (t) { return t.querySelector('.pb-tq-in'); });
  var as = tiles.map(function (t) { return t.querySelector('.pb-ta'); });
  var chips = tiles.map(function (t) { return t.querySelector('.pb-tl'); });
  var frames = tiles.map(function (t) { return t.querySelector('.pb-tf'); });
  if (!grid || !plan || texts.length !== tiles.length) return;

  /* one flying copy per tile: the tile's own answer card */
  var ghosts = as.map(function (a) {
    var g = document.createElement('span');
    g.className = 'pb-ghost'; g.setAttribute('aria-hidden', 'true'); g.textContent = a.textContent;
    grid.appendChild(g); return g;
  });

  /* 1. the card, the empty tiles, the six lines typing (1.4 s) */
  var intro = gsap.timeline({ paused: true });
  intro.fromTo(plan, { opacity: 0, y: 24 }, { opacity: 1, y: 0, duration: D.rise, ease: E.rise }, 0);
  Ravi.maskIn(intro, head, .12);
  intro.fromTo(lis, { opacity: 0, y: 24 }, { opacity: 1, y: 0, duration: D.rise, ease: E.rise, stagger: .05 }, .2);
  var T0 = .5, step = 1.4 / texts.length;
  texts.forEach(function (t, i) {
    var at = T0 + i * step;
    intro.fromTo(nums[i], { opacity: 0, scale: .4 }, { opacity: 1, scale: 1, duration: .3, ease: E.pop }, at);
    intro.add(Ravi.typeLine(t, step - .04), at + .04);
  });

  /* 2. the flight, measured when it starts */
  var fly = null, introDone = false, gateOk = false, wait = null;
  function launch() {
    if (fly || !introDone || !gateOk) return;
    if (wait) { wait.kill(); wait = null; }
    fly = gsap.timeline();
    var DUR = .7;
    tiles.forEach(function (t, i) {
      var g = ghosts[i], src = pbBox(texts[i], grid), dst = pbBox(as[i], grid), at = i * .08, land = at + DUR;
      if (!src.ok || !dst.ok) {
        fly.fromTo(as[i], { opacity: 0 }, { opacity: 1, duration: .3, ease: E.enter }, at);
      } else {
        g.style.width = dst.w + 'px'; g.style.left = dst.x + 'px'; g.style.top = dst.y + 'px';
        /* the card's text starts exactly over the line's text (border 3 + padding 12, padding 8) */
        var a = { x: src.x - 15 - dst.x, y: src.y - 8 - dst.y }, b = { x: 0, y: 0 };
        var pts = pbArc(a, b, 36 + Math.abs(a.x) * .08, 40);
        fly.set(g, { x: a.x, y: a.y, scale: 1 }, at);
        fly.fromTo(g, { autoAlpha: 0 }, { autoAlpha: 1, duration: .12, ease: E.enter, immediateRender: false }, at);
        fly.fromTo(g, { scale: 1 }, { scale: 1.05, duration: .18, ease: E.popSoft, immediateRender: false }, at);
        fly.to(g, { scale: 1, duration: .3, ease: E.enter }, land - .3);
        fly.add(Ravi.packet(g, pts, DUR, E.travel), at);
        fly.to(texts[i], { opacity: DIM, duration: .3, ease: E.enter }, at);
        fly.fromTo(as[i], { opacity: 0 }, { opacity: 1, duration: .12, ease: 'none', immediateRender: false }, land - .02);
        fly.to(g, { autoAlpha: 0, duration: .14, ease: 'none' }, land);
      }
      fly.fromTo(frames[i], { '--pb-hit': 0 }, { '--pb-hit': 1, duration: .12, ease: E.enter, immediateRender: false }, land - .04);
      fly.to(frames[i], { '--pb-hit': 0, duration: .6, ease: E.exit }, land + .2);
      Ravi.maskIn(fly, qs[i], land - .06);
      fly.fromTo(chips[i], { opacity: 0, scale: .4 }, { opacity: 1, scale: 1, duration: D.pop, ease: E.pop, immediateRender: false }, land + .1);
    });
    fly.fromTo(note, { opacity: 0, y: 12 }, { opacity: 1, y: 0, duration: D.enter, ease: E.enter, immediateRender: false }, (tiles.length - 1) * .08 + DUR + .2);
  }
  intro.eventCallback('onComplete', function () {
    introDone = true;
    launch();
    /* if the tiles never fully come into view, fly anyway after a short wait */
    if (!fly) wait = gsap.delayedCall(2.2, function () { wait = null; gateOk = true; launch(); });
  });
  ST.create({ trigger: grid, start: 'top 72%', once: true, onEnter: function () { intro.play(); } });
  /* the flight waits until the six tiles are on screen */
  ST.create({ trigger: list, start: function () { return 'bottom ' + Math.round(innerHeight - 24) + 'px'; }, once: true, onEnter: function () { gateOk = true; launch(); } });

  /* keyboard focus on a tile before it has its answer: finish everything at once */
  function finish() {
    if (!introDone) { intro.progress(1); }
    gateOk = true; launch();
    if (fly) fly.progress(1);
  }
  ctx.on(list, 'focusin', finish);

  return function () {
    if (wait) wait.kill();
    if (fly) fly.kill();
    gsap.set(ghosts.concat(texts, as, qs, chips, [note]), { clearProps: 'opacity,transform,visibility,clipPath' });
    frames.forEach(function (f) { f.style.removeProperty('--pb-hit'); });
    ghosts.forEach(function (g) { if (g.parentNode) g.parentNode.removeChild(g); });
  };
}

/* ---- touch and frames ---- */
function pbSoft(ctx) {
  var gsap = Ravi.gsap, ST = Ravi.ST, start = ctx.frames ? 'top 85%' : 'top 82%';
  var plan = ctx.$('.pb-plan'), lns = ctx.$$('.pb-ln'), note = ctx.$('.pb-note'), lis = ctx.$$('.pb-tiles>li');
  if (!plan) return;
  var tl = gsap.timeline({ paused: true });
  tl.fromTo(plan, { opacity: 0, y: 24 }, { opacity: 1, y: 0, duration: D.rise, ease: E.rise }, 0);
  tl.fromTo(lns, { opacity: 0, y: 6 }, { opacity: 1, y: 0, duration: .3, ease: E.enter, stagger: .06 }, .2);
  tl.fromTo(note, { opacity: 0, y: 12 }, { opacity: 1, y: 0, duration: D.enter, ease: E.enter }, .2 + lns.length * .06 + .15);
  ST.create({ trigger: plan, start: start, once: true, onEnter: function () { tl.play(); } });
  /* the tiles rise as they come into view (stagger .05); each answer card slides in, then its chip pops */
  gsap.set(lis, { opacity: 0, y: 24 });
  ST.batch(lis, { start: ctx.frames ? 'top 85%' : 'top 94%', once: true, onEnter: function (batch) {
    var t = gsap.timeline();
    t.to(batch, { opacity: 1, y: 0, duration: D.rise, ease: E.rise, stagger: .05 }, 0);
    batch.forEach(function (li, i) {
      t.fromTo(li.querySelector('.pb-ta'), { opacity: 0, x: -16 }, { opacity: 1, x: 0, duration: .45, ease: E.rise }, .15 + i * .05);
      t.fromTo(li.querySelector('.pb-tl'), { opacity: 0, scale: .4 }, { opacity: 1, scale: 1, duration: D.pop, ease: E.pop }, .3 + i * .05);
    });
  } });
  return function () { gsap.set(ctx.$$('.pb-tiles>li, .pb-ta, .pb-tl'), { clearProps: 'opacity,transform' }); };
}

Ravi.section('skills', { always: pbAlways, desk: pbDesk, touch: pbSoft, frames: pbSoft });
} catch (err) { console.error('[section skills]', err); }
})();

/* ---- section sdk (08s-sdk.js) ---- */
(function(){
'use strict';
try {
/* 08s · #sdk: for builders (unpinned).
   always: draws the three wires from the hub to the apps (re-measured whenever the figure resizes), so reduced
           motion gets drawn wires too; keeps sampled points for the packets; the copy button with its toast.
   desk / frames (on enter, top 70% / top 80%):
     0     the hub pops, "750" counts up, then the "+" pops
     .3    the wires draw (stagger .12); each app wipes in as its wire arrives
     .9    one packet per wire rides out and back (stagger .15); the bars grow, the Mac rows wipe, the total counts
     1.6   the language chips pop (once the row is on screen)
     1.9   the code line types (once it is on screen), with a caret. Then your bubble pops, a packet carries the
           question from the phone to the hub, the hub pulses, a packet brings the answer back, and only then
           does the reply type: the reply waits for the answer.
     3.4   ZERO DRIFT stamps on (the hub shakes a little), the claim rises.
   touch:  the same at 0.8× the durations; on the stacked layout each app waits for its own top 80%.
   reduce: nothing; the HTML is the final state. */

function sdArr(x) { return Array.prototype.slice.call(x); }
function sdLay(dia) { return (getComputedStyle(dia).getPropertyValue('--sd-lay') || 'wide').trim(); }
function sdCubic(a, b, vert) {
  var c1 = vert ? [a[0], (a[1] + b[1]) / 2] : [(a[0] + b[0]) / 2, a[1]];
  var c2 = vert ? [b[0], (a[1] + b[1]) / 2] : [(a[0] + b[0]) / 2, b[1]];
  return 'M' + a.join(' ') + ' C' + c1.join(' ') + ' ' + c2.join(' ') + ' ' + b.join(' ');
}

/* one wire per app, in DOM order (dash, mac, phone) */
function sdGeom(el) {
  var dia = el.querySelector('.sd-fig'), hub = el.querySelector('.sd-hub');
  if (!dia || !hub || !hub.offsetWidth) return;
  var wires = el.querySelectorAll('.sd-w'), apps = el.querySelectorAll('.sd-app'), lay = sdLay(dia);
  /* the hub may be mid-pop (scaled about its centre): take its centre from the rect and its size from layout */
  var D = dia.getBoundingClientRect(), H = hub.getBoundingClientRect(), hw = hub.offsetWidth, hh = hub.offsetHeight;
  var hx = H.left + H.width / 2 - D.left - hw / 2, hy = H.top + H.height / 2 - D.top - hh / 2, pts = el.sdPts || (el.sdPts = []);
  sdArr(apps).forEach(function (app, i) {
    var win = app.querySelector('.sd-win'), A = app.getBoundingClientRect(), R = win.getBoundingClientRect();
    var rx = R.left - D.left, ry = R.top - D.top, phone = app.classList.contains('sd-app--phone'), d;
    if (lay === 'wide') {
      if (app.classList.contains('sd-app--dash')) d = sdCubic([hx, hy + hh * .5], [rx + R.width, ry + R.height * .5]);
      else d = sdCubic([hx + hw, hy + hh * (phone ? .3 : .7)], [rx, ry + R.height * (phone ? .3 : .5)]);
    } else if (lay === 'row') {
      d = sdCubic([hx + hw / 2, hy + hh], [A.left - D.left + A.width / 2, A.top - D.top], true);
    } else {
      /* down from the hub, left to the spine, down the spine, right into the app */
      var x0 = hx + hw / 2, y0 = hy + hh, yb = y0 + 22, cx = 10, ty = ry + (phone ? 64 : 22), r = 8;
      d = 'M' + x0 + ' ' + y0 + ' V' + (yb - r) + ' Q' + x0 + ' ' + yb + ' ' + (x0 - r) + ' ' + yb + ' H' + (cx + r) +
        ' Q' + cx + ' ' + yb + ' ' + cx + ' ' + (yb + r) + ' V' + (ty - r) + ' Q' + cx + ' ' + ty + ' ' + (cx + r) + ' ' + ty + ' H' + rx;
    }
    wires[i].setAttribute('d', d);
    try { pts[i] = Ravi.samplePath(wires[i], 64); } catch (e) {}
  });
}

/* the copy button: our own toast, so the label stays "[Copy]" */
function sdCopy(c, btn, toast) {
  if (!btn) return;
  var timer = 0;
  function fallback(text) {
    var ok = false, ta = document.createElement('textarea');
    ta.value = text; ta.setAttribute('readonly', ''); ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none';
    document.body.appendChild(ta); ta.select();
    try { ok = document.execCommand('copy'); } catch (e) {}
    document.body.removeChild(ta);
    if (!ok) {
      var code = c.$('.sd-line code'), rg = document.createRange(), s = window.getSelection();
      rg.selectNodeContents(code); s.removeAllRanges(); s.addRange(rg);
    }
    return ok;
  }
  function done(ok) {
    Ravi.announce(ok ? 'Copied' : 'Selected, press Command or Control and C to copy');
    if (!ok || !toast) return;
    toast.hidden = false;
    if (c.motion() && c.gsap) c.gsap.fromTo(toast, { opacity: 0, y: 6 }, { opacity: 1, y: 0, duration: .25, ease: Ravi.E.enter, overwrite: true });
    clearTimeout(timer);
    timer = setTimeout(function () { toast.hidden = true; }, 1600);
  }
  c.on(btn, 'click', function (e) {
    e.stopPropagation();                       // core's generic handler would relabel the button
    var text = btn.getAttribute('data-copy');
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { done(true); }, function () { done(fallback(text)); });
    } else done(fallback(text));
  });
}

function sdAlways(c) {
  var el = c.el, dia = c.$('.sd-fig');
  el.classList.add('sd-js');
  el.sdGeom = function () { sdGeom(el); };
  el.sdGeom();
  if (window.ResizeObserver) new ResizeObserver(function () { el.sdGeom(); }).observe(dia);
  else c.on(window, 'resize', el.sdGeom);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(function () { el.sdGeom(); });
  sdCopy(c, c.$('.sd-copy'), c.$('.sd-toast'));
}

/* run fn once tl has passed `at` and trig has crossed `start` (whichever comes later) */
function sdAfter(tl, at, trig, start, fn) {
  var a = 0, b = 0;
  function go() { if (a && b) { a = b = 0; fn(); } }
  tl.call(function () { a = 1; go(); }, null, at);
  Ravi.ST.create({ trigger: trig, start: start, once: true, onEnter: function () { b = 1; go(); } });
}

function sdBuild(ctx) {
  var gsap = Ravi.gsap, E = Ravi.E, D = Ravi.D, el = ctx.el, $ = ctx.$, $$ = ctx.$$;
  var touch = ctx.touch, k = touch ? 1.25 : 1, start = touch || ctx.frames ? 'top 80%' : 'top 70%';
  var dia = $('.sd-fig'), lay = sdLay(dia), all = [], dead = false;
  if (el.sdGeom) el.sdGeom();
  ctx.onRefresh(function () { if (el.sdGeom) el.sdGeom(); });
  ctx.add(function () { dead = true; });
  function T(o) { var t = gsap.timeline(o); t.timeScale(k); all.push(t); return t; }
  function pts(i) { return function () { return (el.sdPts || [])[i]; }; }

  var hub = $('.sd-hub'), ring = $('.sd-ring svg'), num = $('.sd-num'), dashN = $('.sd-dash-n');
  var apps = $$('.sd-app'), wires = $$('.sd-w'), pk = $$('.sd-pk'), rd = pk.slice(0, 3), wr = pk.slice(3, 6);
  var phoneI = apps.indexOf($('.sd-app--phone'));

  /* idle: the ring turns once every 40 s while it is on screen */
  Ravi.pauseOffscreen(gsap.to(ring, { rotation: 360, duration: 40, ease: 'none', repeat: -1, transformOrigin: '50% 50%' }), hub);

  function ride(t, dot, i, at, dur, back) {
    t.fromTo(dot, { opacity: 0 }, { opacity: 1, duration: .06, immediateRender: false }, at);
    t.add(Ravi.packet(dot, pts(i), dur, E.travel, back ? 1 : 0, back ? 0 : 1), at);
    t.to(dot, { opacity: 0, duration: .12 }, at + dur);
  }

  /* ---------- the hub ---------- */
  var t1 = T({ scrollTrigger: { trigger: dia, start: start, toggleActions: 'play none none none' } });
  /* the numbers keep their final text until their timeline starts (so assistive tech never reads "0") */
  t1.call(function () { num.textContent = '0'; }, null, .01);
  t1.fromTo(hub, { opacity: 0, scale: .8 }, { opacity: 1, scale: 1, ease: E.popHard, duration: .5 }, 0);
  t1.add(Ravi.count(num, 750, .7), .05);
  t1.fromTo($('.sd-plus'), { opacity: 0, scale: 0 }, { opacity: 1, scale: 1, ease: E.popHard, duration: .35 }, .75);
  t1.fromTo($$('.sd-unit, .sd-sub'), { opacity: 0, y: 6 }, { opacity: 1, y: 0, ease: E.enter, duration: .35, stagger: .08 }, .4);
  t1.fromTo($$('.sd-port'), { opacity: 0, scale: 0 }, { opacity: 1, scale: 1, ease: E.pop, duration: .3, stagger: .06 }, .25);

  /* ---------- each app: its wire draws, it wipes in, a packet rides out and back, its data lands ---------- */
  function appSeq(t, i, base, out) {
    var app = apps[i], dir = lay === 'row' ? 'top' : lay === 'wide' && app.classList.contains('sd-app--dash') ? 'right' : 'left';
    var land = base + out + .45;
    if (app.classList.contains('sd-app--dash')) t.call(function () { dashN.textContent = '$0'; }, null, base + .01);
    t.add(Ravi.draw(wires[i], .45), base);
    t.add(Ravi.wipeIn(app, dir, .45), base + .3);
    ride(t, rd[i], i, base + out, .45, false);
    ride(t, wr[i], i, land + .05, .45, true);
    if (app.classList.contains('sd-app--dash')) {
      t.fromTo(app.querySelectorAll('.sd-bar-f'), { scaleX: 0 }, { scaleX: 1, ease: E.rise, duration: .55, stagger: .08 }, land);
      t.add(Ravi.count(dashN, 3450, .6, function (v) { return '$' + Math.round(v).toLocaleString('en-US'); }), land);
    } else if (app.classList.contains('sd-app--mac')) {
      sdArr(app.querySelectorAll('.sd-row')).forEach(function (r, j) { t.add(Ravi.wipeIn(r, 'left', .35), land + j * .08); });
    } else {
      t.fromTo(app.querySelector('.sd-ph-hd'), { opacity: 0 }, { opacity: 1, duration: .3, ease: E.enter }, land);
      t.fromTo(app.querySelector('.sd-ph-in'), { opacity: 0, y: 8 }, { opacity: 1, y: 0, duration: .35, ease: E.enter }, land + .08);
    }
  }
  var last = -1;
  apps.forEach(function (app, i) {
    if (!touch || lay !== 'stack') { appSeq(t1, i, .3 + i * .12, .6 + i * .03); return; }
    var at = T({ paused: true });
    appSeq(at, i, 0, .6);
    /* on the stacked layout an app also waits for its own top 80%; apps that arrive together still go .12 apart */
    sdAfter(t1, .3 + i * .12, app, 'top 80%', function () {
      var now = gsap.ticker.time, d = Math.max(0, last + .12 - now);
      last = now + d;
      if (d) gsap.delayedCall(d, function () { if (!dead) at.play(); }); else at.play();
    });
  });

  /* ---------- the language chips (1.6 s, once the row is on screen) ---------- */
  var tc = T({ paused: true });
  tc.fromTo($$('.sd-lc'), { opacity: 0, scale: .6 }, { opacity: 1, scale: 1, ease: E.popSoft, duration: .4, stagger: .06 }, 0);
  sdAfter(t1, 1.6, $('.sd-langs'), 'top 90%', function () { tc.play(); });

  /* ---------- the code line and its round trip (1.9 s, once the code is on screen) ---------- */
  var box = $('.sd-codebox'), parts = $$('.sd-p'), meB = $('.sd-bub--me'), opsB = $('.sd-bub--ops'), wait = $('.sd-wait');
  var t2 = T({ paused: true });
  t2.fromTo(box, { opacity: 0, y: 16 }, { opacity: 1, y: 0, ease: E.rise, duration: D.rise }, 0);
  var lens = parts.map(function (p) { return p.textContent.length; }), tot = lens.reduce(function (a, b) { return a + b; }, 0), at = .15;
  parts.forEach(function (p, j) { var dd = 1.2 * lens[j] / tot; t2.add(Ravi.typeLine(p, 9).duration(dd), at); at += dd; });
  var typed = at;
  Ravi.caretOn($('.sd-caret'), t2, typed, box);
  t2.fromTo($('.sd-copy'), { opacity: 0 }, { opacity: 1, duration: .3 }, .3);
  t2.fromTo($('.sd-cap'), { opacity: 0, y: 10 }, { opacity: 1, y: 0, ease: E.enter, duration: D.enter }, .35);
  /* the app asks: your bubble pops, the question rides to the hub */
  t2.fromTo(meB, { opacity: 0, scale: .6, transformOrigin: '100% 100%' }, { opacity: 1, scale: 1, ease: E.popSoft, duration: .4 }, typed);
  ride(t2, wr[phoneI], phoneI, typed + .1, .45, true);
  t2.fromTo(opsB, { opacity: 0, scale: .8, transformOrigin: '0% 100%' }, { opacity: 1, scale: 1, ease: E.popSoft, duration: .35 }, typed + .3);
  t2.fromTo(wait, { opacity: 0 }, { opacity: 1, duration: .15 }, typed + .3);
  t2.fromTo(wait.querySelectorAll('i'), { opacity: .25 }, { opacity: 1, duration: .2, stagger: .1, repeat: 3, yoyo: true, ease: 'sine.inOut' }, typed + .32);
  /* the hub works, then the answer rides back; only then does the reply type */
  t2.fromTo(hub, { scale: 1 }, { scale: 1.05, duration: .15, yoyo: true, repeat: 1, ease: E.hold, immediateRender: false }, typed + .55);
  t2.fromTo($$('.sd-dots circle'), { opacity: .5 }, { opacity: 1, duration: .15, yoyo: true, repeat: 1, ease: E.hold, immediateRender: false }, typed + .55);
  ride(t2, rd[phoneI], phoneI, typed + .7, .45, false);
  t2.to(wait, { opacity: 0, duration: .12 }, typed + 1.15);
  t2.add(Ravi.typeLine($('.sd-rep'), 9).duration(.6), typed + 1.15);
  sdAfter(t1, 1.9, box, touch ? 'top 95%' : 'top 88%', function () { t2.play(); });

  /* ---------- ZERO DRIFT (3.4 s: 1.5 s into the code line, once the stamp is on screen) ---------- */
  var stamp = $('.sd-stamp'), t3 = T({ paused: true });
  t3.fromTo(stamp, { opacity: 0, scale: 1.4, rotation: -8, transformOrigin: ctx.phone ? '10% 50%' : '50% 50%' }, { opacity: 1, scale: 1, rotation: -4, ease: E.popHard, duration: .5 }, 0);
  t3.fromTo(hub, { x: -4 }, { x: 0, ease: E.refuse, duration: .6, immediateRender: false }, .14);
  t3.fromTo($('.sd-claim-t'), { opacity: 0, y: 16 }, { opacity: 1, y: 0, ease: E.rise, duration: D.rise }, .18);
  sdAfter(t2, 1.5, stamp, 'top 90%', function () { t3.play(); });

  /* a keyboard user who lands inside the section sees everything at once */
  ctx.on(el, 'focusin', function () {
    if (Ravi.kbRecent()) all.forEach(function (a) { if (a.progress() < 1) a.progress(1); });
  });

  ctx.add(function () { num.textContent = '750'; dashN.textContent = '$3,450'; });
}

Ravi.section('sdk', { always: sdAlways, desk: sdBuild, touch: sdBuild, frames: sdBuild });
} catch (err) { console.error('[section sdk]', err); }
})();

/* ---- section install (09-install.js) ---- */
(function(){
'use strict';
try {
/* 09 · #install: try it in your Slack (unpinned).
   always: the copy button with its "Copied" toast (the label stays "[Copy]").
   desk / touch / frames: each step rises on enter (E.rise, stagger .1) and its mint rule wipes in;
           the copy box's caret starts blinking once step 01 has risen (caretOn). Touch runs at 0.8× the durations.
   reduce: nothing; the HTML is the final state. */

function insCopy(c, btn, toast) {
  if (!btn) return;
  var timer = 0;
  function fallback(text) {
    var ok = false, ta = document.createElement('textarea');
    ta.value = text; ta.setAttribute('readonly', ''); ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none';
    document.body.appendChild(ta); ta.select();
    try { ok = document.execCommand('copy'); } catch (e) {}
    document.body.removeChild(ta);
    if (!ok) {
      var code = btn.parentNode.querySelector('code'), rg = document.createRange(), s = window.getSelection();
      rg.selectNodeContents(code); s.removeAllRanges(); s.addRange(rg);
    }
    return ok;
  }
  function done(ok) {
    Ravi.announce(ok ? 'Copied' : 'Selected, press Command or Control and C to copy');
    if (!ok || !toast) return;
    toast.hidden = false;
    if (c.motion() && c.gsap) c.gsap.fromTo(toast, { opacity: 0, y: 6 }, { opacity: 1, y: 0, duration: .25, ease: Ravi.E.enter, overwrite: true });
    clearTimeout(timer);
    timer = setTimeout(function () { toast.hidden = true; }, 1600);
  }
  c.on(btn, 'click', function (e) {
    e.stopPropagation();                       // core's generic handler would relabel the button
    var text = btn.getAttribute('data-copy');
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { done(true); }, function () { done(fallback(text)); });
    } else done(fallback(text));
  });
}

function insAlways(c) { insCopy(c, c.$('.ins-copy'), c.$('.ins-toast')); }

function insBuild(ctx) {
  var gsap = Ravi.gsap, E = Ravi.E, D = Ravi.D, ST = Ravi.ST;
  var steps = ctx.$$('.ins-step'), k = ctx.touch ? .8 : 1;
  var caret = ctx.$('.ins-caret'), box = ctx.$('.ins-box');

  /* the caret stays hidden until step 01 has risen, then blinks while the box is on screen */
  var ct = gsap.timeline({ paused: true });
  if (caret) Ravi.caretOn(caret, ct, .45 * k, box);

  gsap.set(steps, { opacity: 0, y: 32 });
  gsap.set(ctx.$$('.ins-rule'), { scaleX: 0 });
  ST.batch(steps, { start: ctx.frames ? 'top 90%' : 'top 85%', once: true, onEnter: function (b) {
    gsap.fromTo(b, { opacity: 0, y: 32 }, { opacity: 1, y: 0, ease: E.rise, duration: D.rise * k, stagger: .1 * k, overwrite: true });
    gsap.fromTo(b.map(function (s) { return s.querySelector('.ins-rule'); }), { scaleX: 0 }, { scaleX: 1, ease: E.wipe, duration: D.wipe * k, stagger: .1 * k, delay: .15 * k });
    if (b.indexOf(steps[0]) > -1) ct.play();
  } });

  /* a keyboard user who lands inside the section sees everything at once */
  ctx.on(ctx.el, 'focusin', function () {
    if (!Ravi.kbRecent()) return;
    gsap.set(steps, { opacity: 1, y: 0 });
    gsap.set(ctx.$$('.ins-rule'), { scaleX: 1 });
    ct.play();
  });

  ctx.add(function () { gsap.set(steps.concat(ctx.$$('.ins-rule')), { clearProps: 'opacity,transform' }); });
}

Ravi.section('install', { always: insAlways, desk: insBuild, touch: insBuild, frames: insBuild });
} catch (err) { console.error('[section install]', err); }
})();
