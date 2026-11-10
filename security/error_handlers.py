"""
Production Error Handlers
Provides generic error messages for production, detailed logs server-side
"""

import os
import traceback
from werkzeug.exceptions import HTTPException
from flask import Flask, jsonify
from .logging import get_secure_logger


# Check if in debug mode
def is_debug_mode() -> bool:
    """Check if running in debug mode"""
    debug = os.environ.get('DEBUG', 'false').lower()
    return debug in ('true', '1', 'yes')


def handle_error(
    error: Exception,
    status_code: int = 500,
    public_message: str = None
) -> tuple:
    """
    Handle an error securely.

    - Logs full error details server-side
    - Returns generic message to client in production
    - Returns detailed message in debug mode

    Args:
        error: The exception that occurred
        status_code: HTTP status code to return
        public_message: Optional generic message for client

    Returns:
        Tuple of (response, status_code)
    """
    logger = get_secure_logger()

    # Log full error server-side
    logger.error(f'Error: {str(error)}')
    logger.error(f'Traceback:\n{traceback.format_exc()}')

    # Default public messages
    default_messages = {
        400: 'Invalid request',
        401: 'Authentication required',
        403: 'Access denied',
        404: 'Resource not found',
        429: 'Too many requests',
        500: 'An error occurred',
    }

    # Determine response message
    if is_debug_mode():
        # In debug mode, return detailed error
        response_message = str(error)
    else:
        # In production, return generic message
        response_message = public_message or default_messages.get(
            status_code, 'An error occurred'
        )

    return jsonify({'error': response_message}), status_code


def init_error_handlers(app: Flask):
    """
    Initialize global error handlers for Flask app.

    Args:
        app: Flask application instance
    """
    logger = get_secure_logger()

    @app.errorhandler(400)
    def bad_request_handler(error):
        logger.warning(f'Bad request: {error}')
        if is_debug_mode():
            return jsonify({'error': str(error)}), 400
        return jsonify({'error': 'Invalid request'}), 400

    @app.errorhandler(401)
    def unauthorized_handler(error):
        logger.warning(f'Unauthorized: {error}')
        return jsonify({'error': 'Authentication required'}), 401

    @app.errorhandler(403)
    def forbidden_handler(error):
        logger.warning(f'Forbidden: {error}')
        return jsonify({'error': 'Access denied'}), 403

    @app.errorhandler(404)
    def not_found_handler(error):
        logger.info(f'Not found: {error}')
        return jsonify({'error': 'Resource not found'}), 404

    @app.errorhandler(429)
    def rate_limit_handler(error):
        logger.warning(f'Rate limit exceeded: {error}')
        return jsonify({'error': 'Too many requests. Please try again later.'}), 429

    @app.errorhandler(500)
    def internal_error_handler(error):
        logger.error(f'Internal server error: {error}')
        logger.error(f'Traceback:\n{traceback.format_exc()}')
        if is_debug_mode():
            return jsonify({'error': str(error)}), 500
        return jsonify({'error': 'An error occurred'}), 500

    @app.errorhandler(Exception)
    def generic_error_handler(error):
        # Werkzeug HTTP errors that have no dedicated handler above (405 on a
        # POST-only route, 413 from MAX_CONTENT_LENGTH, 415 …) are still
        # HTTPExceptions — keep their status instead of collapsing them to a
        # 500. Bot GETs on /api/demo/* were logging as server errors.
        if isinstance(error, HTTPException):
            logger.info(f'HTTP {error.code}: {error}')
            return jsonify({'error': error.name}), error.code
        logger.error(f'Unhandled exception: {error}')
        logger.error(f'Traceback:\n{traceback.format_exc()}')
        if is_debug_mode():
            return jsonify({'error': str(error)}), 500
        return jsonify({'error': 'An error occurred'}), 500

    print('[SECURITY] Error handlers initialized')
