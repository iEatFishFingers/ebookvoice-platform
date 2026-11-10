"""
Input Validation Utilities
Prevents injection attacks and validates user input
"""

import re
import uuid
import os
from typing import Optional, BinaryIO


class ValidationError(Exception):
    """Custom exception for validation errors"""
    def __init__(self, message: str, field: str = None):
        self.message = message
        self.field = field
        super().__init__(message)


# Valid voice ID patterns for Edge TTS
# Format: en-US-TonyNeural, en-GB-SoniaNeural, etc.
VOICE_ID_PATTERN = re.compile(r'^[a-z]{2}-[A-Z]{2}-[A-Za-z]+Neural$')

# Alternative patterns for other voice formats
VOICE_ID_PATTERNS = [
    re.compile(r'^[a-z]{2}-[A-Z]{2}-[A-Za-z]+Neural$'),        # Standard: en-US-TonyNeural
    re.compile(r'^[a-z]{2}-[A-Z]{2}-[A-Za-z]+Neural\d*$'),     # With number: en-US-Guy24Neural
    re.compile(r'^[a-z]{2,3}-[A-Z]{2}-[A-Za-z0-9]+Neural$'),   # 3-letter lang: cmn-CN-XiaoxiaoNeural
]

# Task ID pattern (timestamp + random hex)
TASK_ID_PATTERN = re.compile(r'^\d{13}_[a-f0-9]{16}$')

# Legacy task ID pattern (timestamp only) - for backwards compatibility
LEGACY_TASK_ID_PATTERN = re.compile(r'^\d{13}$')

# UUID v4 pattern
UUID_PATTERN = re.compile(
    r'^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
    re.IGNORECASE
)


def validate_voice_id(voice_id: str) -> bool:
    """
    Validate voice ID format to prevent injection.

    Args:
        voice_id: Voice ID string to validate

    Returns:
        True if valid

    Raises:
        ValidationError: If voice ID is invalid
    """
    if not voice_id:
        raise ValidationError('Voice ID is required', 'voice_id')

    if not isinstance(voice_id, str):
        raise ValidationError('Voice ID must be a string', 'voice_id')

    if len(voice_id) > 50:
        raise ValidationError('Voice ID is too long', 'voice_id')

    # Check against known patterns
    for pattern in VOICE_ID_PATTERNS:
        if pattern.match(voice_id):
            return True

    raise ValidationError(
        'Invalid voice ID format. Expected format: en-US-TonyNeural',
        'voice_id'
    )


def validate_task_id(task_id: str) -> bool:
    """
    Validate task ID format.

    Args:
        task_id: Task ID string to validate

    Returns:
        True if valid

    Raises:
        ValidationError: If task ID is invalid
    """
    if not task_id:
        raise ValidationError('Task ID is required', 'task_id')

    if not isinstance(task_id, str):
        raise ValidationError('Task ID must be a string', 'task_id')

    if len(task_id) > 50:
        raise ValidationError('Task ID is too long', 'task_id')

    # Check against patterns (new format and legacy)
    if TASK_ID_PATTERN.match(task_id) or LEGACY_TASK_ID_PATTERN.match(task_id):
        return True

    raise ValidationError('Invalid task ID format', 'task_id')


def validate_audiobook_id(audiobook_id: str) -> bool:
    """
    Validate audiobook ID (UUID format).

    Args:
        audiobook_id: Audiobook ID string to validate

    Returns:
        True if valid

    Raises:
        ValidationError: If audiobook ID is invalid
    """
    if not audiobook_id:
        raise ValidationError('Audiobook ID is required', 'audiobook_id')

    if not isinstance(audiobook_id, str):
        raise ValidationError('Audiobook ID must be a string', 'audiobook_id')

    if not UUID_PATTERN.match(audiobook_id):
        raise ValidationError('Invalid audiobook ID format', 'audiobook_id')

    return True


def validate_text_content(
    text: str,
    max_length: int = 500000,
    min_length: int = 1
) -> str:
    """
    Validate and sanitize text content for TTS conversion.

    Args:
        text: Text content to validate
        max_length: Maximum allowed length (default 500KB)
        min_length: Minimum required length (default 1)

    Returns:
        Sanitized text

    Raises:
        ValidationError: If text is invalid
    """
    if not text:
        raise ValidationError('Text content is required', 'text')

    if not isinstance(text, str):
        raise ValidationError('Text content must be a string', 'text')

    # Remove null bytes and other control characters (except newlines/tabs)
    sanitized = ''.join(
        char for char in text
        if char == '\n' or char == '\t' or char == '\r' or
        (ord(char) >= 32 and ord(char) != 127)
    )

    if len(sanitized) < min_length:
        raise ValidationError(
            f'Text content must be at least {min_length} characters',
            'text'
        )

    if len(sanitized) > max_length:
        raise ValidationError(
            f'Text content exceeds maximum length of {max_length} characters',
            'text'
        )

    return sanitized


