// ReWiseEd shared in-browser document extraction (.docx, .pdf best-effort, .txt/.md)
// Files are parsed entirely in the tab — nothing is uploaded.
(function () {
  'use strict';
// ---------- file extraction (all in-browser) ----------
async function readDocxText(buf) {
  const u8 = new Uint8Array(buf), dv = new DataView(buf);
  let eocd = -1;
  for (let i = u8.length - 22; i >= 0; i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('Not a valid .docx (zip) file.');
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  for (let n = 0; n < count; n++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const method = dv.getUint16(p + 10, true);
    const compSize = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true), extraLen = dv.getUint16(p + 30, true), commentLen = dv.getUint16(p + 32, true);
    const localOff = dv.getUint32(p + 42, true);
    const name = new TextDecoder().decode(u8.slice(p + 46, p + 46 + nameLen));
    if (name === 'word/document.xml') {
      const lNameLen = dv.getUint16(localOff + 26, true), lExtraLen = dv.getUint16(localOff + 28, true);
      const start = localOff + 30 + lNameLen + lExtraLen;
      const comp = u8.slice(start, start + compSize);
      const xmlBytes = method === 0 ? comp
        : new Uint8Array(await new Response(new Blob([comp]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer());
      // zip-bomb guard: refuse absurd expansion instead of freezing the tab
      if (xmlBytes.length > 80 * 1024 * 1024) throw new Error('This .docx expands to an unusually large document — paste the text instead.');
      const doc = new DOMParser().parseFromString(new TextDecoder().decode(xmlBytes), 'application/xml');
      const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
      const out = [];
      for (const para of doc.getElementsByTagNameNS(W, 'p')) {
        let text = '';
        for (const t of para.getElementsByTagNameNS(W, 't')) text += t.textContent;
        if (text.trim()) out.push(text.trim());
      }
      return out.join('\n\n');
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  throw new Error('No word/document.xml found inside the file.');
}

// best-effort PDF text extraction: inflate FlateDecode streams, read Tj/TJ operators
async function readPdfText(buf) {
  const u8 = new Uint8Array(buf);
  const latin = new TextDecoder('latin1').decode(u8);
  if (!latin.startsWith('%PDF')) throw new Error('Not a PDF file.');
  const chunks = [];
  const re = /stream\r?\n/g;
  let m;
  while ((m = re.exec(latin))) {
    const start = m.index + m[0].length;
    const end = latin.indexOf('endstream', start);
    if (end < 0) continue;
    const dictStart = latin.lastIndexOf('<<', m.index);
    const dict = latin.slice(dictStart, m.index);
    // slice exactly /Length bytes when stated; else trim the trailing EOL —
    // DecompressionStream rejects any junk after the zlib stream
    const lenM = dict.match(/\/Length\s+(\d+)/);
    let sEnd = lenM ? Math.min(start + +lenM[1], end) : end;
    while (sEnd > start && (u8[sEnd - 1] === 0x0a || u8[sEnd - 1] === 0x0d || u8[sEnd - 1] === 0x20)) sEnd--;
    let bytes = u8.slice(start, lenM ? Math.min(start + +lenM[1], end) : sEnd);
    if (/FlateDecode/.test(dict)) {
      try { bytes = new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'))).arrayBuffer()); }
      catch {
        try { bytes = new Uint8Array(await new Response(new Blob([u8.slice(start, sEnd)]).stream().pipeThrough(new DecompressionStream('deflate'))).arrayBuffer()); }
        catch { continue; }
      }
    } else if (/DCTDecode|JPXDecode|CCITTFax/.test(dict)) continue; // images
    chunks.push(new TextDecoder('latin1').decode(bytes));
  }
  const unescape = s => s.replace(/\\([nrtbf()\\/]|[0-7]{1,3})/g, (_, c) => {
    const map = { n: '\n', r: '', t: ' ', b: '', f: '' };
    if (map[c] !== undefined) return map[c];
    if (/^[0-7]+$/.test(c)) return String.fromCharCode(parseInt(c, 8));
    return c;
  });
  const parts = [];
  for (const c of chunks) {
    if (!/\b(Tj|TJ|BT)\b/.test(c)) continue;
    const ops = c.match(/\((?:\\.|[^\\()])*\)\s*Tj|\[(?:[^\]\\]|\\.)*\]\s*TJ|T\*|Td|TD/g) || [];
    for (const op of ops) {
      if (op === 'T*' || op.endsWith('Td') || op.endsWith('TD')) { parts.push('\n'); continue; }
      if (op.endsWith('Tj')) { parts.push(unescape(op.slice(1, op.lastIndexOf(')')))); continue; }
      // TJ array: strings mixed with kerning numbers
      const strs = op.match(/\((?:\\.|[^\\()])*\)/g) || [];
      parts.push(strs.map(s => unescape(s.slice(1, -1))).join(''));
    }
    parts.push('\n');
  }
  const text = parts.join('').replace(/\n{3,}/g, '\n\n').replace(/[ \t]+/g, ' ').trim();
  const readable = (text.match(/[a-zA-Z0-9]/g) || []).length;
  if (readable < 60) throw new Error('This PDF stores its text in a form the in-browser reader can’t decode (it may be scanned, or use custom-encoded fonts). Open it and copy-paste the text instead — or upload a .docx.');
  return text;
}

async function extract(file) {
  if (file.size > 25 * 1024 * 1024) throw new Error('File too large (25 MB max) — export a smaller version or paste the text instead.');
  const name = file.name.toLowerCase();
  if (name.endsWith('.docx')) return readDocxText(await file.arrayBuffer());
  if (name.endsWith('.pdf')) return readPdfText(await file.arrayBuffer());
  if (name.endsWith('.doc')) throw new Error('Legacy .doc isn’t supported — save it as .docx in Word and re-upload.');
  return (await file.text()).trim();
}


  // moderation pre-gate: extracted text is screened BEFORE any tool stores or
  // processes it (same checker as the live guard and the server)
  function screenExtracted(text) {
    const chk = window.Rewiseed?.checkText?.(text);
    if (chk && !chk.ok) throw new Error(`This file can’t be used. ${chk.message}`);
    return text;
  }
  const _extract = extract;
  async function extractScreened(file) { return screenExtracted(await _extract(file)); }
  window.RewiseedDocExtract = { readDocxText, readPdfText, extract: extractScreened };
})();
