/* 批量导入商品：把 Excel / CSV / 纯文本的多行内容解析成可写入的商品记录
 *
 * 设计取舍（都很关键，改之前先读完）：
 * 1. 优先进「单列模式」：一行就是一整条商品名。摆摊场景最常干的就是「把货单上的名字贴进来」，
 *    而商品名里本来就允许出现逗号（新增商品表单的 placeholder 都写了「可以带逗号」），
 *    所以绝不无条件按逗号切列，否则「手工皂, 柠檬味」会被切成两条错数据。
 * 2. 只有明确的多列信号才切列：制表符（Excel/WPS 复制粘贴的默认分隔符）、竖线 |。
 *    逗号仅在「逗号段数 >= 2 且第一段之后每一段都是纯数字」时才当分隔符，
 *    这样 `手工皂,12.5` 和 `手工皂,12.5,8` 能正确解析，而带逗号的名字不会被误伤。
 * 3. 首行如果是表头（命中关键词），按表头文字定位列，用户不用记列顺序。
 * 4. 分类用 `>` 表示层级（如 `食品>烘焙`），匹配不到就留空并给出提示，绝不静默归到某个分类。
 */

/* 无表头时的默认列顺序，只写名称也能导入 */
const DEFAULT_ORDER = ['name', 'list_price', 'cost_price', 'safety_stock', 'location', 'sku_code', 'category', 'tags'];

/* 表头关键词 → 字段。都是小写比较，中文不区分大小写 */
const HEADER_KEYWORDS = {
  name: ['名称', '商品名', '商品名称', '品名', '商品', '货品', 'name', 'title', 'product'],
  list_price: ['售价', '价格', '单价', '零售价', '卖价', 'price'],
  cost_price: ['成本', '成本价', '进价', '采购价', 'cost'],
  safety_stock: ['安全库存', '预警', '预警值', '库存阈值', '阈值', 'safety'],
  location: ['货位', '位置', '库位', '存放位置', 'location'],
  sku_code: ['sku', '编码', '商品编码', '货号', '条码', 'code'],
  category: ['分类', '类别', '品类', 'category'],
  tags: ['标签', 'tag', 'tags']
};

const HEADER_TOKENS = (() => {
  const map = new Map();
  Object.keys(HEADER_KEYWORDS).forEach(field => {
    HEADER_KEYWORDS[field].forEach(k => map.set(k, field));
  });
  return map;
})();

/* 把「¥12.5」「12.5元」「1,299」这类写法都转成数字；空 → null；非法 → NaN */
function parseNumber(raw) {
  if (raw === null || raw === undefined) return null;
  const s = String(raw)
    .replace(/[¥￥$,\s]/g, '')
    .replace(/元$/, '')
    .trim();
  if (!s) return null;
  if (!/^-?\d+(\.\d+)?$/.test(s)) return NaN;
  return Number(s);
}

function parseCount(raw) {
  const n = parseNumber(raw);
  if (n === null) return 0;
  if (Number.isNaN(n)) return NaN;
  return Math.max(0, Math.trunc(n));
}

function splitCells(line, sep) {
  return line.split(sep).map(s => s.trim());
}

/* 逗号能否当分隔符：段数 >= 2，且第一段之后每段都是纯数字 */
function commaLooksLikeSeparator(line) {
  const parts = line.split(',').map(s => s.trim());
  if (parts.length < 2) return false;
  if (!parts[0]) return false;
  return parts.slice(1).every(p => p !== '' && !Number.isNaN(parseNumber(p)) && parseNumber(p) !== null);
}

/* 探测整篇文本的主分隔符 */
function detectSeparator(lines) {
  const score = { tab: 0, pipe: 0, comma: 0 };
  lines.forEach(line => {
    if (line.includes('\t')) score.tab += 1;
    else if (line.includes('|')) score.pipe += 1;
    else if (commaLooksLikeSeparator(line)) score.comma += 1;
  });
  if (score.tab > 0 && score.tab >= score.pipe) return 'tab';
  if (score.pipe > 0) return 'pipe';
  if (score.comma > 0) return 'comma';
  return 'single';
}

