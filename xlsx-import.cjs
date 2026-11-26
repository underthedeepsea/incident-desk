'use strict';

const { posix } = require('node:path');
const { promisify } = require('node:util');
const { SaxesParser } = require('saxes');
const XLSX = require('xlsx');
const yauzl = require('yauzl');
const D = require('./v2/data.js');

const MiB = 1024 * 1024;
const maxFileBytes = 8 * MiB;
const maxExpandedBytes = 32 * MiB;
const maxEntries = 256;
const maxSheets = 32;
const maxRows = 20_000;
const maxColumns = 256;
const maxTableCells = 200_000;
const maxTextBytes = 8 * MiB;
const maxFormatLength = 256;
const dayMs = 86_400_000;
const spreadsheetNamespaces = new Set([
  'http://schemas.openxmlformats.org/spreadsheetml/2006/main',
  'http://purl.oclc.org/ooxml/spreadsheetml/main'
]);
const relationshipNamespaces = [
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
  'http://purl.oclc.org/ooxml/officeDocument/relationships'
];
const typePrefix = 'application/vnd.openxmlformats-officedocument.spreadsheetml.';
const partRoles = new Map([
  [typePrefix + 'sheet.main+xml', 'workbook'],
  [typePrefix + 'sharedStrings+xml', 'strings'],
  [typePrefix + 'styles+xml', 'styles']
]);
const contentTypes = '[Content_Types].xml';
const badWorkbook = '无法读取 XLSX 工作簿。请在 Excel 中打开并另存为 .xlsx 后重试。';
const oversizedWorkbook = 'XLSX 工作簿超出处理上限，请删除多余工作表、行或列，或拆分文件后再上传。';
const openZip = promisify(yauzl.fromBuffer);
const decimal = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/iu;
const isSpreadsheet = (node) => spreadsheetNamespaces.has(node.uri);
const attr = (node, name) => node.attributes[name]?.value;
const invalid = () => { throw new Error(badWorkbook); };
const oversized = () => { throw new Error(oversizedWorkbook); };

function visitXml(bytes, onOpen, onClose, onText) {
  const parser = new SaxesParser({ xmlns: true });
  const path = [];
  parser.on('error', invalid);
  parser.on('doctype', invalid);
  parser.on('processinginstruction', invalid);
  parser.on('opentag', (node) => {
    path.push(node.local);
    if (path.length > 64) oversized();
    onOpen(node, path);
  });
  parser.on('closetag', (node) => {
    onClose?.(node, path);
    path.pop();
  });
  if (onText) {
    parser.on('text', (text) => onText(text, path));
    parser.on('cdata', (text) => onText(text, path));
  }
  parser.write(new TextDecoder('utf-8', { fatal: true }).decode(bytes)).close();
}

function entriesOf(zip) {
  return new Promise((resolve, reject) => {
    const entries = new Map();
    const names = new Set();
    let expanded = 0;
    zip.on('error', reject);
    zip.once('end', () => resolve(entries));
    zip.on('entry', (entry) => {
      expanded += entry.uncompressedSize;
      const key = entry.fileName.toLowerCase();
      if (names.size >= maxEntries || expanded > maxExpandedBytes) reject(new Error(oversizedWorkbook));
      else if (names.has(key) || /[\u0000-\u001f\u007f]/u.test(key) || entry.isEncrypted()) reject(new Error(badWorkbook));
      else {
        names.add(key);
        entries.set(entry.fileName, entry);
        zip.readEntry();
      }
    });
    zip.readEntry();
  });
}

