// vst3-bridge-processor.js
// AudioWorklet that round-trips audio through the native VST3 host.
//
// The renderer main world allocates SharedArrayBuffers and hands them to this
// processor via its MessagePort. On each full input block the processor writes
// the block into sabReq, signals the main world (postMessage), then blocks on
// Atomics.wait until the main world has written the processed result into
// sabResp. This gives a synchronous (blocking) mono round-trip with one block
// of latency.
//
// The main world forwards the block to the Electron main process over IPC,
// which sends it to vst3_host and returns the processed audio.

const TIMEOUT_MS = 100;

const ProcessorBase =
  typeof AudioWorkletProcessor !== 'undefined'
    ? AudioWorkletProcessor
    : class { constructor() { this.port = { onmessage: null, postMessage() {} }; } };

class Vst3BridgeProcessor extends ProcessorBase {
  constructor() {
    super();
    this._blockSize = 0;
    this._ready = false;
    this._sabReq = null;
    this._sabResp = null;
    this._ctrl = null;
    this._inBuf = null;
    this._outBuf = null;
    this._inPos = 0;
    this._outPos = 0;
    this._outReady = false;

    this.port.onmessage = (e) => {
      const d = e.data;
      if (d && d.type === 'init') {
        this._blockSize = d.blockSize;
        this._sabReq = new Float32Array(d.sabReq);
        this._sabResp = new Float32Array(d.sabResp);
        this._ctrl = new Int32Array(d.ctrl);
        this._inBuf = new Float32Array(this._blockSize);
        this._outBuf = new Float32Array(this._blockSize);
        this._inPos = 0;
        this._outPos = 0;
        this._outReady = false;
        this._ready = true;
      }
    };
  }

  process(inputs, outputs) {
    const output = outputs[0];
    const out = output ? output[0] : null;
    if (!out || !this._ready) return true;

    const input = inputs[0];
    const block = (input && input[0]) ? input[0].length : out.length;

    // Accumulate input into a full block.
    if (input && input[0]) {
      const src = input[0];
      const space = this._blockSize - this._inPos;
      const n = Math.min(space, block);
      this._inBuf.set(src.subarray(0, n), this._inPos);
      this._inPos += n;
    }

    // When the input block is full, do a blocking round-trip.
    if (this._inPos >= this._blockSize) {
      this._inPos = 0;
      this._sabReq.set(this._inBuf);
      Atomics.store(this._ctrl, 0, 1);           // request ready
      Atomics.notify(this._ctrl, 0);             // notify any reqReady waiter
      this.port.postMessage({ type: 'process' }); // wake the main world
      const r = Atomics.wait(this._ctrl, 1, 0, TIMEOUT_MS); // wait response
      if (r === 'ok') {
        this._outBuf.set(this._sabResp);
      } else {
        // Timed out: output silence rather than stale/partial audio.
        this._outBuf.fill(0);
      }
      Atomics.store(this._ctrl, 1, 0);           // reset response flag
      this._outReady = true;
      this._outPos = 0;
    }

    // Play back the processed block (or silence until the first one is ready).
    if (this._outReady) {
      const n = Math.min(block, this._blockSize - this._outPos);
      out.set(this._outBuf.subarray(this._outPos, this._outPos + n));
      this._outPos += n;
      if (this._outPos >= this._blockSize) this._outReady = false;
      for (let i = n; i < block; i++) out[i] = 0;
    } else {
      out.fill(0);
    }

    return true;
  }
}

if (typeof registerProcessor === 'function') {
  registerProcessor('vst3-bridge-processor', Vst3BridgeProcessor);
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { Vst3BridgeProcessor };
}
