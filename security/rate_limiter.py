"""
In-Memory Rate Limiter
Suitable for low-traffic, single-server deployments (Render.com free tier)

Note: Rate limit counters reset when server restarts.
For multi-server deployments, consider Redis-based rate limiting.
"""

import time
from collections import defaultdict
from functools import wraps
from flask import request, jsonify
from threading import Lock


class RateLimiter:
    """
    Thread-safe in-memory rate limiter using sliding window algorithm.

    Supports different limits for authenticated vs anonymous users.
    """

    def __init__(self):
        # Structure: {key: [(timestamp, count), ...]}
        self._requests = defaultdict(list)
        self._lock = Lock()

    def _get_client_key(self, endpoint: str, user_id: str = None) -> str:
        """Generate unique key for rate limiting"""
        if user_id:
            return f"user:{user_id}:{endpoint}"
        else:
            # Use IP address for anonymous users
            ip = request.headers.get('X-Forwarded-For', request.remote_addr)
            if ip:
                ip = ip.split(',')[0].strip()
            return f"ip:{ip}:{endpoint}"

    def _cleanup_old_requests(self, key: str, window_seconds: int):
        """Remove requests outside the current window"""
        cutoff = time.time() - window_seconds
        self._requests[key] = [
            (ts, count) for ts, count in self._requests[key]
            if ts > cutoff
        ]

    def is_allowed(
        self,
        endpoint: str,
        user_id: str = None,
        limit: int = 100,
        window_seconds: int = 3600
    ) -> tuple:
        """
        Check if request is allowed under rate limit.

        Args:
            endpoint: Endpoint name for rate limiting
            user_id: User ID if authenticated, None for anonymous
            limit: Maximum requests allowed in window
            window_seconds: Time window in seconds

        Returns:
            Tuple of (allowed: bool, remaining: int, reset_time: int)
        """
        key = self._get_client_key(endpoint, user_id)

        with self._lock:
            self._cleanup_old_requests(key, window_seconds)

            # Count requests in window
            total_requests = sum(count for _, count in self._requests[key])

            if total_requests >= limit:
                # Calculate reset time
                if self._requests[key]:
                    oldest_ts = min(ts for ts, _ in self._requests[key])
                    reset_time = int(oldest_ts + window_seconds - time.time())
                else:
                    reset_time = window_seconds

                return False, 0, max(0, reset_time)

            # Record this request
            self._requests[key].append((time.time(), 1))

            remaining = limit - total_requests - 1
            reset_time = window_seconds

            return True, remaining, reset_time

    def get_stats(self, endpoint: str, user_id: str = None) -> dict:
        """Get rate limit stats for display in headers"""
        key = self._get_client_key(endpoint, user_id)

        with self._lock:
            total = sum(count for _, count in self._requests[key])
            return {'current_requests': total, 'key': key}


# Global rate limiter instance
_rate_limiter = RateLimiter()


# Rate limit configurations
RATE_LIMITS = {
    # Conversion endpoints - strict limits
    'convert': {
        'authenticated': {'limit': 10, 'window': 3600},      # 10 per hour
        'anonymous': {'limit': 2, 'window': 86400},          # 2 per day
    },
    'convert_text': {
        'authenticated': {'limit': 10, 'window': 3600},      # 10 per hour
        'anonymous': {'limit': 2, 'window': 86400},          # 2 per day
    },
    'extract_chapters': {
        'authenticated': {'limit': 20, 'window': 3600},      # 20 per hour
        'anonymous': {'limit': 5, 'window': 3600},           # 5 per hour
    },
    # Public web demo — anonymous one-shot TTS preview at /try.
    # 1 per IP per 24h forces the funnel to signup after a single taste.
    'demo': {
        'authenticated': {'limit': 100, 'window': 3600},
        'anonymous': {'limit': 1, 'window': 86400},
    },
    # EPUB text extraction for the /try demo. Cheap operation (in-memory
    # zip parse) but rate-limited to prevent scraping abuse. Looser than
    # the synthesize gate so users can try a few EPUBs before committing.
    'demo_extract': {
        'authenticated': {'limit': 100, 'window': 3600},
        'anonymous': {'limit': 10, 'window': 3600},
    },
    # API endpoints - moderate limits
    'api': {
        'authenticated': {'limit': 100, 'window': 60},       # 100 per minute
        'anonymous': {'limit': 30, 'window': 60},            # 30 per minute
    },
    # Auth endpoints - strict limits to prevent brute force
    'auth': {
        'authenticated': {'limit': 10, 'window': 300},       # 10 per 5 minutes
        'anonymous': {'limit': 10, 'window': 300},           # 10 per 5 minutes
    },
}


def rate_limit(endpoint: str):
    """
    Decorator factory for rate limiting endpoints.

    Automatically applies different limits based on authentication status.

    Args:
        endpoint: Rate limit category name (e.g., 'convert', 'api', 'auth')

    Usage:
        @app.route('/convert', methods=['POST'])
        @optional_auth
        @rate_limit('convert')
        def convert():
            ...

    Response headers added:
        X-RateLimit-Limit: Maximum requests allowed
        X-RateLimit-Remaining: Requests remaining in window
        X-RateLimit-Reset: Seconds until limit resets
    """
    def decorator(f):
        @wraps(f)
        def decorated_function(*args, **kwargs):
            # Get rate limit config
            config = RATE_LIMITS.get(endpoint, RATE_LIMITS['api'])

            # Determine user_id (set by @optional_auth or @require_auth)
            user_id = getattr(request, 'user_id', None)

            # Get appropriate limits
            if user_id:
                limits = config['authenticated']
            else:
                limits = config['anonymous']

            # Check rate limit
            allowed, remaining, reset_time = _rate_limiter.is_allowed(
                endpoint=endpoint,
                user_id=user_id,
                limit=limits['limit'],
                window_seconds=limits['window']
            )

            if not allowed:
                response = jsonify({
                    'error': 'Rate limit exceeded',
                    'retry_after': reset_time,
                    'message': f'Too many requests. Please try again in {reset_time} seconds.'
                })
                response.status_code = 429
                response.headers['X-RateLimit-Limit'] = str(limits['limit'])
                response.headers['X-RateLimit-Remaining'] = '0'
                response.headers['X-RateLimit-Reset'] = str(reset_time)
                response.headers['Retry-After'] = str(reset_time)

                # Log rate limit exceeded
                ip = request.headers.get('X-Forwarded-For', request.remote_addr)
                print(f'[SECURITY] Rate limit exceeded: endpoint={endpoint}, '
                      f'user_id={user_id or "anonymous"}, ip={ip}')

                return response

            # Execute the function
            result = f(*args, **kwargs)

            # Add rate limit headers to response
            if hasattr(result, 'headers'):
                result.headers['X-RateLimit-Limit'] = str(limits['limit'])
                result.headers['X-RateLimit-Remaining'] = str(remaining)
                result.headers['X-RateLimit-Reset'] = str(reset_time)

            return result

        return decorated_function

    return decorator