async function xmlPart(zip, entries, name) {
  const entry = entries.get(name);
  if (!entry) invalid();
  const stream = await promisify(zip.openReadStream).call(zip, entry);
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function packageParts(bytes) {
  const sheets = new Set();
  const parts = {};
  visitXml(bytes, (node, path) => {
    if (path.length !== 2 || node.local !== 'Override' || node.uri !== 'http://schemas.openxmlformats.org/package/2006/content-types') return;
    const type = attr(node, 'ContentType');
    const partName = attr(node, 'PartName');
    if (!partName?.startsWith('/')) invalid();
    const name = partName.slice(1);
    if (type === typePrefix + 'worksheet+xml') {
      if (sheets.has(name)) invalid();
      sheets.add(name);
    } else {
      const role = partRoles.get(type);
      if (role) {
        if (parts[role]) invalid();
        parts[role] = name;
      }
    }
  });
  if (!parts.workbook || !sheets.size) invalid();
  if (sheets.size > maxSheets) oversized();
  return { ...parts, sheets };
}

function sanitizedTypes(parts, sheet) {
  const overrides = [
    [parts.workbook, 'sheet.main+xml'], [sheet, 'worksheet+xml'],
    [parts.strings, 'sharedStrings+xml'], [parts.styles, 'styles+xml']
  ].filter(([name]) => name).map(([name, type]) => {
    const safeName = name.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/"/gu, '&quot;');
    return `<Override PartName="/${safeName}" ContentType="${typePrefix}${type}"/>`;
  });
  return Buffer.from(`<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">${overrides.join('')}</Types>`);
}

function namedSheets(workbook, rels, filename, expected) {
  const targets = new Map();
  visitXml(rels, (node, path) => {
    if (path.length !== 2 || node.local !== 'Relationship' ||
        !relationshipNamespaces.some((ns) => attr(node, 'Type') === ns + '/worksheet')) return;
    const target = attr(node, 'Target');
    const id = attr(node, 'Id');
    if (!target || !id || targets.has(id) || attr(node, 'TargetMode') === 'External') invalid();
    const name = target.startsWith('/') ? target.slice(1) : posix.join(posix.dirname(filename), target);
    if (!expected.has(name)) invalid();
    targets.set(id, name);
  });
  const sheets = [];
  const seenPaths = new Set();
  const seenNames = new Set();
  visitXml(workbook, (node, path) => {
    if (path.join('/') !== 'workbook/sheets/sheet' || !isSpreadsheet(node)) return;
    if (seenNames.size >= maxSheets) oversized();
    const id = Object.values(node.attributes).find((item) => item.local === 'id' && relationshipNamespaces.includes(item.uri));
    const target = targets.get(id?.value);
    const name = excelText(attr(node, 'name') ?? '');
    if (!name || name.length > 31 || seenNames.has(name.toLowerCase()) || !name.isWellFormed() || name.includes(D.ANONYMOUS)) invalid();
    seenNames.add(name.toLowerCase());
    // Non-worksheet tabs, such as chart sheets, contain no importable cells.
    if (!target) return;
    if (seenPaths.has(target)) invalid();
    seenPaths.add(target);
    sheets.push({ target, name, visible: !['hidden', 'veryHidden'].includes(attr(node, 'state')) });
  });
  if (seenPaths.size !== expected.size) invalid();
  return sheets;
}

// Decode Office's escaped characters after XML entity decoding. A single pass
// preserves a literal "_xNNNN_" when its initial underscore was escaped.
const excelText = (value) => value.replace(/_x([a-f\d]{4})_/giu, (_, code) => String.fromCharCode(parseInt(code, 16)));

function textRuns(parentPath, appendRun) {
  const plain = parentPath + '/t';
  const rich = parentPath + '/r/t';
  const isRun = (path) => path === plain || path === rich;
  let run;
  // A single XML text element can emit multiple events. Decode before joining
  // separate elements so adjacent rich-text runs cannot form a new escape.
  return {
    open(path) {
      if (isRun(path)) run = '';
    },
    append(part, path) {
      if (run !== undefined && isRun(path)) run += part;
    },
    close(path) {
      if (!isRun(path)) return;
      appendRun(excelText(run));
      run = undefined;
    }
  };
}

function sharedStrings(bytes) {
  const strings = [];
  let value;
  const runs = textRuns('sst/si', (text) => { value += text; });
  visitXml(bytes, (node, path) => {
    if (!isSpreadsheet(node)) return;
    const level = path.join('/');
    if (level === 'sst/si') value = '';
    else runs.open(level);
  }, (node, path) => {
    if (!isSpreadsheet(node)) return;
    const level = path.join('/');
    if (level === 'sst/si') {
      if (strings.length >= maxTableCells) oversized();
      strings.push(value);
    } else runs.close(level);
  }, (text, path) => {
    runs.append(text, path.join('/'));
  });
  return strings;
}

function sheetCells(bytes, strings, budget) {
  const cells = new Map();
  const physicalWidths = new Map();
  let row = 0;
  let column = -1;
  let cellsBeforeRow = 0;
  let current;
  const runs = textRuns('worksheet/sheetData/row/c/is', (text) => { current.text += text; });
  visitXml(bytes, (node, path) => {
    if (!isSpreadsheet(node)) return;
    const level = path.join('/');
    if (level === 'worksheet/sheetData/row') {
      const next = attr(node, 'r') ?? String(row + 1);
      if (!/^[1-9]\d{0,6}$/u.test(next) || Number(next) <= row) invalid();
      row = Number(next);
      column = -1;
      cellsBeforeRow = cells.size;
    } else if (level === 'worksheet/sheetData/row/c') {
      const address = attr(node, 'r') ?? XLSX.utils.encode_cell({ r: row - 1, c: column + 1 });
      if (!/^[A-Z]{1,3}[1-9]\d{0,6}$/u.test(address)) invalid();
      const decoded = XLSX.utils.decode_cell(address);
      if (decoded.r !== row - 1 || decoded.c <= column) invalid();
      column = decoded.c;
      const style = attr(node, 's');
      if (style !== undefined && !/^\d{1,6}$/u.test(style)) invalid();
      current = { address, row, column, style: Number(style ?? 0), type: attr(node, 't') ?? 'n', raw: '', text: '', inline: false, formula: false, value: false };
    } else if (level === 'worksheet/sheetData/row/c/f' && current) current.formula = true;
    else if (level === 'worksheet/sheetData/row/c/is' && current) {
      if (current.inline || current.value) invalid();
      current.inline = true;
    } else if (level === 'worksheet/sheetData/row/c/v' && current) {
      if (current.inline || current.value) invalid();
      current.value = true;
    } else if (current) runs.open(level);
  }, (node, path) => {
    if (!isSpreadsheet(node)) return;
    const level = path.join('/');
    if (level === 'worksheet/sheetData/row') {
      if (cells.size > cellsBeforeRow) physicalWidths.set(row, column + 1);
      return;
    }
    if (!current) return;
    if (level !== 'worksheet/sheetData/row/c') {
      runs.close(level);
      return;
    }
    if (++budget.cells > maxTableCells) oversized();
    if (current.raw || current.inline || current.formula) {
      if (current.row > maxRows || current.column >= maxColumns) oversized();
      if (current.type === 's' && /^\d+$/u.test(current.raw) && Object.hasOwn(strings, Number(current.raw))) {
        current.validString = true;
        current.text = strings[Number(current.raw)];
      } else if (current.type === 'str') current.text = excelText(current.raw);
      cells.set(current.address, current);
    }
    current = null;
  }, (text, path) => {
    if (!current) return;
    const level = path.join('/');
    if (level === 'worksheet/sheetData/row/c/v') current.raw += text;
    else runs.append(text, level);
  });
  return { cells, physicalWidths };
}

function actualData(cell) {
  if (cell.formula) return true;
  if (cell.type === 'inlineStr' || cell.type === 'str') return !D.isBlank(cell.text);
  if (cell.type === 's' && cell.validString) return !D.isBlank(cell.text);
  return Boolean(cell.raw);
}

function excelDate(value, date1904, format, label) {
  const millis = Math.round(value * dayMs);
  const days = Math.floor(millis / dayMs);
  const start = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, days > 60 ? 30 : 31);
  const date = new Date(start + millis);
  if (!Number.isFinite(date.valueOf()) || date.getUTCFullYear() > 9999 || days < (date1904 ? 0 : 1) || (!date1904 && days === 60)) {
    throw new Error(`${label} 的 Excel 日期无效，请修正日期后重试。`);
  }
  const iso = date.toISOString();
  if (millis % dayMs === 0 && !/[hs]/iu.test(format)) return iso.slice(0, 10);
  return iso.slice(0, -1).replace('T', ' ').replace(/\.000$/u, '');
}

