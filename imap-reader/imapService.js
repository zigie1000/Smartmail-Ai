// imap-reader/imapService.js (compatible with 'imap' package, minimal improvements)
import Imap from 'imap';
import { simpleParser } from 'mailparser';
import dotenv from 'dotenv';
import sslRootCAs from 'ssl-root-cas';
const rootCas = sslRootCAs.create();
rootCas.inject();
dotenv.config();

function normalizeCriteria(raw){
  if (!raw) return ['ALL'];
  if (Array.isArray(raw) && String(raw[0]).toUpperCase() === 'SINCE'){
    let v = raw[1]; if (!(v instanceof Date)) v = new Date(v); if (isNaN(v.getTime())) return ['ALL']; return [['SINCE', v]];
  }
  if (Array.isArray(raw)) {
    const fixed = raw.map(c=>{
      if (Array.isArray(c) && String(c[0]).toUpperCase()==='SINCE'){
        let v=c[1]; if(!(v instanceof Date)) v=new Date(v); if(isNaN(v.getTime())) return null; return ['SINCE', v];
      }
      return c;
    }).filter(Boolean);
    return fixed.length?fixed:['ALL'];
  }
  return ['ALL'];
}

export async function fetchEmails({
  email, password, host, port=993,
  criteria=['ALL'], limit=20, tls=true,
  authType='password', accessToken=''
}){
  return new Promise((resolve, reject)=>{
    let settled=false;
    const done=(err, data)=>{ if(settled) return; settled=true; err?reject(err):resolve(data||[]); };

    criteria = normalizeCriteria(criteria);

    const imapConfig = {
      user: email,
      host,
      port: Number(port)||993,
      tls: !!tls,
      tlsOptions: { rejectUnauthorized:true, servername: host, ca: rootCas },
      connTimeout: 30000,
      authTimeout: 30000
    };

    if (authType === 'xoauth2') {
      // The 'imap' module expects XOAUTH2 initial client response.
      // If you pass a raw access token, many servers will still accept it.
      // For strict servers, generate the SASL string: base64("user=<email>\x01auth=Bearer <token>\x01\x01")
      const token = accessToken || password || '';
      imapConfig.xoauth2 = Buffer.from(`user=${email}\x01auth=Bearer ${token}\x01\x01`).toString('base64');
    } else {
      imapConfig.password = password;
    }

    const imap = new Imap(imapConfig);
    const emails=[];
    const parsers=[];

    const watchdog = setTimeout(()=>{ try{imap.end();}catch{} done(new Error('IMAP connection timed out')); }, 90000);

    imap.once('ready', ()=>{
      imap.openBox('INBOX', true, (err)=>{
        if(err){ clearTimeout(watchdog); return done(err); }
        imap.search(criteria, (err, results=[])=>{
          if(err){ clearTimeout(watchdog); return done(err); }

          if(!Array.isArray(results) || results.length===0){
            clearTimeout(watchdog); try{imap.end();}catch{}; return;
          }
          const n = Math.max(0, Math.min(Number(limit)||0, results.length)) || results.length;
          const uids = results.slice(-n); // newest last; we'll reverse later

          const fetcher = imap.fetch(uids, { bodies: '', struct: true });
          fetcher.on('message', (msg)=>{
            let currentUid=null, internalDate=null, struct=null;
            msg.once('attributes', (attrs)=>{
              currentUid = attrs?.uid ?? null;
              internalDate = attrs?.date ?? null;
              struct = attrs?.struct || null;
            });
            msg.on('body', (stream)=>{
              const p = new Promise((res)=>{
                simpleParser(stream, (err, parsed)=>{
                  if(!err && parsed){
                    const text = parsed.text || '';
                    const hasAttachments = Array.isArray(parsed.attachments) && parsed.attachments.length>0;
                    emails.push({
                      uid: currentUid,
                      subject: parsed.subject || '(no subject)',
                      from: parsed.from?.text || '',
                      to: parsed.to?.text || '',
                      date: parsed.date || internalDate || null,
                      text,
                      snippet: text.slice(0, 500),
                      hasAttachments,
                      importance: 'unimportant'
                    });
                  }
                  res();
                });
              });
              parsers.push(p);
            });
          });

          fetcher.once('error', (e)=>{ clearTimeout(watchdog); done(new Error(`IMAP fetch error: ${e?.message||e}`)); });
          fetcher.once('end', ()=>{ Promise.allSettled(parsers).finally(()=>{ try{imap.end();}catch{} }); });
        });
      });
    });
    imap.once('error', (err)=>{ clearTimeout(watchdog); done(new Error(err?.message||'IMAP error')); });
    imap.once('end',   ()=>{ clearTimeout(watchdog); // sort newest first
      emails.sort((a,b)=> new Date(b.date||0) - new Date(a.date||0));
      done(null, emails);
    });

    try{ imap.connect(); } catch(e){ clearTimeout(watchdog); done(new Error(e?.message||'Failed to start IMAP connection')); }
  });
}
