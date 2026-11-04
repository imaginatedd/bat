// Spectral noise suppressor: minima-controlled noise floor (MCRA-style).
// Runs as an AudioWorkletProcessor. The "threshold" slider (-80..-10 dB) maps to
// the over-subtraction strength.
//
// Estimation is speech-safe on two levels:
//   * A global noise ENERGY is tracked via min-statistics over a sliding window
//     (speech is always above the noise-energy minimum).
//   * The per-bin noise floor is averaged (EMA) only in frames classified as
//     "noise" by that energy VAD, so it converges to the mean noise magnitude
//     (deep suppression) without learning the voice.
//
// Dual-environment: registers a processor in the AudioWorklet global scope, and
// also exports the class via module.exports so it can be unit-tested in Node.

const FFT_SIZE = 1024;
const HOP_SIZE = 512;
const ATTACK_MS = 5;
const RELEASE_MS = 150;
const GAIN_FLOOR = 0.01;         // -40 dB hard gain floor
const SPECTRAL_FLOOR = 0.05;     // -26 dB (beta) in over-subtraction
const ENERGY_WINDOW = 60;        // ~0.64 s window for the noise-energy minimum
const VAD_FACTOR = 2.0;          // "speech" if frame energy > 2x noise energy
const FLOOR_EMA = 0.15;          // per-bin floor averaging rate in noise frames
const FLOOR_EPS = 1e-6;

const SR = (typeof globalThis !== 'undefined' && globalThis.sampleRate) || 48000;

const ProcessorBase =
  typeof AudioWorkletProcessor !== 'undefined'
    ? AudioWorkletProcessor
    : class { constructor() { this.port = { onmessage: null, postMessage() {} }; } };

class NoiseGateProcessor extends ProcessorBase {
  constructor() {
    super();
    const n = FFT_SIZE;
    this._n = n;
    this._hop = HOP_SIZE;
    this._nBins = n / 2 + 1;

    // sqrt-Hann analysis/synthesis window (sums to unity at 50% overlap).
    this._win = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      this._win[i] = Math.sqrt(0.5 * (1 - Math.cos((2 * Math.PI * i) / n)));
    }

    // Per-frame temporal smoothing coefficients (gain is updated once per hop).
    const frameRate = SR / HOP_SIZE;
    this._attackCoeff = 1 - Math.exp(-1 / ((ATTACK_MS / 1000) * frameRate));
    this._releaseCoeff = 1 - Math.exp(-1 / ((RELEASE_MS / 1000) * frameRate));

    this._overSub = 2.5; // default over-subtraction (slider -50 dB)

    // Noise estimation state.
    this._noiseEnergy = Infinity;
    this._energyMinHold = Infinity;
    this._energyCounter = 0;
    this._warmup = true;
    this._noiseFloor = new Float32Array(this._nBins).fill(1.0);

    this._gainSmoothed = new Float32Array(this._nBins).fill(1);
    this._mag = new Float32Array(this._nBins);
    this._target = new Float32Array(this._nBins);
    this._re = new Float32Array(n);
    this._im = new Float32Array(n);

    this._inBufs = [];
    this._outBufs = [];
    this._hopCount = 0;

