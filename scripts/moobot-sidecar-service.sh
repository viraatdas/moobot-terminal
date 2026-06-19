#!/usr/bin/env bash
# Manage the persistent Moobot sidecar — the launchd service that keeps the auto-trader
# (and lenses) running continuously, even when the app window is closed.
#
#   scripts/moobot-sidecar-service.sh start    # load + run (survives app close, login, reboot)
#   scripts/moobot-sidecar-service.sh stop     # stop it entirely (no autonomous trading)
#   scripts/moobot-sidecar-service.sh restart  # bounce it (e.g. after a sidecar code change)
#   scripts/moobot-sidecar-service.sh status   # is it running? pid?
#   scripts/moobot-sidecar-service.sh logs     # tail the sidecar log
#
# To PAUSE trading without stopping the service, open the app and either Stand down
# (back to paper) or flip Auto-approve off — both halt placement while the sidecar runs.
set -uo pipefail

PLIST="$HOME/Library/LaunchAgents/dev.viraat.moobot-sidecar.plist"
LABEL="dev.viraat.moobot-sidecar"
DOMAIN="gui/$(id -u)"

case "${1:-status}" in
  start|enable)
    launchctl bootstrap "$DOMAIN" "$PLIST" 2>/dev/null && echo "started" \
      || { launchctl kickstart -k "$DOMAIN/$LABEL" 2>/dev/null && echo "already loaded — kickstarted"; }
    ;;
  stop|disable)
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null && echo "stopped" || echo "not running"
    ;;
  restart)
    launchctl kickstart -k "$DOMAIN/$LABEL" 2>/dev/null && echo "restarted" || echo "not loaded — run 'start'"
    ;;
  status)
    launchctl print "$DOMAIN/$LABEL" 2>/dev/null | grep -E "state =|pid =" || echo "not loaded"
    ;;
  logs)
    tail -n 100 -f "$HOME/Library/Logs/moobot-sidecar.log"
    ;;
  *)
    echo "usage: $0 {start|stop|restart|status|logs}"
    exit 1
    ;;
esac
