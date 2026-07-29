/**
 * write-sheet.js — Write schedule reconciliation to Google Sheets
 *
 * Usage: node write-sheet.js <reconciliation.json> <sheet-id>
 *
 * Uses a service account (C:\LCOS\service-account.json) to write
 * Dashboard, Discrepancies, LCOS Schedule, and A+ Schedule tabs
 * with full formatting matching hlc-automation.
 */

const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');

const ENV_PATH = 'C:\\projects\\hlc-agents\\.env';
const DEFAULT_SHEET_TITLE = 'HLC Schedule Reconciliation — Issaquah';
const DEFAULT_SHARE_EMAIL = 'fapedraza@gmail.com';

function readEnv(p) {
  if (!fs.existsSync(p)) return {};
  const out = {};
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
  return out;
}
function appendEnv(p, key, value) {
  const existing = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
  const sep = existing && !existing.endsWith('\n') ? '\n' : '';
  fs.appendFileSync(p, `${sep}${key}=${value}\n`);
}

// Arg parsing
const args = process.argv.slice(2);
const createIfMissing = args.includes('--create-if-missing');
const positional = args.filter(a => !a.startsWith('--'));
const reconPath = positional[0];
const sheetIdArg = positional[1];

if (!reconPath) {
  console.error('Usage: node write-sheet.js <reconciliation.json> [sheet-id] [--create-if-missing]');
  process.exit(1);
}

const env = readEnv(ENV_PATH);
let sheetId = sheetIdArg || env.RECONCILE_SHEET_ID || '';
const SERVICE_ACCOUNT_PATH = env.SERVICE_ACCOUNT_PATH || 'C:\\LCOS\\service-account.json';

// ════════════════════════════════════════════════════════════════
// COLORS — matches hlc-automation ReconcileConfig.js exactly
// ════════════════════════════════════════════════════════════════
const C = {
  DARK_BLUE:  { red: 0.102, green: 0.212, blue: 0.365 }, // #1a365d
  MID_BLUE:   { red: 0.176, green: 0.216, blue: 0.282 }, // #2d3748
  WHITE:      { red: 1, green: 1, blue: 1 },
  HEADER_BG:  { red: 0.929, green: 0.949, blue: 0.969 }, // #edf2f7
  EVEN_ROW:   { red: 0.973, green: 0.980, blue: 0.988 }, // #f8fafc
  BORDER:     { red: 0.886, green: 0.910, blue: 0.941 }, // #e2e8f0
  TEXT_MID:   { red: 0.290, green: 0.333, blue: 0.412 }, // #4a5568
  TEXT_LIGHT: { red: 0.627, green: 0.678, blue: 0.749 }, // #a0aec0
  SUBTITLE:   { red: 0.886, green: 0.910, blue: 0.878 }, // #e2e8f0
  GREEN_BG:   { red: 0.776, green: 0.965, blue: 0.831 }, // #c6f6d5
  GREEN_FG:   { red: 0.153, green: 0.404, blue: 0.286 }, // #276749
  RED_BG:     { red: 0.996, green: 0.843, blue: 0.843 }, // #fed7d7
  RED_FG:     { red: 0.608, green: 0.173, blue: 0.173 }, // #9b2c2c
  RED_TEXT:   { red: 0.773, green: 0.188, blue: 0.188 }, // #c53030
  ORANGE_BG:  { red: 1, green: 0.953, blue: 0.878 },     // #fff3e0
  BLUE_BG:    { red: 0.890, green: 0.949, blue: 0.992 }, // #e3f2fd
  PINK_BG:    { red: 0.988, green: 0.894, blue: 0.925 }, // #fce4ec
  PURPLE_BG:  { red: 0.953, green: 0.898, blue: 0.961 }, // #f3e5f5
  YELLOW_BG:  { red: 0.996, green: 0.988, blue: 0.749 }, // #fefcbf
};

