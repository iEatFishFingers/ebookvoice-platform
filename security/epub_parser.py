"""
Secure EPUB Parser
Provides secure parsing of EPUB files with protections against:
- Path traversal attacks
- ZIP bombs
- XXE attacks
- Malicious content
"""

import zipfile
import posixpath
import re
from html import unescape
from typing import List, Dict, Any, BinaryIO, Optional


class _AnchorSplitParser:
    """
    HTML parser that splits a single HTML document into named sections
    keyed by `id`/`name` anchors.

    Used when an EPUB stores multiple chapters inside one HTML file and
    the TOC distinguishes them with `#anchor` fragments.

    Sections are keyed by anchor name; the special key `None` holds any
    content before the first anchor (typically merged into the previous
    chapter or discarded as front matter).
    """

    from html.parser import HTMLParser as _BaseHTMLParser

    class _Impl(_BaseHTMLParser):
        def __init__(self, anchor_ids):
            super().__init__()
            self.anchor_ids = set(anchor_ids)
            self.sections: Dict = {None: []}
            self.images: Dict = {None: []}
            self.current = None
            self._section_word_count = 0
            self._skip_tags = {'script', 'style', 'noscript'}
            self._skip_depth = 0

        def _switch(self, anchor: str):
            self.current = anchor
            if anchor not in self.sections:
                self.sections[anchor] = []
                self.images[anchor] = []
            self._section_word_count = 0

        def handle_starttag(self, tag, attrs):
            if tag in self._skip_tags:
                self._skip_depth += 1
                return
            attrs_dict = dict(attrs)
            # Both id="" (modern) and name="" (old-style <a name="...">) are valid anchor targets
            anchor = attrs_dict.get('id') or attrs_dict.get('name')
            if anchor and anchor in self.anchor_ids:
                self._switch(anchor)
            if tag == 'img' and self._skip_depth == 0:
                src = attrs_dict.get('src', '').strip()
                if src and not src.startswith('data:'):
                    self.images[self.current].append((self._section_word_count, src))

        def handle_startendtag(self, tag, attrs):
            self.handle_starttag(tag, attrs)

        def handle_endtag(self, tag):
            if tag in self._skip_tags:
                self._skip_depth = max(0, self._skip_depth - 1)

        def handle_data(self, data):
            if self._skip_depth > 0:
                return
            text = data.strip()
            if text:
                self.sections[self.current].append(text)
                self._section_word_count += len(text.split())

    def __init__(self, anchor_ids):
        self._impl = _AnchorSplitParser._Impl(anchor_ids)

    def feed(self, data: str):
        self._impl.feed(data)

    def get_sections(self) -> Dict:
        """Return {anchor_id_or_None: (text, [(word_index, src), ...])}."""
        out = {}
        for key in self._impl.sections:
            text = ' '.join(self._impl.sections[key]).strip()
            text = re.sub(r'\s{2,}', ' ', text)
            out[key] = (text, list(self._impl.images.get(key, [])))
        return out


class _HeadingSplitParser:
    """
    HTML parser that splits a single HTML document into sections keyed by
    `<h1>`/`<h2>` headings.  Used as a fallback when the EPUB has a
    degenerate TOC (e.g. a single "Start" entry) but the spine files
    contain real heading structure.
    """

    from html.parser import HTMLParser as _BaseHTMLParser

    class _Impl(_BaseHTMLParser):
        # Headings used as section boundaries, in priority order.
        _HEADING_TAGS = ('h1', 'h2')

        def __init__(self):
            super().__init__()
            # Each section: {'title': str|None, 'text_parts': [], 'images': []}
            self.sections = [{'title': None, 'text_parts': [], 'images': []}]
            self._heading_buf = None       # text accumulated inside the current open heading tag
            self._in_heading_tag = None    # tag name of the currently-open heading
            # Title queued by closed heading(s) but not yet attached to a section —
            # consecutive heading tags with no body between them collapse into
            # a single multi-line title (e.g. <h1>The Richest Man</h1><h1>in Babylon</h1>).
            self._pending_title = None
            self._section_word_count = 0
            self._skip_tags = {'script', 'style', 'noscript'}
            self._skip_depth = 0

        def _flush_pending_title(self):
            """Commit any queued heading text as the start of a new section."""
            if self._pending_title:
                self.sections.append({
                    'title': self._pending_title,
                    'text_parts': [],
                    'images': [],
                })
                self._section_word_count = 0
                self._pending_title = None

        def handle_starttag(self, tag, attrs):
            if tag in self._skip_tags:
                self._skip_depth += 1
                return
            if tag in self._HEADING_TAGS and self._skip_depth == 0:
                self._heading_buf = []
                self._in_heading_tag = tag
                return
            if tag == 'img' and self._skip_depth == 0:
                # Flush any pending title before placing an image into a section.
                self._flush_pending_title()
                attrs_dict = dict(attrs)
                src = attrs_dict.get('src', '').strip()
                if src and not src.startswith('data:'):
                    self.sections[-1]['images'].append(
                        (self._section_word_count, src)
                    )

        def handle_startendtag(self, tag, attrs):
            self.handle_starttag(tag, attrs)

        def handle_endtag(self, tag):
            if tag in self._skip_tags:
                self._skip_depth = max(0, self._skip_depth - 1)
                return
            if tag == self._in_heading_tag and self._heading_buf is not None:
                heading = ''.join(self._heading_buf).strip()
                heading = re.sub(r'\s+', ' ', heading)
                if heading:
                    if self._pending_title:
                        # Consecutive heading with no body in between → merge.
                        self._pending_title = f'{self._pending_title} {heading}'
                    else:
                        self._pending_title = heading
                self._heading_buf = None
                self._in_heading_tag = None

        def handle_data(self, data):
            if self._skip_depth > 0:
                return
            if self._heading_buf is not None:
                self._heading_buf.append(data)
                return
            text = data.strip()
            if not text:
                return
            self._flush_pending_title()
            self.sections[-1]['text_parts'].append(text)
            self._section_word_count += len(text.split())

    def __init__(self):
        self._impl = _HeadingSplitParser._Impl()

    def feed(self, data: str):
        self._impl.feed(data)

    def get_sections(self) -> List:
        """Return ordered list of {title, text, images} dicts (skipping empty leading section)."""
        out = []
        for s in self._impl.sections:
            text = ' '.join(s['text_parts']).strip()
            text = re.sub(r'\s{2,}', ' ', text)
            if not text:
                continue
            out.append({
                'title': s['title'],
                'text': text,
                'images': list(s['images']),
            })
        return out


