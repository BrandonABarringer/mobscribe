#!/bin/bash
# MobScribe Monitor — reads transcript file and feeds new content to Claude for analysis
# Usage: bash scripts/monitor.sh [interval_seconds]

INTERVAL=${1:-30}
TRANSCRIPT_FILE="/tmp/mobscribe-transcript.jsonl"
LAST_LINE_COUNT=0
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LOG_DIR="$SCRIPT_DIR/../logs"
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/monitor-$(date +%Y%m%d-%H%M%S).log"

log() {
  echo "[$(date +%H:%M:%S)] $1" | tee -a "$LOG_FILE"
}

approve() {
  bash "$SCRIPT_DIR/approve.sh" "$1" 60
  return $?
}

log "Monitor started. Polling every ${INTERVAL}s. Log: $LOG_FILE"
log "Watching: $TRANSCRIPT_FILE"

while true; do
  if [ ! -f "$TRANSCRIPT_FILE" ]; then
    sleep "$INTERVAL"
    continue
  fi

  CURRENT_LINE_COUNT=$(wc -l < "$TRANSCRIPT_FILE" | tr -d ' ')

  if [ "$CURRENT_LINE_COUNT" -le "$LAST_LINE_COUNT" ]; then
    sleep "$INTERVAL"
    continue
  fi

  NEW_LINES=$(tail -n +$((LAST_LINE_COUNT + 1)) "$TRANSCRIPT_FILE")
  LAST_LINE_COUNT=$CURRENT_LINE_COUNT

  FORMATTED=$(echo "$NEW_LINES" | while IFS= read -r line; do
    if [ -z "$line" ]; then continue; fi
    TEXT=$(echo "$line" | python3 -c "import sys,json; d=json.load(sys.stdin); ts=d['timestamp']; m=int(ts/60000); s=int((ts%60000)/1000); sp=f' [{d[\"speaker\"]}]' if d.get('speaker') else ''; print(f'[{m:02d}:{s:02d}]{sp} {d[\"text\"]}')" 2>/dev/null)
    if [ -n "$TEXT" ]; then
      echo "$TEXT"
    fi
  done)

  if [ -z "$FORMATTED" ]; then
    sleep "$INTERVAL"
    continue
  fi

  log "New transcript segments:"
  log "$FORMATTED"

  # Pass 1: Claude proposes an action (or NOTHING_TO_DO)
  PROPOSAL=$(claude -p "You are monitoring a live meeting for the R\West agency. You have access to Teamwork (project management), Slack, and web search.

New transcript:

$FORMATTED

If you identify something actionable, respond in this exact format:
ACTION: [one-line description of what you want to do]
DETAIL: [brief context for why]

Actionable items include:
- Someone asks a question that needs research
- A decision is made that should be logged
- An action item is assigned
- Someone directly asks you to do something
- A topic comes up that needs investigation

If nothing is actionable, respond with exactly: NOTHING_TO_DO

Only propose ONE action per response. Be selective — routine discussion is not actionable." 2>/dev/null)

  # Skip if nothing to do
  if [ "$PROPOSAL" = "NOTHING_TO_DO" ] || [ -z "$PROPOSAL" ]; then
    sleep "$INTERVAL"
    continue
  fi

  # Skip API errors — don't surface these as proposals
  if echo "$PROPOSAL" | grep -qi "API Error\|api_error\|Internal server error\|overloaded\|rate_limit"; then
    log "Claude API error (skipping): $(echo "$PROPOSAL" | head -1)"
    sleep "$INTERVAL"
    continue
  fi

  log "Proposed: $PROPOSAL"

  # Extract the action line for the dialog
  ACTION_LINE=$(echo "$PROPOSAL" | grep "^ACTION:" | sed 's/^ACTION: //')
  if [ -z "$ACTION_LINE" ]; then
    ACTION_LINE="$PROPOSAL"
  fi

  # Pass 2: Ask for approval via macOS dialog
  if approve "$ACTION_LINE"; then
    log "APPROVED: $ACTION_LINE"

    # Pass 3: Execute the approved action
    RESULT=$(claude -p "You previously proposed this action based on a meeting transcript:

$PROPOSAL

The user approved this action. Now execute it. You have access to:
- Teamwork MCP (tasks, notebooks, comments)
- Slack MCP (messages)
- Web search

Do it now and report what you did." 2>/dev/null)

    # Check if execution hit an API error
    if echo "$RESULT" | grep -qi "API Error\|api_error\|Internal server error\|overloaded\|rate_limit"; then
      log "Execution failed (API error): $(echo "$RESULT" | head -1)"
      osascript -e "display notification \"Action failed — API error. Will retry next cycle.\" with title \"MobScribe\"" 2>/dev/null
    else
      log "EXECUTED: $RESULT"
      osascript -e "display notification \"$ACTION_LINE\" with title \"MobScribe\" subtitle \"Action completed\"" 2>/dev/null
    fi
  else
    log "DENIED: $ACTION_LINE"
  fi

  sleep "$INTERVAL"
done
