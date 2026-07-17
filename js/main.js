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

  /* ---------- scroll reveals (one-time) ---------- */
  var revealed = document.querySelectorAll('.rv');
  if ('IntersectionObserver' in window && !reduced) {
    var ro = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting) {
          e.target.classList.add('in');
          ro.unobserve(e.target);
        }
      });
    }, { threshold: 0.12, rootMargin: '0px 0px -6% 0px' });
    revealed.forEach(function (el) { ro.observe(el); });
  } else {
    revealed.forEach(function (el) { el.classList.add('in'); });
  }

  /* ---------- phase deep links (details do the open/close natively) ---------- */
  var phases = Array.prototype.slice.call(document.querySelectorAll('.phase'));

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

  /* ---------- deep link ---------- */
  if (location.hash) openPhase(location.hash.slice(1), true);

  /* Enhancement class last: everything above is bound, so CSS may now
     defer .rv visibility to the observer. */
  document.documentElement.classList.add('js');
})();
