"""
Secure Logging Module
Provides logging utilities that never log sensitive data
"""

import os
import logging
from datetime import datetime, timezone
from typing import Optional


# Configure secure logger
_logger = None


def get_secure_logger(name: str = 'security') -> logging.Logger:
    """
    Get a configured logger that follows security best practices.

    Features:
    - No sensitive data in logs
    - Structured logging format
    - Appropriate log level from environment

    Args:
        name: Logger name

    Returns:
        Configured logger instance
    """
    global _logger

    if _logger is None:
        _logger = logging.getLogger(name)

        # Set level from environment
        log_level = os.environ.get('LOG_LEVEL', 'INFO').upper()
        _logger.setLevel(getattr(logging, log_level, logging.INFO))

        # Create handler if none exists
        if not _logger.handlers:
            handler = logging.StreamHandler()
            handler.setLevel(logging.DEBUG)

            # Structured format
            formatter = logging.Formatter(
                '[%(asctime)s] %(levelname)s [%(name)s] %(message)s',
                datefmt='%Y-%m-%d %H:%M:%S'
            )
            handler.setFormatter(formatter)
            _logger.addHandler(handler)

    return _logger


def log_security_event(
    event_type: str,
    user_id: Optional[str] = None,
    ip_address: Optional[str] = None,
    details: Optional[dict] = None,
    level: str = 'INFO'
):
    """
    Log a security-relevant event.

    Never logs sensitive data like tokens, passwords, or full user data.

    Args:
        event_type: Type of event (e.g., 'auth_success', 'rate_limit_exceeded')
        user_id: User ID (will be partially masked)
        ip_address: Client IP address
        details: Additional details (sensitive fields will be filtered)
        level: Log level (DEBUG, INFO, WARNING, ERROR)
    """
    logger = get_secure_logger()

    # Mask user_id if present (show only first 8 chars)
    masked_user_id = None
    if user_id:
        masked_user_id = user_id[:8] + '...' if len(user_id) > 8 else user_id

    # Filter sensitive fields from details
    safe_details = {}
    if details:
        sensitive_fields = {
            'token', 'password', 'secret', 'key', 'authorization',
            'credit_card', 'ssn', 'api_key', 'access_token', 'refresh_token'
        }
        for key, value in details.items():
            key_lower = key.lower()
            if any(sensitive in key_lower for sensitive in sensitive_fields):
                safe_details[key] = '[REDACTED]'
            else:
                safe_details[key] = value

    # Build log message
    message_parts = [f'event={event_type}']

    if masked_user_id:
        message_parts.append(f'user={masked_user_id}')

    if ip_address:
        message_parts.append(f'ip={ip_address}')

    if safe_details:
        message_parts.append(f'details={safe_details}')

    message = ' '.join(message_parts)

    # Log at appropriate level
    log_method = getattr(logger, level.lower(), logger.info)
    log_method(message)


def log_auth_attempt(
    success: bool,
    user_id: Optional[str] = None,
    ip_address: Optional[str] = None,
    reason: Optional[str] = None
):
    """
    Log an authentication attempt.

    Args:
        success: Whether authentication succeeded
        user_id: User ID if known (will be masked)
        ip_address: Client IP address
        reason: Failure reason if not successful
    """
    event_type = 'auth_success' if success else 'auth_failure'
    level = 'INFO' if success else 'WARNING'

    details = {}
    if reason and not success:
        details['reason'] = reason

    log_security_event(
        event_type=event_type,
        user_id=user_id,
        ip_address=ip_address,
        details=details if details else None,
        level=level
    )


def log_rate_limit(
    endpoint: str,
    user_id: Optional[str] = None,
    ip_address: Optional[str] = None,
    limit: int = None,
    window: int = None
):
    """
    Log a rate limit exceeded event.

    Args:
        endpoint: The endpoint that was rate limited
        user_id: User ID if authenticated
        ip_address: Client IP address
        limit: The rate limit that was exceeded
        window: The time window in seconds
    """
    details = {'endpoint': endpoint}
    if limit:
        details['limit'] = limit
    if window:
        details['window_seconds'] = window

    log_security_event(
        event_type='rate_limit_exceeded',
        user_id=user_id,
        ip_address=ip_address,
        details=details,
        level='WARNING'
    )


def log_validation_error(
    field: str,
    error: str,
    ip_address: Optional[str] = None,
    user_id: Optional[str] = None
):
    """
    Log a validation error.

    Args:
        field: The field that failed validation
        error: The validation error message
        ip_address: Client IP address
        user_id: User ID if authenticated
    """
    log_security_event(
        event_type='validation_error',
        user_id=user_id,
        ip_address=ip_address,
        details={'field': field, 'error': error},
        level='WARNING'
    )


def log_suspicious_activity(
    activity_type: str,
    ip_address: Optional[str] = None,
    user_id: Optional[str] = None,
    details: Optional[dict] = None
):
    """
    Log suspicious activity for security monitoring.

    Args:
        activity_type: Type of suspicious activity
        ip_address: Client IP address
        user_id: User ID if known
        details: Additional context
    """
    log_security_event(
        event_type=f'suspicious_{activity_type}',
        user_id=user_id,
        ip_address=ip_address,
        details=details,
        level='WARNING'
    )
