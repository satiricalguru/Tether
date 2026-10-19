// Generates the PDF fixtures used by tests/unit/pdf.test.ts.
// Hand-built PDFs with correct xref offsets; run:
//   node --experimental-strip-types tests/fixtures/pdfs/make-fixtures.ts
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = dirname(fileURLToPath(import.meta.url));

type Body = string | Buffer;

/** objects: object bodies, numbered from 1 in output order. */
function buildPdf(
  objects: Body[],
  { root, info, trailerExtra = '' }: { root: number; info?: number; trailerExtra?: string },
): Buffer {
  const header = Buffer.from('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n', 'latin1');
  const chunks: Buffer[] = [header];
  let offset = header.length;
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    const head = Buffer.from(`${i + 1} 0 obj\n`, 'latin1');
    const b = Buffer.isBuffer(body) ? body : Buffer.from(body, 'latin1');
    const tail = Buffer.from('\nendobj\n', 'latin1');
    offsets.push(offset);
    chunks.push(head, b, tail);
    offset += head.length + b.length + tail.length;
  });
  const xrefStart = offset;
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) xref += `${String(o).padStart(10, '0')} 00000 n \n`;
  xref += `trailer\n<< /Size ${objects.length + 1} /Root ${root} 0 R${info ? ` /Info ${info} 0 R` : ''}${trailerExtra} >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  chunks.push(Buffer.from(xref, 'latin1'));
  return Buffer.concat(chunks);
}

function stream(content: string): Buffer {
  const data = Buffer.from(content, 'latin1');
  return Buffer.concat([
    Buffer.from(`<< /Length ${data.length} >>\nstream\n`, 'latin1'),
    data,
    Buffer.from('\nendstream', 'latin1'),
  ]);
}

// Text lines: each is drawn on its own baseline.
function textContent(lines: string[]): string {
  let s = 'BT\n/F1 14 Tf\n72 720 Td\n';
  lines.forEach((l, i) => {
    if (i > 0) s += '0 -20 Td\n';
    s += `(${l}) Tj\n`;
  });
  return `${s}ET`;
}

// two-pages.pdf — 1 catalog, 2 pages, 3 page1, 4 page2, 5 font, 6 c1, 7 c2, 8 info
const page1 = textContent([
  'Tether reads documents locally.',
  'This is an extra-',
  'ordinary sentence about the caf\\351.',
]);
const page2 = textContent(['The second page has its own text.', 'Nothing leaves your machine.']);
writeFileSync(
  join(DIR, 'two-pages.pdf'),
  buildPdf(
    [
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 6 0 R >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 7 0 R >>',
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
      stream(page1),
      stream(page2),
      '<< /Title (Tether fixture document) /Producer (make-fixtures.mjs) >>',
    ],
    { root: 1, info: 8 },
  ),
);

// no-text.pdf — a page with only a filled rectangle.
writeFileSync(
  join(DIR, 'no-text.pdf'),
  buildPdf(
    [
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>',
      stream('0.2 0.4 0.8 rg\n100 100 300 200 re f'),
    ],
    { root: 1 },
  ),
);

// corrupt.pdf — not a PDF at all.
writeFileSync(
  join(DIR, 'corrupt.pdf'),
  Buffer.from('this is not a pdf, just garbage bytes \x00\x01\x02', 'latin1'),
);

// encrypted.pdf — Standard security handler, revision 2 (RC4 40-bit), user password "secret".
function rc4(key: Uint8Array, data: Uint8Array): Buffer {
  const S = Array.from({ length: 256 }, (_, i) => i);
  let j = 0;
  for (let i = 0; i < 256; i++) {
    j = (j + S[i]! + key[i % key.length]!) & 255;
    [S[i], S[j]] = [S[j]!, S[i]!];
  }
  const out = Buffer.alloc(data.length);
  let i = 0;
  j = 0;
  for (let k = 0; k < data.length; k++) {
    i = (i + 1) & 255;
    j = (j + S[i]!) & 255;
    [S[i], S[j]] = [S[j]!, S[i]!];
    out[k] = data[k]! ^ S[(S[i]! + S[j]!) & 255]!;
  }
  return out;
}
const md5 = (...parts: Buffer[]): Buffer => createHash('md5').update(Buffer.concat(parts)).digest();
const PAD = Buffer.from('28BF4E5E4E758A4164004E56FFFA01082E2E00B6D0683E802F0CA9FE6453697A', 'hex');
const pad = (pw: string): Buffer => Buffer.concat([Buffer.from(pw, 'latin1'), PAD]).subarray(0, 32);
const permissions = -4; // all permissions
const fileId = Buffer.from('0123456789abcdef0123456789abcdef', 'hex');
const O = rc4(md5(pad('owner')).subarray(0, 5), pad('secret'));
const P = Buffer.alloc(4);
P.writeInt32LE(permissions);
const fileKey = md5(pad('secret'), O, P, fileId).subarray(0, 5);
const U = rc4(fileKey, PAD);
const objKey = (num: number): Buffer =>
  md5(fileKey, Buffer.from([num & 255, (num >> 8) & 255, (num >> 16) & 255, 0, 0])).subarray(0, 10);
const encContent = rc4(objKey(4), Buffer.from(textContent(['Locked text.']), 'latin1'));
writeFileSync(
  join(DIR, 'encrypted.pdf'),
  buildPdf(
    [
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 6 0 R >> >> /Contents 4 0 R >>',
      Buffer.concat([
        Buffer.from(`<< /Length ${encContent.length} >>\nstream\n`, 'latin1'),
        encContent,
        Buffer.from('\nendstream', 'latin1'),
      ]),
      `<< /Filter /Standard /V 1 /R 2 /O <${O.toString('hex')}> /U <${U.toString('hex')}> /P ${permissions} >>`,
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    ],
    {
      root: 1,
      trailerExtra: ` /Encrypt 5 0 R /ID [<${fileId.toString('hex')}> <${fileId.toString('hex')}>]`,
    },
  ),
);
