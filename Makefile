# LidlPrint — build shortcuts (zik4 style)
# Targets run from repo root: ~/dev/lidlprint

UI := ui

.PHONY: help devandroid buildandroid sync test clean

help:
	@echo "make devandroid   - build SPA + sync + assembleDebug + install (then launch AS / app)"
	@echo "make buildandroid - full release-ish rebuild: SPA + sync + assembleDebug"
	@echo "make sync         - quasar build + cap sync only"
	@echo "make test         - protocol + raster unit tests (Node)"
	@echo "make clean        - remove build outputs"

# Full dev loop: web build -> native sync -> APK -> install on attached device
devandroid: sync
	cd $(UI)/android && ./gradlew assembleDebug
	adb install -r $(UI)/android/app/build/outputs/apk/debug/app-debug.apk
	@echo "--- installed. launch: adb shell monkey -p com.gurzixo.lidlprint -c android.intent.category.LAUNCHER 1"

# Same without install (what Android Studio / AS build does)
buildandroid: sync
	cd $(UI)/android && ./gradlew assembleDebug

sync:
	cd $(UI) && npm run build
	cd $(UI) && npx cap sync android

test:
	node --test --experimental-strip-types test/*.test.ts

clean:
	rm -rf $(UI)/dist
	cd $(UI)/android && ./gradlew clean || true
