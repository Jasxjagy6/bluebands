/* One sound preference for gameplay and account feedback. No audio downloads. */
const key = 'banditblox.sound';
let enabled = true, context, output, unlocked = false, lastSound = 0;
try { enabled = localStorage.getItem(key) !== 'off'; } catch {}
export const soundEnabled = () => enabled;
export function setSoundEnabled(value) {
  enabled = Boolean(value);
  if (output) output.gain.setValueAtTime(enabled ? 1 : 0, context.currentTime);
  try { localStorage.setItem(key, enabled ? 'on' : 'off'); } catch {}
  document.dispatchEvent(new CustomEvent('eb:soundchange', {detail: enabled}));
}
addEventListener('storage', event => {
  if (event.key === key) {
    enabled = event.newValue !== 'off';
    if (output) output.gain.setValueAtTime(enabled ? 1 : 0, context.currentTime);
    document.dispatchEvent(new CustomEvent('eb:soundchange', {detail: enabled}));
  }
});
function unlock(event) {
  if (!event.isTrusted) return;
  unlocked = true;
  if (enabled) audio();
}
document.addEventListener('pointerdown', unlock, {passive: true});
document.addEventListener('keydown', unlock);
function audio() {
  if (!unlocked || !enabled) return null;
  try {
    if (!context) {
      context = new (window.AudioContext || window.webkitAudioContext)();
      output = context.createGain(); output.gain.value = enabled ? 1 : 0; output.connect(context.destination);
    }
    if (context.state === 'suspended') void context.resume().catch(() => {});
    return context;
  } catch { return null; }
}
export function playSound(kind = 'info') {
  const now = performance.now();
  if (now - lastSound < 180) return;
  const ctx = audio(); if (!ctx) return;
  lastSound = now;
  const notes = kind === 'success' ? [660, 880] : kind === 'error' ? [330, 277] : kind === 'tap' ? [740] : [523, 659];
  notes.forEach((frequency, index) => {
    const oscillator = ctx.createOscillator(), gain = ctx.createGain(), at = ctx.currentTime + index * .085;
    oscillator.type = 'sine'; oscillator.frequency.value = frequency;
    gain.gain.setValueAtTime(.0001, at); gain.gain.exponentialRampToValueAtTime(kind === 'tap' ? .025 : .07, at + .012);
    gain.gain.exponentialRampToValueAtTime(.0001, at + .26);
    oscillator.connect(gain); gain.connect(output); oscillator.start(at); oscillator.stop(at + .28);
    oscillator.onended = () => { oscillator.disconnect(); gain.disconnect(); };
  });
}
const onIcon = '<path d="m11 5-6 4H2v6h3l6 4zM15 8a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14"/>';
const offIcon = '<path d="m11 5-6 4H2v6h3l6 4zM16 9l6 6m0-6-6 6"/>';
export function bindSoundToggle(button) {
  const paint = () => {
    button.setAttribute('aria-pressed', String(enabled));
    button.setAttribute('aria-label', enabled ? 'Mute all sounds' : 'Enable sounds');
    button.title = enabled ? 'Sound on' : 'Sound off';
    button.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${enabled ? onIcon : offIcon}</svg><span>Sound ${enabled ? 'on' : 'off'}</span>`;
  };
  button.addEventListener('click', () => { setSoundEnabled(!enabled); if (enabled) playSound('tap'); });
  document.addEventListener('eb:soundchange', paint); paint();
}
export function dismissAccountNotice() {
  const element = document.getElementById('accountAlert'); if (element) element.hidden = true;
}
