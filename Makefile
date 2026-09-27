# LidlPrint — build shortcuts (zik4 style)
# Targets run from repo root: ~/dev/lidlprint
#
# devandroid  : starts the quasar DEV SERVER (HMR). The WebView loads live
#               code from vroum — no AS rebuild needed for JS changes.
#               Native (Kotlin/java) changes still need an AS Run.
# buildandroid: builds the bundled SPA, syncs it, then opens Android Studio —
#               you compile + upload the (debug) APK from AS.
# installadb  : same as buildandroid but installs via adb, headless.
#
# Loop by turns:
#   1. Agent modifies code and says "ok"
#   2. JS-only change  -> make devandroid (server already running? just save)
#      Native change   -> make buildandroid, compile in AS, upload
#   3. You run + test with devtools open
#   4. You report results/hints back

UI := ui
CAP := ui/src-capacitor/android
ANDROID_JAVA_HOME=$(strip $(shell if [ -n "$$JAVA_HOME" ]; then printf '%s' "$$JAVA_HOME"; elif [ -d "$(HOME)/android-studio/jbr" ]; then printf '%s' "$(HOME)/android-studio/jbr"; elif [ -d "/opt/android-studio/jbr" ]; then printf '%s' "/opt/android-studio/jbr"; fi))
ANDROID_JAVA_ENV=$(if $(strip $(ANDROID_JAVA_HOME)),JAVA_HOME="$(ANDROID_JAVA_HOME)" PATH="$(ANDROID_JAVA_HOME)/bin:$$PATH",)

.PHONY: help devandroid buildandroid installadb sync test clean

help:
	@echo "make devandroid   - quasar DEV SERVER (HMR); WebView loads live code"
	@echo "make buildandroid - bundled SPA + cap sync + open AS (you build/upload)"
	@echo "make installadb   - bundled SPA + cap sync + gradle + adb install"
	@echo "make sync         - quasar build + cap sync only"
	@echo "make test         - protocol + raster unit tests (Node)"
	@echo "make clean        - remove build outputs"

devandroid:
	@echo "--- quasar dev server starting (HMR). WebView loads live from vroum."
	@echo "--- Keep it running; AS Run only needed after NATIVE (java) changes."
	cd $(UI) && npx quasar dev -m capacitor -T android

buildandroid: sync
	@echo "--- JS bundled + synced. Launching Android Studio on $(CURDIR)/$(CAP)"
	@if [ -x "$(HOME)/android-studio/bin/studio.sh" ]; then \
	  nohup env JAVA_HOME="$(HOME)/android-studio/jbr" "$(HOME)/android-studio/bin/studio.sh" "$(CURDIR)/$(CAP)" >/dev/null 2>&1 & \
	  echo "--- AS launching. Compile (debug) + Run from AS to upload."; \
	else \
	  echo "!!! $(HOME)/android-studio/bin/studio.sh not found — open $(CURDIR)/$(CAP) in AS manually"; \
	fi

installadb: sync
	cd $(CAP) && $(ANDROID_JAVA_ENV) ./gradlew assembleDebug
	adb install -r $(CAP)/app/build/outputs/apk/debug/app-debug.apk
	@echo "--- installed. launch: adb shell monkey -p com.gurzixo.lidlprint -c android.intent.category.LAUNCHER 1"

sync:
	cd $(UI) && npm run build
	cd $(UI) && npx cap sync android
	@# cap sync regenerates this with a newer AGP than the installed AS supports
	sed -i 's/com.android.tools.build:gradle:[0-9.]*/com.android.tools.build:gradle:8.9.2/' $(CAP)/capacitor-cordova-android-plugins/build.gradle

test:
	node --test --experimental-strip-types test/*.test.ts

clean:
	rm -rf $(UI)/dist
	cd $(CAP) && $(ANDROID_JAVA_ENV) ./gradlew clean || true
