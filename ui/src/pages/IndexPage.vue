<template>
  <q-page class="column page">
    <!-- ① Banner -->
    <div class="banner row items-center no-wrap q-gutter-x-sm">
      <q-btn
        unelevated
        no-caps
        class="col-auto connect-btn"
        :label="connectLabel"
        :color="connectColor"
        :disable="btState === 'connecting'"
        @click="onConnectTap"
      />
      <div class="col msg" :class="msgClass">{{ btMessage }}</div>
      <div class="col-auto text-caption text-grey-5 self-center">v{{ appVersion }}</div>
    </div>

    <!-- ② Preview -->
    <div
      ref="zoneRef"
      class="col column items-center justify-center q-pa-md preview-zone"
    >
      <template v-if="preview.url">
        <div class="paper relative-position" :style="paperStyle">
          <img :src="preview.url" class="preview-img" alt="print preview" />
        </div>
        <div class="text-caption text-grey-7 q-mt-sm">
          prints at 384 × {{ preview.rows }} dots
        </div>
      </template>
      <div v-else class="text-grey-6 text-center q-pa-xl">
        Share, Paste or Pick an image.
        <div class="row justify-center q-gutter-sm q-mt-sm">
          <q-btn round unelevated size="22px" color="primary" icon="add_photo_alternate" @click="pickImage">
            <q-tooltip>Pick image</q-tooltip>
          </q-btn>
          <q-btn round unelevated size="22px" color="primary" icon="content_paste" @click="pasteImage">
            <q-tooltip>Paste image</q-tooltip>
          </q-btn>
        </div>
      </div>
    </div>

    <!-- ③ Controls (one icon line) + ④ Print -->
    <div class="controls q-px-md q-pb-md q-gutter-y-sm">
      <div class="row no-wrap items-center q-gutter-x-xs icon-line">
        <q-btn-toggle
          v-model="density"
          class="col-auto fat-toggle"
          unelevated
          toggle-color="primary"
          color="grey-3"
          text-color="grey-9"
          :options="[
            { icon: 'light_mode', value: 0 },
            { icon: 'tonality', value: 1 },
            { icon: 'dark_mode', value: 2 },
          ]"
        >
          <q-tooltip>Lighter / Normal / Darker</q-tooltip>
        </q-btn-toggle>
        <q-btn-toggle
          v-model="dither"
          class="col-auto fat-toggle"
          unelevated
          toggle-color="primary"
          color="grey-3"
          text-color="grey-9"
          :options="[
            { icon: 'qr_code_2', value: 'art' },
            { icon: 'photo', value: 'photo' },
          ]"
        >
          <q-tooltip>QR / line art — Photo (dithered)</q-tooltip>
        </q-btn-toggle>
        <q-space />
        <q-btn
          v-if="preview.url"
          flat
          round
          size="18px"
          color="grey-7"
          icon="rotate_right"
          @click="rotateImage"
        >
          <q-tooltip>Rotate 90°</q-tooltip>
        </q-btn>
        <q-btn
          v-if="preview.url"
          flat
          round
          size="18px"
          color="grey-7"
          icon="delete"
          @click="confirmClear"
        >
          <q-tooltip>Clear image</q-tooltip>
        </q-btn>
      </div>
      <q-btn
        class="full-width print-btn"
        no-caps
        unelevated
        size="lg"
        :icon-right="job_printing ? 'sync' : 'print'"
        :label="printLabel"
        :color="canPrint ? 'primary' : 'grey-5'"
        :disable="!canPrint"
        @click="doPrint"
      />
    </div>
  </q-page>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch, nextTick } from 'vue';
import { useRouter } from 'vue-router';
import { useQuasar } from 'quasar';
import { bt as btStore, useBt } from '@/services/bt';
import { useJob } from '@/services/job';

const bt = useBt();
const router = useRouter();
const $q = useQuasar();

