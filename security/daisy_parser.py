"""
daisy_parser.py
===============
Extract chapters from a DAISY digital talking book (uploaded as a ``.zip``),
producing the SAME chapter shape as ``security/epub_parser.py`` /
``security/docx_parser.py`` so the rest of the conversion pipeline
(LanguageSelection → voice → /convert-chapters → worker) is unchanged.

Why this exists
---------------
BookShare — the non-profit library for print-disabled readers our first paying
subscriber uses daily — ships a meaningful chunk of its catalog only as DAISY,
not EPUB. A DAISY download is a ZIP archive. Two generations matter:

* **DAISY 3 (Z39.86-2005)** — the format BookShare actually delivers for
  text-only titles. Content lives in a DTBook XML file (root ``<dtbook>``)
  whose ``<level1>``/``<level2>`` elements ARE the chapter structure. This is
  the primary path.
* **DAISY 2.02** — older books navigated by an ``ncc.html`` table of contents
  with the full text (when present) in companion HTML files. Best-effort
  fallback path.

DAISY 4 needs no support here: its distribution format is EPUB 3, which the
existing EPUB path already handles.

Audio-only DAISY books (SMIL + MP3, no text) cannot be converted — we
synthesise from text — so they get a clear, user-actionable error instead of
a garbage conversion.

Security posture mirrors ``SecureEpubParser``: ZIP-bomb checks (per-entry
compression ratio, total uncompressed cap), nothing is ever extracted to disk
(entries are read into memory only), and only text-bearing entries are read —
an ``.mp3`` inside the archive is never even decompressed.

Returned chapter dict matches the client contract:
    {'id', 'title', 'content', 'duration': 0, 'position', 'imageInserts'}
``imageInserts`` is always ``[]`` — like .docx, DAISY is text-only for now.
"""
import re
import zipfile
import posixpath
import xml.etree.ElementTree as ET
from html.entities import html5 as _HTML5_ENTITIES
from html.parser import HTMLParser
from typing import Any, Dict, List, Optional, Tuple

# ─── Limits (mirrors SecureEpubParser's ZIP-bomb posture) ────────────────────
_MAX_TOTAL_UNCOMPRESSED = 100 * 1024 * 1024   # 100 MB across the archive
_MAX_COMPRESSION_RATIO = 100                  # per-entry ratio cap
_MAX_TEXT_ENTRY_SIZE = 30 * 1024 * 1024       # single text file read cap
_MAX_TEXT_ENTRIES = 500                       # sanity cap on files we read

# Entries we're willing to decompress. Everything else (mp3, smil, images,
# res files) is left untouched inside the archive.
_TEXT_SUFFIXES = ('.xml', '.opf', '.ncx', '.html', '.htm', '.xhtml')

# DTBook elements whose text must NOT be narrated: printed page numbers,
# footnote reference markers, annotation markers, and producer notes that
# DAISY players skip by default.
_SKIP_TAGS = {'pagenum', 'noteref', 'annoref', 'prodnote'}

# Elements that end a text block — used to keep paragraph boundaries so the
# TTS chunker sees natural breaks instead of one endless line.
_BLOCK_TAGS = {
    'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hd', 'li', 'blockquote',
    'div', 'poem', 'linegroup', 'line', 'byline', 'author', 'docauthor',
    'doctitle', 'covertitle', 'bridgehead', 'caption', 'sidebar', 'epigraph',
}

_HEADING_TAGS = ('h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hd')

_MAX_TITLE_LEN = 200


# ─── Small helpers ───────────────────────────────────────────────────────────

def _local(tag: Any) -> str:
    """Namespace-free lowercase local name of an element tag."""
    if not isinstance(tag, str):
        return ''  # comments / processing instructions
    return tag.rsplit('}', 1)[-1].lower()


def _collapse(text: str) -> str:
    """Collapse whitespace runs but keep paragraph breaks (double newlines)."""
    text = re.sub(r'[ \t\r\f\v]+', ' ', text)
    text = re.sub(r' ?\n ?', '\n', text)
    text = re.sub(r'\n{3,}', '\n\n', text)
    return text.strip()


_ENTITY_RE = re.compile(r'&([A-Za-z][A-Za-z0-9]*|#[0-9]+|#x[0-9A-Fa-f]+);')
_XML_BUILTINS = {'amp', 'lt', 'gt', 'quot', 'apos'}


