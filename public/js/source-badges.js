export function normalizeSource(source) {
  const s = String(source || 'manual').trim().toLowerCase().replace(/_/g, '-');
  if (s.startsWith('linkedin')) return 'linkedin';
  if (s.startsWith('gmail')) return 'gmail';
  if (['manual', 'greenhouse', 'ashby', 'lever', 'workday'].includes(s)) return s;
  return s || 'manual';
}

export function sourceDisplayLabel(source) {
  const s = normalizeSource(source);
  if (s === 'linkedin') return 'LINKEDIN';
  if (s === 'gmail') return 'GMAIL';
  return s
    .split('-')
    .map(word => word ? word[0].toUpperCase() + word.slice(1) : word)
    .join(' ');
}

export function sourceBadgeCls(source) {
  const s = normalizeSource(source);
  if (s === 'gmail')      return 'bg-rose-50 text-rose-600';
  if (s === 'linkedin')   return 'bg-sky-50 text-sky-600';
  if (s === 'greenhouse') return 'bg-emerald-50 text-emerald-700';
  if (s === 'ashby')      return 'bg-violet-50 text-violet-700';
  if (s === 'lever')      return 'bg-amber-50 text-amber-700';
  if (s === 'workday')    return 'bg-indigo-50 text-indigo-700';
  if (s === 'manual')     return 'bg-slate-100 text-slate-500';
  return 'bg-slate-100 text-slate-600';
}
