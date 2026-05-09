import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { patchDocXml, patchDocXmlSdt, xmlEscape } from '../lib/docx-utils.mjs';

describe('xmlEscape', () => {
  it('escapes ampersands', () => {
    assert.equal(xmlEscape('A & B'), 'A &amp; B');
  });
  it('escapes angle brackets', () => {
    assert.equal(xmlEscape('<tag>'), '&lt;tag&gt;');
  });
  it('handles null/undefined', () => {
    assert.equal(xmlEscape(null), '');
    assert.equal(xmlEscape(undefined), '');
  });
});

describe('patchDocXml — simple replacements', () => {
  it('replaces a simple placeholder', () => {
    const { docXml, unreplaced } = patchDocXml('<w:t>[summary]</w:t>', { summary: 'Hello' });
    assert.equal(docXml, '<w:t>Hello</w:t>');
    assert.deepEqual(unreplaced, []);
  });

  it('XML-escapes replacement values', () => {
    const { docXml } = patchDocXml('<w:t>[name]</w:t>', { name: 'A & B <Test>' });
    assert.equal(docXml, '<w:t>A &amp; B &lt;Test&gt;</w:t>');
  });

  it('reports unknown placeholders and leaves them unchanged', () => {
    const { docXml, unreplaced } = patchDocXml('<w:t>[missing key]</w:t>', {});
    assert.equal(docXml, '<w:t>[missing key]</w:t>');
    assert.deepEqual(unreplaced, ['[missing key]']);
  });

  it('is case-insensitive for key matching', () => {
    const { docXml } = patchDocXml('<w:t>[SUMMARY]</w:t>', { summary: 'lower' });
    assert.equal(docXml, '<w:t>lower</w:t>');
  });
});

describe('patchDocXml — fragmented XML runs', () => {
  it('replaces a placeholder with embedded XML tags', () => {
    // Word inserts <w:rPr/> inside the text span
    const xml = '<w:t>[summ<w:rPr/>ary]</w:t>';
    const { docXml } = patchDocXml(xml, { summary: 'My Summary' });
    assert.equal(docXml, '<w:t>My Summary</w:t>');
  });

  it('replaces multiple placeholders in one document', () => {
    const xml = '<w:t>[title]</w:t><w:t>[company]</w:t>';
    const { docXml } = patchDocXml(xml, { title: 'Senior CSM', company: 'Acme' });
    assert.equal(docXml, '<w:t>Senior CSM</w:t><w:t>Acme</w:t>');
  });

  it('deduplicates unreplaced entries', () => {
    const xml = '<w:t>[missing]</w:t><w:t>[missing]</w:t>';
    const { unreplaced } = patchDocXml(xml, {});
    assert.equal(unreplaced.length, 1);
    assert.equal(unreplaced[0], '[missing]');
  });
});

describe('patchDocXml — edge cases', () => {
  it('passes through XML with no placeholders unchanged', () => {
    const xml = '<w:t>No placeholders here</w:t>';
    const { docXml, unreplaced } = patchDocXml(xml, {});
    assert.equal(docXml, xml);
    assert.deepEqual(unreplaced, []);
  });
});

// ── SDT helpers ────────────────────────────────────────────────────────────────

function sdt(tagVal, textContent) {
  return `<w:sdt><w:sdtPr><w:tag w:val="${tagVal}"/></w:sdtPr><w:sdtContent><w:p><w:r><w:t>${textContent}</w:t></w:r></w:p></w:sdtContent></w:sdt>`;
}

describe('patchDocXmlSdt — simple replacements', () => {
  it('replaces text inside a matching SDT tag', () => {
    const xml = sdt('PROFESSIONAL_SUMMARY', 'Click or tap here to enter text.');
    const { docXml, unreplaced } = patchDocXmlSdt(xml, { PROFESSIONAL_SUMMARY: 'Strategic CSM with 25 years.' });
    assert.ok(docXml.includes('<w:t>Strategic CSM with 25 years.</w:t>'));
    assert.deepEqual(unreplaced, []);
  });

  it('XML-escapes replacement values', () => {
    const xml = sdt('TITLE_LINE', 'placeholder');
    const { docXml } = patchDocXmlSdt(xml, { TITLE_LINE: 'CSM & Security <Expert>' });
    assert.ok(docXml.includes('CSM &amp; Security &lt;Expert&gt;'));
  });

  it('leaves unmatched SDTs unchanged and reports them', () => {
    const xml = sdt('MISSING_FIELD', 'Click or tap here to enter text.');
    const { docXml, unreplaced } = patchDocXmlSdt(xml, {});
    assert.ok(docXml.includes('Click or tap here to enter text.'));
    assert.deepEqual(unreplaced, ['MISSING_FIELD']);
  });

  it('replaces multiple SDTs in one document', () => {
    const xml = sdt('TITLE_LINE', 'placeholder') + sdt('PROFESSIONAL_SUMMARY', 'placeholder');
    const { docXml, unreplaced } = patchDocXmlSdt(xml, {
      TITLE_LINE: 'Senior CSM',
      PROFESSIONAL_SUMMARY: 'Experienced leader.',
    });
    assert.ok(docXml.includes('<w:t>Senior CSM</w:t>'));
    assert.ok(docXml.includes('<w:t>Experienced leader.</w:t>'));
    assert.deepEqual(unreplaced, []);
  });

  it('deduplicates unreplaced entries', () => {
    const xml = sdt('MISSING', 'x') + sdt('MISSING', 'x');
    const { unreplaced } = patchDocXmlSdt(xml, {});
    assert.equal(unreplaced.length, 1);
  });

  it('does not touch SDTs that have no replacements supplied', () => {
    const xml = sdt('KEEP_ME', 'original text') + sdt('REPLACE_ME', 'old');
    const { docXml } = patchDocXmlSdt(xml, { REPLACE_ME: 'new' });
    assert.ok(docXml.includes('original text'));
    assert.ok(docXml.includes('<w:t>new</w:t>'));
  });
});
