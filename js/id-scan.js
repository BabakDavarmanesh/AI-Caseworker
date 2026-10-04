'use strict';

// ID Scan page (Client Session). The caseworker uploads the client's identity
// document; Gemini reads it and the details are shown for review. The saved
// record (name, date of birth, ...) is used by Responses and the Mock CRM.
// Only the extracted text is stored (localStorage "aic_id_scan"), never the image.

const ID_SCAN_STORAGE_KEY = 'aic_id_scan';
const ID_MAX_IMAGE_SIDE = 2000;          // phone photos are shrunk before upload
const ID_MAX_UPLOAD_BYTES = 6 * 1024 * 1024;

let _idFiles = [];
let _idPreviewUrls = [];

// Status-line messages for this page's pipeline (shared animation in app.js).
Object.assign(PIPELINE_PHASES, {
  'id-upload': { text: 'Preparing the ID document...',               step: 'id-step-upload', slowMs: 6000 },
  'id-read':   { text: 'Gemini is reading the ID...',                step: 'id-step-read',   slowMs: 12000 },
  'id-verify': { text: 'Checking the extracted details...',          step: 'id-step-verify', slowMs: 4000 },
  'id-save':   { text: 'Saving to the client profile...',            step: 'id-step-save',   slowMs: 4000 },
  'id-done':   { text: 'ID details are ready. Please review them.',  success: true },
  'id-error':  { text: "We couldn't read this document. Please try a clearer photo.", error: true }
});

// [key, label, hint]
const ID_FIELDS = [
  ['fullName',       'Full name',             'As printed on the document'],
  ['givenNames',     'Given name(s)',         ''],
  ['surname',        'Surname / family name', ''],
  ['dateOfBirth',    'Date of birth',         'YYYY-MM-DD'],
  ['sex',            'Sex',                   ''],
  ['nationality',    'Nationality',           ''],
  ['placeOfBirth',   'Place of birth',        ''],
  ['documentType',   'Document type',         'e.g. Passport, PR card'],
  ['documentNumber', 'Document number',       ''],
  ['issuingCountry', 'Issuing country',       ''],
  ['issueDate',      'Issue date',            'YYYY-MM-DD'],
  ['expiryDate',     'Expiry date',           'YYYY-MM-DD']
];

function loadIdScan() {
  try { return JSON.parse(localStorage.getItem(ID_SCAN_STORAGE_KEY) || 'null'); } catch { return null; }
}

function persistIdScan(record) {
  if (record) localStorage.setItem(ID_SCAN_STORAGE_KEY, JSON.stringify(record));
  else localStorage.removeItem(ID_SCAN_STORAGE_KEY);
}

// ── File selection ──────────────────────────────────────────────
function idIsSupported(file) {
  return /^(image\/(jpeg|png|webp)|application\/pdf)$/.test(file.type) ||
    /\.(jpe?g|png|webp|pdf)$/i.test(file.name || '');
}

function idAddFiles(files) {
  const ok = files.filter(idIsSupported);
  const bad = files.filter(f => !idIsSupported(f)).map(f => f.name);
  if (bad.length) toast(`Unsupported file: ${bad.join(', ')}`, 'error');
  if (!ok.length) return;
  _idFiles = [..._idFiles, ...ok].slice(0, 2);   // front + back at most
  idRenderSelection();
}

function idOnFileSelect(input) { idAddFiles(Array.from(input.files || [])); input.value = ''; }
function idOnDragOver(e) { e.preventDefault(); document.getElementById('id-upload-zone').classList.add('drag-over'); }
function idOnDragLeave() { document.getElementById('id-upload-zone').classList.remove('drag-over'); }
function idOnDrop(e) {
  e.preventDefault();
  idOnDragLeave();
  idAddFiles(Array.from(e.dataTransfer?.files || []));
}

function idRenderSelection() {
  const has = _idFiles.length > 0;
  document.getElementById('id-file-indicator').style.display = has ? 'flex' : 'none';
  document.getElementById('id-file-label').innerHTML = _idFiles
    .map((f, i) => `<div>${i + 1}. ${esc(f.name)} <span style="opacity:.7">(${(f.size / 1024).toFixed(0)} KB)</span></div>`).join('');
  document.getElementById('btn-id-scan').disabled = !has;
  document.getElementById('btn-id-clear').style.display = has || loadIdScan() ? 'inline-flex' : 'none';
  stepState('id-step-upload', has ? 'step-done' : null, has ? `${_idFiles.length} file${_idFiles.length > 1 ? 's' : ''} selected` : '');
}

