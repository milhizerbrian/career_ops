import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import PizZip from 'pizzip';

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** XML-escape a string for safe insertion into Word XML. */
export function xmlEscape(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Strip all XML tags from a string, returning only text content. */
function stripXmlTags(str) {
  return str.replace(/<[^>]*>/g, '');
}

/**
 * Find and replace all bracket placeholders in raw Word XML.
 * Handles placeholders split across <w:r> runs by matching the
 * bracket-delimited pattern inclusive of interspersed XML tags.
 *
 * @param {string} docXml - Raw word/document.xml string
 * @param {Record<string, string>} replacements - placeholder key → value
 * @returns {{ docXml: string, unreplaced: string[] }}
 */
export function patchDocXml(docXml, replacements) {
  const normalized = Object.fromEntries(
    Object.entries(replacements).map(([k, v]) => [
      k.toLowerCase().replace(/^\[|\]$/g, '').trim(),
      v,
    ])
  );

  const unreplaced = [];
  const BRACKET_RE = /\[(?:[^\[\]<>]|<[^>]*>)*\]/g;

  const patched = docXml.replace(BRACKET_RE, (match) => {
    const key = stripXmlTags(match).slice(1, -1).trim().toLowerCase();
    if (key in normalized) return xmlEscape(normalized[key]);
    const displayKey = `[${stripXmlTags(match).slice(1, -1).trim()}]`;
    if (!unreplaced.includes(displayKey)) unreplaced.push(displayKey);
    return match;
  });

  return { docXml: patched, unreplaced };
}

/**
 * Replace content inside Word SDT (Structured Document Tag) content controls
 * by matching each <w:sdt>'s <w:tag w:val="KEY"/> against the replacements map.
 *
 * @param {string} docXml - Raw word/document.xml string
 * @param {Record<string, string>} replacements - SDT tag name → replacement text
 * @returns {{ docXml: string, unreplaced: string[] }}
 */
export function patchDocXmlSdt(docXml, replacements) {
  const unreplaced = [];

  const patched = docXml.replace(
    /(<w:sdt\b[^>]*>)([\s\S]*?)(<\/w:sdt>)/g,
    (fullMatch, open, inner, close) => {
      const tagMatch = inner.match(/<w:tag\s+w:val="([^"]+)"/);
      if (!tagMatch) return fullMatch;

      const key = tagMatch[1];
      if (!(key in replacements)) {
        if (!unreplaced.includes(key)) unreplaced.push(key);
        return fullMatch;
      }

      const value = xmlEscape(replacements[key]);
      const newInner = inner.replace(
        /(<w:sdtContent\b[^>]*>)([\s\S]*?)(<\/w:sdtContent>)/,
        (_, sdtOpen, sdtInner, sdtClose) => {
          let first = true;
          const replaced = sdtInner.replace(/<w:t[^>]*>[\s\S]*?<\/w:t>/g, () => {
            if (first) { first = false; return `<w:t>${value}</w:t>`; }
            return '';
          });
          return `${sdtOpen}${replaced}${sdtClose}`;
        }
      );
      return `${open}${newInner}${close}`;
    }
  );

  return { docXml: patched, unreplaced };
}

/**
 * Extract SDT tag names from a DOCX/DOTX template.
 * Returns the list of w:tag values found in word/document.xml.
 */
export function listTemplateSdtTags(templatePath) {
  const content = fs.readFileSync(templatePath);
  const zip = new PizZip(content);
  const docXml = zip.file('word/document.xml')?.asText() ?? '';
  const tags = [];
  for (const match of docXml.matchAll(/<w:tag\s+w:val="([^"]+)"/g)) {
    if (!tags.includes(match[1])) tags.push(match[1]);
  }
  return tags;
}

/**
 * Resolve DOCX template path.
 * Checks RESUME_DOCX_TEMPLATE_PATH env first, then prefers the production
 * .dotx (SDT-based) template, falling back to the legacy .docx template.
 */
