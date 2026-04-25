import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';

import { getCachedDashboard } from './lib/cache.mjs';
import { loadJobById } from './lib/data.mjs';
import { generateResume } from './lib/resume-gen.mjs';
import { startWatcher } from './lib/watcher.mjs';

const APP_ROOT = path.dirname(fileURLToPath(import.meta.url));

// Manual .env parsing (no dotenv package)
try {
  const envPath = path.resolve(APP_ROOT, '.env');
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
      const m = line.match(/^([^#=\s][^=]*)=(.*)$/);
      if (m) process.env[m[1].trim()] ??= m[2].trim();
    }
  }
} catch { /* ignore */ }

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);
const PORT = parseInt(process.env.PORT ?? '3000', 10);
const OUTPUT_DIR = path.resolve(APP_ROOT, 'output');

fs.mkdirSync(OUTPUT_DIR, { recursive: true });

// SPA entry
app.get('/', (req, res) => {
  res.sendFile(path.resolve(APP_ROOT, 'public', 'index.html'));
});

// Lightweight jobs list for table rendering (no full report data)
app.get('/api/jobs', (req, res) => {
  try {
    const { jobs } = getCachedDashboard();
    res.json(jobs.map(j => ({
      id: j.id,
      company: j.company || '',
      title: j.title || '',
      score: j.score ?? null,
      status: j.status || '',
      url: j.url || '',
      date_updated: j.date_updated || '',
    })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Full dashboard payload (jobs + profile + build timestamp)
app.get('/api/dashboard', (req, res) => {
  try {
    res.json(getCachedDashboard());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Resume generation — responds immediately; progress comes via socket.io
app.post('/api/create-docs/:id', express.json(), async (req, res) => {
  const jobId = req.params.id;
  try {
    loadJobById(jobId); // validate job exists
  } catch (err) {
    return res.status(404).json({ error: err.message });
  }
  res.json({ started: true, jobId });
  try {
    await generateResume(jobId, io);
  } catch (err) {
    io.emit('progress', { jobId, stage: 'error', status: 'failed', message: err.message });
  }
});

app.use('/output', express.static(OUTPUT_DIR));
app.use(express.static(path.resolve(APP_ROOT, 'public')));

io.on('connection', socket => {
  process.stdout.write(`[socket.io] connected: ${socket.id}\n`);
});

startWatcher();

httpServer.listen(PORT, () => {
  process.stdout.write(`career-ops running at http://localhost:${PORT}\n`);
});
