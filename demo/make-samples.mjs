// Writes the demo's sample invoices to demo/inbox/ as small text PDFs (no dependencies).
// Every company, address and number here is made up.
//   node demo/make-samples.mjs
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const INBOX = fileURLToPath(new URL('./inbox/', import.meta.url));

const SAMPLES = {
  // Balanced and complete: should be auto-approved.
  '1-northwind-INV-1042.pdf': [
    'Northwind Office Supplies Kft.',
    '12 Mill Road, 1095 Budapest',
    'billing@northwind.example',
    '',
    'INVOICE  INV-1042',
    'Invoice date: 2026-10-02      Due date: 2026-11-01',
    'Bill to: Lakeside Dental',
    '',
    'Description              Qty   Unit price   Line total',
    'Copy paper, A4 (box)      10        5.50         55.00',
    'Toner cartridge            2       42.50         85.00',
    '',
    'Subtotal                                       140.00',
    'VAT 27%                                         37.80',
    'Total (EUR)                                    177.80',
    'Payment terms: 30 days',
  ],
  // The supplier's subtotal is wrong (120 + 80 = 200, printed 210): should need review.
  '2-kovacs-print-2044.pdf': [
    'Kovacs Print Bt.',
    '4 Csengery utca, 1067 Budapest',
    'invoices@kovacsprint.example',
    '',
    'INVOICE  2044',
    'Invoice date: 2026-10-05      Due date: 2026-10-20',
    'Bill to: Lakeside Dental',
    '',
    'Description              Qty   Unit price   Line total',
    'Appointment cards       1000        0.12        120.00',
    'Window vinyl               1       80.00         80.00',
    '',
    'Subtotal                                       210.00',
    'VAT 27%                                         56.70',
    'Total (EUR)                                    266.70',
    'Payment terms: 15 days',
  ],
  // A credit note (negative total): should be recommended for review.
  '3-harbour-CN-77.pdf': [
    'Harbour Medical Supply Ltd',
    '9 Quay Street, Dublin 2',
    'accounts@harbourmedical.example',
    '',
    'CREDIT NOTE  CN-77',
    'Date: 2026-10-07',
    'Credit to: Lakeside Dental',
    '',
    'Description              Qty   Unit price   Line total',
    'Returned gloves, box      -1       42.50        -42.50',
    '',
    'Subtotal                                       -42.50',
    'VAT 27%                                        -11.48',
    'Total (EUR)                                    -53.98',
  ],
  // Already in the ledger from last month (see sheet-seed.json): should be caught as a duplicate.
  '4-northwind-INV-1001.pdf': [
    'Northwind Office Supplies Kft.',
    '12 Mill Road, 1095 Budapest',
    'billing@northwind.example',
    '',
    'INVOICE  INV-1001',
    'Invoice date: 2026-09-03      Due date: 2026-10-03',
    'Bill to: Lakeside Dental',
    '',
    'Description              Qty   Unit price   Line total',
    'Copy paper, A4 (box)      20        5.50        110.00',
    '',
    'Subtotal                                       110.00',
    'VAT 27%                                         29.70',
    'Total (EUR)                                    139.70',
    'Payment terms: 30 days',
  ],
};

/** A one-page PDF with the lines in Courier. Enough for any PDF text extractor. */
function pdf(lines) {
  const esc = (s) => s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
  const stream = ['BT', '/F1 10 Tf', '13 TL', '50 790 Td', ...lines.map((l) => `(${esc(l)}) '`), 'ET'].join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>',
    `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`,
  ];
  let out = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out, 'latin1'));
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += `${String(o).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

mkdirSync(INBOX, { recursive: true });
for (const [name, lines] of Object.entries(SAMPLES)) writeFileSync(INBOX + name, pdf(lines));
console.log(`${Object.keys(SAMPLES).length} sample invoices written to demo/inbox/`);