const TYPE_COLORS = {
  'Missing in A+':          C.ORANGE_BG,
  'Missing in LCOS':        C.BLUE_BG,
  'Not Cancelled in A+':    C.PINK_BG,
  'Not Cancelled in LCOS':  { red: 0.878, green: 0.969, blue: 0.980 }, // #e0f7fa — teal
  'Schedule Mismatch':      C.YELLOW_BG,
  'Double Booked':          C.PURPLE_BG,
  'Session/Retest Overlap': { red: 1.0, green: 0.804, blue: 0.824 }, // #ffcdd2 — red
  'Tutor Overloaded': { red: 1.0, green: 0.878, blue: 0.698 },       // #ffe0b2 — amber
};

// ════════════════════════════════════════════════════════════════
// HELPERS
// ════════════════════════════════════════════════════════════════

function fmtDateShort(ymd) {
  const d = new Date(ymd + 'T12:00:00');
  const day = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][d.getDay()];
  return `${day} ${d.getMonth()+1}/${d.getDate()}`;
}

function fmtDateLong(ymd) {
  const d = new Date(ymd + 'T12:00:00');
  return d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
}

function dayShort(ymd) {
  const d = new Date(ymd + 'T12:00:00');
  return ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][d.getDay()];
}

function cellData(val, opts = {}) {
  const cell = { userEnteredValue: {} };
  if (typeof val === 'number') cell.userEnteredValue.numberValue = val;
  else cell.userEnteredValue.stringValue = String(val != null ? val : '');

  const fmt = {};
  if (opts.bg) fmt.backgroundColor = opts.bg;
  if (opts.fg) fmt.textFormat = { ...fmt.textFormat, foregroundColor: opts.fg };
  if (opts.bold) fmt.textFormat = { ...fmt.textFormat, bold: true };
  if (opts.size) fmt.textFormat = { ...fmt.textFormat, fontSize: opts.size };
  if (opts.halign) fmt.horizontalAlignment = opts.halign;
  if (Object.keys(fmt).length > 0) cell.userEnteredFormat = fmt;
  return cell;
}

function emptyCell() {
  return { userEnteredValue: { stringValue: '' } };
}

function mergeRequest(sid, startRow, endRow, startCol, endCol) {
  return { mergeCells: { range: { sheetId: sid, startRowIndex: startRow, endRowIndex: endRow, startColumnIndex: startCol, endColumnIndex: endCol }, mergeType: 'MERGE_ALL' } };
}

function colWidthRequest(sid, col, width) {
  return { updateDimensionProperties: { range: { sheetId: sid, dimension: 'COLUMNS', startIndex: col, endIndex: col + 1 }, properties: { pixelSize: width }, fields: 'pixelSize' } };
}

function rowHeightRequest(sid, row, height) {
  return { updateDimensionProperties: { range: { sheetId: sid, dimension: 'ROWS', startIndex: row, endIndex: row + 1 }, properties: { pixelSize: height }, fields: 'pixelSize' } };
}

function freezeRequest(sid, rows) {
  return { updateSheetProperties: { properties: { sheetId: sid, gridProperties: { frozenRowCount: rows } }, fields: 'gridProperties.frozenRowCount' } };
}

function autoResizeRequest(sid, startCol, endCol) {
  return { autoResizeDimensions: { dimensions: { sheetId: sid, dimension: 'COLUMNS', startIndex: startCol, endIndex: endCol } } };
}

// ════════════════════════════════════════════════════════════════
// BUILD DASHBOARD TAB
// ════════════════════════════════════════════════════════════════