function confirmClear(): void {
  $q.dialog({
    title: 'Clear image?',
    message: 'The current image will be removed.',
    ok: { label: 'Clear', color: 'negative', noCaps: true },
    cancel: { label: 'Keep', flat: true, noCaps: true },
  }).onOk(() => clearImage());
}
const appVersion = __APP_VERSION__;
const btState = computed(() => btStore.state);
const btMessage = computed(() => btStore.message);
const btIsError = computed(() => btStore.isError);
const {
  preview,
  density,
  dither,
  printLabel,
  printing: job_printing,
  rotateImage,
  canPrint,
  doPrint,
  clearImage,
  pasteImage,
  pickImage,
  consumeShare,
} = useJob();

// WYSIWYG fit measured from the REAL preview zone (not guessed viewport math).
// Whole image visible at max size: height-limited when tall, else 48mm wide.
const zoneRef = ref<HTMLElement | null>(null);
const zoneBox = ref({ w: 384, h: 480 });
function measureZone(): void {
  const el = zoneRef.value;
  if (!el) return;
  zoneBox.value = { w: el.clientWidth, h: el.clientHeight };
}
const paperStyle = computed(() => {
  const rows = preview.rows || 1;
  const aspect = rows / 384;
  const { w: zoneW, h: zoneH } = zoneBox.value;
  const pad = 18; // paper border + breathing room
  const hLimited = (zoneH - pad) / (zoneW - pad) < aspect;
  return hLimited
    ? { height: `${zoneH - pad}px`, width: 'auto' }
    : { width: `min(100%, 48mm)` };
});

const connectLabel = computed(() => {
  if (btState.value === 'connecting') return 'Connecting…';
  if (btState.value === 'connected') return 'Connected';
  return 'Connect';
});
const connectColor = computed(() =>
  btState.value === 'connected' ? 'positive' : 'grey-5',
);
const msgClass = computed(() => (btIsError.value ? 'text-red' : 'text-grey-8'));

function onConnectTap() {
  if (btState.value === 'connected') {
    void bt.disconnect('Disconnected');
    return;
  }
  if (!btStore.device) {
    void router.push('/settings');
    return;
  }
  void bt.connect();
}

onMounted(() => {
  void consumeShare();
  measureZone();
  window.addEventListener('resize', measureZone);
});
// re-measure when an image arrives (zone size settles after layout)
watch(
  () => preview.url,
  () => nextTick(measureZone),
);
</script>

<style scoped>
.page {
  background: #fafafa;
  /* Android 15 edge-to-edge: keep clear of the status bar / camera cutout */
  padding-top: env(safe-area-inset-top);
}
.banner {
  padding: 6px 8px;
  background: #fff;
  border-bottom: 1px solid #e0e0e0;
  overflow: hidden;
}
.connect-btn {
  min-width: 110px;
  border: 1px solid #e0e0e0;
}
.msg {
  font-size: 13px;
  line-height: 1.2;
  white-space: nowrap;
  overflow: hidden;
  width:150px;
  text-overflow: ellipsis;
  min-width: 0;
  flex: 1 1 0; /* force the flex basis to 0 so it can shrink */
}
.preview-zone {
  min-height: 0;
  overflow-y: auto; /* long strips scroll here, controls stay put */
}
.paper {
  /* paper strip — sized by paperStyle so the WHOLE bitmap fits the zone */
  background: #fff;
  border: 1px dashed #bbb;
  overflow: hidden;
  margin: 0 auto;
}
.preview-img {
  display: block;
  width: 100%;
  height: auto;
}
.print-btn {
  border-radius: 8px;
}
/* fat fingers: 48px touch targets on all icon controls */
:deep(.fat-toggle .q-btn) {
  min-height: 44px;
  min-width: 44px;
  padding: 0 6px;
}
:deep(.fat-toggle .q-btn .q-icon) {
  font-size: 22px;
}
.icon-line {
  width: 100%;
  max-width: 100%;
  flex-wrap: nowrap;
  overflow: hidden;
}
</style>
