// stripeWebhook.js — ESM webhook handler for Stripe + Supabase
// Exports a DEFAULT function. Keep req.body as RAW (mounted in server.js).
import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '', { apiVersion: '2023-10-16' });
const supabase = createClient(process.env.SUPABASE_URL || '', process.env.SUPABASE_SERVICE_KEY || '');

function addDays(date, days) { const d = new Date(date); d.setDate(d.getDate() + days); return d; }

export default async function stripeWebHook(req, res) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) return res.status(500).json({ error: 'Missing STRIPE_WEBHOOK_SECRET' });

  const sig = req.headers['stripe-signature'];
  let event;
  try {
    // req.body must be a Buffer (express.raw on route)
    event = stripe.webhooks.constructEvent(req.body, sig, secret);
  } catch (err) {
    console.error('❌ Stripe signature error:', err?.message || err);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;

      // Email priority: metadata.email > customer_details.email > customer_email
      const md = session.metadata || {};
      const email =
        (md.email || session.customer_details?.email || session.customer_email || '').toLowerCase();
      if (!email) return res.status(200).send('No email; skipped');

      // Pull product metadata (tier, durationDays) from first line item product
      let productMeta = {};
      let stripeProductId = null;
      let planName = 'Unnamed Plan';
      try {
        const lines = await stripe.checkout.sessions.listLineItems(session.id, { expand: ['data.price.product'] });
        const product = lines.data?.[0]?.price?.product;
        stripeProductId = product?.id || null;
        productMeta = product?.metadata || {};
        planName = product?.name || 'Unnamed Plan';
      } catch (e) {
        console.error('⚠️ Could not expand product metadata:', e?.message || e);
      }

      const tier = String(productMeta.tier || md.tier || 'pro').toLowerCase();
      const durationDays = parseInt(productMeta.durationDays || md.durationDays || '30', 10) || 30;

      const now = new Date();
      const expiresAt = addDays(now, durationDays);
      const licenseKey =
        md.license_key || `lic_${email.replace(/[^a-z0-9]/gi, '')}_${Date.now()}`;

      // Write BOTH legacy columns and SmartEmail-scoped columns
      const payload = {
        email,
        license_key: licenseKey,

        // legacy
        license_type: tier,
        plan: session.client_reference_id || 'manual',
        name: planName,
        status: 'paid',
        is_active: true,
        expires_at: expiresAt.toISOString(),
        created_at: now.toISOString(),
        stripe_customer: session.customer || null,
        stripe_product: stripeProductId,

        // SmartEmail columns the UI/server prefer
        smartemail_tier: tier,
        smartemail_expires: expiresAt.toISOString(),
      };

      const { error } = await supabase.from('licenses').upsert(payload, { onConflict: 'email' });
      if (error) {
        console.error('❌ Supabase upsert error:', error.message || error);
        return res.status(500).send('Database upsert error');
      }

      console.log(`✅ License upserted for ${email} → ${tier} until ${expiresAt.toISOString()}`);
      return res.status(200).send('Success');
    }

    if (event.type === 'customer.subscription.deleted') {
      const sub = event.data.object;
      const email = (sub.metadata?.email || '').toLowerCase();
      if (email) {
        await supabase
          .from('licenses')
          .update({
            status: 'canceled',
            is_active: false,
            smartemail_tier: 'free',
            smartemail_expires: null,
          })
          .eq('email', email);
      }
      return res.status(200).send('Subscription handled');
    }

    return res.status(200).send('Unhandled event');
  } catch (err) {
    console.error('❌ Webhook handler error:', err?.message || err);
    return res.status(500).json({ error: 'Webhook handler failed' });
  }
}
