const express = require('express');
const bcrypt = require('bcryptjs');
const { requireAuth } = require('../middleware/auth');
const { SECTIONS, STATUSES, PER_PAGE_ADMIN } = require('../config/constants');
const { buildTypographyPackage } = require('../lib/editorial');
const { hasCapability, normalizeAdminRole, getAdminRoleLabel } = require('../lib/admin');

const router = express.Router();
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

async function getStats(db) {
  const [rows] = await db.execute('SELECT status, COUNT(*) as c FROM manuscripts GROUP BY status');
  const stats = { pending: 0, under_review: 0, revision: 0, accepted: 0, rejected: 0, published: 0, archived: 0, total: 0 };
  rows.forEach(row => {
    stats[row.status] = Number(row.c);
    stats.total += Number(row.c);
  });
  return stats;
}

async function logAction(db, admin, action, targetType, targetId, details) {
  try {
    await db.execute(
      'INSERT INTO operation_logs (admin_id, admin_name, action, target_type, target_id, details) VALUES (?,?,?,?,?,?)',
      [admin.id, admin.username, action, targetType || null, targetId || null, details || null]
    );
  } catch (error) {
    console.error('Log failed:', error.message);
  }
}

async function notifyUser(db, userId, title, content, link) {
  if (!userId) return;
  await db.execute('INSERT INTO notifications (user_id, title, content, link) VALUES (?, ?, ?, ?)', [userId, title, content, link || '/me']);
}

async function notifyManuscriptOwner(db, manuscriptId, title, content, link) {
  const [[row]] = await db.execute('SELECT user_id FROM manuscripts WHERE id = ?', [manuscriptId]);
  if (!row || !row.user_id) return;
  await notifyUser(db, row.user_id, title, content, link || '/me');
}

function ensureFounder(req, res) {
  if (req.session.admin.role === 'admin') return true;
  res.redirect('/admin/dashboard');
  return false;
}

function ensureCapability(req, res, capability) {
  if (hasCapability(req.session.admin.role, capability)) return true;
  res.redirect('/admin/dashboard');
  return false;
}

function getRoleOptions() {
  return ['admin', 'co_curator', 'editor', 'reviewer'];
}

function normalizeArchiveGrade(value) {
  return ['standard', 'featured', 'dossier', 'honor'].includes(value) ? value : 'standard';
}


async function loadIssueOptions(db) {
  const [issues] = await db.execute('SELECT * FROM issues WHERE is_active = 1 ORDER BY is_current DESC, year DESC, id DESC');
  return issues;
}

async function loadAdminOptions(db) {
  const [admins] = await db.execute("SELECT id, username, role, display_name, title FROM admins ORDER BY FIELD(role, 'admin', 'co_curator', 'editor', 'reviewer'), id ASC");
  return admins;
}

