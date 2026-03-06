const express = require('express');
const bcrypt = require('bcryptjs');
const { requireAuth } = require('../middleware/auth');
const router = express.Router();

const SECTIONS = [
  '负结果档案', '废稿回收站', '方法翻车实录',
  'Reviewer 鬼话档案', '选题尸检报告', '学术情绪标本室', '年度学术垃圾奖'
];
const STATUSES = ['pending','under_review','revision','accepted','rejected','published','archived'];
const PER_PAGE = 15;

const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

async function getStats(db) {
  const [rows] = await db.execute('SELECT status, COUNT(*) as c FROM manuscripts GROUP BY status');
  const s = { pending:0, under_review:0, revision:0, accepted:0, rejected:0, published:0, archived:0, total:0 };
  rows.forEach(r => { s[r.status] = Number(r.c); s.total += Number(r.c); });
  return s;
}

module.exports = function (csrfCheck) {

  // ---------- Login ----------
  router.get('/login', (req, res) => {
    if (req.session && req.session.admin) return res.redirect('/admin/dashboard');
    res.render('admin/login', { error: req.query.error ? '用户名或密码错误' : null });
  });

  router.post('/login', wrap(async (req, res) => {
    const db = res.locals.db;
    const { username, password } = req.body;
    const [rows] = await db.execute('SELECT * FROM admins WHERE username = ?', [username]);
    if (rows.length === 0 || !bcrypt.compareSync(password, rows[0].password_hash)) {
      return res.redirect('/admin/login?error=1');
    }
    req.session.admin = { id: rows[0].id, username: rows[0].username };
    res.redirect('/admin/dashboard');
  }));

  router.get('/logout', (req, res) => {
    req.session.destroy(() => res.redirect('/admin/login'));
  });

  // ---------- Dashboard ----------
  router.get('/', requireAuth, (req, res) => res.redirect('/admin/dashboard'));

  router.get('/dashboard', requireAuth, wrap(async (req, res) => {
    const db = res.locals.db;
    const stats = await getStats(db);
    const [recent] = await db.execute(
      `SELECT id, submission_no, title, section, status, risk_level, created_at
       FROM manuscripts ORDER BY created_at DESC LIMIT 10`
    );
    const [[{ c: todayCount }]] = await db.execute(
      'SELECT COUNT(*) as c FROM manuscripts WHERE DATE(created_at) = CURDATE()'
    );
    res.render('admin/dashboard', { stats, recent, todayCount: Number(todayCount), admin: req.session.admin });
  }));

  // ---------- Manuscript List ----------
  router.get('/manuscripts', requireAuth, wrap(async (req, res) => {
    const db = res.locals.db;
    const { status, section, risk, q, sort } = req.query;
    const page = Math.max(1, parseInt(req.query.page) || 1);

    let countSql = 'SELECT COUNT(*) as c FROM manuscripts WHERE 1=1';
    let sql = 'SELECT id, submission_no, title, discipline, section, author_mode, status, risk_level, desensitized_status, is_featured, is_pinned, is_editor_pick, is_trending, created_at FROM manuscripts WHERE 1=1';
    const params = [];

    if (status)  { const f = ' AND status = ?';     sql += f; countSql += f; params.push(status); }
    if (section) { const f = ' AND section = ?';    sql += f; countSql += f; params.push(section); }
    if (risk)    { const f = ' AND risk_level = ?'; sql += f; countSql += f; params.push(risk); }
    if (q)       { const f = ' AND title LIKE ?';   sql += f; countSql += f; params.push('%' + q + '%'); }

    const [[{ c: total }]] = await db.execute(countSql, params);
    const totalPages = Math.ceil(Number(total) / PER_PAGE) || 1;

    const sortMap = {
      newest: 'created_at DESC', oldest: 'created_at ASC',
      risk: "FIELD(risk_level,'high','medium','low')"
    };
    sql += ' ORDER BY ' + (sortMap[sort] || 'created_at DESC');
    sql += ' LIMIT ? OFFSET ?';

    const [manuscripts] = await db.execute(sql, [...params, PER_PAGE, (page - 1) * PER_PAGE]);
    const stats = await getStats(db);

    res.render('admin/manuscripts', {
      manuscripts, stats, sections: SECTIONS, statuses: STATUSES,
      filters: { status, section, risk, q, sort },
      page, totalPages, admin: req.session.admin
    });
  }));

  // ---------- Manuscript Detail ----------
  router.get('/manuscripts/:id', requireAuth, wrap(async (req, res) => {
    const db = res.locals.db;
    const [rows] = await db.execute('SELECT * FROM manuscripts WHERE id = ?', [req.params.id]);
    if (rows.length === 0) return res.redirect('/admin/manuscripts');
    const stats = await getStats(db);
    res.render('admin/detail', {
      ms: rows[0], stats, sections: SECTIONS, statuses: STATUSES,
      msg: req.query.msg || null, admin: req.session.admin
    });
  }));

  // ---------- Update Manuscript Metadata ----------
  router.post('/manuscripts/:id', requireAuth, csrfCheck, wrap(async (req, res) => {
    const db = res.locals.db;
    const { risk_level, desensitized_status, editor_note, is_featured, is_pinned, is_editor_pick, is_trending, tags } = req.body;
    await db.execute(
      `UPDATE manuscripts SET risk_level=?, desensitized_status=?, editor_note=?,
              is_featured=?, is_pinned=?, is_editor_pick=?, is_trending=?, tags=?
       WHERE id=?`,
      [
        risk_level || 'low', desensitized_status || 'unchecked', editor_note || '',
        is_featured ? 1 : 0, is_pinned ? 1 : 0, is_editor_pick ? 1 : 0, is_trending ? 1 : 0,
        (tags || '').trim(),
        req.params.id
      ]
    );
    res.redirect(`/admin/manuscripts/${req.params.id}?msg=saved`);
  }));

  // ---------- Update Manuscript Content ----------
  router.post('/manuscripts/:id/content', requireAuth, csrfCheck, wrap(async (req, res) => {
    const db = res.locals.db;
    const { title, content } = req.body;
    if (!title || !content) return res.redirect(`/admin/manuscripts/${req.params.id}?msg=content_empty`);
    await db.execute(
      'UPDATE manuscripts SET title=?, content=? WHERE id=?',
      [title.trim(), content.trim(), req.params.id]
    );
    res.redirect(`/admin/manuscripts/${req.params.id}?msg=content_saved`);
  }));

  // ---------- Change Status ----------
  router.post('/manuscripts/:id/status', requireAuth, csrfCheck, wrap(async (req, res) => {
    const db = res.locals.db;
    const { status } = req.body;
    if (!STATUSES.includes(status)) return res.redirect(`/admin/manuscripts/${req.params.id}?msg=invalid`);

    if (status === 'published') {
      await db.execute('UPDATE manuscripts SET status=?, published_at=NOW() WHERE id=?', [status, req.params.id]);
    } else if (status === 'archived') {
      await db.execute('UPDATE manuscripts SET status=?, is_archived=1 WHERE id=?', [status, req.params.id]);
    } else {
      await db.execute('UPDATE manuscripts SET status=? WHERE id=?', [status, req.params.id]);
    }
    res.redirect(`/admin/manuscripts/${req.params.id}?msg=status_${status}`);
  }));

  // ---------- Change Password ----------
  router.get('/password', requireAuth, (req, res) => {
    res.render('admin/password', { msg: req.query.msg || null, admin: req.session.admin, stats: {} });
  });

  router.post('/password', requireAuth, csrfCheck, wrap(async (req, res) => {
    const db = res.locals.db;
    const { old_password, new_password, confirm_password } = req.body;

    if (!old_password || !new_password) return res.redirect('/admin/password?msg=empty');
    if (new_password.length < 6) return res.redirect('/admin/password?msg=too_short');
    if (new_password !== confirm_password) return res.redirect('/admin/password?msg=mismatch');

    const [rows] = await db.execute('SELECT * FROM admins WHERE id = ?', [req.session.admin.id]);
    if (!bcrypt.compareSync(old_password, rows[0].password_hash)) {
      return res.redirect('/admin/password?msg=wrong_old');
    }

    const hash = bcrypt.hashSync(new_password, 10);
    await db.execute('UPDATE admins SET password_hash=? WHERE id=?', [hash, req.session.admin.id]);
    res.redirect('/admin/password?msg=success');
  }));

  return router;
};