function buildDashboard(recon, sid) {
  const { stats, typeCounts, discrepancies, dates } = recon;
  // perDay can be an array or object keyed by date — normalize to array
  let perDay;
  if (Array.isArray(recon.perDay)) {
    perDay = recon.perDay;
  } else if (recon.perDay && typeof recon.perDay === 'object') {
    perDay = dates.map(d => ({ date: d, ...(recon.perDay[d] || { lcos: 0, aplus: 0, matched: 0, discrepancies: 0 }) }));
  } else {
    perDay = [];
  }
  // typeCounts can also be recon.byType
  const typeCountsObj = typeCounts || recon.byType || {};
  const rows = [];
  const requests = [];

  const dateRange = dates.length === 1
    ? fmtDateLong(dates[0])
    : fmtDateShort(dates[0]) + ' \u2192 ' + fmtDateShort(dates[dates.length - 1]);
  const ts = new Date().toLocaleString('en-US', { month:'short', day:'numeric', year:'numeric', hour:'numeric', minute:'2-digit', hour12:true });

  // Row 0: Title
  rows.push({ values: [
    cellData('HLC Schedule Reconciliation', { bg: C.DARK_BLUE, fg: C.WHITE, bold: true, size: 18 }),
    ...Array(5).fill(cellData('', { bg: C.DARK_BLUE }))
  ]});
  requests.push(mergeRequest(sid, 0, 1, 0, 6));
  requests.push(rowHeightRequest(sid, 0, 44));

  // Row 1: Subtitle
  rows.push({ values: [
    cellData('LCOS vs Appointment Plus \u00B7 ' + dateRange + ' \u00B7 Issaquah', { bg: C.MID_BLUE, fg: C.SUBTITLE, size: 11 }),
    ...Array(5).fill(cellData('', { bg: C.MID_BLUE }))
  ]});
  requests.push(mergeRequest(sid, 1, 2, 0, 6));
  requests.push(rowHeightRequest(sid, 1, 28));

  // Row 2: Timestamp
  rows.push({ values: [cellData('Run: ' + ts, { fg: C.TEXT_LIGHT, size: 10 })] });

  // Row 3: blank
  rows.push({ values: [emptyCell()] });

  // Row 4: Stats headers
  const statHeaders = ['LCOS Student-Days', 'A+ Student-Days', 'Matched', 'Discrepancies', 'LCOS Cancelled', 'A+ Cancelled'];
  rows.push({ values: statHeaders.map(h => cellData(h, { bg: C.HEADER_BG, fg: C.TEXT_MID, bold: true, size: 10, halign: 'CENTER' })) });

  // Row 5: Stats values
  const matchedCell = cellData(stats.matched || 0, { bg: C.GREEN_BG, fg: C.GREEN_FG, bold: true, size: 16, halign: 'CENTER' });
  const discBg = stats.discrepancies > 0 ? C.RED_BG : C.GREEN_BG;
  const discFg = stats.discrepancies > 0 ? C.RED_FG : C.GREEN_FG;
  const discCell = cellData(stats.discrepancies || 0, { bg: discBg, fg: discFg, bold: true, size: 16, halign: 'CENTER' });
  rows.push({ values: [
    cellData(stats.lcosTotal || 0, { bold: true, size: 16, halign: 'CENTER' }),
    cellData(stats.aplusTotal || 0, { bold: true, size: 16, halign: 'CENTER' }),
    matchedCell,
    discCell,
    cellData(stats.lcosCancelled || 0, { bold: true, size: 16, halign: 'CENTER' }),
    cellData(stats.aplusCancelled || 0, { bold: true, size: 16, halign: 'CENTER' }),
  ]});

  // Row 6: blank
  rows.push({ values: [emptyCell()] });

  let r = 7;

  // Daily breakdown (if multi-day)
  if (dates.length > 1) {
    rows.push({ values: [cellData('Daily Breakdown', { bold: true, size: 13 })] });
    r++;

    const dayHeaders = ['Date', 'LCOS', 'A+', 'Matched', 'Issues', 'Status'];
    rows.push({ values: dayHeaders.map(h => cellData(h, { bg: C.HEADER_BG, fg: C.TEXT_MID, bold: true, halign: 'CENTER' })) });
    r++;

    for (let i = 0; i < perDay.length; i++) {
      const d = perDay[i];
      const bg = i % 2 === 0 ? C.WHITE : C.EVEN_ROW;
      const statusText = d.discrepancies === 0 ? '\u2705 Clean' : '\u26A0 ' + d.discrepancies + ' issue(s)';
      const issueFg = d.discrepancies > 0 ? C.RED_TEXT : C.GREEN_FG;
      const statusFg = d.discrepancies > 0 ? C.RED_FG : C.GREEN_FG;
      rows.push({ values: [
        cellData(fmtDateShort(d.date), { bg }),
        cellData(d.lcos, { bg, halign: 'CENTER' }),
        cellData(d.aplus, { bg, halign: 'CENTER' }),
        cellData(d.matched, { bg, halign: 'CENTER' }),
        cellData(d.discrepancies, { bg, fg: issueFg, bold: d.discrepancies > 0, halign: 'CENTER' }),
        cellData(statusText, { bg, fg: statusFg }),
      ]});
      r++;
    }
    rows.push({ values: [emptyCell()] });
    r++;
  }

  // Breakdown by type
  if (stats.discrepancies > 0 && Object.keys(typeCountsObj).length > 0) {
    rows.push({ values: [cellData('Breakdown by Type', { bold: true, size: 13 })] });
    r++;
    rows.push({ values: [
      cellData('Type', { bg: C.HEADER_BG, fg: C.TEXT_MID, bold: true }),
      cellData('Count', { bg: C.HEADER_BG, fg: C.TEXT_MID, bold: true }),
    ]});
    r++;

    const typeOrder = ['Missing in A+', 'Missing in LCOS', 'Not Cancelled in A+', 'Not Cancelled in LCOS', 'Schedule Mismatch', 'Double Booked', 'Session/Retest Overlap', 'Tutor Overloaded'];
    for (const t of typeOrder) {
      if (!typeCountsObj[t]) continue;
      const bg = TYPE_COLORS[t] || C.YELLOW_BG;
      rows.push({ values: [
        cellData(t, { bg }),
        cellData(typeCountsObj[t], { bg }),
      ]});
      r++;
    }
  } else if (stats.discrepancies === 0) {
    rows.push({ values: [cellData('\u2705 No discrepancies \u2014 schedules are in sync!', { bg: C.GREEN_BG, fg: C.GREEN_FG, size: 14, halign: 'CENTER' })] });
    requests.push(mergeRequest(sid, r, r + 1, 0, 6));
  }

  // Column widths
  [160, 100, 100, 100, 100, 100].forEach((w, i) => requests.push(colWidthRequest(sid, i, w)));

  return { rows, requests };
}