def validate_epub_file(
    file_obj: BinaryIO,
    max_size_bytes: int = 15 * 1024 * 1024,  # 15MB upload cap
    filename: str = None
) -> bool:
    """
    Validate EPUB file for security.

    Checks:
    - File extension
    - Magic bytes (ZIP format)
    - File size
    - Basic ZIP structure

    Args:
        file_obj: File object to validate
        max_size_bytes: Maximum file size (default 15MB)
        filename: Original filename for extension check

    Returns:
        True if valid

    Raises:
        ValidationError: If file is invalid
    """
    # Check filename extension
    if filename:
        if not filename.lower().endswith('.epub'):
            raise ValidationError(
                'File must have .epub extension',
                'file'
            )

    # Check magic bytes (EPUB is a ZIP file)
    # ZIP magic: PK\x03\x04 or PK\x05\x06 (empty) or PK\x07\x08 (spanned)
    file_obj.seek(0)
    magic = file_obj.read(4)
    file_obj.seek(0)

    if magic[:2] != b'PK':
        raise ValidationError(
            'Invalid file format. File must be a valid EPUB (ZIP archive)',
            'file'
        )

    # Check file size
    file_obj.seek(0, 2)  # Seek to end
    file_size = file_obj.tell()
    file_obj.seek(0)  # Reset to beginning

    if file_size > max_size_bytes:
        raise ValidationError(
            "This EPUB couldn't be processed. Please try a different book.",
            'file'
        )

    if file_size == 0:
        raise ValidationError('File is empty', 'file')

    return True


def validate_docx_file(
    file_obj: BinaryIO,
    max_size_bytes: int = 15 * 1024 * 1024,  # 15MB upload cap (matches EPUB)
    filename: str = None
) -> bool:
    """
    Validate a Word (.docx) upload for security.

    A .docx is an Office Open XML package — i.e. a ZIP archive — so it shares
    EPUB's magic bytes (PK) and the same size/structure checks apply. Only the
    extension differs.

    Raises:
        ValidationError: If file is invalid
    """
    if filename:
        if not filename.lower().endswith('.docx'):
            raise ValidationError('File must have .docx extension', 'file')

    # .docx, like EPUB, is a ZIP archive → must start with the PK magic bytes.
    file_obj.seek(0)
    magic = file_obj.read(4)
    file_obj.seek(0)

    if magic[:2] != b'PK':
        raise ValidationError(
            'Invalid file format. File must be a valid Word document (.docx)',
            'file'
        )

    file_obj.seek(0, 2)
    file_size = file_obj.tell()
    file_obj.seek(0)

    if file_size > max_size_bytes:
        raise ValidationError(
            "This document couldn't be processed. Please try a different file.",
            'file'
        )

    if file_size == 0:
        raise ValidationError('File is empty', 'file')

    return True


def validate_daisy_file(
    file_obj: BinaryIO,
    max_size_bytes: int = 15 * 1024 * 1024,  # 15MB upload cap (matches EPUB)
    filename: str = None
) -> bool:
    """
    Validate a DAISY book upload (.zip) for security.

    DAISY books download as ZIP archives (BookShare et al.), so the same PK
    magic + size checks as EPUB/.docx apply. Whether the zip actually contains
    a DAISY book (DTBook XML / ncc.html) is decided by the parser, which also
    runs the ZIP-bomb checks before decompressing anything.

    Raises:
        ValidationError: If file is invalid
    """
    if filename:
        if not filename.lower().endswith('.zip'):
            raise ValidationError('File must have .zip extension', 'file')

    file_obj.seek(0)
    magic = file_obj.read(4)
    file_obj.seek(0)

    if magic[:2] != b'PK':
        raise ValidationError(
            'Invalid file format. File must be a DAISY book (.zip archive)',
            'file'
        )

    file_obj.seek(0, 2)
    file_size = file_obj.tell()
    file_obj.seek(0)

    if file_size > max_size_bytes:
        raise ValidationError(
            "This DAISY book couldn't be processed. If it's an audio DAISY "
            "book, please use the text edition instead.",
            'file'
        )

    if file_size == 0:
        raise ValidationError('File is empty', 'file')

    return True


def validate_chapter_data(chapter: dict) -> bool:
    """
    Validate chapter data structure.

    Args:
        chapter: Chapter dictionary to validate

    Returns:
        True if valid

    Raises:
        ValidationError: If chapter data is invalid
    """
    if not isinstance(chapter, dict):
        raise ValidationError('Chapter must be an object', 'chapter')

    # Validate required fields
    if 'content' not in chapter:
        raise ValidationError('Chapter must have content', 'chapter.content')

    content = chapter.get('content', '')
    if not content or not content.strip():
        raise ValidationError('Chapter content cannot be empty', 'chapter.content')

    # Validate content length
    validate_text_content(content, max_length=100000)  # 100KB per chapter

    # Validate optional fields
    if 'title' in chapter:
        title = chapter['title']
        if not isinstance(title, str):
            raise ValidationError('Chapter title must be a string', 'chapter.title')
        if len(title) > 500:
            raise ValidationError('Chapter title is too long', 'chapter.title')

    if 'id' in chapter:
        chapter_id = chapter['id']
        if not isinstance(chapter_id, (str, int)):
            raise ValidationError('Chapter ID must be a string or number', 'chapter.id')

    return True


def sanitize_filename(filename: str, max_length: int = 255) -> str:
    """
    Sanitize filename to prevent path traversal and other attacks.

    Args:
        filename: Original filename
        max_length: Maximum filename length

    Returns:
        Sanitized filename
    """
    if not filename:
        return 'unnamed'

    # Remove path separators and null bytes
    filename = os.path.basename(filename)
    filename = filename.replace('\x00', '')

    # Remove or replace dangerous characters
    # Keep alphanumeric, dots, underscores, hyphens, and spaces
    sanitized = re.sub(r'[^\w\s\-\.]', '_', filename)

    # Remove leading/trailing dots and spaces
    sanitized = sanitized.strip('. ')

    # Prevent empty or dot-only filenames
    if not sanitized or sanitized in ('.', '..'):
        return 'unnamed'

    # Truncate to max length
    if len(sanitized) > max_length:
        name, ext = os.path.splitext(sanitized)
        max_name = max_length - len(ext)
        sanitized = name[:max_name] + ext

    return sanitized
