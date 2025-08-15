// stripeWebhook.js — ESM webhook for Stripe + Supabase
// - Exports a DEFAULT handler
// - Uses express.raw on the route (mounted in server.js)
// - Writes both legacy columns (license_type/expires_at) and app-specific smartemail_* columns

import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '', {
  apiVersion: '2023-10-16',
});

const supabase = createClient(
  process.env.SUPABASE_URL || '',
  process.env.SUPABASE_SERVICE_KEY || ''
);

function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

export default async function stripeWebHook(req, res) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    console.error('Missing STRIPE_WEBHOOK_SECRET');
    return res.status(500).json({ error: 'Webhook not configured' });
  }

  const sig = req.headers['stripe-signature'];
  let event;
  try {
    // req.body is a Buffer because we mount express.raw({ type:'application/json' }) on this route
    event = stripe.webhooks.constructEvent(req.body, sig, secret);
  } catch (err) {
    console.error('❌ Stripe signature error:', err?.message || err);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;

      // Email from metadata overrides Stripe customer email if present
      const md = session.metadata || {};
      const email =
        md.email ||
        session.customer_details?.email ||
        session.customer_email ||
        '';

      if (!email) {
        console.warn('⚠️ No email found on session; skipping license creation.');
        return res.status(200).send('No email; skipped');
      }

      // Pull product metadata (tier & durationDays) from the first line item’s Product
      let productMeta = {};
      let stripeProductId = null;
      let planName = 'Unnamed Plan';

      try {
        const lineItems = await stripe.checkout.sessions.listLineItems(session.id, {
          expand: ['data.price.product'],
        });
        const product = lineItems.data?.[0]?.price?.product;
        stripeProductId = product?.id || null;
        productMeta = product?.metadata || {};
        planName = product?.name || 'Unnamed Plan';
      } catch (e) {
        console.error('❌ Could not fetch session line items/product:', e?.message || e);
      }

      // Determine tier and duration
      const tier = String(productMeta.tier || md.tier || 'pro').toLowerCase();
      const durationDays = parseInt(productMeta.durationDays || md.durationDays || '30', 10) || 30;

      // Compute expiry
      const now = new Date();
      const expiresAt = addDays(now, durationDays);

      // License key preference: metadata.license_key → fallback generated
      const licenseKey =
        md.license_key ||
        `lic_${email.replace(/[^a-z0-9]/gi, '').toLowerCase()}_${Date.now()}`;

      // Upsert license
      // NOTE:
      //  - Keep legacy columns license_type / expires_at (your previous schema)
      //  - ALSO set SmartEmail-scoped columns smartemail_tier / smartemail_expires
      const payload = {
        email: email.toLowerCase(),
        license_key: licenseKey,

        // Legacy columns (keep for compatibility with your old code/queries)
        license_type: tier,
        plan: session.client_reference_id || 'manual',
        name: planName,
        status: 'paid',
        is_active: true,
        expires_at: expiresAt.toISOString(),
        created_at: now.toISOString(),
        stripe_customer: session.customer || null,
        stripe_product: stripeProductId,

        // App-specific columns your UI/server read
        smartemail_tier: tier,
        smartemail_expires: expiresAt.toISOString(),
      };

      const { error } = await supabase
        .from('licenses')
        .upsert(payload, { onConflict: 'email' });

      if (error) {
        console.error('❌ Supabase upsert error:', error.message || error);
        return res.status(500).send('Database upsert error');
      }

      console.log(`✅ License upserted for ${email} → ${tier} until ${expiresAt.toISOString()}`);
      return res.status(200).send('Success');
    }

    // Optional: handle subscription events, cancellations, etc.
    if (event.type === 'customer.subscription.deleted') {
      // If you store email in subscription metadata, you can downgrade here.
      const sub = event.data.object;
      const email = sub.metadata?.email || '';
      if (email) {
        await supabase
          .from('licenses')
          .update({
            status: 'canceled',
            is_active: false,
            smartemail_tier: 'free',
            smartemail_expires: null,
          })
          .eq('email', email.toLowerCase());
      }
      return res.status(200).send('Subscription handled');
    }

    // Everything else is fine to ignore
    return res.status(200).send('Unhandled event type');
  } catch (err) {
    console.error('❌ Webhook handler error:', err?.message || err);
    return res.status(500).json({ error: 'Webhook handler failed' });
  }
}
