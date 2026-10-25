// Runs inside every game frame before game scripts. Node's clock is untouched.
export function installSpeedClock({ rate = 1 } = {}) {
  if (globalThis.__claudioClock) { globalThis.__claudioClock.setRate(rate); return; }
  const nativeNow = performance.now.bind(performance);
  const NativeDate = Date;
  const nativeDateNow = NativeDate.now.bind(NativeDate);
  const nativeTimeout = setTimeout.bind(globalThis);
  const nativeClear = clearTimeout.bind(globalThis);
  const nativeRAF = requestAnimationFrame.bind(globalThis);
  const epoch = nativeDateNow() - nativeNow();
  let anchorReal = nativeNow(), anchorVirtual = anchorReal, speed = rate, nextId = 1;
  const timers = new Map();
  const now = () => anchorVirtual + (nativeNow() - anchorReal) * speed;

  function schedule(timer) {
    timer.nativeId = nativeTimeout(() => {
      if (!timers.has(timer.id)) return;
      if (timer.repeat) {
        timer.due = now() + timer.interval;
        schedule(timer);
      } else timers.delete(timer.id);
      if (typeof timer.handler === 'function') timer.handler.apply(globalThis, timer.args);
      else nativeTimeout(String(timer.handler), 0);
    }, Math.min(2147483647, Math.max(0, (timer.due - now()) / speed)));
  }
  function addTimer(handler, delay, args, repeat) {
    const interval = Math.min(2147483647, Math.max(repeat ? 1 : 0, Number(delay) || 0));
    const timer = { id: nextId++, handler, args, repeat, interval, due: now() + interval };
    timers.set(timer.id, timer); schedule(timer); return timer.id;
  }
  function clear(id) {
    const timer = timers.get(Number(id));
    if (timer) { nativeClear(timer.nativeId); timers.delete(timer.id); }
  }
  function SpeedDate(...args) {
    if (!new.target) return new NativeDate(epoch + now()).toString();
    return Reflect.construct(NativeDate, args.length ? args : [epoch + now()], new.target);
  }
  Object.setPrototypeOf(SpeedDate, NativeDate);
  SpeedDate.prototype = NativeDate.prototype;
  SpeedDate.now = () => Math.floor(epoch + now());
  globalThis.Date = SpeedDate;
  Object.defineProperty(performance, 'now', { configurable: true, value: now });
  globalThis.requestAnimationFrame = callback => nativeRAF(() => callback(now()));
  globalThis.setTimeout = (handler, delay, ...args) => addTimer(handler, delay, args, false);
  globalThis.setInterval = (handler, delay, ...args) => addTimer(handler, delay, args, true);
  globalThis.clearTimeout = globalThis.clearInterval = clear;

  const rateAnimation = animation => {
    if (animation) animation.updatePlaybackRate(speed);
    return animation;
  };
  if (globalThis.Element?.prototype.animate) {
    const animate = Element.prototype.animate;
    Element.prototype.animate = function (...args) { return rateAnimation(animate.apply(this, args)); };
  }
  const updateAnimations = () => {
    for (const animation of document.getAnimations()) rateAnimation(animation);
  };
  document.addEventListener('animationstart', updateAnimations, true);
  document.addEventListener('transitionrun', updateAnimations, true);
  const controller = {
    get rate() { return speed; },
    setRate(value) {
      if (!Number.isFinite(value) || value < 1 || value > 8) throw new Error('Speed must be between 1 and 8.');
      anchorVirtual = now(); anchorReal = nativeNow(); speed = value;
      for (const timer of timers.values()) { nativeClear(timer.nativeId); schedule(timer); }
      updateAnimations();
    },
  };
  Object.defineProperty(globalThis, '__claudioClock', { value: controller, configurable: false });
  // The binding returns the latest rate for frames created after a live speed change.
  globalThis.__claudioReadSpeed?.().then(value => controller.setRate(value)).catch(() => {});
}

const controllers = new WeakMap();

export async function prepareSpeed(context, rate = 1) {
  if (controllers.has(context)) return setContextSpeed(context, rate);
  controllers.set(context, { rate });
  await context.exposeBinding('__claudioReadSpeed', () => controllers.get(context).rate);
  await context.addInitScript(installSpeedClock, { rate });
  return setContextSpeed(context, rate);
}

export async function setContextSpeed(context, rate) {
  if (!Number.isFinite(rate) || rate < 1 || rate > 8) throw new Error('La velocidad debe estar entre 1 y 8.');
  const controller = controllers.get(context);
  if (!controller) throw new Error('Primero prepara el reloj del navegador.');
  controller.rate = rate;
  const frames = context.pages().flatMap(page => page.frames());
  const results = await Promise.allSettled(frames.map(frame => frame.evaluate(installSpeedClock, { rate })));
  return { rate, appliedFrames: results.filter(r => r.status === 'fulfilled').length,
    failedFrames: results.filter(r => r.status === 'rejected').length };
}
