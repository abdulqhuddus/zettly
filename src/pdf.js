// Minimal, dependency-free PDF generator for booking confirmations.
// Cloudflare Workers can't easily bundle native/Node-only PDF libraries, so
// this hand-builds a valid single-page PDF from scratch.
//
// Every font used is embedded, rather than relying on the 14 "standard"
// PDF fonts every viewer ships with: those aren't actual font files, so
// each viewer substitutes its own metrically-*similar* stand-in (Nimbus
// Sans, Liberation Sans, etc.), and small real differences between those
// substitutes and the Adobe AFM metrics this file used to lay text out
// against showed up as a few points of drift in right-aligned text --
// worse on longer lines, since it compounds per character. Embedding real
// font files means the glyph widths used to *position* text are exactly
// the widths the viewer will *render* it with, in every viewer.
//   - Body text: Liberation Sans (regular + bold), metrically compatible
//     with Arial/Helvetica, under the SIL Open Font License.
//   - The "zettly" wordmark: the site's brand font is Helvetica Neue at
//     weight 200, a commercial Linotype face that can't legally be
//     embedded without a purchased license, so the wordmark is set in
//     DejaVu Sans ExtraLight instead -- a real weight-200 sans-serif
//     under a license that explicitly permits embedding.

import { DEJAVU_EXTRALIGHT_BASE64 } from "./fonts/dejavu-extralight-base64.js";
import { LIBERATION_REGULAR_BASE64 } from "./fonts/liberation-regular-base64.js";
import { LIBERATION_BOLD_BASE64 } from "./fonts/liberation-bold-base64.js";
import { parseTTF } from "./ttf.js";

function base64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// Each parsed once per isolate and reused across every PDF generated in it.
let _regularFont = null, _boldFont = null, _wordmarkFont = null;
function regularFont() {
  if (!_regularFont) _regularFont = parseTTF(base64ToBytes(LIBERATION_REGULAR_BASE64));
  return _regularFont;
}
function boldFont() {
  if (!_boldFont) _boldFont = parseTTF(base64ToBytes(LIBERATION_BOLD_BASE64));
  return _boldFont;
}
function wordmarkFont() {
  if (!_wordmarkFont) _wordmarkFont = parseTTF(base64ToBytes(DEJAVU_EXTRALIGHT_BASE64));
  return _wordmarkFont;
}

// WinAnsiEncoding and Unicode agree everywhere except the 0x80-0x9F block
// (WinAnsi puts Euro, smart quotes, etc. there); 0xA0-0xFF (Latin-1
// Supplement, our German umlauts/eszett) map straight across.
const WINANSI_HIGH = {
  0x80: 0x20ac, 0x82: 0x201a, 0x83: 0x0192, 0x84: 0x201e, 0x85: 0x2026,
  0x86: 0x2020, 0x87: 0x2021, 0x88: 0x02c6, 0x89: 0x2030, 0x8a: 0x0160,
  0x8b: 0x2039, 0x8c: 0x0152, 0x8e: 0x017d, 0x91: 0x2018, 0x92: 0x2019,
  0x93: 0x201c, 0x94: 0x201d, 0x95: 0x2022, 0x96: 0x2013, 0x97: 0x2014,
  0x98: 0x02dc, 0x99: 0x2122, 0x9a: 0x0161, 0x9b: 0x203a, 0x9c: 0x0153,
  0x9e: 0x017e, 0x9f: 0x0178,
};
function winAnsiCodeToUnicode(code) {
  if (code >= 0x80 && code <= 0x9f) return WINANSI_HIGH[code] || code;
  return code; // ASCII and Latin-1 Supplement both match Unicode directly
}

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

// Map one character to its WinAnsiEncoding byte code (matches Latin-1 for
// the German umlauts we need; a handful of typographic characters are
// remapped to the WinAnsi position that actually carries them).
function toWinAnsiByte(ch) {
  const cp = ch.codePointAt(0);
  if (cp === 0x20ac) return 0x80; // €
  if (cp === 0x2013 || cp === 0x2014) return 0x2d; // en/em dash -> hyphen
  if (cp === 0x2018 || cp === 0x2019) return 0x27; // curly quotes -> '
  if (cp === 0x201c || cp === 0x201d) return 0x22; // curly double quotes -> "
  if (cp === 0x203a) return 0x9b; // › (WinAnsi position)
  if (cp === 0x2039) return 0x8b; // ‹ (WinAnsi position)
  if (cp <= 0xff) return cp;
  return 0x3f; // '?' fallback for anything else
}

