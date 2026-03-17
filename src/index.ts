import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { MicCapture } from "./audio/mic-capture.js";
import { TranscriptBuffer } from "./context/transcript-buffer.js";
import { createMcpServer } from "./mcp/server.js";
import { saveMeeting } from "./storage/meeting-storage.js";
import { StreamingClient } from "./transcription/streaming-client.js";

/** Log to stderr so stdout stays clean for MCP JSON-RPC */
function log(message: string): void {
	process.stderr.write(`[mobscribe] ${message}\n`);
}

const apiKey = process.env.ASSEMBLYAI_API_KEY;
if (!apiKey) {
	log("ERROR: ASSEMBLYAI_API_KEY not set. Copy .env.example to .env and add your key.");
	process.exit(1);
}
// Narrowed to string after the exit guard
const resolvedApiKey: string = apiKey;

// Shared state
const buffer = new TranscriptBuffer();
let mic: MicCapture | null = null;
let streamingClient: StreamingClient | null = null;

// Session metadata for persistence
let sessionMetadata: {
	name: string;
	project?: string;
	context?: string;
	startTime: Date;
} | null = null;

async function startSession(name: string, project?: string, context?: string): Promise<void> {
	if (mic?.isRecording) {
		throw new Error("Session already in progress");
	}

	log(`Starting session: ${name}`);
	buffer.clear();

	// Store session metadata for persistence
	sessionMetadata = {
		name,
		project,
		context,
		startTime: new Date(),
	};

	// Set up transcription client
	streamingClient = new StreamingClient({
		apiKey: resolvedApiKey,
		sampleRate: 16000,
		onSegment: (segment) => {
			if (segment.isFinal) {
				buffer.addSegment(segment);
				log(`[final] ${segment.text}`);
			} else {
				log(`[partial] ${segment.text}`);
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

	// Connect with timeout — fail fast so the MCP tool call returns
	const connectTimeout = new Promise<never>((_, reject) =>
		setTimeout(() => reject(new Error("AssemblyAI connection timed out after 10s")), 10000),
	);
	await Promise.race([streamingClient.connect(), connectTimeout]);

	// Set up mic capture and pipe to transcription
	mic = new MicCapture({ sampleRate: 16000 });

	mic.on("data", (chunk: Buffer) => {
		streamingClient?.sendAudio(chunk);
	});

	mic.on("error", (error: Error) => {
		log(`Mic error: ${error.message}`);
	});

	mic.on("started", () => {
		log("Mic capture started");
	});

	mic.on("stopped", () => {
		log("Mic capture stopped");
	});

	mic.start();
	log(`Session "${name}" recording`);
}

async function stopSession(): Promise<string | undefined> {
	if (mic?.isRecording) {
		mic.stop();
	}
	mic = null;

	if (streamingClient?.isConnected) {
		await streamingClient.disconnect();
	}
	streamingClient = null;

	const segmentCount = buffer.length;
	log(`Session stopped. ${segmentCount} segments captured.`);

	let savedPath: string | undefined;

	// Save meeting if we have session metadata and segments
	if (sessionMetadata && segmentCount > 0) {
		try {
			log("Saving meeting...");
			savedPath = await saveMeeting({
				name: sessionMetadata.name,
				project: sessionMetadata.project,
				context: sessionMetadata.context,
				startTime: sessionMetadata.startTime,
				endTime: new Date(),
				segments: buffer.getSegmentsSince(-1).segments,
			});
			log(`Meeting saved to: ${savedPath}`);
		} catch (error) {
			log(`Failed to save meeting: ${error instanceof Error ? error.message : String(error)}`);
		}
	} else if (segmentCount === 0) {
		log("No segments captured - meeting not saved");
	}

	// Clear session metadata
	sessionMetadata = null;

	return savedPath;
}

// Create MCP server with session controls
const server = createMcpServer({
	buffer,
	onStartSession: startSession,
	onStopSession: stopSession,
});

// Connect MCP server via stdio
async function main(): Promise<void> {
	const transport = new StdioServerTransport();
	await server.connect(transport);
	log("MCP server running on stdio");

	// Graceful shutdown
	process.on("SIGINT", async () => {
		log("Shutting down...");
		await stopSession();
		process.exit(0);
	});

	process.on("SIGTERM", async () => {
		log("Shutting down...");
		await stopSession();
		process.exit(0);
	});
}

main().catch((error) => {
	log(`Fatal: ${error}`);
	process.exit(1);
});
