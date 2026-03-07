function requireAuth(req, res, next) {
  if (req.session && req.session.admin) return next();
  res.redirect('/admin/login');
}

function requireMember(req, res, next) {
  if (req.session && req.session.user) return next();
  res.redirect('/login?next=' + encodeURIComponent(req.originalUrl || '/me'));
}

module.exports = { requireAuth, requireMember };