/* 找第一个能识别出字段的表头行索引；找不到返回 -1 */
function findHeaderRow(cellsList) {
  for (let i = 0; i < Math.min(cellsList.length, 3); i += 1) {
    const cells = cellsList[i];
    const hits = cells.filter(c => HEADER_TOKENS.has(String(c).toLowerCase())).length;
    if (hits >= 2) return i;
    /* 单列也允许有表头：首行就是「名称」/「商品名」/「品名」 */
    if (cells.length === 1 && hits === 1 && cells[0].length <= 6) return i;
  }
  return -1;
}

function buildColumnMap(headerCells) {
  const map = {};
  headerCells.forEach((cell, idx) => {
    const field = HEADER_TOKENS.get(String(cell).toLowerCase());
    if (field && map[field] === undefined) map[field] = idx;
  });
  return map;
}

/* 按名字在当前分类树里找分类，支持 `大类>中类`、`大类/中类`；找不到返回 miss
 * 只给一段名字时先找大类，再全局找中类（必须唯一命中，避免歧义） */
export function matchCategoryPath(db, raw) {
  const text = String(raw || '').trim();
  if (!text) return { id: null, label: '', miss: '' };
  const cats = db.categories || [];
  const parts = text.split(/[>＞/／]/).map(s => s.trim()).filter(Boolean);
  if (!parts.length) return { id: null, label: '', miss: '' };

  const roots = cats.filter(c => !c.parent_id);
  const root = roots.find(c => c.name === parts[0]);
  if (root) {
    if (parts.length === 1) return { id: root.id, label: root.name, miss: '' };
    const child = cats.find(c => c.parent_id === root.id && c.name === parts[1]);
    if (child) return { id: child.id, label: root.name + '>' + child.name, miss: '' };
    return { id: root.id, label: root.name, miss: parts[1], missParent: root.name };
  }

  /* 第一段不是大类：可能是用户只写中类名 */
  const hits = cats.filter(c => c.parent_id && c.name === parts[0]);
  if (hits.length === 1) {
    const parent = cats.find(c => c.id === hits[0].parent_id);
    return {
      id: hits[0].id,
      label: (parent ? parent.name + '>' : '') + hits[0].name,
      miss: ''
    };
  }
  return { id: null, label: '', miss: text };
}