def _resolve_named_entities(xml_text: str) -> str:
    """
    Replace HTML named entities (``&mdash;`` etc.) with their characters.

    DTBook files routinely use entities defined in the DTBook DTD, which
    ElementTree can't resolve (it never fetches external DTDs — deliberately,
    that's the XXE defence). The XML built-ins and numeric references are left
    untouched; unknown names are dropped rather than crashing the parse.
    """
    def sub(m: 're.Match') -> str:
        name = m.group(1)
        if name in _XML_BUILTINS or name.startswith('#'):
            return m.group(0)
        ch = _HTML5_ENTITIES.get(name + ';')
        return ch if ch is not None else ''
    return _ENTITY_RE.sub(sub, xml_text)


_DOCTYPE_RE = re.compile(r'<!DOCTYPE[^\[>]*(\[[^\]]*\])?[^>]*>', re.IGNORECASE)


def _parse_xml(raw: bytes) -> ET.Element:
    """Parse DTBook/NCC XML defensively: strip the DOCTYPE, resolve entities."""
    text = raw.decode('utf-8', errors='replace')
    # Some producers emit UTF-16; detect the BOM and re-decode.
    if raw[:2] in (b'\xff\xfe', b'\xfe\xff'):
        text = raw.decode('utf-16', errors='replace')
    text = _DOCTYPE_RE.sub('', text, count=1)
    text = _resolve_named_entities(text)
    # Kill any encoding declaration that no longer matches the str we hold.
    text = re.sub(r'^\s*<\?xml[^>]*\?>', '', text, count=1)
    return ET.fromstring(text)


# ─── Safe ZIP reading ────────────────────────────────────────────────────────

def _open_zip_safely(path: str) -> zipfile.ZipFile:
    if not zipfile.is_zipfile(path):
        raise ValueError('This file is not a valid DAISY book (not a ZIP archive)')
    zf = zipfile.ZipFile(path, 'r')

    total_uncompressed = 0
    for info in zf.infolist():
        # ZIP-bomb: absurd per-entry compression ratio.
        if info.compress_size > 0:
            ratio = info.file_size / info.compress_size
            if ratio > _MAX_COMPRESSION_RATIO:
                zf.close()
                raise ValueError('This archive could not be processed safely')
        total_uncompressed += info.file_size
    if total_uncompressed > _MAX_TOTAL_UNCOMPRESSED:
        zf.close()
        raise ValueError('This archive could not be processed safely')
    return zf


def _text_entries(zf: zipfile.ZipFile) -> List[str]:
    """Names of text-bearing entries, traversal-safe, capped, sorted."""
    names = []
    for name in zf.namelist():
        lower = name.lower()
        # We never extract to disk, but refuse hostile paths on principle.
        norm = posixpath.normpath(name)
        if norm.startswith(('/', '..')):
            continue
        if lower.endswith(_TEXT_SUFFIXES):
            info = zf.getinfo(name)
            if info.file_size <= _MAX_TEXT_ENTRY_SIZE:
                names.append(name)
        if len(names) >= _MAX_TEXT_ENTRIES:
            break
    return sorted(names)


# ─── DTBook (DAISY 3) extraction ─────────────────────────────────────────────

def _element_text(el: ET.Element, skip: Optional[ET.Element] = None) -> str:
    """All narratable text under ``el``, excluding skip-tags and ``skip``."""
    parts: List[str] = []

    def walk(node: ET.Element):
        tag = _local(node.tag)
        if node is skip or tag in _SKIP_TAGS:
            return
        if node.text:
            parts.append(node.text)
        for child in node:
            walk(child)
            if child.tail:
                parts.append(child.tail)
        if tag in _BLOCK_TAGS:
            parts.append('\n\n')

    walk(el)
    return _collapse(''.join(parts))


def _first_heading(el: ET.Element) -> Optional[ET.Element]:
    for node in el.iter():
        if _local(node.tag) in _HEADING_TAGS:
            return node
    return None


def _dtbook_meta(root: ET.Element) -> Tuple[Optional[str], Optional[str]]:
    """(title, iso-639-1 language) from DTBook metadata; both best-effort."""
    title = None
    language = None
    # xml:lang on the root is the most reliable language signal.
    lang_attr = root.get('{http://www.w3.org/XML/1998/namespace}lang') or root.get('lang')
    if lang_attr:
        language = lang_attr.split('-')[0].split('_')[0].strip().lower() or None
    for meta in root.iter():
        if _local(meta.tag) != 'meta':
            continue
        name = (meta.get('name') or '').strip().lower()
        content = (meta.get('content') or '').strip()
        if not content:
            continue
        if name in ('dc:title', 'dtb:title') and not title:
            title = content
        elif name in ('dc:language', 'dtb:language') and not language:
            language = content.split('-')[0].split('_')[0].strip().lower() or None
    if not title:
        doctitle = next(
            (n for n in root.iter() if _local(n.tag) == 'doctitle'), None)
        if doctitle is not None:
            t = _element_text(doctitle)
            title = t.split('\n')[0][:_MAX_TITLE_LEN] if t else None
    return title, language


