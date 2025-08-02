// stripeWebHook.js — SmartEmail only
import express from 'express';
import { createClient } from '@supabase/supabase-js';
import Stripe from 'stripe';
import crypto from 'crypto';

const router = express.Router();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// Stripe Webhook Endpoint
router.post('/', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('❌ Stripe webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const email = session.customer_email || (session.customer_details && session.customer_details.email);
    const planId = session.client_reference_id || 'manual';
    const stripeCustomer = session.customer;

    let productMetadata = {};
    let stripeProductId = null;
    let planName = 'Unnamed Plan';

    try {
      const lineItems = await stripe.checkout.sessions.listLineItems(session.id, {
        expand: ['data.price.product']
      });

      const product = lineItems.data?.[0]?.price?.product;
      stripeProductId = product?.id;
      productMetadata = product?.metadata || {};
      planName = product?.name || 'Unnamed Plan';

      if (!productMetadata.tier || !productMetadata.durationDays) {
        console.warn('⚠️ Missing product metadata. Applying fallback values.');
        productMetadata.tier = productMetadata.tier || 'free';
        productMetadata.durationDays = productMetadata.durationDays || '30';
      }
    } catch (err) {
      console.error('❌ Failed to retrieve product metadata:', err.message);
      return res.status(500).send('Product metadata error');
    }

    const tier = productMetadata.tier;
    const durationDays = parseInt(productMetadata.durationDays, 10) || 30;

    const now = new Date();
    const expiresAt = new Date(now.getTime() + durationDays * 24 * 60 * 60 * 1000);
    const licenseKey = crypto.randomBytes(16).toString('hex');

    const payload = {
      email,
      license_key: licenseKey,
      license_type: tier,
      plan: planId,
      name: planName,
      status: 'active',
      is_active: true,
      expires_at: expiresAt.toISOString(),
      created_at: now.toISOString(),
      stripe_customer: stripeCustomer,
      stripe_product: stripeProductId
    };

    const { error } = await supabase.from('licenses').upsert([payload], {
      onConflict: ['email']
    });

    if (error) {
      console.error('❌ Supabase insert/upsert error:', error.message);
      return res.status(500).send('Database insert error');
    }

    console.log(`✅ SmartEmail license activated: ${email} → ${tier} until ${expiresAt.toISOString()}`);
    return res.status(200).send('Success');
  }

  return res.status(200).send('Unhandled event type');
});

export default router;
