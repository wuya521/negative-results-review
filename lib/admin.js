const ROLE_LABELS = {
  admin: '创馆人',
  co_curator: '联合馆长',
  editor: '编辑策展',
  reviewer: '审稿',
};

const PUBLIC_ROLE_TITLES = {
  admin: 'Founding Curator / 创馆人',
  co_curator: 'Co-Curator / 联合馆长',
  editor: 'Editorial Curator / 编辑策展',
  reviewer: 'Review Desk / 审稿席',
};

const CAPABILITY_MAP = {
  admin: new Set(['view_dashboard', 'manage_manuscripts', 'manage_publication', 'manage_announcements', 'view_members', 'review_members', 'manage_member_state', 'manage_admins', 'view_logs']),
  co_curator: new Set(['view_dashboard', 'manage_manuscripts', 'manage_publication', 'manage_announcements', 'view_members', 'review_members', 'view_logs']),
  editor: new Set(['view_dashboard', 'manage_manuscripts', 'manage_announcements']),
  reviewer: new Set(['view_dashboard', 'manage_manuscripts']),
};

const ARCHIVE_GRADE_META = {
  standard: { label: '正式馆藏', stamp: 'ARCHIVE' },
  featured: { label: '策展精选', stamp: 'FEATURED' },
  dossier: { label: '专题卷宗', stamp: 'DOSSIER' },
  honor: { label: '荣誉入藏', stamp: 'HONOR' },
};

function normalizeAdminRole(role) {
  return CAPABILITY_MAP[role] ? role : 'reviewer';
}

function hasCapability(role, capability) {
  return CAPABILITY_MAP[normalizeAdminRole(role)].has(capability);
}

function getAdminRoleLabel(role) {
  return ROLE_LABELS[normalizeAdminRole(role)] || ROLE_LABELS.reviewer;
}

function getPublicRoleTitle(role, fallback) {
  return fallback || PUBLIC_ROLE_TITLES[normalizeAdminRole(role)] || PUBLIC_ROLE_TITLES.reviewer;
}

function getArchiveGradeMeta(grade) {
  return ARCHIVE_GRADE_META[grade] || ARCHIVE_GRADE_META.standard;
}

module.exports = {
  ROLE_LABELS,
  ARCHIVE_GRADE_META,
  normalizeAdminRole,
  hasCapability,
  getAdminRoleLabel,
  getPublicRoleTitle,
  getArchiveGradeMeta,
};
