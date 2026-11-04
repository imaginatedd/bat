class AudioProcessor {
    constructor() {
        this.audioContext = null;
        this.mediaStream = null;
        this.sourceNode = null;
        this.analyserNode = null;
        this.isProcessing = false;

        // Effect nodes
        this.gateNode = null;
        this.gateWorkletNode = null;
        this.compressorNode = null;
        this.eqNodes = { low: null, mid: null, high: null };
        this.reverbNode = null;
        this.reverbInput = null;
        this.reverbOutput = null;
        this.deesserNode = null;
        this.gainNode = null;
        this.vstPlugins = [];
        this.vst3BridgeAvailable = false;

        // Effect states
        this.effects = {
            gate: { enabled: true, threshold: -50 },
            compressor: { enabled: true, threshold: -24, ratio: 4 },
            eq: { enabled: true, low: 0, mid: 0, high: 0 },
            reverb: { enabled: false, size: 30, mix: 20 },
            deesser: { enabled: false, freq: 6000, reduction: 50 },
            output: { enabled: true, gain: 0 }
        };

        this.initUI();
    }

    async initialize() {
        try {
            this.audioContext = new (window.AudioContext || window.webkitAudioContext)();

            // Load AudioWorklet for noise gate. Load it via a Blob URL when running
            // inside Electron, because AudioWorklet module loading can fail under
            // the file:// protocol.
            try {
                let moduleUrl = 'noise-gate-processor.js';
                if (typeof window.electronAPI !== 'undefined' && window.electronAPI.getWorkletSource) {
                    const src = await window.electronAPI.getWorkletSource();
                    if (src) {
                        moduleUrl = URL.createObjectURL(new Blob([src], { type: 'application/javascript' }));
                    }
                }
                await this.audioContext.audioWorklet.addModule(moduleUrl);
                console.log('AudioWorklet loaded successfully');
            } catch (e) {
                console.warn('AudioWorklet not available, using fallback gate', e);
            }

            // Load the VST3 bridge worklet (round-trips audio through the native host).
            try {
                let bridgeUrl = 'vst3-bridge-processor.js';
                if (typeof window.electronAPI !== 'undefined' && window.electronAPI.getVst3BridgeSource) {
                    const src = await window.electronAPI.getVst3BridgeSource();
                    if (src) {
                        bridgeUrl = URL.createObjectURL(new Blob([src], { type: 'application/javascript' }));
                    }
                }
                await this.audioContext.audioWorklet.addModule(bridgeUrl);
                this.vst3BridgeAvailable = true;
                console.log('VST3 bridge worklet loaded');
            } catch (e) {
                console.warn('VST3 bridge worklet not available', e);
            }

            await this.loadDevices();
        } catch (error) {
            console.error('Failed to initialize audio:', error);
            alert('Audio initialization failed: ' + error.message);
        }
    }

    async loadDevices() {
        try {
            const devices = await navigator.mediaDevices.enumerateDevices();
            const audioInputs = devices.filter(device => device.kind === 'audioinput');

            const select = document.getElementById('inputDevice');
            select.innerHTML = '<option value="">Select input device...</option>';

            audioInputs.forEach(device => {
                const option = document.createElement('option');
                option.value = device.deviceId;
                option.textContent = device.label || `Microphone ${select.options.length}`;
                select.appendChild(option);
            });
        } catch (error) {
            console.error('Failed to load devices:', error);
        }
    }

    async start() {
        const deviceId = document.getElementById('inputDevice').value;

        if (!deviceId) {
            alert('Please select an input device');
            return;
        }

        try {
            const constraints = {
                audio: {
                    deviceId: deviceId ? { exact: deviceId } : undefined,
                    echoCancellation: false,
                    noiseSuppression: false,
                    autoGainControl: false
                }
            };

            this.mediaStream = await navigator.mediaDevices.getUserMedia(constraints);
            await this.setupAudioGraph();
            this.startVisualizer();
            this.isProcessing = true;

            this.updateStatus(true);
            document.getElementById('startBtn').style.display = 'none';
            document.getElementById('stopBtn').style.display = 'block';
        } catch (error) {
            console.error('Failed to start audio processing:', error);
            alert('Failed to access microphone: ' + error.message);
        }
    }

    async setupAudioGraph() {
        // Create source
        this.sourceNode = this.audioContext.createMediaStreamSource(this.mediaStream);

        // Create analyser for visualization
        this.analyserNode = this.audioContext.createAnalyser();
        this.analyserNode.fftSize = 2048;

        // Create effect nodes
        await this.setupNoiseGate();
        this.setupCompressor();
        this.setupEQ();
        this.setupReverb();
        this.setupDeesser();
        this.setupOutput();

        // Connect the chain
        this.connectAudioGraph();
    }

    async setupNoiseGate() {
        try {
            // Try using AudioWorklet
            this.gateWorkletNode = new AudioWorkletNode(this.audioContext, 'noise-gate-processor');
            this.gateWorkletNode.port.postMessage({
                type: 'threshold',
                value: this.effects.gate.threshold
            });
            this.gateNode = this.gateWorkletNode;
            console.log('Using AudioWorklet for noise gate');
        } catch (e) {
            // Fallback to ScriptProcessor
            console.log('Using ScriptProcessor fallback for noise gate');
            this.setupNoiseGateFallback();
        }
    }

    setupNoiseGateFallback() {
        // Time-domain RMS gate with hysteresis + hold, used only when the
        // spectral AudioWorklet is unavailable.
        const bufferSize = 2048;
        this.gateNode = this.audioContext.createScriptProcessor(bufferSize, 1, 1);

        const sampleRate = this.audioContext.sampleRate;
        const rmsCoeff = 1 - Math.exp(-1 / (sampleRate * 0.010)); // 10 ms RMS envelope
        const attackCoeff = 1 - Math.exp(-1 / (sampleRate * 0.001)); // 1 ms attack
        const releaseCoeff = 1 - Math.exp(-1 / (sampleRate * 0.100)); // 100 ms release
        const holdSamples = Math.floor(sampleRate * 0.05); // 50 ms hold

        let rmsEnv = 0;
        let envelope = 0;
        let gateOpen = false;
        let holdCounter = 0;

        this.gateNode.onaudioprocess = (e) => {
            const input = e.inputBuffer.getChannelData(0);
            const output = e.outputBuffer.getChannelData(0);
            const threshold = this.effects.gate.threshold;

            for (let i = 0; i < input.length; i++) {
                const sample = input[i];

                // Smooth RMS envelope (power domain).
                rmsEnv += rmsCoeff * (sample * sample - rmsEnv);
                const dbLevel = 10 * Math.log10(rmsEnv + 1e-12);

                // Hysteresis + hold.
                if (dbLevel > threshold) {
                    gateOpen = true;
                    holdCounter = holdSamples;
                } else if (dbLevel < threshold - 6) {
                    if (holdCounter > 0) {
                        holdCounter--;
                    } else {
                        gateOpen = false;
                    }
                } else if (holdCounter > 0) {
                    holdCounter--;
                }

                const target = gateOpen ? 1 : 0;
                const coeff = gateOpen ? attackCoeff : releaseCoeff;
                envelope += (target - envelope) * coeff;

                output[i] = sample * envelope;
            }
        };
    }

    setupCompressor() {
        this.compressorNode = this.audioContext.createDynamicsCompressor();
        this.updateCompressor();
    }

    setupEQ() {
        // Low shelf
        this.eqNodes.low = this.audioContext.createBiquadFilter();
        this.eqNodes.low.type = 'lowshelf';
        this.eqNodes.low.frequency.value = 80;
        this.eqNodes.low.gain.value = 0;

        // Mid peaking
        this.eqNodes.mid = this.audioContext.createBiquadFilter();
        this.eqNodes.mid.type = 'peaking';
        this.eqNodes.mid.frequency.value = 1000;
        this.eqNodes.mid.Q.value = 1;
        this.eqNodes.mid.gain.value = 0;

        // High shelf
        this.eqNodes.high = this.audioContext.createBiquadFilter();
        this.eqNodes.high.type = 'highshelf';
        this.eqNodes.high.frequency.value = 8000;
        this.eqNodes.high.gain.value = 0;
    }

    setupReverb() {
        // Create convolver for reverb
        this.reverbNode = this.audioContext.createConvolver();
        this.reverbDry = this.audioContext.createGain();
        this.reverbWet = this.audioContext.createGain();

        const mix = this.effects.reverb.mix / 100;
        this.reverbDry.gain.value = 1 - mix;
        this.reverbWet.gain.value = mix;

        // Generate impulse response
        this.generateReverbImpulse();
    }

    generateReverbImpulse() {
        const sampleRate = this.audioContext.sampleRate;
        const length = Math.max(1, Math.floor(sampleRate * (this.effects.reverb.size / 100) * 2));
        const impulse = this.audioContext.createBuffer(2, length, sampleRate);

        for (let channel = 0; channel < 2; channel++) {
            const channelData = impulse.getChannelData(channel);
            for (let i = 0; i < length; i++) {
                channelData[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, 2);
            }
        }

        this.reverbNode.buffer = impulse;
    }

    setupDeesser() {
        // High-frequency compressor
        this.deesserNode = this.audioContext.createBiquadFilter();
        this.deesserNode.type = 'peaking';
        this.deesserNode.frequency.value = 6000;
        this.deesserNode.Q.value = 2;
        this.deesserNode.gain.value = 0;
    }

    setupOutput() {
        this.gainNode = this.audioContext.createGain();
        this.gainNode.gain.value = 1;
    }

    connectAudioGraph() {
        let currentNode = this.sourceNode;

        // Gate
        if (this.effects.gate.enabled && this.gateNode) {
            currentNode.connect(this.gateNode);
            currentNode = this.gateNode;
        }

        // Compressor
        if (this.effects.compressor.enabled) {
            currentNode.connect(this.compressorNode);
            currentNode = this.compressorNode;
        }

        // EQ chain
        if (this.effects.eq.enabled) {
            currentNode.connect(this.eqNodes.low);
            this.eqNodes.low.connect(this.eqNodes.mid);
            this.eqNodes.mid.connect(this.eqNodes.high);
            currentNode = this.eqNodes.high;
        }

        // VST3 Plugins
        this.vstPlugins.forEach(plugin => {
            if (plugin.enabled && plugin.node) {
                currentNode.connect(plugin.node);
                currentNode = plugin.node;
            }
        });

        // De-esser
        if (this.effects.deesser.enabled) {
            currentNode.connect(this.deesserNode);
            currentNode = this.deesserNode;
        }

        // Reverb (parallel)
        if (this.effects.reverb.enabled) {
            this.reverbInput = this.audioContext.createGain();
            currentNode.connect(this.reverbInput);

            this.reverbInput.connect(this.reverbDry);
            this.reverbInput.connect(this.reverbNode);
            this.reverbNode.connect(this.reverbWet);

            this.reverbOutput = this.audioContext.createGain();
            this.reverbDry.connect(this.reverbOutput);
            this.reverbWet.connect(this.reverbOutput);

            currentNode = this.reverbOutput;
        }

        // Output gain (bypassed when the Output effect is disabled)
        if (this.effects.output.enabled) {
            currentNode.connect(this.gainNode);
            currentNode = this.gainNode;
        }

        // Connect to analyser and destination
        currentNode.connect(this.analyserNode);
        currentNode.connect(this.audioContext.destination);
    }

    disconnectAudioGraph() {
        if (this.sourceNode) this.sourceNode.disconnect();
        if (this.gateNode) this.gateNode.disconnect();
        if (this.compressorNode) this.compressorNode.disconnect();
        if (this.eqNodes.low) {
            this.eqNodes.low.disconnect();
            this.eqNodes.mid.disconnect();
            this.eqNodes.high.disconnect();
        }
        this.vstPlugins.forEach(plugin => {
            if (plugin.node) plugin.node.disconnect();
        });
        if (this.reverbNode) {
            this.reverbNode.disconnect();
            this.reverbDry.disconnect();
            this.reverbWet.disconnect();
        }
        if (this.reverbInput) this.reverbInput.disconnect();
        if (this.reverbOutput) this.reverbOutput.disconnect();
        if (this.deesserNode) this.deesserNode.disconnect();
        if (this.gainNode) this.gainNode.disconnect();
        if (this.analyserNode) this.analyserNode.disconnect();
    }

    updateCompressor() {
        if (!this.compressorNode) return;

        this.compressorNode.threshold.value = this.effects.compressor.threshold;
        this.compressorNode.ratio.value = this.effects.compressor.ratio;
        this.compressorNode.attack.value = 0.003;
        this.compressorNode.release.value = 0.25;
        this.compressorNode.knee.value = 30;
    }

    updateGateThreshold() {
        if (this.gateWorkletNode && this.gateWorkletNode.port) {
            this.gateWorkletNode.port.postMessage({
                type: 'threshold',
                value: this.effects.gate.threshold
            });
        }
    }

    async loadVST3Plugin() {
        if (typeof window.electronAPI === 'undefined') {
            alert('VST3 loading is only available in Electron environment');
            return;
        }

        try {
            const pluginPath = await window.electronAPI.openVST3Dialog();

            if (!pluginPath) return;

            const result = await window.electronAPI.loadVST3(pluginPath);

            if (result.success) {
                // Bridge node: round-trips audio through the native VST3 host.
                const vstNode = this.createVst3BridgeNode(result.pluginId);

                const plugin = {
                    id: result.pluginId,
                    name: result.name,
                    path: pluginPath,
                    node: vstNode,
                    enabled: true,
                    parameters: result.parameters || []
                };

                this.vstPlugins.push(plugin);
                this.addVSTPluginToUI(plugin);

                alert(`VST3 plugin loaded: ${result.name}\n${plugin.parameters.length} parameters.`);

                if (this.isProcessing) {
                    this.disconnectAudioGraph();
                    this.connectAudioGraph();
                }
            } else {
                alert('Failed to load VST3: ' + result.error);
            }
        } catch (error) {
            console.error('VST3 loading error:', error);
            alert('Failed to load VST3 plugin: ' + error.message);
        }
    }

    addVSTPluginToUI(plugin) {
        const container = document.getElementById('vstPluginsContainer');

        const pluginBlock = document.createElement('div');
        pluginBlock.className = 'effect-block';
        pluginBlock.id = `vst-${plugin.id}`;

        pluginBlock.innerHTML = `
            <div class="effect-header">
                <span class="effect-title">🎛️ ${this.escapeHtml(plugin.name)}</span>
                <div style="display: flex; gap: 10px; align-items: center;">
                    <label class="toggle-switch">
                        <input type="checkbox" class="vst-toggle" data-id="${plugin.id}" checked>
                        <span class="slider"></span>
                    </label>
                    <button class="remove-vst-btn" data-id="${plugin.id}" title="Remove plugin">✕</button>
                </div>
            </div>
            <div class="vst-params"></div>
        `;

        container.appendChild(pluginBlock);

        // Build one slider per plugin parameter (no extra styling).
        const paramsContainer = pluginBlock.querySelector('.vst-params');
        (plugin.parameters || []).forEach((p) => {
            const group = document.createElement('div');
            group.className = 'control-group';

            const label = document.createElement('div');
            label.className = 'control-label';
            const name = document.createElement('span');
            name.textContent = p.title || ('Param ' + p.id);
            const value = document.createElement('span');
            value.className = 'control-value';
            value.textContent = this.formatParamValue(p);
            label.appendChild(name);
            label.appendChild(value);

            const slider = document.createElement('input');
            slider.type = 'range';
            slider.min = '0';
            slider.max = '1';
            slider.step = '0.001';
            slider.value = String(p.value != null ? p.value : 0);

            slider.addEventListener('input', () => {
                const v = parseFloat(slider.value);
                value.textContent = v.toFixed(3) + (p.units ? ' ' + p.units : '');
                if (typeof window.electronAPI !== 'undefined') {
                    window.electronAPI.setVST3Parameter(plugin.id, p.id, v)
                        .catch((err) => console.error('setVST3Parameter failed:', err));
                }
            });

            group.appendChild(label);
            group.appendChild(slider);
            paramsContainer.appendChild(group);
        });

        // Add event listeners
        pluginBlock.querySelector('.vst-toggle').addEventListener('change', (e) => {
            plugin.enabled = e.target.checked;
            if (this.isProcessing) {
                this.disconnectAudioGraph();
                this.connectAudioGraph();
            }
        });

        pluginBlock.querySelector('.remove-vst-btn').addEventListener('click', () => {
            this.removeVSTPlugin(plugin.id);
        });
    }

    formatParamValue(p) {
        const v = p.value != null ? p.value : 0;
        return v.toFixed(3) + (p.units ? ' ' + p.units : '');
    }

    escapeHtml(s) {
        return String(s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    createVst3BridgeNode(pluginId) {
        // If the bridge worklet is unavailable, fall back to a pass-through gain.
        if (!this.vst3BridgeAvailable || typeof window.electronAPI === 'undefined') {
            const g = this.audioContext.createGain();
            g.gain.value = 1;
            return g;
        }

        const blockSize = 1024; // mono samples per round-trip
        const sabReq = new SharedArrayBuffer(blockSize * 4);
        const sabResp = new SharedArrayBuffer(blockSize * 4);
        const ctrl = new SharedArrayBuffer(8); // Int32Array(2): [reqReady, respReady]

        const node = new AudioWorkletNode(this.audioContext, 'vst3-bridge-processor', {
            numberOfInputs: 1,
            numberOfOutputs: 1,
            outputChannelCount: [1],
            channelCount: 1,
            channelCountMode: 'explicit',
            channelInterpretation: 'speakers'
        });

        const ctrlView = new Int32Array(ctrl);
        const respView = new Float32Array(sabResp);

        node.port.onmessage = async (e) => {
            if (!e.data || e.data.type !== 'process') return;
            Atomics.store(ctrlView, 0, 0); // consume the request
            const req = new Float32Array(sabReq);
            const reqCopy = new Float32Array(blockSize);
            reqCopy.set(req);
            try {
                const result = await window.electronAPI.processVST3(pluginId, reqCopy, {
                    sampleRate: this.audioContext.sampleRate,
                    blockSize
                });
                if (result && result.success && result.audioData) {
                    const data = result.audioData instanceof Float32Array
                        ? result.audioData
                        : new Float32Array(result.audioData);
                    respView.set(data.subarray(0, blockSize));
                } else {
                    respView.fill(0);
                }
            } catch (err) {
                console.error('VST3 bridge round-trip failed:', err);
                respView.fill(0);
            }
            Atomics.store(ctrlView, 1, 1); // response ready
            Atomics.notify(ctrlView, 1);
        };

        node.port.postMessage({ type: 'init', sabReq, sabResp, ctrl, blockSize });
        return node;
    }

    async removeVSTPlugin(pluginId) {
        const index = this.vstPlugins.findIndex(p => p.id === pluginId);

        if (index !== -1) {
            const plugin = this.vstPlugins[index];

            if (plugin.node) {
                plugin.node.disconnect();
            }

            if (typeof window.electronAPI !== 'undefined') {
                await window.electronAPI.unloadVST3(pluginId);
            }

            this.vstPlugins.splice(index, 1);

            const element = document.getElementById(`vst-${pluginId}`);
            if (element) {
                element.remove();
            }

            if (this.isProcessing) {
                this.disconnectAudioGraph();
                this.connectAudioGraph();
            }
        }
    }

    startVisualizer() {
        const canvas = document.getElementById('visualizer');
        const ctx = canvas.getContext('2d');
        canvas.width = canvas.offsetWidth;
        canvas.height = canvas.offsetHeight;

        const bufferLength = this.analyserNode.frequencyBinCount;
        const dataArray = new Uint8Array(bufferLength);

        const draw = () => {
            if (!this.isProcessing) return;

            requestAnimationFrame(draw);

            this.analyserNode.getByteTimeDomainData(dataArray);

            ctx.fillStyle = '#1a1a1a';
            ctx.fillRect(0, 0, canvas.width, canvas.height);

            ctx.lineWidth = 2;
            ctx.strokeStyle = '#667eea';
            ctx.beginPath();

            const sliceWidth = canvas.width / bufferLength;
            let x = 0;

            for (let i = 0; i < bufferLength; i++) {
                const v = dataArray[i] / 128.0;
                const y = v * canvas.height / 2;

                if (i === 0) {
                    ctx.moveTo(x, y);
                } else {
                    ctx.lineTo(x, y);
                }

                x += sliceWidth;
            }

            ctx.lineTo(canvas.width, canvas.height / 2);
            ctx.stroke();
        };

        draw();
    }

    stop() {
        this.isProcessing = false;

        if (this.mediaStream) {
            this.mediaStream.getTracks().forEach(track => track.stop());
        }

        this.disconnectAudioGraph();

        this.updateStatus(false);
        document.getElementById('startBtn').style.display = 'block';
        document.getElementById('stopBtn').style.display = 'none';
    }

    updateStatus(active) {
        const status = document.getElementById('status');
        status.textContent = active ? 'Active' : 'Inactive';
        status.className = active ? 'status active' : 'status inactive';
    }

    applyPreset(presetName) {
        const presets = {
            default: {
                gate: { threshold: -50 },
                compressor: { threshold: -24, ratio: 4 },
                eq: { low: 0, mid: 0, high: 0 },
                reverb: { size: 30, mix: 20 },
                deesser: { freq: 6000, reduction: 50 },
                output: { gain: 0 }
            },
            podcast: {
                gate: { threshold: -45 },
                compressor: { threshold: -20, ratio: 6 },
                eq: { low: 2, mid: 3, high: 4 },
                reverb: { size: 15, mix: 10 },
                deesser: { freq: 6500, reduction: 60 },
                output: { gain: 3 }
            },
            gaming: {
                gate: { threshold: -40 },
                compressor: { threshold: -18, ratio: 8 },
                eq: { low: -2, mid: 4, high: 6 },
                reverb: { size: 10, mix: 5 },
                deesser: { freq: 7000, reduction: 70 },
                output: { gain: 5 }
            },
            broadcast: {
                gate: { threshold: -48 },
                compressor: { threshold: -22, ratio: 10 },
                eq: { low: 1, mid: 2, high: 3 },
                reverb: { size: 20, mix: 15 },
                deesser: { freq: 6000, reduction: 55 },
                output: { gain: 4 }
            },
            vocal: {
                gate: { threshold: -42 },
                compressor: { threshold: -16, ratio: 4 },
                eq: { low: -3, mid: 5, high: 8 },
                reverb: { size: 40, mix: 30 },
                deesser: { freq: 6500, reduction: 65 },
                output: { gain: 2 }
            },
            clean: {
                gate: { threshold: -35 },
                compressor: { threshold: -20, ratio: 3 },
                eq: { low: 0, mid: 1, high: 2 },
                reverb: { size: 5, mix: 5 },
                deesser: { freq: 7000, reduction: 50 },
                output: { gain: 1 }
            }
        };

        const preset = presets[presetName];
        if (!preset) return;

        // Update values
        this.effects.gate.threshold = preset.gate.threshold;
        this.effects.compressor.threshold = preset.compressor.threshold;
        this.effects.compressor.ratio = preset.compressor.ratio;
        this.effects.eq.low = preset.eq.low;
        this.effects.eq.mid = preset.eq.mid;
        this.effects.eq.high = preset.eq.high;
        this.effects.reverb.size = preset.reverb.size;
        this.effects.reverb.mix = preset.reverb.mix;
        this.effects.deesser.freq = preset.deesser.freq;
        this.effects.deesser.reduction = preset.deesser.reduction;
        this.effects.output.gain = preset.output.gain;

        // Update UI
        document.getElementById('gateThreshold').value = preset.gate.threshold;
        document.getElementById('compThreshold').value = preset.compressor.threshold;
        document.getElementById('compRatio').value = preset.compressor.ratio;
        document.getElementById('eqLow').value = preset.eq.low;
        document.getElementById('eqMid').value = preset.eq.mid;
        document.getElementById('eqHigh').value = preset.eq.high;
        document.getElementById('reverbSize').value = preset.reverb.size;
        document.getElementById('reverbMix').value = preset.reverb.mix;
        document.getElementById('deesserFreq').value = preset.deesser.freq;
        document.getElementById('deesserReduction').value = preset.deesser.reduction;
        document.getElementById('gain').value = preset.output.gain;

        this.updateAllDisplayValues();

        if (this.isProcessing) {
            this.applyEffectChanges();
        }
    }

    applyEffectChanges() {
        if (this.compressorNode) {
            this.updateCompressor();
        }

        if (this.eqNodes.low) {
            this.eqNodes.low.gain.value = this.effects.eq.low;
            this.eqNodes.mid.gain.value = this.effects.eq.mid;
            this.eqNodes.high.gain.value = this.effects.eq.high;
        }

        if (this.deesserNode) {
            this.deesserNode.frequency.value = this.effects.deesser.freq;
            const reduction = this.effects.deesser.reduction / 100;
            this.deesserNode.gain.value = -reduction * 12;
        }

        if (this.gainNode) {
            this.gainNode.gain.value = Math.pow(10, this.effects.output.gain / 20);
        }

        if (this.effects.reverb.enabled && this.reverbNode) {
            this.generateReverbImpulse();
            const mix = this.effects.reverb.mix / 100;
            this.reverbDry.gain.value = 1 - mix;
            this.reverbWet.gain.value = mix;
        }

        this.updateGateThreshold();
    }

    updateAllDisplayValues() {
        document.getElementById('gateThresholdValue').textContent =
            this.effects.gate.threshold + ' dB';
        document.getElementById('compThresholdValue').textContent =
            this.effects.compressor.threshold + ' dB';
        document.getElementById('compRatioValue').textContent =
            this.effects.compressor.ratio + ':1';
        document.getElementById('eqLowValue').textContent =
            this.effects.eq.low + ' dB';
        document.getElementById('eqMidValue').textContent =
            this.effects.eq.mid + ' dB';
        document.getElementById('eqHighValue').textContent =
            this.effects.eq.high + ' dB';
        document.getElementById('reverbSizeValue').textContent =
            this.effects.reverb.size + '%';
        document.getElementById('reverbMixValue').textContent =
            this.effects.reverb.mix + '%';
        document.getElementById('deesserFreqValue').textContent =
            this.effects.deesser.freq + ' Hz';
        document.getElementById('deesserReductionValue').textContent =
            this.effects.deesser.reduction + '%';
        document.getElementById('gainValue').textContent =
            this.effects.output.gain + ' dB';
    }

    initUI() {
        // Start/Stop buttons
        document.getElementById('startBtn').addEventListener('click', () => this.start());
        document.getElementById('stopBtn').addEventListener('click', () => this.stop());

        // Load VST3 button
        document.getElementById('loadVSTBtn').addEventListener('click', () => this.loadVST3Plugin());

        // Preset buttons
        document.querySelectorAll('.preset-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                document.querySelectorAll('.preset-btn').forEach(b => b.classList.remove('active'));
                e.target.classList.add('active');
                this.applyPreset(e.target.dataset.preset);
            });
        });

        // Effect toggles
        const toggles = {
            gateToggle: 'gate',
            compressorToggle: 'compressor',
            eqToggle: 'eq',
            reverbToggle: 'reverb',
            deesserToggle: 'deesser',
            outputToggle: 'output'
        };

        Object.entries(toggles).forEach(([id, effect]) => {
            document.getElementById(id).addEventListener('change', (e) => {
                this.effects[effect].enabled = e.target.checked;
                if (this.isProcessing) {
                    this.disconnectAudioGraph();
                    this.connectAudioGraph();
                }
            });
        });

        // Sliders
        const sliders = [
            { id: 'gateThreshold', effect: 'gate', prop: 'threshold', format: ' dB', callback: () => this.updateGateThreshold() },
            { id: 'compThreshold', effect: 'compressor', prop: 'threshold', format: ' dB' },
            { id: 'compRatio', effect: 'compressor', prop: 'ratio', format: ':1' },
            { id: 'eqLow', effect: 'eq', prop: 'low', format: ' dB' },
            { id: 'eqMid', effect: 'eq', prop: 'mid', format: ' dB' },
            { id: 'eqHigh', effect: 'eq', prop: 'high', format: ' dB' },
            { id: 'reverbSize', effect: 'reverb', prop: 'size', format: '%' },
            { id: 'reverbMix', effect: 'reverb', prop: 'mix', format: '%' },
            { id: 'deesserFreq', effect: 'deesser', prop: 'freq', format: ' Hz' },
            { id: 'deesserReduction', effect: 'deesser', prop: 'reduction', format: '%' },
            { id: 'gain', effect: 'output', prop: 'gain', format: ' dB' }
        ];

        sliders.forEach(({ id, effect, prop, format, callback }) => {
            const slider = document.getElementById(id);
            const valueDisplay = document.getElementById(id + 'Value');

            slider.addEventListener('input', (e) => {
                const value = parseFloat(e.target.value);
                this.effects[effect][prop] = value;
                valueDisplay.textContent = value + format;

                if (callback) callback();

                if (this.isProcessing) {
                    this.applyEffectChanges();
                }
            });
        });
    }
}

// Initialize app
const audioProcessor = new AudioProcessor();

window.addEventListener('DOMContentLoaded', () => {
    audioProcessor.initialize();
});