function idClear() {
  _idFiles = [];
  _idPreviewUrls.forEach(u => URL.revokeObjectURL(u));
  _idPreviewUrls = [];
  persistIdScan(null);
  document.getElementById('id-result').style.display = 'none';
  document.getElementById('id-status').textContent = '';
  if (typeof setUploadAreaCollapsed === 'function') setUploadAreaCollapsed(false);
  resetPipelineStatus();
  ['id-step-upload', 'id-step-read', 'id-step-verify', 'id-step-save'].forEach(id => stepState(id, null));
  idRenderSelection();
  toast('ID details cleared', 'info');
}

// ── Preparing the files for Gemini ──────────────────────────────
function idReadAsBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] || '');
    r.onerror = () => reject(r.error || new Error('Could not read the file'));
    r.readAsDataURL(blob);
  });
}

// Images: shrink large photos to keep the request small. PDFs: sent as is.
async function idPrepareFile(file) {
  if (file.type === 'application/pdf' || /\.pdf$/i.test(file.name)) {
    if (file.size > ID_MAX_UPLOAD_BYTES) throw new Error(`${file.name} is larger than 6 MB.`);
    return { mimeType: 'application/pdf', data: await idReadAsBase64(file) };
  }
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, ID_MAX_IMAGE_SIDE / Math.max(bmp.width, bmp.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bmp.width * scale);
    canvas.height = Math.round(bmp.height * scale);
    canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise(res => canvas.toBlob(res, 'image/jpeg', 0.9));
    return { mimeType: 'image/jpeg', data: await idReadAsBase64(blob) };
  } catch (_) {
    if (file.size > ID_MAX_UPLOAD_BYTES) throw new Error(`${file.name} is larger than 6 MB.`);
    return { mimeType: file.type || 'image/jpeg', data: await idReadAsBase64(file) };
  }
}

const ID_EXTRACT_PROMPT = `You read identity documents for an immigration caseworker (passport, permanent resident card, driver's licence, national ID card, birth certificate, visa or permit).
Extract ONLY what is printed on the document image(s). Never guess or invent a value. If a field is missing, unreadable or covered, use an empty string.
If both a visual zone and a machine-readable zone (MRZ) exist and agree, use them; if they disagree, prefer the visual zone and mention it in "notes".
Write dates as YYYY-MM-DD (convert from any format, e.g. 05 MAR/MARS 1985 -> 1985-03-05). Write names in Latin letters as printed (keep accents); fullName = given names + surname.
Return JSON exactly:
{
  "isIdentityDocument": true,
  "documentType": "", "issuingCountry": "", "documentNumber": "",
  "fullName": "", "givenNames": "", "surname": "",
  "dateOfBirth": "", "sex": "", "nationality": "", "placeOfBirth": "",
  "issueDate": "", "expiryDate": "",
  "notes": ""
}`;

async function idExtractWithGemini(parts) {
  const s = loadSettings();
  if (!s.gcpProjectId) throw new Error('Set the Google Project ID in Settings first.');
  const model = (s.geminiModel || GEMINI_DEFAULT_MODEL).trim();
  const res = await fetch('/gemini', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      projectId: s.gcpProjectId,
      location: s.geminiLocation || 'global',
      model,
      credentialsFile: s.gcpCredentialsFile || 'google-service-account.json',
      request: {
        contents: [{ role: 'user', parts: [{ text: ID_EXTRACT_PROMPT }, ...parts.map(p => ({ inlineData: p }))] }],
        generationConfig: {
          responseMimeType: 'application/json',
          temperature: 0,
          thinkingConfig: /^gemini-3/.test(model) ? { thinkingLevel: 'low' } : { thinkingBudget: 0 }
        }
      }
    })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error?.message || `Gemini ${res.status}`);
  const raw = data.candidates?.[0]?.content?.parts?.map(x => x.text || '').join('') || '';
  return JSON.parse(raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''));
}

