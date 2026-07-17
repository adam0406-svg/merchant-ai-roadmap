// Progressive enhancement. Without JS every phase opens natively via <details>
// and all content is visible. The .js class is added only after all handlers
// are bound, so a failed script can never hide content.
(function () {
  var reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ---------- hero word cascade (one-time entrance) ---------- */
  var heroH1 = document.querySelector('.hero h1');
  if (heroH1 && !reduced) {
    heroH1.classList.remove('rv');
    var wordIndex = 0;
    var wrapWords = function (node) {
      Array.prototype.slice.call(node.childNodes).forEach(function (child) {
        if (child.nodeType === 3) {
          var frag = document.createDocumentFragment();
          child.textContent.split(/(\s+)/).forEach(function (part) {
            if (!part) return;
            if (/^\s+$/.test(part)) { frag.appendChild(document.createTextNode(part)); return; }
            var w = document.createElement('span');
            w.className = 'w';
            w.textContent = part;
            w.style.setProperty('--wd', (0.15 + wordIndex * 0.055).toFixed(3) + 's');
            wordIndex++;
            frag.appendChild(w);
          });
          node.replaceChild(frag, child);
        } else if (child.nodeType === 1) {
          wrapWords(child);
        }
      });
    };
    wrapWords(heroH1);
    heroH1.classList.add('words-ready');
    requestAnimationFrame(function () {
      requestAnimationFrame(function () { heroH1.classList.add('words-in'); });
    });
  }

  /* ---------- drifting transaction particles ---------- */
  /* Currency and payment glyphs from Flatpay's six markets (kr, EUR, GBP)
     rising like settled transactions; a few plain sparks in between. */
  var ambient = document.querySelector('.ambient');
  if (ambient && !reduced) {
    var glyphs = ['kr', '€', '£', '€', 'kr', '✓', '€'];
    for (var i = 0; i < 14; i++) {
      var ff = document.createElement('span');
      var isGlyph = i % 3 !== 2; /* two glyphs for every plain spark */
      if (isGlyph) {
        ff.className = 'ff glyph';
        ff.textContent = glyphs[i % glyphs.length];
        ff.style.fontSize = (8 + Math.random() * 5).toFixed(1) + 'px';
      } else {
        ff.className = 'ff';
        var size = 2.5 + Math.random() * 3.5;
        ff.style.width = size + 'px';
        ff.style.height = size + 'px';
      }
      ff.setAttribute('aria-hidden', 'true');
      ff.style.left = (Math.random() * 100) + '%';
      ff.style.setProperty('--o', (0.12 + Math.random() * 0.3).toFixed(2));
      ff.style.setProperty('--sway', ((Math.random() - 0.5) * 120).toFixed(0) + 'px');
      var dur = 16 + Math.random() * 18;
      ff.style.animationDuration = dur.toFixed(1) + 's';
      ff.style.animationDelay = (-Math.random() * dur).toFixed(1) + 's';
      ambient.appendChild(ff);
    }
  }

  /* ---------- scroll reveals (+ stat count-up) ---------- */
  var countUp = function (el) {
    var target = parseInt(el.textContent, 10);
    if (isNaN(target)) return;
    var start = null, dur = 900;
    var step = function (ts) {
      if (!start) start = ts;
      var p = Math.min((ts - start) / dur, 1);
      var eased = 1 - Math.pow(1 - p, 3);
      el.textContent = Math.round(eased * target);
      if (p < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  };

  var revealed = document.querySelectorAll('.rv');
  if ('IntersectionObserver' in window && !reduced) {
    var ro = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting) {
          e.target.classList.add('in');
          if (e.target.classList.contains('sg')) {
            var n = e.target.querySelector('.n');
            if (n) countUp(n);
          }
          ro.unobserve(e.target);
        }
      });
    }, { threshold: 0.12, rootMargin: '0px 0px -6% 0px' });
    revealed.forEach(function (el) { ro.observe(el); });
  } else {
    revealed.forEach(function (el) { el.classList.add('in'); });
  }

  /* ---------- ghost number parallax ---------- */
  var ghosts = Array.prototype.slice.call(document.querySelectorAll('.phase-ghost'));
  if (ghosts.length && !reduced) {
    var pTick = false;
    var parallax = function () {
      var vh = window.innerHeight;
      ghosts.forEach(function (g) {
        var r = g.getBoundingClientRect();
        if (r.bottom < -200 || r.top > vh + 200) return;
        var off = (r.top + r.height / 2 - vh / 2) * -0.07;
        g.style.transform = 'translateY(' + off.toFixed(1) + 'px)';
      });
      pTick = false;
    };
    window.addEventListener('scroll', function () {
      if (!pTick) { pTick = true; requestAnimationFrame(parallax); }
    }, { passive: true });
    parallax();
  }

  /* ---------- typewriter on the merchant quote ---------- */
  function typewrite(el) {
    var full = el.getAttribute('data-text') || el.textContent;
    if (el._twTimer) { clearTimeout(el._twTimer); el._twTimer = null; }
    if (reduced) { el.textContent = full; el.classList.remove('typing'); return; }
    el.textContent = '';
    el.classList.add('typing');
    var i = 0;
    var tick = function () {
      i++;
      el.textContent = full.slice(0, i);
      if (i < full.length) {
        el._twTimer = setTimeout(tick, 55 + Math.random() * 45);
      } else {
        el._twTimer = setTimeout(function () { el.classList.remove('typing'); }, 1600);
      }
    };
    el._twTimer = setTimeout(tick, 650);
  }

  function resetTypewriters(scope) {
    Array.prototype.slice.call(scope.querySelectorAll('.typewriter')).forEach(function (el) {
      if (el._twTimer) { clearTimeout(el._twTimer); el._twTimer = null; }
      el.classList.remove('typing');
      el.textContent = el.getAttribute('data-text') || el.textContent;
    });
  }

  /* ---------- phase deep links (details do the open/close natively) ---------- */
  var phases = Array.prototype.slice.call(document.querySelectorAll('.phase'));

  Array.prototype.slice.call(document.querySelectorAll('details.phase-details')).forEach(function (d) {
    d.addEventListener('toggle', function () {
      if (d.open) {
        Array.prototype.slice.call(d.querySelectorAll('.typewriter')).forEach(typewrite);
      } else {
        resetTypewriters(d);
      }
    });
  });

  function openPhase(id, scroll) {
    var phase = document.getElementById(id);
    if (!phase || !phase.classList.contains('phase')) return false;
    var d = phase.querySelector('details.phase-details');
    if (d) d.open = true;
    if (scroll) {
      requestAnimationFrame(function () {
        var y = phase.getBoundingClientRect().top + window.pageYOffset - 20;
        window.scrollTo({ top: y, behavior: reduced ? 'auto' : 'smooth' });
      });
    }
    return true;
  }

  /* ---------- rail + overview nodes ---------- */
  var railLinks = Array.prototype.slice.call(document.querySelectorAll('.rail a'));
  var jumpLinks = railLinks.concat(Array.prototype.slice.call(document.querySelectorAll('.ov-node')));
  jumpLinks.forEach(function (a) {
    a.addEventListener('click', function (e) {
      var id = a.getAttribute('href').slice(1);
      if (openPhase(id, true)) e.preventDefault();
    });
  });

  if (railLinks.length && 'IntersectionObserver' in window) {
    var po = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting) {
          railLinks.forEach(function (a) {
            a.classList.toggle('active', a.getAttribute('href') === '#' + e.target.id);
          });
        }
      });
    }, { rootMargin: '-40% 0px -55% 0px' });
    phases.forEach(function (p) { po.observe(p); });
    var simSec = document.getElementById('simulator');
    if (simSec) po.observe(simSec);
  }

  /* ---------- top progress line ---------- */
  var bar = document.querySelector('.progress');
  if (bar) {
    var ticking = false;
    var update = function () {
      var doc = document.documentElement;
      var max = doc.scrollHeight - window.innerHeight;
      bar.style.width = (max > 0 ? (window.pageYOffset / max) * 100 : 0) + '%';
      ticking = false;
    };
    window.addEventListener('scroll', function () {
      if (!ticking) { requestAnimationFrame(update); ticking = true; }
    }, { passive: true });
    update();
  }

  /* ---------- hologram spec overlay ---------- */
  var holo = document.querySelector('.holo');
  if (holo) {
    var hFrame = holo.querySelector('iframe');
    var hClose = holo.querySelector('.holo-close');
    var hNewtab = holo.querySelector('.holo-newtab');
    var hLast = null;

    var openHolo = function (e) {
      e.preventDefault();
      hLast = document.activeElement;
      if (!hFrame.getAttribute('src')) hFrame.src = 'workflow.html?embed=1';
      holo.hidden = false;
      document.body.style.overflow = 'hidden';
      requestAnimationFrame(function () {
        requestAnimationFrame(function () { holo.classList.add('show'); });
      });
      hClose.focus();
    };
    var closeHolo = function () {
      holo.classList.remove('show');
      document.body.style.overflow = '';
      setTimeout(function () { holo.hidden = true; }, 400);
      if (hLast) hLast.focus();
    };

    Array.prototype.slice.call(document.querySelectorAll('.js-holo')).forEach(function (a) {
      a.addEventListener('click', openHolo);
    });
    hClose.addEventListener('click', closeHolo);
    holo.querySelector('.holo-backdrop').addEventListener('click', closeHolo);
    document.addEventListener('keydown', function (e) {
      if (holo.hidden) return;
      if (e.key === 'Escape') { closeHolo(); return; }
      /* focus trap: cycle between the bar controls and the iframe */
      if (e.key === 'Tab') {
        var focusables = [hNewtab, hClose, hFrame];
        var idx = focusables.indexOf(document.activeElement);
        if (idx === -1) { hClose.focus(); e.preventDefault(); return; }
        var next = idx + (e.shiftKey ? -1 : 1);
        if (next < 0) { focusables[focusables.length - 1].focus(); e.preventDefault(); }
        else if (next >= focusables.length) { focusables[0].focus(); e.preventDefault(); }
      }
    });
  }

  /* ---------- floating back-to-top (workflow page) ---------- */
  var toTop = document.querySelector('.to-top');
  if (toTop) {
    var ttTick = false;
    var ttUpdate = function () {
      toTop.classList.toggle('show', window.pageYOffset > 600);
      ttTick = false;
    };
    window.addEventListener('scroll', function () {
      if (!ttTick) { ttTick = true; requestAnimationFrame(ttUpdate); }
    }, { passive: true });
    ttUpdate();
  }

  /* ---------- embedded (in-overlay) mode for the spec page ---------- */
  if (location.search.indexOf('embed=1') !== -1) {
    document.documentElement.classList.add('embed');
  }

  /* ---------- deep link ---------- */
  if (location.hash) openPhase(location.hash.slice(1), true);

  /* Enhancement class last: everything above is bound, so CSS may now
     defer .rv visibility to the observer. */
  document.documentElement.classList.add('js');
})();
