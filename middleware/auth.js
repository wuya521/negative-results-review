const { hasCapability } = require('../lib/admin');

function requireAuth(req, res, next) {
  if (req.session && req.session.admin) return next();
  res.redirect('/admin/login');
}

function requireAdminCapability(capability) {
  return function (req, res, next) {
    if (req.session && req.session.admin && hasCapability(req.session.admin.role, capability)) {
      return next();
    }
    res.redirect('/admin/dashboard');
  };
}

function requireMember(req, res, next) {
  if (req.session && req.session.user) return next();
  res.redirect('/login?next=' + encodeURIComponent(req.originalUrl || '/me'));
}

module.exports = { requireAuth, requireAdminCapability, requireMember };
