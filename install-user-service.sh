#!/bin/bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVICE_NAME="${SERVICE_NAME:-gstitch-mcproxy}"
TEMPLATE_PATH="${ROOT_DIR}/systemd/gstitch-mcproxy.service"
USER_SYSTEMD_DIR="${XDG_CONFIG_HOME:-${HOME}/.config}/systemd/user"
TARGET_PATH="${USER_SYSTEMD_DIR}/${SERVICE_NAME}.service"

mkdir -p "${USER_SYSTEMD_DIR}"
sed "s|__ROOT_DIR__|${ROOT_DIR}|g" "${TEMPLATE_PATH}" > "${TARGET_PATH}"

systemctl --user daemon-reload
systemctl --user enable --now "${SERVICE_NAME}.service"
systemctl --user status "${SERVICE_NAME}.service" --no-pager --lines=20