const express = require('express');
const bcrypt = require('bcryptjs');
const { requireMember } = require('../middleware/auth');
const { SECTIONS, PER_PAGE_PUBLIC, estimateReadingTime } = require('../config/constants');

const router = express.Router();
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

async function createNotification(db, userId, title, content, link) {
  if (!userId) return;
  await db.execute(
    'INSERT INTO notifications (user_id, title, content, link) VALUES (?, ?, ?, ?)',
    [userId, title, content, link || '']
  );
}

module.exports = function (submitLimiter, csrfCheck) {
  router.get('/', wrap(async (req, res) => {
    const db = res.locals.db;
    const [pinned] = await db.execute(
      `SELECT id, submission_no, title, section, author_mode, pen_name, is_pinned, is_editor_pick, is_trending, is_featured, tags, published_at
       FROM manuscripts WHERE status = 'published' AND is_pinned = 1 ORDER BY published_at DESC LIMIT 3`
    );
    const [articles] = await db.execute(
      `SELECT id, submission_no, title, section, author_mode, pen_name, is_pinned, is_editor_pick, is_trending, is_featured, tags, published_at, view_count
       FROM manuscripts WHERE status = 'published' ORDER BY is_pinned DESC, published_at DESC LIMIT 8`
    );
    const [featured] = await db.execute(
      `SELECT id, submission_no, title, section, published_at
       FROM manuscripts WHERE status = 'published' AND is_featured = 1 ORDER BY published_at DESC LIMIT 3`
    );
    res.render('index', { articles, featured, pinned, sections: SECTIONS });
  }));

  router.get('/register', (req, res) => {
    res.render('register', { error: null, form: {}, nextUrl: req.query.next || '/me' });
  });

  router.post('/register', csrfCheck, wrap(async (req, res) => {
    const db = res.locals.db;
    const { email, display_name, password, confirm_password, next } = req.body;
    const form = { email, display_name };

    if (!email || !display_name || !password) {
      return res.render('register', { error: '请完整填写注册信息。', form, nextUrl: next || '/me' });
    }
    if (password.length < 6) {
      return res.render('register', { error: '密码至少需要 6 位。', form, nextUrl: next || '/me' });
    }
    if (password !== confirm_password) {
      return res.render('register', { error: '两次输入的密码不一致。', form, nextUrl: next || '/me' });
    }

    const [exists] = await db.execute('SELECT id FROM users WHERE email = ?', [email.trim().toLowerCase()]);
    if (exists.length > 0) {
      return res.render('register', { error: '这个邮箱已经注册过。', form, nextUrl: next || '/me' });
    }

    const hash = bcrypt.hashSync(password, 10);
    const [result] = await db.execute(
      'INSERT INTO users (email, password_hash, display_name, last_login_at) VALUES (?, ?, ?, NOW())',
      [email.trim().toLowerCase(), hash, display_name.trim().substring(0, 80)]
    );

    req.session.user = {
      id: result.insertId,
      email: email.trim().toLowerCase(),
      display_name: display_name.trim().substring(0, 80),
      member_tier: 'member'
    };

    await createNotification(db, result.insertId, '欢迎加入负结果通讯', '你的会员工作台已经启用，现在可以收藏文章、保存投稿归属并接收站内通知。', '/me');
    res.redirect(next || '/me');
  }));

  router.get('/login', (req, res) => {
    res.render('login', { error: null, form: {}, nextUrl: req.query.next || '/me' });
  });

  router.post('/login', csrfCheck, wrap(async (req, res) => {
    const db = res.locals.db;
    const { email, password, next } = req.body;
    const form = { email };
    if (!email || !password) {
      return res.render('login', { error: '请输入邮箱和密码。', form, nextUrl: next || '/me' });
    }

    const [rows] = await db.execute('SELECT * FROM users WHERE email = ? AND is_active = 1', [email.trim().toLowerCase()]);
    if (rows.length === 0 || !bcrypt.compareSync(password, rows[0].password_hash)) {
      return res.render('login', { error: '邮箱或密码错误。', form, nextUrl: next || '/me' });
    }

    await db.execute('UPDATE users SET last_login_at = NOW() WHERE id = ?', [rows[0].id]);
    req.session.user = {
      id: rows[0].id,
      email: rows[0].email,
      display_name: rows[0].display_name,
      member_tier: rows[0].member_tier || 'member'
    };

    res.redirect(next || '/me');
  }));

  router.get('/logout', (req, res) => {
    delete req.session.user;
    res.redirect('/');
  });

  router.get('/me', requireMember, wrap(async (req, res) => {
    const db = res.locals.db;
    const userId = req.session.user.id;
    const [[profile]] = await db.execute(
      'SELECT id, email, display_name, member_tier, bio, created_at, last_login_at FROM users WHERE id = ?',
      [userId]
    );
    const [submissions] = await db.execute(
      `SELECT id, submission_no, title, section, status, created_at, updated_at, published_at
       FROM manuscripts WHERE user_id = ? ORDER BY created_at DESC LIMIT 20`,
      [userId]
    );
    const [favorites] = await db.execute(
      `SELECT m.id, m.title, m.section, m.published_at, f.created_at AS favorited_at
       FROM favorites f
       JOIN manuscripts m ON m.id = f.article_id
       WHERE f.user_id = ? AND m.status IN ('published', 'archived')
       ORDER BY f.created_at DESC LIMIT 12`,
      [userId]
    );
    const [notifications] = await db.execute(
      'SELECT id, title, content, link, is_read, created_at FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 20',
      [userId]
    );
    res.render('member-dashboard', { profile, submissions, favorites, notifications });
  }));

  router.post('/notifications/:id/read', requireMember, csrfCheck, wrap(async (req, res) => {
    const db = res.locals.db;
    await db.execute('UPDATE notifications SET is_read = 1 WHERE id = ? AND user_id = ?', [req.params.id, req.session.user.id]);
    res.redirect('/me');
  }));

  router.get('/submit', (req, res) => {
    res.render('submit', {
      success: req.query.success === '1',
      submissionNo: req.query.no || null,
      sections: SECTIONS,
      memberHint: req.session.user ? '该稿件会自动归入你的会员工作台。' : null,
    });
  });

  router.post('/submit', submitLimiter, csrfCheck, wrap(async (req, res) => {
    const db = res.locals.db;
    const { title, discipline, section, author_mode, pen_name, content, value_note, agree } = req.body;

    if (!title || !discipline || !section || !content || !agree) {
      return res.render('submit', {
        error: '请完整填写必填项后再提交。',
        sections: SECTIONS,
        form: req.body,
        memberHint: req.session.user ? '该稿件会自动归入你的会员工作台。' : null,
      });
    }

    const year = new Date().getFullYear();
    const [rows] = await db.execute(
      'SELECT submission_no FROM manuscripts WHERE submission_no LIKE ? ORDER BY submission_no DESC LIMIT 1',
      [`NRR-${year}-%`]
    );
    let seq = 1;
    if (rows.length > 0) {
      const last = parseInt(rows[0].submission_no.split('-').pop(), 10);
      if (!isNaN(last)) seq = last + 1;
    }
    const submission_no = `NRR-${year}-${String(seq).padStart(3, '0')}`;

    const userId = req.session.user ? req.session.user.id : null;
    await db.execute(
      `INSERT INTO manuscripts (submission_no, title, discipline, section, author_mode, pen_name, user_id, content, value_note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        submission_no,
        title.trim(),
        discipline.trim(),
        section,
        author_mode || 'anonymous',
        pen_name || null,
        userId,
        content.trim(),
        value_note || null
      ]
    );

    if (userId) {
      await createNotification(db, userId, '投稿已提交', `稿件 ${submission_no} 已进入编辑队列。你可以在会员工作台持续跟踪状态。`, '/me');
    }

    res.redirect(`/submit?success=1&no=${encodeURIComponent(submission_no)}`);
  }));

  router.get('/track', (req, res) => {
    res.render('track', { result: null, query: req.query.no || '' });
  });

  router.post('/track', csrfCheck, wrap(async (req, res) => {
    const db = res.locals.db;
    let no = (req.body.submission_no || '').trim();
    if (!no) return res.render('track', { result: null, query: '', error: '请输入稿件编号。' });

    if (/^\d{1,4}$/.test(no)) {
      const year = new Date().getFullYear();
      no = `NRR-${year}-${no.padStart(3, '0')}`;
    }

    const [rows] = await db.execute(
      `SELECT submission_no, title, section, status, risk_level, desensitized_status,
              editor_note, created_at, updated_at, published_at
       FROM manuscripts WHERE submission_no = ?`, [no]
    );

    if (rows.length === 0) {
      return res.render('track', { result: null, query: no, error: '没有找到对应稿件，请检查编号是否正确，例如 NRR-2026-001 或 001。' });
    }

    const ms = rows[0];
    const statusMap = {
      pending: '待审',
      under_review: '审核中',
      revision: '退修',
      accepted: '已录用',
      rejected: '已拒稿',
      published: '已发布',
      archived: '已归档'
    };

    res.render('track', {
      result: {
        no: ms.submission_no,
        title: ms.title,
        section: ms.section,
        status: ms.status,
        statusText: statusMap[ms.status] || ms.status,
        editorNote: ms.status === 'revision' ? ms.editor_note : null,
        createdAt: ms.created_at,
        updatedAt: ms.updated_at,
        publishedAt: ms.published_at,
      },
      query: no,
    });
  }));

  router.get('/about', (req, res) => res.render('about'));

  router.get('/article/:id', wrap(async (req, res) => {
    const db = res.locals.db;
    const [rows] = await db.execute(
      `SELECT * FROM manuscripts WHERE id = ? AND status IN ('published','archived')`, [req.params.id]
    );
    if (rows.length === 0) {
      return res.status(404).render('error', { code: 404, title: '文章不存在', message: '你访问的文章不存在或尚未公开。' });
    }

    const article = rows[0];
    db.execute('UPDATE manuscripts SET view_count = view_count + 1 WHERE id = ?', [req.params.id]).catch(() => {});

    const [comments] = await db.execute(
      'SELECT id, nickname, content, created_at FROM comments WHERE article_id = ? ORDER BY created_at ASC', [req.params.id]
    );

    const tags = (article.tags || '').split(',').map(t => t.trim()).filter(Boolean);
    let related = [];
    if (tags.length > 0) {
      const tagConditions = tags.map(() => 'tags LIKE ?').join(' OR ');
      const tagParams = tags.map(t => `%${t}%`);
      const [relRows] = await db.execute(
        `SELECT id, title, section, published_at, view_count FROM manuscripts
         WHERE status IN ('published','archived') AND id != ? AND (section = ? OR ${tagConditions})
         ORDER BY published_at DESC LIMIT 4`,
        [article.id, article.section, ...tagParams]
      );
      related = relRows;
    }
    if (related.length < 3) {
      const excludeIds = [article.id, ...related.map(r => r.id)];
      const placeholders = excludeIds.map(() => '?').join(',');
      const [moreRows] = await db.execute(
        `SELECT id, title, section, published_at, view_count FROM manuscripts
         WHERE status IN ('published','archived') AND id NOT IN (${placeholders})
         ORDER BY published_at DESC LIMIT ?`,
        [...excludeIds, 4 - related.length]
      );
      related = [...related, ...moreRows].slice(0, 4);
    }

    let isFavorited = false;
    if (req.session.user) {
      const [[fav]] = await db.execute(
        'SELECT COUNT(*) AS c FROM favorites WHERE user_id = ? AND article_id = ?',
        [req.session.user.id, article.id]
      );
      isFavorited = Number(fav.c || 0) > 0;
    }

    const readingTime = estimateReadingTime(article.content);
    res.render('article', { article, comments, related, readingTime, isFavorited });
  }));

  router.post('/article/:id/comment', csrfCheck, wrap(async (req, res) => {
    const db = res.locals.db;
    const { nickname, content } = req.body;
    if (!content || content.trim().length < 2) {
      return res.redirect(`/article/${req.params.id}#comments`);
    }
    const safeName = (nickname || '').trim() || (req.session.user ? req.session.user.display_name : '匿名读者');
    await db.execute(
      'INSERT INTO comments (article_id, nickname, content) VALUES (?, ?, ?)',
      [req.params.id, safeName.substring(0, 100), content.trim().substring(0, 2000)]
    );
    res.redirect(`/article/${req.params.id}#comments`);
  }));

  router.post('/article/:id/favorite', requireMember, csrfCheck, wrap(async (req, res) => {
    const db = res.locals.db;
    const userId = req.session.user.id;
    const articleId = Number(req.params.id);
    const [[exists]] = await db.execute(
      'SELECT id FROM favorites WHERE user_id = ? AND article_id = ?',
      [userId, articleId]
    );
    if (exists && exists.id) {
      await db.execute('DELETE FROM favorites WHERE id = ?', [exists.id]);
    } else {
      await db.execute('INSERT INTO favorites (user_id, article_id) VALUES (?, ?)', [userId, articleId]);
    }
    res.redirect(`/article/${articleId}`);
  }));

  router.get('/archive', wrap(async (req, res) => {
    const db = res.locals.db;
    const { section, year, featured, q } = req.query;
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);

    let countSql = `SELECT COUNT(*) as c FROM manuscripts WHERE status IN ('published','archived')`;
    let sql = `SELECT id, submission_no, title, section, author_mode, pen_name,
                      is_featured, is_pinned, is_editor_pick, is_trending, tags, published_at, view_count
               FROM manuscripts WHERE status IN ('published','archived')`;
    const params = [];

    if (section) { const f = ' AND section = ?'; sql += f; countSql += f; params.push(section); }
    if (year) { const f = ' AND YEAR(published_at) = ?'; sql += f; countSql += f; params.push(year); }
    if (featured === '1') { const f = ' AND is_featured = 1'; sql += f; countSql += f; }
    if (q) {
      const f = ' AND (title LIKE ? OR discipline LIKE ? OR content LIKE ? OR tags LIKE ?)';
      sql += f; countSql += f;
      params.push('%' + q + '%', '%' + q + '%', '%' + q + '%', '%' + q + '%');
    }

    const [[{ c: total }]] = await db.execute(countSql, params);
    const totalPages = Math.ceil(Number(total) / PER_PAGE_PUBLIC) || 1;

    sql += ' ORDER BY is_pinned DESC, published_at DESC LIMIT ? OFFSET ?';
    const [articles] = await db.execute(sql, [...params, PER_PAGE_PUBLIC, (page - 1) * PER_PAGE_PUBLIC]);

    const [yearRows] = await db.execute(
      `SELECT DISTINCT YEAR(published_at) as y FROM manuscripts
       WHERE status IN ('published','archived') AND published_at IS NOT NULL ORDER BY y DESC`
    );

    res.render('archive', {
      articles,
      sections: SECTIONS,
      years: yearRows.map(r => String(r.y)),
      filters: { section, year, featured, q },
      page,
      totalPages,
    });
  }));

  router.get('/rss', wrap(async (req, res) => {
    const db = res.locals.db;
    const [articles] = await db.execute(
      `SELECT id, submission_no, title, section, content, published_at
       FROM manuscripts WHERE status = 'published' ORDER BY published_at DESC LIMIT 20`
    );

    const host = req.protocol + '://' + req.get('host');
    let xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
    xml += '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">\n<channel>\n';
    xml += '  <title>负结果通讯 Negative Results Review</title>\n';
    xml += '  <link>' + host + '</link>\n';
    xml += '  <description>记录科研中不被看见的那部分</description>\n';
    xml += '  <language>zh-CN</language>\n';
    xml += '  <atom:link href="' + host + '/rss" rel="self" type="application/rss+xml"/>\n';

    for (const a of articles) {
      const excerpt = (a.content || '').substring(0, 300).replace(/[<>&"]/g, c =>
        ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c])
      );
      xml += '  <item>\n';
      xml += '    <title>' + a.title.replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c])) + '</title>\n';
      xml += '    <link>' + host + '/article/' + a.id + '</link>\n';
      xml += '    <guid>' + host + '/article/' + a.id + '</guid>\n';
      xml += '    <description>' + excerpt + '...</description>\n';
      xml += '    <category>' + a.section + '</category>\n';
      if (a.published_at) xml += '    <pubDate>' + new Date(a.published_at).toUTCString() + '</pubDate>\n';
      xml += '  </item>\n';
    }
    xml += '</channel>\n</rss>';

    res.set('Content-Type', 'application/rss+xml; charset=utf-8');
    res.send(xml);
  }));

  return router;
};