def _chapter_elements(root: ET.Element) -> List[ET.Element]:
    """
    The elements that should become chapters.

    Normally each ``<level1>`` is a chapter. Some books wrap everything in a
    single level1 "part" whose ``<level2>`` children are the real chapters —
    if there's exactly one level1 with 2+ level2 children, descend one level.
    DAISY also allows generic ``<level depth="n">``.
    """
    def levels_of(parent_iter, names) -> List[ET.Element]:
        found = []
        for node in parent_iter:
            tag = _local(node.tag)
            if tag in names:
                found.append(node)
            elif tag == 'level' and node.get('depth') in ('1', None) and 'level1' in names:
                found.append(node)
            elif tag == 'level' and node.get('depth') == '2' and 'level2' in names:
                found.append(node)
        return found

    level1s = levels_of(root.iter(), {'level1'})
    if len(level1s) == 1:
        level2s = levels_of(level1s[0].iter(), {'level2'})
        if len(level2s) >= 2:
            return level2s
    if level1s:
        return level1s
    # Degenerate books with no level markup: whole bodymatter (or book) is one
    # chapter.
    body = next((n for n in root.iter() if _local(n.tag) == 'bodymatter'), None)
    if body is None:
        body = next((n for n in root.iter() if _local(n.tag) == 'book'), root)
    return [body]


def _extract_from_dtbook(root: ET.Element) -> Dict[str, Any]:
    book_title, language = _dtbook_meta(root)
    chapters: List[Dict[str, Any]] = []

    for el in _chapter_elements(root):
        heading = _first_heading(el)
        title = None
        if heading is not None:
            t = _element_text(heading)
            title = t.split('\n')[0].strip()[:_MAX_TITLE_LEN] or None
        content = _element_text(el, skip=heading)
        if not content:
            continue
        chapters.append({
            'id': str(len(chapters) + 1),
            'title': title,
            'content': content,
            'duration': 0,
            'position': len(chapters),
            'imageInserts': [],
        })

    _resolve_untitled(chapters, book_title)
    return {'chapters': chapters, 'language': (language or 'en')}


# ─── DAISY 2.02 (ncc.html + content HTML) fallback ──────────────────────────

class _HtmlChapterSplitter(HTMLParser):
    """
    Stream an HTML content document into (title, text) chapter pairs, splitting
    on <h1> (falling back to a single chapter when the file has none).
    Text inside <script>/<style> and page-number spans is dropped.
    """

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.chapters: List[Tuple[Optional[str], List[str]]] = [(None, [])]
        self._in_h1 = False
        self._h1_text: List[str] = []
        # Stack of tag names whose subtree we're dropping (script/style/page
        # spans). Popped when the matching end tag arrives.
        self._suppress_stack: List[str] = []

    def handle_starttag(self, tag, attrs):
        if self._suppress_stack:
            # Nested tag inside a suppressed subtree — keep the stack balanced.
            self._suppress_stack.append(tag)
            return
        attrs = dict(attrs)
        cls = (attrs.get('class') or '').lower()
        if (tag in ('script', 'style', 'head', 'title')
                or 'page-normal' in cls or 'pagenum' in cls):
            self._suppress_stack.append(tag)
            return
        if tag == 'h1':
            self._in_h1 = True
            self._h1_text = []
        elif tag in ('p', 'br', 'div', 'li', 'h2', 'h3', 'h4', 'h5', 'h6') and not self._in_h1:
            self.chapters[-1][1].append('\n\n')

    def handle_endtag(self, tag):
        if self._suppress_stack:
            if tag == self._suppress_stack[-1]:
                self._suppress_stack.pop()
            return
        if tag == 'h1' and self._in_h1:
            self._in_h1 = False
            title = _collapse(''.join(self._h1_text)) or None
            # h1 starts a NEW chapter titled by it.
            self.chapters.append((title, []))

    def handle_data(self, data):
        if self._suppress_stack:
            return
        if self._in_h1:
            self._h1_text.append(data)
        else:
            self.chapters[-1][1].append(data)


