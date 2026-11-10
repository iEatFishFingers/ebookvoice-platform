"""
docx_parser.py
==============
Extract chapters from a Microsoft Word (.docx) document, producing the SAME
chapter shape as ``security/epub_parser.py`` so the rest of the conversion
pipeline (LanguageSelection → voice → /convert-chapters → worker) is unchanged.

Why this exists
---------------
Our first paying subscriber (a totally-blind BookShare user) sources many
titles as Word documents rather than EPUB — BookShare doesn't ship everything
as EPUB. ``.docx`` is also the most common manuscript format generally, so this
opens the app to authors as well as the print-disabled audience. EPUB stays the
gold path; this is purely additive.

Chapter detection (in priority order)
-------------------------------------
1. **Heading 1 / Title styles** — the canonical way Word documents mark chapter
   breaks. Each such paragraph starts a new chapter and supplies its title.
2. **``Chapter N`` / ``Part N`` text** — fallback for documents that were typed
   without heading styles (very common). A paragraph whose text looks like a
   chapter header starts a new chapter.
3. **Single chapter** — if neither signal is present, the whole document becomes
   one chapter titled from the document's core properties (or "Document").

Returned chapter dict matches the EPUB extraction's *client* shape:
    {'id', 'title', 'content', 'duration': 0, 'position', 'imageInserts'}
``imageInserts`` is always ``[]`` — inline-image follow-along isn't supported
for .docx in this first version (EPUB keeps that feature). The EPUB path emits
the same key after its background image upload completes.
"""
import re
from typing import Any, Dict, List, Optional

# A paragraph is treated as a chapter heading if its (stripped) text matches.
# Kept deliberately conservative so prose like "...the next chapter of her life"
# inside a sentence never triggers it — the whole paragraph must BE the header.
_CHAPTER_WORD_RE = re.compile(
    r'^(chapter|part|book|section|prologue|epilogue|introduction|foreword'
    r'|preface|afterword)\b',
    re.IGNORECASE,
)
# Bare roman numerals on their own line (e.g. "II", "IV.", "V."). UPPERCASE-only
# and requiring 2+ chars or a trailing period, so a one-word line like "mill"
# (all-roman letters but lowercase) or the bare pronoun "I" never false-triggers.
_ROMAN_RE = re.compile(r'^([IVXLCDM]{2,}|[IVXLCDM])\.$|^[IVXLCDM]{2,}$')

# Heading paragraphs longer than this many characters are almost certainly body
# text mis-styled as a heading; don't let them become a chapter title/break.
_MAX_HEADING_LEN = 120


def _is_heading_style(style_name: Optional[str]) -> bool:
    """True for Word's top-level chapter styles: 'Heading 1' and 'Title'."""
    if not style_name:
        return False
    name = style_name.strip().lower()
    return name in ('heading 1', 'title') or name == 'heading1'


def _looks_like_chapter_text(text: str) -> bool:
    t = text.strip()
    if not t or len(t) > _MAX_HEADING_LEN:
        return False
    return bool(_CHAPTER_WORD_RE.match(t)) or bool(_ROMAN_RE.match(t))


def _clean(text: str) -> str:
    # Collapse runs of whitespace; python-docx already gives us plain text.
    return re.sub(r'[ \t]+', ' ', text).strip()


def _doc_language(document) -> str:
    """Best-effort ISO 639-1 from the document's core properties; default 'en'."""
    try:
        lang = getattr(document.core_properties, 'language', None)
        if lang:
            return str(lang).split('-')[0].split('_')[0].strip().lower() or 'en'
    except Exception:
        pass
    return 'en'


def _doc_title(document, fallback: str = 'Document') -> str:
    try:
        title = getattr(document.core_properties, 'title', None)
        if title and title.strip():
            return title.strip()
    except Exception:
        pass
    return fallback


def extract_docx_chapters(path: str) -> Dict[str, Any]:
    """
    Parse a .docx file at ``path`` into chapters.

    Returns ``{'chapters': [...], 'language': '<iso>'}``.
    Raises ``ValueError`` if the document has no readable text.
    """
    # Imported lazily so the rest of the backend doesn't hard-depend on
    # python-docx being installed (e.g. during unrelated unit tests).
    from docx import Document

    document = Document(path)
    language = _doc_language(document)

    # Build a flat list of (style_name, text) for non-empty paragraphs.
    paras: List[tuple] = []
    for p in document.paragraphs:
        text = _clean(p.text)
        if not text:
            continue
        style_name = getattr(getattr(p, 'style', None), 'name', None)
        paras.append((style_name, text))

    if not paras:
        raise ValueError('Document contains no readable text')

    # Decide which detector to use. Prefer real heading styles; only fall back
    # to text-pattern matching when the document has no usable headings.
    has_headings = any(_is_heading_style(s) for s, _ in paras)

    chapters: List[Dict[str, Any]] = []
    cur_title: Optional[str] = None
    cur_body: List[str] = []

    def _flush(title: Optional[str]):
        body = '\n\n'.join(cur_body).strip()
        if not body:
            return
        chapters.append({
            'id': str(len(chapters) + 1),
            'title': title,  # may be None; resolved after the full pass
            'content': body,
            'duration': 0,
            'position': len(chapters),
            'imageInserts': [],
        })

    for style_name, text in paras:
        is_break = (
            _is_heading_style(style_name) if has_headings
            else _looks_like_chapter_text(text)
        )
        if is_break:
            # Close the chapter in progress, start a new one titled by this line.
            _flush(cur_title)
            cur_title = text
            cur_body = []
        else:
            cur_body.append(text)
    _flush(cur_title)

    # No break ever fired AND no untitled body accumulated → join everything as
    # one chapter (e.g. a document that is entirely heading-like lines).
    if not chapters:
        body = '\n\n'.join(t for _, t in paras).strip()
        if not body:
            raise ValueError('Document contains no readable text')
        chapters.append({
            'id': '1', 'title': None, 'content': body,
            'duration': 0, 'position': 0, '_raw_image_inserts': [],
        })

    # Resolve any untitled chapters now that we know the full structure:
    #  - the sole chapter of an unstructured doc → the document's own title
    #  - untitled text that precedes the first heading → "Front Matter"
    #  - anything else untitled → a sequential "Chapter N"
    for i, ch in enumerate(chapters):
        if ch['title']:
            continue
        if len(chapters) == 1:
            ch['title'] = _doc_title(document)
        elif i == 0:
            ch['title'] = 'Front Matter'
        else:
            ch['title'] = f'Chapter {i + 1}'

    return {'chapters': chapters, 'language': language}
