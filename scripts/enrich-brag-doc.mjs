#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const DEFAULT_BRAG = path.resolve(APP_ROOT, 'data', 'master-brag-document.md');

function argValue(name, fallback = '') {
  const idx = process.argv.indexOf(name);
  return idx >= 0 && process.argv[idx + 1] ? process.argv[idx + 1] : fallback;
}

function collectRoleSections(markdown) {
  const sections = [];
  const experienceStart = markdown.search(/^##\s+Experience Details\b/m);
  const certStart = markdown.search(/^##\s+Certifications\b/m);
  const scope = markdown.slice(
    experienceStart >= 0 ? experienceStart : 0,
    certStart >= 0 ? certStart : markdown.length
  );
  const headingRe = /^###\s+(.+)$/gm;
  const matches = [...scope.matchAll(headingRe)].filter((match) => match[1].includes('—'));
  for (let i = 0; i < matches.length; i++) {
    const start = matches[i].index;
    const end = matches[i + 1]?.index ?? scope.length;
    sections.push({
      title: matches[i][1].trim(),
      body: scope.slice(start, end),
    });
  }
  return sections;
}

function collectBullets(sectionBody) {
  const bulletBlock = sectionBody.match(/\*\*Bullets:\*\*([\s\S]*?)(?=\n---|\n###|\n##|\n\*\*Key Metrics:\*\*|$)/i)?.[1] ?? '';
  return bulletBlock
    .split('\n')
    .map((line) => line.match(/^\s*-\s+(.+)$/)?.[1]?.trim())
    .filter(Boolean);
}

function countMatches(text, patterns) {
  const found = new Set();
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) found.add(match[0].toLowerCase());
  }
  return found.size;
}

function shorthandIssues(bullet) {
  const issues = [];
  if (/^(managed|owned|supported|advised|maintained|partnered|worked|helped|drove)\b/i.test(bullet)) {
    issues.push('hedged or generic opening verb');
  }
  if (/\b(by optimizing|through engagement|via adoption|by leveraging|supported customers|managed accounts)\b/i.test(bullet)) {
    issues.push('generic mechanism');
  }
  if (/\bacross\s+[^.]+,\s+[^.]+,\s+(and\s+)?[^.]+/i.test(bullet) && !/\$|\d+%|Fortune|top-\d+|CISO|VP/i.test(bullet)) {
    issues.push('unspecific enumeration');
  }
  if (!/\$[\d,.]+[MBK]?|\d+%|\d+\+?x|\b\d+\s*(accounts?|customers?|clients?|ARR|NPS|CSAT)\b/i.test(bullet)) {
    issues.push('missing metric or scope proof');
  }
  return issues;
}

function analyzeRole(section) {
  const text = section.body;
  const bullets = collectBullets(text);
  const namedAccountCount = countMatches(text, [
    /\btop-\d+\b/gi,
    /\bFortune\s+\d+\b/gi,
    /\bregional\s+[a-z]+/gi,
    /\bnational\s+[a-z]+/gi,
    /\bleading\s+[a-z]+/gi,
  ]);
  const namedUseCaseCount = countMatches(text, [
    /\bransomware\b/gi,
    /\beast-west\b/gi,
    /\bMITRE\b/gi,
    /\bMTTR\b/gi,
    /\bplaybooks?\b/gi,
    /\bcloud security onboarding\b/gi,
    /\bthreat detection\b/gi,
  ]);
  const namedMechanismCount = countMatches(text, [
    /\bmaturity model\b/gi,
    /\bframework\b/gi,
    /\bcadence\b/gi,
    /\bQBR\b/gi,
    /\brecovery planning\b/gi,
    /\bstakeholder realignment\b/gi,
    /\bsuccess planning\b/gi,
  ]);
  const shorthand = bullets
    .map((bullet) => ({ bullet, issues: shorthandIssues(bullet) }))
    .filter((item) => item.issues.length);

  return {
    title: section.title,
    bulletCount: bullets.length,
    namedAccountCount,
    namedUseCaseCount,
    namedMechanismCount,
    shorthand,
  };
}

function renderReport(results, bragPath) {
  const lines = [
    '# Brag Doc Enrichment Report',
    '',
    `Source: ${bragPath}`,
    `Generated: ${new Date().toISOString()}`,
    '',
  ];

  for (const result of results) {
    lines.push(`## ${result.title}`);
    lines.push('');
    lines.push(`- Bullets: ${result.bulletCount}`);
    lines.push(`- Named account signals: ${result.namedAccountCount}`);
    lines.push(`- Named use-case signals: ${result.namedUseCaseCount}`);
    lines.push(`- Named mechanism signals: ${result.namedMechanismCount}`);
    if (result.shorthand.length) {
      lines.push('- Shorthand bullets to enrich:');
      for (const item of result.shorthand) {
        lines.push(`  - ${item.bullet}`);
        lines.push(`    - Issues: ${item.issues.join(', ')}`);
      }
    } else {
      lines.push('- Shorthand bullets to enrich: none detected');
    }
    lines.push('');
  }

  return `${lines.join('\n')}\n`;
}

function main() {
  const bragPath = path.resolve(argValue('--brag', DEFAULT_BRAG));
  const outPath = argValue('--out');
  if (!fs.existsSync(bragPath)) {
    process.stderr.write(`Brag doc not found: ${bragPath}\n`);
    process.exit(1);
  }

  const markdown = fs.readFileSync(bragPath, 'utf8');
  const results = collectRoleSections(markdown).map(analyzeRole);
  const report = renderReport(results, bragPath);

  if (outPath) {
    fs.writeFileSync(path.resolve(outPath), report);
  } else {
    process.stdout.write(report);
  }
}

main();