function toWinAnsiBytes(str) {
  const bytes = [];
  for (const ch of str) bytes.push(toWinAnsiByte(ch));
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
  const font = opts.wordmarkFont ? "F3" : opts.bold ? "F2" : "F1";
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

// Real glyph widths (per 1000 em) read straight out of the embedded
// Liberation Sans font's own metrics -- the exact font the PDF actually
// draws with, so this can never drift from what gets rendered the way a
// static Adobe-AFM table (tuned against one particular viewer's Helvetica
// substitute) could.
function charWidthUnits(ch, bold) {
  const font = bold ? boldFont() : regularFont();
  const unicode = winAnsiCodeToUnicode(toWinAnsiByte(ch));
  const w = font.widthForChar(unicode);
  return w == null ? (bold ? 611 : 556) : w; // fallback: roughly average glyph width
}
function estWidth(str, size, bold) {
  let units = 0;
  for (const ch of str) units += charWidthUnits(ch, bold);
  return (units / 1000) * size;
}

// Width of a string set in the embedded wordmark font (DejaVu Sans
// ExtraLight), reading real advance widths out of its own hmtx table
// instead of the Helvetica AFM tables above.
function estWordmarkWidth(str, size) {
  const font = wordmarkFont();
  let units = 0;
  for (const ch of str) {
    const w = font.widthForChar(ch.codePointAt(0));
    units += w == null ? 556 : w; // fallback: roughly average glyph width
  }
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
 * @param {string} data.priceText - the total, already formatted ("€39" or "Preis nach Diagnose"); shown as the only price row when there's no call-out fee, or as the bold total row when there is one
 * @param {string} [data.servicePriceText] - the service price alone, before any call-out fee; only used (and required) when data.commuteFee > 0
 * @param {number} [data.commuteFee] - the distance-based call-out fee in whole euros; > 0 splits the price into Price / Call-out fee / Total rows
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
        callout: "Call-out fee",
        total: "Total",
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
        // ---- Cancellation-mode strings (data.cancelled: true) ----
        boxTitleCancelled: "CANCELLED BOOKING",
        subjectCancelled: (ref) => `Subject: Cancellation confirmation ${ref}`,
        introCancelled: "your booking below has been cancelled as requested. This letter is your confirmation of the cancellation.",
        introCancelledByAdmin: "your booking below has been cancelled by our team. This letter is your confirmation of the cancellation.",
        reasonLabel: "Reason for cancellation",
        rebookMsg: "If you'd like to book a new appointment, feel free to visit our website again.",
        cancelledStatusNote: "No further action is needed. If you did not request this cancellation, please contact us immediately at kontakt@zettly.de.",
        cancelledStatusNoteByAdmin: "No further action is needed. If you have any questions about this cancellation, please contact us at kontakt@zettly.de.",
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
        callout: "Anfahrtspauschale",
        total: "Gesamt",
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
        // ---- Stornierungs-Modus (data.cancelled: true) ----
        boxTitleCancelled: "STORNIERTE BUCHUNG",
        subjectCancelled: (ref) => `Betreff: Stornierungsbestätigung ${ref}`,
        introCancelled: "Ihre unten stehende Buchung wurde wie gewünscht storniert. Dieses Schreiben ist Ihre Stornierungsbestätigung.",
        introCancelledByAdmin: "Ihre unten stehende Buchung wurde von unserem Team storniert. Dieses Schreiben ist Ihre Stornierungsbestätigung.",
        reasonLabel: "Grund der Stornierung",
        rebookMsg: "Falls Sie einen neuen Termin buchen möchten, besuchen Sie gerne erneut unsere Website.",
        cancelledStatusNote: "Es ist keine weitere Aktion erforderlich. Falls Sie diese Stornierung nicht veranlasst haben, kontaktieren Sie uns bitte umgehend unter kontakt@zettly.de.",
        cancelledStatusNoteByAdmin: "Es ist keine weitere Aktion erforderlich. Bei Fragen zu dieser Stornierung kontaktieren Sie uns gerne unter kontakt@zettly.de.",
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
  // The site's own letter-spacing is 0.01em (~0.17pt at this size) -- barely
  // perceptible. The previous 0.3pt value was tuned to visually widen plain
  // Helvetica's naturally tight advance widths; DejaVu Sans ExtraLight's own
  // widths already read correctly at the site's real spacing, so a heavier
  // value here just shows up as an obvious gap between every letter.
  const wordmarkCharSpace = 0.15;
  const wordmarkBaselineMM = logoCenterMM + 2.6; // optical baseline offset for a centered look
  // "zett" and "ly" are drawn as two separate runs (different colors), so
  // "ly" must start exactly where "zett" ends: its glyph width PLUS the
  // character-spacing (Tc) added after each of its 4 letters, including the
  // trailing one — leaving that out (or fudging it with an arbitrary
  // multiplier) is what let "ly" creep back and overlap the "t". Set in the
  // embedded DejaVu Sans ExtraLight (weight 200), matching the site's actual
  // Helvetica Neue 200 wordmark far more closely than plain Helvetica.
  const zettWidth = estWordmarkWidth("zett", wordmarkSize) + 4 * wordmarkCharSpace;
  content.push(text(LEFT_X + 11.5 * MM, fromTop(wordmarkBaselineMM), wordmarkSize, "zett", { color: INK, charSpace: wordmarkCharSpace, wordmarkFont: true }));
  content.push(text(LEFT_X + 11.5 * MM + zettWidth, fromTop(wordmarkBaselineMM), wordmarkSize, "ly", { color: PURPLE, charSpace: wordmarkCharSpace, wordmarkFont: true }));

  const headerLines = data.lang === "en"
    ? ["Zettly GmbH", "Musterstrasse 12, 80331 Munich", "kontakt@zettly.de | www.zettly.de"]
    : ["Zettly GmbH", "Musterstraße 12, 80331 München", "kontakt@zettly.de | www.zettly.de"];
  // Vertically center the 3-line contact block on the same row as the logo:
  // total block height ~= 2 * headerLineGap; start half that above center.
  // (Kept as a tight, even gap between all three lines — there was no real
  // difference in the numbers before, but a slightly smaller, uniform gap
  // reads as more evenly set than 4.4mm did.)
  const headerLineGap = 4;
  const headerBlockStartMM = logoCenterMM - headerLineGap + 1.5;
  headerLines.forEach((l, i) => {
    content.push(textRight(RIGHT_X, fromTop(headerBlockStartMM + i * headerLineGap), 8.5, l, { color: MUTED }));
  });

  content.push(line(LEFT_X, fromTop(23), RIGHT_X, fromTop(23), BORDER, 1));

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
  // Sits just below the letterhead divider, right under the three-line
  // sender block on the same row, instead of leaving a large dead gap
  // between the letterhead and the table.
  const boxTop = 26; // mm from top
  const boxPad = 6; // left/right inset in pt, kept clear of the border on every row
  const boxInnerPt = boxW - boxPad * 2;
  const rowH = 8; // mm, for a normal single-line label/value row
  const stackedLineH = 4.3; // mm, per wrapped value line in a stacked row

  // A short value sits right-aligned next to its label on one line; a long
  // one (the email address) is stacked below its label, left-aligned, at a
  // font size guaranteed to fit boxInnerPt so it never crosses the border.
  function fitFontSize(value, startSize, maxWidthPt) {
    let size = startSize;
    while (size > 6 && estWidth(value, size, true) > maxWidthPt) size -= 0.5;
    return size;
  }

  // Word-wraps a stacked row's value to the box's actual inner width at its
  // point size (rather than shrinking font size indefinitely), so a longer
  // free-text value — the cancellation reason — wraps onto a few lines
  // instead of being squeezed unreadably small onto one.
  function wrapToWidthPt(str, size, maxWidthPt, bold) {
    const words = String(str).split(/\s+/).filter(Boolean);
    const lines = [];
    let cur = "";
    for (const w of words) {
      const candidate = cur ? `${cur} ${w}` : w;
      if (cur && estWidth(candidate, size, bold) > maxWidthPt) {
        lines.push(cur);
        cur = w;
      } else {
        cur = candidate;
      }
    }
    if (cur) lines.push(cur);
    return lines;
  }
  function stackedRowHeight(lineCount) {
    return 4.6 + lineCount * stackedLineH + 2.2;
  }

  const boxRows = [
    { label: L.ref, value: data.bookingRef, size: 9.5 },
    { label: L.date, value: data.dateDisplay, size: 9.5 },
    { label: L.time, value: data.time, size: 9.5 },
    { label: L.duration, value: `${data.duration} ${L.minutes}`, size: 9.5 },
  ];
  // The service price and the distance-based call-out fee are shown as
  // separate line items with a bold total underneath, rather than a single
  // merged figure, so the customer can see exactly what they're being
  // charged for.
  if (data.commuteFee > 0) {
    boxRows.push({ label: L.price, value: data.servicePriceText, size: 9.5 });
    boxRows.push({ label: L.callout, value: `+ €${data.commuteFee}`, size: 9.5 });
    boxRows.push({ label: L.total, value: data.priceText, size: 9.5, bold: true });
  } else {
    boxRows.push({ label: L.price, value: data.priceText, size: 9.5 });
  }
  if (data.cancelled && data.cancellationReason) {
    const reasonSize = 9;
    const reasonLines = wrapToWidthPt(data.cancellationReason, reasonSize, boxInnerPt, true).slice(0, 4);
    boxRows.push({ label: L.reasonLabel, lines: reasonLines, size: reasonSize, stacked: true });
  }
  if (data.customerEmail) {
    boxRows.push({
      label: L.email,
      lines: [data.customerEmail],
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
  const boxHeaderColor = data.cancelled ? DANGER : PURPLE;
  const boxTitleText = data.cancelled ? L.boxTitleCancelled : L.boxTitle;
  const boxH = headerH + boxRows.reduce((sum, r) => sum + (r.stacked ? stackedRowHeight(r.lines.length) : rowH), 0);
  content.push(strokeRect(boxX, fromTop(boxTop + boxH), boxW, boxH * MM, BORDER, 1));
  content.push(rect(boxX, fromTop(boxTop + headerH), boxW, headerH * MM, boxHeaderColor));
  // Vertically center the header title inside the colored bar: place the
  // baseline half a cap-height below the bar's vertical midpoint, rather
  // than a fixed offset from the top (which left it sitting too high).
  const headerTitleSize = 8.5;
  const headerCapHeightMM = (headerTitleSize * 0.7) / MM;
  const headerBaselineMM = boxTop + headerH / 2 + headerCapHeightMM / 2;
  content.push(textCenter(boxX + boxW / 2, fromTop(headerBaselineMM), headerTitleSize, boxTitleText, { bold: true, color: [1, 1, 1] }));
  let rowCursor = boxTop + headerH;
  boxRows.forEach((row, i) => {
    const h = row.stacked ? stackedRowHeight(row.lines.length) : rowH;
    if (i > 0) content.push(line(boxX, fromTop(rowCursor), boxX + boxW, fromTop(rowCursor), BORDER, 0.6));
    if (row.stacked) {
      content.push(text(boxX + boxPad, fromTop(rowCursor + 4.6), 7.5, row.label.toUpperCase(), { color: MUTED }));
      row.lines.forEach((ln, li) => {
        content.push(text(boxX + boxPad, fromTop(rowCursor + 9.6 + li * stackedLineH), row.size, ln, { bold: true, color: INK }));
      });
    } else {
      // The total row (when a call-out fee splits the price into line
      // items) is picked out in the brand color so it reads as the bottom
      // line, not just another row.
      const emphasisColor = row.bold ? PURPLE : INK;
      content.push(text(boxX + boxPad, fromTop(rowCursor + 5.3), 7.5, row.label.toUpperCase(), { color: row.bold ? PURPLE : MUTED }));
      content.push(textRight(boxX + boxW - boxPad, fromTop(rowCursor + 5.3), row.size, row.value, { bold: true, color: emphasisColor }));
    }
    rowCursor += h;
  });

  // ---- Place/date, right-aligned above the subject line ----
  const belowBlockY = Math.max(70, boxTop + boxH + 8, addrY + 6);
  content.push(textRight(RIGHT_X, fromTop(belowBlockY), 9.5, L.place(today), { color: MUTED }));

  // ---- Subject line ----
  const subjectText = data.cancelled ? L.subjectCancelled(data.bookingRef) : L.subject(data.bookingRef);
  const introText = data.cancelled
    ? (data.cancelledBy === "admin" ? L.introCancelledByAdmin : L.introCancelled)
    : L.intro;
  content.push(rect(LEFT_X, fromTop(belowBlockY + 11.8), 3, 11, data.cancelled ? DANGER : PINK));
  content.push(text(LEFT_X + 8, fromTop(belowBlockY + 11), 11.5, subjectText, { bold: true, color: INK }));

  // ---- Body ----
  let y = fromTop(belowBlockY + 25);
  content.push(text(LEFT_X, y, 10.5, L.hi(data.customerName), { color: INK }));
  y -= 16;
  const introLines = wrapText(introText, 92);
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

  // ---- Callout: a clearly set-off, colored box so this isn't just another
  // paragraph of grey small print — the cancellation policy on a booking
  // confirmation, or the cancellation itself being confirmed on a
  // cancellation letter. ----
  const calloutPadX = 10;
  const calloutPadTop = 10;
  const calloutPadBottom = 10;
  const calloutHeadingSize = 10;
  const calloutBodySize = 9.5;
  const calloutHeadingGap = 14;
  const calloutBodyLineGap = 12.5;
  const calloutColor = DANGER;
  const calloutBgColor = DANGER_BG;
  const calloutBodyText = data.cancelled
    ? (data.cancelledBy === "admin" ? L.cancelledStatusNoteByAdmin : L.cancelledStatusNote)
    : L.footer1;
  const calloutBodyLines = wrapText(calloutBodyText, 86);
  const calloutInnerH = calloutHeadingGap + calloutBodyLines.length * calloutBodyLineGap;
  const calloutH = calloutPadTop + calloutInnerH + calloutPadBottom;
  const calloutTopY = y;
  const calloutBottomY = calloutTopY - calloutH;
  content.push(rect(LEFT_X, calloutBottomY, RIGHT_X - LEFT_X, calloutH, calloutBgColor));
  content.push(rect(LEFT_X, calloutBottomY, 3, calloutH, calloutColor));

  let cy = calloutTopY - calloutPadTop - calloutHeadingSize * 0.8;
  content.push(text(LEFT_X + calloutPadX, cy, calloutHeadingSize, data.cancelled ? L.boxTitleCancelled : L.cancelHeading, { bold: true, color: calloutColor }));
  cy -= calloutHeadingGap;
  for (const bl of calloutBodyLines) {
    content.push(text(LEFT_X + calloutPadX, cy, calloutBodySize, bl, { color: INK }));
    cy -= calloutBodyLineGap;
  }
  y = calloutBottomY - 16;

  if (data.cancelled) {
    const rebookLines = wrapText(L.rebookMsg, 92);
    for (const rl of rebookLines) {
      content.push(text(LEFT_X, y, 9.5, rl, { color: MUTED }));
      y -= 13;
    }
    y -= 5;
  } else {
    const noteLines = wrapText(L.footer2note, 92);
    for (const nl of noteLines) {
      content.push(text(LEFT_X, y, 8, nl, { color: MUTED }));
      y -= 11;
    }
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
  // Every font is embedded (see the file-header comment for why), so each
  // needs its own raw-file stream + FontDescriptor behind its Font dict.
  // Object numbers are fixed in this order: 1 Catalog, 2 Pages, 3 Page,
  // 4 Font F1 (regular), 5 Font F2 (bold), 6 content stream, 7/8 F1's
  // FontFile2+FontDescriptor, 9/10 F2's, 11/12 F3 (wordmark)'s, 13 Font F3.
  function widthsArray(font, firstChar, lastChar) {
    const widths = [];
    for (let c = firstChar; c <= lastChar; c++) {
      const w = font.widthForChar(winAnsiCodeToUnicode(c));
      widths.push(w == null ? 556 : w);
    }
    return widths;
  }
  function fontFileStream(font) {
    return concat([
      te(`<< /Length ${font.raw.length} /Length1 ${font.raw.length} >>\nstream\n`),
      font.raw,
      te("\nendstream"),
    ]);
  }

  const rf = regularFont();
  const bf = boldFont();
  const wf = wordmarkFont();
  // WinAnsiEncoding's full printable range: ASCII (32-126) plus the Latin-1
  // Supplement block (160-255) that carries the German umlauts/eszett, plus
  // the handful of typographic characters WinAnsi keeps at 128-159 (€, etc).
  const rfWidths = widthsArray(rf, 32, 255);
  const bfWidths = widthsArray(bf, 32, 255);
  const wfWidths = widthsArray(wf, 32, 126);

  const objects = [];
  objects.push(te("<< /Type /Catalog /Pages 2 0 R >>")); // 1
  objects.push(te("<< /Type /Pages /Kids [3 0 R] /Count 1 >>")); // 2
  objects.push(te(
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] ` +
    `/Resources << /Font << /F1 4 0 R /F2 5 0 R /F3 13 0 R >> >> /Contents 6 0 R >>`
  )); // 3
  objects.push(te(
    `<< /Type /Font /Subtype /TrueType /BaseFont /LiberationSans /FirstChar 32 /LastChar 255 ` +
    `/Widths [${rfWidths.join(" ")}] /Encoding /WinAnsiEncoding /FontDescriptor 8 0 R >>`
  )); // 4
  objects.push(te(
    `<< /Type /Font /Subtype /TrueType /BaseFont /LiberationSans-Bold /FirstChar 32 /LastChar 255 ` +
    `/Widths [${bfWidths.join(" ")}] /Encoding /WinAnsiEncoding /FontDescriptor 10 0 R >>`
  )); // 5
  objects.push(concat([
    te(`<< /Length ${contentStream.length} >>\nstream\n`),
    contentStream,
    te("\nendstream"),
  ])); // 6
  objects.push(fontFileStream(rf)); // 7
  objects.push(te(
    `<< /Type /FontDescriptor /FontName /LiberationSans /Flags 32 ` +
    `/FontBBox [${rf.bbox.join(" ")}] /ItalicAngle ${rf.italicAngle} /Ascent ${rf.ascent} ` +
    `/Descent ${rf.descent} /CapHeight ${rf.capHeight} /StemV 80 /FontFile2 7 0 R >>`
  )); // 8
  objects.push(fontFileStream(bf)); // 9
  objects.push(te(
    `<< /Type /FontDescriptor /FontName /LiberationSans-Bold /Flags 32 /ForceBold true ` +
    `/FontBBox [${bf.bbox.join(" ")}] /ItalicAngle ${bf.italicAngle} /Ascent ${bf.ascent} ` +
    `/Descent ${bf.descent} /CapHeight ${bf.capHeight} /StemV 140 /FontFile2 9 0 R >>`
  )); // 10
  objects.push(fontFileStream(wf)); // 11
  objects.push(te(
    `<< /Type /FontDescriptor /FontName /DejaVuSansExtraLight /Flags 32 ` +
    `/FontBBox [${wf.bbox.join(" ")}] /ItalicAngle ${wf.italicAngle} /Ascent ${wf.ascent} ` +
    `/Descent ${wf.descent} /CapHeight ${wf.capHeight} /StemV 50 /FontFile2 11 0 R >>`
  )); // 12
  objects.push(te(
    `<< /Type /Font /Subtype /TrueType /BaseFont /DejaVuSansExtraLight /FirstChar 32 /LastChar 126 ` +
    `/Widths [${wfWidths.join(" ")}] /Encoding /WinAnsiEncoding /FontDescriptor 12 0 R >>`
  )); // 13

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
