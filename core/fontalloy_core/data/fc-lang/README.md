# Bundled fc-lang data

This directory holds fontconfig's `fc-lang` orthography corpus, vendored
verbatim: **341 `.orth` files**, one language charset per file. Each file
defines the codepoints ("orthography") fontconfig uses to answer "does
this font cover language X?". `fontalloy_core/presets.py` parses them at
import time into the language-preset registry.

- Source: <https://gitlab.freedesktop.org/fontconfig/fontconfig> (`fc-lang/`
  directory), fetched from the GitHub mirror
  <https://github.com/fontconfig/fontconfig>.
- Pinned ref: `2.18.3` (release tag), vendored 2026-10-10. Re-pin
  deliberately: the test suite asserts the measured codepoint counts, so
  upstream corpus changes surface in CI instead of silently shifting
  preset coverage.
- Format: lines carry a codepoint (`0x4E00` or bare hex `0041`), an
  inclusive range (`start-end` or `start..end`), or a deletion
  (`-<codepoint>`); `#` and TAB start comments; `include <file.orth>`
  splices a sibling file (`zh_mo.orth` includes `zh_hk.orth`).

## License

Every `.orth` file carries fontconfig's permissive license notice in its
own header (MIT-style "Historical Permission Notice"; copyright 2002
Keith Packard and/or the fontconfig Authors; two files declare it as
`SPDX-License-Identifier: HPND` instead of the boilerplate text). The
in-file notices are preserved verbatim in these bundled copies — do not
strip them. The notice, quoted once for reference:

```text
Permission to use, copy, modify, distribute, and sell this software and
its documentation for any purpose is hereby granted without fee,
provided that the above copyright notice appear in all copies and that
both that copyright notice and this permission notice appear in
supporting documentation, and that the name of the author(s) not be used
in advertising or publicity pertaining to distribution of the software
without specific, written prior permission.  The authors make no
representations about the suitability of this software for any purpose.
It is provided "as is" without express or implied warranty.

THE AUTHOR(S) DISCLAIMS ALL WARRANTIES WITH REGARD TO THIS SOFTWARE,
INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS, IN NO
EVENT SHALL THE AUTHOR(S) BE LIABLE FOR ANY SPECIAL, INDIRECT OR
CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS OF
USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR
OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR
PERFORMANCE OF THIS SOFTWARE.
```
