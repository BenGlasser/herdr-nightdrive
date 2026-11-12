#!/bin/sh
# Copies each panel mod's code into panels/<mod>/, where the dock imports it from: Herdr won't load
# a module from another mod's folder. The panel mods stay the source; run this after changing one.
cd "$(dirname "$0")" || exit 1
rm -rf panels
for m in nightdrive-files nightdrive-changes nightdrive-dash nightdrive-prs clickup standup posthog; do
  [ -f "../$m/main.js" ] || { echo "missing ../$m"; continue; }
  rm -rf "panels/$m"; mkdir -p "panels/$m"
  cp "../$m"/*.js "panels/$m/"
done
echo "panels synced: $(ls panels | tr '\n' ' ')"
