"""
Security Audit Logging
Database-backed audit logging for security events
"""

import os
from typing import Optional, Dict, Any
from datetime import datetime, timezone
from flask import request


def get_client_ip() -> str:
    """Get client IP address from request"""
    # Check for X-Forwarded-For header (common with proxies/load balancers)
    forwarded_for = request.headers.get('X-Forwarded-For')
    if forwarded_for:
        # Take the first IP (client's original IP)
        return forwarded_for.split(',')[0].strip()
    return request.remote_addr or 'unknown'


class SecurityAuditLog:
    """
    Database-backed security audit logging.

    Logs security-relevant events to Supabase for:
    - Security monitoring
    - Incident response
    - Compliance requirements
    """

    def __init__(self, supabase_client):
        """
        Initialize audit log with Supabase client.

        Args:
            supabase_client: Initialized Supabase client instance
        """
        self.supabase = supabase_client
        self._enabled = os.environ.get('ENABLE_AUDIT_LOG', 'true').lower() == 'true'

    def log_event(
        self,
        event_type: str,
        user_id: Optional[str] = None,
        ip_address: Optional[str] = None,
        details: Optional[Dict[str, Any]] = None
    ) -> bool:
        """
        Log a security event to the database.

        Args:
            event_type: Type of event (e.g., 'auth_success', 'rate_limit')
            user_id: User ID if known
            ip_address: Client IP address
            details: Additional event details (no sensitive data!)

        Returns:
            True if logged successfully, False otherwise
        """
        if not self._enabled:
            return True

        try:
            # Filter sensitive data from details
            safe_details = self._filter_sensitive_data(details)

            # Get IP from request if not provided
            if ip_address is None:
                try:
                    ip_address = get_client_ip()
                except RuntimeError:
                    # Not in request context
                    ip_address = None

            event_data = {
                'event_type': event_type,
                'user_id': user_id,
                'ip_address': ip_address,
                'details': safe_details,
            }

            self.supabase.table('security_audit_log').insert(event_data).execute()
            return True

        except Exception as e:
            # Log to console but don't fail the request
            print(f'[AUDIT] Failed to log event: {e}')
            return False

    def _filter_sensitive_data(self, details: Optional[Dict]) -> Optional[Dict]:
        """Remove sensitive fields from details"""
        if not details:
            return None

        sensitive_fields = {
            'token', 'password', 'secret', 'key', 'authorization',
            'credit_card', 'ssn', 'api_key', 'access_token', 'refresh_token',
            'session', 'cookie'
        }

        safe_details = {}
        for key, value in details.items():
            key_lower = key.lower()
            if any(sensitive in key_lower for sensitive in sensitive_fields):
                safe_details[key] = '[REDACTED]'
            elif isinstance(value, dict):
                # Recursively filter nested dicts
                safe_details[key] = self._filter_sensitive_data(value)
            else:
                safe_details[key] = value

        return safe_details

    # Convenience methods for common events

    def log_auth_success(self, user_id: str, ip_address: str = None):
        """Log successful authentication"""
        return self.log_event(
            event_type='auth_success',
            user_id=user_id,
            ip_address=ip_address
        )

    def log_auth_failure(
        self,
        ip_address: str = None,
        reason: str = None,
        user_id: str = None
    ):
        """Log failed authentication attempt"""
        return self.log_event(
            event_type='auth_failure',
            user_id=user_id,
            ip_address=ip_address,
            details={'reason': reason} if reason else None
        )

    def log_rate_limit_exceeded(
        self,
        endpoint: str,
        user_id: str = None,
        ip_address: str = None
    ):
        """Log rate limit exceeded event"""
        return self.log_event(
            event_type='rate_limit_exceeded',
            user_id=user_id,
            ip_address=ip_address,
            details={'endpoint': endpoint}
        )

    def log_account_deletion(self, user_id: str, ip_address: str = None):
        """Log account deletion"""
        return self.log_event(
            event_type='account_deletion',
            user_id=user_id,
            ip_address=ip_address
        )

    def log_subscription_change(
        self,
        user_id: str,
        old_tier: str,
        new_tier: str,
        ip_address: str = None
    ):
        """Log subscription tier change"""
        return self.log_event(
            event_type='subscription_change',
            user_id=user_id,
            ip_address=ip_address,
            details={'old_tier': old_tier, 'new_tier': new_tier}
        )

    def log_suspicious_activity(
        self,
        activity_type: str,
        user_id: str = None,
        ip_address: str = None,
        details: Dict = None
    ):
        """Log suspicious activity for investigation"""
        return self.log_event(
            event_type=f'suspicious_{activity_type}',
            user_id=user_id,
            ip_address=ip_address,
            details=details
        )

    def log_validation_error(
        self,
        field: str,
        error: str,
        user_id: str = None,
        ip_address: str = None
    ):
        """Log input validation error"""
        return self.log_event(
            event_type='validation_error',
            user_id=user_id,
            ip_address=ip_address,
            details={'field': field, 'error': error}
        )

    def get_recent_events(
        self,
        event_type: str = None,
        user_id: str = None,
        limit: int = 100
    ) -> list:
        """
        Query recent security events.

        Args:
            event_type: Filter by event type
            user_id: Filter by user ID
            limit: Maximum events to return

        Returns:
            List of event records
        """
        try:
            query = self.supabase.table('security_audit_log') \
                .select('*') \
                .order('timestamp', desc=True) \
                .limit(limit)

            if event_type:
                query = query.eq('event_type', event_type)

            if user_id:
                query = query.eq('user_id', user_id)

            response = query.execute()
            return response.data or []

        except Exception as e:
            print(f'[AUDIT] Failed to query events: {e}')
            return []
