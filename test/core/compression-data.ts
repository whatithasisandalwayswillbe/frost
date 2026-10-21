// Generated files shared by compression and backup/restore tests.
import { crc32, deflateSync, gzipSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { random } from '../support.js';

const { writeZip } = await import(new URL('../../../tools/archives.mjs', import.meta.url).href);

// A complete PDF with byte offsets, metadata and optional Flate streams.
function pdf(compressed: boolean): Buffer {
  const pages = 48;
  const objects: Buffer[] = [
    Buffer.from('<< /Type /Catalog /Pages 2 0 R >>'),
    Buffer.from(
      `<< /Type /Pages /Count ${pages} /Kids [${Array.from({ length: pages }, (_, i) => `${4 + i * 2} 0 R`).join(' ')}] >>`,
    ),
    Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'),
  ];
  for (let page = 0; page < pages; page++) {
    objects.push(
      Buffer.from(
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + page * 2} 0 R >>`,
      ),
    );
    const content = Buffer.from(
      `BT /F1 10 Tf 40 750 Td 12 TL\n${Array.from({ length: 48 }, (_, line) => `(Document page ${page + 1}, line ${line + 1}: original text, numbers ${page * 97 + line}, and spacing.) Tj T*`).join('\n')}\nET\n`,
    );
    const stream = compressed ? deflateSync(content) : content;
    objects.push(
      Buffer.concat([
        Buffer.from(`<< /Length ${stream.length}${compressed ? ' /Filter /FlateDecode' : ''} >>\nstream\n`),
        stream,
        Buffer.from('\nendstream'),
      ]),
    );
  }
  objects.push(
    Buffer.from('<< /Title (Original document) /Author (Test author) /Subject (Preserve metadata and byte offsets) >>'),
  );
  const parts = [Buffer.from('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
  const offsets = [0];
  let offset = parts[0].length;
  for (let i = 0; i < objects.length; i++) {
    const part = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`), objects[i], Buffer.from('\nendobj\n')]);
    offsets.push(offset);
    parts.push(part);
    offset += part.length;
  }
  parts.push(
    Buffer.from(
      `xref\n0 ${offsets.length}\n0000000000 65535 f \n${offsets
        .slice(1)
        .map(value => `${String(value).padStart(10, '0')} 00000 n \n`)
        .join(
          '',
        )}trailer\n<< /Size ${offsets.length} /Root 1 0 R /Info ${objects.length} 0 R >>\nstartxref\n${offset}\n%%EOF\n`,
    ),
  );
  return Buffer.concat(parts);
}

