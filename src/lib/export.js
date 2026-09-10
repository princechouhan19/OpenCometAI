// src/lib/export.js
// Export helpers for downloadable JSON/CSV/TXT/Markdown artifacts.

export async function downloadExportFile(payloadOrOptions = {}, maybeOptions = {}) {
  const isWrappedCall = Object.prototype.hasOwnProperty.call(payloadOrOptions || {}, 'dataset') || Object.prototype.hasOwnProperty.call(payloadOrOptions || {}, 'format');
  const options = isWrappedCall
    ? payloadOrOptions
    : { dataset: payloadOrOptions, ...maybeOptions };
  const {
    dataset = {},
    format = 'json',
    formats = null,
    folder = 'Open Comet Exports',
    diskLabel = 'Default Downloads',
    baseName = `open-comet-export-${Date.now()}`,
    prompt = false,
  } = options;

  if (Array.isArray(formats) && formats.length > 1) {
    const files = [];
    for (const item of formats) {
      files.push(await downloadExportFile({ ...options, formats: null, format: item, dataset }));
    }
    return files;
  }

  const normalizedFormat = String(format || 'json').toLowerCase();
  const prepared = buildExportPayload(dataset, normalizedFormat);
  const filename = makeFilename(folder, diskLabel, baseName, prepared.extension);
  const url = makeDataUrl(prepared.mimeType, prepared.content);

  const downloadId = await chrome.downloads.download({
    url,
    filename,
    saveAs: Boolean(prompt),
    conflictAction: 'uniquify',
  });

  return {
    downloadId,
    filename,
    format: normalizedFormat,
    mimeType: prepared.mimeType,
  };
}

function buildExportPayload(dataset, format) {
  switch (format) {
    case 'csv':
      return {
        extension: 'csv',
        mimeType: 'text/csv;charset=utf-8',
        content: rowsToCsv(dataset.columns || inferColumns(dataset.rows || []), dataset.rows || []),
      };
    case 'txt':
      return {
        extension: 'txt',
        mimeType: 'text/plain;charset=utf-8',
        content: toPlainText(dataset),
      };
    case 'md':
    case 'markdown':
      return {
        extension: 'md',
        mimeType: 'text/markdown;charset=utf-8',
        content: toMarkdown(dataset),
      };
    case 'json':
    default:
      return {
        extension: 'json',
        mimeType: 'application/json;charset=utf-8',
        content: JSON.stringify(dataset, null, 2),
      };
  }
}

function makeFilename(folder, diskLabel, baseName, extension) {
  const cleanFolder = sanitizeSegment(folder || 'Open Comet Exports');
  const cleanDisk = sanitizeSegment(diskLabel || 'Default Downloads');
  const cleanBase = sanitizeSegment(baseName || `open-comet-export-${Date.now()}`);
  return `${cleanFolder}/${cleanDisk}/${cleanBase}.${extension}`;
}

function sanitizeSegment(value) {
  return String(value || '')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\s/g, '-')
    .substring(0, 80) || 'export';
}

function makeDataUrl(mimeType, content) {
  return `data:${mimeType},${encodeURIComponent(String(content || ''))}`;
}

function inferColumns(rows) {
  const columns = new Set();
  for (const row of rows || []) {
    for (const key of Object.keys(row || {})) columns.add(key);
  }
  return [...columns];
}

function rowsToCsv(columns, rows) {
  const cols = (columns || []).length ? columns : inferColumns(rows);
  const lines = [cols.map(csvCell).join(',')];
  for (const row of rows || []) {
    lines.push(cols.map(column => csvCell(row?.[column] ?? '')).join(','));
  }
  return lines.join('\r\n');
}

function csvCell(value) {
  const text = String(value ?? '');
  return `"${text.replace(/"/g, '""')}"`;
}

function toPlainText(dataset) {
  const lines = [];
  if (dataset.title) lines.push(dataset.title);
  if (dataset.summary) lines.push('', dataset.summary);
  if (Array.isArray(dataset.columns) && dataset.columns.length) {
    lines.push('', `Columns: ${dataset.columns.join(', ')}`);
  }
  if (Array.isArray(dataset.rows) && dataset.rows.length) {
    lines.push('', 'Rows:');
    dataset.rows.forEach((row, index) => {
      lines.push(`${index + 1}. ${JSON.stringify(row)}`);
    });
  }
  return lines.join('\n').trim();
}

function toMarkdown(dataset) {
  const parts = [];
  if (dataset.title) parts.push(`# ${dataset.title}`);
  if (dataset.summary) parts.push(dataset.summary);
  const columns = dataset.columns || inferColumns(dataset.rows || []);
  if (columns.length && Array.isArray(dataset.rows) && dataset.rows.length) {
    parts.push(`| ${columns.join(' | ')} |`);
    parts.push(`| ${columns.map(() => '---').join(' | ')} |`);
    for (const row of dataset.rows) {
      parts.push(`| ${columns.map(column => escapePipe(row?.[column] ?? '')).join(' | ')} |`);
    }
  }
  return parts.join('\n\n').trim();
}

function escapePipe(value) {
  return String(value ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

