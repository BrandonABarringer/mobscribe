import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { EventEmitter } from "node:events";

export interface MicCaptureOptions {
	sampleRate?: number;
	channels?: number;
	bitDepth?: number;
	device?: string;
}

/**
 * Captures microphone audio via SoX and emits PCM chunks.
 * SoX handles device access; permissions come from the parent process (Terminal/IDE).
 *
 * Events:
 *   "data"    — (chunk: Buffer) raw PCM audio
 *   "error"   — (error: Error)
 *   "started" — recording started
 *   "stopped" — recording stopped
 */
export class MicCapture extends EventEmitter {
	private process: ChildProcessWithoutNullStreams | null = null;
	private readonly sampleRate: number;
	private readonly channels: number;
	private readonly bitDepth: number;
	private readonly device: string | undefined;

	constructor(options: MicCaptureOptions = {}) {
		super();
		this.sampleRate = options.sampleRate ?? 16000;
		this.channels = options.channels ?? 1;
		this.bitDepth = options.bitDepth ?? 16;
		this.device = options.device;
	}

	get isRecording(): boolean {
		return this.process !== null && !this.process.killed;
	}

	start(): void {
		if (this.isRecording) {
			throw new Error("Already recording");
		}

		const args = [
			// Input: default microphone
			"-d",
			// Output format: raw PCM
			"-t",
			"raw",
			// Encoding: signed integer
			"-e",
			"signed-integer",
			// Bit depth
			"-b",
			String(this.bitDepth),
			// Channels
			"-c",
			String(this.channels),
			// Sample rate
			"-r",
			String(this.sampleRate),
			// Output to stdout
			"-",
		];

		if (this.device) {
			// Prepend device selection before -d
			args.unshift("-t", "coreaudio", this.device);
			// Remove the -d flag since we're specifying a device
			const dIndex = args.indexOf("-d");
			if (dIndex !== -1) {
				args.splice(dIndex, 1);
			}
		}

		this.process = spawn("sox", args);

		this.process.stdout.on("data", (chunk: Buffer) => {
			this.emit("data", chunk);
		});

		this.process.stderr.on("data", (data: Buffer) => {
			const message = data.toString().trim();
			// SoX prints informational messages to stderr — only emit actual errors
			if (message.toLowerCase().includes("error") || message.toLowerCase().includes("fail")) {
				this.emit("error", new Error(`SoX: ${message}`));
			}
		});

		this.process.on("error", (error: Error) => {
			this.emit("error", new Error(`Failed to start SoX: ${error.message}`));
			this.process = null;
		});

		this.process.on("close", (code: number | null) => {
			this.process = null;
			if (code !== null && code !== 0) {
				this.emit("error", new Error(`SoX exited with code ${code}`));
			}
			this.emit("stopped");
		});

		this.emit("started");
	}

	stop(): void {
		if (!this.process) {
			return;
		}

		this.process.kill("SIGTERM");
		this.process = null;
	}
}
