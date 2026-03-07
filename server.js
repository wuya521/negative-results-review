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

const MEMBER_TIER_META = {
  member: { label: '普通会员', shortLabel: 'MEMBER', className: 'tier-badge--member' },
  supporter: { label: '支持会员', shortLabel: 'SUPPORTER', className: 'tier-badge--supporter' },
  contributor: { label: '投稿协作会员', shortLabel: 'CONTRIBUTOR', className: 'tier-badge--contributor' },
  editorial: { label: '编辑协作身份', shortLabel: 'EDITORIAL', className: 'tier-badge--editorial' },
};

app.set('trust proxy', 1);
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));
app.use(express.json({ limit: '2mb' }));

let markedLib = null;

async function ensureMarked() {
  if (markedLib) return markedLib;
  const mod = await import('marked');
  markedLib = mod.marked || mod.default || mod;
  markedLib.setOptions({
    gfm: true,
    breaks: true,
    headerIds: false,
    mangle: false,
  });
  return markedLib;
}

const submitLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  message: '<h1>提交过于频繁</h1><p>每小时最多投稿 5 次，请稍后再试。</p><a href="/submit">返回投稿</a>',
  standardHeaders: true,
  legacyHeaders: false,
});

function sanitizeRenderedHtml(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?>[\s\S]*?<\/style>/gi, '')
    .replace(/\son\w+=("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/javascript:/gi, '');
}

function renderMarkdown(text) {
  if (!text) return '';
  if (!markedLib) {
    return String(text).replace(/\n/g, '<br>');
  }
  return sanitizeRenderedHtml(markedLib.parse(String(text)));
}

function csrfCheck(req, res, next) {
  const token = req.body._csrf || req.headers['x-csrf-token'];
  if (!token || token !== req.session.csrf) {
    return res.status(403).render('error', {
      code: 403,
      title: '表单已过期',
      message: '请返回上一页重试。这通常是因为页面停留时间过长。',
    });
  }
  next();
}

function getMemberTierMeta(tier) {
  return MEMBER_TIER_META[tier] || MEMBER_TIER_META.member;
}

async function start() {
  await ensureMarked();
  const pool = await initDB();

  const sessionStore = new MySQLStore({
    clearExpired: true,
    checkExpirationInterval: 900000,
    createDatabaseTable: false,
    schema: { tableName: 'sessions', columnNames: { session_id: 'session_id', expires: 'expires', data: 'data' } },
  }, pool);

  app.use(session({
    store: sessionStore,
    secret: process.env.SESSION_SECRET || 'fallback-secret-change-me',
    resave: false,
    saveUninitialized: false,
    cookie: {
      maxAge: 1000 * 60 * 60 * 8,
      sameSite: 'lax',
      httpOnly: true,
    }
  }));

  app.use((req, res, next) => {
    if (req.method === 'GET' && !req.session.csrf) {
      req.session.csrf = crypto.randomBytes(24).toString('hex');
    }
    res.locals.csrfToken = req.session.csrf || '';
    next();
  });

  app.use((req, res, next) => {
    Promise.resolve().then(async () => {
      res.locals.db = pool;
      res.locals.currentPath = req.path;
      res.locals.currentUser = null;
      res.locals.unreadNotifications = 0;

      if (req.session.user && req.session.user.id) {
        const [userRows] = await pool.execute(
          'SELECT id, email, display_name, member_tier, is_active FROM users WHERE id = ? LIMIT 1',
          [req.session.user.id]
        );

        if (userRows.length > 0 && Number(userRows[0].is_active) === 1) {
          req.session.user = {
            id: userRows[0].id,
            email: userRows[0].email,
            display_name: userRows[0].display_name,
            member_tier: userRows[0].member_tier || 'member'
          };
          res.locals.currentUser = req.session.user;

          const [[row]] = await pool.execute(
            'SELECT COUNT(*) AS c FROM notifications WHERE user_id = ? AND is_read = 0',
            [req.session.user.id]
          );
          res.locals.unreadNotifications = Number(row.c || 0);
        } else {
          delete req.session.user;
        }
      }

      res.locals.formatContent = renderMarkdown;
      res.locals.statusLabel = function (s) { return STATUS_LABELS[s] || s; };
      res.locals.riskLabel = function (r) { return RISK_LABELS[r] || r; };
      res.locals.parseTags = function (t) {
        if (!t) return [];
        return t.split(',').map(s => s.trim()).filter(Boolean);
      };
      res.locals.estimateReadingTime = estimateReadingTime;
      res.locals.memberTierMeta = getMemberTierMeta;
      res.locals.sections = SECTIONS;
      res.locals.statuses = STATUSES;
    }).then(() => next(), next);
  });

  app.use('/', require('./routes/public')(submitLimiter, csrfCheck));
  app.use('/admin', require('./routes/admin')(csrfCheck));

  app.use((req, res) => {
    res.status(404).render('error', {
      code: 404,
      title: '页面不存在',
      message: '你访问的页面不存在，可能已被移动或删除。',
    });
  });

  app.use((err, req, res, next) => {
    console.error(err);
    res.status(500).render('error', {
      code: 500,
      title: '服务器内部错误',
      message: '服务器遇到了意外错误，请稍后再试。',
    });
  });

  app.listen(PORT, () => {
    console.log('负结果通讯 - 站点服务已启动');
    console.log(`前台: http://localhost:${PORT}`);
    console.log(`后台: http://localhost:${PORT}/admin`);
    console.log('默认管理员: admin / admin2026');
  });
}

start().catch(err => {
  console.error('启动失败:', err.message);
  process.exit(1);
});
