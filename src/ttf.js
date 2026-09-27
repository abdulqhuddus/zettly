// Minimal TrueType (.ttf) parser -- just enough to embed a font as a PDF
// simple TrueType font (FontFile2): sfnt table directory, head/hhea/maxp
// metrics, hmtx advance widths, a format-4 cmap for glyph lookup, and
// OS/2 for cap height. No glyph outlines are touched; the whole font file
// is embedded as-is and the PDF viewer's own rasterizer draws the glyphs.

function u16(buf, off) { return (buf[off] << 8) | buf[off + 1]; }
function i16(buf, off) { const v = u16(buf, off); return v >= 0x8000 ? v - 0x10000 : v; }
function u32(buf, off) { return (buf[off] * 0x1000000) + (buf[off + 1] << 16) + (buf[off + 2] << 8) + buf[off + 3]; }
function i32(buf, off) { const v = u32(buf, off); return v >= 0x80000000 ? v - 0x100000000 : v; }
function tag4(buf, off) { return String.fromCharCode(buf[off], buf[off + 1], buf[off + 2], buf[off + 3]); }

function readTableDirectory(buf) {
  const numTables = u16(buf, 4);
  const tables = {};
  for (let i = 0; i < numTables; i++) {
    const rec = 12 + i * 16;
    const tag = tag4(buf, rec);
    tables[tag] = { offset: u32(buf, rec + 8), length: u32(buf, rec + 12) };
  }
  return tables;
}

// Parses a format-4 cmap subtable into a Map<unicodeCodePoint, glyphId>.
function parseCmapFormat4(buf, off) {
  const segCountX2 = u16(buf, off + 6);
  const segCount = segCountX2 / 2;
  const endCodesOff = off + 14;
  const startCodesOff = endCodesOff + segCountX2 + 2;
  const idDeltaOff = startCodesOff + segCountX2;
  const idRangeOff = idDeltaOff + segCountX2;
  const map = new Map();
  for (let s = 0; s < segCount; s++) {
    const endCode = u16(buf, endCodesOff + s * 2);
    const startCode = u16(buf, startCodesOff + s * 2);
    const idDelta = i16(buf, idDeltaOff + s * 2);
    const idRangeOffset = u16(buf, idRangeOff + s * 2);
    if (startCode === 0xffff && endCode === 0xffff) continue;
    for (let c = startCode; c <= endCode && c !== 0xffff; c++) {
      let gid;
      if (idRangeOffset === 0) {
        gid = (c + idDelta) & 0xffff;
      } else {
        const addr = idRangeOff + s * 2 + idRangeOffset + (c - startCode) * 2;
        gid = u16(buf, addr);
        if (gid !== 0) gid = (gid + idDelta) & 0xffff;
      }
      if (gid !== 0) map.set(c, gid);
    }
  }
  return map;
}

function findBestCmapSubtable(buf, cmapOffset) {
  const numTables = u16(buf, cmapOffset + 2);
  let best = null;
  for (let i = 0; i < numTables; i++) {
    const rec = cmapOffset + 4 + i * 8;
    const platformID = u16(buf, rec);
    const encodingID = u16(buf, rec + 2);
    const subOffset = cmapOffset + u32(buf, rec + 4);
    const format = u16(buf, subOffset);
    if (format !== 4) continue; // only format 4 needed for Latin/BMP text
    const score = platformID === 3 && encodingID === 1 ? 3 : platformID === 0 ? 2 : 1;
    if (!best || score > best.score) best = { score, subOffset };
  }
  return best ? best.subOffset : null;
}

/**
 * Parse a TrueType font file into the pieces needed to embed it as a PDF
 * simple TrueType font: units-per-em, ascent/descent/capHeight/bbox/italic
 * angle (all scaled to a 1000-unit em, PDF's convention), and a
 * `widthForChar(code)` helper returning the advance width (in 1000-unit em)
 * for a given Unicode code point, or null if the font has no glyph for it.
 */
export function parseTTF(buf) {
  const tables = readTableDirectory(buf);
  const head = tables.head.offset;
  const hhea = tables.hhea.offset;
  const maxp = tables.maxp.offset;
  const hmtx = tables.hmtx.offset;
  const cmap = tables.cmap.offset;
  const os2 = tables["OS/2"] ? tables["OS/2"].offset : null;
  const post = tables.post ? tables.post.offset : null;

  const unitsPerEm = u16(buf, head + 18);
  const xMin = i16(buf, head + 36), yMin = i16(buf, head + 38);
  const xMax = i16(buf, head + 40), yMax = i16(buf, head + 42);
  const ascentRaw = i16(buf, hhea + 4);
  const descentRaw = i16(buf, hhea + 6);
  const numOfLongHorMetrics = u16(buf, hhea + 34);
  const numGlyphs = u16(buf, maxp + 4);

  let capHeight = Math.round(unitsPerEm * 0.7);
  if (os2) {
    const os2Version = u16(buf, os2 + 0);
    if (os2Version >= 2) capHeight = i16(buf, os2 + 88);
  }
  let italicAngle = 0;
  if (post) italicAngle = i32(buf, post + 4) / 65536;

  const scale = 1000 / unitsPerEm;
  const advanceWidths = new Array(numGlyphs);
  for (let g = 0; g < numGlyphs; g++) {
    const idx = g < numOfLongHorMetrics ? g : numOfLongHorMetrics - 1;
    advanceWidths[g] = u16(buf, hmtx + idx * 4);
  }

  const cmapSub = findBestCmapSubtable(buf, cmap);
  const unicodeToGid = cmapSub ? parseCmapFormat4(buf, cmapSub) : new Map();

  function widthForChar(codePoint) {
    const gid = unicodeToGid.get(codePoint);
    if (gid === undefined || advanceWidths[gid] === undefined) return null;
    return Math.round(advanceWidths[gid] * scale);
  }

  return {
    unitsPerEm,
    ascent: Math.round(ascentRaw * scale),
    descent: Math.round(descentRaw * scale),
    capHeight: Math.round(capHeight * scale),
    italicAngle,
    bbox: [Math.round(xMin * scale), Math.round(yMin * scale), Math.round(xMax * scale), Math.round(yMax * scale)],
    widthForChar,
    raw: buf,
  };
}
