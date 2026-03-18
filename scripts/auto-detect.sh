#!/bin/bash
# MobScribe Auto-Detect — monitors for active conferencing connections
# and prompts to start recording when a meeting is detected.
#
# Usage: bash scripts/auto-detect.sh [poll_interval_seconds]
#
# Monitors UDP ports used by conferencing apps:
#   - Zoom: 8801-8810, 3478-3479
#   - Slack huddles: 3478
#   - Teams: 3478-3481
#   - Generic WebRTC/STUN: 3478
#
# Meeting names are auto-generated from the transcript summary after recording.

POLL_INTERVAL=${1:-5}
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DEBOUNCE_SECONDS=2
COOLDOWN_SECONDS=30

# State
MEETING_ACTIVE=false
MEETING_SKIPPED=false
DETECTION_START=0
LAST_MEETING_END=0
MONITOR_PID=""

log() {
  echo "[$(date +%H:%M:%S)] $1"
}

# Detect conferencing UDP connections and return the app name
detect_meeting() {
  # Check standard conferencing ports (Zoom, Teams, generic WebRTC/STUN)
  local pids
  pids=$(lsof -ti UDP:3478-3481,8801-8810 2>/dev/null | sort -u)

  # Also check for Slack huddles — they use UDP:443 (QUIC/WebRTC)
  local slack_udp_pids
  slack_udp_pids=$(lsof -i UDP:443 -P 2>/dev/null | grep -i slack | awk '{print $2}' | sort -u)

  # Combine all PIDs
  local all_pids
  all_pids=$(echo "$pids $slack_udp_pids" | tr ' ' '\n' | grep -v '^$' | sort -u)

  if [ -z "$all_pids" ]; then
    echo ""
    return 1
  fi

  for pid in $all_pids; do
    local app_path
    app_path=$(ps -p "$pid" -o comm= 2>/dev/null)

    if [ -z "$app_path" ]; then
      continue
    fi

    case "$app_path" in
      *zoom* | *CptHost* | *caphost*)
        echo "zoom"
        return 0
        ;;
      *Slack* | *slack*)
        echo "slack"
        return 0
        ;;
      *Teams* | *teams*)
        echo "teams"
        return 0
        ;;
    esac
  done

  echo "unknown"
  return 0
}

# Generate a default meeting name from the app
default_name() {
  local app="$1"
  local time_str
  time_str=$(date +"%I:%M%p" | sed 's/^0//')

  case "$app" in
    zoom)  echo "Zoom Meeting $time_str" ;;
    slack) echo "Slack Huddle $time_str" ;;
    teams) echo "Teams Meeting $time_str" ;;
    *)     echo "Meeting $time_str" ;;
  esac
}

# Prompt user to start recording
prompt_record() {
  local app="$1"
  local app_label=""
  case "$app" in
    zoom)  app_label="Zoom meeting" ;;
    slack) app_label="Slack huddle" ;;
    teams) app_label="Teams meeting" ;;
    *)     app_label="Meeting" ;;
  esac

  local result
  result=$(osascript -e "
    display dialog \"$app_label detected. Start recording?\" & return & return & \"The meeting will be named automatically from the conversation.\" with title \"MobScribe\" buttons {\"Skip\", \"Record\"} default button \"Record\" giving up after 30
  " 2>&1)

  if echo "$result" | grep -q "Record"; then
    return 0
  else
    return 1
  fi
}

# Start MobScribe recording directly via Node
start_recording() {
  local name="$1"
  log "Starting recording: $name"

  MOBSCRIBE_DIR="$SCRIPT_DIR/.."

  # Load .env for AssemblyAI key
  if [ -f "$MOBSCRIBE_DIR/.env" ]; then
    export $(grep -v '^#' "$MOBSCRIBE_DIR/.env" | xargs)
  fi

  # Start recorder process in background — stays alive until SIGTERM
  node "$MOBSCRIBE_DIR/dist/record.js" --name "$name" &
  RECORDER_PID=$!
  log "Recorder started (PID: $RECORDER_PID)"

  # Give it a moment to connect before starting the monitor
  sleep 3

  # Start the monitor script in the background
  bash "$SCRIPT_DIR/monitor.sh" 30 &
  MONITOR_PID=$!
  log "Monitor started (PID: $MONITOR_PID)"

  osascript -e "display notification \"Recording started\" with title \"MobScribe\" subtitle \"$name\"" 2>/dev/null
}

# Stop MobScribe recording
stop_recording() {
  log "Meeting ended. Stopping recording and generating summary..."

  # Kill monitor first
  if [ -n "$MONITOR_PID" ] && kill -0 "$MONITOR_PID" 2>/dev/null; then
    kill "$MONITOR_PID" 2>/dev/null
    log "Monitor stopped"
  fi
  MONITOR_PID=""

  # Send SIGTERM to recorder — triggers save + summary generation
  if [ -n "$RECORDER_PID" ] && kill -0 "$RECORDER_PID" 2>/dev/null; then
    kill "$RECORDER_PID"
    log "Recorder stopping (saving meeting and generating summary)..."
    # Wait for it to finish saving
    wait "$RECORDER_PID" 2>/dev/null
    log "Recorder stopped"
  fi
  RECORDER_PID=""

  osascript -e "display notification \"Recording saved. Summary generating...\" with title \"MobScribe\"" 2>/dev/null

  LAST_MEETING_END=$(date +%s)
}

# Main loop
log "MobScribe Auto-Detect started"
log "Polling every ${POLL_INTERVAL}s | Debounce: ${DEBOUNCE_SECONDS}s | Cooldown: ${COOLDOWN_SECONDS}s"
log "Monitoring UDP ports: 3478-3481, 8801-8810"

while true; do
  app=$(detect_meeting)
  now=$(date +%s)

  if [ -n "$app" ]; then
    if [ "$MEETING_ACTIVE" = false ] && [ "$MEETING_SKIPPED" = false ]; then
      # New meeting detected — start debounce
      if [ "$DETECTION_START" -eq 0 ]; then
        DETECTION_START=$now
        log "Conferencing connection detected ($app). Waiting ${DEBOUNCE_SECONDS}s to confirm..."
      fi

      elapsed=$((now - DETECTION_START))

      if [ "$elapsed" -ge "$DEBOUNCE_SECONDS" ]; then
        # Check cooldown
        since_last=$((now - LAST_MEETING_END))
        if [ "$LAST_MEETING_END" -gt 0 ] && [ "$since_last" -lt "$COOLDOWN_SECONDS" ]; then
          sleep "$POLL_INTERVAL"
          continue
        fi

        # Debounce passed — prompt user
        log "Meeting confirmed ($app)"

        if prompt_record "$app"; then
          MEETING_ACTIVE=true
          name=$(default_name "$app")
          start_recording "$name"
        else
          log "Recording skipped by user"
          MEETING_SKIPPED=true
        fi

        DETECTION_START=0
      fi
    fi
  else
    # No meeting detected — reset state
    DETECTION_START=0

    if [ "$MEETING_ACTIVE" = true ]; then
      stop_recording
      MEETING_ACTIVE=false
    fi

    MEETING_SKIPPED=false
  fi

  sleep "$POLL_INTERVAL"
done
