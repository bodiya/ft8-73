// Shared transport clock: t in [0,duration), play/pause, speed (multiplier), loop.
export class Clock {
  constructor() { this.t = 0; this.duration = 15; this.playing = false; this.speed = 1; this.loop = true; this.subs = new Set(); this._last = null; this._raf = null; this.onEnd = null; }
  subscribe(fn) { this.subs.add(fn); return () => this.subs.delete(fn); }
  _emit(kind = 'tick') { for (const fn of this.subs) fn(this, kind); }
  setDuration(d) { this.duration = d; if (this.t > d) this.t = 0; this._emit('duration'); }
  seek(t) { this.t = Math.max(0, Math.min(this.duration, t)); this._emit('seek'); }
  play() { if (this.playing) return; this.playing = true; this._last = null; this._emit('play'); this._raf = requestAnimationFrame(this._frame); }
  pause() { if (!this.playing) return; this.playing = false; cancelAnimationFrame(this._raf); this._emit('pause'); }
  toggle() { this.playing ? this.pause() : this.play(); }
  stop() { this.pause(); this.seek(0); }
  setSpeed(s) { this.speed = s; this._emit('speed'); }
  _frame = (now) => {
    if (!this.playing) return;
    if (this._last != null) {
      // Clamp the frame delta: rAF stops while the tab is hidden, so on return `now - _last`
      // can be tens of seconds and the playhead would jump (and desync the audio source).
      const dt = Math.min(now - this._last, 100);
      this.t += dt / 1000 * this.speed;
      if (this.t >= this.duration) { if (this.loop) this.t -= this.duration; else { this.t = this.duration; this.pause(); this._emit('tick'); return; } }
    }
    this._last = now; this._emit('tick');
    this._raf = requestAnimationFrame(this._frame);
  };
}
