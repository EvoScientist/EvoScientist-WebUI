// Whitespace as the backend reads it: Python's `str.split()` and
// `str.strip()` and `re`'s `\s` all take the characters `str.isspace()` takes.
// JS's `\s` differs: it takes U+FEFF, and leaves out U+001C to U+001F and
// U+0085.

/** One character of Python whitespace. */
export const PY_SPACE =
  // U+001C to U+001F are control characters, and Python whitespace too.
  // eslint-disable-next-line no-control-regex
  /[\t\n\v\f\r\x1c-\x1f \x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]/;

/** Python's `str.strip()`, in one pass: an end-anchored regex would be
 *  quadratic on a long run of spaces inside the text. */
export function pyStrip(text: string): string {
  let start = 0;
  let end = text.length;
  while (start < end && PY_SPACE.test(text[start])) start++;
  while (end > start && PY_SPACE.test(text[end - 1])) end--;
  return text.slice(start, end);
}
