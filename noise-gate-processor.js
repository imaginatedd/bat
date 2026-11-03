class NoiseGateProcessor extends AudioWorkletProcessor {
    constructor() {
        super();
        this.threshold = -50;
        this.attackTime = 0.001;
        this.releaseTime = 0.1;
        this.isOpen = false;
        this.envelope = 0;

        this.port.onmessage = (e) => {
            if (e.data.type === 'threshold') {
                this.threshold = e.data.value;
            }
        };
    }

    process(inputs, outputs, parameters) {
        const input = inputs[0];
        const output = outputs[0];

        if (!input || !input[0]) {
            return true;
        }

        for (let channel = 0; channel < input.length; channel++) {
            const inputChannel = input[channel];
            const outputChannel = output[channel];

            for (let i = 0; i < inputChannel.length; i++) {
                const sample = inputChannel[i];

                // Calculate RMS level
                const level = Math.abs(sample);
                const dbLevel = 20 * Math.log10(level + 0.0001);

                // Gate logic
                if (dbLevel > this.threshold) {
                    this.isOpen = true;
                } else if (dbLevel < this.threshold - 6) {
                    this.isOpen = false;
                }

                // Envelope follower
                const target = this.isOpen ? 1 : 0;
                const coeff = this.isOpen ? this.attackTime : this.releaseTime;
                this.envelope += (target - this.envelope) * coeff;

                // Apply gate
                outputChannel[i] = sample * this.envelope;
            }
        }

        return true;
    }
}

registerProcessor('noise-gate-processor', NoiseGateProcessor);
