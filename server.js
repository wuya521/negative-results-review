require('dotenv').config();
const express = require('express');
const session = require('express-session');
const MySQLStore = require('express-mysql-session')(session);
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const path = require('path');
const { initDB } = require('./db/init');
const { STATUS_LABELS, RISK_LABELS, SECTIONS, STATUSES, estimateReadingTime } = require('./config/constants');

const app = express();
const PORT = process.env.PORT || 3000;

app.set('trust proxy', 1);

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));
app.use(express.json({ limit: '2mb' }));

const submitLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, max: 5,
  message: '<h1>提交过于频繁</h1><p>每小时最多投稿 5 次，请稍后再试。</p><a href="/submit">返回投稿</a>',
  standardHeaders: true, legacyHeaders: false,
});

function csrfCheck(req, res, next) {
  const token = req.body._csrf || req.headers['x-csrf-token'];
  if (!token || token !== req.session.csrf) {
    return res.status(403).render('error', {
      code: 403, title: '表单已过期',
      message: '请返回上一页重试。这通常是因为页面停留时间过长。',
    });
  }
  next();
}

async function start() {
  const pool = await initDB();

  const sessionStore = new MySQLStore({
    clearExpired: true, checkExpirationInterval: 900000,
    createDatabaseTable: false,
    schema: { tableName: 'sessions', columnNames: { session_id: 'session_id', expires: 'expires', data: 'data' } },
  }, pool);

  app.use(session({
    store: sessionStore,
    secret: process.env.SESSION_SECRET || 'fallback-secret-change-me',
    resave: false, saveUninitialized: false,
    cookie: { maxAge: 1000 * 60 * 60 * 8 }
  }));

  app.use((req, res, next) => {
    if (req.method === 'GET') {
      if (!req.session.csrf) req.session.csrf = crypto.randomBytes(24).toString('hex');
    }
    res.locals.csrfToken = req.session.csrf || '';
    next();
  });

  app.use((req, res, next) => {
    res.locals.db = pool;
    res.locals.csrfCheck = csrfCheck;
    res.locals.currentPath = req.path;
    res.locals.formatContent = function (text) {
      if (!text) return '';
      const esc = text.replace(/&/g, '&amp;').replace(/</g, '&lt;')
                       .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
      return esc.split(/\n\n+/).map(p => '<p>' + p.replace(/\n/g, '<br>') + '</p>').join('');
    };
    res.locals.statusLabel = function (s) { return STATUS_LABELS[s] || s; };
    res.locals.riskLabel = function (r) { return RISK_LABELS[r] || r; };
    res.locals.parseTags = function (t) {
      if (!t) return [];
      return t.split(',').map(s => s.trim()).filter(Boolean);
    };
    res.locals.estimateReadingTime = estimateReadingTime;
    res.locals.sections = SECTIONS;
    res.locals.statuses = STATUSES;
    next();
  });

  app.use('/', require('./routes/public')(submitLimiter, csrfCheck));
  app.use('/admin', require('./routes/admin')(csrfCheck));

  app.use((req, res) => {
    res.status(404).render('error', {
      code: 404, title: '页面不存在',
      message: '你访问的页面不存在，可能已被移动或删除。',
    });
  });

  app.use((err, req, res, next) => {
    console.error(err);
    res.status(500).render('error', {
      code: 500, title: '服务器内部错误',
      message: '服务器遇到了意外错误，请稍后再试。',
    });
  });

  app.listen(PORT, () => {
    console.log('负结果通讯 — 编辑部系统已启动');
    console.log(`前台: http://localhost:${PORT}`);
    console.log(`后台: http://localhost:${PORT}/admin`);
    console.log('默认管理员: admin / admin2026');
  });
}

start().catch(err => { console.error('启动失败:', err.message); process.exit(1); });