export function compressionData(): Map<string, Buffer> {
  const text = Buffer.from(
    Array.from({ length: 6000 }, (_, i) => `function item${i}(value) { return value + ${i % 97}; }\n`).join(''),
  );
  const json = Buffer.from(
    JSON.stringify(
      Array.from({ length: 6000 }, (_, i) => ({
        path: `/documents/project-${i % 20}/file-${i}.txt`,
        size: i * 29,
        mode: 420,
        modified: 1728000000 + i,
      })),
    ),
  );
  const csv = Buffer.from(
    Array.from(
      { length: 12000 },
      (_, i) => `${i},${i % 97},${(i * 1.23456).toFixed(4)},person${i % 130}@example.test\n`,
    ).join(''),
  );
  const unicode = '雪と氷, neige et glace, лёд, 눈과 얼음, gelo, hielo.\n'.repeat(2000);
  const code = readFileSync(new URL('../../src/core/manifest.js', import.meta.url));
  const codeBundle = Buffer.concat([
    code,
    ...['core/storage', 'core/config', 'engine/backup', 'platform/fs-root-windows'].map(file =>
      readFileSync(new URL(`../../src/${file}.js`, import.meta.url)),
    ),
  ]);
  const typescript = Buffer.from(
    Array.from(
      { length: 200 },
      (_, i) =>
        `export interface Record${i} { id: string; name: string; values: number[]; }\nexport function get${i}(items: Map<string, Record${i}>, id: string): Record${i} | undefined {\n  return items.get(id);\n}\n`,
    ).join('\n'),
  );
  const python = Buffer.from(
    Array.from(
      { length: 300 },
      (_, i) =>
        `def item_${i}(records, key):\n    """Keep the exact source, including whitespace."""\n    result = records.get(key, {})\n    return {"id": ${i}, "value": result.get("value", ${i % 97})}\n\n`,
    ).join(''),
  );
  const cpp = Buffer.from(
    Array.from(
      { length: 300 },
      (_, i) =>
        `template <typename T>\nT item${i}(const std::vector<T>& values, std::size_t index) {\n    if (index >= values.size()) { return T{}; }\n    return values[index] + ${i % 97};\n}\n\n`,
    ).join(''),
  );
  const markdown = Buffer.from(
    Array.from(
      { length: 300 },
      (_, i) =>
        `## Section ${i + 1}\n\nA document with **formatting**, [links](https://example.test/${i}), and exact whitespace.\n\n- Item ${i % 17}\n- A second item\n\n\`code(${i})\`\n\n`,
    ).join(''),
  );
  const xml = Buffer.from(
    `<?xml version="1.0" encoding="UTF-8"?>\n<records>\n${Array.from({ length: 4000 }, (_, i) => `  <record id="${i}" group="${i % 23}"><name>Item ${i}</name><value>${i * 17}</value></record>`).join('\n')}\n</records>\n`,
  );
  const svg = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024">${Array.from({ length: 2000 }, (_, i) => `<rect x="${i % 100}" y="${Math.floor(i / 100)}" width="10" height="10" fill="#${(i * 173).toString(16).padStart(6, '0')}"/>`).join('')}</svg>`,
  );
  const html = Buffer.from(
    `<!doctype html>\n<html lang="en"><meta charset="utf-8"><title>Original page</title><body>${Array.from({ length: 1500 }, (_, i) => `<article id="item-${i}"><h2>Item ${i}</h2><p>Exact text and whitespace with an <a href="/items/${i}">original link</a>.</p></article>\n`).join('')}</body></html>`,
  );
  const sql = Buffer.from(
    Array.from(
      { length: 6000 },
      (_, i) => `INSERT INTO records (id, name, group_id, enabled) VALUES (${i}, 'Item ${i}', ${i % 17}, ${i % 2});\n`,
    ).join(''),
  );
  const docx = writeZip([
    {
      name: '[Content_Types].xml',
      mode: 0o644,
      data: Buffer.from(
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
      ),
    },
    {
      name: '_rels/.rels',
      mode: 0o644,
      data: Buffer.from(
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
      ),
    },
    {
      name: 'word/document.xml',
      mode: 0o644,
      data: Buffer.from(
        `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${Array.from({ length: 1500 }, (_, i) => `<w:p><w:r><w:t xml:space="preserve">Original paragraph ${i}, number ${i * 97}. Preserve all bytes.</w:t></w:r></w:p>`).join('')}<w:sectPr/></w:body></w:document>`,
      ),
    },
  ]) as Buffer;
  const zip = writeZip([
    // Keep this ratio sample fixed. Changes to error wording in the live source can change which
    // compression strategy wins, even though neither the codec nor its compatibility changed.
    {
      name: 'source.js',
      mode: 0o644,
      data: readFileSync(new URL('../../../test/copy/manifest-compression.fixture', import.meta.url)),
    },
    { name: 'data.xml', mode: 0o644, data: xml },
  ]) as Buffer;

  const width = 1024,
    height = 1024,
    stride = width * 3;
  const pixels = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const offset = y * stride + x * 3;
      pixels[offset] = x & 255;
      pixels[offset + 1] = y & 255;
      pixels[offset + 2] = (x + y) & 255;
    }

  const header = Buffer.alloc(54);
  header.write('BM');
  header.writeUInt32LE(header.length + pixels.length, 2);
  header.writeUInt32LE(header.length, 10);
  header.writeUInt32LE(40, 14);
  header.writeInt32LE(width, 18);
  header.writeInt32LE(height, 22);
  header.writeUInt16LE(1, 26);
  header.writeUInt16LE(24, 28);
  header.writeUInt32LE(pixels.length, 34);
  const bmp = Buffer.concat([header, pixels]);

  const pngChunk = (type: string, data: Buffer): Buffer => {
    const chunk = Buffer.alloc(data.length + 12);
    chunk.writeUInt32BE(data.length);
    chunk.write(type, 4);
    data.copy(chunk, 8);
    chunk.writeUInt32BE(crc32(chunk.subarray(4, -4)), chunk.length - 4);
    return chunk;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const scanlines = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) pixels.copy(scanlines, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  const png = Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    pngChunk('IHDR', ihdr),
    pngChunk('tEXt', Buffer.from('Comment\0preserve every original byte')),
    pngChunk('IDAT', deflateSync(scanlines)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);

  const repeated = random(768 << 10);
  const largeRepeated = random(3 << 20, 246813579);
  return new Map([
    ['empty', Buffer.alloc(0)],
    ['tiny', Buffer.from('hello')],
    ['source', text],
    ['code-js', code],
    ['code-short', code.subarray(0, 4096)],
    ['code-bundle', codeBundle],
    ['code-worker', Buffer.concat(Array.from({ length: 8 }, () => codeBundle))],
    ['code-ts', typescript],
    ['code-python', python],
    ['code-cpp', cpp],
    ['markdown', markdown],
    ['xml', xml],
    ['svg', svg],
    ['html', html],
    ['sql', sql],
    ['pdf', pdf(false)],
    ['pdf-flate', pdf(true)],
    ['docx', docx],
    ['zip', zip],
    ['json', json],
    ['csv', csv],
    ['utf8', Buffer.from(unicode)],
    ['utf16', Buffer.from(unicode, 'utf16le')],
    ['bmp', bmp],
    ['png', png],
    ['wav', readFileSync(new URL('../../assets/sfx/explosion.wav', import.meta.url))],
    ['gzip', gzipSync(text)],
    ['random', random(1 << 20)],
    ['random-small', random(32 << 10)],
    ['distant-text', Buffer.concat([text, random(768 << 10), text])],
    ['distant-binary', Buffer.concat([repeated, random(256 << 10, 987654321), repeated])],
    ['distant-max', Buffer.concat([largeRepeated, random(2 << 20, 987654321), largeRepeated])],
  ]);
}