function dateText(raw, label) {
  if (!/^\d{4}-\d{2}-\d{2}(?:T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)?)?$/u.test(raw) || !D.datePart(raw)) {
    throw new Error(`${label} 的 Excel 日期无效，请修正日期后重试。`);
  }
  return raw.replace('T', ' ');
}

const cellLabel = (cell) => `XLSX 第 ${cell.row} 行（${cell.address}）`;

function cellValue(cell, parsed, date1904, styleCount) {
  const label = cellLabel(cell);
  if (cell.formula && !cell.raw) {
    throw new Error(`${label} 的公式没有保存结果，请在 Excel 中将公式复制并选择性粘贴为值后再上传。`);
  }
  if (cell.type === 'e') throw new Error(`${label} 含 Excel 错误，请修正单元格后再上传。`);
  if (cell.type === 'inlineStr' || cell.type === 'str' || (cell.type === 's' && cell.validString)) {
    if (!cell.text.isWellFormed() || cell.text.includes(D.ANONYMOUS)) throw new Error(`${label} 含无法导入的文本字符，请重新填写该单元格。`);
    return cell.text;
  }
  if (cell.type === 'd') return dateText(cell.raw, label);
  if (cell.type === 'b' && /^[01]$|^(?:true|false)$/u.test(cell.raw)) return /^(?:1|true)$/u.test(cell.raw) ? 'TRUE' : 'FALSE';
  if (cell.type === 'n' && cell.raw.length <= 64 && decimal.test(cell.raw) && Number.isFinite(parsed?.v) && parsed.v === Number(cell.raw)) {
    const format = parsed.z;
    if (cell.style && (cell.style >= styleCount || !format)) {
      throw new Error(`${label} 的数字格式无法读取，请将该格设为常规格式或保存为文本。`);
    }
    cell.numberFormat = format;
    if (!format || format === 'General') return String(parsed.v);
    if (format.length > maxFormatLength) oversized();
    const pattern = format.replace(/"(?:[^"]|"")*"|\\.|_.|\*./gu, '');
    if (XLSX.SSF.is_date(format) && /[yd]/iu.test(pattern)) return excelDate(parsed.v, date1904, pattern, label);
    try {
      return XLSX.SSF.format(format, parsed.v, { date1904 });
    } catch {
      throw new Error(`${label} 的数字格式无法读取，请将该格设为常规格式或保存为文本。`);
    }
  }
  throw new Error(`${label} 含无法读取的值，请修正该格并重新保存工作簿。`);
}

