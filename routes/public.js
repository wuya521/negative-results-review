const express = require('express');
const router = express.Router();

const SECTIONS = [
  '负结果档案', '废稿回收站', '方法翻车实录',
  'Reviewer 鬼话档案', '选题尸检报告', '学术情绪标本室', '年度学术垃圾奖'
];
const PER_PAGE = 10;

const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

module.exports = function (submitLimiter, csrfCheck) {

  // ---------- Homepage ----------
  router.get('/', wrap(async (req, res) => {
    const db = res.locals.db;
    const [pinned] = await db.execute(
      `SELECT id, submission_no, title, section, author_mode, pen_name, is_pinned, is_editor_pick, is_trending, is_featured, tags, published_at
       FROM manuscripts WHERE status = 'published' AND is_pinned = 1 ORDER BY published_at DESC LIMIT 3`
    );
    const [articles] = await db.execute(
      `SELECT id, submission_no, title, section, author_mode, pen_name, is_pinned, is_editor_pick, is_trending, is_featured, tags, published_at
       FROM manuscripts WHERE status = 'published' ORDER BY is_pinned DESC, published_at DESC LIMIT 8`
    );
    const [featured] = await db.execute(
      `SELECT id, submission_no, title, section, published_at
       FROM manuscripts WHERE status = 'published' AND is_featured = 1 ORDER BY published_at DESC LIMIT 3`
    );
    res.render('index', { articles, featured, pinned, sections: SECTIONS });
  }));

  // ---------- Submit ----------
  router.get('/submit', (req, res) => {
    res.render('submit', {
      success: req.query.success === '1',
      submissionNo: req.query.no || null,
      sections: SECTIONS
    });
  });

  router.post('/submit', submitLimiter, csrfCheck, wrap(async (req, res) => {
    const db = res.locals.db;
    const { title, discipline, section, author_mode, pen_name, content, value_note, agree } = req.body;

    if (!title || !discipline || !section || !content || !agree) {
      return res.render('submit', { error: '请填写所有必填项并勾选声明。', sections: SECTIONS, form: req.body });
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

    await db.execute(
      `INSERT INTO manuscripts (submission_no, title, discipline, section, author_mode, pen_name, content, value_note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [submission_no, title.trim(), discipline.trim(), section, author_mode || 'anonymous', pen_name || null, content.trim(), value_note || null]
    );

    res.redirect(`/submit?success=1&no=${encodeURIComponent(submission_no)}`);
  }));

  // ---------- Track ----------
  router.get('/track', (req, res) => {
    res.render('track', { result: null, query: req.query.no || '' });
  });

  router.post('/track', csrfCheck, wrap(async (req, res) => {
    const db = res.locals.db;
    const no = (req.body.submission_no || '').trim();
    if (!no) return res.render('track', { result: null, query: '', error: '请输入稿件编号' });

    const [rows] = await db.execute(
      `SELECT submission_no, title, section, status, risk_level, desensitized_status,
              editor_note, created_at, updated_at, published_at
       FROM manuscripts WHERE submission_no = ?`, [no]
    );

    if (rows.length === 0) {
      return res.render('track', { result: null, query: no, error: '未找到该编号的稿件，请检查输入' });
    }

    const ms = rows[0];
    const statusMap = {
      pending: '编辑部已收到，等待审阅',
      under_review: '审核中，编辑部正在审阅',
      revision: '退修 — 请根据编辑部意见修改后重新提交',
      accepted: '已录用，等待排期发布',
      rejected: '未通过审核',
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

  // ---------- About ----------
  router.get('/about', (req, res) => res.render('about'));

  // ---------- Article Detail ----------
  router.get('/article/:id', wrap(async (req, res) => {
    const db = res.locals.db;
    const [rows] = await db.execute(
      `SELECT * FROM manuscripts WHERE id = ? AND status IN ('published','archived')`, [req.params.id]
    );
    if (rows.length === 0) return res.status(404).send('<h1>404</h1><p>文章不存在或尚未发布。</p><a href="/">返回首页</a>');
    res.render('article', { article: rows[0] });
  }));

  // ---------- Archive ----------
  router.get('/archive', wrap(async (req, res) => {
    const db = res.locals.db;
    const { section, year, featured, q } = req.query;
    const page = Math.max(1, parseInt(req.query.page) || 1);

    let countSql = `SELECT COUNT(*) as c FROM manuscripts WHERE status IN ('published','archived')`;
    let sql = `SELECT id, submission_no, title, section, author_mode, pen_name,
                      is_featured, is_pinned, is_editor_pick, is_trending, tags, published_at
               FROM manuscripts WHERE status IN ('published','archived')`;
    const params = [];

    if (section)        { const f = ' AND section = ?';    sql += f; countSql += f; params.push(section); }
    if (year)           { const f = ' AND YEAR(published_at) = ?'; sql += f; countSql += f; params.push(year); }
    if (featured === '1') { const f = ' AND is_featured = 1'; sql += f; countSql += f; }
    if (q) {
      const f = ' AND (title LIKE ? OR discipline LIKE ?)';
      sql += f; countSql += f;
      params.push('%' + q + '%', '%' + q + '%');
    }

    const [[{ c: total }]] = await db.execute(countSql, params);
    const totalPages = Math.ceil(Number(total) / PER_PAGE) || 1;

    sql += ' ORDER BY is_pinned DESC, published_at DESC LIMIT ? OFFSET ?';
    const [articles] = await db.execute(sql, [...params, PER_PAGE, (page - 1) * PER_PAGE]);

    const [yearRows] = await db.execute(
      `SELECT DISTINCT YEAR(published_at) as y FROM manuscripts
       WHERE status IN ('published','archived') AND published_at IS NOT NULL ORDER BY y DESC`
    );

    res.render('archive', {
      articles, sections: SECTIONS,
      years: yearRows.map(r => String(r.y)),
      filters: { section, year, featured, q },
      page, totalPages,
    });
  }));

  return router;
};
