/**
 * The audio sink.
 *
 * The core produces interleaved stereo float samples at 44.1 kHz in bursts of
 * one video frame. This processor keeps them in a queue and hands the sound
 * card exactly one render quantum at a time. If the queue runs dry it outputs
 * silence and counts an underrun, rather than repeating the last buffer (which
 * is what makes cheap browser emulators buzz).
 */
class Ps1AudioProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.queue = [];
    this.queuedSamples = 0;
    this.underruns = 0;
    this.lastStatsAt = 0;
    this.port.onmessage = (event) => {
      const { data } = event;
      if (data?.type === 'samples') {
        this.queue.push(new Float32Array(data.samples));
        this.queuedSamples += data.samples.length;
        // Never let a stalled tab build an unbounded backlog.
        while (this.queuedSamples > 44100 * 2 && this.queue.length > 2) {
          const dropped = this.queue.shift();
          this.queuedSamples -= dropped.length;
        }
      } else if (data?.type === 'flush') {
        this.queue = [];
        this.queuedSamples = 0;
      }
    };
  }

  process(_inputs, outputs) {
    const output = outputs[0];
    const left = output[0];
    const right = output[1] ?? output[0];
    let written = 0;
    while (written < left.length && this.queue.length) {
      const chunk = this.queue[0];
      const take = Math.min(chunk.length, (left.length - written) * 2);
      for (let i = 0; i < take; i += 2) {
        left[written + i / 2] = chunk[i];
        right[written + i / 2] = chunk[i + 1] ?? chunk[i];
      }
      written += take / 2;
      if (take === chunk.length) this.queue.shift();
      else this.queue[0] = chunk.subarray(take);
      this.queuedSamples -= take;
    }
    if (written < left.length) {
      if (this.queuedSamples === 0 && written === 0) this.underruns++;
      left.fill(0, written);
      right.fill(0, written);
    }
    if (currentTime - this.lastStatsAt > 1) {
      this.lastStatsAt = currentTime;
      this.port.postMessage({ type: 'stats', underruns: this.underruns, queued: this.queuedSamples });
    }
    return true;
  }
}

registerProcessor('ps1-audio', Ps1AudioProcessor);
