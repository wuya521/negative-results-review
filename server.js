require('dotenv').config();
const express = require('express');
const session = require('express-session');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const path = require('path');
const { initDB } = require('./db/init');

const app = express();
const PORT = process.env.PORT || 3000;

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.use(session({
  secret: process.env.SESSION_SECRET || 'fallback-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 8 }
}));

// --- CSRF token ---
app.use((req, res, next) => {
  if (req.method === 'GET') {
    if (!req.session.csrf) req.session.csrf = crypto.randomBytes(24).toString('hex');
  }
  res.locals.csrfToken = req.session.csrf || '';
  next();
});

function csrfCheck(req, res, next) {
  const token = req.body._csrf || req.headers['x-csrf-token'];
  if (!token || token !== req.session.csrf) {
    return res.status(403).send('<h1>403</h1><p>表单已过期，请返回重试。</p><a href="javascript:history.back()">返回</a>');
  }
  next();
}

// --- Rate limiting for submissions ---
const submitLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  message: '<h1>提交过于频繁</h1><p>每小时最多投稿 5 次，请稍后再试。</p><a href="/submit">返回投稿</a>',
  standardHeaders: true,
  legacyHeaders: false,
});

async function start() {
  const pool = await initDB();

  app.use((req, res, next) => {
    res.locals.db = pool;
    res.locals.csrfCheck = csrfCheck;
    res.locals.formatContent = function (text) {
      if (!text) return '';
      const esc = text.replace(/&/g, '&amp;').replace(/</g, '&lt;')
                       .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
      return esc.split(/\n\n+/).map(p => '<p>' + p.replace(/\n/g, '<br>') + '</p>').join('');
    };
    res.locals.statusLabel = function (s) {
      const map = { pending:'待审', under_review:'审核中', revision:'退修',
        accepted:'已录用', rejected:'已拒稿', published:'已发布', archived:'已归档' };
      return map[s] || s;
    };
    res.locals.riskLabel = function (r) {
      return { low:'低', medium:'中', high:'高' }[r] || r;
    };
    res.locals.parseTags = function (t) {
      if (!t) return [];
      return t.split(',').map(s => s.trim()).filter(Boolean);
    };
    next();
  });

  app.use('/', require('./routes/public')(submitLimiter, csrfCheck));
  app.use('/admin', require('./routes/admin')(csrfCheck));

  app.use((req, res) => {
    res.status(404).send('<h1>404</h1><p>页面不存在</p><a href="/">返回首页</a>');
  });

  app.use((err, req, res, next) => {
    console.error(err);
    res.status(500).send('<h1>500</h1><p>服务器内部错误</p><a href="/">返回首页</a>');
  });

  app.listen(PORT, () => {
    console.log(`负结果通讯 — 编辑部系统已启动`);
    console.log(`前台: http://localhost:${PORT}`);
    console.log(`后台: http://localhost:${PORT}/admin`);
    console.log(`默认管理员: admin / admin2026`);
  });
}

start().catch(err => {
  console.error('启动失败:', err.message);
  process.exit(1);
});
