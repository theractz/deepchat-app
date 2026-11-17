/*!
 * DeepFileReader — pembaca file untuk DeepChat (jalan 100% di browser, file tidak diunggah ke server).
 *
 * Pemakaian:
 *   const r = await DeepFileReader.read(file, { maxChars: 40000, onProgress: (msg) => {} });
 *   // r = { text, truncated, kind, ext, originalChars }
 *   // Kalau gagal: melempar DeepFileReader.FileReadError dengan pesan Bahasa Indonesia yang siap ditampilkan.
 *
 * Format yang didukung:
 *   teks/kode : txt md json csv tsv html css js ts py xml yaml log sql java c cpp go rs php rb sh ... (lihat TEXT_EXTS)
 *   dokumen   : pdf (PDF teks, bukan scan), docx, odt, rtf
 *   tabel     : xlsx xlsm xlsb xls ods
 *   slide     : pptx, odp
 *
 * Library pihak ketiga (pdf.js, mammoth, SheetJS, JSZip) dimuat malas (lazy) dari CDN
 * hanya ketika dibutuhkan, dengan cadangan CDN kedua.
 */
(function (global) {
  'use strict';

  class FileReadError extends Error {
    constructor(message) { super(message); this.name = 'FileReadError'; }
  }

  // ---------- Daftar format ----------
  const TEXT_EXTS = [
    'txt', 'md', 'markdown', 'js', 'mjs', 'cjs', 'ts', 'jsx', 'tsx', 'json', 'html', 'htm', 'css', 'scss',
    'py', 'csv', 'tsv', 'xml', 'yml', 'yaml', 'log', 'sql', 'java', 'c', 'h', 'cpp', 'cs', 'go', 'rs',
    'php', 'rb', 'sh', 'ini', 'toml', 'svg'
  ];
  const TEXT_SET = new Set(TEXT_EXTS);

  const BINARY_KINDS = {
    pdf: 'pdf',
    docx: 'docx',
    xlsx: 'sheet', xlsm: 'sheet', xlsb: 'sheet', xls: 'sheet', ods: 'sheet',
    pptx: 'pptx',
    odt: 'odf', odp: 'odf',
    rtf: 'rtf'
  };

  const UNSUPPORTED = {
    doc: 'File .doc (Word lama) belum bisa dibaca. Simpan ulang sebagai .docx lalu unggah lagi.',
    ppt: 'File .ppt (PowerPoint lama) belum bisa dibaca. Simpan ulang sebagai .pptx lalu unggah lagi.',
    pages: 'File Pages belum didukung. Ekspor dulu ke PDF atau .docx.',
    numbers: 'File Numbers belum didukung. Ekspor dulu ke .xlsx atau .csv.',
    key: 'File Keynote belum didukung. Ekspor dulu ke PDF atau .pptx.',
    png: 'Gambar belum didukung karena butuh OCR. Salin teksnya ke file .txt dulu.',
    jpg: 'Gambar belum didukung karena butuh OCR. Salin teksnya ke file .txt dulu.',
    jpeg: 'Gambar belum didukung karena butuh OCR. Salin teksnya ke file .txt dulu.',
    gif: 'Gambar belum didukung karena butuh OCR. Salin teksnya ke file .txt dulu.',
    webp: 'Gambar belum didukung karena butuh OCR. Salin teksnya ke file .txt dulu.',
    zip: 'File ZIP belum didukung. Ekstrak dulu lalu unggah file di dalamnya.'
  };

  const MAX_TEXT_BYTES = 2 * 1024 * 1024;     // file teks/kode
  const MAX_BINARY_BYTES = 15 * 1024 * 1024;  // pdf, docx, xlsx, dst.

  const ALL_EXTS = TEXT_EXTS.concat(Object.keys(BINARY_KINDS));
  const ACCEPT = ALL_EXTS.map(e => '.' + e).join(',');

  // ---------- Pemuat library (lazy, dengan CDN cadangan) ----------
  const LIBS = {
    pdf: {
      urls: [
        'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js',
        'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.min.js'
      ],
      ready: () => !!global.pdfjsLib
    },
    mammoth: {
      urls: [
        'https://cdnjs.cloudflare.com/ajax/libs/mammoth/1.6.0/mammoth.browser.min.js',
        'https://cdn.jsdelivr.net/npm/mammoth@1.6.0/mammoth.browser.min.js'
      ],
      ready: () => !!global.mammoth
    },
    xlsx: {
      urls: [
        'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js',
        'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js'
      ],
      ready: () => !!global.XLSX
    },
    jszip: {
      urls: [
        'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js',
        'https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js'
      ],
      ready: () => !!global.JSZip
    }
  };
  const loading = {};
  const usedUrl = {};

  function loadScript(url) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = url;
      s.async = true;
      s.onload = () => resolve();
      s.onerror = () => { s.remove(); reject(new Error('gagal memuat ' + url)); };
      document.head.appendChild(s);
    });
  }

  function ensure(key) {
    if (LIBS[key].ready()) return Promise.resolve();
    if (loading[key]) return loading[key];
    const p = (async () => {
      for (const url of LIBS[key].urls) {
        try {
          await loadScript(url);
          if (LIBS[key].ready()) { usedUrl[key] = url; return; }
        } catch (e) { /* coba CDN berikutnya */ }
      }
      throw new FileReadError('Gagal memuat komponen pembaca file. Periksa koneksi internet lalu coba lagi.');
    })();
    loading[key] = p;
    p.catch(() => { delete loading[key]; }); // boleh dicoba ulang kalau gagal
    return p;
  }

  // ---------- Helper teks ----------
  function extOf(name) {
    const m = /\.([a-z0-9]+)$/i.exec(String(name || ''));
    return m ? m[1].toLowerCase() : '';
  }

  function decodeEntities(s) {
    return s
      .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
      .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
      .replace(/&amp;/g, '&');
  }

  function normalize(text) {
    return String(text)
      .replace(/\r\n?/g, '\n')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  // Ambil teks dari XML per paragraf. paraEnd = tag penutup paragraf, textRe = regex isi teks
  function xmlParagraphs(xml, paraEnd, textRe) {
    const paras = xml.split(paraEnd);
    const out = [];
    for (const chunk of paras) {
      const p = chunk + '<'; // pemisah paragraf sudah terbuang, tutup node teks terakhir
      let line = '';
      let m;
      textRe.lastIndex = 0;
      while ((m = textRe.exec(p)) !== null) line += decodeEntities(m[1]);
      if (line.trim()) out.push(line);
    }
    return out.join('\n');
  }

  // Parser RTF sederhana (best-effort): buang kontrol, ambil teks, \par jadi baris baru
  function rtfToText(src) {
    const SKIP = new Set(['fonttbl', 'colortbl', 'stylesheet', 'info', 'pict', 'header', 'footer', 'footnote',
      'themedata', 'colorschememapping', 'datastore', 'latentstyles', 'listtable', 'listoverridetable', 'rsidtbl', 'generator']);
    let out = '', i = 0, depth = 0, skipDepth = null;
    while (i < src.length) {
      const c = src[i];
      if (c === '{') {
        depth++; i++;
        if (skipDepth === null) {
          const m = /^\\(\*\\)?([a-z]+)/.exec(src.slice(i, i + 40));
          if (m && (m[1] || SKIP.has(m[2]))) skipDepth = depth;
        }
        continue;
      }
      if (c === '}') {
        if (skipDepth !== null && depth === skipDepth) skipDepth = null;
        depth--; i++;
        continue;
      }
      if (c === '\\') {
        const n = src[i + 1];
        if (n === "'") {
          if (skipDepth === null) out += String.fromCharCode(parseInt(src.substr(i + 2, 2), 16));
          i += 4; continue;
        }
        if (n === '\\' || n === '{' || n === '}') {
          if (skipDepth === null) out += n;
          i += 2; continue;
        }
        const m = /^\\([a-zA-Z]+)(-?\d+)? ?/.exec(src.slice(i, i + 40));
        if (m) {
          const w = m[1];
          if (skipDepth === null) {
            if (w === 'par' || w === 'line' || w === 'row') out += '\n';
            else if (w === 'tab' || w === 'cell') out += '\t';
            else if (w === 'u' && m[2] !== undefined) {
              let code = parseInt(m[2], 10);
              if (code < 0) code += 65536;
              out += String.fromCharCode(code);
            }
          }
          i += m[0].length;
          if (w === 'u' && src[i] && src[i] !== '\\' && src[i] !== '{' && src[i] !== '}') i++; // lewati karakter cadangan
          continue;
        }
        i += 2; continue;
      }
      if (c !== '\n' && c !== '\r' && skipDepth === null) out += c;
      i++;
    }
    return out;
  }

  // ---------- Pembaca per jenis ----------
  const READERS = {
    async text(file) {
      const t = await file.text();
      if (t.includes('\u0000')) throw new FileReadError('File ini bukan file teks yang bisa dibaca.');
      return t;
    },

    async pdf(file, o) {
      await ensure('pdf');
      const pdfjs = global.pdfjsLib;
      pdfjs.GlobalWorkerOptions.workerSrc = usedUrl.pdf.replace('pdf.min.js', 'pdf.worker.min.js');
      const data = new Uint8Array(await file.arrayBuffer());
      const doc = await pdfjs.getDocument({ data }).promise;
      const total = doc.numPages;
      let out = '';
      let hasText = false;
      for (let p = 1; p <= total; p++) {
        o.onProgress(`Membaca halaman ${p} dari ${total}…`);
        const page = await doc.getPage(p);
        const content = await page.getTextContent();
        let line = '';
        for (const it of content.items) {
          line += it.str;
          line += it.hasEOL ? '\n' : (it.str && !/\s$/.test(it.str) ? ' ' : '');
        }
        line = line.replace(/[ \t]{2,}/g, ' ').trim();
        if (line) hasText = true;
        out += `\n--- Halaman ${p} ---\n${line}\n`;
        if (out.length >= o.maxChars * 1.2) break; // cukup, tidak perlu baca seluruh PDF raksasa
      }
      if (doc.destroy) doc.destroy();
      if (!hasText) {
        throw new FileReadError('PDF ini tidak punya teks yang bisa dibaca (kemungkinan hasil scan/gambar). Coba PDF versi teks atau salin teksnya ke .txt.');
      }
      return out;
    },

    async docx(file) {
      await ensure('mammoth');
      const r = await global.mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() });
      return r.value;
    },

    async sheet(file, o) {
      await ensure('xlsx');
      const XLSX = global.XLSX;
      const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' });
      let out = '';
      for (const name of wb.SheetNames) {
        o.onProgress(`Membaca sheet ${name}…`);
        const csv = XLSX.utils.sheet_to_csv(wb.Sheets[name], { blankrows: false });
        if (csv.trim()) out += `## Sheet: ${name}\n${csv}\n\n`;
        if (out.length >= o.maxChars * 1.2) break;
      }
      return out;
    },

    async pptx(file, o) {
      await ensure('jszip');
      const zip = await global.JSZip.loadAsync(await file.arrayBuffer());
      const slides = Object.keys(zip.files)
        .map(n => ({ n, m: /^ppt\/slides\/slide(\d+)\.xml$/.exec(n) }))
        .filter(x => x.m)
        .sort((a, b) => a.m[1] - b.m[1]);
      if (!slides.length) throw new FileReadError('Tidak ada slide yang ditemukan di file PPTX ini.');
      let out = '';
      for (let i = 0; i < slides.length; i++) {
        o.onProgress(`Membaca slide ${i + 1} dari ${slides.length}…`);
        const xml = await zip.file(slides[i].n).async('string');
        const text = xmlParagraphs(xml, '</a:p>', /<a:t[^>]*>([\s\S]*?)<\/a:t>/g);
        out += `\n--- Slide ${i + 1} ---\n${text}\n`;
        if (out.length >= o.maxChars * 1.2) break;
      }
      return out;
    },

    async odf(file) { // odt & odp
      await ensure('jszip');
      const zip = await global.JSZip.loadAsync(await file.arrayBuffer());
      const f = zip.file('content.xml');
      if (!f) throw new FileReadError('Isi dokumen tidak ditemukan.');
      const xml = await f.async('string');
      const body = xml.replace(/<text:(tab|s)\b[^>]*\/>/g, ' ').replace(/<text:line-break\s*\/>/g, '\n');
      return xmlParagraphs(body, /<\/text:(?:p|h)>/, />([^<]+)</g);
    },

    async rtf(file) {
      return rtfToText(await file.text());
    }
  };

  function friendlyError(e, kind) {
    const msg = String((e && (e.message || e.name)) || '');
    if ((e && e.name === 'PasswordException') || /password|encrypt/i.test(msg)) {
      return 'File ini dikunci dengan password, jadi tidak bisa dibaca.';
    }
    if (e && e.name === 'InvalidPDFException') return 'File PDF rusak atau tidak valid.';
    if (global.console) console.error('[DeepFileReader]', e);
    return `File ${kind.toUpperCase()} ini tidak bisa dibaca (kemungkinan rusak atau formatnya tidak didukung).`;
  }

  // ---------- API publik ----------
  async function read(file, opts) {
    opts = opts || {};
    const maxChars = opts.maxChars || 40000;
    const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : function () {};
    if (!file) throw new FileReadError('File tidak ditemukan.');

    const ext = extOf(file.name);
    if (UNSUPPORTED[ext]) throw new FileReadError(UNSUPPORTED[ext]);
    const kind = TEXT_SET.has(ext) ? 'text' : BINARY_KINDS[ext];
    if (!kind) {
      throw new FileReadError(`Format .${ext || '?'} belum didukung. Yang bisa: PDF, Word (.docx), Excel (.xlsx/.xls), PowerPoint (.pptx), ODF, RTF, serta file teks/kode (.txt, .md, .json, .csv, .js, .py, .html, dll).`);
    }
    if (file.size > (kind === 'text' ? MAX_TEXT_BYTES : MAX_BINARY_BYTES)) {
      throw new FileReadError(`File terlalu besar. Maksimal ${kind === 'text' ? 2 : 15} MB untuk jenis file ini.`);
    }

    let raw;
    try {
      raw = await READERS[kind](file, { maxChars, onProgress });
    } catch (e) {
      if (e instanceof FileReadError) throw e;
      throw new FileReadError(friendlyError(e, kind));
    }

    const text = normalize(raw);
    if (!text) throw new FileReadError('Tidak ada teks yang bisa dibaca dari file ini.');
    const truncated = text.length > maxChars;
    return {
      text: truncated ? text.slice(0, maxChars) : text,
      truncated,
      kind: kind === 'text' ? ext : kind,
      ext,
      originalChars: text.length
    };
  }

  global.DeepFileReader = {
    read,
    FileReadError,
    accept: ACCEPT,
    extensions: ALL_EXTS,
    _test: { rtfToText, xmlParagraphs, normalize, decodeEntities, extOf }
  };
})(typeof window !== 'undefined' ? window : globalThis);
