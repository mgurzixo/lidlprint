# LidlPrint — build shortcuts (zik4 style)
# Targets run from repo root: ~/dev/lidlprint
#
# devandroid  : starts quasar dev (HMR server) AND opens Android Studio on
#               ui/android — press Run in AS to deploy; the WebView loads the
#               dev server with live reload.
# buildandroid: full SPA build + cap sync + assembleDebug + adb install.

UI := ui
ANDROID_JAVA_HOME=$(strip $(shell if [ -n "$$JAVA_HOME" ]; then printf '%s' "$$JAVA_HOME"; elif [ -d "$(HOME)/android-studio/jbr" ]; then printf '%s' "$(HOME)/android-studio/jbr"; elif [ -d "/opt/android-studio/jbr" ]; then printf '%s' "/opt/android-studio/jbr"; fi))
ANDROID_JAVA_ENV=$(if $(strip $(ANDROID_JAVA_HOME)),JAVA_HOME="$(ANDROID_JAVA_HOME)" PATH="$(ANDROID_JAVA_HOME)/bin:$$PATH",)

.PHONY: help devandroid buildandroid sync test clean

help:
	@echo "make devandroid   - quasar dev (HMR) + launch Android Studio on ui/android"
	@echo "make buildandroid - SPA build + cap sync + assembleDebug + adb install"
	@echo "make sync         - quasar build + cap sync only"
	@echo "make test         - protocol + raster unit tests (Node)"
	@echo "make clean        - remove build outputs"

devandroid: sync-dev
	@echo "--- quasar opens Android Studio itself (bin.linuxAndroidStudio). Press Run in AS."
	cd $(UI) && $(ANDROID_JAVA_ENV) npx quasar dev -m capacitor -T android

# Build web assets + sync so AS/gradle always has fresh www assets
sync-dev:
	cd $(UI) && npx quasar build -m spa
	cd $(UI) && npx cap sync android

buildandroid: sync
	cd $(UI)/android && $(ANDROID_JAVA_ENV) ./gradlew assembleDebug
	adb install -r $(UI)/android/app/build/outputs/apk/debug/app-debug.apk
	@echo "--- installed. launch: adb shell monkey -p com.gurzixo.lidlprint -c android.intent.category.LAUNCHER 1"

sync:
	cd $(UI) && npm run build
	cd $(UI) && npx cap sync android

test:
	node --test --experimental-strip-types test/*.test.ts

clean:
	rm -rf $(UI)/dist
	cd $(UI)/android && $(ANDROID_JAVA_ENV) ./gradlew clean || true