// ── Scan ────────────────────────────────────────────────────────
async function idRunScan() {
  if (!_idFiles.length) return;
  const btn = document.getElementById('btn-id-scan');
  const status = document.getElementById('id-status');
  btn.disabled = true;
  status.textContent = '';
  resetPipelineStatus();

  try {
    stepState('id-step-upload', 'step-active');
    setPipelinePhase('id-upload');
    const parts = [];
    for (const f of _idFiles) parts.push(await idPrepareFile(f));
    _idPreviewUrls.forEach(u => URL.revokeObjectURL(u));
    _idPreviewUrls = _idFiles.filter(f => f.type.startsWith('image/')).map(f => URL.createObjectURL(f));
    stepState('id-step-upload', 'step-done');

    stepState('id-step-read', 'step-active');
    setPipelinePhase('id-read');
    const out = await idExtractWithGemini(parts);
    stepState('id-step-read', 'step-done');

    stepState('id-step-verify', 'step-active');
    setPipelinePhase('id-verify');
    if (out.isIdentityDocument === false) throw new Error('This does not look like an identity document.');
    const record = { scannedAt: new Date().toISOString(), fileNames: _idFiles.map(f => f.name) };
    ID_FIELDS.forEach(([key]) => { record[key] = String(out[key] || '').trim(); });
    if (!record.fullName) record.fullName = [record.givenNames, record.surname].filter(Boolean).join(' ');
    record.notes = String(out.notes || '').trim();
    stepState('id-step-verify', 'step-done');

    stepState('id-step-save', 'step-active');
    setPipelinePhase('id-save');
    persistIdScan(record);
    stepState('id-step-save', 'step-done');
    setPipelinePhase('id-done');

    idRenderResult(record);
    if (typeof setUploadAreaCollapsed === 'function') setUploadAreaCollapsed(true);
    toast('ID read — please review the details', 'success');
  } catch (e) {
    console.error('[ID Scan]', e);
    ['id-step-upload', 'id-step-read', 'id-step-verify', 'id-step-save'].forEach(id => {
      const el = document.getElementById(id);
      if (el && el.classList.contains('step-active')) stepState(id, null);
    });
    setPipelinePhase('id-error');
    status.textContent = e.message || String(e);
    toast('ID scan failed: ' + (e.message || e), 'error');
  } finally {
    btn.disabled = !_idFiles.length;
    document.getElementById('btn-id-clear').style.display = 'inline-flex';
  }
}

// ── Result ──────────────────────────────────────────────────────
function idRenderResult(record) {
  document.getElementById('id-result').style.display = 'block';

  document.getElementById('id-fields').innerHTML = ID_FIELDS.map(([key, label, hint]) => `
    <div class="form-group" style="margin-bottom:0">
      <label>${esc(label)}</label>
      <input type="text" id="id-f-${key}" value="${esc(record[key] || '')}" placeholder="${esc(hint || '—')}" oninput="idRefreshChecks()">
    </div>`).join('');

  const preview = document.getElementById('id-preview');
  preview.innerHTML = _idPreviewUrls.length
    ? _idPreviewUrls.map(u => `<img src="${u}" alt="ID document preview">`).join('')
    : `<div class="id-preview-empty">${record.fileNames?.length ? '📄 ' + esc(record.fileNames.join(', ')) : 'No preview'}<br><small>(the ID image is not stored)</small></div>`;

  idRefreshChecks();
  document.getElementById('id-result').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function idCollectEdits() {
  const rec = Object.assign({}, loadIdScan() || {});
  ID_FIELDS.forEach(([key]) => {
    const el = document.getElementById(`id-f-${key}`);
    if (el) rec[key] = el.value.trim();
  });
  return rec;
}

// Badges and warnings (expired document, impossible date of birth, missing fields).
function idRefreshChecks() {
  const rec = idCollectEdits();
  const today = todayIsoDate();
  const badges = [];
  const warnings = [];
  const isDate = v => /^\d{4}-\d{2}-\d{2}$/.test(v || '');

  if (rec.documentType) badges.push(`<span class="badge badge-blue">${esc(rec.documentType)}</span>`);
  if (isDate(rec.expiryDate)) {
    badges.push(rec.expiryDate < today
      ? '<span class="badge badge-orange">⚠ Expired</span>'
      : '<span class="badge badge-green">✓ Valid until ' + esc(rec.expiryDate) + '</span>');
  }
  if (!rec.fullName) warnings.push('The full name could not be read. Please type it.');
  if (!rec.dateOfBirth) warnings.push('The date of birth could not be read. Please type it (YYYY-MM-DD).');
  else if (!isDate(rec.dateOfBirth)) warnings.push('Write the date of birth as YYYY-MM-DD.');
  else if (rec.dateOfBirth > today) warnings.push('The date of birth is in the future — please check it.');
  if (rec.notes) warnings.push('Gemini note: ' + rec.notes);

  document.getElementById('id-badges').innerHTML = badges.join('');
  document.getElementById('id-warnings').innerHTML = warnings
    .map(w => `<div class="a-warning" style="margin-top:6px">⚠️ <div>${esc(w)}</div></div>`).join('');
}

function idSaveEdits(goToIntake) {
  const rec = idCollectEdits();
  rec.updatedAt = new Date().toISOString();
  persistIdScan(rec);
  toast('ID details saved', 'success');
  if (goToIntake) window.location.href = 'interview.html';
}

// ── Page start ──────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', () => {
  if (document.body?.dataset?.page !== 'id-scan') return;
  const saved = loadIdScan();
  if (saved) {
    ['id-step-upload', 'id-step-read', 'id-step-verify', 'id-step-save'].forEach(id => stepState(id, 'step-done'));
    idRenderResult(saved);
    if (typeof setUploadAreaCollapsed === 'function') setUploadAreaCollapsed(true);
  }
  idRenderSelection();
});