function parseTags(raw) {
  const text = String(raw || '').trim();
  if (!text) return [];
  return Array.from(new Set(
    text.split(/[\/／,，]/).map(s => s.trim().replace(/^#/, '')).filter(t => t && t.length <= 10)
  ));
}

/* 主入口：解析整段文本
 * 返回 { rows, okCount, badCount, warnCount, separator, headerSkipped }
 * 每行结构：{ line, name, list_price, cost_price, safety_stock, location, sku_code,
 *            category_id, categoryLabel, categoryRaw, tags, errors:[], warns:[] } */
export function parseProductImport(text, db) {
  const rawLines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
  /* 去掉纯空行，但要保留原始行号，方便用户回头核对 */
  const lines = [];
  rawLines.forEach((content, i) => {
    if (content.trim()) lines.push({ content: content.trim(), no: i + 1 });
  });
  if (!lines.length) {
    return { rows: [], okCount: 0, badCount: 0, warnCount: 0, separator: 'single', headerSkipped: false };
  }

  const separator = detectSeparator(lines.map(l => l.content));
  const sepChar = separator === 'tab' ? '\t' : separator === 'pipe' ? '|' : ',';

  /* 单列模式下每行只有一格，不做逗号切分（保护带逗号的商品名） */
  const cellsList = lines.map(l => (separator === 'single' ? [l.content] : splitCells(l.content, sepChar)));

  const headerIdx = findHeaderRow(cellsList);
  const columnMap = headerIdx >= 0 ? buildColumnMap(cellsList[headerIdx]) : null;
  const order = columnMap ? null : DEFAULT_ORDER;

  const existingSkus = new Set((db.products || []).map(p => String(p.sku_code || '').toUpperCase()).filter(Boolean));
  const existingNames = new Set((db.products || []).map(p => String(p.name || '').trim()));
  const seenSkus = new Set();
  const seenNames = new Set();
  const rows = [];

  lines.forEach((line, idx) => {
    if (idx === headerIdx) return;
    const cells = cellsList[idx];
    const pick = field => {
      const pos = columnMap ? columnMap[field] : order.indexOf(field);
      if (pos === undefined || pos === null || pos < 0) return '';
      return cells[pos] === undefined ? '' : cells[pos];
    };

    const name = String(pick('name') || '').trim();
    const priceRaw = pick('list_price');
    const costRaw = pick('cost_price');
    const safetyRaw = pick('safety_stock');
    const location = String(pick('location') || '').trim();
    const skuRaw = String(pick('sku_code') || '').trim();
    const categoryRaw = String(pick('category') || '').trim();
    const tagsRaw = String(pick('tags') || '').trim();

    const errors = [];
    const warns = [];

    if (!name) errors.push('缺少商品名称');
    else if (existingNames.has(name)) warns.push('库里已有同名商品，导入后会重复');
    else if (seenNames.has(name)) warns.push('本批次内名称重复');
    else seenNames.add(name);

    const list_price = parseNumber(priceRaw);
    if (Number.isNaN(list_price)) errors.push('售价「' + priceRaw + '」不是数字');
    else if (list_price === null) warns.push('未填售价');
    else if (list_price < 0) errors.push('售价不能为负');

    const cost_price = parseNumber(costRaw);
    if (Number.isNaN(cost_price)) errors.push('成本价「' + costRaw + '」不是数字');

    const safety_stock = parseCount(safetyRaw);
    if (Number.isNaN(safety_stock)) errors.push('安全库存「' + safetyRaw + '」不是数字');

    const sku_code = skuRaw;
    if (sku_code) {
      const key = sku_code.toUpperCase();
      if (existingSkus.has(key)) errors.push('SKU「' + sku_code + '」已存在');
      else if (seenSkus.has(key)) errors.push('SKU「' + sku_code + '」在本批次内重复');
      else seenSkus.add(key);
    }

    const cat = matchCategoryPath(db, categoryRaw);
    if (cat.miss) {
      warns.push(cat.missParent
        ? '大类「' + cat.missParent + '」下没有中类「' + cat.miss + '」，将挂在大类'
        : '分类「' + cat.miss + '」不存在，将归入未分类');
    }

    rows.push({
      line: line.no,
      name,
      list_price: list_price === null ? 0 : list_price,
      cost_price: cost_price === null ? '' : cost_price,
      safety_stock,
      location,
      sku_code,
      cat1: cat.id || '',
      cat2: '',
      category_id: cat.id || null,
      categoryLabel: cat.label,
      categoryRaw,
      categoryMiss: cat.miss || '',
      tags: parseTags(tagsRaw),
      errors,
      warns
    });
  });

  const okCount = rows.filter(r => !r.errors.length).length;
  return {
    rows,
    okCount,
    badCount: rows.length - okCount,
    warnCount: rows.filter(r => !r.errors.length && r.warns.length).length,
    separator,
    headerSkipped: headerIdx >= 0
  };
}

/* Excel 工作表矩阵 → TSV 文本，复用上面的解析规则。
   单元格里的制表符/换行会破坏行列结构，先压成空格 */
export function matrixToTsv(matrix) {
  return (matrix || [])
    .map(row => (row || [])
      .map(cell => String(cell === null || cell === undefined ? '' : cell)
        .replace(/\t/g, ' ')
        .replace(/\r?\n/g, ' '))
      .join('\t'))
    .filter(line => line.trim())
    .join('\n');
}

/* 界面里展示解析预览时的示例文本，和解析规则保持一致 */
export const IMPORT_SAMPLE = [
  '手工皂\t18\t6\t5\tA-1\tSOAP01\t洗护>皂类\t手工/送礼',
  '帆布包\t39\t12\t3\tB-2\t\t布艺\t热销'
].join('\n');

export const IMPORT_COLUMNS = [
  { key: 'name', label: '商品名称', required: true, hint: '必填，可以带逗号' },
  { key: 'list_price', label: '售价', hint: '数字，可带 ¥' },
  { key: 'cost_price', label: '成本价', hint: '选填，算毛利用' },
  { key: 'safety_stock', label: '安全库存', hint: '整数，0 表示不预警' },
  { key: 'location', label: '货位', hint: '如 A-1' },
  { key: 'sku_code', label: 'SKU', hint: '留空自动生成' },
  { key: 'category', label: '分类', hint: '大类>中类' },
  { key: 'tags', label: '标签', hint: '多个用 / 分隔' }
];
