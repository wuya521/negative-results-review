const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { requireMember } = require('../middleware/auth');
const { SECTIONS, PER_PAGE_PUBLIC, estimateReadingTime } = require('../config/constants');
const { buildTypographyPackage } = require('../lib/editorial');

const router = express.Router();
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const MEMBER_TIER_LABELS = {
  member: '普通会员',
  supporter: '支持会员',
  contributor: '投稿协作会员',
  editorial: '编辑协作身份',
};

async function createNotification(db, userId, title, content, link) {
  if (!userId) return;
  await db.execute(
    'INSERT INTO notifications (user_id, title, content, link) VALUES (?, ?, ?, ?)',
    [userId, title, content, link || '']
  );
}

function getDashboardFeedback(query) {
  const messages = {
    profile_saved: '账户资料已更新。',
    password_saved: '密码已更新，请妥善保管。',
    application_sent: '会员申请已提交，等待后台审核。',
    notification_read: '通知已标记为已读。',
    notifications_cleared: '所有通知已标记为已读。',
  };
  const errors = {
    profile_invalid: '昵称不能为空，且长度不能超过 80 个字符。',
    password_invalid: '请完整填写密码修改表单。',
    password_mismatch: '两次输入的新密码不一致。',
    password_short: '新密码至少需要 6 位。',
    password_wrong: '旧密码不正确。',
    application_pending: '你已有待处理的会员申请，请等待审核结果。',
    application_invalid: '请填写有效的申请说明。',
    application_same_tier: '你已经是这个会员等级，无需重复申请。',
  };
  return {
    message: messages[query.msg] || null,
    error: errors[query.error] || null,
  };
}

function createSubmitToken(req) {
  req.session.submitToken = crypto.randomBytes(24).toString('hex');
  return req.session.submitToken;
}

function getSubmissionFingerprint(payload) {
  return crypto
    .createHash('sha256')
    .update([
      payload.title,
      payload.discipline,
      payload.section,
      payload.author_mode,
      payload.pen_name,
      payload.content,
      payload.value_note,
    ].map(item => String(item || '').trim().replace(/\s+/g, ' ')).join('\n--nrr--\n'))
    .digest('hex');
}

async function loadCurrentIssue(db) {
  const [rows] = await db.execute(
    'SELECT * FROM issues WHERE is_active = 1 ORDER BY is_current DESC, year DESC, id DESC LIMIT 1'
  );
  return rows[0] || null;
}

function getAudienceList(user) {
  const audiences = ['all'];
  if (!user) {
    audiences.push('guest');
    return audiences;
  }
  audiences.push('member');
  if (user.member_tier) audiences.push(user.member_tier);
  return audiences;
}

async function loadAnnouncements(db, scope, user, limit = 5) {
  const flagMap = {
    home: 'show_on_home',
    dashboard: 'show_on_dashboard',
    article: 'show_on_article',
  };
  const audienceList = getAudienceList(user);
  const placeholders = audienceList.map(() => '?').join(',');
  const [rows] = await db.execute(
    `SELECT * FROM announcements
     WHERE is_active = 1
       AND ${flagMap[scope] || 'show_on_home'} = 1
       AND audience IN (${placeholders})
       AND (start_at IS NULL OR start_at <= NOW())
       AND (end_at IS NULL OR end_at >= NOW())
     ORDER BY is_pinned DESC, priority DESC, created_at DESC
     LIMIT ?`,
    [...audienceList, limit]
  );

  if (rows.length) {
    await db.execute(
      `UPDATE announcements SET impression_count = impression_count + 1 WHERE id IN (${rows.map(() => '?').join(',')})`,
      rows.map(item => item.id)
    ).catch(() => {});
  }
  return rows;
}

