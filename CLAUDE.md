# MobScribe v2

Real-time meeting transcription service that streams audio to AssemblyAI and exposes transcripts to Claude Code via MCP.

## Architecture

```
Mic (SoX) → AssemblyAI WebSocket → Transcript Buffer → MCP Server → Claude Code
```

- **Audio capture**: SoX via child process, PCM 16-bit 16kHz mono
- **Transcription**: AssemblyAI Streaming SDK (Universal-Streaming model)
- **MCP Server**: Exposes tools for Claude Code to read transcript, get summaries, manage sessions
- **Context management**: Rolling summary + recent buffer to keep payloads right-sized for LLM consumption

## Project Structure

```
src/
  audio/          — Mic capture via SoX child process
  transcription/  — AssemblyAI streaming client
  mcp/            — MCP server with transcript tools
  context/        — Rolling summary + buffer management
  index.ts        — Entry point
tests/            — Vitest unit tests
```

## Setup

```bash
# Install dependencies
npm install

# Copy env and add your AssemblyAI API key
cp .env.example .env

# Requires SoX for audio capture
brew install sox
```

## Development

```bash
npm run build       # TypeScript compile
npm run typecheck   # Type check without emit
npm run check       # Biome lint + format
npm run test        # Run tests
npm run knip        # Dead code detection
```

## Permissions

- Mic access comes from the parent process (Terminal.app or IDE)
- No app bundle or signing needed — SoX inherits Terminal's mic permission
- AssemblyAI API key stored in .env (gitignored)

## Conventions

- No `any` types
- Biome for linting and formatting
- Tests alongside implementation in tests/ directory
