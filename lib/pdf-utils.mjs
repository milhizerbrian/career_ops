import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs';
import { niceCommand } from './resume-resource-throttle.mjs';

const execFileAsync = promisify(execFile);

const SOFFICE_PATHS = [
  '/Applications/LibreOffice.app/Contents/MacOS/soffice',
  '/usr/local/bin/soffice',
  '/usr/bin/soffice',
];

function findSoffice() {
  if (process.env.RESUME_SOFFICE_PATH) return process.env.RESUME_SOFFICE_PATH;
  for (const p of SOFFICE_PATHS) {
    if (fs.existsSync(p)) return p;
  }
  return 'soffice'; // fall back to PATH
}

/**
 * Convert a DOCX to PDF using LibreOffice headless.
 * Output PDF written to outputDir with same basename as DOCX.
 *
 * @param {string} docxPath - Absolute path to input .docx
 * @param {string} outputDir - Absolute path to output directory
 * @returns {Promise<string>} Absolute path to generated PDF
 */
export async function docxToPdf(docxPath, outputDir) {
  const soffice = findSoffice();
  fs.mkdirSync(outputDir, { recursive: true });

  try {
    const args = [
      '--headless',
      '--convert-to', 'pdf',
      '--outdir', outputDir,
      docxPath,
    ];
    const nice = niceCommand(soffice, args);
    await execFileAsync(nice.command, nice.args);
  } catch (err) {
    throw new Error(`LibreOffice PDF conversion failed: ${err.stderr || err.message}`);
  }

  const basename = path.basename(docxPath, '.docx');
  const pdfPath = path.resolve(outputDir, `${basename}.pdf`);

  if (!fs.existsSync(pdfPath) || fs.statSync(pdfPath).size === 0) {
    throw new Error(`LibreOffice completed but no PDF created: ${pdfPath}`);
  }

  return pdfPath;
}

/**
 * Count pages in a PDF with pdfinfo when available.
 *
 * @param {string} pdfPath - Absolute path to a PDF
 * @returns {Promise<number|null>} Page count, or null if unavailable
 */
export async function getPdfPageCount(pdfPath) {
  try {
    const { stdout } = await execFileAsync('pdfinfo', [pdfPath]);
    const match = stdout.match(/^Pages:\s+(\d+)/m);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

/**
 * Read PDF page geometry and text bounds from Poppler's bbox output.
 *
 * @param {string} pdfPath - Absolute path to a PDF
 * @returns {Promise<Array<{ width: number, height: number, wordCount: number, contentBottom: number|null, fillRatio: number|null }>>}
 */
export async function getPdfPageMetrics(pdfPath) {
  const { stdout } = await execFileAsync('pdftotext', ['-bbox', pdfPath, '-']);
  const pages = [];
  for (const pageMatch of stdout.matchAll(/<page width="([^"]+)" height="([^"]+)">([\s\S]*?)<\/page>/g)) {
    const width = Number(pageMatch[1]);
    const height = Number(pageMatch[2]);
    const body = pageMatch[3];
    const bottoms = [...body.matchAll(/<word\b[^>]*\byMax="([^"]+)"/g)].map(match => Number(match[1]));
    const contentBottom = bottoms.length ? Math.max(...bottoms) : null;
    pages.push({
      width,
      height,
      wordCount: bottoms.length,
      contentBottom,
      fillRatio: contentBottom && height ? Number((contentBottom / height).toFixed(4)) : null,
    });
  }
  return pages;
}
