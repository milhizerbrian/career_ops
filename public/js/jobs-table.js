function atsScore(job) {
  const ats = Number(job?._ats?.score);
  if (Number.isFinite(ats)) return ats;
  const fit = Number(job?.score);
  return Number.isFinite(fit) ? fit * 20 : -1;
}

export function sortJobsBy(jobs, col, dir, statusOrder = []) {
  return [...jobs].sort((a, b) => {
    let av, bv;
    switch (col) {
      case 'company':      av = (a.company  || '').toLowerCase(); bv = (b.company  || '').toLowerCase(); break;
      case 'score':        av = atsScore(a);                       bv = atsScore(b);                       break;
      case 'location':     av = (a.location || '').toLowerCase(); bv = (b.location || '').toLowerCase(); break;
      case 'date_updated': av = a.date_updated || '';             bv = b.date_updated || '';             break;
      case 'date_found':   av = a.date_found   || '';             bv = b.date_found   || '';             break;
      case 'status': {
        const ai = statusOrder.indexOf((a.status || '').toLowerCase());
        const bi = statusOrder.indexOf((b.status || '').toLowerCase());
        av = ai === -1 ? 99 : ai;
        bv = bi === -1 ? 99 : bi;
        break;
      }
      default: return 0;
    }
    if (av === bv) return 0;
    const cmp = av > bv ? 1 : -1;
    return dir === 'asc' ? cmp : -cmp;
  });
}
