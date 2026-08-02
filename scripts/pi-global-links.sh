#!/bin/sh
set -eu

SCRIPT_DIRECTORY=$(CDPATH= cd "$(dirname "$0")" && pwd -P)
REPOSITORY_ROOT=$(dirname "$SCRIPT_DIRECTORY")
AGENT_DIRECTORY=${PI_CODING_AGENT_DIR:-"$HOME/.pi/agent"}

case "$AGENT_DIRECTORY" in
  /*) ;;
  *) AGENT_DIRECTORY="$PWD/$AGENT_DIRECTORY" ;;
esac

EXTENSION_NAMES="goal plan lsp ast-grep hashline request rg todo jaron diffreport telemetry enforce notify doclint loop"

usage() {
  cat <<'EOF'
Usage: ./scripts/pi-global-links.sh <action> [scope]

Manage this repository's Pi global extension and theme symlinks.

Actions:
  on | enable       Create missing managed links
  off | disable     Remove managed links
  toggle            Turn all selected links off when enabled; otherwise turn them on
  status            Show link and active-theme state (default)

Scopes:
  all               Fifteen extensions and every pi-extensions-*.json theme (default)
  extensions        goal, plan, lsp, ast-grep, hashline, request, rg, todo, jaron, diffreport, telemetry, enforce, notify, doclint, and loop
  themes            Repository-owned global themes

Conflicting files, directories, and foreign symlinks are never overwritten or
removed. Theme links cannot be disabled while settings.json selects a managed
theme; select a built-in theme through /settings first.
EOF
}

fail() {
  printf '%s\n' "$*" >&2
  exit 1
}

for_extensions() {
  extension_callback=$1
  for extension_name in $EXTENSION_NAMES; do
    "$extension_callback" \
      "extensions" \
      "$extension_name" \
      "$REPOSITORY_ROOT/$extension_name" \
      "$AGENT_DIRECTORY/extensions/$extension_name"
  done
}

for_themes() {
  theme_callback=$1
  theme_found=0
  for theme_source in "$REPOSITORY_ROOT"/themes/pi-extensions-*.json; do
    [ -f "$theme_source" ] || continue
    theme_found=1
    theme_name=${theme_source##*/}
    "$theme_callback" \
      "themes" \
      "$theme_name" \
      "$theme_source" \
      "$AGENT_DIRECTORY/themes/$theme_name"
  done
  [ "$theme_found" -eq 1 ] || fail "No managed themes found under $REPOSITORY_ROOT/themes"
}

for_selected() {
  selected_callback=$1
  case "$SCOPE" in
    all)
      for_extensions "$selected_callback"
      for_themes "$selected_callback"
      ;;
    extensions) for_extensions "$selected_callback" ;;
    themes) for_themes "$selected_callback" ;;
  esac
}

classify_item() {
  item_source=$1
  item_target=$2
  [ -e "$item_source" ] || fail "Missing repository resource: $item_source"

  if [ -L "$item_target" ]; then
    if [ "$item_target" -ef "$item_source" ]; then
      CLASS_STATE=on
      CLASS_DETAIL=$(readlink "$item_target")
    else
      CLASS_STATE=conflict
      CLASS_DETAIL="symlink -> $(readlink "$item_target")"
    fi
  elif [ -e "$item_target" ]; then
    CLASS_STATE=conflict
    if [ -d "$item_target" ]; then
      CLASS_DETAIL="existing directory"
    else
      CLASS_DETAIL="existing file"
    fi
  else
    CLASS_STATE=off
    CLASS_DETAIL=missing
  fi
}

preflight_item() {
  item_category=$1
  item_name=$2
  item_source=$3
  item_target=$4
  classify_item "$item_source" "$item_target"
  if [ "$CLASS_STATE" = conflict ]; then
    CONFLICT_COUNT=$((CONFLICT_COUNT + 1))
    CONFLICT_LINES="$CONFLICT_LINES
  $item_target: $CLASS_DETAIL"
  fi
}

preflight() {
  CONFLICT_COUNT=0
  CONFLICT_LINES=
  for_selected preflight_item
  if [ "$CONFLICT_COUNT" -gt 0 ]; then
    printf 'Managed target conflicts detected; no changes made:%s\n' "$CONFLICT_LINES" >&2
    exit 1
  fi
}

