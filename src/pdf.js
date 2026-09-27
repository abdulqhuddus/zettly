// Minimal, dependency-free PDF generator for booking confirmations.
// Cloudflare Workers can't easily bundle native/Node-only PDF libraries, so
// this hand-builds a valid single-page PDF using only the standard
// (non-embedded) Helvetica / Helvetica-Bold fonts, which every PDF viewer
// ships with. No fonts, images, or external files are embedded.

const PAGE_W = 595; // A4 in points
const PAGE_H = 842;

function te(str) {
  // ASCII-only encoder for PDF structural keywords (always safe).
  const out = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) out[i] = str.charCodeAt(i);
  return out;
}

function concat(arrays) {
  let len = 0;
  for (const a of arrays) len += a.length;
  const out = new Uint8Array(len);
  let off = 0;
  for (const a of arrays) { out.set(a, off); off += a.length; }
  return out;
}

// Map a JS string to WinAnsiEncoding bytes (matches Latin-1 for the
// German umlauts we need; the Euro sign is remapped to 0x80 as WinAnsi
// diverges from Latin-1 there).
function toWinAnsiBytes(str) {
  const bytes = [];
  for (const ch of str) {
    const cp = ch.codePointAt(0);
    if (cp === 0x20ac) { bytes.push(0x80); continue; } // €
    if (cp === 0x2013 || cp === 0x2014) { bytes.push(0x2d); continue; } // en/em dash -> hyphen
    if (cp === 0x2018 || cp === 0x2019) { bytes.push(0x27); continue; } // curly quotes -> '
    if (cp === 0x201c || cp === 0x201d) { bytes.push(0x22); continue; } // curly double quotes -> "
    if (cp === 0x203a) { bytes.push(0x9b); continue; } // › (WinAnsi position)
    if (cp === 0x2039) { bytes.push(0x8b); continue; } // ‹ (WinAnsi position)
    if (cp <= 0xff) { bytes.push(cp); continue; }
    bytes.push(0x3f); // '?' fallback for anything else
  }
  return bytes;
}

// Escape a literal PDF string's bytes: backslash, and parentheses.
function escapeLiteral(bytes) {
  const out = [];
  for (const b of bytes) {
    if (b === 0x28 || b === 0x29 || b === 0x5c) out.push(0x5c);
    out.push(b);
  }
  return out;
}

function pdfString(str) {
  return new Uint8Array(escapeLiteral(toWinAnsiBytes(str)));
}

