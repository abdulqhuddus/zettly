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

// Real Adobe Core-14 AFM glyph widths (per 1000 em) for Helvetica /
// Helvetica-Bold, codes 32-126, plus the handful of German/Euro glyphs this
// site actually needs. Using the real metrics (rather than a flat average
// per character) is what makes right/center-aligned text land exactly on
// the intended edge instead of drifting — a short line full of narrow
// glyphs (i, l, ., @, |) was previously being placed too far left, leaving
// a visible gap on the right; a line full of wide glyphs (digits, capitals)
// could run past the edge, as with a booking reference or email address.
const HELV_WIDTHS = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
  1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
  333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,
  556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];
const HELV_BOLD_WIDTHS = [
  278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611,
  975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556,
  333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611,
  611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584,
];
// Extended glyphs beyond ASCII (German umlauts/eszett/Euro), by character.
const EXTRA_WIDTHS = {
  regular: { ä: 556, ö: 556, ü: 556, Ä: 667, Ö: 778, Ü: 722, ß: 611, é: 556, É: 667, "€": 556 },
  bold: { ä: 611, ö: 611, ü: 611, Ä: 722, Ö: 778, Ü: 722, ß: 611, é: 556, É: 722, "€": 556 },
};
function charWidthUnits(ch, bold) {
  const code = ch.codePointAt(0);
  if (code >= 32 && code <= 126) return (bold ? HELV_BOLD_WIDTHS : HELV_WIDTHS)[code - 32];
  const extra = EXTRA_WIDTHS[bold ? "bold" : "regular"][ch];
  if (extra) return extra;
  return bold ? 611 : 556; // fallback: roughly Helvetica's average glyph width
}
function estWidth(str, size, bold) {
  let units = 0;
  for (const ch of str) units += charWidthUnits(ch, bold);
  return (units / 1000) * size;
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

function strokeRect(x, y, w, h, color, width) {
  return te(`${color[0]} ${color[1]} ${color[2]} RG\n${width} w\n${x} ${y} ${w} ${h} re S\n`);
}

function line(x1, y1, x2, y2, color, width) {
  return te(`${color[0]} ${color[1]} ${color[2]} RG\n${width} w\n${x1} ${y1} m ${x2} ${y2} l S\n`);
}

// A filled rectangle with rounded corners, drawn as a vector path (4 straight
// edges + 4 cubic-bezier corners), used for the letterhead logo mark so it
// matches the site's actual rounded-square brand mark instead of plain rects.
function roundedRect(x, y, w, h, r, color) {
  r = Math.min(r, w / 2, h / 2);
  const k = 0.5522847498 * r; // bezier magic number for a quarter circle
  const parts = [];
  parts.push(te(`${color[0]} ${color[1]} ${color[2]} rg\n`));
  parts.push(te(`${x + r} ${y} m\n`));
  parts.push(te(`${x + w - r} ${y} l\n`));
  parts.push(te(`${x + w - r + k} ${y} ${x + w} ${y + r - k} ${x + w} ${y + r} c\n`));
  parts.push(te(`${x + w} ${y + h - r} l\n`));
  parts.push(te(`${x + w} ${y + h - r + k} ${x + w - r + k} ${y + h} ${x + w - r} ${y + h} c\n`));
  parts.push(te(`${x + r} ${y + h} l\n`));
  parts.push(te(`${x + r - k} ${y + h} ${x} ${y + h - r + k} ${x} ${y + h - r} c\n`));
  parts.push(te(`${x} ${y + r} l\n`));
  parts.push(te(`${x} ${y + r - k} ${x + r - k} ${y} ${x + r} ${y} c\n`));
  parts.push(te("f\n"));
  return concat(parts);
}

const PURPLE = [0.486, 0.227, 0.929]; // #7C3AED
const PINK = [0.925, 0.286, 0.6]; // #EC4899-ish
const INK = [0.067, 0.067, 0.078]; // #111114
const MUTED = [0.42, 0.42, 0.455]; // #6b6b74
const BORDER = [0.914, 0.906, 0.937]; // #e9e7ef
const DANGER = [0.761, 0.094, 0.357]; // #c2185b, matches the site's cancel/danger accent
const DANGER_BG = [0.992, 0.933, 0.949]; // #fdeef2

// millimetres -> PDF points (1mm = 2.834645669pt)
const MM = 2.834645669;
function fromTop(mm) { return PAGE_H - mm * MM; }
const LEFT_X = 20 * MM; // DIN 5008 left margin
const RIGHT_X = 190 * MM; // DIN 5008 right content edge (20mm from right on A4)

// The 4-square brand mark used in the site header (m1..m4), drawn to scale
// at (xMM, yTopMM) with a given size in mm, so the letterhead carries an
// actual logo mark rather than just the wordmark.
function drawLogoMark(content, xMM, yTopMM, sizeMM) {
  const s = (sizeMM * MM) / 100; // scale factor: 100 SVG units -> sizeMM
  const x0 = xMM * MM;
  const yTop = fromTop(yTopMM);
  const sq = (svgX, svgY, svgW, svgH, r, color) => {
    const px = x0 + svgX * s;
    const py = yTop - svgY * s - svgH * s;
    content.push(roundedRect(px, py, svgW * s, svgH * s, r * s, color));
  };
  sq(0, 0, 28, 28, 6, PURPLE);
  sq(36, 0, 64, 64, 14, INK);
  sq(0, 36, 64, 64, 14, PURPLE);
  sq(72, 72, 28, 28, 6, INK);
}

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
        ref: "Booking ref.",
        boxTitle: "BOOKING DETAILS",
        subject: (ref) => `Subject: Booking confirmation ${ref}`,
        hi: (n) => `Dear ${n},`,
        intro: "thank you for booking with Zettly. Please find your appointment details below:",
        service: "Service",
        date: "Date",
        time: "Time",
        duration: "Duration",
        price: "Price",
        email: "Email",
        minutes: "min",
        cancelHeading: "Cancellation policy",
        footer1: "You can cancel this booking free of charge up to 24 hours before your appointment, using the cancellation link in your confirmation email, or by contacting us at kontakt@zettly.de.",
        footer2note: "Please note: Zettly reserves the right to cancel or reschedule a booking in exceptional cases; we will inform you immediately if this happens.",
        closing1: "Kind regards,",
        closing2: "The Zettly Team",
        addrTo: (n) => n,
        senderLine: "Zettly | kontakt@zettly.de | Munich, Germany",
        footerBar: "Zettly | IT support for home & business | Munich, Germany | kontakt@zettly.de | www.zettly.de",
        place: (d) => `Munich, ${d}`,
      }
    : {
        title: "Buchungsbestätigung",
        ref: "Buchungsnr.",
        boxTitle: "BUCHUNGSDETAILS",
        subject: (ref) => `Betreff: Buchungsbestätigung ${ref}`,
        hi: (n) => `Sehr geehrte(r) ${n},`,
        intro: "vielen Dank für Ihre Buchung bei Zettly. Nachfolgend finden Sie Ihre Termindetails:",
        service: "Leistung",
        date: "Datum",
        time: "Uhrzeit",
        duration: "Dauer",
        price: "Preis",
        email: "E-Mail",
        minutes: "Min.",
        cancelHeading: "Stornierungsbedingungen",
        footer1: "Sie können diese Buchung bis 24 Stunden vor dem Termin kostenlos stornieren - über den Stornierungslink in Ihrer Bestätigungs-E-Mail oder per Kontakt an kontakt@zettly.de.",
        footer2note: "Bitte beachten Sie: Zettly behält sich das Recht vor, eine Buchung in Ausnahmefällen zu stornieren oder zu verschieben; wir informieren Sie in diesem Fall umgehend.",
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

  // ---- Letterhead: logo mark + wordmark top-left, sender contact top-right ----
  // Site wordmark is a LIGHT weight (CSS font-weight:200), not bold — the
  // hand-rolled PDF only ships standard Helvetica/Helvetica-Bold, so the
  // closest honest match is plain (non-bold) Helvetica with a touch of
  // letter-spacing, rather than a heavy bold face.
  const logoSizeMM = 9;
  const logoTopMM = 9;
  drawLogoMark(content, LEFT_X / MM, logoTopMM, logoSizeMM);
  const logoCenterMM = logoTopMM + logoSizeMM / 2;
  const wordmarkSize = 17;
  const wordmarkCharSpace = 0.3;
  const wordmarkBaselineMM = logoCenterMM + 2.6; // optical baseline offset for a centered look
  // "zett" and "ly" are drawn as two separate runs (different colors), so
  // "ly" must start exactly where "zett" ends: its glyph width PLUS the
  // character-spacing (Tc) added after each of its 4 letters, including the
  // trailing one — leaving that out (or fudging it with an arbitrary
  // multiplier) is what let "ly" creep back and overlap the "t".
  const zettWidth = estWidth("zett", wordmarkSize, false) + 4 * wordmarkCharSpace;
  content.push(text(LEFT_X + 11.5 * MM, fromTop(wordmarkBaselineMM), wordmarkSize, "zett", { color: INK, charSpace: wordmarkCharSpace }));
  content.push(text(LEFT_X + 11.5 * MM + zettWidth, fromTop(wordmarkBaselineMM), wordmarkSize, "ly", { color: PURPLE, charSpace: wordmarkCharSpace }));

  const headerLines = data.lang === "en"
    ? ["Zettly GmbH", "Musterstrasse 12, 80331 Munich", "kontakt@zettly.de | www.zettly.de"]
    : ["Zettly GmbH", "Musterstraße 12, 80331 München", "kontakt@zettly.de | www.zettly.de"];
  // Vertically center the 3-line contact block on the same row as the logo:
  // total block height ~= 2 * 4.4mm line-gap; start half that above center.
  const headerBlockStartMM = logoCenterMM - 4.4 + 1.5;
  headerLines.forEach((l, i) => {
    content.push(textRight(RIGHT_X, fromTop(headerBlockStartMM + i * 4.4), 8.5, l, { color: MUTED }));
  });

  content.push(line(LEFT_X, fromTop(28), RIGHT_X, fromTop(28), BORDER, 1));

  // ---- DIN 5008 window-envelope address field (left column) ----
  // Small sender return line, then the recipient block beneath it, both
  // positioned to sit inside a standard C6/5 (DL) window envelope.
  content.push(text(LEFT_X, fromTop(48), 7.5, data.lang === "en"
    ? "Zettly GmbH · Musterstrasse 12 · 80331 Munich"
    : "Zettly GmbH · Musterstraße 12 · 80331 München", { color: MUTED, charSpace: 0.2 }));
  content.push(line(LEFT_X, fromTop(49.6), LEFT_X + 78 * MM, fromTop(49.6), BORDER, 0.6));

  content.push(text(LEFT_X, fromTop(59), 11.5, L.addrTo(data.customerName), { bold: true, color: INK }));
  const addressLines = data.customerAddress ? wrapText(data.customerAddress, 46).slice(0, 2) : [];
  let addrY = 64.5;
  for (const al of addressLines) {
    content.push(text(LEFT_X, fromTop(addrY), 10, al, { color: INK }));
    addrY += 5;
  }

  // ---- Bordered booking-details box (right column), like a company quote/order box ----
  const boxX = 112 * MM;
  const boxW = RIGHT_X - boxX; // already in pt, like boxX/RIGHT_X
  const boxTop = 45; // mm from top
  const boxPad = 6; // left/right inset in pt, kept clear of the border on every row
  const boxInnerPt = boxW - boxPad * 2;
  const rowH = 8; // mm, for a normal single-line label/value row
  const stackedRowH = 12; // mm, for a row whose value sits on its own line below the label

  // A short value sits right-aligned next to its label on one line; a long
  // one (the email address) is stacked below its label, left-aligned, at a
  // font size guaranteed to fit boxInnerPt so it never crosses the border.
  function fitFontSize(value, startSize, maxWidthPt) {
    let size = startSize;
    while (size > 6 && estWidth(value, size, true) > maxWidthPt) size -= 0.5;
    return size;
  }

  const boxRows = [
    { label: L.ref, value: data.bookingRef, size: 9.5 },
    { label: L.date, value: data.dateDisplay, size: 9.5 },
    { label: L.time, value: data.time, size: 9.5 },
    { label: L.duration, value: `${data.duration} ${L.minutes}`, size: 9.5 },
    { label: L.price, value: data.priceText, size: 9.5 },
  ];
  if (data.customerEmail) {
    boxRows.push({
      label: L.email,
      value: data.customerEmail,
      size: fitFontSize(data.customerEmail, 9, boxInnerPt),
      stacked: true,
    });
  }
  // Shrink any inline value that would otherwise overrun the box (e.g. a
  // long booking reference) rather than letting it spill past the border.
  boxRows.forEach((row) => {
    if (!row.stacked) row.size = fitFontSize(row.value, row.size, boxInnerPt * 0.62);
  });

  const headerH = 8;
  const boxH = headerH + boxRows.reduce((sum, r) => sum + (r.stacked ? stackedRowH : rowH), 0);
  content.push(strokeRect(boxX, fromTop(boxTop + boxH), boxW, boxH * MM, BORDER, 1));
  content.push(rect(boxX, fromTop(boxTop + headerH), boxW, headerH * MM, PURPLE));
  // Vertically center the header title inside the purple bar: place the
  // baseline half a cap-height below the bar's vertical midpoint, rather
  // than a fixed offset from the top (which left it sitting too high).
  const headerTitleSize = 8.5;
  const headerCapHeightMM = (headerTitleSize * 0.7) / MM;
  const headerBaselineMM = boxTop + headerH / 2 + headerCapHeightMM / 2;
  content.push(textCenter(boxX + boxW / 2, fromTop(headerBaselineMM), headerTitleSize, L.boxTitle, { bold: true, color: [1, 1, 1] }));
  let rowCursor = boxTop + headerH;
  boxRows.forEach((row, i) => {
    const h = row.stacked ? stackedRowH : rowH;
    if (i > 0) content.push(line(boxX, fromTop(rowCursor), boxX + boxW, fromTop(rowCursor), BORDER, 0.6));
    if (row.stacked) {
      content.push(text(boxX + boxPad, fromTop(rowCursor + 4.6), 7.5, row.label.toUpperCase(), { color: MUTED }));
      content.push(text(boxX + boxPad, fromTop(rowCursor + 9.6), row.size, row.value, { bold: true, color: INK }));
    } else {
      content.push(text(boxX + boxPad, fromTop(rowCursor + 5.3), 7.5, row.label.toUpperCase(), { color: MUTED }));
      content.push(textRight(boxX + boxW - boxPad, fromTop(rowCursor + 5.3), row.size, row.value, { bold: true, color: INK }));
    }
    rowCursor += h;
  });

  // ---- Place/date, right-aligned above the subject line ----
  const belowBlockY = Math.max(70, boxTop + boxH + 8, addrY + 6);
  content.push(textRight(RIGHT_X, fromTop(belowBlockY), 9.5, L.place(today), { color: MUTED }));

  // ---- Subject line ----
  content.push(rect(LEFT_X, fromTop(belowBlockY + 11.8), 3, 11, PINK));
  content.push(text(LEFT_X + 8, fromTop(belowBlockY + 11), 11.5, L.subject(data.bookingRef), { bold: true, color: INK }));

  // ---- Body ----
  let y = fromTop(belowBlockY + 25);
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
  const crumbLines = wrapText(crumbStr, 100);
  for (const cl of crumbLines) {
    content.push(text(LEFT_X, y, 9, cl, { bold: true, color: PURPLE }));
    y -= 13;
  }
  y -= 14;

  content.push(line(LEFT_X, y, RIGHT_X, y, BORDER, 1));
  y -= 22;

  // ---- Cancellation policy callout: a clearly set-off, colored box so the
  // cancellation terms aren't just another paragraph of grey small print. ----
  const calloutPadX = 10;
  const calloutPadTop = 10;
  const calloutPadBottom = 10;
  const calloutHeadingSize = 10;
  const calloutBodySize = 9.5;
  const calloutHeadingGap = 14;
  const calloutBodyLineGap = 12.5;
  const calloutBodyLines = wrapText(L.footer1, 86);
  const calloutInnerH = calloutHeadingGap + calloutBodyLines.length * calloutBodyLineGap;
  const calloutH = calloutPadTop + calloutInnerH + calloutPadBottom;
  const calloutTopY = y;
  const calloutBottomY = calloutTopY - calloutH;
  content.push(rect(LEFT_X, calloutBottomY, RIGHT_X - LEFT_X, calloutH, DANGER_BG));
  content.push(rect(LEFT_X, calloutBottomY, 3, calloutH, DANGER));

  let cy = calloutTopY - calloutPadTop - calloutHeadingSize * 0.8;
  content.push(text(LEFT_X + calloutPadX, cy, calloutHeadingSize, L.cancelHeading, { bold: true, color: DANGER }));
  cy -= calloutHeadingGap;
  for (const bl of calloutBodyLines) {
    content.push(text(LEFT_X + calloutPadX, cy, calloutBodySize, bl, { color: INK }));
    cy -= calloutBodyLineGap;
  }
  y = calloutBottomY - 16;

  const noteLines = wrapText(L.footer2note, 92);
  for (const nl of noteLines) {
    content.push(text(LEFT_X, y, 8, nl, { color: MUTED }));
    y -= 11;
  }
  y -= 18;
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
