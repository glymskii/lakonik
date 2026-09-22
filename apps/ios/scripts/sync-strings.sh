#!/bin/sh
# Обновляет каталог строк из результатов последней сборки (xcodebuild не синхронизирует .xcstrings сам, в отличие от Xcode).
# Использование: после `xcodebuild ... -derivedDataPath /tmp/adv-sim build` → ./scripts-sync-strings.sh /tmp/adv-sim
set -e
DD="${1:-/tmp/adv-sim}"
FILES=$(find "$DD/Build/Intermediates.noindex/Lakonik.build" -path "*/Objects-normal/arm64/*.stringsdata" | grep -v "Widgets\|Broadcast")
xcrun xcstringstool sync "$(dirname "$0")/../Lakonik/Resources/Localizable.xcstrings" --stringsdata $FILES
python3 -c "import json;d=json.load(open('$(dirname "$0")/../Lakonik/Resources/Localizable.xcstrings'));print('строк в каталоге:',len(d['strings']))"
