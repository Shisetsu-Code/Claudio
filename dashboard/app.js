const $ = id => document.getElementById(id);
const labels = { loading: 'CARGANDO', ready: 'LISTO', running: 'EN CURSO', attention: 'REVISAR', error: 'ERROR', closed: 'CERRADO', interrupted: 'INTERRUMPIDO' };
const phases = { completed: 'Lote completado', time_budget: 'Presupuesto de tiempo agotado · puedes continuar', anomalia: 'Detenido por señal visual', cancelled: 'Detenido por solicitud', error: 'Error en el lote' };
let snapshot = null;
let receivedAt = 0;
let selected = 'current';
function duration(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return [Math.floor(s / 3600), Math.floor(s % 3600 / 60), s % 60].map(n => String(n).padStart(2, '0')).join(':');
}
function time(value) { return new Date(value).toLocaleTimeString('es-AR', { hour12: false }); }
function current() { return selected === 'current' ? snapshot?.current : snapshot?.history.find(s => s.id === selected); }
function renderClock() {
  const s = current();
  const live = s && !s.endedAt && selected === 'current';
  $('elapsed').textContent = s ? duration(s.elapsedMs + (live ? Date.now() - receivedAt : 0)) : '00:00:00';
}
function render() {
  const s = current();
  $('status').textContent = s ? labels[s.status] || s.status : 'SIN SESIÓN';
  $('status').className = 'badge ' + (s?.status || '');
  $('game').textContent = s?.title || 'Esperando al juego';
  $('url').textContent = s?.url || 'Abre un juego desde Claude para empezar el seguimiento.';
  $('spins').textContent = s?.totalSpins ?? 0;
  $('attempts').textContent = (s?.totalAttempts || 0) + ' intentos · ' + (s?.unconfirmedSpins || 0) + ' sin confirmar' + (s?.inFlight ? ' · 1 en curso' : '');
  $('speed').textContent = (s?.speed || 1) + '×';
  $('fast').textContent = s?.fastMode ? 'Observación rápida activada' : 'Ritmo de observación normal';
  $('anomalies').textContent = s?.anomalies ?? 0;
  $('average').textContent = s?.totalSpins ? (s.averageSpinMs / 1000).toFixed(2) + ' s por tirada · promedio' : 'Todavía no hay tiradas';
  $('started').textContent = s ? 'Inicio ' + time(s.startedAt) + ' · tiempo real' : 'Tiempo real · sin acelerar';
  const batch = s?.batch;
  const percent = batch?.target ? Math.round(batch.completed / batch.target * 100) : 0;
  $('completed').replaceChildren(document.createTextNode((batch?.completed ?? 0) + ' '));
  const target = document.createElement('span'); target.textContent = '/ ' + (batch?.target ?? 0) + ' intentos'; $('completed').append(target);
  $('percent').textContent = percent + '%';
  $('progress').max = batch?.target || 1; $('progress').value = batch?.completed || 0;
  $('phase').textContent = phases[s?.phase] || s?.phase || 'Listo para observar';
  $('remaining').textContent = batch ? batch.remaining + ' pendientes' : '—';
  $('batch-status').textContent = batch ? (batch.status === 'running' ? 'EN CURSO' : 'FINALIZADO') : 'Sin lote';
  $('error').hidden = !s?.lastError; $('error').textContent = s?.lastError || '';
  $('finding-count').textContent = s?.findings.length || 0;
  $('findings').replaceChildren();
  if (!s?.findings.length) {
    const empty = document.createElement('div'); empty.className = 'empty';
    const icon = document.createElement('span'); icon.textContent = '✧';
    const title = document.createElement('h4'); title.textContent = 'El próximo hallazgo empieza aquí';
    const p = document.createElement('p'); p.textContent = 'Claude puede registrar mecánicas, bonus y observaciones mientras explora el juego.';
    empty.append(icon, title, p); $('findings').append(empty);
  }
  for (const f of [...(s?.findings || [])].reverse()) {
    const item = document.createElement('article'); item.className = 'finding';
    const tag = document.createElement('span'); tag.className = 'finding-tag'; tag.textContent = f.category;
    const title = document.createElement('h4'); title.textContent = f.title;
    const detail = document.createElement('p'); detail.textContent = f.detail;
    const meta = document.createElement('small'); meta.textContent = time(f.at) + ' · Registrado por ' + f.source;
    item.append(tag, title, detail, meta); $('findings').append(item);
  }
  $('events').replaceChildren();
  for (const e of [...(s?.events || [])].reverse().slice(0, 80)) {
    const item = document.createElement('li'); item.className = e.type;
    const at = document.createElement('time'); at.textContent = time(e.at);
    const p = document.createElement('p'); p.textContent = e.message;
    item.append(at, p); $('events').append(item);
  }
  if (!s?.events.length) { const li = document.createElement('li'); li.className = 'empty-event'; li.textContent = 'Los eventos de la sesión aparecerán aquí.'; $('events').append(li); }
  $('updated').textContent = 'Última actualización ' + time(snapshot.now);
  renderClock();
}
function accept(data) {
  snapshot = data; receivedAt = Date.now();
  const previous = $('sessions').value;
  $('sessions').replaceChildren(new Option('Sesión actual', 'current'));
  for (const s of data.history) $('sessions').add(new Option(new Date(s.startedAt).toLocaleDateString('es-AR') + ' ' + time(s.startedAt) + ' · ' + s.title, s.id));
  selected = previous === 'current' || data.history.some(s => s.id === previous) ? previous : 'current';
  $('sessions').value = selected; render();
}
$('sessions').addEventListener('change', event => { selected = event.target.value; render(); });
const events = new EventSource('/events');
events.onopen = () => { $('connection').textContent = 'Conectado al MCP'; $('connection').className = 'connection'; };
events.onmessage = event => { try { accept(JSON.parse(event.data)); } catch { $('connection').textContent = 'No se pudo leer el estado'; } };
events.onerror = () => { $('connection').textContent = 'Sin conexión · reintentando'; $('connection').className = 'connection offline'; };
setInterval(renderClock, 1000);
