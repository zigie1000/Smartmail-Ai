const express = require('express');
const router = express.Router();
const { supabase } = require('./licenseManager');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const crypto = require('crypto');

router.post('/', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('❌ Stripe webhook signature error:', err.message);
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

      console.log('📦 Stripe product ID:', stripeProductId);
      console.log('📄 Stripe product metadata:', productMetadata);
      console.log('🏷️ Plan Name:', planName);

      if (!productMetadata.tier || !productMetadata.durationDays) {
        console.warn('⚠️ Metadata missing or incomplete. Applying fallback values.');
        productMetadata.tier = productMetadata.tier || 'default';
        productMetadata.durationDays = productMetadata.durationDays || '30';
      }
    } catch (err) {
      console.error('❌ Failed to retrieve line items or product metadata:', err.message);
      return res.status(500).send('Stripe product retrieval error');
    }

    const licenseType = productMetadata.tier;
    const durationDays = parseInt(productMetadata.durationDays, 10) || 30;

    const now = new Date();
    const expiresAt = new Date(now.getTime() + durationDays * 24 * 60 * 60 * 1000);
    const licenseKey = crypto.randomBytes(16).toString('hex');

    const insertPayload = {
      email,
      license_key: licenseKey,
      license_type: licenseType,
      plan: planId,
      name: planName,
      status: 'active',
      is_active: true,
      expires_at: expiresAt.toISOString(),
      created_at: now.toISOString(),
      stripe_customer: stripeCustomer,
      stripe_product: stripeProductId
    };

    const { error } = await supabase.from('licenses').upsert([insertPayload], { onConflict: ['email'] });

    if (error) {
      console.error('❌ Supabase insert/upsert error:', error.message);
      return res.status(500).send('Database insert error');
    }

    console.log(`✅ License inserted or updated for ${email} → ${licenseType} until ${expiresAt.toISOString()}`);
    return res.status(200).send('Success');
  }

  return res.status(200).send('Unhandled event type');
});

module.exports = router;