read_active_theme() {
  settings_path="$AGENT_DIRECTORY/settings.json"
  ACTIVE_THEME="(not configured)"
  [ -f "$settings_path" ] || return 0

  parsed_theme=$(sed -n 's/.*"theme"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$settings_path" | sed -n '1p')
  if [ -n "$parsed_theme" ]; then
    ACTIVE_THEME=$parsed_theme
  elif grep -q 'pi-extensions-' "$settings_path"; then
    ACTIVE_THEME="(unparsed managed theme)"
  fi
}

check_theme_can_be_disabled() {
  case "$SCOPE" in
    all|themes) ;;
    extensions) return 0 ;;
  esac

  read_active_theme
  case "$ACTIVE_THEME" in
    *pi-extensions-*|"(unparsed managed theme)")
      fail "Cannot disable managed theme links while the active theme is '$ACTIVE_THEME'. Choose a built-in theme through /settings, then retry. No links changed."
      ;;
  esac
}

enable_item() {
  item_category=$1
  item_name=$2
  item_source=$3
  item_target=$4
  classify_item "$item_source" "$item_target"
  [ "$CLASS_STATE" = off ] || return 0

  mkdir -p "$AGENT_DIRECTORY/$item_category"
  ln -s "$item_source" "$item_target"
  CHANGED_COUNT=$((CHANGED_COUNT + 1))
}

disable_item() {
  item_category=$1
  item_name=$2
  item_source=$3
  item_target=$4
  classify_item "$item_source" "$item_target"
  [ "$CLASS_STATE" = on ] || return 0

  unlink "$item_target"
  CHANGED_COUNT=$((CHANGED_COUNT + 1))
}

inspect_toggle_item() {
  item_category=$1
  item_name=$2
  item_source=$3
  item_target=$4
  classify_item "$item_source" "$item_target"
  [ "$CLASS_STATE" = on ] || ALL_ON=0
}

status_item() {
  item_category=$1
  item_name=$2
  item_source=$3
  item_target=$4
  classify_item "$item_source" "$item_target"

  detail=
  if [ "$CLASS_STATE" = conflict ]; then
    detail=" ($CLASS_DETAIL)"
    STATUS_CONFLICTS=$((STATUS_CONFLICTS + 1))
  fi
  case "$CLASS_STATE" in
    on) STATUS_ON=$((STATUS_ON + 1)) ;;
    off) STATUS_OFF=$((STATUS_OFF + 1)) ;;
  esac
  printf '  %-8s %s%s\n' "$CLASS_STATE" "$item_name" "$detail"
}

print_status() {
  STATUS_ON=0
  STATUS_OFF=0
  STATUS_CONFLICTS=0
  printf 'Pi agent directory: %s\n' "$AGENT_DIRECTORY"

  case "$SCOPE" in
    all|extensions)
      printf 'extensions:\n'
      for_extensions status_item
      ;;
  esac
  case "$SCOPE" in
    all|themes)
      printf 'themes:\n'
      for_themes status_item
      read_active_theme
      printf 'Active theme: %s\n' "$ACTIVE_THEME"
      ;;
  esac

  printf 'Summary: %s on, %s off, %s conflicts\n' "$STATUS_ON" "$STATUS_OFF" "$STATUS_CONFLICTS"
  [ "$STATUS_CONFLICTS" -eq 0 ]
}

[ "$#" -le 2 ] || fail "Expected an action and optional scope"
ACTION=${1:-status}
SCOPE=${2:-all}

case "$ACTION" in
  -h|--help)
    usage
    exit 0
    ;;
  enable) ACTION=on ;;
  disable) ACTION=off ;;
  on|off|toggle|status) ;;
  *) fail "Unknown action: $ACTION" ;;
esac

case "$SCOPE" in
  extension) SCOPE=extensions ;;
  theme) SCOPE=themes ;;
  all|extensions|themes) ;;
  *) fail "Unknown scope: $SCOPE" ;;
esac

if [ "$ACTION" = status ]; then
  print_status || exit 1
  exit 0
fi

preflight
if [ "$ACTION" = toggle ]; then
  ALL_ON=1
  for_selected inspect_toggle_item
  if [ "$ALL_ON" -eq 1 ]; then
    ACTION=off
  else
    ACTION=on
  fi
fi

CHANGED_COUNT=0
case "$ACTION" in
  on)
    for_selected enable_item
    printf 'Enabled %s managed link(s).\n' "$CHANGED_COUNT"
    ;;
  off)
    check_theme_can_be_disabled
    for_selected disable_item
    printf 'Disabled %s managed link(s).\n' "$CHANGED_COUNT"
    ;;
esac

print_status || exit 1
printf '%s\n' "Restart Pi to apply discovery and theme changes."
