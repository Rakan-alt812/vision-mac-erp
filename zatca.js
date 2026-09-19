'use strict';
const crypto = require('node:crypto');

/* ══════════════════════════════════════════════════════════════
   ZATCA Phase 2 (فاتورة) — e-invoice generation.

   What this module DOES produce, to spec:
     • UBL 2.1 invoice XML with the mandatory fields
     • The TLV → Base64 QR payload (tags 1-5 mandatory, 6-8 for signed)
     • SHA-256 invoice hash + previous-invoice-hash chain (PIH)

   What it CANNOT do without a real onboarding:
     • A valid cryptographic stamp. That requires a CSID certificate and
       private key issued to your VAT number by ZATCA. The signature block
       below is marked simulated and will be rejected by production.
     • Submission to the Clearance/Reporting API — needs the CSID + endpoint
       credentials from your ZATCA portal onboarding.

   Drop a real cert+key into settings and swap signSimulated() for a real
   ECDSA P-256 sign over the canonicalised XML, and the rest of the pipeline
   is already in the right shape.
   ══════════════════════════════════════════════════════════════ */

const R2 = n => Math.round((Number(n) || 0) * 100) / 100;
const esc = s => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&apos;');

/* ---- TLV encoding: tag (1 byte) | length (1 byte) | value (UTF-8) ---- */
function tlv(tag, value) {
  const v = Buffer.from(String(value), 'utf8');
  if (v.length > 255) throw new Error('قيمة TLV أطول من 255 بايت — الوسم ' + tag);
  return Buffer.concat([Buffer.from([tag, v.length]), v]);
}

/**
 * Build the ZATCA QR payload.
 * Tags: 1 seller name · 2 VAT number · 3 timestamp (ISO8601 Z)
 *       4 total incl. VAT · 5 VAT amount · 6 XML hash · 7 signature · 8 public key
 */
function buildQR({ sellerName, vatNumber, timestamp, total, vatAmount, xmlHash, signature, publicKey }) {
  const parts = [
    tlv(1, sellerName),
    tlv(2, vatNumber),
    tlv(3, timestamp),
    tlv(4, R2(total).toFixed(2)),
    tlv(5, R2(vatAmount).toFixed(2)),
  ];
  if (xmlHash) parts.push(tlv(6, xmlHash));
  if (signature) parts.push(tlv(7, signature));
  if (publicKey) parts.push(tlv(8, publicKey));
  return Buffer.concat(parts).toString('base64');
}

/** Decode a QR payload back into tags — used by the verify endpoint. */
function decodeQR(b64) {
  const buf = Buffer.from(b64, 'base64');
  const out = [];
  let i = 0;
  while (i < buf.length) {
    const tag = buf[i], len = buf[i + 1];
    if (len == null || i + 2 + len > buf.length) break;
    out.push({ tag, value: buf.slice(i + 2, i + 2 + len).toString('utf8') });
    i += 2 + len;
  }
  return out;
}

const TAG_NAMES = { 1: 'اسم البائع', 2: 'الرقم الضريبي', 3: 'التاريخ والوقت',
  4: 'الإجمالي شامل الضريبة', 5: 'مبلغ الضريبة', 6: 'بصمة الفاتورة',
  7: 'التوقيع الرقمي', 8: 'المفتاح العام' };

/* ---- SHA-256 hash of the canonical XML, Base64 (ZATCA uses Base64 not hex) ---- */
function hashXML(xml) {
  return crypto.createHash('sha256').update(xml, 'utf8').digest('base64');
}

/** Simulated stamp. Deterministic, clearly labelled, never valid in production. */
function signSimulated(hash) {
  return crypto.createHash('sha256').update('SIMULATED::' + hash).digest('base64').slice(0, 64);
}

