# MobScribe

Real-time meeting transcription MCP server for [Claude Code](https://docs.anthropic.com/en/docs/claude-code). Records audio, streams it to AssemblyAI for transcription, and exposes the transcript through MCP tools — so Claude can listen to your meetings in real time.

After a meeting ends, MobScribe automatically saves the transcript and generates a structured summary (topics, decisions, action items) using Claude. Past meetings are queryable through MCP tools.

## Architecture

```
Mic (SoX) → AssemblyAI WebSocket → Transcript Buffer → MCP Server → Claude Code
```

- **Audio capture**: SoX via child process, PCM 16-bit 16kHz mono
- **Transcription**: AssemblyAI Streaming SDK with speaker diarization
- **MCP Server**: Exposes tools for reading transcripts, managing sessions, and querying past meetings
- **Meeting persistence**: Auto-saves to `~/meetings/` with AI-generated summaries
- **Monitor script**: Autonomous meeting agent with macOS approval gate for proposed actions

## MCP Tools

### Live session
| Tool | Description |
|------|-------------|
| `session_start` | Start a new transcription session with name, project, and context |
| `session_stop` | Stop recording — automatically saves transcript and generates summary |
| `transcript_get_new` | Get new segments since last read (cursor-based) |
| `transcript_get_full` | Get the complete transcript from the current session |
| `transcript_get_recent` | Get the most recent N segments |
| `transcript_status` | Get segment count and cursor position |

### Past meetings
| Tool | Description |
|------|-------------|
| `meeting_list` | List all past meetings (filterable by date, project, speaker) |
| `meeting_search` | Search across meeting summaries by keyword |
| `meeting_summary` | Get a meeting's metadata and auto-generated summary |
| `meeting_get` | Get full meeting data including complete transcript |

## Setup

```bash
# Install dependencies
npm install

# Copy env and add your AssemblyAI API key
cp .env.example .env

# Requires SoX for audio capture
brew install sox

# Build
npm run build
```

### Claude Code MCP configuration

Add to your Claude Code MCP settings:

```json
{
  "mcpServers": {
    "mobscribe": {
      "command": "node",
      "args": ["/path/to/mobscribe/dist/index.js"],
      "env": {
        "ASSEMBLYAI_API_KEY": "your_key_here"
      }
    }
  }
}
```

## Meeting persistence

When a session stops, MobScribe saves three files to `~/meetings/YYYY-MM-DD-meeting-name/`:

- **metadata.json** — Meeting name, project, date, duration, speakers
- **summary.json** — AI-generated overview, topics, decisions, action items, key moments
- **transcript.jsonl** — Raw transcript segments with timestamps and speaker labels

Summaries are generated using Claude (Opus) via the CLI.

## Monitor script

The monitor script runs alongside the MCP server and autonomously watches the transcript for actionable items:

```bash
bash scripts/monitor.sh [interval_seconds]
```

It polls the transcript file, feeds new segments to Claude, and if Claude identifies something actionable (a question to research, a decision to log, an action item), it pops a macOS dialog for approval before executing.

## Development

```bash
npm run build       # TypeScript compile
npm run typecheck   # Type check without emit
npm run check       # Biome lint + format
npm run test        # Run tests
```

## Requirements

- Node.js 20+
- macOS (for SoX mic permissions and AppleScript approval dialogs)
- [AssemblyAI](https://www.assemblyai.com/) API key
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI (for summary generation and monitor script)
- SoX (`brew install sox`)

## License

ISC