function rowsFor({ cells, physicalWidths }, parsed, date1904, styleCount) {
  const rows = new Map();
  let textBytes = 0;
  for (const cell of cells.values()) {
    const value = cellValue(cell, Object.hasOwn(parsed, cell.address) && parsed[cell.address], date1904, styleCount);
    textBytes += Buffer.byteLength(value);
    if (textBytes > maxTextBytes) oversized();
    if (!rows.has(cell.row)) rows.set(cell.row, { line: cell.row, values: [], cells: new Map() });
    const row = rows.get(cell.row);
    while (row.values.length <= cell.column) row.values.push('');
    row.values[cell.column] = value;
    row.cells.set(cell.column, cell);
  }
  const ordered = [...rows.values()];
  const header = ordered.find((row) => row.values.some((value) => !D.isBlank(value)));
  if (header) {
    // Only the header defines new columns. A blank cell in a data row, or
    // the worksheet's used range, must not declare additional headers.
    const width = physicalWidths.get(header.line);
    if (width > maxColumns || width * rows.size > maxTableCells) oversized();
    while (header.values.length < width) header.values.push('');
  }
  return ordered;
}

function identifierCell(row, index, field) {
  if (field !== D.ID && field !== '序列号') return;
  const cell = row.cells.get(index);
  if (!cell || ['s', 'str', 'inlineStr'].includes(cell.type)) return;
  const number = Number(cell.raw);
  const digits = cell.raw.split(/[eE]/u)[0].replace(/\D/gu, '').replace(/^0+|0+$/gu, '');
  const format = cell.numberFormat ?? 'General';
  if (cell.type !== 'n' || !Number.isSafeInteger(number) || Math.abs(number) >= 1e15 || digits.length > 15 || !/^(?:General|@|0+)$/u.test(format)) {
    throw new Error(`${cellLabel(cell)} 的“${field}”可能存在精度或格式问题，请设为文本并从原始资料重新填写完整编号。`);
  }
}