// ════════════════════════════════════════════════════════════════
// BUILD DISCREPANCIES TAB
// ════════════════════════════════════════════════════════════════

function buildDiscrepancies(recon, sid) {
  const { discrepancies, dates } = recon;
  const rows = [];
  const requests = [];
  const dateRange = dates.length === 1 ? dates[0] : dates[0] + ' \u2192 ' + dates[dates.length - 1];

  if (discrepancies.length === 0) {
    rows.push({ values: [cellData('\u2705 No discrepancies for ' + dateRange, { fg: C.GREEN_FG, size: 16 })] });
    return { rows, requests };
  }

  // Header
  const headers = ['Type', 'Student', 'Date', 'Day', 'LCOS Schedule', 'A+ Schedule', 'LCOS (min)', 'A+ (min)'];
  rows.push({ values: headers.map(h => cellData(h, { bg: C.DARK_BLUE, fg: C.WHITE, bold: true, halign: 'CENTER' })) });

  // Data rows
  for (const d of discrepancies) {
    const bg = TYPE_COLORS[d.type] || C.YELLOW_BG;
    rows.push({ values: [
      cellData(d.type, { bg }),
      cellData(d.student, { bg }),
      cellData(d.date, { bg }),
      cellData(dayShort(d.date), { bg }),
      cellData(d.lcos_detail, { bg }),
      cellData(d.aplus_detail, { bg }),
      cellData(d.lcos_mins || 0, { bg }),
      cellData(d.aplus_mins || 0, { bg }),
    ]});
  }

  requests.push(freezeRequest(sid, 1));
  requests.push(autoResizeRequest(sid, 0, 8));

  return { rows, requests };
}

