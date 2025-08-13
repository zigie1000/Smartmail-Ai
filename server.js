// server.js — SmartEmail + IMAP UI/API (+ optional Google/Microsoft OAuth hooks)

// Force IPv4 to avoid IPv6 stalls with iCloud IMAP on Render
import dns from 'dns';
dns.setDefaultResultOrder?.('ipv4first');

import express from 'express';
import fetch from 'node-fetch';
import dotenv from 'dotenv';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';

// Optional: Supabase (used by /validate-license if you have a licenses table)
import { createClient } from '@supabase/supabase-js';

// ✅ IMAP REST routes (kept inside this repo’s file tree)
import imapRoutes from './imap-reader/imapRoutes.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// ---------- Core middleware ----------
app.set('trust proxy', 1);
app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// ---------- Static UI ----------
app.use(express.static(path.join(__dirname, 'public')));

// ---------- Health check ----------
app.get('/healthz', (req, res) => res.status(200).send('ok'));

// ---------- IMAP API ----------
app.use('/api/imap', imapRoutes);

// ---------- (Optional) License validation ----------
// This is null-safe. If you don't use Supabase, it just returns "free".
app.get('/validate-license', async (req, res) => {
  try {
    const email = typeof req.query.email === 'string' ? req.query.email.trim().toLowerCase() : '';
    const licenseKey = typeof req.query.licenseKey === 'string' ? req.query.licenseKey.trim() : '';

    // If no Supabase creds, return "free" and avoid crashes
    const SUPABASE_URL = process.env.SUPABASE_URL || '';
    const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || '';
    if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
      return res.status(200).json({
        status: 'active',
        tier: 'free',
        email: email || null,
        licenseKey: null,
        expiresAt: null
      });
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

    let row = null;
    if (licenseKey) {
      const { data, error } = await supabase
        .from('licenses')
        .select('email, license_key, smartemail_tier, smartemail_expires')
        .eq('license_key', licenseKey)
        .maybeSingle();
      if (error) throw error;
      row = data;
    } else if (email) {
      const { data, error } = await supabase
        .from('licenses')
        .select('email, license_key, smartemail_tier, smartemail_expires')
        .eq('email', email)
        .maybeSingle();
      if (error) throw error;
      row = data;
    }

    // If no row, default to free without throwing
    if (!row) {
      return res.status(200).json({
        status: 'active',
        tier: 'free',
        email: email || null,
        licenseKey: null,
        expiresAt: null
      });
    }

    const now = new Date();
    const tier = row.smartemail_tier || 'free';
    const expiresAt = row.smartemail_expires || null;
    const active = tier === 'free' || !expiresAt || (new Date(expiresAt) >= now);

    return res.status(200).json({
      status: active ? 'active' : 'expired',
      tier,
      email: row.email || null,
      licenseKey: row.license_key || null,
      expiresAt
    });
  } catch (err) {
    console.error('validate-license error:', err?.message || err);
    return res.status(500).json({ error: 'Validation failed' });
  }
});

// ---------- Root -> serve app ----------
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Convenience routes to the IMAP UI
app.get('/imap', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'imap.html'));
});

// ---------- Start ----------
app.listen(PORT, () => {
  console.log(`SmartEmail backend running on port ${PORT}`);
});
