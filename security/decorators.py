"""
Authentication Decorators
Provides @optional_auth and @require_task_ownership decorators
"""

import os
from functools import wraps
from flask import request, jsonify, g
import jwt

# Cache for JWKS
_jwks_cache = None


def get_jwks():
    """Fetch and cache Supabase JWKS (JSON Web Key Set)"""
    global _jwks_cache
    if _jwks_cache is None:
        import requests
        supabase_url = os.environ.get('SUPABASE_URL')
        jwks_url = f"{supabase_url}/auth/v1/.well-known/jwks.json"
        try:
            response = requests.get(jwks_url, timeout=10)
            response.raise_for_status()
            _jwks_cache = response.json()
        except Exception as e:
            print(f'[SECURITY] Failed to load JWKS: {e}')
            raise
    return _jwks_cache


def _validate_token(token: str) -> dict:
    """
    Validate JWT token and return decoded payload.

    Args:
        token: JWT token string

    Returns:
        Decoded token payload

    Raises:
        jwt.InvalidTokenError: If token is invalid
    """
    # Get algorithm from JWT header (do NOT log the header or claims)
    header = jwt.get_unverified_header(token)
    algorithm = header.get('alg', 'HS256')
    kid = header.get('kid')

    if algorithm == 'HS256':
        # Legacy HS256 tokens (symmetric key)
        jwt_secret = os.environ.get('SUPABASE_JWT_SECRET')
        if not jwt_secret:
            raise ValueError('Server configuration error: JWT secret not configured')

        return jwt.decode(
            token,
            jwt_secret,
            algorithms=['HS256'],
            audience='authenticated'
        )
    elif algorithm == 'ES256':
        # Modern ES256 tokens (asymmetric key)
        jwks = get_jwks()

        if not kid:
            raise jwt.InvalidTokenError('Token missing key ID')

        # Find the matching key
        signing_key = None
        for key in jwks.get('keys', []):
            if key.get('kid') == kid:
                signing_key = jwt.PyJWK(key)
                break

        if not signing_key:
            raise jwt.InvalidTokenError('Invalid token key')

        return jwt.decode(
            token,
            signing_key.key,
            algorithms=['ES256'],
            audience='authenticated'
        )
    else:
        raise jwt.InvalidTokenError(f'Unsupported token algorithm: {algorithm}')


def _extract_device_id() -> str | None:
    """
    Read X-Device-Id header, validate it's a plausible UUID-ish token, and
    return it. Returns None if missing or fails sanity check.

    We don't enforce strict UUID format because the frontend may generate the
    ID with a manual hex generator (no `uuid` package in expo-secure-store
    path). Sanity bounds prevent injection: 16-128 chars of hex + dashes only.
    """
    raw = request.headers.get('X-Device-Id')
    if not raw:
        return None
    raw = raw.strip()
    if not (16 <= len(raw) <= 128):
        return None
    if not all(c.isalnum() or c == '-' for c in raw):
        return None
    return raw


def optional_auth(f):
    """
    Decorator that extracts user_id if token is present, sets None otherwise.
    Does not reject requests without authentication.

    Also extracts device_id from the X-Device-Id header (anonymous-trial
    identity). Both can be set on the same request — auth wins for endpoints
    that branch on `is_authenticated`, but `request.device_id` stays available
    for analytics and dedup purposes regardless.

    Sets:
        request.user_id:         User ID if authenticated, None otherwise
        request.is_authenticated: True if authenticated, False otherwise
        request.device_id:       Anonymous device UUID from X-Device-Id, or None
    """
    @wraps(f)
    def decorated_function(*args, **kwargs):
        auth_header = request.headers.get('Authorization')

        request.user_id = None
        request.is_authenticated = False
        request.device_id = _extract_device_id()

        if auth_header and auth_header.startswith('Bearer '):
            token = auth_header.split(' ')[1]

            try:
                decoded = _validate_token(token)
                request.user_id = decoded['sub']
                request.is_authenticated = True
                # Secure logging - no sensitive data
                print(f'[AUTH] Request authenticated')
            except jwt.ExpiredSignatureError:
                # Token expired - treat as anonymous
                print('[AUTH] Token expired, treating as anonymous')
            except jwt.InvalidTokenError as e:
                # Invalid token - treat as anonymous
                print(f'[AUTH] Invalid token, treating as anonymous')
            except Exception as e:
                # Other errors - treat as anonymous
                print(f'[AUTH] Auth error, treating as anonymous')

        return f(*args, **kwargs)

    return decorated_function


def require_task_ownership(task_manager):
    """
    Decorator factory that verifies the authenticated user owns the task.

    Must be used after @require_auth or @optional_auth.

    Args:
        task_manager: TaskManager instance for looking up tasks

    Usage:
        @app.route('/status/<task_id>')
        @require_auth
        @require_task_ownership(task_manager)
        def status(task_id):
            ...
    """
    def decorator(f):
        @wraps(f)
        def decorated_function(*args, **kwargs):
            # Get task_id from URL parameters
            task_id = kwargs.get('task_id')

            if not task_id:
                return jsonify({'error': 'Task ID required'}), 400

            # Ownership only needs the identity columns. Selecting just these
            # (instead of '*') avoids pulling the multi-hundred-KB `chapters`
            # blob out of Supabase on every /status poll — this decorator runs
            # before the handler, so '*' here doubled the per-poll egress.
            task = task_manager.get_task(task_id, columns='id, user_id, device_id',
                                         distinguish_errors=True)

            # DB unreachable (Supabase outage) ≠ task gone. 503 tells the
            # client to keep polling; a 404 here would hit its 3-strike
            # drop counter and kill a healthy in-flight conversion.
            if task is type(task_manager).DB_ERROR:
                return jsonify({'error': 'Service temporarily unavailable. Please retry.'}), 503

            if not task:
                return jsonify({'error': 'Task not found'}), 404

            # Check ownership against either user_id or device_id. A task row
            # has exactly one identity set (CHECK constraint in migration 010);
            # the request must match it.
            task_user_id = task.get('user_id')
            task_device_id = task.get('device_id')

            if task_user_id is not None:
                # User-owned task: requester must be the same authenticated user.
                if not hasattr(request, 'user_id') or request.user_id is None:
                    return jsonify({'error': 'Authentication required'}), 401
                if request.user_id != task_user_id:
                    # Don't reveal that task exists - return 404
                    return jsonify({'error': 'Task not found'}), 404
            elif task_device_id is not None:
                # Anonymous task: requester's X-Device-Id must match. Authenticated
                # users on the same device can also access (covers the brief window
                # between sign-up and the claim endpoint completing).
                req_device = getattr(request, 'device_id', None)
                if req_device != task_device_id:
                    return jsonify({'error': 'Task not found'}), 404
            # else: orphan task with no identity — let through (shouldn't exist).

            return f(*args, **kwargs)

        return decorated_function

    return decorator
