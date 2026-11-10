"""Contract tests for POST /api/sync-mobile-purchase.

By the time the app calls this, Apple has already charged the card. The
RevenueCat webhook is the authoritative writer; this endpoint is a fast path.
So it must never 500 on our own misconfiguration, never write a sandbox
(TestFlight) purchase into a real profile, and never downgrade anyone.
"""
import sys
from functools import wraps
from unittest.mock import MagicMock, patch

# Imported here, not inside _app(): patch.dict(sys.modules) discards any module
# first imported inside it, which would leave a second, unbound `request` proxy.
from flask import request

USER_ID = '00000000-0000-4000-8000-000000000001'
FUTURE = '2099-01-01T00:00:00Z'


def _require_auth(f):
    @wraps(f)
    def inner(*a, **k):
        request.user_id = USER_ID
        return f(*a, **k)
    return inner


def _app():
    mock_client = MagicMock()
    with patch.dict("sys.modules", {
        "auth": MagicMock(
            require_auth=_require_auth,
            get_user_profile=MagicMock(return_value={}),
            get_supabase_client=MagicMock(return_value=mock_client),
            TERMS_VERSION='1',
        )
    }):
        for mod in list(sys.modules.keys()):
            if mod == "epub_to_audio":
                del sys.modules[mod]
        import epub_to_audio as m
    m.get_supabase_client = MagicMock(return_value=mock_client)
    m.app.config['TESTING'] = True
    return m, mock_client


def _rc(status, body=None):
    resp = MagicMock(status_code=status, text='{}')
    resp.json.return_value = body or {}
    return resp


def _subscriber(tier, product, sandbox):
    return {'subscriber': {
        'entitlements': {tier: {'expires_date': FUTURE, 'product_identifier': product}},
        'subscriptions': {product: {'expires_date': FUTURE, 'is_sandbox': sandbox}},
        'non_subscriptions': {},
    }}


def _post(m, rc_response):
    with patch.dict('os.environ', {'REVENUECAT_SECRET_KEY': 'sk_test'}), \
         patch.object(m.http_requests, 'get', return_value=rc_response):
        return m.app.test_client().post('/api/sync-mobile-purchase', json={'tier': 'starter'})


def test_auth_error_from_revenuecat_is_pending_not_500():
    """The 2026-10-15 case: a v2 key on the v1 API answers 403."""
    m, db = _app()
    resp = _post(m, _rc(403))
    assert resp.status_code == 202
    assert resp.get_json()['pending'] is True
    db.table.assert_not_called()


def test_production_purchase_is_written():
    m, db = _app()
    resp = _post(m, _rc(200, _subscriber('starter', 'starter_monthly', sandbox=False)))
    assert resp.status_code == 200
    assert resp.get_json()['tier'] == 'starter'
    payload = db.table.return_value.update.call_args[0][0]
    assert payload['subscription_tier'] == 'starter'


def test_sandbox_purchase_never_unlocks_a_tier():
    """TestFlight purchases must not write a paid tier — and nothing would take it back."""
    m, db = _app()
    resp = _post(m, _rc(200, _subscriber('pro', 'pro_monthly', sandbox=True)))
    assert resp.status_code == 202
    assert resp.get_json()['pending'] is True
    db.table.assert_not_called()


def test_no_entitlement_never_downgrades():
    """e.g. a Stripe web subscriber pressing Restore on iOS."""
    m, db = _app()
    resp = _post(m, _rc(200, {'subscriber': {'entitlements': {}, 'subscriptions': {}}}))
    assert resp.status_code == 202
    db.table.assert_not_called()


def test_sandbox_lifetime_is_skipped_but_production_sub_still_counts():
    m, _ = _app()
    rc = {'subscriber': {
        'entitlements': {
            'lifetime': {'expires_date': None, 'product_identifier': 'lifetime'},
            'starter': {'expires_date': FUTURE, 'product_identifier': 'starter_monthly'},
        },
        'subscriptions': {'starter_monthly': {'is_sandbox': False}},
        'non_subscriptions': {'lifetime': [{'is_sandbox': True}]},
    }}
    assert m._tier_from_rc_subscriber(rc) == 'starter'
