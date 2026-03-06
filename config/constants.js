const SECTIONS = [
  '负结果档案', '废稿回收站', '方法翻车实录',
  'Reviewer 鬼话档案', '选题尸检报告', '学术情绪标本室', '年度学术垃圾奖'
];

const STATUSES = ['pending', 'under_review', 'revision', 'accepted', 'rejected', 'published', 'archived'];

const STATUS_LABELS = {
  pending: '待审', under_review: '审核中', revision: '退修',
  accepted: '已录用', rejected: '已拒稿', published: '已发布', archived: '已归档'
};

const RISK_LABELS = { low: '低', medium: '中', high: '高' };

const ROLES = { admin: '超级管理员', editor: '编辑', reviewer: '审核员' };

const PER_PAGE_PUBLIC = 10;
const PER_PAGE_ADMIN = 15;

function estimateReadingTime(text) {
  if (!text) return 1;
  const cjkChars = (text.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) || []).length;
  const words = text.replace(/[\u4e00-\u9fff\u3400-\u4dbf]/g, '').split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.ceil((cjkChars / 400) + (words / 200)));
}

module.exports = {
  SECTIONS, STATUSES, STATUS_LABELS, RISK_LABELS, ROLES,
  PER_PAGE_PUBLIC, PER_PAGE_ADMIN, estimateReadingTime
};