// ════════════════════════════════════════════════════════════════
// BUILD RAW DATA TABS (LCOS Schedule, A+ Schedule)
// ════════════════════════════════════════════════════════════════

function buildRawTab(sessions, headers, sid) {
  const rows = [];
  const requests = [];

  // Header row
  rows.push({ values: headers.map(h => cellData(h, { bg: C.DARK_BLUE, fg: C.WHITE, bold: true })) });

  // Data rows
  for (const row of sessions) {
    rows.push({ values: row.map(v => cellData(v)) });
  }

  requests.push(freezeRequest(sid, 1));
  requests.push(autoResizeRequest(sid, 0, headers.length));

  return { rows, requests };
}

// ════════════════════════════════════════════════════════════════
// MAIN
// ════════════════════════════════════════════════════════════════

async function main() {
  // Auth — needs spreadsheets + drive for --create-if-missing (share file)
  const creds = JSON.parse(fs.readFileSync(SERVICE_ACCOUNT_PATH, 'utf8'));
  const auth = new google.auth.GoogleAuth({
    credentials: creds,
    scopes: [
      'https://www.googleapis.com/auth/spreadsheets',
      'https://www.googleapis.com/auth/drive',
    ],
  });
  const sheets = google.sheets({ version: 'v4', auth });
  const drive = google.drive({ version: 'v3', auth });

  // Read reconciliation data
  const recon = JSON.parse(fs.readFileSync(reconPath, 'utf8'));

  // ── Step 0: Resolve or create sheet ──
  let needsCreate = !sheetId;
  if (sheetId) {
    try {
      await sheets.spreadsheets.get({ spreadsheetId: sheetId, fields: 'spreadsheetId' });
    } catch (err) {
      if (err.code === 404 && createIfMissing) {
        console.log('Sheet not found; will create.');
        needsCreate = true;
      } else {
        throw err;
      }
    }
  }
  if (needsCreate) {
    if (!createIfMissing) {
      console.error('No RECONCILE_SHEET_ID set and --create-if-missing not passed. Aborting.');
      process.exit(1);
    }
    console.log('Creating new spreadsheet:', DEFAULT_SHEET_TITLE);
    const created = await sheets.spreadsheets.create({
      resource: { properties: { title: DEFAULT_SHEET_TITLE } },
      fields: 'spreadsheetId',
    });
    sheetId = created.data.spreadsheetId;
    console.log('Created sheet ID:', sheetId);

    await drive.permissions.create({
      fileId: sheetId,
      requestBody: { type: 'user', role: 'writer', emailAddress: DEFAULT_SHARE_EMAIL },
      sendNotificationEmail: false,
    });
    console.log('Shared with', DEFAULT_SHARE_EMAIL);

    appendEnv(ENV_PATH, 'RECONCILE_SHEET_ID', sheetId);
    console.log('Wrote RECONCILE_SHEET_ID to', ENV_PATH);
  }

  console.log('Authenticated. Writing to sheet:', sheetId);
  console.log('Stats:', recon.stats.lcosTotal, 'LCOS,', recon.stats.aplusTotal, 'A+,', recon.stats.discrepancies, 'discrepancies');

  // ── Step 1: Get existing tabs ──
  const info = await sheets.spreadsheets.get({ spreadsheetId: sheetId, fields: 'sheets.properties' });
  const existingSheets = info.data.sheets.map(s => ({ id: s.properties.sheetId, title: s.properties.title }));
  console.log('Existing tabs:', existingSheets.map(s => s.title).join(', '));

  // ── Step 2: Delete all tabs, recreate fresh ──
  const tabNames = ['Dashboard', 'Discrepancies', 'LCOS Schedule', 'A+ Schedule'];
  const setupRequests = [];

  // Add temp tab
  setupRequests.push({ addSheet: { properties: { title: '_temp' } } });

  // Delete all existing tabs
  for (const s of existingSheets) {
    setupRequests.push({ deleteSheet: { sheetId: s.id } });
  }

  // Create the 4 tabs
  const tabIds = [100, 101, 102, 103];
  for (let i = 0; i < tabNames.length; i++) {
    setupRequests.push({ addSheet: { properties: { title: tabNames[i], sheetId: tabIds[i] } } });
  }

  await sheets.spreadsheets.batchUpdate({ spreadsheetId: sheetId, resource: { requests: setupRequests } });
  console.log('Tabs recreated.');

  // Delete temp tab
  const info2 = await sheets.spreadsheets.get({ spreadsheetId: sheetId, fields: 'sheets.properties' });
  const tempSheet = info2.data.sheets.find(s => s.properties.title === '_temp');
  if (tempSheet) {
    await sheets.spreadsheets.batchUpdate({ spreadsheetId: sheetId, resource: { requests: [{ deleteSheet: { sheetId: tempSheet.properties.sheetId } }] } });
  }

  // ── Step 3: Build tab data ──

  // Prepare LCOS sessions as array of arrays
  const lcosHeaders = ['Date', 'Student Name', 'Client ID', 'Service', 'Subject Area', 'Start Time', 'End Time', 'Duration (min)', 'Attend Code', 'Status Code', 'Is Active', 'Is Cancelled', 'Notes'];
  const lcosSessions = (recon.lcosSessions || recon.lcosSessionsRaw || recon.rawSessions || []).map(s => [
    s.date, s.studentName, s.clientId || '', s.service || '', s.subjectArea || '',
    s.startTime || '', s.endTime || '', s.durationMins || 0,
    s.attendCode || '', s.statusCode || '', s.isActive ? 'TRUE' : 'FALSE', s.isCancelled ? 'TRUE' : 'FALSE',
    s.notes || ''
  ]).sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]) || a[5].localeCompare(b[5]));

  const aplusHeaders = ['Date', 'Student Name', 'Start Time', 'End Time', 'Duration (min)', 'Status', 'Service', 'Staff', 'Notes'];
  const aplusSessions = (recon.aplusSessions || []).map(s => [
    s.date, s.studentName, s.startTime || '', s.endTime || '', s.durationMins || 0,
    s.status || '', s.service || '', s.staff || '', s.notes || ''
  ]).sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]) || a[2].localeCompare(b[2]));

  const dashboard = buildDashboard(recon, tabIds[0]);
  const discrepancies = buildDiscrepancies(recon, tabIds[1]);
  const lcosTab = buildRawTab(lcosSessions, lcosHeaders, tabIds[2]);
  const aplusTab = buildRawTab(aplusSessions, aplusHeaders, tabIds[3]);

  // ── Step 4: Write all tabs via batchUpdate ──
  const allRequests = [];

  // Write row data
  const tabData = [
    { sid: tabIds[0], data: dashboard },
    { sid: tabIds[1], data: discrepancies },
    { sid: tabIds[2], data: lcosTab },
    { sid: tabIds[3], data: aplusTab },
  ];

  for (const { sid, data } of tabData) {
    if (data.rows.length > 0) {
      allRequests.push({
        updateCells: {
          rows: data.rows,
          fields: 'userEnteredValue,userEnteredFormat',
          start: { sheetId: sid, rowIndex: 0, columnIndex: 0 },
        }
      });
    }
    allRequests.push(...data.requests);
  }

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: sheetId,
    resource: { requests: allRequests },
  });

  // Set Dashboard as the active/first sheet
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: sheetId,
    resource: { requests: [
      { updateSheetProperties: { properties: { sheetId: tabIds[0], index: 0 }, fields: 'index' } },
    ]},
  });

  console.log('Done! Wrote', dashboard.rows.length, 'dashboard rows,', discrepancies.rows.length, 'discrepancy rows,', lcosTab.rows.length, 'LCOS rows,', aplusTab.rows.length, 'A+ rows.');
}

main().catch(err => {
  console.error('Error:', err.message);
  if (err.errors) console.error('Details:', JSON.stringify(err.errors, null, 2));
  process.exit(1);
});
