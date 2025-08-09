import Imap from 'imap';
import { simpleParser } from 'mailparser';
import dotenv from 'dotenv';
dotenv.config();

export async function fetchEmails({ email, password, host, port = 993, criteria = ['ALL'], limit = 20 }) {
  return new Promise((resolve, reject) => {
    const imap = new Imap({
      user: email,
      password,
      host,
      port,
      tls: true
    });

    let emails = [];

    imap.once('ready', () => {
      imap.openBox('INBOX', true, (err, box) => {
        if (err) return reject(err);

        imap.search(criteria, (err, results) => {
          if (err) return reject(err);

          const fetcher = imap.fetch(results.slice(-limit), { bodies: '' });
          fetcher.on('message', (msg) => {
            msg.on('body', (stream) => {
              simpleParser(stream, (err, parsed) => {
                if (!err) {
                  emails.push({
                    subject: parsed.subject || '(no subject)',
                    from: parsed.from?.text || '',
                    date: parsed.date,
                    text: parsed.text || '',
                    html: parsed.html || ''
                  });
                }
              });
            });
          });

          fetcher.once('end', () => {
            imap.end();
          });
        });
      });
    });

    imap.once('error', (err) => reject(err));
    imap.once('end', () => resolve(emails));
    imap.connect();
  });
}
