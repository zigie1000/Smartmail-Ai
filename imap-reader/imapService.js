// imap-reader/imapService.js — IMAP fetcher (iCloud-friendly), returns headers/attachments for better classification

import Imap from 'imap';
import { simpleParser } from 'mailparser';
import sslRootCAs from 'ssl-root-cas';
import dotenv from 'dotenv';
dotenv.config();

// trust common CAs (Render/iCloud TLS quirks)
const rootCas = sslRootCAs.create(); rootCas.inject();

const IMAP_DEBUG = String(process.env.IMAP_DEBUG || '').toLowerCase() === 'true';

function friendlyImapError(msg, ctx = {}){
  const s = String(msg||'').toLowerCase();
  if (/authentication failed|invalid credentials/.test(s)) return 'Authentication failed. Check email/password or app password.';
  if (/unable to verify the first certificate|self signed/i.test(s)) return 'TLS validation failed. Try TLS=On or correct host.';
  if (/timed? out|timeout/.test(s)) return 'IMAP connection timed out.';
  if (/no such host|getaddrinfo/i.test(s)) return `Cannot resolve host ${ctx.host||''}.`;
  return msg || 'IMAP error';
}

function openImap({ email, password, accessToken, host, port=993, tls=true, authType='password' }){
  const cfg = {
    user: email,
    host, port, tls,
    autotls: 'always',
    tlsOptions: { rejectUnauthorized: true, ca: rootCas },
    connTimeout: 30000, authTimeout: 30000
  };
  if (authType === 'xoauth2') cfg.xoauth2 = accessToken || password || '';
  else cfg.password = password;
  const imap = new Imap(cfg);
  if (IMAP_DEBUG){
    imap.on('alert',  m => console.log('[IMAP alert]', m));
    imap.on('close',  hadErr => console.log('[IMAP close]', hadErr));
    imap.on('error',  err => console.log('[IMAP error]', err?.message||err));
    imap.on('ready',  () => console.log('[IMAP ready]'));
  }
  return imap;
}

function openMailbox(imap, box='INBOX'){
  return new Promise((resolve, reject) => {
    imap.openBox(box, true, (err, boxInfo) => err ? reject(err) : resolve(boxInfo));
  });
}

function fetchBodies(imap, uids){
  return new Promise((resolve, reject) => {
    const out = [];
    if (!uids.length) return resolve(out);

    const f = imap.fetch(uids, { bodies: '', struct: true });
    f.on('message', (msg) => {
      const chunks = [];
      let attrs = null;
      msg.on('body', (stream) => {
        stream.on('data', (d)=>chunks.push(d));
      });
      msg.once('attributes', (a)=> attrs = a);
      msg.once('end', async () => {
        try{
          const parsed = await simpleParser(Buffer.concat(chunks));
          const headers = {};
          for (const [k,v] of parsed.headerLines || []) headers[k.toLowerCase()] = String(v||'');
          const attachments = parsed.attachments || [];
          const hasIcs = attachments.some(a => /\.ics$/i.test(a.filename || '')) || /text\/calendar/i.test(parsed.headers.get('content-type')||'');
          const attachTypes = attachments.map(a => (a.contentType||'').split(';')[0]);

          const fromObj = parsed.from?.value?.[0] || {};
          const fromEmail = String(fromObj.address||'').toLowerCase();
          const fromDomain = fromEmail.split('@')[1] || '';

          out.push({
            uid: attrs?.uid,
            id: attrs?.uid,
            date: parsed.date ? new Date(parsed.date).toISOString() : '',
            subject: parsed.subject || '',
            from: parsed.from?.text || '',
            fromEmail, fromDomain,
            to: parsed.to?.text || '',
            cc: parsed.cc?.text || '',
            snippet: (parsed.text||'').slice(0, 1200),
            text: parsed.text || '',
            headers,
            contentType: headers['content-type'] || '',
            hasIcs,
            attachTypes,
            unread: !attrs?.flags?.includes('\\Seen'),
            flagged: attrs?.flags?.includes('\\Flagged')
          });
        }catch(e){
          out.push({ uid: attrs?.uid, id: attrs?.uid, subject:'(parse failed)', snippet:'', headers:{} });
        }
      });
    });
    f.once('error', (e)=> reject(e));
    f.once('end', ()=> resolve(out));
  });
}

export async function fetchEmails({ email, password, accessToken, host, port=993, tls=true, authType='password', search=['ALL'], limit=20, importantFirst=false }) {
  return new Promise((resolve, reject) => {
    const imap = openImap({ email, password, accessToken, host, port, tls, authType });
    const finish = (err, data) => {
      try { imap.end(); } catch {}
      return err ? reject(new Error(friendlyImapError(err?.message||err, {host,email,authType}))) : resolve(data);
    };

    let watchdog = setTimeout(()=>{ try{ imap.destroy(); } catch{} finish(new Error('IMAP timed out')); }, 120000);

    imap.once('ready', async () => {
      try{
        await openMailbox(imap, 'INBOX');
        // Search UIDs by date range
        imap.search(search, async (err, uids) => {
          if (err) return finish(err);
          uids = (uids || []).slice(-Math.max(1, Number(limit)||20)); // last N
          if (!uids.length) return finish({ items:[], hasMore:false, nextCursor:null });

          // newest first
          uids.sort((a,b)=>b-a);

          const items = await fetchBodies(imap, uids);
          // sort important-first on the client usually; we keep order by date desc
          const payload = { items, hasMore:false, nextCursor:null };
          finish(payload);
        });
      }catch(e){ finish(e); }
    });

    imap.once('error', (e)=> {
      clearTimeout(watchdog);
      finish(e);
    });
    imap.once('end', ()=> {
      clearTimeout(watchdog);
    });

    try{ imap.connect(); } catch(e){ clearTimeout(watchdog); finish(e); }
  });
}

export async function testLogin({ email, password, accessToken, host, port=993, tls=true, authType='password' }){
  return new Promise((resolve, reject) => {
    const imap = openImap({ email, password, accessToken, host, port, tls, authType });
    const finish = (err) => { try{ imap.end(); }catch{}; return err ? reject(err) : resolve(true); };
    let watchdog = setTimeout(()=>{ try{ imap.destroy(); } catch{} finish(new Error('IMAP timed out')); }, 60000);

    imap.once('ready', async ()=> {
      try{ await openMailbox(imap, 'INBOX'); finish(); }
      catch(e){ finish(e); }
    });
    imap.once('error', (e)=> { clearTimeout(watchdog); finish(e); });
    imap.once('end', ()=> { clearTimeout(watchdog); });

    try{ imap.connect(); } catch(e){ clearTimeout(watchdog); finish(e); }
  });
}