// Rough Helvetica average character width fractions (of font size) for
// word-wrapping. Not metrically exact, just good enough to avoid running
// text off the page.
function wrapText(str, maxCharsPerLine) {
  const words = str.split(" ");
  const lines = [];
  let line = "";
  for (const w of words) {
    const candidate = line ? line + " " + w : w;
    if (candidate.length > maxCharsPerLine && line) {
      lines.push(line);
      line = w;
    } else {
      line = candidate;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function text(x, y, size, str, opts = {}) {
  const font = opts.bold ? "F2" : "F1";
  const color = opts.color || [0, 0, 0];
  const parts = [];
  parts.push(te(`${color[0]} ${color[1]} ${color[2]} rg\n`));
  parts.push(te("BT\n"));
  parts.push(te(`/${font} ${size} Tf\n`));
  if (opts.charSpace) parts.push(te(`${opts.charSpace} Tc\n`));
  parts.push(te(`${x} ${y} Td\n`));
  parts.push(te("("));
  parts.push(pdfString(str));
  parts.push(te(") Tj\n"));
  parts.push(te("ET\n"));
  return concat(parts);
}

// Average Helvetica glyph width as a fraction of font size (rough, but close
// enough for right/center-aligning short lines of Latin text).
const AVG_CHAR_W = { regular: 0.5, bold: 0.545 };
function estWidth(str, size, bold) {
  return str.length * size * AVG_CHAR_W[bold ? "bold" : "regular"];
}
function textRight(xRight, y, size, str, opts = {}) {
  const x = xRight - estWidth(str, size, opts.bold);
  return text(x, y, size, str, opts);
}
function textCenter(xCenter, y, size, str, opts = {}) {
  const x = xCenter - estWidth(str, size, opts.bold) / 2;
  return text(x, y, size, str, opts);
}

function rect(x, y, w, h, color) {
  return te(`${color[0]} ${color[1]} ${color[2]} rg\n${x} ${y} ${w} ${h} re f\n`);
}

function line(x1, y1, x2, y2, color, width) {
  return te(`${color[0]} ${color[1]} ${color[2]} RG\n${width} w\n${x1} ${y1} m ${x2} ${y2} l S\n`);
}

const PURPLE = [0.486, 0.227, 0.929]; // #7C3AED
const PINK = [0.925, 0.286, 0.6]; // #EC4899-ish
const INK = [0.067, 0.067, 0.078]; // #111114
const MUTED = [0.42, 0.42, 0.455]; // #6b6b74
const BORDER = [0.914, 0.906, 0.937]; // #e9e7ef

// millimetres -> PDF points (1mm = 2.834645669pt)
const MM = 2.834645669;
function fromTop(mm) { return PAGE_H - mm * MM; }
const LEFT_X = 20 * MM; // DIN 5008 left margin
const RIGHT_X = 190 * MM; // DIN 5008 right content edge (20mm from right on A4)

/**
 * Build a one-page booking-confirmation PDF.
 * @param {object} data
 * @param {string} data.bookingRef
 * @param {string} data.customerName
 * @param {string[]} data.breadcrumb - ordered list of selection labels
 * @param {string} data.date - ISO yyyy-mm-dd
 * @param {string} data.dateDisplay - human readable date, already localized
 * @param {string} data.time
 * @param {number} data.duration - minutes
 * @param {string} data.priceText - already formatted ("€39" or "Preis nach Diagnose")
 * @param {"de"|"en"} data.lang
 * @returns {Uint8Array}
 */
export function generateBookingPdf(data) {
  const L = data.lang === "en"
    ? {
        title: "Booking Confirmation",
        ref: "Booking reference",
        subject: (ref) => `Subject: Booking confirmation ${ref}`,
        hi: (n) => `Dear ${n},`,
        intro: "thank you for booking with Zettly. Please find your appointment details below:",
        service: "Service",
        date: "Date",
        time: "Time",
        duration: "Duration",
        price: "Price",
        minutes: "min",
        footer1: "Need to reschedule or cancel? Just reply to the confirmation email.",
        closing1: "Kind regards,",
        closing2: "The Zettly Team",
        addrTo: (n) => n,
        senderLine: "Zettly | kontakt@zettly.de | Munich, Germany",
        footerBar: "Zettly | IT support for home & business | Munich, Germany | kontakt@zettly.de | www.zettly.de",
        place: (d) => `Munich, ${d}`,
      }
    : {
        title: "Buchungsbestätigung",
        ref: "Buchungsnummer",
        subject: (ref) => `Betreff: Buchungsbestätigung ${ref}`,
        hi: (n) => `Sehr geehrte(r) ${n},`,
        intro: "vielen Dank für Ihre Buchung bei Zettly. Nachfolgend finden Sie Ihre Termindetails:",
        service: "Leistung",
        date: "Datum",
        time: "Uhrzeit",
        duration: "Dauer",
        price: "Preis",
        minutes: "Min.",
        footer1: "Termin umbuchen oder stornieren? Antworten Sie einfach auf die Bestätigungs-E-Mail.",
        closing1: "Mit freundlichen Grüßen",
        closing2: "Ihr Zettly-Team",
        addrTo: (n) => n,
        senderLine: "Zettly | kontakt@zettly.de | München, Deutschland",
        footerBar: "Zettly | IT-Support für Zuhause & Unternehmen | München, Deutschland | kontakt@zettly.de | www.zettly.de",
        place: (d) => `München, ${d}`,
      };

  const today = new Date().toLocaleDateString(data.lang === "en" ? "en-GB" : "de-DE", {
    day: "2-digit", month: "2-digit", year: "numeric",
  });

  const content = [];

  // ---- Letterhead (top-left wordmark, top-right sender contact block) ----
  content.push(text(LEFT_X, fromTop(18), 19, "zettly", { bold: true, color: PURPLE }));
  content.push(rect(LEFT_X, fromTop(21.2), 26, 2, PINK));

  const headerLines = data.lang === "en"
    ? ["Zettly", "Munich, Germany", "kontakt@zettly.de | www.zettly.de"]
    : ["Zettly", "München, Deutschland", "kontakt@zettly.de | www.zettly.de"];
  headerLines.forEach((l, i) => {
    content.push(textRight(RIGHT_X, fromTop(13 + i * 4.6), 8.5, l, { color: MUTED }));
  });

  content.push(line(LEFT_X, fromTop(30), RIGHT_X, fromTop(30), BORDER, 1));

  // ---- DIN 5008 window-envelope address field ----
  // Small sender return line, then the recipient block beneath it, both
  // positioned to sit inside a standard C6/5 (DL) window envelope.
  content.push(text(LEFT_X, fromTop(50), 7.5, data.lang === "en"
    ? "Zettly, Munich, Germany"
    : "Zettly, München, Deutschland", { color: MUTED, charSpace: 0.2 }));
  content.push(line(LEFT_X, fromTop(51.6), LEFT_X + 78 * MM, fromTop(51.6), BORDER, 0.6));

  content.push(text(LEFT_X, fromTop(61), 11, L.addrTo(data.customerName), { bold: true, color: INK }));
  content.push(text(LEFT_X, fromTop(66.5), 9.5, data.customerEmail || "", { color: MUTED }));

  // ---- Place/date, right-aligned above the subject line ----
  content.push(textRight(RIGHT_X, fromTop(92), 9.5, L.place(today), { color: MUTED }));

  // ---- Subject line ----
  content.push(rect(LEFT_X, fromTop(102.8), 3, 11, PINK));
  content.push(text(LEFT_X + 8, fromTop(102), 11.5, L.subject(data.bookingRef), { bold: true, color: INK }));

  // ---- Booking reference badge, right-aligned under the subject ----
  const refLabel = `${L.ref}: ${data.bookingRef}`;
  content.push(textRight(RIGHT_X, fromTop(102), 10, refLabel, { bold: true, color: PURPLE }));

  // ---- Body ----
  let y = fromTop(116);
  content.push(text(LEFT_X, y, 10.5, L.hi(data.customerName), { color: INK }));
  y -= 16;
  const introLines = wrapText(L.intro, 92);
  for (const il of introLines) {
    content.push(text(LEFT_X, y, 10.5, il, { color: INK }));
    y -= 14;
  }
  y -= 10;

  // Breadcrumb of selections
  content.push(text(LEFT_X, y, 8.5, L.service.toUpperCase(), { color: MUTED }));
  y -= 14;
  const crumbStr = data.breadcrumb.join("  ›  ");
  const crumbLines = wrapText(crumbStr, 82);
  for (const cl of crumbLines) {
    content.push(text(LEFT_X, y, 11, cl, { bold: true, color: PURPLE }));
    y -= 15;
  }
  y -= 8;

  content.push(line(LEFT_X, y, RIGHT_X, y, BORDER, 1));
  y -= 24;

  // Detail rows: Date / Time / Duration / Price
  const rows = [
    [L.date, data.dateDisplay],
    [L.time, data.time],
    [L.duration, `${data.duration} ${L.minutes}`],
    [L.price, data.priceText],
  ];
  for (const [label, value] of rows) {
    content.push(text(LEFT_X, y, 9, label.toUpperCase(), { color: MUTED }));
    content.push(text(LEFT_X + 170, y, 11.5, value, { bold: true, color: INK }));
    y -= 20;
  }

  y -= 10;
  content.push(line(LEFT_X, y, RIGHT_X, y, BORDER, 1));
  y -= 22;

  content.push(text(LEFT_X, y, 9.5, L.footer1, { color: MUTED }));
  y -= 34;
  content.push(text(LEFT_X, y, 10, L.closing1, { color: INK }));
  y -= 15;
  content.push(text(LEFT_X, y, 10, L.closing2, { bold: true, color: PURPLE }));

  // ---- Letter footer bar (company info strip at the bottom of the page) ----
  content.push(line(LEFT_X, fromTop(272), RIGHT_X, fromTop(272), BORDER, 1));
  content.push(rect(LEFT_X, fromTop(276.5), 22, 1.6, PINK));
  content.push(textCenter((LEFT_X + RIGHT_X) / 2, fromTop(278), 7.5, L.footerBar, { color: MUTED }));

  const contentStream = concat(content);

  // ---- Assemble the PDF object graph ----
  const objects = [];
  objects.push(te("<< /Type /Catalog /Pages 2 0 R >>"));
  objects.push(te("<< /Type /Pages /Kids [3 0 R] /Count 1 >>"));
  objects.push(te(
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] ` +
    `/Resources << /Font << /F1 4 0 R /F2 5 0 R >> >> /Contents 6 0 R >>`
  ));
  objects.push(te("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>"));
  objects.push(te("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>"));
  objects.push(concat([
    te(`<< /Length ${contentStream.length} >>\nstream\n`),
    contentStream,
    te("\nendstream"),
  ]));

  const chunks = [te("%PDF-1.4\n")];
  const offsets = [];
  let pos = chunks[0].length;

  objects.forEach((objBytes, i) => {
    offsets.push(pos);
    const head = te(`${i + 1} 0 obj\n`);
    const tail = te("\nendobj\n");
    chunks.push(head, objBytes, tail);
    pos += head.length + objBytes.length + tail.length;
  });

  const xrefStart = pos;
  const xrefLines = [`xref`, `0 ${objects.length + 1}`, `0000000000 65535 f `];
  for (const off of offsets) {
    xrefLines.push(String(off).padStart(10, "0") + " 00000 n ");
  }
  const xref = te(xrefLines.join("\n") + "\n");
  const trailer = te(
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`
  );

  chunks.push(xref, trailer);
  return concat(chunks);
}

export function toBase64(bytes) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  // btoa is available in the Workers runtime.
  return btoa(binary);
}
