#!/bin/bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVICE_NAME="${SERVICE_NAME:-gstitch-mcproxy}"
TEMPLATE_PATH="${ROOT_DIR}/systemd/gstitch-mcproxy.system.service"
TMP_UNIT_PATH="$(mktemp)"
RUN_USER="${SUDO_USER:-${USER}}"
RUN_GROUP="$(id -gn "${RUN_USER}")"
HOME_DIR="$(getent passwd "${RUN_USER}" | cut -d: -f6)"
SYSTEM_UNIT_PATH="/etc/systemd/system/${SERVICE_NAME}.service"

cleanup() {
  rm -f "${TMP_UNIT_PATH}"
}

trap cleanup EXIT

sed \
  -e "s|__ROOT_DIR__|${ROOT_DIR}|g" \
  -e "s|__RUN_USER__|${RUN_USER}|g" \
  -e "s|__RUN_GROUP__|${RUN_GROUP}|g" \
  -e "s|__HOME_DIR__|${HOME_DIR}|g" \
  "${TEMPLATE_PATH}" > "${TMP_UNIT_PATH}"

sudo install -o root -g root -m 0644 "${TMP_UNIT_PATH}" "${SYSTEM_UNIT_PATH}"

if systemctl --user --quiet is-active "${SERVICE_NAME}.service"; then
  systemctl --user disable --now "${SERVICE_NAME}.service"
fi

sudo systemctl daemon-reload
sudo systemctl enable --now "${SERVICE_NAME}.service"
sudo systemctl status "${SERVICE_NAME}.service" --no-pager --lines=20