/* ---- UBL 2.1 invoice ---- */
function buildXML({ invoice, seller, customer, lines, prevHash }) {
  const net = R2(lines.reduce((s, l) => s + l.qty * l.price, 0));
  const vat = R2(lines.reduce((s, l) => s + l.qty * l.price * l.vat, 0));
  const total = R2(net + vat);
  const ts = (invoice.idate || new Date().toISOString().slice(0, 10)) + 'T' +
             (invoice.itime || '12:00:00') + 'Z';
  const uuid = invoice.zatca_uuid || crypto.randomUUID();
  const pih = prevHash || Buffer.from('0').toString('base64');

  const lineXML = lines.map((l, i) => {
    const lnet = R2(l.qty * l.price), lvat = R2(lnet * l.vat);
    return `  <cac:InvoiceLine>
    <cbc:ID>${i + 1}</cbc:ID>
    <cbc:InvoicedQuantity unitCode="PCE">${R2(l.qty)}</cbc:InvoicedQuantity>
    <cbc:LineExtensionAmount currencyID="SAR">${lnet.toFixed(2)}</cbc:LineExtensionAmount>
    <cac:TaxTotal>
      <cbc:TaxAmount currencyID="SAR">${lvat.toFixed(2)}</cbc:TaxAmount>
      <cbc:RoundingAmount currencyID="SAR">${R2(lnet + lvat).toFixed(2)}</cbc:RoundingAmount>
    </cac:TaxTotal>
    <cac:Item>
      <cbc:Name>${esc(l.descr)}</cbc:Name>
      <cac:ClassifiedTaxCategory>
        <cbc:ID schemeID="UN/ECE 5305">S</cbc:ID>
        <cbc:Percent>${R2(l.vat * 100)}</cbc:Percent>
        <cac:TaxScheme><cbc:ID schemeID="UN/ECE 5153">VAT</cbc:ID></cac:TaxScheme>
      </cac:ClassifiedTaxCategory>
    </cac:Item>
    <cac:Price><cbc:PriceAmount currencyID="SAR">${R2(l.price).toFixed(2)}</cbc:PriceAmount></cac:Price>
  </cac:InvoiceLine>`;
  }).join('\n');

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"
         xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2"
         xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2"
         xmlns:ext="urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2">
  <cbc:ProfileID>reporting:1.0</cbc:ProfileID>
  <cbc:ID>${esc(invoice.code)}</cbc:ID>
  <cbc:UUID>${uuid}</cbc:UUID>
  <cbc:IssueDate>${esc(invoice.idate)}</cbc:IssueDate>
  <cbc:IssueTime>${esc(invoice.itime || '12:00:00')}</cbc:IssueTime>
  <cbc:InvoiceTypeCode name="0100000">388</cbc:InvoiceTypeCode>
  <cbc:DocumentCurrencyCode>SAR</cbc:DocumentCurrencyCode>
  <cbc:TaxCurrencyCode>SAR</cbc:TaxCurrencyCode>
  <cac:AdditionalDocumentReference>
    <cbc:ID>PIH</cbc:ID>
    <cac:Attachment>
      <cbc:EmbeddedDocumentBinaryObject mimeCode="text/plain">${pih}</cbc:EmbeddedDocumentBinaryObject>
    </cac:Attachment>
  </cac:AdditionalDocumentReference>
  <cac:AccountingSupplierParty>
    <cac:Party>
      <cac:PartyIdentification>
        <cbc:ID schemeID="CRN">${esc(seller.cr)}</cbc:ID>
      </cac:PartyIdentification>
      <cac:PostalAddress>
        <cbc:CityName>${esc(seller.city)}</cbc:CityName>
        <cac:Country><cbc:IdentificationCode>SA</cbc:IdentificationCode></cac:Country>
      </cac:PostalAddress>
      <cac:PartyTaxScheme>
        <cbc:CompanyID>${esc(seller.vat)}</cbc:CompanyID>
        <cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme>
      </cac:PartyTaxScheme>
      <cac:PartyLegalEntity>
        <cbc:RegistrationName>${esc(seller.name)}</cbc:RegistrationName>
      </cac:PartyLegalEntity>
    </cac:Party>
  </cac:AccountingSupplierParty>
  <cac:AccountingCustomerParty>
    <cac:Party>
      <cac:PostalAddress>
        <cbc:CityName>${esc(customer.city || 'جدة')}</cbc:CityName>
        <cac:Country><cbc:IdentificationCode>SA</cbc:IdentificationCode></cac:Country>
      </cac:PostalAddress>
      <cac:PartyTaxScheme>
        <cbc:CompanyID>${esc(customer.vat)}</cbc:CompanyID>
        <cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme>
      </cac:PartyTaxScheme>
      <cac:PartyLegalEntity>
        <cbc:RegistrationName>${esc(customer.name)}</cbc:RegistrationName>
      </cac:PartyLegalEntity>
    </cac:Party>
  </cac:AccountingCustomerParty>
  <cac:TaxTotal>
    <cbc:TaxAmount currencyID="SAR">${vat.toFixed(2)}</cbc:TaxAmount>
    <cac:TaxSubtotal>
      <cbc:TaxableAmount currencyID="SAR">${net.toFixed(2)}</cbc:TaxableAmount>
      <cbc:TaxAmount currencyID="SAR">${vat.toFixed(2)}</cbc:TaxAmount>
      <cac:TaxCategory>
        <cbc:ID schemeID="UN/ECE 5305">S</cbc:ID>
        <cbc:Percent>15.00</cbc:Percent>
        <cac:TaxScheme><cbc:ID schemeID="UN/ECE 5153">VAT</cbc:ID></cac:TaxScheme>
      </cac:TaxCategory>
    </cac:TaxSubtotal>
  </cac:TaxTotal>
  <cac:LegalMonetaryTotal>
    <cbc:LineExtensionAmount currencyID="SAR">${net.toFixed(2)}</cbc:LineExtensionAmount>
    <cbc:TaxExclusiveAmount currencyID="SAR">${net.toFixed(2)}</cbc:TaxExclusiveAmount>
    <cbc:TaxInclusiveAmount currencyID="SAR">${total.toFixed(2)}</cbc:TaxInclusiveAmount>
    <cbc:PayableAmount currencyID="SAR">${total.toFixed(2)}</cbc:PayableAmount>
  </cac:LegalMonetaryTotal>
${lineXML}
</Invoice>`;

  return { xml, uuid, net, vat, total, timestamp: ts, pih };
}

/** Full pipeline: XML → hash → simulated stamp → QR. */
function generate({ invoice, seller, customer, lines, prevHash }) {
  const built = buildXML({ invoice, seller, customer, lines, prevHash });
  const hash = hashXML(built.xml);
  const signature = signSimulated(hash);
  const qr = buildQR({
    sellerName: seller.name, vatNumber: seller.vat, timestamp: built.timestamp,
    total: built.total, vatAmount: built.vat, xmlHash: hash, signature,
    publicKey: 'SIMULATED-PUBLIC-KEY'
  });
  return { ...built, hash, signature, qr, simulated: true };
}

/** Validate a Saudi VAT number: 15 digits, starts and ends with 3. */
function validVAT(v) { return /^3\d{13}3$/.test(String(v || '')); }

module.exports = { generate, buildQR, decodeQR, hashXML, validVAT, TAG_NAMES, R2 };
