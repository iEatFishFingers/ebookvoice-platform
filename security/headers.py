"""
Security Headers Middleware
Adds security headers to all responses
"""

from flask import Flask


def add_security_headers(response):
    """
    Add security headers to response.

    Headers added:
    - Strict-Transport-Security: Enforce HTTPS
    - X-Frame-Options: Prevent clickjacking
    - X-Content-Type-Options: Prevent MIME sniffing
    - Content-Security-Policy: Control resource loading
    - Referrer-Policy: Control referrer information
    - Permissions-Policy: Restrict browser features

    Args:
        response: Flask response object

    Returns:
        Response with security headers
    """
    # Strict-Transport-Security
    # max-age=31536000 = 1 year
    # includeSubDomains = apply to all subdomains
    response.headers['Strict-Transport-Security'] = (
        'max-age=31536000; includeSubDomains'
    )

    # X-Frame-Options
    # DENY = never allow framing
    response.headers['X-Frame-Options'] = 'DENY'

    # X-Content-Type-Options
    # nosniff = don't try to guess MIME types
    response.headers['X-Content-Type-Options'] = 'nosniff'

    # Content-Security-Policy
    # Restrictive policy for API server
    csp_directives = [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: https:",
        "font-src 'self'",
        "connect-src 'self'",
        "media-src 'self' https://res.cloudinary.com",
        "frame-ancestors 'none'",
        "base-uri 'self'",
        "form-action 'self'",
    ]
    response.headers['Content-Security-Policy'] = '; '.join(csp_directives)

    # Referrer-Policy
    # strict-origin-when-cross-origin = send referrer for same-origin,
    # only origin for cross-origin
    response.headers['Referrer-Policy'] = 'strict-origin-when-cross-origin'

    # Permissions-Policy (formerly Feature-Policy)
    # Disable unnecessary browser features
    permissions = [
        'geolocation=()',
        'microphone=()',
        'camera=()',
        'payment=()',
        'usb=()',
        'magnetometer=()',
        'gyroscope=()',
        'accelerometer=()',
    ]
    response.headers['Permissions-Policy'] = ', '.join(permissions)

    # X-XSS-Protection (legacy, but still useful)
    response.headers['X-XSS-Protection'] = '1; mode=block'

    # Cache-Control for API responses
    # Prevent caching of sensitive data
    if 'Cache-Control' not in response.headers:
        response.headers['Cache-Control'] = 'no-store, no-cache, must-revalidate, max-age=0'

    return response


def init_security_headers(app: Flask):
    """
    Initialize security headers middleware for Flask app.

    Args:
        app: Flask application instance
    """
    @app.after_request
    def security_headers_middleware(response):
        return add_security_headers(response)

    print('[SECURITY] Security headers middleware initialized')
