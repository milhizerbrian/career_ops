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
 * Resolve DOCX template path.
 * Checks RESUME_DOCX_TEMPLATE_PATH env first, then data/ relative to app root.
 */
export function resolveTemplatePath() {
  if (process.env.RESUME_DOCX_TEMPLATE_PATH) {
    const p = path.resolve(process.env.RESUME_DOCX_TEMPLATE_PATH);
    if (!fs.existsSync(p)) throw new Error(`RESUME_DOCX_TEMPLATE_PATH not found: ${p}`);
    return p;
  }
  const p = path.resolve(APP_ROOT, 'data', 'Brian_Milhizer_template_CSM-FINAL-clean.docx');
  if (!fs.existsSync(p)) throw new Error(`Template not found: ${p}`);
  return p;
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
 * Patch a DOCX template with AI-generated replacement values and write output.
 *
 * @param {string} templatePath - Absolute path to .docx template
 * @param {Record<string, string>} replacements - placeholder key → value
 * @param {string} outputPath - Absolute path for output .docx
 * @returns {{ unreplaced: string[] }}
 */
export function patchDocx(templatePath, replacements, outputPath) {
  const content = fs.readFileSync(templatePath);
  const zip = new PizZip(content);

  const docXmlFile = zip.file('word/document.xml');
  if (!docXmlFile) throw new Error(`Template missing word/document.xml: ${templatePath}`);

  const { docXml, unreplaced } = patchDocXml(docXmlFile.asText(), replacements);
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