function buildSubmitViewModel(req, overrides = {}) {
  const submitToken = overrides.submitToken || req.session.submitToken || createSubmitToken(req);
  return {
    success: overrides.success !== undefined ? overrides.success : req.query.success === '1',
    duplicateDetected: overrides.duplicateDetected !== undefined ? overrides.duplicateDetected : req.query.duplicate === '1',
    submissionNo: overrides.submissionNo !== undefined ? overrides.submissionNo : (req.query.no || null),
    error: overrides.error || null,
    form: overrides.form || {},
    sections: SECTIONS,
    submitToken,
    currentIssue: overrides.currentIssue || null,
    memberHint: req.session.user
      ? '会员投稿会自动归入你的工作台，并附带身份徽章与站内通知。'
      : '登录后投稿可自动归档到会员工作台，便于后续追踪与收藏。',
  };
}

async function loadMemberDashboardData(db, userId) {
  const [[profile]] = await db.execute(
    'SELECT id, email, display_name, member_tier, bio, created_at, last_login_at, is_active FROM users WHERE id = ?',
    [userId]
  );
  const [submissions] = await db.execute(
    `SELECT id, submission_no, title, display_title, section, status, issue_id, created_at, updated_at, published_at
     FROM manuscripts WHERE user_id = ? ORDER BY created_at DESC LIMIT 20`,
    [userId]
  );
  const [favorites] = await db.execute(
    `SELECT m.id, m.title, m.display_title, m.section, m.published_at, f.created_at AS favorited_at
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
  const [applications] = await db.execute(
    `SELECT a.id, a.requested_tier, a.reason, a.status, a.admin_note, a.reviewed_at, a.created_at,
            reviewer.username AS reviewer_name
     FROM member_applications a
     LEFT JOIN admins reviewer ON reviewer.id = a.reviewed_by
     WHERE a.user_id = ?
     ORDER BY a.created_at DESC LIMIT 10`,
    [userId]
  );

  return {
    profile,
    submissions,
    favorites,
    notifications,
    applications,
    canApply: !applications.some(item => item.status === 'pending'),
  };
}

function prepareArticleRecord(article) {
  const renderedTitle = article.display_title || article.title;
  const renderedContent = article.published_content || article.content;
  const renderedDeck = article.deck || article.value_note || '';
  const renderedExcerpt = article.excerpt || (renderedContent || '').replace(/[#>*`\-]/g, '').slice(0, 160);
  return {
    ...article,
    renderedTitle,
    renderedContent,
    renderedDeck,
    renderedExcerpt,
  };
}