async function readPackage(bytes, requestedSheet) {
  if (bytes.length < 4 || bytes.readUInt32LE(0) !== 0x04034b50) invalid();
  const zip = await openZip(bytes, { lazyEntries: true, autoClose: false, strictFileNames: true, validateEntrySizes: true });
  try {
    const entries = await entriesOf(zip);
    const types = await xmlPart(zip, entries, contentTypes);
    const parts = packageParts(types);
    const workbook = await xmlPart(zip, entries, parts.workbook);
    const relsPath = posix.join(posix.dirname(parts.workbook), '_rels', posix.basename(parts.workbook) + '.rels');
    const rels = await xmlPart(zip, entries, relsPath);
    const sheets = namedSheets(workbook, rels, parts.workbook, parts.sheets);
    const stringsXml = parts.strings ? await xmlPart(zip, entries, parts.strings) : null;
    const strings = stringsXml ? sharedStrings(stringsXml) : [];
    const budget = { cells: 0 };
    const available = [];
    for (const sheet of sheets.filter((sheet) => sheet.visible)) {
      const xml = await xmlPart(zip, entries, sheet.target);
      const data = sheetCells(xml, strings, budget);
      if ([...data.cells.values()].some(actualData)) available.push({ ...sheet, xml, data });
    }
    const names = available.map(({ name }) => name);
    const chosen = requestedSheet ? available.find(({ name }) => name === requestedSheet) : available.length === 1 ? available[0] : null;
    if (!chosen) return { names };

    const sanitized = XLSX.CFB.utils.cfb_new();
    // Feed the workbook reader only validated parts from a freshly written archive.
    // Drawings, external link parts and worksheet relationships are not needed for values.
    for (const [name, data] of [[contentTypes, sanitizedTypes(parts, chosen.target)], [parts.workbook, workbook], [relsPath, rels], [chosen.target, chosen.xml], [parts.strings, stringsXml]]) {
      if (data) XLSX.CFB.utils.cfb_add(sanitized, name, data);
    }
    let styleCount = 0;
    if (parts.styles) {
      const styles = await xmlPart(zip, entries, parts.styles);
      visitXml(styles, (node, path) => {
        if (node.local === 'numFmt' && (attr(node, 'formatCode')?.length ?? 0) > maxFormatLength) oversized();
        if (path.join('/') === 'styleSheet/cellXfs/xf' && ++styleCount > 65_536) oversized();
      });
      XLSX.CFB.utils.cfb_add(sanitized, parts.styles, styles);
    }
    const data = XLSX.CFB.write(sanitized, { fileType: 'zip', type: 'buffer', compression: false });
    const parsed = XLSX.read(data, { type: 'buffer', sheets: [chosen.name], cellNF: true, cellFormula: false, cellHTML: false, cellText: false, nodim: true });
    if (!Object.hasOwn(parsed.Sheets, chosen.name) || !parsed.Sheets[chosen.name]) invalid();
    const rows = rowsFor(chosen.data, parsed.Sheets[chosen.name], Boolean(parsed.Workbook.WBProps.date1904), styleCount);
    return { names, sheet: chosen.name, rows };
  } finally {
    zip.close();
  }
}

let reading = 0;
async function readXlsx(bytes, requestedSheet) {
  if (reading >= 2) throw new Error('正在读取其他 XLSX 文件，请稍后重试。');
  reading += 1;
  try {
    return await readPackage(bytes, requestedSheet);
  } catch (error) {
    if (error.constructor === Error && /^(?:XLSX |无法读取 XLSX )/u.test(error.message)) throw error;
    throw new Error(badWorkbook);
  } finally {
    reading -= 1;
  }
}

module.exports = { readXlsx, maxFileBytes, identifierCell };
