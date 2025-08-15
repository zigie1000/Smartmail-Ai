// stripeWebhook.js  — ESM router for Stripe webhooks
// Works with "type": "module" in package.json

import express from 'express';
import Stripe from 'stripe';
import crypto from 'crypto';
import { createClient } from '@supabase/supabase-js';

const router = express.Router();

// --- Env checks ---
const STRIPE_SECRET_KEY     = process.env.STRIPE_SECRET_KEY || '';
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';
const SUPABASE_URL          = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_KEY  = process.env.SUPABASE_SERVICE_KEY || '';

if (!STRIPE_SECRET_KEY) {
  console.warn('⚠️ STRIPE_SECRET_KEY is not set; webhook will not verify events.');
}
if (!STRIPE_WEBHOOK_SECRET) {
  console.warn('⚠️ STRIPE_WEBHOOK_SECRET is not set; webhook signature verification will fail.');
}
if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.warn('⚠️ Supabase env vars missing; license upserts will fail.');
}

const stripe = new Stripe(STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' });
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// ---------- Helpers ----------
function daysToMs(days) { return Number(days) * 24 * 60 * 60 * 1000; }

function inferTierAndDurationFromStripe(data = {}) {
  // Prefer product metadata
  const md = data?.product?.metadata || {};
  const price = data?.price || {};
  const recurring = price?.recurring || {};

  // Metadata (recommended): metadata.tier = "pro" | "premium"; metadata.durationDays = "30" | "365"
  let tier = (md.tier || '').toLowerCase();
  let durationDays = parseInt(md.durationDays, 10);

  // Fallback by price interval if metadata not present
  if (!tier) {
    if (recurring?.interval === 'year') tier = 'premium';
    else if (recurring?.interval === 'month') tier = 'pro';
  }
  if (!Number.isFinite(durationDays) || durationDays <= 0) {
    if (tier === 'premium') durationDays = 365;
    else if (tier === 'pro') durationDays = 30;
  }

  // Final safety defaults
  if (!tier) tier = 'pro';
  if (!Number.isFinite(durationDays) || durationDays <= 0) durationDays = 30;

  return { tier, durationDays };
}

async function upsertLicense({ email, tier, durationDays, stripeRefs = {} }) {
  if (!email) throw new Error('Missing email for license upsert');

  const now = new Date();
  const expiresAt = new Date(now.getTime() + daysToMs(durationDays));
  const licenseKey = crypto.randomBytes(16).toString('hex');

  // Upsert on email; keep other legacy fields if you have them
  const payload = {
    email,
    license_key: licenseKey,                 // set/refresh a key (optional)
    smartemail_tier: tier,                   // authoritative for this app
    smartemail_expires: expiresAt.toISOString(),
    status: 'active',
    // helpful Stripe refs for support/debug
    stripe_customer: stripeRefs.customer || null,
    stripe_subscription: stripeRefs.subscription || null,
    stripe_product: stripeRefs.product || null,
    updated_at: now.toISOString()
  };

  const { error } = await supabase
    .from('licenses')
    .upsert(payload, { onConflict: 'email' });

  if (error) throw new Error(`Supabase upsert failed: ${error.message}`);

  return { email, tier, expiresAt: expiresAt.toISOString(), licenseKey };
}

// ---------- Webhook route ----------
// IMPORTANT: this must see the *raw* body; mount before express.json()
router.post('/', express.raw({ type: 'application/json' }), async (req, res) => {
  let event;

  try {
    const sig = req.headers['stripe-signature'];
    if (!STRIPE_WEBHOOK_SECRET) throw new Error('STRIPE_WEBHOOK_SECRET not configured');
    event = stripe.webhooks.constructEvent(req.body, sig, STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('❌ Stripe signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    // We handle both Checkout and Subscription flows.
    switch (event.type) {
      case 'checkout.session.completed': {
        // One-time after checkout completion
        const session = event.data.object;

        // Email from session
        const email =
          session.customer_email ||
          session?.customer_details?.email ||
          session?.metadata?.email ||
          '';

        // Pull first line item’s product to read metadata
        const lineItems = await stripe.checkout.sessions.listLineItems(session.id, { expand: ['data.price.product'] });
        const first = lineItems?.data?.[0] || {};
        const product = first?.price?.product || null;

        const { tier, durationDays } = inferTierAndDurationFromStripe({
          product,
          price: first?.price
        });

        const result = await upsertLicense({
          email,
          tier,
          durationDays,
          stripeRefs: {
            customer: session.customer || null,
            subscription: session.subscription || null,
            product: product?.id || null
          }
        });

        console.log(`✅ Checkout completed: ${email} → ${tier} for ${durationDays}d (exp ${result.expiresAt})`);
        return res.status(200).send('ok');
      }

      case 'invoice.payment_succeeded': {
        // Recurring billing case — extend license on every successful payment.
        const invoice = event.data.object;
        const customerId = invoice.customer;
        const subscriptionId = invoice.subscription;

        // Get subscription → plan/price → product metadata
        const subscription = subscriptionId
          ? await stripe.subscriptions.retrieve(subscriptionId, { expand: ['items.data.price.product'] })
          : null;

        const item = subscription?.items?.data?.[0] || {};
        const product = item?.price?.product || null;

        // We need the email; try invoice, customer, or subscription metadata
        let email =
          invoice?.customer_email ||
          invoice?.customer_address?.email ||
          subscription?.metadata?.email ||
          '';

        // If still not found, try the Stripe Customer object
        if (!email && customerId) {
          const customer = await stripe.customers.retrieve(customerId);
          email = customer?.email || '';
        }

        const { tier, durationDays } = inferTierAndDurationFromStripe({
          product,
          price: item?.price
        });

        const result = await upsertLicense({
          email,
          tier,
          durationDays,
          stripeRefs: {
            customer: customerId || null,
            subscription: subscriptionId || null,
            product: product?.id || null
          }
        });

        console.log(`🔁 Recurring payment: ${email} → ${tier} extended ${durationDays}d (exp ${result.expiresAt})`);
        return res.status(200).send('ok');
      }

      // Optional: handle subscription deletions (set to free/expired)
      case 'customer.subscription.deleted': {
        const sub = event.data.object;
        const customerId = sub.customer;

        // Try to find email from customer
        let email = '';
        try {
          const customer = await stripe.customers.retrieve(customerId);
          email = customer?.email || '';
        } catch {}

        if (email) {
          const { error } = await supabase
            .from('licenses')
            .update({
              smartemail_tier: 'free',
              smartemail_expires: null,
              status: 'canceled',
              updated_at: new Date().toISOString()
            })
            .eq('email', email);

          if (error) throw new Error(`Supabase cancel update failed: ${error.message}`);
          console.log(`🚫 Subscription canceled → ${email} downgraded to free`);
        }

        return res.status(200).send('ok');
      }

      default:
        // Acknowledge other events
        return res.status(200).send('ignored');
    }
  } catch (err) {
    console.error('❌ Webhook handler error:', err.message || err);
    return res.status(500).send('Webhook handler error');
  }
});

// Export both default and named for compatibility with your server.js
export const stripeWebHook = router;
export default router;
