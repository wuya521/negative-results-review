const express = require('express');
const bcrypt = require('bcryptjs');
const { requireAuth } = require('../middleware/auth');
const router = express.Router();
const { SECTIONS, STATUSES, PER_PAGE_ADMIN } = require('../config/constants');

const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

async function getStats(db) {
  const [rows] = await db.execute('SELECT status, COUNT(*) as c FROM manuscripts GROUP BY status');
  const s = { pending:0, under_review:0, revision:0, accepted:0, rejected:0, published:0, archived:0, total:0 };
  rows.forEach(r => { s[r.status] = Number(r.c); s.total += Number(r.c); });
  return s;
}

async function logAction(db, admin, action, targetType, targetId, details) {
  try {
    await db.execute(
      'INSERT INTO operation_logs (admin_id, admin_name, action, target_type, target_id, details) VALUES (?,?,?,?,?,?)',
      [admin.id, admin.username, action, targetType || null, targetId || null, details || null]
    );
  } catch (e) { console.error('Log failed:', e.message); }
}

async function notifyManuscriptOwner(db, manuscriptId, title, content, link) {
  const [[row]] = await db.execute('SELECT user_id FROM manuscripts WHERE id = ?', [manuscriptId]);
  if (!row || !row.user_id) return;
  await db.execute(
    'INSERT INTO notifications (user_id, title, content, link) VALUES (?, ?, ?, ?)',
    [row.user_id, title, content, link || '/me']
  );
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
    req.session.admin = { id: rows[0].id, username: rows[0].username, role: rows[0].role || 'admin' };
    await logAction(db, req.session.admin, 'login', null, null, null);
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

    // Weekly trend data for chart
    const [weekData] = await db.execute(
      `SELECT DATE(created_at) as day, COUNT(*) as c
       FROM manuscripts WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)
       GROUP BY DATE(created_at) ORDER BY day ASC`
    );

    // Section distribution for chart
    const [sectionData] = await db.execute(
      `SELECT section, COUNT(*) as c FROM manuscripts GROUP BY section ORDER BY c DESC`
    );

    res.render('admin/dashboard', {
      stats, recent, todayCount: Number(todayCount),
      weekData, sectionData,
      admin: req.session.admin
    });
  }));

  // ---------- Manuscript List ----------
  router.get('/manuscripts', requireAuth, wrap(async (req, res) => {
    const db = res.locals.db;
    const { status, section, risk, q, sort } = req.query;
    const page = Math.max(1, parseInt(req.query.page) || 1);

    let countSql = 'SELECT COUNT(*) as c FROM manuscripts WHERE 1=1';
    let sql = 'SELECT id, submission_no, title, discipline, section, author_mode, user_id, status, risk_level, desensitized_status, is_featured, is_pinned, is_editor_pick, is_trending, created_at FROM manuscripts WHERE 1=1';
    const params = [];

    if (status)  { const f = ' AND status = ?';     sql += f; countSql += f; params.push(status); }
    if (section) { const f = ' AND section = ?';    sql += f; countSql += f; params.push(section); }
    if (risk)    { const f = ' AND risk_level = ?'; sql += f; countSql += f; params.push(risk); }
    if (q) {
      const f = ' AND (title LIKE ? OR discipline LIKE ? OR content LIKE ? OR submission_no LIKE ?)';
      sql += f; countSql += f;
      params.push('%' + q + '%', '%' + q + '%', '%' + q + '%', '%' + q + '%');
    }

    const [[{ c: total }]] = await db.execute(countSql, params);
    const totalPages = Math.ceil(Number(total) / PER_PAGE_ADMIN) || 1;

    const sortMap = {
      newest: 'created_at DESC', oldest: 'created_at ASC',
      risk: "FIELD(risk_level,'high','medium','low')"
    };
    sql += ' ORDER BY ' + (sortMap[sort] || 'created_at DESC');
    sql += ' LIMIT ? OFFSET ?';

    const [manuscripts] = await db.execute(sql, [...params, PER_PAGE_ADMIN, (page - 1) * PER_PAGE_ADMIN]);
    const stats = await getStats(db);

    res.render('admin/manuscripts', {
      manuscripts, stats, sections: SECTIONS, statuses: STATUSES,
      filters: { status, section, risk, q, sort },
      page, totalPages, admin: req.session.admin
    });
  }));

  // ---------- Batch Status Change ----------
  router.post('/manuscripts/batch', requireAuth, csrfCheck, wrap(async (req, res) => {
    const db = res.locals.db;
    const { ids, action } = req.body;
    if (!ids || !action) return res.redirect('/admin/manuscripts');

    const idList = Array.isArray(ids) ? ids : [ids];
    const validStatuses = STATUSES;

    if (validStatuses.includes(action)) {
      for (const id of idList) {
        if (action === 'published') {
          await db.execute('UPDATE manuscripts SET status=?, published_at=NOW() WHERE id=?', [action, id]);
        } else {
          await db.execute('UPDATE manuscripts SET status=? WHERE id=?', [action, id]);
        }
      }
      await logAction(db, req.session.admin, `batch_status_${action}`, 'manuscript', null, `IDs: ${idList.join(',')}`);
    }

    res.redirect('/admin/manuscripts?msg=batch_done');
  }));

  // ---------- CSV Export ----------
  router.get('/manuscripts/export', requireAuth, wrap(async (req, res) => {
    const db = res.locals.db;
    const [rows] = await db.execute(
      `SELECT submission_no, title, discipline, section, author_mode, pen_name, status,
              risk_level, desensitized_status, is_featured, is_pinned, view_count,
              tags, created_at, updated_at, published_at
       FROM manuscripts ORDER BY created_at DESC`
    );

    let csv = '\uFEFF'; // BOM for Excel UTF-8
    csv += '编号,标题,学科,栏目,署名方式,笔名,状态,风险,脱敏,精选,置顶,浏览量,标签,投稿时间,更新时间,发布时间\n';
    for (const r of rows) {
      const fields = [
        r.submission_no, `"${(r.title||'').replace(/"/g,'""')}"`, r.discipline, r.section,
        r.author_mode, r.pen_name || '', r.status, r.risk_level, r.desensitized_status,
        r.is_featured, r.is_pinned, r.view_count, `"${r.tags||''}"`,
        r.created_at, r.updated_at, r.published_at || ''
      ];
      csv += fields.join(',') + '\n';
    }

    await logAction(db, req.session.admin, 'export_csv', null, null, `${rows.length} rows`);
    res.set({
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="nrr-manuscripts-${new Date().toISOString().slice(0,10)}.csv"`
    });
    res.send(csv);
  }));

  // ---------- Operation Logs ----------
  router.get('/logs', requireAuth, wrap(async (req, res) => {
    const db = res.locals.db;
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const [[{ c: total }]] = await db.execute('SELECT COUNT(*) as c FROM operation_logs');
    const totalPages = Math.ceil(Number(total) / 20) || 1;
    const [logs] = await db.execute(
      'SELECT * FROM operation_logs ORDER BY created_at DESC LIMIT 20 OFFSET ?',
      [(page - 1) * 20]
    );
    const stats = await getStats(db);
    res.render('admin/logs', { logs, stats, page, totalPages, admin: req.session.admin });
  }));

  // ---------- Manuscript Detail ----------
  router.get('/manuscripts/:id', requireAuth, wrap(async (req, res) => {
    const db = res.locals.db;
    const [rows] = await db.execute('SELECT * FROM manuscripts WHERE id = ?', [req.params.id]);
    let owner = null;
    if (rows.length > 0 && rows[0].user_id) {
      const [ownerRows] = await db.execute('SELECT id, email, display_name, member_tier, created_at, last_login_at FROM users WHERE id = ?', [rows[0].user_id]);
      owner = ownerRows[0] || null;
    }
    if (rows.length === 0) return res.redirect('/admin/manuscripts');

    const [logs] = await db.execute(
      'SELECT * FROM operation_logs WHERE target_type = ? AND target_id = ? ORDER BY created_at DESC LIMIT 20',
      ['manuscript', req.params.id]
    );

    const stats = await getStats(db);
    res.render('admin/detail', {
      ms: rows[0], stats, sections: SECTIONS, statuses: STATUSES,
      logs, owner, msg: req.query.msg || null, admin: req.session.admin
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
        (tags || '').trim(), req.params.id
      ]
    );
    await logAction(db, req.session.admin, 'update_metadata', 'manuscript', req.params.id, `risk=${risk_level}, desen=${desensitized_status}`);
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
    await logAction(db, req.session.admin, 'update_content', 'manuscript', req.params.id, `title=${title.trim().substring(0,50)}`);
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

    await logAction(db, req.session.admin, `status_to_${status}`, 'manuscript', req.params.id, null);
    const statusTitleMap = {
      pending: '稿件已回到待审队列',
      under_review: '稿件进入审核中',
      revision: '稿件需要修改',
      accepted: '稿件已被录用',
      rejected: '稿件未通过审核',
      published: '稿件已发布',
      archived: '稿件已归档'
    };
    await notifyManuscriptOwner(db, req.params.id, statusTitleMap[status] || '稿件状态更新', `你的稿件状态已更新为 ${status}。请前往会员工作台查看详情。`, '/me');
    res.redirect(`/admin/manuscripts/${req.params.id}?msg=status_${status}`);
  }));

  // ---------- Admin Management ----------
  router.get('/admins', requireAuth, wrap(async (req, res) => {
    const db = res.locals.db;
    if (req.session.admin.role !== 'admin') return res.redirect('/admin/dashboard');
    const [admins] = await db.execute('SELECT id, username, role, created_at FROM admins ORDER BY id ASC');
    const stats = await getStats(db);
    res.render('admin/admins', { admins, stats, msg: req.query.msg || null, admin: req.session.admin });
  }));

  router.post('/admins/add', requireAuth, csrfCheck, wrap(async (req, res) => {
    const db = res.locals.db;
    if (req.session.admin.role !== 'admin') return res.redirect('/admin/dashboard');
    const { username, password, role } = req.body;
    if (!username || !password || password.length < 6) return res.redirect('/admin/admins?msg=invalid');

    const [existing] = await db.execute('SELECT id FROM admins WHERE username = ?', [username]);
    if (existing.length > 0) return res.redirect('/admin/admins?msg=exists');

    const hash = bcrypt.hashSync(password, 10);
    const validRole = ['admin', 'editor', 'reviewer'].includes(role) ? role : 'editor';
    await db.execute('INSERT INTO admins (username, password_hash, role) VALUES (?,?,?)', [username, hash, validRole]);
    await logAction(db, req.session.admin, 'add_admin', 'admin', null, `username=${username}, role=${validRole}`);
    res.redirect('/admin/admins?msg=added');
  }));

  router.post('/admins/:id/delete', requireAuth, csrfCheck, wrap(async (req, res) => {
    const db = res.locals.db;
    if (req.session.admin.role !== 'admin') return res.redirect('/admin/dashboard');
    if (parseInt(req.params.id) === req.session.admin.id) return res.redirect('/admin/admins?msg=self');
    await db.execute('DELETE FROM admins WHERE id = ?', [req.params.id]);
    await logAction(db, req.session.admin, 'delete_admin', 'admin', req.params.id, null);
    res.redirect('/admin/admins?msg=deleted');
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
    await logAction(db, req.session.admin, 'change_password', 'admin', req.session.admin.id, null);
    res.redirect('/admin/password?msg=success');
  }));

  return router;
};







