#!/bin/sh
set -eu

STATE_DIR="${STATE_DIR:-/app/state}"
LAST_RUN_FILE="${STATE_DIR}/last_run_date"
SCHEDULE_HOUR="${SCHEDULE_HOUR:-10}"
SCHEDULE_MINUTE="${SCHEDULE_MINUTE:-0}"
# Window (seconds) after scheduled time during which a missed run is still
# allowed to fire. Beyond this, today is skipped — no backfill.
SCHEDULE_WINDOW_SEC="${SCHEDULE_WINDOW_SEC:-600}"

mkdir -p "${STATE_DIR}"

run_if_due() {
    today="$(date +%F)"
    dow="$(date +%u)"
    now_epoch="$(date +%s)"
    target_epoch="$(date -d "${today} ${SCHEDULE_HOUR}:${SCHEDULE_MINUTE}:00" +%s)"
    last_run_date=""

    # Skip Sat (6) and Sun (7).
    if [ "${dow}" -ge 6 ]; then
        return 0
    fi

    if [ -f "${LAST_RUN_FILE}" ]; then
        last_run_date="$(cat "${LAST_RUN_FILE}")"
    fi

    if [ "${last_run_date}" = "${today}" ]; then
        return 0
    fi

    if [ "${now_epoch}" -lt "${target_epoch}" ]; then
        return 0
    fi

    if [ "${now_epoch}" -ge "$(( target_epoch + SCHEDULE_WINDOW_SEC ))" ]; then
        return 0
    fi

    echo "[scheduler] running check-in for ${today}"
    if /app/scripts/run-checkin.sh; then
        printf '%s\n' "${today}" > "${LAST_RUN_FILE}"
        echo "[scheduler] run completed for ${today}"
    else
        status=$?
        echo "[scheduler] run failed with status ${status}"
        return "${status}"
    fi
}

echo "[scheduler] started (TZ=${TZ:-unset}, SCHEDULE_HOUR=${SCHEDULE_HOUR}, SCHEDULE_MINUTE=${SCHEDULE_MINUTE}, WINDOW_SEC=${SCHEDULE_WINDOW_SEC})"

while true; do
    run_if_due || true
    sleep 60
done
