/**
 * Send test messages to the relay over plain SMTP.
 *   node scripts/send-test.ts [--host 127.0.0.1] [--port 2525] [--from a@b] [--to x@y] [--user u --pass p] [--subject s]
 *                             [--sample plain|rich] [--attach file ...] [--inline image ...] [--name "Display Name"] [--out file.eml]
 * --sample rich sends an HTML report with two embedded (cid:) images, a CSV and a PDF attachment.
 * --attach adds files of your own (any sample). --inline embeds images of your own in the HTML body (cid:).
 * --name sets the From display name.
 * --out writes the MIME message to a file instead of sending it.
 * With the mock Graph server, recipients containing "throttle" or "denied" trigger 429/403.
 */
import nodemailer from 'nodemailer';
import { writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { parseArgs } from 'node:util';
import { crc32, deflateSync } from 'node:zlib';

const { values: a } = parseArgs({
  options: {
    host: { type: 'string', default: '127.0.0.1' },
    port: { type: 'string', default: '2525' },
    from: { type: 'string', default: 'scanner@contoso.com' },
    name: { type: 'string' },
    to: { type: 'string', multiple: true, default: ['someone@contoso.com'] },
    subject: { type: 'string' },
    sample: { type: 'string', default: 'plain' },
    attach: { type: 'string', multiple: true, default: [] },
    inline: { type: 'string', multiple: true, default: [] },
    out: { type: 'string' },
    user: { type: 'string' },
    pass: { type: 'string' },
  },
});

/** Minimal RGB PNG encoder, so the rich sample needs no image files. */
function png(width: number, height: number, pixel: (x: number, y: number) => [number, number, number]): Buffer {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width * 3 + 1);
    for (let x = 0; x < width; x++) raw.set(pixel(x, y), row + 1 + x * 3);
  }
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

/** One-page PDF with a line of text. */
function pdf(text: string): Buffer {
  const stream = `BT /F1 14 Tf 72 720 Td (${text.replace(/[()\\]/g, '\\$&')}) Tj ET`;
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets = objs.map((o, i) => { const at = out.length; out += `${i + 1} 0 obj\n${o}\nendobj\n`; return at; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

function richSample() {
  // Battery-charge chart: green line on a light grid; and a small square logo.
  const load = (x: number) => 60 + 35 * Math.sin(x / 40) + 10 * Math.sin(x / 7);
  const chart = png(480, 160, (x, y) => {
    if (Math.abs(160 - y - load(x)) < 2) return [16, 124, 16];
    return x % 60 === 0 || y % 40 === 0 ? [225, 225, 225] : [250, 250, 250];
  });
  const logo = png(48, 48, (x, y) => (Math.hypot(x - 24, y - 24) < 20 ? [0, 90, 158] : [255, 255, 255]));
  const rows = Array.from({ length: 24 }, (_, h) => `${String(h).padStart(2, '0')}:00,${(load(h * 20) + 20).toFixed(0)},${(230 + Math.sin(h) * 3).toFixed(1)},${(31 + Math.cos(h)).toFixed(1)}`);
  const html = `<!doctype html><html><head><style>td{padding:4px 8px}</style></head><body style="font-family:Segoe UI,Arial">
<span style="display:none">Rack 4 UPS: 2 events in the last 24 hours</span>
<img src="cid:logo@relay" alt="Contoso logo" width="48" height="48">
<h2>Daily UPS report — Rack 4</h2>
<p>Hello team,</p>
<p>The UPS in <b>Rack 4</b> switched to battery <b>twice</b> in the last 24 hours. Battery health is good, but
runtime at the current load is below the 15-minute target. Please review the load on PDU&nbsp;B.</p>
<table border="1" cellspacing="0">
<tr><th>Metric</th><th>Value</th></tr>
<tr><td>Battery charge</td><td>100%</td></tr>
<tr><td>Estimated runtime</td><td>12 min</td></tr>
<tr><td>Load</td><td>68%</td></tr>
<tr><td>Transfers to battery</td><td>2 (03:12, 14:47)</td></tr>
</table>
<p>Load over the last 24 hours:</p>
<p><img src="cid:chart@relay" alt="Load chart, last 24 hours" width="480" height="160"></p>
<ul><li>Full event log attached as CSV.</li><li>Monthly summary attached as PDF.</li></ul>
<p><a href="https://ups-rack4.contoso.local/status">Open the UPS dashboard</a></p>
<p style="color:#888">Sent by UPS Network Management Card 3 · ups-rack4.contoso.local</p>
</body></html>`;
  return {
    subject: 'Daily UPS report — Rack 4',
    html,
    text: 'The UPS in Rack 4 switched to battery twice in the last 24 hours. Estimated runtime 12 min at 68% load.',
    attachments: [
      { filename: 'logo.png', content: logo, contentType: 'image/png', cid: 'logo@relay' },
      { filename: 'load-24h.png', content: chart, contentType: 'image/png', cid: 'chart@relay' },
      { filename: 'ups-rack4-events.csv', content: `time,load_pct,input_v,temp_c\n${rows.join('\n')}\n`, contentType: 'text/csv' },
      { filename: 'ups-rack4-monthly.pdf', content: pdf('UPS Rack 4 - monthly summary (test document)'), contentType: 'application/pdf' },
    ],
  };
}

const sample: { subject?: string; html?: string; text: string; attachments: object[] } =
  a.sample === 'rich' ? richSample() : { text: 'Hello from scripts/send-test.ts', attachments: [] };
if (a.inline.length) {
  const imgs = a.inline.map((path, i) => ({ filename: basename(path), path, cid: `inline${i}@send-test` }));
  const tags = imgs.map((x) => `<p><img src="cid:${x.cid}" alt="${x.filename}" style="max-width:100%"></p>`).join('\n');
  sample.html = sample.html
    ? sample.html.replace('</body>', `<p>Screenshots:</p>\n${tags}\n</body>`)
    : `<html><body><p>${sample.text}</p>\n${tags}\n</body></html>`;
  sample.attachments.push(...imgs);
}
const transport = a.out
  ? nodemailer.createTransport({ streamTransport: true, buffer: true })
  : nodemailer.createTransport({
    host: a.host, port: Number(a.port), secure: false, ignoreTLS: true,
    auth: a.user ? { user: a.user, pass: a.pass ?? '' } : undefined,
  });
try {
  const info = await transport.sendMail({
    from: a.name ? { name: a.name, address: a.from } : a.from,
    to: a.to,
    subject: a.subject ?? sample.subject ?? `Relay test ${new Date().toISOString()}`,
    text: sample.text,
    html: sample.html,
    attachments: [...sample.attachments, ...a.attach.map((path) => ({ filename: basename(path), path }))],
  });
  if (a.out) {
    writeFileSync(a.out, (info as unknown as { message: Buffer }).message);
    console.log(`wrote ${a.out}`);
  } else console.log(info.response);
} catch (e) {
  const err = e as { responseCode?: number; response?: string; message: string };
  console.error(`FAILED ${err.responseCode ?? ''} ${err.response ?? err.message}`);
  process.exitCode = 1;
}
