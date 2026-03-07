const SECTIONS = [
  '负结果档案',
  '废稿回收站',
  '方法翻车实录',
  'Reviewer 鬼话档案',
  '选题尸检报告',
  '学术情绪标本室'
];

const STATUSES = ['pending', 'under_review', 'revision', 'accepted', 'rejected', 'published', 'archived'];

const STATUS_LABELS = {
  pending: '待审',
  under_review: '审核中',
  revision: '退修',
  accepted: '已录用',
  rejected: '已拒稿',
  published: '已发布',
  archived: '已归档',
};

const RISK_LABELS = {
  low: '低',
  medium: '中',
  high: '高',
};

const ROLES = {
  admin: '创馆人',
  co_curator: '联合馆长',
  editor: '编辑策展',
  reviewer: '审稿',
};

const ARCHIVE_GRADE_LABELS = {
  standard: '正式馆藏',
  featured: '策展精选',
  dossier: '专题卷宗',
  honor: '荣誉入藏',
};

const PER_PAGE_PUBLIC = 10;
const PER_PAGE_ADMIN = 15;

function estimateReadingTime(text) {
  if (!text) return 1;
  const cjkChars = (text.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) || []).length;
  const words = text.replace(/[\u4e00-\u9fff\u3400-\u4dbf]/g, '').split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.ceil((cjkChars / 400) + (words / 200)));
}

module.exports = {
  SECTIONS,
  STATUSES,
  STATUS_LABELS,
  RISK_LABELS,
  ROLES,
  ARCHIVE_GRADE_LABELS,
  PER_PAGE_PUBLIC,
  PER_PAGE_ADMIN,
  estimateReadingTime,
};