    this.port.onmessage = (e) => {
      if (e.data && e.data.type === 'threshold') {
        const v = typeof e.data.value === 'number' ? e.data.value : -50;
        // Map slider -80..-10 dB to over-subtraction strength 1.5..4.0.
        this._overSub = 1.5 + ((v + 80) / 70) * 2.5;
      }
    };
  }

  _ensureBuffers(nCh) {
    while (this._inBufs.length < nCh) {
      this._inBufs.push(new Float32Array(this._n));
      this._outBufs.push(new Float32Array(this._n));
    }
  }

  _fft(re, im, inverse) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    const sign = inverse ? 1 : -1;
    for (let len = 2; len <= n; len <<= 1) {
      const ang = sign * 2 * Math.PI / len;
      const wlenr = Math.cos(ang), wleni = Math.sin(ang);
      for (let i = 0; i < n; i += len) {
        let wr = 1, wi = 0;
        for (let j = 0; j < (len >> 1); j++) {
          const a = i + j, b = i + j + (len >> 1);
          const ur = re[a], ui = im[a];
          const vr = re[b] * wr - im[b] * wi;
          const vi = re[b] * wi + im[b] * wr;
          re[a] = ur + vr; im[a] = ui + vi;
          re[b] = ur - vr; im[b] = ui - vi;
          const nwr = wr * wlenr - wi * wleni;
          wi = wr * wleni + wi * wlenr;
          wr = nwr;
        }
      }
    }
    if (inverse) {
      for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
    }
  }

  _processFrame(nCh) {
    const n = this._n, nBins = this._nBins;
    const re = this._re, im = this._im;

    // Magnitude spectrum of channel 0 drives the shared gain curve.
    const ch0 = this._inBufs[0];
    for (let i = 0; i < n; i++) { re[i] = ch0[i] * this._win[i]; im[i] = 0; }
    this._fft(re, im, false);

    const mag = this._mag;
    let frameEnergy = 0;
    for (let i = 0; i < nBins; i++) {
      mag[i] = Math.sqrt(re[i] * re[i] + im[i] * im[i]);
    }
    for (let i = 1; i < nBins - 1; i++) frameEnergy += mag[i] * mag[i];

    const floor = this._noiseFloor;

    // Global noise-energy minimum tracking (speech-safe).
    if (frameEnergy < this._energyMinHold) this._energyMinHold = frameEnergy;
    this._energyCounter++;

    let isNoise;
    if (this._warmup) {
      // Fast start: commit the running per-bin minimum every frame.
      for (let i = 1; i < nBins - 1; i++) {
        if (mag[i] < floor[i]) floor[i] = mag[i];
      }
      if (this._energyCounter >= ENERGY_WINDOW) {
        this._noiseEnergy = this._energyMinHold;
        this._warmup = false;
        this._energyCounter = 0;
        this._energyMinHold = Infinity;
      }
      isNoise = true;
    } else {
      if (this._energyCounter >= ENERGY_WINDOW) {
        this._noiseEnergy = this._energyMinHold;
        this._energyCounter = 0;
        this._energyMinHold = Infinity;
      }
      isNoise = frameEnergy < this._noiseEnergy * VAD_FACTOR;
      if (isNoise) {
        for (let i = 1; i < nBins - 1; i++) {
          floor[i] += FLOOR_EMA * (mag[i] - floor[i]);
        }
      } else {
        // Speech: never raise the floor into the voice; only follow dips.
        for (let i = 1; i < nBins - 1; i++) {
          if (mag[i] < floor[i]) floor[i] = mag[i];
        }
      }
    }
    for (let i = 1; i < nBins - 1; i++) {
      if (floor[i] < FLOOR_EPS) floor[i] = FLOOR_EPS;
    }

    // Over-subtraction spectral suppression -> target gain per bin.
    const alpha = this._overSub;
    const target = this._target;
    target[0] = 1;
    target[nBins - 1] = 1;
    for (let i = 1; i < nBins - 1; i++) {
      const m = mag[i];
      const f = floor[i];
      let clean = m - alpha * f;
      const betaFloor = SPECTRAL_FLOOR * m;
      if (clean < betaFloor) clean = betaFloor;
      let g = clean / (m + FLOOR_EPS);
      if (g < GAIN_FLOOR) g = GAIN_FLOOR; else if (g > 1) g = 1;
      target[i] = g;
    }

    // Light 3-tap spectral smoothing to reduce musical noise.
    let prev = target[1];
    for (let i = 1; i < nBins - 1; i++) {
      const cur = target[i];
      const next = (i + 1 < nBins - 1) ? target[i + 1] : cur;
      target[i] = 0.25 * prev + 0.5 * cur + 0.25 * next;
      prev = cur;
    }

    // Temporal smoothing (fast attack, slow release) of the gain curve.
    const gs = this._gainSmoothed;
    for (let i = 1; i < nBins - 1; i++) {
      const t = target[i];
      const a = t > gs[i] ? this._attackCoeff : this._releaseCoeff;
      gs[i] += a * (t - gs[i]);
    }

    // Apply the shared gain curve to every channel and overlap-add.
    for (let ch = 0; ch < nCh; ch++) {
      const inBuf = this._inBufs[ch];
      for (let i = 0; i < n; i++) { re[i] = inBuf[i] * this._win[i]; im[i] = 0; }
      this._fft(re, im, false);
      for (let i = 1, j = n - 1; i < nBins - 1; i++, j--) {
        const g = gs[i];
        re[i] *= g; im[i] *= g;
        re[j] *= g; im[j] *= g;
      }
      im[0] = 0;
      im[nBins - 1] = 0;
      this._fft(re, im, true);
      const outBuf = this._outBufs[ch];
      for (let i = 0; i < n; i++) outBuf[i] += re[i] * this._win[i];
    }
  }

  process(inputs, outputs) {
    const input = inputs[0], output = outputs[0];
    if (!input || !output || !input[0]) return true;

    const nCh = Math.min(input.length, output.length);
    if (nCh === 0) return true;
    const block = input[0].length;
    this._ensureBuffers(nCh);

    for (let ch = 0; ch < nCh; ch++) {
      const inBuf = this._inBufs[ch];
      inBuf.copyWithin(0, block);
      inBuf.set(input[ch], this._n - block);
    }
    this._hopCount += block;
    if (this._hopCount >= this._hop) {
      this._hopCount -= this._hop;
      this._processFrame(nCh);
    }

    for (let ch = 0; ch < nCh; ch++) {
      const outBuf = this._outBufs[ch];
      output[ch].set(outBuf.subarray(0, block));
      outBuf.copyWithin(0, block);
      outBuf.fill(0, this._n - block);
    }
    return true;
  }
}

if (typeof registerProcessor === 'function') {
  registerProcessor('noise-gate-processor', NoiseGateProcessor);
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { NoiseGateProcessor, FFT_SIZE, HOP_SIZE };
}