def _extract_from_daisy202(zf: zipfile.ZipFile, ncc_name: str) -> Dict[str, Any]:
    ncc_root = None
    try:
        ncc_root = _parse_xml(zf.read(ncc_name))
    except ET.ParseError:
        pass  # ncc is only used for metadata; content HTMLs carry the text

    book_title = None
    language = None
    if ncc_root is not None:
        book_title, language = _dtbook_meta(ncc_root)  # same meta shape

    ncc_dir = posixpath.dirname(ncc_name)
    content_names = [
        n for n in _text_entries(zf)
        if n.lower().endswith(('.html', '.htm', '.xhtml'))
        and posixpath.basename(n).lower() not in ('ncc.html', 'ncc.htm')
        and (not ncc_dir or n.startswith(ncc_dir))
    ]

    chapters: List[Dict[str, Any]] = []
    for name in content_names:
        raw = zf.read(name)
        splitter = _HtmlChapterSplitter()
        try:
            splitter.feed(raw.decode('utf-8', errors='replace'))
            splitter.close()
        except Exception:
            continue
        for title, parts in splitter.chapters:
            content = _collapse(''.join(parts))
            if not content:
                continue
            chapters.append({
                'id': str(len(chapters) + 1),
                'title': title,
                'content': content,
                'duration': 0,
                'position': len(chapters),
                'imageInserts': [],
            })

    _resolve_untitled(chapters, book_title)
    return {'chapters': chapters, 'language': (language or 'en')}


# ─── Shared finishing pass ───────────────────────────────────────────────────

def _resolve_untitled(chapters: List[Dict[str, Any]], book_title: Optional[str]):
    """Match the docx parser's titling rules for consistency across formats."""
    for i, ch in enumerate(chapters):
        if ch['title']:
            continue
        if len(chapters) == 1:
            ch['title'] = book_title or 'Book'
        elif i == 0:
            ch['title'] = 'Front Matter'
        else:
            ch['title'] = f'Chapter {i + 1}'


_AUDIO_ONLY_MSG = (
    'This DAISY book appears to be audio-only (no text inside), so there is '
    'nothing to convert. Please download the text or full-text DAISY edition '
    '— on BookShare choose "DAISY" (text), not "DAISY Audio".'
)


# ─── Public API ──────────────────────────────────────────────────────────────

def extract_daisy_chapters(path: str) -> Dict[str, Any]:
    """
    Parse a DAISY ``.zip`` at ``path`` into chapters.

    Returns ``{'chapters': [...], 'language': '<iso>'}`` — the same contract
    as ``extract_docx_chapters``. Raises ``ValueError`` with a user-actionable
    message for non-DAISY zips and audio-only DAISY books.
    """
    zf = _open_zip_safely(path)
    try:
        names = _text_entries(zf)
        all_names_lower = [n.lower() for n in zf.namelist()]

        # ── DAISY 3: find DTBook XML (root <dtbook>) ──
        dtbook_roots: List[ET.Element] = []
        for name in names:
            if not name.lower().endswith('.xml'):
                continue
            head = zf.read(name)[:4096].decode('utf-8', errors='replace')
            if '<dtbook' not in head.lower():
                continue
            try:
                dtbook_roots.append(_parse_xml(zf.read(name)))
            except ET.ParseError as e:
                print(f'[WARN] DAISY: DTBook parse failed for {name}: {e}')

        if dtbook_roots:
            # Multi-volume books: concatenate in filename order.
            merged: Dict[str, Any] = {'chapters': [], 'language': 'en'}
            for root in dtbook_roots:
                part = _extract_from_dtbook(root)
                for ch in part['chapters']:
                    ch['id'] = str(len(merged['chapters']) + 1)
                    ch['position'] = len(merged['chapters'])
                    merged['chapters'].append(ch)
                if part['language'] != 'en':
                    merged['language'] = part['language']
            if merged['chapters']:
                return merged
            raise ValueError(_AUDIO_ONLY_MSG)

        # ── DAISY 2.02: ncc.html present ──
        ncc_name = next(
            (n for n in zf.namelist()
             if posixpath.basename(n).lower() in ('ncc.html', 'ncc.htm')),
            None,
        )
        if ncc_name:
            result = _extract_from_daisy202(zf, ncc_name)
            # A structure-only ncc with SMIL/MP3s and no real text = audio DAISY.
            total_words = sum(
                len(ch['content'].split()) for ch in result['chapters'])
            if not result['chapters'] or total_words < 20:
                raise ValueError(_AUDIO_ONLY_MSG)
            return result

        # ── Not DAISY at all: help the user route the file correctly ──
        if any(n.endswith('.epub') for n in all_names_lower):
            raise ValueError(
                'This zip contains an EPUB. Please upload the .epub file '
                'itself instead of the zip.'
            )
        if any(n.endswith(('.mp3', '.smil')) for n in all_names_lower):
            raise ValueError(_AUDIO_ONLY_MSG)
        raise ValueError(
            'This zip does not look like a DAISY book. We support DAISY 3 '
            '(text) and DAISY 2.02 zips, plus EPUB and Word files uploaded '
            'directly.'
        )
    finally:
        zf.close()
