"""
Security Module for EbookVoiceReact
OWASP Top 10 Security Hardening Implementation

This module provides:
- Authentication decorators (@require_auth, @optional_auth, @require_task_ownership)
- Rate limiting middleware (in-memory, suitable for single-server deployments)
- Input validation utilities
- Security headers middleware
- Secure logging (no sensitive data)
- Production error handling
- Secure EPUB parsing

Usage:
    from security import (
        optional_auth,
        require_task_ownership,
        rate_limit,
        add_security_headers,
        validate_voice_id,
        validate_task_id,
        get_secure_logger
    )
"""

from .decorators import optional_auth, require_task_ownership
from .rate_limiter import rate_limit, RateLimiter
from .validators import (
    validate_voice_id,
    validate_task_id,
    validate_audiobook_id,
    validate_text_content,
    validate_epub_file,
    validate_docx_file,
    validate_daisy_file,
    ValidationError
)
from .headers import add_security_headers, init_security_headers
from .logging import get_secure_logger, log_security_event
from .error_handlers import init_error_handlers, handle_error
from .epub_parser import SecureEpubParser
from .docx_parser import extract_docx_chapters
from .daisy_parser import extract_daisy_chapters

__all__ = [
    # Decorators
    'optional_auth',
    'require_task_ownership',
    # Rate limiting
    'rate_limit',
    'RateLimiter',
    # Validators
    'validate_voice_id',
    'validate_task_id',
    'validate_audiobook_id',
    'validate_text_content',
    'validate_epub_file',
    'validate_docx_file',
    'validate_daisy_file',
    'ValidationError',
    # Headers
    'add_security_headers',
    'init_security_headers',
    # Logging
    'get_secure_logger',
    'log_security_event',
    # Error handlers
    'init_error_handlers',
    'handle_error',
    # EPUB parser
    'SecureEpubParser',
    # DOCX parser
    'extract_docx_chapters',
    # DAISY parser
    'extract_daisy_chapters',
]
