(function () {
  'use strict';

  /* ---------- Navigation scroll ---------- */
  var nav = document.getElementById('nav');
  var navToggle = document.getElementById('navToggle');
  var navLinks = document.getElementById('navLinks');

  if (nav) {
    window.addEventListener('scroll', function () {
      nav.classList.toggle('scrolled', window.scrollY > 30);
    }, { passive: true });
  }

  if (navToggle && navLinks) {
    navToggle.addEventListener('click', function () {
      var isOpen = navLinks.classList.toggle('open');
      navToggle.textContent = isOpen ? '✕' : '☰';
    });
    navLinks.querySelectorAll('a').forEach(function (a) {
      a.addEventListener('click', function () {
        navLinks.classList.remove('open');
        navToggle.textContent = '☰';
      });
    });
  }

  /* ---------- Scroll fade-in ---------- */
  var fadeEls = document.querySelectorAll('.fade-in');
  if ('IntersectionObserver' in window && fadeEls.length) {
    var obs = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting) { e.target.classList.add('visible'); obs.unobserve(e.target); }
      });
    }, { threshold: 0.12, rootMargin: '0px 0px -40px 0px' });
    fadeEls.forEach(function (el) { obs.observe(el); });
  } else {
    fadeEls.forEach(function (el) { el.classList.add('visible'); });
  }

  /* ---------- Column modal ---------- */
  var modalOverlay = document.getElementById('columnModal');
  var modalClose   = document.getElementById('modalClose');
  var modalTag     = document.getElementById('modalTag');
  var modalTitle   = document.getElementById('modalTitle');
  var modalBody    = document.getElementById('modalBody');

  document.querySelectorAll('.col-card').forEach(function (card) {
    card.addEventListener('click', function () {
      if (!modalOverlay) return;
      if (modalTag)   modalTag.textContent   = card.getAttribute('data-index');
      if (modalTitle) modalTitle.textContent = card.getAttribute('data-title');
      if (modalBody)  modalBody.innerHTML    = '<p>' + card.getAttribute('data-desc') + '</p>';
      modalOverlay.classList.add('active');
      document.body.style.overflow = 'hidden';
    });
  });

  function closeModal() {
    if (modalOverlay) { modalOverlay.classList.remove('active'); document.body.style.overflow = ''; }
  }
  if (modalClose)   modalClose.addEventListener('click', closeModal);
  if (modalOverlay) modalOverlay.addEventListener('click', function (e) { if (e.target === modalOverlay) closeModal(); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeModal(); });

  /* ---------- Smooth scroll ---------- */
  document.querySelectorAll('a[href^="#"]').forEach(function (a) {
    a.addEventListener('click', function (e) {
      var id = this.getAttribute('href');
      if (id === '#') return;
      var target = document.querySelector(id);
      if (target) {
        e.preventDefault();
        var offset = nav ? nav.offsetHeight : 0;
        window.scrollTo({ top: target.getBoundingClientRect().top + window.pageYOffset - offset, behavior: 'smooth' });
      }
    });
  });

  /* ---------- Toast from query param ---------- */
  var params = new URLSearchParams(window.location.search);
  if (params.get('success') === '1') {
    showToast('投稿已提交，感谢你的记录。编辑部将在 7 个工作日内审阅。');
    history.replaceState(null, '', window.location.pathname);
  }

  function showToast(msg) {
    var t = document.getElementById('toast');
    if (!t) { t = document.createElement('div'); t.className = 'toast'; t.id = 'toast'; document.body.appendChild(t); }
    t.textContent = msg;
    t.classList.add('show');
    setTimeout(function () { t.classList.remove('show'); }, 4000);
  }

})();