module.exports = function (submitLimiter, csrfCheck) {
  router.get('/', wrap(async (req, res) => {
    const db = res.locals.db;
    const [pinned] = await db.execute(
      `SELECT id, submission_no, title, display_title, section, author_mode, pen_name, is_pinned, is_editor_pick, is_trending, is_featured, tags, published_at
       FROM manuscripts WHERE status = 'published' AND is_pinned = 1 ORDER BY published_at DESC LIMIT 3`
    );
    const [articles] = await db.execute(
      `SELECT id, submission_no, title, display_title, deck, excerpt, section, author_mode, pen_name, is_pinned, is_editor_pick, is_trending, is_featured, tags, published_at, view_count
       FROM manuscripts WHERE status = 'published' ORDER BY is_pinned DESC, published_at DESC LIMIT 8`
    );
    const [featured] = await db.execute(
      `SELECT id, submission_no, title, display_title, section, published_at
       FROM manuscripts WHERE status = 'published' AND is_featured = 1 ORDER BY published_at DESC LIMIT 3`
    );
    const broadcasts = await loadAnnouncements(db, 'home', req.session.user, 6);
    const currentIssue = await loadCurrentIssue(db);
    res.render('index', { articles, featured, pinned, sections: SECTIONS, broadcasts, currentIssue });
  }));

  router.get('/broadcasts', wrap(async (req, res) => {
    const db = res.locals.db;
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const audienceList = getAudienceList(req.session.user);
    const placeholders = audienceList.map(() => '?').join(',');
    const [[{ c: total }]] = await db.execute(
      `SELECT COUNT(*) AS c FROM announcements
       WHERE audience IN (${placeholders}) AND is_active = 1`,
      audienceList
    );
    const totalPages = Math.ceil(Number(total) / PER_PAGE_PUBLIC) || 1;
    const [broadcasts] = await db.execute(
      `SELECT * FROM announcements
       WHERE audience IN (${placeholders}) AND is_active = 1
       ORDER BY is_pinned DESC, priority DESC, created_at DESC
       LIMIT ? OFFSET ?`,
      [...audienceList, PER_PAGE_PUBLIC, (page - 1) * PER_PAGE_PUBLIC]
    );
    res.render('broadcasts', { broadcasts, page, totalPages });
  }));

  router.get('/broadcasts/:id', wrap(async (req, res) => {
    const db = res.locals.db;
    const [rows] = await db.execute('SELECT * FROM announcements WHERE id = ? AND is_active = 1 LIMIT 1', [req.params.id]);
    if (!rows.length) {
      return res.status(404).render('error', { code: 404, title: '广播不存在', message: '你访问的广播不存在或已下线。' });
    }
    res.render('broadcast', { broadcast: rows[0] });
  }));

  router.get('/broadcasts/:id/go', wrap(async (req, res) => {
    const db = res.locals.db;
    const [rows] = await db.execute('SELECT id, cta_link FROM announcements WHERE id = ? AND is_active = 1 LIMIT 1', [req.params.id]);
    if (!rows.length) return res.redirect('/broadcasts');
    await db.execute('UPDATE announcements SET click_count = click_count + 1 WHERE id = ?', [req.params.id]).catch(() => {});
    res.redirect(rows[0].cta_link || '/broadcasts');
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

    const normalizedEmail = email.trim().toLowerCase();
    const [exists] = await db.execute('SELECT id FROM users WHERE email = ?', [normalizedEmail]);
    if (exists.length > 0) {
      return res.render('register', { error: '这个邮箱已经注册过。', form, nextUrl: next || '/me' });
    }

    const hash = bcrypt.hashSync(password, 10);
    const displayName = display_name.trim().substring(0, 80);
    const [result] = await db.execute(
      'INSERT INTO users (email, password_hash, display_name, last_login_at) VALUES (?, ?, ?, NOW())',
      [normalizedEmail, hash, displayName]
    );

    req.session.user = {
      id: result.insertId,
      email: normalizedEmail,
      display_name: displayName,
      member_tier: 'member'
    };

    await createNotification(
      db,
      result.insertId,
      '欢迎加入负结果通讯',
      '你的会员工作台已经启用，现在可以收藏文章、保存投稿归属并接收站内通知。',
      '/me'
    );
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

    const normalizedEmail = email.trim().toLowerCase();
    const [rows] = await db.execute('SELECT * FROM users WHERE email = ? LIMIT 1', [normalizedEmail]);
    if (rows.length === 0) {
      return res.render('login', { error: '邮箱或密码错误。', form, nextUrl: next || '/me' });
    }

    const user = rows[0];
    if (Number(user.is_active) !== 1) {
      delete req.session.user;
      return res.render('login', { error: '账号已被封禁，请联系管理员。', form, nextUrl: next || '/me' });
    }
    if (!bcrypt.compareSync(password, user.password_hash)) {
      return res.render('login', { error: '邮箱或密码错误。', form, nextUrl: next || '/me' });
    }

    await db.execute('UPDATE users SET last_login_at = NOW() WHERE id = ?', [user.id]);
    req.session.user = {
      id: user.id,
      email: user.email,
      display_name: user.display_name,
      member_tier: user.member_tier || 'member'
    };

    res.redirect(next || '/me');
  }));

  router.get('/logout', (req, res) => {
    delete req.session.user;
    res.redirect('/');
  });

  router.get('/me', requireMember, wrap(async (req, res) => {
    const db = res.locals.db;
    const feedback = getDashboardFeedback(req.query);
    const data = await loadMemberDashboardData(db, req.session.user.id);
    const dashboardAnnouncements = await loadAnnouncements(db, 'dashboard', req.session.user, 4);
    if (data.profile) {
      req.session.user.display_name = data.profile.display_name;
      req.session.user.member_tier = data.profile.member_tier;
    }
    res.render('member-dashboard', {
      ...data,
      feedback,
      memberTierLabels: MEMBER_TIER_LABELS,
      dashboardAnnouncements,
    });
  }));

  router.post('/me/profile', requireMember, csrfCheck, wrap(async (req, res) => {
    const db = res.locals.db;
    const displayName = (req.body.display_name || '').trim();
    const bio = (req.body.bio || '').trim().substring(0, 500);
    if (!displayName || displayName.length > 80) return res.redirect('/me?error=profile_invalid');
    await db.execute('UPDATE users SET display_name = ?, bio = ? WHERE id = ?', [displayName, bio, req.session.user.id]);
    req.session.user.display_name = displayName;
    res.redirect('/me?msg=profile_saved');
  }));

  router.post('/me/password', requireMember, csrfCheck, wrap(async (req, res) => {
    const db = res.locals.db;
    const { old_password, new_password, confirm_password } = req.body;
    if (!old_password || !new_password || !confirm_password) return res.redirect('/me?error=password_invalid');
    if (new_password.length < 6) return res.redirect('/me?error=password_short');
    if (new_password !== confirm_password) return res.redirect('/me?error=password_mismatch');
    const [rows] = await db.execute('SELECT password_hash FROM users WHERE id = ?', [req.session.user.id]);
    if (rows.length === 0 || !bcrypt.compareSync(old_password, rows[0].password_hash)) return res.redirect('/me?error=password_wrong');
    const hash = bcrypt.hashSync(new_password, 10);
    await db.execute('UPDATE users SET password_hash = ? WHERE id = ?', [hash, req.session.user.id]);
    await createNotification(db, req.session.user.id, '账户密码已更新', '你的会员账户密码刚刚被修改。若这不是你本人操作，请立即联系站点管理员。', '/me');
    res.redirect('/me?msg=password_saved');
  }));

  router.post('/me/applications', requireMember, csrfCheck, wrap(async (req, res) => {
    const db = res.locals.db;
    const requestedTier = ['supporter', 'contributor'].includes(req.body.requested_tier) ? req.body.requested_tier : 'supporter';
    const reason = (req.body.reason || '').trim();
    if (reason.length < 12) return res.redirect('/me?error=application_invalid');

    const [[profile]] = await db.execute('SELECT member_tier FROM users WHERE id = ?', [req.session.user.id]);
    if (profile && profile.member_tier === requestedTier) return res.redirect('/me?error=application_same_tier');

    const [[pending]] = await db.execute('SELECT COUNT(*) AS c FROM member_applications WHERE user_id = ? AND status = ?', [req.session.user.id, 'pending']);
    if (Number(pending.c || 0) > 0) return res.redirect('/me?error=application_pending');

    await db.execute('INSERT INTO member_applications (user_id, requested_tier, reason) VALUES (?, ?, ?)', [req.session.user.id, requestedTier, reason.substring(0, 4000)]);
    await createNotification(db, req.session.user.id, '会员申请已提交', '你的会员申请已进入后台审核队列，审核结果会通过站内通知告知。', '/me');
    res.redirect('/me?msg=application_sent');
  }));

  router.post('/notifications/:id/read', requireMember, csrfCheck, wrap(async (req, res) => {
    const db = res.locals.db;
    await db.execute('UPDATE notifications SET is_read = 1 WHERE id = ? AND user_id = ?', [req.params.id, req.session.user.id]);
    res.redirect('/me?msg=notification_read');
  }));

  router.post('/notifications/read-all', requireMember, csrfCheck, wrap(async (req, res) => {
    const db = res.locals.db;
    await db.execute('UPDATE notifications SET is_read = 1 WHERE user_id = ? AND is_read = 0', [req.session.user.id]);
    res.redirect('/me?msg=notifications_cleared');
  }));

  router.get('/submit', wrap(async (req, res) => {
    const db = res.locals.db;
    const submitToken = createSubmitToken(req);
    const currentIssue = await loadCurrentIssue(db);
    res.render('submit', buildSubmitViewModel(req, { submitToken, currentIssue }));
  }));

  router.post('/submit/optimize', csrfCheck, wrap(async (req, res) => {
    const payload = buildTypographyPackage(req.body || {});
    res.json({ ok: true, ...payload });
  }));

  router.post('/submit', submitLimiter, csrfCheck, wrap(async (req, res) => {
    const db = res.locals.db;
    const { title, discipline, section, author_mode, pen_name, content, value_note, agree, submit_token } = req.body;
    const form = { title, discipline, section, author_mode, pen_name, content, value_note, agree };
    const currentIssue = await loadCurrentIssue(db);

    if (!submit_token || submit_token !== req.session.submitToken) {
      return res.status(409).render('submit', buildSubmitViewModel(req, {
        error: '这份投稿表单已经失效。请刷新页面后重新提交，系统已阻止重复投稿。',
        form,
        submitToken: createSubmitToken(req),
        currentIssue,
      }));
    }

    createSubmitToken(req);

    if (!title || !discipline || !section || !content || !agree) {
      return res.render('submit', buildSubmitViewModel(req, {
        error: '请完整填写必填项后再提交。',
        form,
        currentIssue,
      }));
    }

    const cleanedTitle = title.trim();
    const cleanedDiscipline = discipline.trim();
    const cleanedContent = content.trim();
    const cleanedValueNote = (value_note || '').trim();
    const userId = req.session.user ? req.session.user.id : null;

    if (userId) {
      const [duplicates] = await db.execute(
        `SELECT submission_no FROM manuscripts
         WHERE user_id = ? AND title = ? AND content = ?
           AND created_at >= (NOW() - INTERVAL 30 MINUTE)
         ORDER BY id DESC LIMIT 1`,
        [userId, cleanedTitle, cleanedContent]
      );
      if (duplicates.length > 0) {
        return res.redirect(`/submit?success=1&duplicate=1&no=${encodeURIComponent(duplicates[0].submission_no)}`);
      }
    }

    const fingerprint = getSubmissionFingerprint({ title: cleanedTitle, discipline: cleanedDiscipline, section, author_mode, pen_name, content: cleanedContent, value_note: cleanedValueNote });
    const lastSubmission = req.session.lastSubmission || null;
    const submissionActor = userId || `guest:${req.ip}`;
    if (lastSubmission && lastSubmission.fingerprint === fingerprint && lastSubmission.actor === submissionActor && Date.now() - Number(lastSubmission.createdAt || 0) < 15 * 60 * 1000) {
      return res.redirect(`/submit?success=1&duplicate=1&no=${encodeURIComponent(lastSubmission.submissionNo)}`);
    }

    const year = new Date().getFullYear();
    const [rows] = await db.execute('SELECT submission_no FROM manuscripts WHERE submission_no LIKE ? ORDER BY submission_no DESC LIMIT 1', [`NRR-${year}-%`]);
    let seq = 1;
    if (rows.length > 0) {
      const last = parseInt(rows[0].submission_no.split('-').pop(), 10);
      if (!isNaN(last)) seq = last + 1;
    }
    const submissionNo = `NRR-${year}-${String(seq).padStart(3, '0')}`;
    const optimized = buildTypographyPackage({ title: cleanedTitle, section, content: cleanedContent, value_note: cleanedValueNote });

    await db.execute(
      `INSERT INTO manuscripts
       (submission_no, title, discipline, section, author_mode, pen_name, user_id, content, value_note, issue_id, deck, excerpt, optimized_content, layout_style, publication_label)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        submissionNo,
        cleanedTitle,
        cleanedDiscipline,
        section,
        author_mode || 'anonymous',
        pen_name || null,
        userId,
        cleanedContent,
        cleanedValueNote || null,
        currentIssue ? currentIssue.id : null,
        optimized.deck,
        optimized.excerpt,
        optimized.optimizedContent,
        'journal',
        currentIssue ? `${currentIssue.issue_label} / ${currentIssue.season || ''} ${currentIssue.year}`.trim() : ''
      ]
    );

    req.session.lastSubmission = { fingerprint, actor: submissionActor, submissionNo, createdAt: Date.now() };

    if (userId) {
      await createNotification(db, userId, '投稿已提交', `稿件 ${submissionNo} 已进入编辑队列。你可以在会员工作台持续跟踪状态。`, '/me');
    }

    res.redirect(`/submit?success=1&no=${encodeURIComponent(submissionNo)}`);
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
      `SELECT submission_no, title, section, status, risk_level, desensitized_status, editor_note, created_at, updated_at, published_at
       FROM manuscripts WHERE submission_no = ?`,
      [no]
    );

    if (rows.length === 0) {
      return res.render('track', { result: null, query: no, error: '没有找到对应稿件，请检查编号是否正确，例如 NRR-2026-001 或 001。' });
    }

    const ms = rows[0];
    const statusMap = { pending: '待审', under_review: '审核中', revision: '退修', accepted: '已录用', rejected: '已拒稿', published: '已发布', archived: '已归档' };
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
      `SELECT m.*, i.issue_code, i.issue_label, i.season, i.year, i.theme_title
       FROM manuscripts m
       LEFT JOIN issues i ON i.id = m.issue_id
       WHERE m.id = ? AND m.status IN ('published','archived')`,
      [req.params.id]
    );
    if (!rows.length) {
      return res.status(404).render('error', { code: 404, title: '文章不存在', message: '你访问的文章不存在或尚未公开。' });
    }

    const article = prepareArticleRecord(rows[0]);
    db.execute('UPDATE manuscripts SET view_count = view_count + 1 WHERE id = ?', [req.params.id]).catch(() => {});
    const [comments] = await db.execute('SELECT id, nickname, content, created_at FROM comments WHERE article_id = ? ORDER BY created_at ASC', [req.params.id]);
    const tags = (article.tags || '').split(',').map(t => t.trim()).filter(Boolean);
    let related = [];
    if (tags.length > 0) {
      const tagConditions = tags.map(() => 'tags LIKE ?').join(' OR ');
      const tagParams = tags.map(t => `%${t}%`);
      const [relRows] = await db.execute(
        `SELECT id, title, display_title, section, published_at, view_count FROM manuscripts
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
        `SELECT id, title, display_title, section, published_at, view_count FROM manuscripts
         WHERE status IN ('published','archived') AND id NOT IN (${placeholders})
         ORDER BY published_at DESC LIMIT ?`,
        [...excludeIds, 4 - related.length]
      );
      related = [...related, ...moreRows].slice(0, 4);
    }

    let isFavorited = false;
    if (req.session.user) {
      const [[fav]] = await db.execute('SELECT COUNT(*) AS c FROM favorites WHERE user_id = ? AND article_id = ?', [req.session.user.id, article.id]);
      isFavorited = Number(fav.c || 0) > 0;
    }
    const articleAnnouncements = await loadAnnouncements(db, 'article', req.session.user, 2);
    res.render('article', { article, comments, related, readingTime: estimateReadingTime(article.renderedContent), isFavorited, articleAnnouncements });
  }));

  router.get('/article/:id/print', wrap(async (req, res) => {
    const db = res.locals.db;
    const [rows] = await db.execute(
      `SELECT m.*, i.issue_code, i.issue_label, i.season, i.year, i.theme_title, i.cover_label
       FROM manuscripts m
       LEFT JOIN issues i ON i.id = m.issue_id
       WHERE m.id = ? AND m.status IN ('published','archived')`,
      [req.params.id]
    );
    if (!rows.length) {
      return res.status(404).render('error', { code: 404, title: '馆藏版不存在', message: '该馆藏版尚未开放。' });
    }
    const article = prepareArticleRecord(rows[0]);
    res.render('article-print', { article, readingTime: estimateReadingTime(article.renderedContent) });
  }));

  router.get('/article/:id/pdf', (req, res) => {
    res.redirect(`/article/${req.params.id}/print?mode=pdf`);
  });

  router.post('/article/:id/comment', csrfCheck, wrap(async (req, res) => {
    const db = res.locals.db;
    const { nickname, content } = req.body;
    if (!content || content.trim().length < 2) return res.redirect(`/article/${req.params.id}#comments`);
    const safeName = (nickname || '').trim() || (req.session.user ? req.session.user.display_name : '匿名读者');
    await db.execute('INSERT INTO comments (article_id, nickname, content) VALUES (?, ?, ?)', [req.params.id, safeName.substring(0, 100), content.trim().substring(0, 2000)]);
    res.redirect(`/article/${req.params.id}#comments`);
  }));

  router.post('/article/:id/favorite', requireMember, csrfCheck, wrap(async (req, res) => {
    const db = res.locals.db;
    const userId = req.session.user.id;
    const articleId = Number(req.params.id);
    const [[exists]] = await db.execute('SELECT id FROM favorites WHERE user_id = ? AND article_id = ?', [userId, articleId]);
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
    let sql = `SELECT id, submission_no, title, display_title, deck, excerpt, section, author_mode, pen_name,
                      is_featured, is_pinned, is_editor_pick, is_trending, tags, published_at, view_count
               FROM manuscripts WHERE status IN ('published','archived')`;
    const params = [];
    if (section) { const filter = ' AND section = ?'; sql += filter; countSql += filter; params.push(section); }
    if (year) { const filter = ' AND YEAR(published_at) = ?'; sql += filter; countSql += filter; params.push(year); }
    if (featured === '1') { const filter = ' AND is_featured = 1'; sql += filter; countSql += filter; }
    if (q) {
      const filter = ' AND (title LIKE ? OR discipline LIKE ? OR content LIKE ? OR tags LIKE ? OR excerpt LIKE ?)';
      sql += filter;
      countSql += filter;
      params.push('%' + q + '%', '%' + q + '%', '%' + q + '%', '%' + q + '%', '%' + q + '%');
    }
    const [[{ c: total }]] = await db.execute(countSql, params);
    const totalPages = Math.ceil(Number(total) / PER_PAGE_PUBLIC) || 1;
    sql += ' ORDER BY is_pinned DESC, published_at DESC LIMIT ? OFFSET ?';
    const [articles] = await db.execute(sql, [...params, PER_PAGE_PUBLIC, (page - 1) * PER_PAGE_PUBLIC]);
    const [yearRows] = await db.execute(`SELECT DISTINCT YEAR(published_at) as y FROM manuscripts WHERE status IN ('published','archived') AND published_at IS NOT NULL ORDER BY y DESC`);
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
      `SELECT id, submission_no, title, display_title, section, published_content, content, published_at
       FROM manuscripts WHERE status = 'published' ORDER BY published_at DESC LIMIT 20`
    );
    const host = req.protocol + '://' + req.get('host');
    let xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
    xml += '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">\n<channel>\n';
    xml += '  <title>负结果通讯 Negative Results Review</title>\n';
    xml += `  <link>${host}</link>\n`;
    xml += '  <description>记录科研中不被看见的那部分</description>\n';
    xml += '  <language>zh-CN</language>\n';
    xml += `  <atom:link href="${host}/rss" rel="self" type="application/rss+xml"/>\n`;
    for (const item of articles) {
      const source = item.published_content || item.content || '';
      const excerpt = source.substring(0, 300).replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
      xml += '  <item>\n';
      xml += `    <title>${(item.display_title || item.title).replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]))}</title>\n`;
      xml += `    <link>${host}/article/${item.id}</link>\n`;
      xml += `    <guid>${host}/article/${item.id}</guid>\n`;
      xml += `    <description>${excerpt}...</description>\n`;
      xml += `    <category>${item.section}</category>\n`;
      if (item.published_at) xml += `    <pubDate>${new Date(item.published_at).toUTCString()}</pubDate>\n`;
      xml += '  </item>\n';
    }
    xml += '</channel>\n</rss>';
    res.set('Content-Type', 'application/rss+xml; charset=utf-8');
    res.send(xml);
  }));

  return router;
};
