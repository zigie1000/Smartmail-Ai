// stripeWebhook.js  (ESM, no require())
// Registers an Express router you can mount at /stripe/webhook

import express from 'express';
import crypto from 'crypto';
import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' });
const router = express.Router();

// raw body for Stripe signature verification
router.post('/', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('❌ Stripe webhook signature error:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type !== 'checkout.session.completed') {
    return res.status(200).send('Unhandled event type');
  }

  // --- Make a scoped Supabase client (service key) ---
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  try {
    const session = event.data.object;
    const email =
      session.customer_email ||
      (session.customer_details && session.customer_details.email) ||
      null;

    if (!email) {
      console.warn('⚠️ No email on session; skipping license write.');
      return res.status(200).send('No email');
    }

    // Read the product metadata (tier, durationDays)
    const lineItems = await stripe.checkout.sessions.listLineItems(session.id, {
      expand: ['data.price.product']
    });
    const product = lineItems?.data?.[0]?.price?.product;
    const meta = (product && product.metadata) || {};
    const planName = (product && product.name) || 'Unnamed Plan';

    const paidTier = String(meta.tier || 'pro').toLowerCase();  // default pro if missing
    const durationDays = parseInt(meta.durationDays || '30', 10);

    const now = new Date();
    const expiresAt = new Date(now.getTime() + durationDays * 24 * 60 * 60 * 1000);
    const licenseKey = crypto.randomBytes(16).toString('hex');

    // Upsert both smartemail_* and legacy fields
    const payload = {
      email: email.toLowerCase(),
      license_key: licenseKey,
      // Primary for SmartEmail:
      smartemail_tier: paidTier,
      smartemail_expires: expiresAt.toISOString(),
      // Keep legacy for compatibility:
      tier: paidTier,
      expires_at: expiresAt.toISOString(),
      // status flags
      status: 'active',
      is_active: true,
      // optional Stripe refs
      stripe_customer: session.customer || null,
      stripe_product: product?.id || null,
      plan: session.client_reference_id || 'checkout',
      name: planName,
      created_at: now.toISOString()
    };

    const { error } = await supabase
      .from('licenses')
      .upsert([payload], { onConflict: 'email' });

    if (error) {
      console.error('❌ Supabase upsert error:', error.message);
      return res.status(500).send('Database insert error');
    }

    console.log(`✅ License set: ${email} → ${paidTier} until ${payload.smartemail_expires}`);
    return res.status(200).send('Success');
  } catch (err) {
    console.error('❌ Webhook handler error:', err);
    return res.status(500).send('Server error');
  }
});

// Support both default and named import styles:
export { router as stripeWebHook };
export default router;