export function resolveTemplatePath() {
  if (process.env.RESUME_DOCX_TEMPLATE_PATH) {
    const p = path.resolve(process.env.RESUME_DOCX_TEMPLATE_PATH);
    if (!fs.existsSync(p)) throw new Error(`RESUME_DOCX_TEMPLATE_PATH not found: ${p}`);
    return p;
  }
  const preferred = path.resolve(APP_ROOT, 'data', 'FINAL Brian Milhizer Production Resume Template v2.dotx');
  if (fs.existsSync(preferred)) return preferred;
  const v1 = path.resolve(APP_ROOT, 'data', 'FINAL Brian Milhizer Production Resume Template.dotx');
  if (fs.existsSync(v1)) return v1;
  const legacy = path.resolve(APP_ROOT, 'data', 'Brian_Milhizer_template_CSM-FINAL-clean.docx');
  if (fs.existsSync(legacy)) return legacy;
  throw new Error(`No resume template found in data/`);
}

/**
 * Extract all unique bracket placeholder keys from a DOCX template.
 * Use this to verify the synthesis prompt matches the template before first run.
 */
export function listTemplatePlaceholders(templatePath) {
  const content = fs.readFileSync(templatePath);
  const zip = new PizZip(content);
  const docXml = zip.file('word/document.xml')?.asText() ?? '';
  const BRACKET_RE = /\[(?:[^\[\]<>]|<[^>]*>)*\]/g;
  const keys = new Set();
  for (const match of docXml.matchAll(BRACKET_RE)) {
    const key = stripXmlTags(match[0]).slice(1, -1).trim();
    if (key.length >= 5) keys.add(key);
  }
  return [...keys];
}

/**
 * Return the list of fillable fields from a template.
 * For SDT templates: returns w:tag names. For bracket templates: returns placeholder keys.
 */
export function listTemplateFields(templatePath) {
  const content = fs.readFileSync(templatePath);
  const zip = new PizZip(content);
  const docXml = zip.file('word/document.xml')?.asText() ?? '';
  if (/<w:tag\s+w:val="/.test(docXml)) {
    const tags = [];
    for (const match of docXml.matchAll(/<w:tag\s+w:val="([^"]+)"/g)) {
      if (!tags.includes(match[1])) tags.push(match[1]);
    }
    return tags;
  }
  // Bracket placeholders fallback
  const BRACKET_RE = /\[(?:[^\[\]<>]|<[^>]*>)*\]/g;
  const keys = new Set();
  for (const match of docXml.matchAll(BRACKET_RE)) {
    const key = stripXmlTags(match[0]).slice(1, -1).trim();
    if (key.length >= 5) keys.add(key);
  }
  return [...keys];
}

/**
 * Patch a DOCX template with AI-generated replacement values and write output.
 * Auto-detects SDT content controls vs bracket placeholders based on template content.
 *
 * @param {string} templatePath - Absolute path to .docx/.dotx template
 * @param {Record<string, string>} replacements - field name → value
 * @param {string} outputPath - Absolute path for output .docx
 * @returns {{ unreplaced: string[] }}
 */
export function patchDocx(templatePath, replacements, outputPath) {
  const content = fs.readFileSync(templatePath);
  const zip = new PizZip(content);

  const docXmlFile = zip.file('word/document.xml');
  if (!docXmlFile) throw new Error(`Template missing word/document.xml: ${templatePath}`);

  const rawXml = docXmlFile.asText();
  const hasSdts = /<w:tag\s+w:val="/.test(rawXml);
  const { docXml, unreplaced } = hasSdts
    ? patchDocXmlSdt(rawXml, replacements)
    : patchDocXml(rawXml, replacements);
  zip.file('word/document.xml', docXml);

  // Fix content type: .dotx template → .docx document
  const ctFile = zip.file('[Content_Types].xml');
  if (ctFile) {
    zip.file(
      '[Content_Types].xml',
      ctFile.asText().replace(
        'wordprocessingml.template.main+xml',
        'wordprocessingml.document.main+xml'
      )
    );
  }

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, zip.generate({ type: 'nodebuffer' }));

  if (unreplaced.length) {
    process.stderr.write(`[docx-utils] Unreplaced placeholders: ${JSON.stringify(unreplaced)}\n`);
  }

  return { unreplaced };
}
