const KEYWORD_TAGS = [
  '选题', '文献综述', '沉没成本', '负结果', 'p值', '实验设计', '学术写作', '田野调查', '真实性',
  '同行评审', '审稿意见', '研究生', '拒稿', '投稿经历', '学术坚持', '统计显著性', '学术诚信',
  '问卷设计', '预测试', '方法论', '导师沟通', '科研情绪', '实验室', '审稿矛盾', '失败经过',
  '反思', '方法', '结果', '讨论', '补记', '教训', '建议'
];

const HEADING_PATTERNS = [
  /^(摘要|导语|背景|研究背景|方法|实验方法|过程|失败经过|结果|讨论|反思|补记|附记|教训|建议|结语|后记|编辑说明)[：:]?$/,
  /^[一二三四五六七八九十]+[、.．].+$/,
  /^\d+[、.．].+$/,
];

function normalizeText(text) {
  return String(text || '')
    .replace(/\r\n/g, '\n')
    .replace(/\u00a0/g, ' ')
    .replace(/[\t ]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function splitLongParagraph(paragraph) {
  if (paragraph.length <= 180) return [paragraph];
  const parts = [];
  let remaining = paragraph.trim();
  while (remaining.length > 180) {
    const slice = remaining.slice(0, 140);
    const punctuationIndexes = ['。', '！', '？', ';', '；'].map(mark => slice.lastIndexOf(mark));
    const cutIndex = Math.max(...punctuationIndexes);
    if (cutIndex < 50) break;
    parts.push(remaining.slice(0, cutIndex + 1).trim());
    remaining = remaining.slice(cutIndex + 1).trim();
  }
  if (remaining) parts.push(remaining);
  return parts;
}

function toHeading(line) {
  const clean = line.replace(/[：:]$/, '').trim();
  if (HEADING_PATTERNS[0].test(line)) return `## ${clean}`;
  if (/^[一二三四五六七八九十]+[、.．]/.test(line)) return `## ${clean.replace(/^[一二三四五六七八九十]+[、.．]\s*/, '')}`;
  if (/^\d+[、.．]/.test(line) && clean.length < 28) return `## ${clean.replace(/^\d+[、.．]\s*/, '')}`;
  return line;
}

function optimizeMarkdownContent(text) {
  const normalized = normalizeText(text);
  if (!normalized) return '';

  const rawBlocks = normalized.split(/\n{2,}/).map(block => block.trim()).filter(Boolean);
  const output = [];

  rawBlocks.forEach(block => {
    const lines = block.split('\n').map(line => line.trim()).filter(Boolean);
    if (!lines.length) return;

    if (lines.length === 1) {
      const single = lines[0];
      if (HEADING_PATTERNS.some(pattern => pattern.test(single)) && single.length <= 32) {
        output.push(toHeading(single));
        return;
      }
      splitLongParagraph(single).forEach(part => output.push(part));
      return;
    }

    const looksLikeList = lines.every(line => /^[-*•]|^\d+[.、]|^[一二三四五六七八九十]+[、.．]/.test(line));
    if (looksLikeList) {
      lines.forEach(line => {
        output.push(line.replace(/^[•]/, '-').replace(/^[一二三四五六七八九十]+[、.．]\s*/, '- '));
      });
      return;
    }

    lines.forEach((line, index) => {
      if (HEADING_PATTERNS.some(pattern => pattern.test(line)) && line.length <= 32) {
        output.push(toHeading(line));
      } else if (/^(审稿意见|邮件原文|原话|编辑备注)[：:]/.test(line)) {
        output.push(`> ${line.replace(/[：:]/, '： ')}`);
      } else if (index === 0 && lines.length > 1 && line.length <= 24 && !/[。！？]$/.test(line)) {
        output.push(`## ${line}`);
      } else {
        splitLongParagraph(line).forEach(part => output.push(part));
      }
    });
  });

  return output.join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
}

function generateExcerpt(text) {
  const normalized = normalizeText(text).replace(/[#>*`\-]/g, '').replace(/\s+/g, ' ');
  if (!normalized) return '';
  return normalized.length > 120 ? `${normalized.slice(0, 120).trim()}…` : normalized;
}

function generateDeck(title, valueNote, content) {
  const note = normalizeText(valueNote);
  if (note) return note.length > 56 ? `${note.slice(0, 56).trim()}…` : note;
  const excerpt = generateExcerpt(content);
  if (!excerpt) return title || '';
  return excerpt.length > 72 ? `${excerpt.slice(0, 72).trim()}…` : excerpt;
}

function suggestTags(section, title, content) {
  const source = `${section || ''} ${title || ''} ${content || ''}`;
  const found = [];
  KEYWORD_TAGS.forEach(tag => {
    if (source.includes(tag) && !found.includes(tag)) found.push(tag);
  });
  if (section && !found.includes(section)) found.unshift(section);
  return found.slice(0, 6);
}

function buildTypographyPackage(payload) {
  const optimizedContent = optimizeMarkdownContent(payload.content || '');
  return {
    optimizedContent,
    excerpt: generateExcerpt(optimizedContent),
    deck: generateDeck(payload.title || '', payload.value_note || '', optimizedContent),
    suggestedTags: suggestTags(payload.section || '', payload.title || '', optimizedContent),
  };
}

module.exports = {
  optimizeMarkdownContent,
  generateExcerpt,
  generateDeck,
  suggestTags,
  buildTypographyPackage,
};