class SecureHTMLParser:
    """
    Simple HTML parser that extracts text content safely.
    Uses Python's built-in html.parser to avoid XXE vulnerabilities
    that can occur with lxml.
    """

    from html.parser import HTMLParser as _BaseHTMLParser

    class _Impl(_BaseHTMLParser):
        def __init__(self):
            super().__init__()
            self.text_parts = []
            self.title = None
            self.title_from_tag = None  # Store <title> tag content separately
            self.in_title = False
            self.in_h1 = False
            self.in_h2 = False
            self.in_h3 = False
            self.current_heading = None
            self._skip_tags = {'script', 'style', 'noscript'}
            self._skip_depth = 0
            # Track inline images: list of (word_index, src_path)
            self.image_positions: list = []

        def _current_word_count(self) -> int:
            """Count words accumulated in text_parts so far."""
            return sum(len(t.split()) for t in self.text_parts)

        def handle_starttag(self, tag, attrs):
            if tag in self._skip_tags:
                self._skip_depth += 1
            elif tag == 'title':
                self.in_title = True
            elif tag == 'h1':
                self.in_h1 = True
                self.current_heading = []
            elif tag == 'h2':
                self.in_h2 = True
                self.current_heading = []
            elif tag == 'h3':
                self.in_h3 = True
                self.current_heading = []
            elif tag == 'img' and self._skip_depth == 0:
                attrs_dict = dict(attrs)
                src = attrs_dict.get('src', '').strip()
                # Skip data URIs and empty srcs — only keep real file references
                if src and not src.startswith('data:'):
                    self.image_positions.append((self._current_word_count(), src))

        def handle_endtag(self, tag):
            if tag in self._skip_tags:
                self._skip_depth = max(0, self._skip_depth - 1)
            elif tag == 'title':
                self.in_title = False
            elif tag == 'h1':
                if self.current_heading:
                    heading_text = ''.join(self.current_heading).strip()
                    if heading_text and self._is_valid_title(heading_text) and not self.title:
                        self.title = heading_text
                self.in_h1 = False
                self.current_heading = None
            elif tag == 'h2':
                if self.current_heading:
                    heading_text = ''.join(self.current_heading).strip()
                    if heading_text and self._is_valid_title(heading_text) and not self.title:
                        self.title = heading_text
                self.in_h2 = False
                self.current_heading = None
            elif tag == 'h3':
                if self.current_heading:
                    heading_text = ''.join(self.current_heading).strip()
                    if heading_text and self._is_valid_title(heading_text) and not self.title:
                        self.title = heading_text
                self.in_h3 = False
                self.current_heading = None

        def handle_data(self, data):
            if self._skip_depth > 0:
                return

            if self.in_title and not self.title_from_tag:
                self.title_from_tag = data.strip()

            if self.current_heading is not None:
                self.current_heading.append(data)

            # Skip <title> tag content from body text — it's captured separately
            # and often contains file paths from PDF-to-EPUB conversion
            if self.in_title:
                return

            # Add text content, filtering out file-path-like strings
            text = data.strip()
            if text and not self._is_file_path(text):
                self.text_parts.append(text)

        def _is_file_path(self, text: str) -> bool:
            """
            Check if text looks like a file path that should be excluded from content.
            Catches paths like /app/public/task/{uuid}/{uuid}.pdf that leak from
            PDF-to-EPUB conversion.
            """
            # Starts with / or \ and looks like a path (contains more slashes)
            if (text.startswith('/') or text.startswith('\\')) and text.count('/') >= 2:
                return True

            # Contains common path segments from conversion systems
            if '/app/' in text or '/public/' in text or '/task/' in text:
                return True
            if '\\app\\' in text or '\\public\\' in text or '\\task\\' in text:
                return True

            # Looks like a file path ending with a common extension
            path_pattern = re.compile(
                r'^[/\\]?[\w./-]+\.(pdf|epub|html|xhtml|htm|txt|doc|docx)$',
                re.IGNORECASE
            )
            if path_pattern.match(text):
                return True

            # Long hex/UUID path pattern (e.g., /app/public/task/68ed633d46b270.../2a3a0bdb-...pdf)
            if re.search(r'[a-f0-9]{20,}', text.lower()) and '/' in text:
                return True

            return False

        def _is_valid_title(self, text: str) -> bool:
            """
            Check if text is a valid chapter title.
            Filters out file paths, UUIDs, and other invalid patterns.
            """
            if not text:
                return False

            # Filter out file paths
            if text.startswith('/') or text.startswith('\\'):
                return False
            if '/app/' in text or '\\app\\' in text:
                return False
            if '/public/' in text or '\\public\\' in text:
                return False
            if text.endswith('.pdf') or text.endswith('.epub') or text.endswith('.html'):
                return False

            # Filter out UUIDs and hex strings (common in generated paths)
            if re.search(r'[a-f0-9]{16,}', text.lower()):
                return False

            # Filter out paths with multiple slashes
            if text.count('/') > 2 or text.count('\\') > 2:
                return False

            # Filter out very long "titles" that are likely paths or encoded data
            if len(text) > 200:
                return False

            # Filter out titles that are just numbers or very short
            if text.isdigit() or len(text) < 2:
                return False

            return True

        def get_text(self) -> str:
            """Get all extracted text, with post-processing to remove any remaining file paths."""
            text = ' '.join(self.text_parts)

            # Post-process: strip any file-path-like patterns that slipped through
            text = re.sub(
                r'/?(?:app/|public/|task/)[\w./-]*\.(?:pdf|epub|html|xhtml|txt)\b',
                '',
                text,
                flags=re.IGNORECASE
            )

            # Clean up any resulting double spaces or leading/trailing whitespace
            text = re.sub(r'\s{2,}', ' ', text).strip()
            return text

        def get_title(self) -> Optional[str]:
            """
            Get document title.
            Prioritizes h1/h2/h3 headings over <title> tag to avoid file paths.
            Only falls back to <title> if it's a valid title.
            """
            # If we found a valid heading, use it
            if self.title:
                return self.title

            # Fall back to <title> tag only if it's valid
            if self.title_from_tag and self._is_valid_title(self.title_from_tag):
                return self.title_from_tag

            return None

    def __init__(self):
        self._impl = SecureHTMLParser._Impl()

    def feed(self, data: str):
        self._impl.feed(data)

    def get_text(self) -> str:
        return self._impl.get_text()

    def get_title(self) -> Optional[str]:
        return self._impl.get_title()

    def get_image_positions(self) -> List[tuple]:
        """Return list of (word_index, src_path) for every <img> found."""
        return list(self._impl.image_positions)


