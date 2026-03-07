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

  // --- Core Tables ---
  await pool.query(`
    CREATE TABLE IF NOT EXISTS admins (
      id            INT AUTO_INCREMENT PRIMARY KEY,
      username      VARCHAR(50)  UNIQUE NOT NULL,
      password_hash VARCHAR(255) NOT NULL,
      role          VARCHAR(20)  NOT NULL DEFAULT 'admin',
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
    CREATE TABLE IF NOT EXISTS manuscripts (
      id                  INT AUTO_INCREMENT PRIMARY KEY,
      submission_no       VARCHAR(32)  UNIQUE NOT NULL,
      title               VARCHAR(500) NOT NULL,
      discipline          VARCHAR(100) NOT NULL,
      section             VARCHAR(100) NOT NULL,
      author_mode         VARCHAR(20)  NOT NULL DEFAULT 'anonymous',
      pen_name            VARCHAR(100),
      user_id             INT,
      content             TEXT         NOT NULL,
      value_note          TEXT,
      status              VARCHAR(20)  NOT NULL DEFAULT 'pending',
      risk_level          VARCHAR(10)  NOT NULL DEFAULT 'low',
      desensitized_status VARCHAR(20)  NOT NULL DEFAULT 'unchecked',
      editor_note         TEXT,
      is_featured         TINYINT(1)   NOT NULL DEFAULT 0,
      is_pinned           TINYINT(1)   NOT NULL DEFAULT 0,
      is_editor_pick      TINYINT(1)   NOT NULL DEFAULT 0,
      is_trending         TINYINT(1)   NOT NULL DEFAULT 0,
      tags                VARCHAR(500) DEFAULT '',
      view_count          INT          NOT NULL DEFAULT 0,
      is_archived         TINYINT(1)   NOT NULL DEFAULT 0,
      created_at          DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at          DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      published_at        DATETIME,
      INDEX idx_user_id (user_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS favorites (
      id          INT AUTO_INCREMENT PRIMARY KEY,
      user_id     INT NOT NULL,
      article_id  INT NOT NULL,
      created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_user_article (user_id, article_id),
      INDEX idx_favorites_user (user_id),
      INDEX idx_favorites_article (article_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS notifications (
      id          INT AUTO_INCREMENT PRIMARY KEY,
      user_id     INT NOT NULL,
      title       VARCHAR(160) NOT NULL,
      content     TEXT NOT NULL,
      link        VARCHAR(255) DEFAULT '',
      is_read     TINYINT(1) NOT NULL DEFAULT 0,
      created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_notifications_user (user_id),
      INDEX idx_notifications_read (user_id, is_read)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS comments (
      id          INT AUTO_INCREMENT PRIMARY KEY,
      article_id  INT          NOT NULL,
      nickname    VARCHAR(100) NOT NULL DEFAULT '匿名读者',
      content     TEXT         NOT NULL,
      created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_article (article_id),
      FOREIGN KEY (article_id) REFERENCES manuscripts(id) ON DELETE CASCADE
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

  // --- Sessions table (for express-mysql-session) ---
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sessions (
      session_id VARCHAR(128) NOT NULL PRIMARY KEY,
      expires    INT UNSIGNED NOT NULL,
      data       MEDIUMTEXT,
      INDEX idx_expires (expires)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  // --- Migrations for upgrading from older schema ---
  // Uses plain ALTER TABLE (compatible with MySQL 5.7+), catches duplicate column errors
  const migrations = [
    "ALTER TABLE manuscripts ADD COLUMN is_pinned TINYINT(1) NOT NULL DEFAULT 0 AFTER is_featured",
    "ALTER TABLE manuscripts ADD COLUMN is_editor_pick TINYINT(1) NOT NULL DEFAULT 0 AFTER is_pinned",
    "ALTER TABLE manuscripts ADD COLUMN is_trending TINYINT(1) NOT NULL DEFAULT 0 AFTER is_editor_pick",
    "ALTER TABLE manuscripts ADD COLUMN tags VARCHAR(500) DEFAULT '' AFTER is_trending",
    "ALTER TABLE manuscripts ADD COLUMN view_count INT NOT NULL DEFAULT 0 AFTER tags",
    "ALTER TABLE admins ADD COLUMN role VARCHAR(20) NOT NULL DEFAULT 'admin' AFTER password_hash",
    "ALTER TABLE manuscripts ADD COLUMN user_id INT AFTER pen_name",
    "ALTER TABLE users ADD COLUMN member_tier VARCHAR(20) NOT NULL DEFAULT 'member' AFTER display_name",
    "ALTER TABLE users ADD COLUMN bio VARCHAR(500) DEFAULT '' AFTER member_tier",
    "ALTER TABLE users ADD COLUMN is_active TINYINT(1) NOT NULL DEFAULT 1 AFTER bio",
    "ALTER TABLE users ADD COLUMN last_login_at DATETIME AFTER created_at"
  ];
  for (const sql of migrations) {
    try { await pool.query(sql); } catch (e) {
      if (e.errno !== 1060) console.error('[DB Migration]', e.message);
    }
  }
  // --- Seed admin ---
  const [adminRows] = await pool.execute('SELECT id FROM admins LIMIT 1');
  if (adminRows.length === 0) {
    const hash = bcrypt.hashSync('admin2026', 10);
    await pool.execute('INSERT INTO admins (username, password_hash, role) VALUES (?, ?, ?)', ['admin', hash, 'admin']);
    console.log('[DB] 初始管理员已创建: admin / admin2026');
  }

  // --- Seed manuscripts ---
  const [[{ c: msCount }]] = await pool.execute('SELECT COUNT(*) as c FROM manuscripts');
  if (Number(msCount) === 0) {
    const seeds = [
      {
        no:'NRR-2026-001', title:'一种注定失败的选题是如何诞生的',
        disc:'教育学', sec:'负结果档案', mode:'anonymous', pen:null,
        content:'选题来自导师的灵光一闪，文献综述来自我的两个通宵，最终结论来自现实的冷酷否定。回顾整个过程，失败的种子在第一天就已经种下——一个未经充分验证的假设，一份选择性忽略负面文献的综述，以及一种对权威判断的过度信任。\n\n那是研一下学期的一个组会，导师在白板上随手画了一个框架图，说："如果我们用 X 方法去分析 Y 现象，应该能得到 Z 结论。"那一刻，他的眼睛里闪着一种令人信服的光芒——那种光芒，我后来才知道，叫做"没有做过文献综述的自信"。\n\n我当时年轻，对导师的判断深信不疑。两个通宵之后，我找到了大约 40 篇相关论文。其中 35 篇的结论是：这个方向要么已经被做过了，要么有根本性的方法论问题。但我选择性地忽略了这 35 篇。\n\n接下来的三个月，我以近乎虔诚的态度推进着这个选题。最终的数据分析只花了一个下午。p 值远大于 0.05，效果量接近于零。导师的回复只有一行字："那就换个方向吧。"',
        val:'帮助其他研究生在选题阶段识别潜在的失败信号，减少沉没成本。',
        st:'published', risk:'low', desen:'passed',
        note:'典型的选题失败案例，叙述克制真实，有广泛参考价值。建议作为创刊号头条。',
        feat:1, pin:1, pick:1, trend:0, tags:'选题,文献综述,沉没成本',
        arch:0, ca:'2026-02-20 14:30:00', ua:'2026-03-01 09:00:00', pa:'2026-03-01 09:00:00'
      },
      {
        no:'NRR-2026-002', title:'我把实验做了三个月，结论是没有差异',
        disc:'心理学', sec:'负结果档案', mode:'anonymous', pen:null,
        content:'三个月的日夜，换来一句"无显著差异"。但这句话本身，或许就是一种发现——只是没有人愿意为它付版面费。\n\n实验设计是教科书式的：随机分组、双盲处理、充足样本量。一切都按照预注册方案执行。结果？三组被试在所有指标上都没有统计学差异。效果量小到可以忽略。\n\n我反复检查数据，没有录入错误，没有异常值问题。这就是真实的结果。导师看了数据后沉默了很久，最后说了一句："这说明你的实验做得很规范，只是假设不成立。"\n\n"无差异"不是一种被欢迎的结论。但它是一种真实的结论。',
        val:'提示研究者"无显著差异"同样是有价值的发现。',
        st:'published', risk:'low', desen:'passed',
        note:'对负结果的典型叙述，展现了学术出版对阴性结果的系统性偏见。',
        feat:0, pin:0, pick:1, trend:1, tags:'负结果,p值,实验设计',
        arch:0, ca:'2026-02-18 10:15:00', ua:'2026-02-25 11:00:00', pa:'2026-02-25 11:00:00'
      },
      {
        no:'NRR-2026-003', title:'被导师删掉的那一段，才是全文最真实的部分',
        disc:'社会学', sec:'废稿回收站', mode:'pen_name', pen:'田野旁观者',
        content:'学术写作的吊诡之处在于，你必须学会删掉自己最真诚的表达。那些被红笔划去的句子，承载的恰恰是研究者最初的直觉。\n\n导师说："这一段太主观了。"我理解他的意思——学术论文需要客观、克制、去个人化。但那一段写的是我在田野调查中最真实的感受。\n\n删掉它之后，论文变得更"学术"了，但也更空洞了。这就是被删掉的那一段。我把它放在这里，作为一种小小的纪念。',
        val:'反思学术写作中真实表达与规范表达之间的张力。',
        st:'published', risk:'medium', desen:'passed',
        note:'涉及师生关系的写作，已脱敏处理。文字质量好，有文学感。',
        feat:1, pin:0, pick:0, trend:1, tags:'学术写作,田野调查,真实性',
        arch:0, ca:'2026-02-10 16:45:00', ua:'2026-02-18 14:00:00', pa:'2026-02-18 14:00:00'
      },
      {
        no:'NRR-2026-004', title:'Reviewer 要我补一个根本无法完成的实验',
        disc:'生物医学', sec:'Reviewer 鬼话档案', mode:'anonymous', pen:null,
        content:'审稿人建议"补充一个纵向追踪实验"，时间跨度建议为五年。这是第三轮审稿意见。我的毕业期限还剩八个月。\n\n第一轮：增加样本量。我忍了，花了两个月重新收数据。\n第二轮：补充对照组实验。我又忍了，再花两个月。\n第三轮：建议进行五年纵向追踪。\n\n我怀疑审稿人没有意识到这是一篇硕士论文。或者——他完全意识到了。\n\n这篇论文最终没有发出来。不是因为研究不好，而是因为审稿系统中存在一种结构性的不对等。',
        val:'揭示同行评审中不合理要求的系统性问题。',
        st:'published', risk:'medium', desen:'passed',
        note:'已确认脱敏，不涉及具体期刊和审稿人。反映了审稿制度的普遍性问题。',
        feat:0, pin:0, pick:0, trend:0, tags:'同行评审,审稿意见,研究生',
        arch:0, ca:'2026-02-05 09:20:00', ua:'2026-02-10 16:00:00', pa:'2026-02-10 16:00:00'
      },
      {
        no:'NRR-2026-005', title:'那个被拒了七次的稿子，第八次终于放弃了',
        disc:'管理学', sec:'废稿回收站', mode:'anonymous', pen:null,
        content:'不是我不够坚持，而是我终于读懂了拒稿信之间的沉默。七封拒稿信，像七面镜子，映出同一张疲惫的脸。\n\n这篇论文最初写于 2023 年秋天。到第七次投稿时，我已经把原文改得面目全非。它变成了一个四不像——一个被反复修改到失去灵魂的文本。\n\n第八次投稿前，我打开文档，从头读了一遍。然后关掉了电脑。有些东西，放下也是一种选择。',
        val:'记录一篇论文从投稿到放弃的完整历程。',
        st:'published', risk:'low', desen:'passed',
        note:'很有共鸣的投稿经历记录。文字节制有力。',
        feat:0, pin:0, pick:0, trend:0, tags:'拒稿,投稿经历,学术坚持',
        arch:0, ca:'2026-01-28 20:00:00', ua:'2026-02-03 10:00:00', pa:'2026-02-03 10:00:00'
      },
      {
        no:'NRR-2026-006', title:'统计显著性 p=0.07：一个令人窒息的故事',
        disc:'公共卫生', sec:'负结果档案', mode:'real_name', pen:'陈默',
        content:'如果 p 值是一扇门，那 0.07 就是门缝里透出的光——你看得到，但进不去。\n\n所有结果都指向同一个方向：效果存在。效果量是合理的。但 p = 0.07。就是这 0.02 的距离，决定了这篇论文是"有发现"还是"没发现"。\n\n我和导师讨论了很久，最终决定如实报告。我们没有做任何数据清洗来让 p 跌破 0.05。这是一个关于诚实的选择，但它的代价是：这篇论文至今没有发表。\n\n0.05 是一条人为画定的线。在这条线的两侧，数据没有本质区别。但学术出版制度在这条线两侧看到的，是完全不同的故事。',
        val:'探讨 p 值阈值的僵化带来的科研评判困境。',
        st:'published', risk:'low', desen:'passed',
        note:'作者选择实名发表，勇气可嘉。内容具有方法论反思价值。',
        feat:1, pin:0, pick:1, trend:0, tags:'p值,统计显著性,学术诚信',
        arch:0, ca:'2026-01-20 11:30:00', ua:'2026-01-28 15:00:00', pa:'2026-01-28 15:00:00'
      },
      {
        no:'NRR-2026-007', title:'问卷设计中一道歧义题毁掉了整个数据集',
        disc:'传播学', sec:'方法翻车实录', mode:'anonymous', pen:null,
        content:'第 14 题的措辞可以被理解为两种完全相反的意思。我在预测试阶段没有发现这个问题——因为预测试的 15 个人恰好都理解为了同一种含义。\n\n正式施测中，这道题的作答分布呈现出诡异的双峰形态。直到事后访谈，我才发现将近 40% 的被试对题目的理解与我的预设完全不同。\n\n一道歧义题，毁掉了三个月的数据收集。',
        val:'提示研究者在问卷设计中进行充分的预测试。',
        st:'accepted', risk:'low', desen:'passed',
        note:'实用性强的方法教训。可排入下一期。',
        feat:0, pin:0, pick:0, trend:0, tags:'问卷设计,预测试,方法论',
        arch:0, ca:'2026-01-15 14:20:00', ua:'2026-01-22 09:00:00', pa:null
      },
      {
        no:'NRR-2026-008', title:'导师说"这个方向很有潜力"的三种含义',
        disc:'计算机科学', sec:'选题尸检报告', mode:'anonymous', pen:null,
        content:'经过两年的观察和三次选题失败，我终于总结出导师说"这个方向很有潜力"时的三种含义：\n\n第一种：他真的觉得有潜力（概率约 20%）。\n第二种：他没有认真想过，但不想打击你的积极性（概率约 50%）。\n第三种：他正在忙别的事情，随口说的（概率约 30%）。\n\n区分方法：一周后再问一次。如果他记得并且愿意深入讨论，大概是第一种。',
        val:'帮助研究生辨别导师反馈中的真实信息。',
        st:'under_review', risk:'medium', desen:'unchecked',
        note:'有趣但需确认是否有对号入座风险。待脱敏审查。',
        feat:0, pin:0, pick:0, trend:0, tags:'导师沟通,选题',
        arch:0, ca:'2026-01-10 19:45:00', ua:'2026-01-12 10:00:00', pa:null
      },
      {
        no:'NRR-2026-009', title:'在实验室哭过的人不止我一个',
        disc:'化学', sec:'学术情绪标本室', mode:'anonymous', pen:null,
        content:'那天下午，实验第四次失败。培养了两周的细胞因为一次忘记关紫外灯而全部污染。我蹲在超净台旁边，终于哭了出来。\n\n隔壁实验台的师姐递给我一包纸巾，说："我上个月也哭过。"\n\n后来我才知道，实验室里几乎每个人都哭过。只是大家都选择了沉默。',
        val:'为研究生的科研情绪提供共鸣与正常化的参照。',
        st:'pending', risk:'low', desen:'unchecked', note:null,
        feat:0, pin:0, pick:0, trend:0, tags:'科研情绪,实验室',
        arch:0, ca:'2026-03-02 08:30:00', ua:'2026-03-02 08:30:00', pa:null
      },
      {
        no:'NRR-2026-010', title:'一审和二审的意见完全矛盾，编辑让我"综合考虑"',
        disc:'经济学', sec:'Reviewer 鬼话档案', mode:'anonymous', pen:null,
        content:'审稿人 A："文章最大的问题是过于依赖定量方法，建议增加质性分析。"\n审稿人 B："文章最大的问题是质性部分过多，建议删除，集中做定量。"\n编辑回信："请综合考虑两位审稿人的意见进行修改。"\n\n我盯着屏幕看了十分钟，然后给自己泡了一杯茶。有些问题，是没有答案的。',
        val:'记录同行评审中审稿人意见相互矛盾的真实案例。',
        st:'pending', risk:'medium', desen:'unchecked', note:null,
        feat:0, pin:0, pick:0, trend:0, tags:'同行评审,审稿矛盾',
        arch:0, ca:'2026-03-03 12:15:00', ua:'2026-03-03 12:15:00', pa:null
      },
      {
        no:'NRR-2026-011', title:'我用了一年时间证明自己最初的直觉是对的',
        disc:'物理学', sec:'负结果档案', mode:'real_name', pen:'李远',
        content:'一年前，我对导师说："我觉得这个效应在低温环境下不成立。"导师说："你得证明它。"\n\n于是我花了一年时间，最终得出结论：这个效应在低温环境下确实不成立。和我一年前的直觉完全一致。\n\n区别在于，现在我有了数据支撑。但这一年的验证过程无法发表——因为"证明某个效应不存在"在大多数期刊看来，不算一个"发现"。',
        val:'探讨科研中直觉与验证之间的关系。',
        st:'revision', risk:'low', desen:'passed',
        note:'内容有价值，但建议作者补充更多实验细节。',
        feat:0, pin:0, pick:0, trend:0, tags:'科研直觉,负结果',
        arch:0, ca:'2026-02-28 17:00:00', ua:'2026-03-04 14:00:00', pa:null
      },
      {
        no:'NRR-2026-012', title:'那篇写了两万字最终被我自己删掉的论文',
        disc:'哲学', sec:'废稿回收站', mode:'anonymous', pen:null,
        content:'两万字。四个月的周末和深夜。最终，我自己按下了删除键。\n\n不是因为写得不好。是因为在写完之后，我发现自己真正想说的话——那个让我在凌晨三点还睡不着的问题——并没有出现在这两万字里的任何地方。\n\n我写了一篇形式完美的论文，但它不是我想写的那篇。',
        val:'反思学术写作中的沉没成本与自我审查。',
        st:'pending', risk:'low', desen:'unchecked', note:null,
        feat:0, pin:0, pick:0, trend:0, tags:'沉没成本,学术写作',
        arch:0, ca:'2026-03-05 21:00:00', ua:'2026-03-05 21:00:00', pa:null
      }
    ];

    const sql = `INSERT INTO manuscripts
      (submission_no,title,discipline,section,author_mode,pen_name,content,value_note,
       status,risk_level,desensitized_status,editor_note,
       is_featured,is_pinned,is_editor_pick,is_trending,tags,
       is_archived,created_at,updated_at,published_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`;

    for (const s of seeds) {
      await pool.execute(sql, [
        s.no, s.title, s.disc, s.sec, s.mode, s.pen, s.content, s.val,
        s.st, s.risk, s.desen, s.note,
        s.feat, s.pin, s.pick, s.trend, s.tags,
        s.arch, s.ca, s.ua, s.pa
      ]);
    }
    console.log(`[DB] 已写入 ${seeds.length} 篇种子稿件`);
  }

  return pool;
}

module.exports = { initDB };