module.exports = function (csrfCheck) {
  router.get('/login', (req, res) => {
    if (req.session && req.session.admin) return res.redirect('/admin/dashboard');
    res.render('admin/login', { error: req.query.error ? '用户名或密码错误' : null });
  });

  router.post('/login', wrap(async (req, res) => {
    const db = res.locals.db;
    const { username, password } = req.body;
    const [rows] = await db.execute('SELECT * FROM admins WHERE username = ?', [username]);
    if (!rows.length || !bcrypt.compareSync(password, rows[0].password_hash)) return res.redirect('/admin/login?error=1');
    req.session.admin = {
      id: rows[0].id,
      username: rows[0].username,
      role: normalizeAdminRole(rows[0].role || 'admin'),
      display_name: rows[0].display_name || rows[0].username,
      title: rows[0].title || ''
    };
    await logAction(db, req.session.admin, 'login', null, null, null);
    res.redirect('/admin/dashboard');
  }));

  router.get('/logout', (req, res) => {
    req.session.destroy(() => res.redirect('/admin/login'));
  });

  router.get('/', requireAuth, (req, res) => res.redirect('/admin/dashboard'));

  router.get('/dashboard', requireAuth, wrap(async (req, res) => {
    const db = res.locals.db;
    const stats = await getStats(db);
    const [recent] = await db.execute(`SELECT id, submission_no, title, section, status, risk_level, created_at FROM manuscripts ORDER BY created_at DESC LIMIT 10`);
    const [[{ todayCount }]] = await db.execute('SELECT COUNT(*) AS todayCount FROM manuscripts WHERE DATE(created_at) = CURDATE()');
    const [[{ broadcastCount }]] = await db.execute('SELECT COUNT(*) AS broadcastCount FROM announcements WHERE is_active = 1');
    const [[{ currentIssueCount }]] = await db.execute('SELECT COUNT(*) AS currentIssueCount FROM issues WHERE is_current = 1');
    const [weekData] = await db.execute(`SELECT DATE(created_at) as day, COUNT(*) as c FROM manuscripts WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL 30 DAY) GROUP BY DATE(created_at) ORDER BY day ASC`);
    const [sectionData] = await db.execute(`SELECT section, COUNT(*) as c FROM manuscripts GROUP BY section ORDER BY c DESC`);

    res.render('admin/dashboard', {
      stats,
      recent,
      todayCount: Number(todayCount || 0),
      weekData,
      sectionData,
      broadcastCount: Number(broadcastCount || 0),
      currentIssueCount: Number(currentIssueCount || 0),
      admin: req.session.admin,
    });
  }));

  router.get('/manuscripts', requireAuth, wrap(async (req, res) => {
    const db = res.locals.db;
    const { status, section, risk, q, sort } = req.query;
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    let countSql = 'SELECT COUNT(*) as c FROM manuscripts WHERE 1=1';
    let sql = 'SELECT id, submission_no, title, discipline, section, author_mode, user_id, status, risk_level, desensitized_status, is_featured, is_pinned, is_editor_pick, is_trending, created_at FROM manuscripts WHERE 1=1';
    const params = [];

    if (status) { const filter = ' AND status = ?'; sql += filter; countSql += filter; params.push(status); }
    if (section) { const filter = ' AND section = ?'; sql += filter; countSql += filter; params.push(section); }
    if (risk) { const filter = ' AND risk_level = ?'; sql += filter; countSql += filter; params.push(risk); }
    if (q) {
      const filter = ' AND (title LIKE ? OR discipline LIKE ? OR content LIKE ? OR submission_no LIKE ?)';
      sql += filter;
      countSql += filter;
      params.push('%' + q + '%', '%' + q + '%', '%' + q + '%', '%' + q + '%');
    }

    const [[{ c: total }]] = await db.execute(countSql, params);
    const totalPages = Math.ceil(Number(total) / PER_PAGE_ADMIN) || 1;
    const sortMap = { newest: 'created_at DESC', oldest: 'created_at ASC', risk: "FIELD(risk_level,'high','medium','low')" };
    sql += ' ORDER BY ' + (sortMap[sort] || 'created_at DESC') + ' LIMIT ? OFFSET ?';
    const [manuscripts] = await db.execute(sql, [...params, PER_PAGE_ADMIN, (page - 1) * PER_PAGE_ADMIN]);

    res.render('admin/manuscripts', {
      manuscripts,
      stats: await getStats(db),
      sections: SECTIONS,
      statuses: STATUSES,
      filters: { status, section, risk, q, sort },
      page,
      totalPages,
      admin: req.session.admin,
    });
  }));

  router.post('/manuscripts/batch', requireAuth, csrfCheck, wrap(async (req, res) => {
    const db = res.locals.db;
    const { ids, action } = req.body;
    if (!ids || !action) return res.redirect('/admin/manuscripts');
    const idList = Array.isArray(ids) ? ids : [ids];

    if (STATUSES.includes(action)) {
      for (const id of idList) {
        if (action === 'published') {
          await db.execute('UPDATE manuscripts SET status = ?, published_at = NOW() WHERE id = ?', [action, id]);
          await notifyManuscriptOwner(db, id, '稿件已发布', '你的稿件已经进入公开档案，可在前台查看馆藏版与阅读页。', `/article/${id}`);
        } else if (action === 'archived') {
          await db.execute('UPDATE manuscripts SET status = ?, is_archived = 1 WHERE id = ?', [action, id]);
          await notifyManuscriptOwner(db, id, '稿件已归档', '你的稿件已被归档处理，可在会员工作台继续查看记录。', '/me');
        } else {
          await db.execute('UPDATE manuscripts SET status = ? WHERE id = ?', [action, id]);
          await notifyManuscriptOwner(db, id, '稿件状态已更新', `你的稿件状态已更新为 ${action}。`, '/me');
        }
      }
      await logAction(db, req.session.admin, `batch_status_${action}`, 'manuscript', null, `IDs: ${idList.join(',')}`);
    }
    res.redirect('/admin/manuscripts?msg=batch_done');
  }));

  router.get('/manuscripts/export', requireAuth, wrap(async (req, res) => {
    const db = res.locals.db;
    const [rows] = await db.execute(
      `SELECT submission_no, title, discipline, section, author_mode, pen_name, status, risk_level, desensitized_status,
              is_featured, is_pinned, view_count, tags, created_at, updated_at, published_at
       FROM manuscripts ORDER BY created_at DESC`
    );

    let csv = '\uFEFF';
    csv += '编号,标题,学科,栏目,署名方式,笔名,状态,风险,脱敏,精选,置顶,浏览量,标签,投稿时间,更新时间,发布时间\n';
    for (const row of rows) {
      const fields = [row.submission_no, `"${(row.title || '').replace(/"/g, '""')}"`, row.discipline, row.section, row.author_mode, row.pen_name || '', row.status, row.risk_level, row.desensitized_status, row.is_featured, row.is_pinned, row.view_count, `"${row.tags || ''}"`, row.created_at, row.updated_at, row.published_at || ''];
      csv += fields.join(',') + '\n';
    }

    await logAction(db, req.session.admin, 'export_csv', null, null, `${rows.length} rows`);
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="nrr-manuscripts-${new Date().toISOString().slice(0, 10)}.csv"` });
    res.send(csv);
  }));

  router.get('/logs', requireAuth, wrap(async (req, res) => {
    const db = res.locals.db;
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    if (!ensureCapability(req, res, 'view_logs')) return;
    const [[{ c: total }]] = await db.execute('SELECT COUNT(*) as c FROM operation_logs');
    const totalPages = Math.ceil(Number(total) / 20) || 1;
    const [logs] = await db.execute('SELECT * FROM operation_logs ORDER BY created_at DESC LIMIT 20 OFFSET ?', [(page - 1) * 20]);
    res.render('admin/logs', { logs, stats: await getStats(db), page, totalPages, admin: req.session.admin });
  }));

  router.get('/issues', requireAuth, wrap(async (req, res) => {
    const db = res.locals.db;
    const [issues] = await db.execute(`SELECT i.*,
      lead.username AS lead_username, lead.display_name AS lead_display_name, lead.title AS lead_title,
      co.username AS co_username, co.display_name AS co_display_name, co.title AS co_title,
      (SELECT COUNT(*) FROM manuscripts m WHERE m.issue_id = i.id) AS manuscript_count
      FROM issues i
      LEFT JOIN admins lead ON lead.id = i.lead_admin_id
      LEFT JOIN admins co ON co.id = i.co_admin_id
      ORDER BY i.is_current DESC, i.year DESC, i.id DESC`);
    const adminOptions = await loadAdminOptions(db);
    res.render('admin/issues', { issues, adminOptions, stats: await getStats(db), admin: req.session.admin, msg: req.query.msg || null });
  }));

  router.post('/issues', requireAuth, csrfCheck, wrap(async (req, res) => {
    const db = res.locals.db;
    if (!ensureCapability(req, res, 'manage_publication')) return;
    const issueCode = (req.body.issue_code || '').trim();
    const issueLabel = (req.body.issue_label || '').trim();
    const season = (req.body.season || '').trim();
    const year = Number(req.body.year) || new Date().getFullYear();
    const themeTitle = (req.body.theme_title || '').trim();
    const themeNote = (req.body.theme_note || '').trim();
    const coverLabel = (req.body.cover_label || '').trim();
    const leadAdminId = req.body.lead_admin_id ? Number(req.body.lead_admin_id) : null;
    let coAdminId = req.body.co_admin_id ? Number(req.body.co_admin_id) : null;
    const curatorStatement = (req.body.curator_statement || '').trim();
    const isCurrent = req.body.is_current ? 1 : 0;
    if (coAdminId && leadAdminId && coAdminId === leadAdminId) coAdminId = null;
    if (!issueCode || !issueLabel) return res.redirect('/admin/issues?msg=invalid');
    if (isCurrent) await db.execute('UPDATE issues SET is_current = 0');
    await db.execute('INSERT INTO issues (issue_code, issue_label, season, year, theme_title, theme_note, cover_label, lead_admin_id, co_admin_id, curator_statement, is_current, is_active) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)', [issueCode, issueLabel, season, year, themeTitle, themeNote, coverLabel, leadAdminId, coAdminId, curatorStatement, isCurrent]);
    await logAction(db, req.session.admin, 'create_issue', 'issue', null, issueCode);
    res.redirect('/admin/issues?msg=created');
  }));

  router.post('/issues/:id/update', requireAuth, csrfCheck, wrap(async (req, res) => {
    const db = res.locals.db;
    if (!ensureCapability(req, res, 'manage_publication')) return;
    const issueCode = (req.body.issue_code || '').trim();
    const issueLabel = (req.body.issue_label || '').trim();
    const season = (req.body.season || '').trim();
    const year = Number(req.body.year) || new Date().getFullYear();
    const themeTitle = (req.body.theme_title || '').trim();
    const themeNote = (req.body.theme_note || '').trim();
    const coverLabel = (req.body.cover_label || '').trim();
    const leadAdminId = req.body.lead_admin_id ? Number(req.body.lead_admin_id) : null;
    let coAdminId = req.body.co_admin_id ? Number(req.body.co_admin_id) : null;
    const curatorStatement = (req.body.curator_statement || '').trim();
    const isCurrent = req.body.is_current ? 1 : 0;
    const isActive = req.body.is_active ? 1 : 0;
    if (coAdminId && leadAdminId && coAdminId === leadAdminId) coAdminId = null;
    if (!issueCode || !issueLabel) return res.redirect('/admin/issues?msg=invalid');
    if (isCurrent) await db.execute('UPDATE issues SET is_current = 0');
    await db.execute('UPDATE issues SET issue_code = ?, issue_label = ?, season = ?, year = ?, theme_title = ?, theme_note = ?, cover_label = ?, lead_admin_id = ?, co_admin_id = ?, curator_statement = ?, is_current = ?, is_active = ? WHERE id = ?', [issueCode, issueLabel, season, year, themeTitle, themeNote, coverLabel, leadAdminId, coAdminId, curatorStatement, isCurrent, isActive, req.params.id]);
    await logAction(db, req.session.admin, 'update_issue', 'issue', req.params.id, issueCode);
    res.redirect('/admin/issues?msg=saved');
  }));

  router.post('/issues/:id/current', requireAuth, csrfCheck, wrap(async (req, res) => {
    const db = res.locals.db;
    if (!ensureCapability(req, res, 'manage_publication')) return;
    await db.execute('UPDATE issues SET is_current = 0');
    await db.execute('UPDATE issues SET is_current = 1 WHERE id = ?', [req.params.id]);
    await logAction(db, req.session.admin, 'set_current_issue', 'issue', req.params.id, null);
    res.redirect('/admin/issues?msg=current_saved');
  }));

  router.get('/announcements', requireAuth, wrap(async (req, res) => {
    const db = res.locals.db;
    if (!ensureCapability(req, res, 'manage_announcements')) return;
    const [announcements] = await db.execute(`SELECT a.*,
      creator.username AS creator_username, creator.display_name AS creator_display_name, creator.title AS creator_title
      FROM announcements a
      LEFT JOIN admins creator ON creator.id = a.created_by
      ORDER BY a.is_pinned DESC, a.priority DESC, a.created_at DESC`);
    res.render('admin/announcements', { announcements, stats: await getStats(db), admin: req.session.admin, msg: req.query.msg || null });
  }));

  router.get('/announcements/new', requireAuth, wrap(async (req, res) => {
    if (!ensureCapability(req, res, 'manage_announcements')) return;
    res.render('admin/announcement-detail', { announcement: null, stats: await getStats(res.locals.db), admin: req.session.admin, msg: null });
  }));

  router.get('/announcements/:id', requireAuth, wrap(async (req, res) => {
    const db = res.locals.db;
    if (!ensureCapability(req, res, 'manage_announcements')) return;
    const [rows] = await db.execute(`SELECT a.*, creator.username AS creator_username, creator.display_name AS creator_display_name, creator.title AS creator_title
      FROM announcements a LEFT JOIN admins creator ON creator.id = a.created_by WHERE a.id = ?`, [req.params.id]);
    if (!rows.length) return res.redirect('/admin/announcements');
    res.render('admin/announcement-detail', { announcement: rows[0], stats: await getStats(db), admin: req.session.admin, msg: req.query.msg || null });
  }));

  router.post('/announcements/save', requireAuth, csrfCheck, wrap(async (req, res) => {
    const db = res.locals.db;
    if (!ensureCapability(req, res, 'manage_announcements')) return;
    const payload = {
      id: req.body.id || '',
      title: (req.body.title || '').trim(),
      subtitle: (req.body.subtitle || '').trim(),
      content: (req.body.content || '').trim(),
      type: (req.body.type || 'notice').trim(),
      audience: (req.body.audience || 'all').trim(),
      theme: (req.body.theme || 'archive').trim(),
      priority: Number(req.body.priority) || 0,
      cta_text: (req.body.cta_text || '').trim(),
      cta_link: (req.body.cta_link || '').trim(),
      signature_name: (req.body.signature_name || '').trim(),
      signature_title: (req.body.signature_title || '').trim(),
      start_at: req.body.start_at || null,
      end_at: req.body.end_at || null,
      is_active: req.body.is_active ? 1 : 0,
      is_pinned: req.body.is_pinned ? 1 : 0,
      is_rotating: req.body.is_rotating ? 1 : 0,
      show_on_home: req.body.show_on_home ? 1 : 0,
      show_on_dashboard: req.body.show_on_dashboard ? 1 : 0,
      show_on_article: req.body.show_on_article ? 1 : 0,
    };
    if (!payload.title || !payload.content) return res.redirect('/admin/announcements?msg=invalid');

    if (payload.id) {
      await db.execute(`UPDATE announcements SET title = ?, subtitle = ?, content = ?, type = ?, audience = ?, theme = ?, priority = ?, cta_text = ?, cta_link = ?, signature_name = ?, signature_title = ?, start_at = ?, end_at = ?, is_active = ?, is_pinned = ?, is_rotating = ?, show_on_home = ?, show_on_dashboard = ?, show_on_article = ? WHERE id = ?`, [payload.title, payload.subtitle, payload.content, payload.type, payload.audience, payload.theme, payload.priority, payload.cta_text, payload.cta_link, payload.signature_name, payload.signature_title, payload.start_at, payload.end_at, payload.is_active, payload.is_pinned, payload.is_rotating, payload.show_on_home, payload.show_on_dashboard, payload.show_on_article, payload.id]);
      await logAction(db, req.session.admin, 'update_announcement', 'announcement', payload.id, payload.title);
      return res.redirect(`/admin/announcements/${payload.id}?msg=saved`);
    }

    const [result] = await db.execute(`INSERT INTO announcements (title, subtitle, content, type, audience, theme, priority, cta_text, cta_link, signature_name, signature_title, start_at, end_at, is_active, is_pinned, is_rotating, show_on_home, show_on_dashboard, show_on_article, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [payload.title, payload.subtitle, payload.content, payload.type, payload.audience, payload.theme, payload.priority, payload.cta_text, payload.cta_link, payload.signature_name, payload.signature_title, payload.start_at, payload.end_at, payload.is_active, payload.is_pinned, payload.is_rotating, payload.show_on_home, payload.show_on_dashboard, payload.show_on_article, req.session.admin.id]);
    await logAction(db, req.session.admin, 'create_announcement', 'announcement', result.insertId, payload.title);
    res.redirect(`/admin/announcements/${result.insertId}?msg=created`);
  }));

  router.post('/announcements/:id/delete', requireAuth, csrfCheck, wrap(async (req, res) => {
    const db = res.locals.db;
    if (!ensureCapability(req, res, 'manage_announcements')) return;
    await db.execute('UPDATE announcements SET is_active = 0 WHERE id = ?', [req.params.id]);
    await logAction(db, req.session.admin, 'deactivate_announcement', 'announcement', req.params.id, null);
    res.redirect('/admin/announcements?msg=deleted');
  }));

  router.get('/manuscripts/:id', requireAuth, wrap(async (req, res) => {
    const db = res.locals.db;
    const [rows] = await db.execute(`SELECT m.*, i.issue_label, i.issue_code, i.season, i.year, i.theme_title,
      curator.username AS curator_username, curator.display_name AS curator_display_name, curator.title AS curator_title,
      assignee.username AS assignee_username, assignee.display_name AS assignee_display_name, assignee.title AS assignee_title
      FROM manuscripts m
      LEFT JOIN issues i ON i.id = m.issue_id
      LEFT JOIN admins curator ON curator.id = m.curator_admin_id
      LEFT JOIN admins assignee ON assignee.id = m.assigned_admin_id
      WHERE m.id = ?`, [req.params.id]);
    if (!rows.length) return res.redirect('/admin/manuscripts');
    const ms = rows[0];

    let owner = null;
    if (ms.user_id) {
      const [ownerRows] = await db.execute('SELECT id, email, display_name, member_tier, is_active, created_at, last_login_at FROM users WHERE id = ?', [ms.user_id]);
      owner = ownerRows[0] || null;
    }

    const [logs] = await db.execute('SELECT * FROM operation_logs WHERE target_type = ? AND target_id = ? ORDER BY created_at DESC LIMIT 20', ['manuscript', req.params.id]);
    const [versions] = await db.execute('SELECT * FROM article_versions WHERE manuscript_id = ? ORDER BY created_at DESC LIMIT 20', [req.params.id]);
    const issues = await loadIssueOptions(db);
    const adminOptions = await loadAdminOptions(db);

    res.render('admin/detail', {
      ms,
      stats: await getStats(db),
      sections: SECTIONS,
      statuses: STATUSES,
      logs,
      owner,
      versions,
      issues,
      adminOptions,
      msg: req.query.msg || null,
      admin: req.session.admin,
    });
  }));

  router.post('/manuscripts/:id', requireAuth, csrfCheck, wrap(async (req, res) => {
    const db = res.locals.db;
    const { risk_level, desensitized_status, editor_note, is_featured, is_pinned, is_editor_pick, is_trending, tags, archive_code, archive_grade, curator_note, curator_admin_id, assigned_admin_id, internal_note } = req.body;
    await db.execute(`UPDATE manuscripts SET risk_level = ?, desensitized_status = ?, editor_note = ?, is_featured = ?, is_pinned = ?, is_editor_pick = ?, is_trending = ?, tags = ?, archive_code = ?, archive_grade = ?, curator_note = ?, curator_admin_id = ?, assigned_admin_id = ?, internal_note = ? WHERE id = ?`, [risk_level || 'low', desensitized_status || 'unchecked', editor_note || '', is_featured ? 1 : 0, is_pinned ? 1 : 0, is_editor_pick ? 1 : 0, is_trending ? 1 : 0, (tags || '').trim(), (archive_code || '').trim(), normalizeArchiveGrade(archive_grade), (curator_note || '').trim(), curator_admin_id ? Number(curator_admin_id) : null, assigned_admin_id ? Number(assigned_admin_id) : null, (internal_note || '').trim(), req.params.id]);
    await logAction(db, req.session.admin, 'update_metadata', 'manuscript', req.params.id, `risk=${risk_level}, grade=${normalizeArchiveGrade(archive_grade)}`);
    res.redirect(`/admin/manuscripts/${req.params.id}?msg=saved`);
  }));

  router.post('/manuscripts/:id/content', requireAuth, csrfCheck, wrap(async (req, res) => {
    const db = res.locals.db;
    const { title, content } = req.body;
    if (!title || !content) return res.redirect(`/admin/manuscripts/${req.params.id}?msg=content_empty`);
    await db.execute('UPDATE manuscripts SET title = ?, content = ? WHERE id = ?', [title.trim(), content.trim(), req.params.id]);
    await db.execute('INSERT INTO article_versions (manuscript_id, version_type, title, content, meta_json, created_by_admin_id) VALUES (?, ?, ?, ?, ?, ?)', [req.params.id, 'raw_edit', title.trim(), content.trim(), JSON.stringify({ source: 'admin_content' }), req.session.admin.id]).catch(() => {});
    await logAction(db, req.session.admin, 'update_content', 'manuscript', req.params.id, `title=${title.trim().substring(0, 50)}`);
    res.redirect(`/admin/manuscripts/${req.params.id}?msg=content_saved`);
  }));

  router.post('/manuscripts/:id/optimize', requireAuth, csrfCheck, wrap(async (req, res) => {
    const db = res.locals.db;
    const [[manuscript]] = await db.execute('SELECT id, title, section, value_note, content FROM manuscripts WHERE id = ?', [req.params.id]);
    if (!manuscript) return res.redirect('/admin/manuscripts');
    const pack = buildTypographyPackage(manuscript);
    await db.execute('UPDATE manuscripts SET optimized_content = ?, deck = IF(deck = "", ?, deck), excerpt = IF(excerpt IS NULL OR excerpt = "", ?, excerpt) WHERE id = ?', [pack.optimizedContent, pack.deck, pack.excerpt, req.params.id]);
    await db.execute('INSERT INTO article_versions (manuscript_id, version_type, title, content, meta_json, created_by_admin_id) VALUES (?, ?, ?, ?, ?, ?)', [req.params.id, 'optimized', manuscript.title, pack.optimizedContent, JSON.stringify({ deck: pack.deck, excerpt: pack.excerpt, suggestedTags: pack.suggestedTags }), req.session.admin.id]);
    await logAction(db, req.session.admin, 'optimize_manuscript', 'manuscript', req.params.id, `tags=${pack.suggestedTags.join('|')}`);
    res.redirect(`/admin/manuscripts/${req.params.id}?msg=optimized`);
  }));

  router.post('/manuscripts/:id/apply-optimized', requireAuth, csrfCheck, wrap(async (req, res) => {
    const db = res.locals.db;
    const [[manuscript]] = await db.execute('SELECT title, optimized_content, deck, excerpt FROM manuscripts WHERE id = ?', [req.params.id]);
    if (!manuscript || !manuscript.optimized_content) return res.redirect(`/admin/manuscripts/${req.params.id}?msg=no_optimized`);
    await db.execute('UPDATE manuscripts SET published_content = ?, display_title = IFNULL(display_title, title) WHERE id = ?', [manuscript.optimized_content, req.params.id]);
    await db.execute('INSERT INTO article_versions (manuscript_id, version_type, title, content, meta_json, created_by_admin_id) VALUES (?, ?, ?, ?, ?, ?)', [req.params.id, 'published', manuscript.title, manuscript.optimized_content, JSON.stringify({ deck: manuscript.deck, excerpt: manuscript.excerpt }), req.session.admin.id]);
    await logAction(db, req.session.admin, 'apply_optimized_publish', 'manuscript', req.params.id, null);
    res.redirect(`/admin/manuscripts/${req.params.id}?msg=published_copy_saved`);
  }));

  router.post('/manuscripts/:id/publication', requireAuth, csrfCheck, wrap(async (req, res) => {
    const db = res.locals.db;
    const payload = {
      display_title: (req.body.display_title || '').trim(),
      deck: (req.body.deck || '').trim(),
      excerpt: (req.body.excerpt || '').trim(),
      publication_label: (req.body.publication_label || '').trim(),
      layout_style: (req.body.layout_style || 'journal').trim(),
      issue_id: req.body.issue_id ? Number(req.body.issue_id) : null,
      pdf_enabled: req.body.pdf_enabled ? 1 : 0,
      archive_code: (req.body.archive_code || '').trim(),
      archive_grade: normalizeArchiveGrade(req.body.archive_grade),
      published_content: (req.body.published_content || '').trim(),
    };
    await db.execute(`UPDATE manuscripts SET display_title = ?, deck = ?, excerpt = ?, publication_label = ?, layout_style = ?, issue_id = ?, pdf_enabled = ?, archive_code = ?, archive_grade = ?, published_content = ? WHERE id = ?`, [payload.display_title || null, payload.deck, payload.excerpt, payload.publication_label, payload.layout_style || 'journal', payload.issue_id, payload.pdf_enabled, payload.archive_code, payload.archive_grade, payload.published_content || null, req.params.id]);
    await logAction(db, req.session.admin, 'update_publication_layout', 'manuscript', req.params.id, `issue=${payload.issue_id || 'none'}`);
    res.redirect(`/admin/manuscripts/${req.params.id}?msg=publication_saved`);
  }));

  router.post('/manuscripts/:id/status', requireAuth, csrfCheck, wrap(async (req, res) => {
    const db = res.locals.db;
    const { status } = req.body;
    if (!STATUSES.includes(status)) return res.redirect(`/admin/manuscripts/${req.params.id}?msg=invalid`);
    if (status === 'published') {
      await db.execute('UPDATE manuscripts SET status = ?, published_at = NOW() WHERE id = ?', [status, req.params.id]);
    } else if (status === 'archived') {
      await db.execute('UPDATE manuscripts SET status = ?, is_archived = 1 WHERE id = ?', [status, req.params.id]);
    } else {
      await db.execute('UPDATE manuscripts SET status = ? WHERE id = ?', [status, req.params.id]);
    }
    await logAction(db, req.session.admin, `status_to_${status}`, 'manuscript', req.params.id, null);
    const titleMap = { pending: '稿件已回到待审队列', under_review: '稿件进入审核中', revision: '稿件需要修改', accepted: '稿件已被录用', rejected: '稿件未通过审核', published: '稿件已正式入馆', archived: '稿件已归档' };
    await notifyManuscriptOwner(db, req.params.id, titleMap[status] || '稿件状态更新', `你的稿件状态已更新为 ${status}。请前往会员工作台查看详情。`, '/me');
    res.redirect(`/admin/manuscripts/${req.params.id}?msg=status_${status}`);
  }));

  router.get('/users', requireAuth, wrap(async (req, res) => {
    const db = res.locals.db;
    if (!ensureCapability(req, res, 'view_members')) return;
    const { tier, state, q } = req.query;
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    let countSql = 'SELECT COUNT(*) AS c FROM users WHERE 1 = 1';
    let sql = `SELECT u.id, u.email, u.display_name, u.member_tier, u.is_active, u.created_at, u.last_login_at,
                      (SELECT COUNT(*) FROM manuscripts m WHERE m.user_id = u.id) AS submission_count,
                      (SELECT COUNT(*) FROM member_applications a WHERE a.user_id = u.id AND a.status = 'pending') AS pending_application_count
               FROM users u WHERE 1 = 1`;
    const params = [];
    if (tier) { const filter = ' AND u.member_tier = ?'; countSql += filter; sql += filter; params.push(tier); }
    if (state === 'active') { countSql += ' AND u.is_active = 1'; sql += ' AND u.is_active = 1'; }
    else if (state === 'inactive') { countSql += ' AND u.is_active = 0'; sql += ' AND u.is_active = 0'; }
    if (q) { const filter = ' AND (u.email LIKE ? OR u.display_name LIKE ?)'; countSql += filter; sql += filter; params.push('%' + q + '%', '%' + q + '%'); }
    const [[{ c: total }]] = await db.execute(countSql, params);
    const totalPages = Math.ceil(Number(total) / PER_PAGE_ADMIN) || 1;
    sql += ' ORDER BY u.created_at DESC LIMIT ? OFFSET ?';
    const [users] = await db.execute(sql, [...params, PER_PAGE_ADMIN, (page - 1) * PER_PAGE_ADMIN]);
    const [[{ totalUsers }]] = await db.execute('SELECT COUNT(*) AS totalUsers FROM users');
    const [[{ activeUsers }]] = await db.execute('SELECT COUNT(*) AS activeUsers FROM users WHERE is_active = 1');
    const [[{ pendingApplications }]] = await db.execute('SELECT COUNT(*) AS pendingApplications FROM member_applications WHERE status = ?', ['pending']);
    res.render('admin/users', { users, stats: await getStats(db), memberStats: { totalUsers: Number(totalUsers || 0), activeUsers: Number(activeUsers || 0), pendingApplications: Number(pendingApplications || 0) }, filters: { tier, state, q }, page, totalPages, admin: req.session.admin });
  }));

  router.get('/users/:id', requireAuth, wrap(async (req, res) => {
    const db = res.locals.db;
    if (!ensureCapability(req, res, 'view_members')) return;
    const [rows] = await db.execute('SELECT id, email, display_name, member_tier, bio, is_active, created_at, last_login_at FROM users WHERE id = ?', [req.params.id]);
    if (!rows.length) return res.redirect('/admin/users');
    const [submissions] = await db.execute(`SELECT id, submission_no, title, section, status, created_at, updated_at FROM manuscripts WHERE user_id = ? ORDER BY created_at DESC LIMIT 20`, [req.params.id]);
    const [favorites] = await db.execute(`SELECT m.id, m.title, m.section, f.created_at AS favorited_at FROM favorites f JOIN manuscripts m ON m.id = f.article_id WHERE f.user_id = ? ORDER BY f.created_at DESC LIMIT 10`, [req.params.id]);
    const [notifications] = await db.execute('SELECT id, title, content, is_read, created_at FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 10', [req.params.id]);
    const [applications] = await db.execute(`SELECT a.*, reviewer.username AS reviewer_name FROM member_applications a LEFT JOIN admins reviewer ON reviewer.id = a.reviewed_by WHERE a.user_id = ? ORDER BY a.created_at DESC`, [req.params.id]);
    res.render('admin/user-detail', { user: rows[0], submissions, favorites, notifications, applications, stats: await getStats(db), admin: req.session.admin, msg: req.query.msg || null });
  }));

  router.post('/users/:id/tier', requireAuth, csrfCheck, wrap(async (req, res) => {
    const db = res.locals.db;
    if (!ensureCapability(req, res, 'manage_member_state')) return;
    const memberTier = ['member', 'supporter', 'contributor', 'editorial'].includes(req.body.member_tier) ? req.body.member_tier : 'member';
    await db.execute('UPDATE users SET member_tier = ? WHERE id = ?', [memberTier, req.params.id]);
    await logAction(db, req.session.admin, 'grant_member_tier', 'user', req.params.id, `tier=${memberTier}`);
    await notifyUser(db, req.params.id, '会员等级已更新', `你的会员等级已调整为 ${memberTier}。`, '/me');
    res.redirect(`/admin/users/${req.params.id}?msg=tier_saved`);
  }));

  router.post('/users/:id/status', requireAuth, csrfCheck, wrap(async (req, res) => {
    const db = res.locals.db;
    if (!ensureCapability(req, res, 'manage_member_state')) return;
    const isActive = req.body.is_active === '1' ? 1 : 0;
    await db.execute('UPDATE users SET is_active = ? WHERE id = ?', [isActive, req.params.id]);
    await logAction(db, req.session.admin, isActive ? 'reactivate_user' : 'deactivate_user', 'user', req.params.id, null);
    await notifyUser(db, req.params.id, isActive ? '账户已恢复使用' : '账户已被暂停', isActive ? '你的会员账户已恢复，可正常登录和使用工作台。' : '你的会员账户已被后台暂停，如有疑问请联系站点管理员。', '/me');
    res.redirect(`/admin/users/${req.params.id}?msg=status_saved`);
  }));

  router.get('/member-applications', requireAuth, wrap(async (req, res) => {
    const db = res.locals.db;
    if (!ensureCapability(req, res, 'review_members')) return;
    const status = req.query.status || '';
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    let countSql = 'SELECT COUNT(*) AS c FROM member_applications a WHERE 1 = 1';
    let sql = `SELECT a.id, a.user_id, a.requested_tier, a.reason, a.status, a.admin_note, a.reviewed_at, a.created_at, u.display_name, u.email, u.member_tier, reviewer.username AS reviewer_name FROM member_applications a JOIN users u ON u.id = a.user_id LEFT JOIN admins reviewer ON reviewer.id = a.reviewed_by WHERE 1 = 1`;
    const params = [];
    if (status) { const filter = ' AND a.status = ?'; countSql += filter; sql += filter; params.push(status); }
    const [[{ c: total }]] = await db.execute(countSql, params);
    const totalPages = Math.ceil(Number(total) / 20) || 1;
    sql += ` ORDER BY CASE WHEN a.status = 'pending' THEN 0 ELSE 1 END, a.created_at DESC LIMIT 20 OFFSET ?`;
    const [applications] = await db.execute(sql, [...params, (page - 1) * 20]);
    res.render('admin/member-applications', { applications, filters: { status }, page, totalPages, stats: await getStats(db), admin: req.session.admin, msg: req.query.msg || null });
  }));

  router.post('/member-applications/:id/review', requireAuth, csrfCheck, wrap(async (req, res) => {
    const db = res.locals.db;
    if (!ensureCapability(req, res, 'review_members')) return;
    const action = req.body.action === 'approve' ? 'approve' : 'reject';
    const adminNote = (req.body.admin_note || '').trim().substring(0, 2000);
    const [rows] = await db.execute('SELECT * FROM member_applications WHERE id = ?', [req.params.id]);
    if (!rows.length) return res.redirect('/admin/member-applications?msg=not_found');
    const application = rows[0];
    if (application.status !== 'pending') return res.redirect('/admin/member-applications?msg=already_reviewed');
    const finalStatus = action === 'approve' ? 'approved' : 'rejected';
    await db.execute('UPDATE member_applications SET status = ?, admin_note = ?, reviewed_by = ?, reviewed_at = NOW() WHERE id = ?', [finalStatus, adminNote, req.session.admin.id, req.params.id]);
    if (action === 'approve') {
      await db.execute('UPDATE users SET member_tier = ? WHERE id = ?', [application.requested_tier, application.user_id]);
      await notifyUser(db, application.user_id, '会员申请已通过', `你的会员申请已通过审核，当前等级已调整为 ${application.requested_tier}。${adminNote ? ' 审核备注：' + adminNote : ''}`, '/me');
    } else {
      await notifyUser(db, application.user_id, '会员申请未通过', `你的会员申请未通过审核。${adminNote ? ' 审核备注：' + adminNote : ''}`, '/me');
    }
    await logAction(db, req.session.admin, `review_member_application_${finalStatus}`, 'member_application', req.params.id, `user=${application.user_id}, tier=${application.requested_tier}`);
    res.redirect('/admin/member-applications?msg=reviewed');
  }));

  router.get('/admins', requireAuth, wrap(async (req, res) => {
    const db = res.locals.db;
    if (!ensureFounder(req, res)) return;
    const [admins] = await db.execute("SELECT id, username, role, display_name, title, badge_label, bio, public_slug, is_public, created_at FROM admins ORDER BY FIELD(role, 'admin', 'co_curator', 'editor', 'reviewer'), id ASC");
    res.render('admin/admins', { admins, stats: await getStats(db), msg: req.query.msg || null, admin: req.session.admin });
  }));

  router.post('/admins/add', requireAuth, csrfCheck, wrap(async (req, res) => {
    const db = res.locals.db;
    if (!ensureFounder(req, res)) return;
    const { username, password, role, display_name, title, badge_label, public_slug } = req.body;
    if (!username || !password || password.length < 6) return res.redirect('/admin/admins?msg=invalid');
    const [existing] = await db.execute('SELECT id FROM admins WHERE username = ?', [username]);
    if (existing.length > 0) return res.redirect('/admin/admins?msg=exists');
    const hash = bcrypt.hashSync(password, 10);
    const validRole = getRoleOptions().includes(role) ? role : 'editor';
    const safeDisplayName = (display_name || username).trim().substring(0, 80);
    const safeTitle = (title || getAdminRoleLabel(validRole)).trim().substring(0, 120);
    const safeBadgeLabel = (badge_label || getAdminRoleLabel(validRole)).trim().substring(0, 40);
    const safeSlug = (public_slug || username).trim().substring(0, 80);
    await db.execute('INSERT INTO admins (username, password_hash, role, display_name, title, badge_label, public_slug, is_public) VALUES (?,?,?,?,?,?,?,?)', [username.trim(), hash, validRole, safeDisplayName, safeTitle, safeBadgeLabel, safeSlug, req.body.is_public ? 1 : 0]);
    await logAction(db, req.session.admin, 'add_admin', 'admin', null, `username=${username}, role=${validRole}`);
    res.redirect('/admin/admins?msg=added');
  }));

  router.post('/admins/:id/profile', requireAuth, csrfCheck, wrap(async (req, res) => {
    const db = res.locals.db;
    if (!ensureFounder(req, res)) return;
    const role = getRoleOptions().includes(req.body.role) ? req.body.role : 'editor';
    const payload = {
      display_name: (req.body.display_name || '').trim().substring(0, 80),
      title: (req.body.title || '').trim().substring(0, 120),
      badge_label: (req.body.badge_label || '').trim().substring(0, 40),
      bio: (req.body.bio || '').trim().substring(0, 500),
      public_slug: (req.body.public_slug || '').trim().substring(0, 80),
      is_public: req.body.is_public ? 1 : 0,
    };
    await db.execute('UPDATE admins SET role = ?, display_name = ?, title = ?, badge_label = ?, bio = ?, public_slug = ?, is_public = ? WHERE id = ?', [role, payload.display_name, payload.title, payload.badge_label, payload.bio, payload.public_slug, payload.is_public, req.params.id]);
    await logAction(db, req.session.admin, 'update_admin_profile', 'admin', req.params.id, `role=${role}`);
    res.redirect('/admin/admins?msg=profile_saved');
  }));

  router.post('/admins/:id/delete', requireAuth, csrfCheck, wrap(async (req, res) => {
    const db = res.locals.db;
    if (!ensureFounder(req, res)) return;
    if (parseInt(req.params.id, 10) === req.session.admin.id) return res.redirect('/admin/admins?msg=self');
    await db.execute('DELETE FROM admins WHERE id = ?', [req.params.id]);
    await logAction(db, req.session.admin, 'delete_admin', 'admin', req.params.id, null);
    res.redirect('/admin/admins?msg=deleted');
  }));

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
    if (!bcrypt.compareSync(old_password, rows[0].password_hash)) return res.redirect('/admin/password?msg=wrong_old');
    const hash = bcrypt.hashSync(new_password, 10);
    await db.execute('UPDATE admins SET password_hash = ? WHERE id = ?', [hash, req.session.admin.id]);
    await logAction(db, req.session.admin, 'change_password', 'admin', req.session.admin.id, null);
    res.redirect('/admin/password?msg=success');
  }));

  return router;
};
