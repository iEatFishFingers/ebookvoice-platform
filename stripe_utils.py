"""
Stripe Service Module
Handles all Stripe payment integration logic including:
- Checkout session creation
- Billing portal session creation
- Webhook event processing
- Database synchronization
"""

import os
import stripe
from auth import get_supabase_client
from tier_limits import TIER_LIMITS, limits_for

# Initialize Stripe with secret key
stripe.api_key = os.environ.get('STRIPE_SECRET_KEY')

# Stripe-specific config: maps tier name → Stripe price ID.
# Tier *limits* are imported from tier_limits.py (single source of truth).
STRIPE_PRICE_IDS = {
    'starter':    os.environ.get('STRIPE_PRICE_STARTER'),
    'pro':        os.environ.get('STRIPE_PRICE_PRO'),
    'enterprise': os.environ.get('STRIPE_PRICE_ENTERPRISE'),
}


class StripeService:
    """Service class for handling Stripe operations"""

    @staticmethod
    def _get_app_url(platform):
        """
        Get the correct app URL for Stripe redirects based on the client platform.

        - 'web' (includes mobile browsers) → Vercel website URL
        - 'ios' / 'android' (native apps only) → deep link scheme
        """
        if platform == 'web':
            return os.environ.get('APP_URL_WEB', 'http://localhost:8081/payment')
        else:
            return 'ebookvoice://payment'

    @staticmethod
    def create_checkout_session(user_id, email, tier, platform='web'):
        """
        Create a Stripe Checkout session for subscription purchase or upgrade.

        Args:
            user_id: User's Supabase ID
            email: User's email address
            tier: Subscription tier (starter, pro, enterprise)

        Returns:
            dict: Contains checkout session URL and session ID
        """
        supabase = get_supabase_client()

        # Get or create Stripe customer and check for existing subscription
        profile = supabase.table('profiles').select('stripe_customer_id, stripe_subscription_id, subscription_status, subscription_tier').eq('id', user_id).single().execute()
        stripe_customer_id = profile.data.get('stripe_customer_id') if profile.data else None
        existing_subscription_id = profile.data.get('stripe_subscription_id') if profile.data else None
        subscription_status = profile.data.get('subscription_status') if profile.data else None
        current_tier = profile.data.get('subscription_tier') if profile.data else 'free'

        if not stripe_customer_id:
            # Create new Stripe customer
            customer = stripe.Customer.create(
                email=email,
                metadata={'supabase_user_id': user_id}
            )
            stripe_customer_id = customer.id

            # Save customer ID to database
            supabase.table('profiles').update({
                'stripe_customer_id': stripe_customer_id
            }).eq('id', user_id).execute()

            print(f'✅ Created Stripe customer: {stripe_customer_id} for user: {user_id}')
        else:
            print(f'✅ Using existing Stripe customer: {stripe_customer_id}')

        # Get price ID for the tier
        price_id = STRIPE_PRICE_IDS.get(tier)
        if not price_id:
            raise ValueError(f'Invalid tier or missing price ID for tier: {tier}')

        # Check if user has an active subscription that needs upgrading
        if existing_subscription_id and subscription_status == 'active':
            print(f'📊 User has active subscription: {existing_subscription_id} (tier: {current_tier})')
            print(f'🔄 Upgrading/changing subscription from {current_tier} to {tier}')

            # For upgrades/downgrades, we need to use Checkout to collect payment
            # Create a new checkout session that will update the existing subscription
            app_url = StripeService._get_app_url(platform)

            print(f'🔗 Using APP_URL: {app_url} (platform: {platform})')
            print(f'🔗 Creating upgrade checkout session')

            # Cancel the old subscription at period end and create new one
            # This ensures proper payment collection
            session = stripe.checkout.Session.create(
                customer=stripe_customer_id,
                payment_method_types=['card'],
                line_items=[{
                    'price': price_id,
                    'quantity': 1,
                }],
                mode='subscription',
                success_url=f'{app_url}/success?session_id={{CHECKOUT_SESSION_ID}}',
                cancel_url=f'{app_url}/cancel',
                metadata={
                    'user_id': user_id,
                    'tier': tier,
                    'upgrade_from': current_tier,
                    'old_subscription_id': existing_subscription_id
                },
                # Cancel the old subscription when new one is created
                subscription_data={
                    'metadata': {
                        'user_id': user_id,
                        'tier': tier
                    }
                }
            )

            print(f'✅ Created upgrade checkout session: {session.id}')

            return {
                'url': session.url,
                'session_id': session.id,
                'upgraded': False,
                'is_upgrade': True
            }

        # Get app URL for redirects based on platform
        app_url = StripeService._get_app_url(platform)

        print(f'🔗 Using APP_URL: {app_url} (platform: {platform})')
        print(f'🔗 Success URL will be: {app_url}/success?session_id={{CHECKOUT_SESSION_ID}}')
        print(f'🔗 Cancel URL will be: {app_url}/cancel')

        # Create checkout session for new subscription
        session = stripe.checkout.Session.create(
            customer=stripe_customer_id,
            payment_method_types=['card'],
            line_items=[{
                'price': price_id,
                'quantity': 1,
            }],
            mode='subscription',
            success_url=f'{app_url}/success?session_id={{CHECKOUT_SESSION_ID}}',
            cancel_url=f'{app_url}/cancel',
            metadata={
                'user_id': user_id,
                'tier': tier
            }
        )

        print(f'✅ Created checkout session: {session.id} for tier: {tier}')

        return {
            'url': session.url,
            'session_id': session.id,
            'upgraded': False
        }

    @staticmethod
    def create_portal_session(user_id, platform='web'):
        """
        Create a Stripe billing portal session for subscription management.

        Args:
            user_id: User's Supabase ID
            platform: Client platform ('web', 'ios', 'android')

        Returns:
            dict: Contains portal session URL
        """
        supabase = get_supabase_client()

        # Get Stripe customer ID
        profile = supabase.table('profiles').select('stripe_customer_id').eq('id', user_id).single().execute()
        stripe_customer_id = profile.data.get('stripe_customer_id') if profile.data else None

        if not stripe_customer_id:
            raise ValueError('User does not have a Stripe customer ID')

        # Get app URL for return based on platform
        app_url = StripeService._get_app_url(platform)

        print(f'🔗 Portal return URL: {app_url} (platform: {platform})')

        # Create portal session
        session = stripe.billing_portal.Session.create(
            customer=stripe_customer_id,
            return_url=app_url,
        )

        print(f'✅ Created portal session for customer: {stripe_customer_id}')

        return {
            'url': session.url
        }

    @staticmethod
    def update_subscription_in_db(subscription):
        """
        Update subscription information in database from Stripe subscription object.

        Args:
            subscription: Stripe subscription object
        """
        supabase = get_supabase_client()

        # Get user ID from Stripe customer
        customer_id = subscription.customer
        profile = supabase.table('profiles').select('id').eq('stripe_customer_id', customer_id).single().execute()

        if not profile.data:
            print(f'❌ No user found for Stripe customer: {customer_id}')
            return

        user_id = profile.data['id']

        # Determine tier from subscription metadata or items
        tier = None
        if subscription.metadata and subscription.metadata.get('tier'):
            tier = subscription.metadata.get('tier')
        else:
            # Try to get tier from price ID
            price_id = subscription['items']['data'][0]['price']['id']
            for tier_name, mapped_price_id in STRIPE_PRICE_IDS.items():
                if mapped_price_id == price_id:
                    tier = tier_name
                    break

        if not tier:
            print(f'⚠️ Could not determine tier for subscription: {subscription.id}')
            tier = 'starter'  # Default fallback

        # Get tier limits from the canonical source
        tier_limits = limits_for(tier)

        # Convert Unix timestamp to ISO 8601 format for Supabase
        from datetime import datetime, timezone

        current_period_end = None
        if hasattr(subscription, 'current_period_end') and subscription.current_period_end:
            current_period_end = datetime.fromtimestamp(subscription.current_period_end, tz=timezone.utc).isoformat()

        # Update database
        update_data = {
            'stripe_subscription_id': subscription.id,
            'subscription_tier': tier,
            'subscription_status': subscription.status,
            'max_audiobooks': tier_limits['max_audiobooks'],
            'max_monthly_conversions': tier_limits['max_monthly_conversions']
        }

        # Add optional fields if they exist
        if current_period_end:
            update_data['subscription_current_period_end'] = current_period_end

        if hasattr(subscription, 'cancel_at_period_end'):
            update_data['subscription_cancel_at_period_end'] = subscription.cancel_at_period_end

        result = supabase.table('profiles').update(update_data).eq('id', user_id).execute()

        print(f'✅ Updated subscription for user: {user_id}')
        print(f'   → Tier: {tier}')
        print(f'   → Status: {subscription.status}')
        print(f'   → Max Audiobooks: {tier_limits["max_audiobooks"]}')
        print(f'   → Max Monthly Conversions: {tier_limits["max_monthly_conversions"]}')
        print(f'   → Database update result: {len(result.data) if result.data else 0} row(s) updated')

    @staticmethod
    def cancel_subscription_in_db(subscription_id):
        """
        Handle subscription cancellation in database.

        Args:
            subscription_id: Stripe subscription ID
        """
        supabase = get_supabase_client()

        try:
            # Get user by subscription ID
            profile = supabase.table('profiles').select('id').eq('stripe_subscription_id', subscription_id).single().execute()

            if not profile.data:
                print(f'ℹ️ No user found for subscription: {subscription_id} (user may have been deleted)')
                return

            user_id = profile.data['id']

            # Downgrade to free tier
            update_data = {
                'subscription_tier': 'free',
                'subscription_status': 'canceled',
                'subscription_cancel_at_period_end': False,
                'max_audiobooks': 10,
                'max_monthly_conversions': 2,
                'monthly_conversion_count': 0
            }

            supabase.table('profiles').update(update_data).eq('id', user_id).execute()

            print(f'✅ Canceled subscription and downgraded user: {user_id} to free tier')

        except Exception as e:
            # If profile doesn't exist (PGRST116 error), it means user was deleted
            # This is expected when account deletion triggers subscription cancellation
            if 'PGRST116' in str(e) or 'The result contains 0 rows' in str(e):
                print(f'ℹ️ Profile not found for subscription {subscription_id} (likely deleted account, ignoring)')
                return
            else:
                # Re-raise unexpected errors
                print(f'❌ Unexpected error in cancel_subscription_in_db: {e}')
                raise

    @staticmethod
    def check_webhook_processed(event_id):
        """
        Check if webhook event has already been processed (idempotency).

        Args:
            event_id: Stripe event ID

        Returns:
            bool: True if already processed, False otherwise
        """
        supabase = get_supabase_client()

        result = supabase.table('processed_webhooks').select('id').eq('event_id', event_id).execute()

        return len(result.data) > 0

    @staticmethod
    def mark_webhook_processed(event_id):
        """
        Mark webhook event as processed.

        Args:
            event_id: Stripe event ID
        """
        supabase = get_supabase_client()

        supabase.table('processed_webhooks').insert({
            'event_id': event_id
        }).execute()

        print(f'✅ Marked webhook as processed: {event_id}')

    @staticmethod
    def handle_checkout_completed(session):
        """
        Handle successful checkout completion.

        Args:
            session: Stripe checkout session object
        """
        # Get the subscription from the session
        subscription_id = session.subscription

        if subscription_id:
            subscription = stripe.Subscription.retrieve(subscription_id)

            # Check if this was an upgrade (old subscription to cancel)
            old_subscription_id = session.metadata.get('old_subscription_id') if session.metadata else None

            if old_subscription_id:
                print(f'🔄 This is an upgrade/change - canceling old subscription: {old_subscription_id}')
                try:
                    # Cancel the old subscription immediately
                    stripe.Subscription.delete(old_subscription_id)
                    print(f'✅ Canceled old subscription: {old_subscription_id}')
                except Exception as e:
                    print(f'⚠️ Could not cancel old subscription {old_subscription_id}: {e}')

            # Update database with new subscription
            StripeService.update_subscription_in_db(subscription)
        else:
            print(f'⚠️ No subscription found in checkout session: {session.id}')

    @staticmethod
    def handle_subscription_updated(subscription):
        """
        Handle subscription update (upgrade, downgrade, renewal).

        Args:
            subscription: Stripe subscription object
        """
        StripeService.update_subscription_in_db(subscription)

    @staticmethod
    def handle_subscription_deleted(subscription):
        """
        Handle subscription deletion/cancellation.

        Args:
            subscription: Stripe subscription object
        """
        StripeService.cancel_subscription_in_db(subscription.id)

    @staticmethod
    def handle_invoice_payment_succeeded(invoice):
        """
        Handle successful invoice payment (renewals).

        Args:
            invoice: Stripe invoice object
        """
        # Safely get subscription ID
        subscription_id = getattr(invoice, 'subscription', None)

        if subscription_id:
            subscription = stripe.Subscription.retrieve(subscription_id)
            StripeService.update_subscription_in_db(subscription)
            print(f'✅ Invoice payment succeeded for subscription: {subscription_id}')
        else:
            print(f'⚠️ No subscription found in invoice: {invoice.id}')

    @staticmethod
    def handle_invoice_payment_failed(invoice):
        """
        Handle failed invoice payment.

        Args:
            invoice: Stripe invoice object
        """
        subscription_id = invoice.subscription

        if subscription_id:
            supabase = get_supabase_client()

            # Update subscription status to past_due
            supabase.table('profiles').update({
                'subscription_status': 'past_due'
            }).eq('stripe_subscription_id', subscription_id).execute()

            print(f'❌ Invoice payment failed for subscription: {subscription_id}')
        else:
            print(f'⚠️ No subscription found in failed invoice: {invoice.id}')

    @staticmethod
    def cancel_user_subscription(user_id):
        """
        Cancel all active subscriptions for a user (immediate cancellation).
        Used when deleting user account.

        Args:
            user_id: User's Supabase ID

        Returns:
            bool: True if cancellation successful or no subscription exists, False on error
        """
        supabase = get_supabase_client()

        try:
            # Get user's Stripe subscription ID
            profile = supabase.table('profiles').select('stripe_subscription_id').eq('id', user_id).single().execute()

            if not profile.data:
                print(f'⚠️ No profile found for user: {user_id}')
                return True  # No profile means nothing to cancel

            subscription_id = profile.data.get('stripe_subscription_id')

            if not subscription_id:
                print(f'ℹ️ No active subscription for user: {user_id}')
                return True  # No subscription to cancel

            # Cancel the subscription immediately
            try:
                stripe.Subscription.delete(subscription_id)
                print(f'✅ Canceled subscription {subscription_id} for user: {user_id}')
                return True
            except stripe.error.InvalidRequestError as e:
                # Subscription might already be canceled or doesn't exist
                if 'No such subscription' in str(e) or 'already been canceled' in str(e).lower():
                    print(f'ℹ️ Subscription {subscription_id} already canceled or does not exist')
                    return True
                else:
                    print(f'❌ Error canceling subscription {subscription_id}: {e}')
                    return False

        except Exception as e:
            print(f'❌ Error in cancel_user_subscription for user {user_id}: {e}')
            return False
