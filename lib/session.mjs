import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export class SessionStore extends EventEmitter {
  constructor({ dataDir, now = Date.now }) {
    super();
    this.now = now;
    this.file = path.join(dataDir, 'sessions.json');
    this.serverStartedAt = now();
    this.current = null;
    this.history = [];
    fs.mkdirSync(dataDir, { recursive: true });
    if (fs.existsSync(this.file)) {
      const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.history = saved.history ?? [];
      if (saved.current) {
        const previous = saved.current;
        if (!previous.endedAt) {
          previous.endedAt = previous.updatedAt;
          previous.status = 'interrupted';
          previous.phase = 'interrupted';
          if (previous.batch?.status === 'running') Object.assign(previous.batch, { status: 'interrupted', endedAt: previous.endedAt });
          if (previous.inFlight) { previous.unconfirmedSpins = (previous.unconfirmedSpins || 0) + 1; previous.inFlight = false; }
        }
        this.history.unshift(previous);
      }
      this.history = this.history.slice(0, 20);
    }
  }

  start(url) {
    if (this.current) {
      if (!this.current.endedAt) this.close();
      this.history.unshift(this.current);
      this.history = this.history.slice(0, 20);
    }
    const now = this.now();
    this.current = {
      id: randomUUID(), url, title: new URL(url).hostname || 'Juego local',
      startedAt: now, updatedAt: now, endedAt: null,
      status: 'loading', phase: 'Cargando el juego', speed: 1, fastMode: false,
      totalSpins: 0, totalAttempts: 0, unconfirmedSpins: 0, inFlight: false, totalSpinMs: 0, anomalies: 0,
      batch: null, findings: [], events: [], lastError: null,
    };
    this.event('session', 'Sesión iniciada');
  }

  update(patch) {
    if (!this.current || this.current.endedAt) return;
    Object.assign(this.current, patch);
    this.changed();
  }

  event(type, message, detail = null) {
    if (!this.current || this.current.endedAt) return;
    this.current.events.push({ at: this.now(), type, message, detail });
    this.current.events = this.current.events.slice(-300);
    this.changed();
  }

  beginBatch(target) {
    if (!this.current || this.current.endedAt) return;
    this.update({ status: 'running', phase: 'Preparando lote', lastError: null, batch: {
      id: randomUUID(), target, completed: 0, remaining: target,
      startedAt: this.now(), endedAt: null, status: 'running',
    } });
    this.event('batch', `Lote de ${target} tiradas iniciado`);
  }

  attempt() {
    if (!this.current || this.current.endedAt) return;
    this.current.totalAttempts++;
    this.update({ inFlight: true });
  }

  resolvePending({ moved, ms }) {
    const current = this.current;
    if (!current || current.endedAt || !current.inFlight) return;
    current.inFlight = false;
    if (moved) { current.totalSpins++; current.totalSpinMs += ms; }
    else current.unconfirmedSpins++;
    if (current.batch) {
      current.batch.completed++;
      current.batch.remaining = Math.max(0, current.batch.target - current.batch.completed);
    }
    this.event('observation', moved ? 'Tirada pendiente estabilizada y registrada' : 'Intento pendiente estabilizado; movimiento sin confirmar');
  }

  spin(row) {
    const current = this.current;
    if (!current?.batch || current.endedAt) return;
    if (!current.inFlight) current.totalAttempts++;
    current.inFlight = false;
    if (row.moved !== false) { current.totalSpins++; current.totalSpinMs += row.ms; }
    current.batch.completed++;
    current.batch.remaining = Math.max(0, current.batch.target - current.batch.completed);
    if (row.anomalia?.length) current.anomalies++;
    this.event(row.anomalia?.length ? 'anomaly' : 'spin',
      row.anomalia?.length ? `Intento ${current.totalAttempts}: ${row.anomalia.join(', ')}` : `Giro observado ${current.totalSpins} estabilizado`, row);
  }

  finishBatch(status) {
    if (!this.current?.batch || this.current.endedAt) return;
    Object.assign(this.current.batch, { status, endedAt: this.now() });
    this.update({ status: status === 'anomalia' ? 'attention' : status === 'error' ? 'error' : 'ready', phase: status });
    this.event('batch', `Lote finalizado: ${status}`);
    this.flush();
  }

  finding({ title, detail, category = 'observation' }) {
    if (!this.current || this.current.endedAt) throw new Error('Abre un juego antes de registrar descubrimientos.');
    const finding = { id: randomUUID(), at: this.now(), title, detail, category, source: 'Claude' };
    this.current.findings.push(finding);
    this.current.findings = this.current.findings.slice(-100);
    this.event('finding', title);
    this.flush();
    return finding;
  }

  error(error) {
    if (!this.current || this.current.endedAt) return;
    const message = String(error?.message ?? error);
    this.update({ status: 'error', phase: 'Error', lastError: message });
    this.event('error', message);
    this.flush();
  }

  close(status = 'closed') {
    if (!this.current || this.current.endedAt) return;
    if (this.current.batch?.status === 'running') Object.assign(this.current.batch, { status: status === 'closed' ? 'interrupted' : status, endedAt: this.now() });
    if (this.current.inFlight) { this.current.unconfirmedSpins++; this.current.inFlight = false; }
    this.event('session', 'Sesión finalizada');
    this.update({ status, phase: status === 'closed' ? 'Navegador cerrado' : status, endedAt: this.now() });
    this.flush();
  }

  snapshot() {
    const now = this.now();
    const present = session => session ? {
      ...session, elapsedMs: Math.max(0, (session.endedAt ?? now) - session.startedAt),
      averageSpinMs: session.totalSpins ? Math.round(session.totalSpinMs / session.totalSpins) : 0,
    } : null;
    return structuredClone({ version: 1, now, serverStartedAt: this.serverStartedAt,
      current: present(this.current), history: this.history.map(present) });
  }

  changed() {
    if (this.current) this.current.updatedAt = this.now();
    this.emit('change');
    if (!this.flushTimer) this.flushTimer = setTimeout(() => this.flush(), 250).unref();
  }

  flush() {
    clearTimeout(this.flushTimer);
    this.flushTimer = null;
    const temporary = this.file + '.tmp';
    fs.writeFileSync(temporary, JSON.stringify({ current: this.current, history: this.history }));
    fs.renameSync(temporary, this.file);
  }
}