class SecureEpubParser:
    """
    Secure EPUB parser with protections against common attacks.

    Protections:
    - Path traversal: Validates all file paths in ZIP
    - ZIP bombs: Checks compression ratios and sizes
    - XXE: Uses html.parser instead of lxml
    - Resource limits: Enforces file count and size limits

    Chapter extraction strategy:
    - Reads OPF spine for correct reading order (not ZIP file order)
    - Uses NCX/NAV TOC entries as chapter boundaries
    - Merges split files (e.g. part0000_split_000..013) into one logical chapter
    - Decodes HTML entities in titles
    - Never uses chapter body text as the chapter title
    """

    # Security limits
    MAX_FILES = 1000
    MAX_TOTAL_SIZE = 100 * 1024 * 1024  # 100MB uncompressed
    MAX_COMPRESSION_RATIO = 100  # Max 100:1 compression ratio
    MAX_FILE_SIZE = 15 * 1024 * 1024  # 15MB per file

    def __init__(self, file_obj: BinaryIO):
        self.file_obj = file_obj
        self._validated = False
        self._zipfile = None
        # Ordered TOC entries — preserves fragments so anchor-based chapters
        # can be split out of a single HTML file.
        # Each entry: {'href': str, 'fragment': str|None, 'title': str}
        self._toc_entries: List[Dict[str, Any]] = []
        # Backward-compat: fragment-stripped href → first matching title.
        # Derived from _toc_entries; preserved because callers and tests rely on it.
        self._toc_titles: Dict[str, str] = {}

    def validate(self) -> bool:
        """
        Validate EPUB file for security issues.

        Returns:
            True if file passes all security checks

        Raises:
            ValueError: If file is invalid
            SecurityError: If file fails security checks
        """
        self.file_obj.seek(0)

        # Check if valid ZIP
        if not zipfile.is_zipfile(self.file_obj):
            raise ValueError('File is not a valid EPUB (ZIP archive)')

        self.file_obj.seek(0)
        self._zipfile = zipfile.ZipFile(self.file_obj, 'r')

        # Check file count
        file_list = self._zipfile.namelist()
        if len(file_list) > self.MAX_FILES:
            raise SecurityError(
                f'EPUB contains too many files ({len(file_list)} > {self.MAX_FILES})'
            )

        total_uncompressed = 0

        for info in self._zipfile.infolist():
            # Check for path traversal
            if '..' in info.filename or info.filename.startswith('/'):
                raise SecurityError(
                    f'Potential path traversal detected: {info.filename}'
                )

            # Check for absolute paths (Windows)
            if ':' in info.filename:
                raise SecurityError(
                    f'Absolute path detected: {info.filename}'
                )

            # Check individual file size
            if info.file_size > self.MAX_FILE_SIZE:
                raise SecurityError(
                    f'File too large: {info.filename} ({info.file_size} bytes)'
                )

            # Check compression ratio (ZIP bomb detection)
            if info.compress_size > 0:
                ratio = info.file_size / info.compress_size
                if ratio > self.MAX_COMPRESSION_RATIO:
                    raise SecurityError(
                        f'Suspicious compression ratio for {info.filename}: {ratio:.1f}:1'
                    )

            total_uncompressed += info.file_size

        # Check total uncompressed size
        if total_uncompressed > self.MAX_TOTAL_SIZE:
            raise SecurityError(
                f'Total uncompressed size too large: {total_uncompressed} bytes'
            )

        self._validated = True
        return True

    def extract_text(self) -> str:
        """
        Extract all text from EPUB.

        Returns:
            Combined text content from all chapters
        """
        if not self._validated:
            self.validate()

        all_text = []

        for filename in self._zipfile.namelist():
            if self._is_content_file(filename):
                try:
                    content = self._zipfile.read(filename)
                    text = self._parse_html_safe(content)
                    if text.strip():
                        all_text.append(text)
                except Exception as e:
                    # Skip files that can't be parsed
                    print(f'[SECURITY] Warning: Could not parse {filename}: {e}')
                    continue

        return ' '.join(all_text)

    def extract_chapters(self) -> List[Dict[str, Any]]:
        """
        Extract chapters from EPUB with titles and content.

        Strategy:
        1. Parse OPF → spine-ordered file list (correct reading order)
        2. Parse NCX/NAV → TOC title map (titles ONLY from metadata, never body)
        3. Use TOC entries as chapter boundaries; merge split files into one chapter
        4. Fall back to per-file extraction if no TOC found

        Returns:
            List of chapter dicts: {id, title, content, duration, position}
        """
        if not self._validated:
            self.validate()

        # Step 1: Get reading order from OPF spine
        spine_files = self._get_spine_ordered_files()

        # Step 2: Parse TOC — fills self._toc_titles (href → title)
        self._parse_toc()

        chapters = []

        toc_is_useful = bool(self._toc_entries) and not self._is_degenerate_toc(spine_files)

        if toc_is_useful and spine_files:
            # Step 3a: TOC is trustworthy — group spine files using TOC boundaries,
            # splitting individual files at anchors when multiple TOC entries point to one file.
            chapters = self._build_chapters_from_toc_boundaries(spine_files)
        elif spine_files:
            # Step 3b: TOC missing or degenerate — split each spine file on <h1>/<h2>
            # headings so books like "The Secret" (1 TOC entry covering 100 spine files)
            # still produce real per-chapter audio.
            chapters = self._build_chapters_from_headings(spine_files)
        else:
            # Step 3c: No spine info — fall back to namelist() order
            fallback_files = [
                f for f in self._zipfile.namelist()
                if self._is_content_file(f)
            ]
            chapters = self._build_chapters_per_file(fallback_files)

        # Step 4: Auto-strip non-readable entries (copyright, TOC pages, dividers)
        chapters = self._filter_non_content_chapters(chapters)

        # Re-number after filtering so IDs and positions are sequential
        for idx, ch in enumerate(chapters):
            ch['id'] = str(idx + 1)
            ch['position'] = idx

        return chapters

    # ─── OPF / Spine ───────────────────────────────────────────────────────────

    def extract_book_language(self) -> Optional[str]:
        """
        Return the EPUB's declared language as an ISO 639-1 code (e.g. "en", "es"),
        or None if no <dc:language> element is found in the OPF metadata.

        Locale subtags are stripped: "en-GB" → "en", "zh-Hans" → "zh".
        """
        if not self._validated:
            self.validate()

        opf_path = self._find_opf_path()
        if not opf_path:
            return None

        try:
            opf_content = self._zipfile.read(opf_path).decode('utf-8', errors='replace')
        except Exception:
            return None

        m = re.search(
            r'<dc:language\b[^>]*>\s*([^<\s]+)\s*</dc:language>',
            opf_content,
            re.IGNORECASE,
        )
        if not m:
            return None

        lang = m.group(1).strip().lower()
        # Strip locale/script subtag: "en-GB" → "en", "zh-Hans" → "zh"
        return lang.split('-')[0] if '-' in lang else lang

    def _find_opf_path(self) -> Optional[str]:
        """
        Locate the OPF package document.

        Prefers container.xml (the spec-mandated location) so that OPF files
        placed at unusual paths are still found correctly.
        """
        # 1. Check META-INF/container.xml (EPUB spec requirement)
        container_candidates = [
            n for n in self._zipfile.namelist()
            if n.lower().endswith('container.xml')
        ]
        for container_path in container_candidates:
            try:
                content = self._zipfile.read(container_path).decode('utf-8', errors='replace')
                m = re.search(
                    r'<rootfile[^>]+full-path=["\']([^"\']+)["\']',
                    content,
                    re.IGNORECASE,
                )
                if m:
                    return m.group(1)
            except Exception:
                continue

        # 2. Fallback: find any .opf file
        for name in self._zipfile.namelist():
            if name.lower().endswith('.opf'):
                return name

        return None

    def _get_spine_ordered_files(self) -> List[str]:
        """
        Return content file paths in spine (reading) order.

        Parses OPF manifest + spine to resolve idref → href, then returns
        only files that are HTML/XHTML content.
        """
        opf_path = self._find_opf_path()
        if not opf_path:
            return []

        try:
            opf_content = self._zipfile.read(opf_path).decode('utf-8', errors='replace')
        except Exception as e:
            print(f'[EPUB] Cannot read OPF {opf_path}: {e}')
            return []

        opf_dir = posixpath.dirname(opf_path)

        # Build manifest: id → absolute href within ZIP
        manifest: Dict[str, str] = {}
        for item_match in re.finditer(r'<item\b([^>]+)>', opf_content, re.IGNORECASE):
            attrs = item_match.group(1)
            id_m = re.search(r'\bid=["\']([^"\']+)["\']', attrs)
            href_m = re.search(r'\bhref=["\']([^"\']+)["\']', attrs)
            if id_m and href_m:
                item_id = id_m.group(1)
                href = href_m.group(1)
                # Resolve relative href against OPF directory
                if opf_dir:
                    full_href = posixpath.normpath(posixpath.join(opf_dir, href))
                else:
                    full_href = href
                manifest[item_id] = full_href

        # Walk spine idrefs in document order
        spine_m = re.search(r'<spine\b[^>]*>(.*?)</spine>', opf_content, re.DOTALL | re.IGNORECASE)
        if not spine_m:
            return []

        spine_files: List[str] = []
        for idref_m in re.finditer(
            r'<itemref\b[^>]*\bidref=["\']([^"\']+)["\']',
            spine_m.group(1),
            re.IGNORECASE,
        ):
            item_id = idref_m.group(1)
            href = manifest.get(item_id)
            if href and self._is_content_file(href):
                spine_files.append(href)

        return spine_files

    # ─── TOC parsing (NCX + NAV) ───────────────────────────────────────────────

    def _parse_toc(self):
        """
        Parse EPUB Table of Contents to build self._toc_titles.

        Supports both NCX (EPUB 2) and NAV (EPUB 3).  NAV takes precedence
        when both are present because NAV is the EPUB 3 standard and tends to
        have cleaner titles.
        """
        try:
            self._parse_ncx()
        except Exception as e:
            print(f'[EPUB] NCX parsing failed: {e}')

        try:
            # NAV entries fully replace NCX entries when present — intentional.
            self._parse_nav()
        except Exception as e:
            print(f'[EPUB] NAV parsing failed: {e}')

        # Derive backward-compat title map (first title wins per fragment-stripped href).
        for entry in self._toc_entries:
            self._toc_titles.setdefault(entry['href'], entry['title'])

    def _parse_ncx(self):
        """
        Parse NCX file (EPUB 2 Table of Contents).

        Uses document order of navPoints — NOT playOrder — because playOrder
        is frequently absent, duplicated, or wrong in real-world EPUBs.
        """
        ncx_file = next(
            (n for n in self._zipfile.namelist() if n.lower().endswith('.ncx')),
            None,
        )
        if not ncx_file:
            return

        content = self._zipfile.read(ncx_file).decode('utf-8', errors='replace')

        # Match navPoints in document order.
        # Deliberately NOT requiring playOrder — it can be absent or wrong.
        # Capture the navLabel text and the content src attribute.
        navpoint_pattern = re.compile(
            r'<navPoint\b[^>]*>.*?'
            r'<navLabel\b[^>]*>\s*<text\b[^>]*>(.*?)</text>.*?'
            r'<content\b[^>]*\bsrc=["\']([^"\']+)["\']',
            re.DOTALL | re.IGNORECASE,
        )

        for match in navpoint_pattern.finditer(content):
            raw_title = match.group(1).strip()
            src = match.group(2).strip()

            # Decode HTML entities (e.g. &#39; → ')
            # Strip any inline HTML that ended up inside <text> (rare but happens).
            plain_title = re.sub(r'<[^>]+>', '', raw_title)
            title = unescape(plain_title).strip()

            # Preserve the fragment so we can split anchor-based chapters later.
            fragment = None
            if '#' in src:
                src, fragment = src.split('#', 1)

            src = self._normalize_content_path(src, ncx_file)

            if title and src:
                self._toc_entries.append({
                    'href': src,
                    'fragment': fragment,
                    'title': title,
                })

    def _parse_nav(self):
        """
        Parse NAV file (EPUB 3 Table of Contents).

        Looks for <nav epub:type="toc"> or <nav id="toc">, then extracts
        <a href="...">title</a> links.  Handles inline HTML inside <a> by
        stripping tags to get clean title text.
        """
        nav_file = next(
            (
                n for n in self._zipfile.namelist()
                if 'nav' in n.lower() and (
                    n.lower().endswith('.xhtml') or n.lower().endswith('.html')
                )
            ),
            None,
        )
        if not nav_file:
            return

        content = self._zipfile.read(nav_file).decode('utf-8', errors='replace')

        # Find the TOC nav element
        toc_nav_m = re.search(
            r'<nav\b[^>]*epub:type=["\']toc["\'][^>]*>(.*?)</nav>',
            content,
            re.DOTALL | re.IGNORECASE,
        )
        if not toc_nav_m:
            toc_nav_m = re.search(
                r'<nav\b[^>]*\bid=["\']toc["\'][^>]*>(.*?)</nav>',
                content,
                re.DOTALL | re.IGNORECASE,
            )
        if not toc_nav_m:
            return

        toc_content = toc_nav_m.group(1)

        # Extract <a href="...">...</a> — content between tags may include child elements
        link_pattern = re.compile(
            r'<a\b[^>]*\bhref=["\']([^"\']+)["\'][^>]*>(.*?)</a>',
            re.IGNORECASE | re.DOTALL,
        )

        # Track whether NAV produced any entries — if so, it overrides any NCX
        # entries we collected earlier (NAV is the EPUB 3 standard and tends
        # to have cleaner data).
        nav_entries: List[Dict[str, Any]] = []

        for match in link_pattern.finditer(toc_content):
            href = match.group(1).strip()
            raw_title = match.group(2)

            # Strip any child HTML tags to get plain text, then decode entities
            plain_title = re.sub(r'<[^>]+>', '', raw_title)
            title = unescape(plain_title).strip()

            # Preserve fragment for anchor-based chapter splitting.
            fragment = None
            if '#' in href:
                href, fragment = href.split('#', 1)

            href = self._normalize_content_path(href, nav_file)

            if title and href:
                nav_entries.append({
                    'href': href,
                    'fragment': fragment,
                    'title': title,
                })

        if nav_entries:
            self._toc_entries = nav_entries

    # ─── Chapter assembly ──────────────────────────────────────────────────────

    def _build_chapters_from_toc_boundaries(
        self, spine_files: List[str]
    ) -> List[Dict[str, Any]]:
        """
        Assemble logical chapters using the TOC as boundary information.

        Two cases per spine file:
        - 0 or 1 TOC entries point at it → standard behaviour: file starts a new
          chapter (or continues the previous one).  Calibre-style split files
          (split_000…split_013) get merged back together.
        - 2+ TOC entries point at it (with `#fragment` anchors) → split the
          file's HTML at those anchor IDs, producing one chapter per anchor.
          This is what fixes books like "The Subtle Art" where 50 TOC entries
          collapse to 15 unique files.
        """
        # Bucket TOC entries by spine href, preserving document order within each bucket.
        toc_by_href: Dict[str, List[Dict[str, Any]]] = {}
        for entry in self._toc_entries:
            toc_by_href.setdefault(entry['href'], []).append(entry)

        # Also handle basename-only TOC hrefs (some EPUBs strip directory paths
        # in the NCX even though the OPF resolves them fully).
        spine_by_basename: Dict[str, str] = {
            posixpath.basename(f): f for f in spine_files
        }
        for entry in self._toc_entries:
            if entry['href'] not in spine_by_basename.values():
                full = spine_by_basename.get(posixpath.basename(entry['href']))
                if full and full not in toc_by_href:
                    # Re-key by the full spine path so lookups below succeed.
                    toc_by_href.setdefault(full, []).append(entry)

        # Determine which spine files are chapter starts.
        spine_starts = [(idx, href) for idx, href in enumerate(spine_files) if href in toc_by_href]
        if not spine_starts:
            return self._build_chapters_per_file(spine_files)

        chapters: List[Dict[str, Any]] = []

        def _append_chapter(title: str, text: str, image_inserts: List[Dict[str, Any]]):
            if not text.strip():
                return
            chapters.append({
                'id': str(len(chapters) + 1),
                'title': title,
                'content': text,
                'duration': 0,
                'position': len(chapters),
                '_raw_image_inserts': image_inserts,
            })

        for group_idx, (start_idx, start_href) in enumerate(spine_starts):
            end_idx = (
                spine_starts[group_idx + 1][0]
                if group_idx + 1 < len(spine_starts)
                else len(spine_files)
            )
            group_files = spine_files[start_idx:end_idx]
            entries_for_start_file = toc_by_href[start_href]

            anchor_entries = [e for e in entries_for_start_file if e['fragment']]
            plain_entries = [e for e in entries_for_start_file if not e['fragment']]

            # ── Case A: file holds multiple chapters separated by anchors ──
            # Trigger: 2+ anchor entries and *no* plain entry pointing at the
            # same file.  When a plain entry exists alongside anchors (e.g.
            # "Chapter 1" + "Chapter 1 → How to..."), the anchors are
            # sub-sections of one chapter — don't split them.
            if len(anchor_entries) >= 2 and not plain_entries:
                anchor_chapters = self._split_file_at_anchors(start_href, entries_for_start_file)

                # Continuation files (split_001…) share the *last* anchor chapter.
                continuation_files = group_files[1:]
                if continuation_files and anchor_chapters:
                    extra_text, extra_inserts = self._collect_text_from_files(
                        continuation_files,
                        word_offset=len(anchor_chapters[-1]['content'].split()),
                    )
                    if extra_text:
                        anchor_chapters[-1]['content'] = (
                            anchor_chapters[-1]['content'] + ' ' + extra_text
                        ).strip()
                        anchor_chapters[-1]['_raw_image_inserts'].extend(extra_inserts)

                for ac in anchor_chapters:
                    _append_chapter(ac['title'], ac['content'], ac['_raw_image_inserts'])
                continue

            # ── Case B: standard chapter (possibly multi-file).  Prefer the
            # plain (fragmentless) TOC title if one exists — it's the chapter
            # heading rather than a sub-section heading.
            title = (plain_entries or entries_for_start_file)[0]['title']
            combined_text, image_inserts = self._collect_text_from_files(group_files)
            _append_chapter(title, combined_text, image_inserts)

        return chapters

    def _collect_text_from_files(
        self, files: List[str], word_offset: int = 0
    ) -> tuple:
        """
        Read and concatenate text from a sequence of spine files.
        Returns (combined_text, image_inserts).
        """
        text_parts: List[str] = []
        image_inserts: List[Dict[str, Any]] = []
        running_offset = word_offset

        for href in files:
            try:
                content_bytes = self._zipfile.read(href)
                text, images = self._parse_html_with_images(content_bytes, href)
            except Exception as e:
                print(f'[EPUB] Warning: Could not parse {href}: {e}')
                continue

            if not text.strip():
                continue

            for wi, src, ref in images:
                image_inserts.append({
                    'wordIndex': wi + running_offset,
                    'src': src,
                    'refFile': ref,
                })
            running_offset += len(text.split())
            text_parts.append(text)

        return ' '.join(text_parts).strip(), image_inserts

    def _split_file_at_anchors(
        self, href: str, entries: List[Dict[str, Any]]
    ) -> List[Dict[str, Any]]:
        """
        Split a single HTML file into multiple chapter records based on the
        anchor IDs referenced by `entries`.

        Each entry must have a `fragment` (the anchor name).  Entries without
        fragments are treated as the prefix section (everything before the
        first anchor) — typically a chapter intro.
        """
        anchor_ids = [e['fragment'] for e in entries if e['fragment']]
        if not anchor_ids:
            # No fragments — caller shouldn't have routed us here, but degrade gracefully.
            text, inserts = self._collect_text_from_files([href])
            return [{
                'title': entries[0]['title'],
                'content': text,
                '_raw_image_inserts': inserts,
            }]

        try:
            content_bytes = self._zipfile.read(href)
        except Exception as e:
            print(f'[EPUB] Warning: Could not read {href} for anchor split: {e}')
            return []

        try:
            html_str = content_bytes.decode('utf-8', errors='replace')
        except Exception:
            html_str = content_bytes.decode('latin-1', errors='replace')

        splitter = _AnchorSplitParser(anchor_ids)
        try:
            splitter.feed(html_str)
        except Exception as e:
            print(f'[EPUB] Anchor splitter failed on {href}: {e} — falling back to whole file')
            text, inserts = self._collect_text_from_files([href])
            return [{
                'title': entries[0]['title'],
                'content': text,
                '_raw_image_inserts': inserts,
            }]

        sections = splitter.get_sections()

        # First fragmentless entry (if any) owns the prefix; otherwise the
        # prefix is dropped (it's typically a brief preamble that belongs to
        # whatever came before in the spine).
        prefix_entry = next((e for e in entries if not e['fragment']), None)

        chapter_records: List[Dict[str, Any]] = []

        if prefix_entry:
            prefix_text, prefix_imgs = sections.get(None, ('', []))
            chapter_records.append({
                'title': prefix_entry['title'],
                'content': prefix_text,
                '_raw_image_inserts': [
                    {'wordIndex': wi, 'src': src, 'refFile': href}
                    for wi, src in prefix_imgs
                ],
            })

        for entry in entries:
            if not entry['fragment']:
                continue
            sec_text, sec_imgs = sections.get(entry['fragment'], ('', []))
            if not sec_text:
                # Anchor not found in HTML — skip rather than emit an empty chapter.
                continue
            chapter_records.append({
                'title': entry['title'],
                'content': sec_text,
                '_raw_image_inserts': [
                    {'wordIndex': wi, 'src': src, 'refFile': href}
                    for wi, src in sec_imgs
                ],
            })

        return chapter_records

    def _is_degenerate_toc(self, spine_files: List[str]) -> bool:
        """
        Detect "useless TOC" cases like books with a single navPoint titled
        "Start" covering 50+ spine files.  When this happens, we'd rather
        ignore the TOC entirely and split on headings instead.
        """
        if not self._toc_entries or not spine_files:
            return False

        unique_files = {e['href'] for e in self._toc_entries}
        # Exactly 1 TOC entry covering many spine files → useless.
        if len(self._toc_entries) <= 1 and len(spine_files) >= 4:
            return True

        # 1 unique file in TOC but many in spine → also useless (e.g. all entries
        # point at "index.html" which spans the whole book).
        if len(unique_files) == 1 and len(spine_files) >= 4:
            return True

        return False

    def _build_chapters_from_headings(
        self, spine_files: List[str]
    ) -> List[Dict[str, Any]]:
        """
        Split each spine file at <h1>/<h2> headings to recover chapter
        structure when the TOC is missing or useless.

        Falls back to one-chapter-per-file behaviour for spine files that
        contain no headings.
        """
        chapters: List[Dict[str, Any]] = []
        chapter_num = 1

        for href in spine_files:
            try:
                content_bytes = self._zipfile.read(href)
            except Exception as e:
                print(f'[EPUB] Warning: Could not read {href}: {e}')
                continue

            try:
                html_str = content_bytes.decode('utf-8', errors='replace')
            except Exception:
                html_str = content_bytes.decode('latin-1', errors='replace')

            splitter = _HeadingSplitParser()
            try:
                splitter.feed(html_str)
            except Exception as e:
                print(f'[EPUB] Heading splitter failed on {href}: {e}')
                continue

            sections = splitter.get_sections()

            # If the file has no headings, fall back to whole-file chapter.
            if not sections or all(s['title'] is None for s in sections):
                text, images = self._parse_html_with_images(content_bytes, href)
                if not text.strip():
                    continue
                chapters.append({
                    'id': str(chapter_num),
                    'title': self._get_toc_title(href) or f'Chapter {chapter_num}',
                    'content': text,
                    'duration': 0,
                    'position': chapter_num - 1,
                    '_raw_image_inserts': [
                        {'wordIndex': wi, 'src': src, 'refFile': ref}
                        for wi, src, ref in images
                    ],
                })
                chapter_num += 1
                continue

            for sec in sections:
                if not sec['text'].strip():
                    continue
                title = sec['title'] or f'Chapter {chapter_num}'
                chapters.append({
                    'id': str(chapter_num),
                    'title': title,
                    'content': sec['text'],
                    'duration': 0,
                    'position': chapter_num - 1,
                    '_raw_image_inserts': [
                        {'wordIndex': wi, 'src': src, 'refFile': href}
                        for wi, src in sec['images']
                    ],
                })
                chapter_num += 1

        return chapters

    def _build_chapters_per_file(
        self, content_files: List[str]
    ) -> List[Dict[str, Any]]:
        """
        Fallback: one chapter per content file.
        Title comes from the heading in the file; never from body text.
        """
        chapters: List[Dict[str, Any]] = []
        chapter_num = 1

        for filename in content_files:
            try:
                content_bytes = self._zipfile.read(filename)
            except Exception as e:
                print(f'[EPUB] Warning: Could not read {filename}: {e}')
                continue

            text, images = self._parse_html_with_images(content_bytes, filename)
            if not text.strip():
                continue

            # Re-parse for title (get_title lives on SecureHTMLParser)
            parser = SecureHTMLParser()
            try:
                parser.feed(content_bytes.decode('utf-8', errors='replace'))
            except Exception:
                parser.feed(content_bytes.decode('latin-1', errors='replace'))

            title = (
                self._get_toc_title(filename)
                or parser.get_title()
                or f'Chapter {chapter_num}'
            )

            raw_image_inserts = [
                {'wordIndex': wi, 'src': src, 'refFile': ref}
                for wi, src, ref in images
            ]

            chapters.append({
                'id': str(chapter_num),
                'title': title,
                'content': text,
                'duration': 0,
                'position': chapter_num - 1,
                '_raw_image_inserts': raw_image_inserts,
            })
            chapter_num += 1

        return chapters

    # ─── Auto-filter ───────────────────────────────────────────────────────────

    # Titles that are never meaningful spoken content.
    # Lower-cased for case-insensitive comparison.
    _JUNK_TITLES = frozenset({
        'table of contents', 'contents', 'toc',
        'copyright', 'copyright page',
        'title page', 'title',
        'cover', 'cover page',
        'dedication',
        '...', '…',
    })

    # Chapters with fewer than this many words of content are almost always
    # section dividers or blank spacer pages — not meaningful spoken content.
    _MIN_WORD_COUNT = 50
    # CJK fallback: Japanese/Chinese don't use whitespace between words, so the
    # whitespace-token count above massively under-counts real prose. We treat
    # a chapter as "long enough" if EITHER the whitespace word count clears
    # _MIN_WORD_COUNT OR the count of CJK ideographs/kana clears this threshold.
    # 100 CJK chars ≈ 2 short paragraphs of real prose — comfortably above the
    # "header / blank divider" range we're trying to filter out.
    _MIN_CJK_CHAR_COUNT = 100

    @staticmethod
    def _count_cjk_chars(text: str) -> int:
        """Count CJK ideographs + Japanese kana + Hangul syllables."""
        return sum(
            1 for ch in text
            if (
                '぀' <= ch <= 'ヿ'   # Hiragana + Katakana
                or '㐀' <= ch <= '䶿'  # CJK Ext A
                or '一' <= ch <= '鿿'  # CJK Unified
                or '가' <= ch <= '힯'  # Hangul Syllables
            )
        )

    def _filter_non_content_chapters(
        self, chapters: List[Dict[str, Any]]
    ) -> List[Dict[str, Any]]:
        """
        Remove chapters that would be useless or jarring when read aloud:
        - Known boilerplate titles (copyright, table of contents, etc.)
        - Chapters with fewer than 50 words (section dividers, part headers)
          — with a CJK character-count fallback so Japanese/Chinese books
          aren't accidentally emptied (their `.split()` token count is tiny).

        Books that already extract cleanly (e.g. claudeLit, Rational Male) are
        unaffected because their chapters are all 400+ words and have proper titles.
        """
        kept = []
        for ch in chapters:
            content = ch.get('content', '')
            title_lower = ch.get('title', '').strip().lower()
            word_count = len(content.split())
            cjk_count = self._count_cjk_chars(content)

            if title_lower in self._JUNK_TITLES:
                print(f'[EPUB] Auto-skipped junk title: {ch["title"]!r}')
                continue

            if word_count < self._MIN_WORD_COUNT and cjk_count < self._MIN_CJK_CHAR_COUNT:
                print(
                    f'[EPUB] Auto-skipped short chapter: {ch["title"]!r} '
                    f'({word_count} words, {cjk_count} CJK chars)'
                )
                continue

            kept.append(ch)

        return kept

    # ─── Helpers ───────────────────────────────────────────────────────────────

    def _normalize_content_path(self, path: str, reference_file: str) -> str:
        """
        Resolve a path that is relative to a reference file into an absolute
        ZIP-internal path (no leading slash).
        """
        # Already absolute within the ZIP
        if path.startswith('/'):
            return path.lstrip('/')

        ref_dir = posixpath.dirname(reference_file)
        full_path = posixpath.normpath(posixpath.join(ref_dir, path))
        return full_path

    def _get_toc_title(self, filename: str) -> Optional[str]:
        """
        Look up the TOC title for a content file.

        Tries exact match first, then basename match to handle cases where the
        OPF and TOC use different relative base directories.
        """
        if filename in self._toc_titles:
            return self._toc_titles[filename]

        # Basename fallback (e.g. OPF resolves "OEBPS/Text/ch1.xhtml" but NCX
        # stored just "ch1.xhtml")
        basename = posixpath.basename(filename)
        for toc_path, title in self._toc_titles.items():
            if posixpath.basename(toc_path) == basename:
                return title

        return None

    def read_zip_file(self, path: str) -> Optional[bytes]:
        """
        Read raw bytes for any file inside the EPUB ZIP.
        Used by the upload layer to retrieve image data without re-opening the ZIP.
        Returns None if the path does not exist.
        """
        try:
            return self._zipfile.read(path)
        except Exception:
            return None

    def _parse_html_with_images(
        self, content: bytes, ref_file: str
    ) -> tuple:
        """
        Parse an HTML/XHTML file and return (text, images).

        images is a list of (word_index, src_path, ref_file) tuples where
        src_path is the raw src attribute value from the <img> tag and
        ref_file is the content file path needed to resolve relative paths.
        """
        try:
            text_str = content.decode('utf-8', errors='replace')
        except Exception:
            text_str = content.decode('latin-1', errors='replace')

        parser = SecureHTMLParser()
        parser.feed(text_str)
        text = parser.get_text()
        images = [
            (wi, src, ref_file)
            for wi, src in parser.get_image_positions()
        ]
        return text, images

    def _is_content_file(self, filename: str) -> bool:
        """Return True if this file is an HTML/XHTML content document."""
        lower = filename.lower()
        return (
            lower.endswith('.html') or
            lower.endswith('.xhtml') or
            lower.endswith('.htm') or
            lower.endswith('.xml')
        ) and not lower.startswith('meta-inf/')

    def _parse_html_safe(self, content: bytes) -> str:
        """
        Decode and extract plain text from an HTML/XHTML file safely.
        """
        try:
            text = content.decode('utf-8', errors='replace')
        except Exception:
            text = content.decode('latin-1', errors='replace')

        parser = SecureHTMLParser()
        parser.feed(text)
        return parser.get_text()

    def close(self):
        """Close the ZIP file."""
        if self._zipfile:
            self._zipfile.close()
            self._zipfile = None

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        self.close()
        return False


class SecurityError(Exception):
    """Security-related error during EPUB parsing"""
    pass
