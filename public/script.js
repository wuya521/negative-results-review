(function () {
  'use strict';

  var nav = document.getElementById('nav');
  var navToggle = document.getElementById('navToggle');
  var navLinks = document.getElementById('navLinks');
  var themeToggle = document.getElementById('themeToggle');
  var backBtn = document.getElementById('backToTop');
  var modalOverlay = document.getElementById('columnModal');
  var modalClose = document.getElementById('modalClose');
  var modalTag = document.getElementById('modalTag');
  var modalTitle = document.getElementById('modalTitle');
  var modalBody = document.getElementById('modalBody');

  function toggleNavLabel(isOpen) {
    if (!navToggle) return;
    navToggle.textContent = isOpen ? 'X' : '☰';
  }

  function applyThemeState(isDark) {
    if (isDark) {
      document.documentElement.setAttribute('data-theme', 'dark');
      localStorage.setItem('nrr-theme', 'dark');
    } else {
      document.documentElement.removeAttribute('data-theme');
      localStorage.setItem('nrr-theme', 'light');
    }

    document.documentElement.style.colorScheme = isDark ? 'dark' : 'light';

    if (!themeToggle) return;
    var nextLabel = isDark ? '切换到浅色模式' : '切换到深色模式';
    themeToggle.setAttribute('aria-pressed', String(isDark));
    themeToggle.setAttribute('aria-label', nextLabel);
    themeToggle.setAttribute('title', nextLabel);
  }

  if (nav) {
    window.addEventListener('scroll', function () {
      nav.classList.toggle('scrolled', window.scrollY > 30);
    }, { passive: true });
  }

  if (navToggle && navLinks) {
    toggleNavLabel(false);
    navToggle.addEventListener('click', function () {
      var isOpen = navLinks.classList.toggle('open');
      toggleNavLabel(isOpen);
    });

    navLinks.querySelectorAll('a').forEach(function (link) {
      link.addEventListener('click', function () {
        navLinks.classList.remove('open');
        toggleNavLabel(false);
      });
    });
  }

  applyThemeState(document.documentElement.getAttribute('data-theme') === 'dark');

  if (themeToggle) {
    themeToggle.addEventListener('click', function () {
      var isDark = document.documentElement.getAttribute('data-theme') === 'dark';
      applyThemeState(!isDark);
    });
  }

  if (backBtn) {
    window.addEventListener('scroll', function () {
      backBtn.classList.toggle('visible', window.scrollY > 400);
    }, { passive: true });

    backBtn.addEventListener('click', function () {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
  }

  var fadeEls = document.querySelectorAll('.fade-in');
  if ('IntersectionObserver' in window && fadeEls.length) {
    var observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add('visible');
          observer.unobserve(entry.target);
        }
      });
    }, { threshold: 0.12, rootMargin: '0px 0px -40px 0px' });

    fadeEls.forEach(function (el) { observer.observe(el); });
  } else {
    fadeEls.forEach(function (el) { el.classList.add('visible'); });
  }

  document.querySelectorAll('.col-card[data-title]').forEach(function (card) {
    card.addEventListener('click', function (event) {
      if (!modalOverlay) return;
      event.preventDefault();
      if (modalTag) modalTag.textContent = card.getAttribute('data-index') || '';
      if (modalTitle) modalTitle.textContent = card.getAttribute('data-title') || '';
      if (modalBody) modalBody.innerHTML = '<p>' + (card.getAttribute('data-desc') || '') + '</p>';
      modalOverlay.classList.add('active');
      document.body.style.overflow = 'hidden';
    });
  });

  function closeModal() {
    if (!modalOverlay) return;
    modalOverlay.classList.remove('active');
    document.body.style.overflow = '';
  }

  if (modalClose) modalClose.addEventListener('click', closeModal);
  if (modalOverlay) {
    modalOverlay.addEventListener('click', function (event) {
      if (event.target === modalOverlay) closeModal();
    });
  }

  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape') closeModal();
  });

  document.querySelectorAll('a[href^="#"]').forEach(function (anchor) {
    anchor.addEventListener('click', function (event) {
      var id = anchor.getAttribute('href');
      if (id === '#') return;
      var target = document.querySelector(id);
      if (!target) return;
      event.preventDefault();
      var offset = nav ? nav.offsetHeight : 0;
      window.scrollTo({
        top: target.getBoundingClientRect().top + window.pageYOffset - offset,
        behavior: 'smooth'
      });
    });
  });

  var params = new URLSearchParams(window.location.search);
  if (params.get('success') === '1') {
    showToast('投稿已成功提交，请使用稿件编号继续追踪进度。');
    history.replaceState(null, '', window.location.pathname);
  }

  function showToast(message) {
    var toast = document.getElementById('toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.className = 'toast';
      toast.id = 'toast';
      document.body.appendChild(toast);
    }
    toast.textContent = message;
    toast.classList.add('show');
    setTimeout(function () {
      toast.classList.remove('show');
    }, 4000);
  }
})();
