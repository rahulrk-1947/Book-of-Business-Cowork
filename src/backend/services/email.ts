/**
 * Email composition. The app can't send mail itself from the browser (there's
 * no mail server), so it composes the message — recipient, subject and body
 * filled from an editable per-document-type template — and hands it to the
 * user's email app. `compose` does the placeholder substitution server-side so
 * it's testable and consistent.
 *
 * Placeholders: {contact} {number} {date} {due_date} {total} {amount_due}
 *               {currency} {org} {reference} {footer}
 */
import { getDb } from '../db';
import { baseCurrency } from '../engine';
import * as invoices from './invoices';

export type EmailDocType = 'ACCREC' | 'ACCPAY' | 'ACCRECCREDIT' | 'ACCPAYCREDIT' | 'QUOTE' | 'PO' | 'REMINDER';

const LABEL: Record<EmailDocType, string> = {
  ACCREC: 'invoice', ACCPAY: 'bill', ACCRECCREDIT: 'credit note',
  ACCPAYCREDIT: 'supplier credit', QUOTE: 'quote', PO: 'purchase order', REMINDER: 'payment reminder',
};

// The base email_templates table keys rows by a document_type string.
const DOC_TYPE: Record<EmailDocType, string> = {
  ACCREC: 'INVOICE', ACCPAY: 'BILL', ACCRECCREDIT: 'CREDITNOTE',
  ACCPAYCREDIT: 'SUPPLIERCREDIT', QUOTE: 'QUOTE', PO: 'PO', REMINDER: 'REMINDER',
};

/** Sensible defaults so a template always exists, even before customising. */
function defaultTemplate(docType: EmailDocType): { subject: string; body: string } {
  const noun = LABEL[docType] ?? 'document';
  if (docType === 'QUOTE') {
    return {
      subject: 'Quote {number} from {org}',
      body: 'Hi {contact},\n\nThank you for your interest. Please find quote {number} for {total} attached.\n\n{footer}\n\nKind regards,\n{org}',
    };
  }
  if (docType === 'PO') {
    return {
      subject: 'Purchase order {number} from {org}',
      body: 'Hi {contact},\n\nPlease find our purchase order {number} for {total} attached.\n\n{footer}\n\nKind regards,\n{org}',
    };
  }
  if (docType === 'REMINDER') {
    return {
      subject: 'Payment reminder from {org}',
      body: 'Hi {contact},\\n\\nThis is a friendly reminder that the following, totalling {total}, is currently outstanding on your account:\\n\\n{invoices}\\n\\nIf payment is already on its way, thank you \u2014 please disregard this note. Otherwise we would be grateful for settlement at your earliest convenience.\\n\\n{footer}\\n\\nKind regards,\\n{org}',
    };
  }
  return {
    subject: `${capitalize(noun)} {number} from {org}`,
    body: `Hi {contact},\n\nPlease find ${noun} {number} for {total} attached, due {due_date}.\n\n{footer}\n\nThank you,\n{org}`,
  };
}

function capitalize(s: string) { return s.charAt(0).toUpperCase() + s.slice(1); }

export function getTemplate(docType: EmailDocType) {
  const row: any = getDb().prepare('SELECT subject, body FROM email_templates WHERE document_type = ?').get(DOC_TYPE[docType]);
  const hasRow = !!(row && row.subject);
  return { doc_type: docType, ...(hasRow ? { subject: row.subject, body: row.body } : defaultTemplate(docType)), is_default: !hasRow };
}

export function listTemplates() {
  return (Object.keys(LABEL) as EmailDocType[]).map((t) => ({ label: capitalize(LABEL[t]), ...getTemplate(t) }));
}

export function saveTemplate(input: { doc_type: EmailDocType; subject: string; body: string }) {
  if (!input.subject?.trim()) throw new Error('The subject can’t be empty');
  if (!input.body?.trim()) throw new Error('The body can’t be empty');
  getDb().prepare(
    `INSERT INTO email_templates (document_type, subject, body) VALUES (?, ?, ?)
     ON CONFLICT(document_type) DO UPDATE SET subject = excluded.subject, body = excluded.body`
  ).run(DOC_TYPE[input.doc_type], input.subject, input.body);
  return getTemplate(input.doc_type);
}

/** Reset a template back to the built-in default. */
export function resetTemplate(docType: EmailDocType) {
  getDb().prepare('DELETE FROM email_templates WHERE document_type = ?').run(DOC_TYPE[docType]);
  return getTemplate(docType);
}

function loadDoc(docType: EmailDocType, id: number): any {
  if (docType === 'QUOTE') return invoices.getQuote(id);
  if (docType === 'PO') return invoices.getPO(id);
  return invoices.get(id);
}

/** Build a ready-to-send email for a document: to, subject, body, and filename. */
export function compose(docType: EmailDocType, id: number) {
  const db = getDb();
  const doc = loadDoc(docType, id);
  if (!doc) throw new Error('Document not found');
  const org: any = db.prepare('SELECT trading_name, legal_name, invoice_footer FROM organisations WHERE id = 1').get() ?? {};
  const contact: any = db.prepare('SELECT name, email FROM contacts WHERE id = ?').get(doc.contact_id) ?? {};

  const cur = doc.currency_code ?? baseCurrency();
  const fmt = (c: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: cur }).format((c ?? 0) / 100);
  const number = doc.invoice_number ?? doc.quote_number ?? doc.order_number ?? '';
  const orgName = org.trading_name || org.legal_name || 'us';

  const fields: Record<string, string> = {
    contact: contact.name ?? '',
    number,
    date: doc.date ?? '',
    due_date: doc.due_date ?? doc.expiry_date ?? doc.delivery_date ?? '',
    total: fmt(doc.total),
    amount_due: fmt(doc.amount_due ?? doc.total),
    currency: cur,
    org: orgName,
    reference: doc.reference ?? '',
    footer: org.invoice_footer ?? '',
  };
  const fill = (s: string) => s
    .replace(/\\n/g, '\n')                                   // seeded templates store literal \n
    .replace(/\{(\w+)\}/g, (_, k) => (k in fields ? fields[k] : `{${k}}`))
    .replace(/\n{3,}/g, '\n\n')                              // tidy blank placeholder lines (e.g. empty footer)
    .trim();

  const tpl = getTemplate(docType);
  return {
    to: contact.email ?? '',
    subject: fill(tpl.subject),
    body: fill(tpl.body),
    number,
    filename: `${number || LABEL[docType]}.pdf`,
    has_recipient: !!contact.email,
  };
}
