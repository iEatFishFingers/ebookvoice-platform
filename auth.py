# auth.py
import os
import jwt
from datetime import datetime, timezone
from functools import wraps
from flask import request, jsonify
from supabase import create_client, Client
import requests

# Current version of the Terms of Service / Privacy Policy. Bump this (use the
# date the legal docs were materially changed) whenever Terms change in a way
# that requires fresh user agreement. The in-app re-consent gate compares each
# user's profiles.terms_accepted_version against this and prompts once on a
# mismatch. Keep this in sync with the "Last Updated" date in
# mobile-app/public/terms.html.
TERMS_VERSION = '2026-06-03'

# Lazy Supabase client initialization
_supabase_client = None
_jwks_cache = None

def get_supabase_client() -> Client:
    """Get or create Supabase client instance"""
    global _supabase_client
    if _supabase_client is None:
        _supabase_client = create_client(
            os.environ.get('SUPABASE_URL'),
            os.environ.get('SUPABASE_SERVICE_KEY')
        )
    return _supabase_client


def reset_supabase_client() -> None:
    """Force recreation of the Supabase client on next call.
    Called by TaskManager after an HTTP/2 connection error."""
    global _supabase_client
    _supabase_client = None

def get_jwks():
    """Fetch and cache Supabase JWKS (JSON Web Key Set)"""
    global _jwks_cache
    if _jwks_cache is None:
        supabase_url = os.environ.get('SUPABASE_URL')
        jwks_url = f"{supabase_url}/auth/v1/.well-known/jwks.json"
        try:
            response = requests.get(jwks_url)
            response.raise_for_status()
            _jwks_cache = response.json()
            print(f'✅ JWKS loaded from {jwks_url}')
        except Exception as e:
            print(f'❌ Failed to load JWKS: {e}')
            raise
    return _jwks_cache

def require_auth(f):
    """Decorator to require JWT authentication (supports both HS256 and ES256)"""
    @wraps(f)
    def decorated_function(*args, **kwargs):
        auth_header = request.headers.get('Authorization')

        if not auth_header or not auth_header.startswith('Bearer '):
            print('❌ Auth failed: Missing or invalid authorization header')
            return jsonify({'error': 'Missing or invalid authorization header'}), 401

        token = auth_header.split(' ')[1]

        # ── JWT validation only — route function is called OUTSIDE this block ──
        # This prevents route-level exceptions (DB errors, etc.) from being
        # swallowed and misreported as 401 authentication failures.
        try:
            # Get algorithm from JWT header (SECURITY: Do NOT log token or claims)
            header = jwt.get_unverified_header(token)
            algorithm = header.get('alg', 'HS256')
            kid = header.get('kid')

            # Handle different algorithms
            if algorithm == 'HS256':
                # Legacy HS256 tokens (symmetric key)
                jwt_secret = os.environ.get('SUPABASE_JWT_SECRET')
                if not jwt_secret:
                    print('❌ CRITICAL: SUPABASE_JWT_SECRET not found in environment!')
                    return jsonify({'error': 'Server configuration error'}), 500

                decoded = jwt.decode(
                    token,
                    jwt_secret,
                    algorithms=['HS256'],
                    audience='authenticated'
                )
            elif algorithm == 'ES256':
                # Modern ES256 tokens (asymmetric key)
                jwks = get_jwks()

                if not kid:
                    print('[AUTH] Token missing key ID')
                    return jsonify({'error': 'Invalid token'}), 401

                # Find the matching key
                signing_key = None
                for key in jwks.get('keys', []):
                    if key.get('kid') == kid:
                        signing_key = jwt.PyJWK(key)
                        break

                if not signing_key:
                    print('[AUTH] No matching signing key found')
                    return jsonify({'error': 'Invalid token'}), 401

                decoded = jwt.decode(
                    token,
                    signing_key.key,
                    algorithms=['ES256'],
                    audience='authenticated'
                )
            else:
                print(f'❌ Unsupported algorithm: {algorithm}')
                return jsonify({'error': f'Unsupported token algorithm: {algorithm}'}), 401

            request.user_id = decoded['sub']
            print('[AUTH] Authentication successful')

        except jwt.ExpiredSignatureError:
            print('[AUTH] Token expired')
            return jsonify({'error': 'Token has expired'}), 401
        except jwt.InvalidTokenError:
            # SECURITY: Do NOT log token content or detailed error messages
            print('[AUTH] Invalid token')
            return jsonify({'error': 'Invalid token'}), 401
        except Exception:
            # SECURITY: Do NOT log detailed error messages that might contain token info
            print('[AUTH] Authentication failed')
            return jsonify({'error': 'Authentication failed'}), 401

        # Route function executes here — outside the JWT try/except.
        # Any exceptions from the route propagate normally to Flask's error handler.
        return f(*args, **kwargs)

    return decorated_function

def get_user_profile(user_id):
    """Fetch user profile from Supabase, create if doesn't exist"""
    try:
        supabase = get_supabase_client()

        # Try to fetch existing profile
        try:
            response = supabase.table('profiles').select('*').eq('id', user_id).single().execute()
            return response.data
        except Exception as fetch_error:
            # If profile doesn't exist, create it
            if 'PGRST116' in str(fetch_error) or 'contains 0 rows' in str(fetch_error):
                print(f'⚠️ Profile not found for user {user_id}, creating default profile...')

                # Get user info from Supabase auth
                try:
                    auth_user = supabase.auth.admin.get_user_by_id(user_id)
                    email = auth_user.user.email if auth_user.user else None
                    user_metadata = auth_user.user.user_metadata if auth_user.user else {}
                except Exception as auth_error:
                    print(f'⚠️ Could not fetch auth user data: {auth_error}')
                    email = None
                    user_metadata = {}

                # Create default profile
                from tier_limits import limits_for
                free_limits = limits_for('free')
                new_profile = {
                    'id': user_id,
                    'email': email,
                    'first_name': user_metadata.get('first_name'),
                    'last_name': user_metadata.get('last_name'),
                    'display_name': user_metadata.get('display_name', email.split('@')[0] if email else 'User'),
                    'subscription_tier': 'free',
                    'max_audiobooks': free_limits['max_audiobooks'],
                    'max_monthly_conversions': free_limits['max_monthly_conversions'],
                    'monthly_conversion_count': 0,
                    'conversion_count': 0,
                    # New signups agree to the current Terms at the signup screen
                    # (consent line in SignUpScreen.tsx), so stamp them now — this
                    # keeps the re-consent gate from prompting a brand-new user
                    # immediately after they just agreed.
                    'terms_accepted_version': TERMS_VERSION,
                    'terms_accepted_at': datetime.now(timezone.utc).isoformat(),
                }

                try:
                    create_response = supabase.table('profiles').insert(new_profile).execute()
                except Exception as insert_error:
                    # Defensive: if migration 011 hasn't been applied yet the
                    # terms_* columns won't exist. Retry without them rather than
                    # failing account creation. The user will simply see the
                    # re-consent prompt once (acceptable degradation).
                    if 'terms_accepted' in str(insert_error) or 'column' in str(insert_error).lower():
                        print(f'⚠️ terms_* columns missing, retrying profile insert without them: {insert_error}')
                        new_profile.pop('terms_accepted_version', None)
                        new_profile.pop('terms_accepted_at', None)
                        create_response = supabase.table('profiles').insert(new_profile).execute()
                    else:
                        raise
                print(f'✅ Created default profile for user {user_id}')
                return create_response.data[0] if create_response.data else None
            else:
                raise fetch_error
    except Exception as e:
        print(f'❌ Error in get_user_profile: {e}')
        return None
