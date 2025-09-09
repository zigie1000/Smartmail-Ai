// imap-reader/imapClassifier.js (ESM)

/**
 * emails: [{ subject, fromEmail, fromDomain, text, snippet, flags: [] , ... }]
 * opts.lists:
 *   - vip: Set of emails or domains
 *   - legal: Set of domains
 *   - government: Set of domains
 *   - bulk: Set of sender domains you consider bulk
 *   - weights: { email: Map, domain: Map } (optional)
 */
export async function classifyEmails(emails = [], opts = {}) {
  const lists = opts.lists || {};
  const vipSet   = lists.vip || new Set();
  const legalSet = lists.legal || new Set();
  const govSet   = lists.government || new Set();
  const bulkSet  = lists.bulk || new Set();

  const lowerHas = (s, needles=[]) => {
    const t = String(s || '').toLowerCase();
    return needles.some(n => t.includes(String(n).toLowerCase()));
  };

  return (emails || []).map((e) => {
    const out = { ...e };
    const subject = String(e.subject || '');
    const textAll = (e.text || e.snippet || '').toLowerCase();
    const fromEmail  = String(e.fromEmail || '').toLowerCase();
    const fromDomain = String(e.fromDomain || '').toLowerCase();

    const labels = new Set(out.labels || []);
    let importance = 'unclassified';
    let urgency = 0;
    let action_required = false;

    // VIP by exact email or domain
    if (vipSet.has(fromEmail) || vipSet.has(fromDomain)) {
      labels.add('VIP');
      importance = 'high';
    }

    // Legal & Security
    if (
      legalSet.has(fromDomain) ||
      lowerHas(subject, ['legal', 'contract', 'nda', 'attorney', 'law', 'subpoena']) ||
      lowerHas(textAll, ['legal disclaimer', 'terms of service', 'settlement'])
    ) {
      labels.add('Legal');
      if (importance === 'unclassified') importance = 'medium';
    }

    // Government / Tax
    if (govSet.has(fromDomain) || lowerHas(fromDomain, ['gov', 'gov.za', 'sars.gov', 'hmrc', 'irs'])) {
      labels.add('Government');
      importance = 'high';
    }

    // Finance / Billing
    if (
      lowerHas(subject, ['invoice', 'receipt', 'payment', 'billing', 'statement']) ||
      lowerHas(textAll,   ['invoice', 'receipt', 'payment due', 'wire instructions'])
    ) {
      labels.add('Finance');
      if (importance !== 'high') importance = 'medium';
    }

    // Meetings
    if (lowerHas(subject, ['meeting', 'invite', 'calendar', 'schedule']) || lowerHas(textAll, ['zoom', 'meet.google'])) {
      labels.add('Meetings');
    }

    // Newsletters / bulk marketing
    if (
      bulkSet.has(fromDomain) ||
      lowerHas(subject, ['newsletter', 'update', 'digest', 'unsubscribe']) ||
      lowerHas(textAll, ['unsubscribe', 'manage preferences'])
    ) {
      labels.add('Newsletters');
      if (importance === 'unclassified') importance = 'low';
    }

    // Urgent / Actionable
    if (lowerHas(subject, ['urgent', 'asap', 'action required']) || lowerHas(textAll, ['action required'])) {
      labels.add('Urgent');
      importance = 'high';
      urgency = Math.max(urgency, 2);
      action_required = true;
    }

    // Needs Action heuristic
    if (lowerHas(textAll, ['please confirm', 'please review', 'please reply', 'follow up'])) {
      labels.add('Needs Action');
      action_required = true;
      if (importance === 'unclassified') importance = 'medium';
    }

    // Finalize
    out.labels = Array.from(labels);
    out.importance = importance;
    out.urgency = urgency;
    out.action_required = action_required;
    return out;
  });
}

export default { classifyEmails };
