// Fast drop-in for make.fun's csv-reader 1.0.0.
//
// Semantics (from the reference, vendor/csv-reader/index.js): one left-to-right
// pass; U+FEFF dropped at the very start; a record ends at LF or CRLF; a line
// left with no characters is no record; outside quotes a CR not followed by LF
// is dropped (stray_cr); a field opening with a quote runs to the next quote
// that is not doubled ("" is one quote, CRLF / lone CR inside read as LF);
// what follows the closing quote up to the next comma or line break is
// appended as it stands (quote_junk, when the field ends); a quote that never
// closes is a literal character and the text after it is read again as
// unquoted (unterminated_quote); a quote inside an unquoted field is literal;
// fields stay strings; columns is the first record when header is true, else
// null; rows are padded (short_row, with fields: its count) or cut (long_row,
// with extra: the cut fields) to the first record's width; each error is
// {code, line, row}, in the order met, a record's short_row/long_row when it
// ends; line is the 1-based line its record starts on, row its index in rows
// (null for the header).
//
// Speed: every LF and CR position is collected once, so the next line break
// is a pointer step and no search ever runs past it; a clean line (no quote,
// no stray CR) is answered with one split(','); any other record is parsed
// field by field with indexOf jumps, all inlined in one flat function — no
// closures over the hot state, no per-field call or result object, no regex.

