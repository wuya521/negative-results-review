const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');

async function initDB() {
  const pool = mysql.createPool({
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'nrr',
    waitForConnections: true,
    connectionLimit: 10,
    dateStrings: true,
  });

  await pool.query(`
    CREATE TABLE IF NOT EXISTS admins (
      id            INT AUTO_INCREMENT PRIMARY KEY,
      username      VARCHAR(50) UNIQUE NOT NULL,
      password_hash VARCHAR(255) NOT NULL,
      role          VARCHAR(20) NOT NULL DEFAULT 'admin',
      display_name  VARCHAR(80) DEFAULT '',
      title         VARCHAR(120) DEFAULT '',
      badge_label   VARCHAR(40) DEFAULT '',
      bio           VARCHAR(500) DEFAULT '',
      public_slug   VARCHAR(80) DEFAULT '',
      is_public     TINYINT(1) NOT NULL DEFAULT 1,
      created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id            INT AUTO_INCREMENT PRIMARY KEY,
      email         VARCHAR(120) UNIQUE NOT NULL,
      password_hash VARCHAR(255) NOT NULL,
      display_name  VARCHAR(80) NOT NULL,
      member_tier   VARCHAR(20) NOT NULL DEFAULT 'member',
      bio           VARCHAR(500) DEFAULT '',
      is_active     TINYINT(1) NOT NULL DEFAULT 1,
      created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_login_at DATETIME
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS issues (
      id          INT AUTO_INCREMENT PRIMARY KEY,
      issue_code  VARCHAR(40) UNIQUE NOT NULL,
      issue_label VARCHAR(120) NOT NULL,
      season      VARCHAR(20) DEFAULT '',
      year        INT NOT NULL,
      theme_title VARCHAR(255) DEFAULT '',
      theme_note  TEXT,
      cover_label VARCHAR(120) DEFAULT '',
      lead_admin_id INT,
      co_admin_id INT,
      curator_statement TEXT,
      is_current  TINYINT(1) NOT NULL DEFAULT 0,
      is_active   TINYINT(1) NOT NULL DEFAULT 1,
      created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS manuscripts (
      id                  INT AUTO_INCREMENT PRIMARY KEY,
      submission_no       VARCHAR(32) UNIQUE NOT NULL,
      title               VARCHAR(500) NOT NULL,
      discipline          VARCHAR(100) NOT NULL,
      section             VARCHAR(100) NOT NULL,
      author_mode         VARCHAR(20) NOT NULL DEFAULT 'anonymous',
      pen_name            VARCHAR(100),
      user_id             INT,
      content             MEDIUMTEXT NOT NULL,
      value_note          TEXT,
      issue_id            INT,
      display_title       VARCHAR(500),
      deck                VARCHAR(500) DEFAULT '',
      excerpt             TEXT,
      optimized_content   MEDIUMTEXT,
      published_content   MEDIUMTEXT,
      layout_style        VARCHAR(50) NOT NULL DEFAULT 'journal',
      publication_label   VARCHAR(120) DEFAULT '',
      pdf_enabled         TINYINT(1) NOT NULL DEFAULT 1,
      archive_code        VARCHAR(40) DEFAULT '',
      archive_grade       VARCHAR(20) NOT NULL DEFAULT 'standard',
      curator_note        TEXT,
      curator_admin_id    INT,
      assigned_admin_id   INT,
      internal_note       TEXT,
      status              VARCHAR(20) NOT NULL DEFAULT 'pending',
      risk_level          VARCHAR(10) NOT NULL DEFAULT 'low',
      desensitized_status VARCHAR(20) NOT NULL DEFAULT 'unchecked',
      editor_note         TEXT,
      is_featured         TINYINT(1) NOT NULL DEFAULT 0,
      is_pinned           TINYINT(1) NOT NULL DEFAULT 0,
      is_editor_pick      TINYINT(1) NOT NULL DEFAULT 0,
      is_trending         TINYINT(1) NOT NULL DEFAULT 0,
      tags                VARCHAR(500) DEFAULT '',
      view_count          INT NOT NULL DEFAULT 0,
      is_archived         TINYINT(1) NOT NULL DEFAULT 0,
      created_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      published_at        DATETIME,
      INDEX idx_user_id (user_id),
      INDEX idx_issue_id (issue_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS favorites (
      id         INT AUTO_INCREMENT PRIMARY KEY,
      user_id    INT NOT NULL,
      article_id INT NOT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_user_article (user_id, article_id),
      INDEX idx_favorites_user (user_id),
      INDEX idx_favorites_article (article_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS notifications (
      id         INT AUTO_INCREMENT PRIMARY KEY,
      user_id    INT NOT NULL,
      title      VARCHAR(160) NOT NULL,
      content    TEXT NOT NULL,
      link       VARCHAR(255) DEFAULT '',
      is_read    TINYINT(1) NOT NULL DEFAULT 0,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_notifications_user (user_id),
      INDEX idx_notifications_read (user_id, is_read)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS announcements (
      id                INT AUTO_INCREMENT PRIMARY KEY,
      title             VARCHAR(255) NOT NULL,
      subtitle          VARCHAR(255) DEFAULT '',
      content           TEXT NOT NULL,
      type              VARCHAR(30) NOT NULL DEFAULT 'notice',
      audience          VARCHAR(30) NOT NULL DEFAULT 'all',
      theme             VARCHAR(30) NOT NULL DEFAULT 'archive',
      priority          INT NOT NULL DEFAULT 0,
      is_active         TINYINT(1) NOT NULL DEFAULT 1,
      is_pinned         TINYINT(1) NOT NULL DEFAULT 0,
      is_rotating       TINYINT(1) NOT NULL DEFAULT 1,
      start_at          DATETIME,
      end_at            DATETIME,
      cta_text          VARCHAR(80) DEFAULT '',
      cta_link          VARCHAR(255) DEFAULT '',
      show_on_home      TINYINT(1) NOT NULL DEFAULT 1,
      show_on_dashboard TINYINT(1) NOT NULL DEFAULT 0,
      show_on_article   TINYINT(1) NOT NULL DEFAULT 0,
      impression_count  INT NOT NULL DEFAULT 0,
      click_count       INT NOT NULL DEFAULT 0,
      signature_name    VARCHAR(80) DEFAULT '',
      signature_title   VARCHAR(120) DEFAULT '',
      created_by        INT,
      created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_announcement_active (is_active, start_at, end_at),
      INDEX idx_announcement_priority (priority, is_pinned)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS member_applications (
      id             INT AUTO_INCREMENT PRIMARY KEY,
      user_id        INT NOT NULL,
      requested_tier VARCHAR(20) NOT NULL DEFAULT 'supporter',
      reason         TEXT NOT NULL,
      status         VARCHAR(20) NOT NULL DEFAULT 'pending',
      admin_note     TEXT,
      reviewed_by    INT,
      reviewed_at    DATETIME,
      created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_member_app_user (user_id),
      INDEX idx_member_app_status (status, created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS article_versions (
      id                  INT AUTO_INCREMENT PRIMARY KEY,
      manuscript_id       INT NOT NULL,
      version_type        VARCHAR(30) NOT NULL,
      title               VARCHAR(500) NOT NULL,
      content             MEDIUMTEXT NOT NULL,
      meta_json           JSON,
      created_by_admin_id INT,
      created_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_article_versions (manuscript_id, version_type, created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS comments (
      id         INT AUTO_INCREMENT PRIMARY KEY,
      article_id INT NOT NULL,
      nickname   VARCHAR(100) NOT NULL DEFAULT '匿名读者',
      content    TEXT NOT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_article (article_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS operation_logs (
      id          INT AUTO_INCREMENT PRIMARY KEY,
      admin_id    INT,
      admin_name  VARCHAR(50),
      action      VARCHAR(100) NOT NULL,
      target_type VARCHAR(50),
      target_id   INT,
      details     TEXT,
      created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_target (target_type, target_id),
      INDEX idx_admin (admin_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS sessions (
      session_id VARCHAR(128) NOT NULL PRIMARY KEY,
      expires    INT UNSIGNED NOT NULL,
      data       MEDIUMTEXT,
      INDEX idx_expires (expires)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  const migrations = [
    "ALTER TABLE admins ADD COLUMN role VARCHAR(20) NOT NULL DEFAULT 'admin' AFTER password_hash",
    "ALTER TABLE admins ADD COLUMN display_name VARCHAR(80) DEFAULT '' AFTER role",
    "ALTER TABLE admins ADD COLUMN title VARCHAR(120) DEFAULT '' AFTER display_name",
    "ALTER TABLE admins ADD COLUMN badge_label VARCHAR(40) DEFAULT '' AFTER title",
    "ALTER TABLE admins ADD COLUMN bio VARCHAR(500) DEFAULT '' AFTER badge_label",
    "ALTER TABLE admins ADD COLUMN public_slug VARCHAR(80) DEFAULT '' AFTER bio",
    "ALTER TABLE admins ADD COLUMN is_public TINYINT(1) NOT NULL DEFAULT 1 AFTER public_slug",
    "ALTER TABLE users ADD COLUMN member_tier VARCHAR(20) NOT NULL DEFAULT 'member' AFTER display_name",
    "ALTER TABLE users ADD COLUMN bio VARCHAR(500) DEFAULT '' AFTER member_tier",
    "ALTER TABLE users ADD COLUMN is_active TINYINT(1) NOT NULL DEFAULT 1 AFTER bio",
    "ALTER TABLE users ADD COLUMN last_login_at DATETIME AFTER created_at",
    "ALTER TABLE issues ADD COLUMN lead_admin_id INT AFTER cover_label",
    "ALTER TABLE issues ADD COLUMN co_admin_id INT AFTER lead_admin_id",
    "ALTER TABLE issues ADD COLUMN curator_statement TEXT AFTER co_admin_id",
    "ALTER TABLE manuscripts ADD COLUMN user_id INT AFTER pen_name",
    "ALTER TABLE manuscripts ADD COLUMN is_pinned TINYINT(1) NOT NULL DEFAULT 0 AFTER is_featured",
    "ALTER TABLE manuscripts ADD COLUMN is_editor_pick TINYINT(1) NOT NULL DEFAULT 0 AFTER is_pinned",
    "ALTER TABLE manuscripts ADD COLUMN is_trending TINYINT(1) NOT NULL DEFAULT 0 AFTER is_editor_pick",
    "ALTER TABLE manuscripts ADD COLUMN tags VARCHAR(500) DEFAULT '' AFTER is_trending",
    "ALTER TABLE manuscripts ADD COLUMN view_count INT NOT NULL DEFAULT 0 AFTER tags",
    "ALTER TABLE manuscripts ADD COLUMN issue_id INT AFTER value_note",
    "ALTER TABLE manuscripts ADD COLUMN display_title VARCHAR(500) AFTER issue_id",
    "ALTER TABLE manuscripts ADD COLUMN deck VARCHAR(500) DEFAULT '' AFTER display_title",
    "ALTER TABLE manuscripts ADD COLUMN excerpt TEXT AFTER deck",
    "ALTER TABLE manuscripts ADD COLUMN optimized_content MEDIUMTEXT AFTER excerpt",
    "ALTER TABLE manuscripts ADD COLUMN published_content MEDIUMTEXT AFTER optimized_content",
    "ALTER TABLE manuscripts ADD COLUMN layout_style VARCHAR(50) NOT NULL DEFAULT 'journal' AFTER published_content",
    "ALTER TABLE manuscripts ADD COLUMN publication_label VARCHAR(120) DEFAULT '' AFTER layout_style",
    "ALTER TABLE manuscripts ADD COLUMN pdf_enabled TINYINT(1) NOT NULL DEFAULT 1 AFTER publication_label",
    "ALTER TABLE manuscripts ADD COLUMN archive_code VARCHAR(40) DEFAULT '' AFTER pdf_enabled",
    "ALTER TABLE manuscripts ADD COLUMN archive_grade VARCHAR(20) NOT NULL DEFAULT 'standard' AFTER archive_code",
    "ALTER TABLE manuscripts ADD COLUMN curator_note TEXT AFTER archive_grade",
    "ALTER TABLE manuscripts ADD COLUMN curator_admin_id INT AFTER curator_note",
    "ALTER TABLE manuscripts ADD COLUMN assigned_admin_id INT AFTER curator_admin_id",
    "ALTER TABLE manuscripts ADD COLUMN internal_note TEXT AFTER assigned_admin_id",
    "ALTER TABLE announcements ADD COLUMN signature_name VARCHAR(80) DEFAULT '' AFTER click_count",
    "ALTER TABLE announcements ADD COLUMN signature_title VARCHAR(120) DEFAULT '' AFTER signature_name"
  ];

  for (const sql of migrations) {
    try {
      await pool.query(sql);
    } catch (error) {
      if (error.errno !== 1060) console.error('[DB Migration]', error.message);
    }
  }

  const [adminRows] = await pool.execute('SELECT id FROM admins LIMIT 1');
  if (adminRows.length === 0) {
    const hash = bcrypt.hashSync('admin2026', 10);
    await pool.execute('INSERT INTO admins (username, password_hash, role, display_name, title, badge_label, bio, public_slug, is_public) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', ['admin', hash, 'admin', '???', 'Founding Curator / ???', 'FOUNDING CURATOR', '?????????????????', 'founding-curator', 1]);
    console.log('[DB] 初始化管理员已创建: admin / admin2026');
  }

  const [issueRows] = await pool.execute('SELECT id FROM issues LIMIT 1');
  if (issueRows.length === 0) {
    await pool.execute(
      'INSERT INTO issues (issue_code, issue_label, season, year, theme_title, theme_note, cover_label, is_current, is_active) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ['ISSUE-001', 'ISSUE 001', 'SPRING', 2026, '当 p 值停在 0.05 的门外', '创刊号聚焦那些有价值但未被主流叙事保留的负结果。', '创刊号', 1, 1]
    );
  }

  const [announcementRows] = await pool.execute('SELECT id FROM announcements LIMIT 1');
  if (announcementRows.length === 0) {
    await pool.execute(
      `INSERT INTO announcements
       (title, subtitle, content, type, audience, theme, priority, is_active, is_pinned, is_rotating, start_at, cta_text, cta_link, show_on_home, show_on_dashboard)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), ?, ?, ?, ?)`,
      [
        '创刊号征集进行中',
        '档案馆播报机已启动',
        '本期征集负结果档案、方法翻车实录与被删掉却最真实的研究片段。你可以直接投稿，系统会为内容生成更适合馆藏阅读的排版建议。',
        'editorial',
        'all',
        'archive',
        100,
        1,
        1,
        1,
        '前往投稿',
        '/submit',
        1,
        1
      ]
    );
  }

  const [[{ c: manuscriptCount }]] = await pool.execute('SELECT COUNT(*) AS c FROM manuscripts');
  if (Number(manuscriptCount) === 0) {
    const [[issue]] = await pool.execute('SELECT id FROM issues WHERE is_current = 1 ORDER BY id ASC LIMIT 1');
    const seeds = [
      {
        submission_no: 'NRR-2026-001',
        title: '一种注定失败的选题是如何诞生的',
        discipline: '教育学',
        section: '负结果档案',
        author_mode: 'anonymous',
        pen_name: null,
        content: '选题来自导师的灵光一闪，文献综述来自我的两个通宵，最终结论来自现实的冷酷否定。\n\n那是研一下学期的一次组会，导师在白板上画了一个漂亮的框架。我回去后翻了大量文献，发现这个问题早就被验证过，也早就被证伪过，但我还是带着侥幸心理做了下去。\n\n三个月后，数据分析只花了一个下午。p 值远大于 0.05，效应量几乎为零。真正失败的不是实验，而是我在第一天就忽略的预警信号。',
        value_note: '帮助后来者在选题阶段识别失败信号，减少沉没成本。',
        status: 'published',
        risk_level: 'low',
        desensitized_status: 'passed',
        editor_note: '创刊号头条，适合作为选题失败的典型馆藏。',
        is_featured: 1,
        is_pinned: 1,
        is_editor_pick: 1,
        is_trending: 0,
        tags: '选题,文献综述,沉没成本',
        issue_id: issue ? issue.id : null,
        display_title: '一种注定失败的选题是如何诞生的',
        deck: '选题阶段被忽略的警报，往往比失败数据更早出现。',
        excerpt: '选题失败不是某个夜晚突然发生的，它往往在最初的侥幸里已经成形。',
        published_content: '## 失败起点\n\n选题来自导师的灵光一闪，文献综述来自我的两个通宵，最终结论来自现实的冷酷否定。\n\n## 被忽略的预警\n\n那是研一下学期的一次组会，导师在白板上画了一个漂亮的框架。我回去后翻了大量文献，发现这个问题早就被验证过，也早就被证伪过，但我还是带着侥幸心理做了下去。\n\n## 真正的结论\n\n三个月后，数据分析只花了一个下午。p 值远大于 0.05，效应量几乎为零。真正失败的不是实验，而是我在第一天就忽略的预警信号。',
        layout_style: 'journal',
        publication_label: 'ISSUE 001 / SPRING 2026',
        pdf_enabled: 1,
        published_at: '2026-03-01 09:00:00'
      },
      {
        submission_no: 'NRR-2026-002',
        title: '我把实验做了三个月，结论是没有差异',
        discipline: '心理学',
        section: '负结果档案',
        author_mode: 'anonymous',
        pen_name: null,
        content: '三个月的日夜，换来一句“无显著差异”。但这句话本身，或许就是一种发现。\n\n实验设计是标准化的，样本量也足够，执行过程没有偷工减料。最后得到的结果只是告诉我：我最初的假设并不成立。\n\n阴性结果并不华丽，但它真实，而且足够让后来的人少走弯路。',
        value_note: '说明“无显著差异”同样值得被发表和阅读。',
        status: 'published',
        risk_level: 'low',
        desensitized_status: 'passed',
        editor_note: '阴性结果的典型样本，适合与创刊号主题联动。',
        is_featured: 0,
        is_pinned: 0,
        is_editor_pick: 1,
        is_trending: 1,
        tags: '负结果,p值,实验设计',
        issue_id: issue ? issue.id : null,
        display_title: '我把实验做了三个月，结论是没有差异',
        deck: '“无显著差异”不是空白，而是一种更难被接受的真实。',
        excerpt: '当实验设计足够规整时，没有差异本身也会成为一种发现。',
        published_content: null,
        layout_style: 'journal',
        publication_label: 'ISSUE 001 / SPRING 2026',
        pdf_enabled: 1,
        published_at: '2026-02-25 11:00:00'
      },
      {
        submission_no: 'NRR-2026-003',
        title: 'Reviewer 要我补一个根本无法完成的实验',
        discipline: '生物医学',
        section: 'Reviewer 鬼话档案',
        author_mode: 'anonymous',
        pen_name: null,
        content: '第一轮让我加样本，第二轮让我补对照，第三轮直接建议做一个五年纵向实验。\n\n问题在于，这是一篇硕士论文，而我距离毕业只剩下八个月。\n\n有时候被拒的不是研究，而是你根本不可能满足的结构性要求。',
        value_note: '揭示同行评审中不合理要求的结构性问题。',
        status: 'under_review',
        risk_level: 'medium',
        desensitized_status: 'unchecked',
        editor_note: '待进一步脱敏后可入馆。',
        is_featured: 0,
        is_pinned: 0,
        is_editor_pick: 0,
        is_trending: 0,
        tags: '同行评审,审稿意见,研究生',
        issue_id: issue ? issue.id : null,
        display_title: null,
        deck: '',
        excerpt: '',
        published_content: null,
        layout_style: 'journal',
        publication_label: 'ISSUE 001 / SPRING 2026',
        pdf_enabled: 1,
        published_at: null
      }
    ];

    const sql = `INSERT INTO manuscripts
      (submission_no, title, discipline, section, author_mode, pen_name, content, value_note, issue_id,
       display_title, deck, excerpt, optimized_content, published_content, layout_style, publication_label, pdf_enabled,
       status, risk_level, desensitized_status, editor_note, is_featured, is_pinned, is_editor_pick, is_trending, tags, created_at, updated_at, published_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW(), ?)`;

    for (const seed of seeds) {
      await pool.execute(sql, [
        seed.submission_no,
        seed.title,
        seed.discipline,
        seed.section,
        seed.author_mode,
        seed.pen_name,
        seed.content,
        seed.value_note,
        seed.issue_id,
        seed.display_title,
        seed.deck,
        seed.excerpt,
        seed.published_content,
        seed.published_content,
        seed.layout_style,
        seed.publication_label,
        seed.pdf_enabled,
        seed.status,
        seed.risk_level,
        seed.desensitized_status,
        seed.editor_note,
        seed.is_featured,
        seed.is_pinned,
        seed.is_editor_pick,
        seed.is_trending,
        seed.tags,
        seed.published_at
      ]);
    }
    console.log(`[DB] 已写入 ${seeds.length} 篇种子稿件`);
  }

  return pool;
}

module.exports = { initDB };
