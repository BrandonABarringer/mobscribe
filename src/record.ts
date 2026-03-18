/**
 * Standalone recording mode — starts mic capture + transcription without the MCP server.
 * Used by the auto-detect script to record meetings directly.
 *
 * Usage: node dist/record.js --name "Meeting Name" [--project "Project"] [--context "Context"]
 *
 * Signals:
 *   SIGINT/SIGTERM → stops recording, saves meeting, generates summary, exits
 */

import { MicCapture } from "./audio/mic-capture.js";
import { TranscriptBuffer } from "./context/transcript-buffer.js";
import { saveMeeting } from "./storage/meeting-storage.js";
import { StreamingClient } from "./transcription/streaming-client.js";

function log(message: string): void {
	process.stderr.write(`[mobscribe-record] ${message}\n`);
}

function parseArgs(): { name: string; project?: string; context?: string } {
	const args = process.argv.slice(2);
	let name = "Meeting";
	let project: string | undefined;
	let context: string | undefined;

	for (let i = 0; i < args.length; i++) {
		switch (args[i]) {
			case "--name":
				name = args[++i] || "Meeting";
				break;
			case "--project":
				project = args[++i];
				break;
			case "--context":
				context = args[++i];
				break;
		}
	}

	return { name, project, context };
}

const apiKey = process.env.ASSEMBLYAI_API_KEY;
if (!apiKey) {
	log("ERROR: ASSEMBLYAI_API_KEY not set. Copy .env.example to .env and add your key.");
	process.exit(1);
}

const { name, project, context } = parseArgs();
const buffer = new TranscriptBuffer();
const startTime = new Date();
let stopping = false;

async function startRecording(): Promise<void> {
	log(`Starting recording: ${name}`);
	buffer.clear();

	const streamingClient = new StreamingClient({
		apiKey: apiKey as string,
		sampleRate: 16000,
		onSegment: (segment) => {
			if (segment.isFinal) {
				buffer.addSegment(segment);
				log(`[final] ${segment.text}`);
			}
		},
		onError: (error) => {
			log(`ERROR: ${error.message}`);
		},
		onOpen: () => {
			log("Transcription connected");
		},
		onClose: () => {
			log("Transcription disconnected");
		},
	});

	const connectTimeout = new Promise<never>((_, reject) =>
		setTimeout(() => reject(new Error("AssemblyAI connection timed out after 10s")), 10000),
	);
	await Promise.race([streamingClient.connect(), connectTimeout]);

	const mic = new MicCapture({ sampleRate: 16000 });

	mic.on("data", (chunk: Buffer) => {
		streamingClient.sendAudio(chunk);
	});

	mic.on("error", (error: Error) => {
		log(`Mic error: ${error.message}`);
	});

	mic.on("started", () => {
		log("Mic capture started");
	});

	mic.start();
	log(`Recording "${name}" — send SIGINT or SIGTERM to stop`);

	// Graceful shutdown handler
	const shutdown = async () => {
		if (stopping) return;
		stopping = true;

		log("Stopping recording...");
		mic.stop();

		if (streamingClient.isConnected) {
			await streamingClient.disconnect();
		}

		const segmentCount = buffer.length;
		log(`${segmentCount} segments captured.`);

		if (segmentCount > 0) {
			try {
				log("Saving meeting and generating summary...");
				const savedPath = await saveMeeting({
					name,
					project,
					context,
					startTime,
					endTime: new Date(),
					segments: buffer.getSegmentsSince(-1).segments,
				});
				log(`Meeting saved to: ${savedPath}`);

				// Write the saved path to stdout so the caller can read it
				process.stdout.write(`${savedPath}\n`);
			} catch (error) {
				log(`Failed to save meeting: ${error instanceof Error ? error.message : String(error)}`);
			}
		} else {
			log("No segments captured - meeting not saved");
		}

		process.exit(0);
	};

	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);
}

startRecording().catch((error) => {
	log(`Fatal: ${error}`);
	process.exit(1);
});