export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const len = text.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;
  let pos = 0;
  let line = 1;
  if (len > 0 && text.charCodeAt(0) === 0xfeff) pos = 1;

  // Every LF and CR position, collected once.
  const lfs = [];
  const crs = [];
  let i = text.indexOf('\n', pos);
  while (i !== -1) { lfs.push(i); i = text.indexOf('\n', i + 1); }
  i = text.indexOf('\r', pos);
  while (i !== -1) { crs.push(i); i = text.indexOf('\r', i + 1); }
  let lfIdx = 0;
  let crIdx = 0;

  let recordLine = 1;
  let recordRow = null;

  while (pos < len) {
    // Next LF at or after pos (len: none left).
    while (lfIdx < lfs.length && lfs[lfIdx] < pos) lfIdx++;
    const nl = lfIdx < lfs.length ? lfs[lfIdx] : len;
    if (nl < len) {
      let segEnd = nl;
      if (segEnd > pos && text.charCodeAt(segEnd - 1) === 13) segEnd -= 1;
      if (segEnd === pos) {
        // A line left with no characters is no record.
        pos = nl + 1;
        line += 1;
        continue;
      }
      const q = text.indexOf('"', pos);
      if (q === -1 || q >= segEnd) {
        while (crIdx < crs.length && crs[crIdx] < pos) crIdx++;
        const cr = crIdx < crs.length ? crs[crIdx] : len;
        if (cr >= segEnd) {
          // Clean line: one split.
          recordLine = line;
          recordRow = header && columns === null ? null : rows.length;
          const fields = text.slice(pos, segEnd).split(',');
          pos = nl + 1;
          line += 1;
          if (width < 0) width = fields.length;
          if (header && columns === null) {
            columns = fields;
            continue;
          }
          if (fields.length < width) {
            errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
            while (fields.length < width) fields.push('');
          } else if (fields.length > width) {
            errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
          }
          rows.push(fields);
          continue;
        }
      }
    } else {
      const q = text.indexOf('"', pos);
      while (crIdx < crs.length && crs[crIdx] < pos) crIdx++;
      const cr = crIdx < crs.length ? crs[crIdx] : len;
      if (q === -1 && cr >= len) {
        // Clean last line, no line break after it.
        recordLine = line;
        recordRow = header && columns === null ? null : rows.length;
        const fields = text.slice(pos).split(',');
        pos = len;
        if (width < 0) width = fields.length;
        if (header && columns === null) {
          columns = fields;
          continue;
        }
        if (fields.length < width) {
          errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
          while (fields.length < width) fields.push('');
        } else if (fields.length > width) {
          errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
        }
        rows.push(fields);
        continue;
      }
    }

    // Slow path: this record holds a quote or a stray CR (or spans lines).
    // Parsed field by field, all inline.
    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;
    const fields = [];
    let lastQuoted = false;
    fieldLoop: while (true) {
      let value = '';
      let added = 0;
      let isJunk = false;
      if (text.charCodeAt(pos) === 34) {
        lastQuoted = true;
        const open = pos;
        const openLine = line;
        pos += 1;
        let closed = false;
        while (pos < len) {
          const q = text.indexOf('"', pos);
          if (q === -1) break;
          while (lfIdx < lfs.length && lfs[lfIdx] < pos) lfIdx++;
          while (crIdx < crs.length && crs[crIdx] < pos) crIdx++;
          const lf = lfIdx < lfs.length ? lfs[lfIdx] : len;
          const cr = crIdx < crs.length ? crs[crIdx] : len;
          if (cr >= q && lf >= q) {
            value += text.slice(pos, q);
          } else {
            // Normalise every CR / LF inside [pos, q) to LF, counting lines.
            let sp = pos;
            while (sp < q) {
              while (lfIdx < lfs.length && lfs[lfIdx] < sp) lfIdx++;
              while (crIdx < crs.length && crs[crIdx] < sp) crIdx++;
              const lf2 = lfIdx < lfs.length ? lfs[lfIdx] : len;
              const cr2 = crIdx < crs.length ? crs[crIdx] : len;
              const m2 = lf2 < cr2 ? lf2 : cr2;
              if (m2 >= q) {
                value += text.slice(sp, q);
                break;
              }
              value += text.slice(sp, m2);
              value += '\n';
              line += 1;
              sp = m2 + 1;
              if (m2 === cr2 && sp < q && text.charCodeAt(sp) === 10) sp += 1; // CRLF is one LF
            }
          }
          if (text.charCodeAt(q + 1) === 34) {
            value += '"';
            pos = q + 2;
            continue;
          }
          pos = q + 1;
          closed = true;
          break;
        }
        if (!closed) {
          // The quote never closes: it is a literal character, and the text
          // after it is read again as unquoted. pos moves back, so the LF /
          // CR pointers must rewind with it.
          pos = open + 1;
          line = openLine;
          while (lfIdx > 0 && lfs[lfIdx - 1] >= pos) lfIdx -= 1;
          while (crIdx > 0 && crs[crIdx - 1] >= pos) crIdx -= 1;
          errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
          value = '"';
          added = 0;
          // Fall through to the unquoted parse below.
        } else if (pos >= len) {
          fields.push(value);
          break fieldLoop;
        } else {
          const ch = text.charCodeAt(pos);
          if (ch === 44) {
            pos += 1;
            fields.push(value);
            continue fieldLoop;
          }
          if (ch === 10) {
            pos += 1;
            line += 1;
            fields.push(value);
            break fieldLoop;
          }
          if (ch === 13 && text.charCodeAt(pos + 1) === 10) {
            pos += 2;
            line += 1;
            fields.push(value);
            break fieldLoop;
          }
          // Junk after the closing quote: read as unquoted, appending.
          isJunk = true;
          added = 0;
          // Fall through to the unquoted parse below.
        }
      } else {
        lastQuoted = false;
      }

      // Unquoted parse: a plain field, the junk after a closing quote, or
      // the re-read after an unterminated quote. `value` and `added` are
      // already set; `isJunk` only for the junk case.
      let ended = 2; // 0 comma, 1 line break, 2 end
      while (true) {
        const c = text.indexOf(',', pos);
        while (lfIdx < lfs.length && lfs[lfIdx] < pos) lfIdx++;
        while (crIdx < crs.length && crs[crIdx] < pos) crIdx++;
        const nl2 = lfIdx < lfs.length ? lfs[lfIdx] : len;
        const cr2 = crIdx < crs.length ? crs[crIdx] : len;
        let m = c === -1 ? len : c;
        let kind = 0; // 0 comma, 1 LF, 2 CR
        if (nl2 < m) { m = nl2; kind = 1; }
        if (cr2 < m) { m = cr2; kind = 2; }
        if (kind === 2) {
          if (text.charCodeAt(m + 1) === 10) {
            value += text.slice(pos, m);
            added += m - pos;
            pos = m + 2;
            line += 1;
            ended = 1;
            break;
          }
          errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
          value += text.slice(pos, m);
          added += m - pos;
          pos = m + 1;
          continue;
        }
        value += text.slice(pos, m);
        added += m - pos;
        if (m >= len) {
          pos = len;
          ended = 2;
        } else if (kind === 0) {
          pos = m + 1;
          ended = 0;
        } else {
          pos = m + 1;
          line += 1;
          ended = 1;
        }
        break;
      }
      if (isJunk && added > 0) errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
      fields.push(value);
      if (ended === 0) continue fieldLoop;
      break fieldLoop;
    }

    // A line that held only stray CRs is left with no characters: no record
    // (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !lastQuoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
