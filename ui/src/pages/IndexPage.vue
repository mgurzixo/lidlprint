<template>
  <q-page class="column page">
    <!-- ① Banner -->
    <div class="banner row items-center q-gutter-x-sm">
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
    <div class="col column items-center justify-center q-pa-md preview-zone">
      <template v-if="preview.url">
        <div class="paper relative-position">
          <img :src="preview.url" class="preview-img" alt="print preview" />
        </div>
        <div class="row items-center justify-between full-width q-mt-sm">
          <div class="text-caption text-grey-7">
            prints at 384 × {{ preview.rows }} dots
          </div>
          <q-btn no-caps flat color="grey-7" icon="delete" label="Clear" @click="clearImage" />
        </div>
      </template>
      <div v-else class="text-grey-6 text-center q-pa-xl">
        Share an image to LidlPrint, or use the buttons:
        <div class="q-gutter-sm q-mt-sm">
          <q-btn no-caps unelevated color="primary" label="Pick Image" @click="pickImage" />
          <q-btn no-caps unelevated color="primary" label="Paste image" @click="pasteImage" />
        </div>
      </div>
    </div>

    <!-- ③ Controls + ④ Print -->
    <div class="controls q-px-md q-pb-md q-gutter-y-sm">
      <q-btn-toggle
        v-model="dither"
        class="full-width"
        no-caps
        unelevated
        toggle-color="primary"
        color="grey-3"
        text-color="grey-9"
        :options="[
          { label: 'Art (crisp)', value: 'art' },
          { label: 'Photo (dithered)', value: 'photo' },
        ]"
      />
      <q-btn
        class="full-width print-btn"
        no-caps
        unelevated
        size="lg"
        :label="printLabel"
        :color="canPrint ? 'primary' : 'grey-5'"
        :disable="!canPrint"
        @click="doPrint"
      />
    </div>
  </q-page>
</template>

<script setup lang="ts">
import { computed, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { bt as btStore, useBt } from '@/services/bt';
import { useJob } from '@/services/job';

const bt = useBt();
const router = useRouter();
const appVersion = __APP_VERSION__;
const btState = computed(() => btStore.state);
const btMessage = computed(() => btStore.message);
const btIsError = computed(() => btStore.isError);
const {
  preview,
  density,
  dither,
  printLabel,
  canPrint,
  doPrint,
  clearImage,
  pasteImage,
  pickImage,
  consumeShare,
} = useJob();

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

onMounted(() => void consumeShare());
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
  text-overflow: ellipsis;
}
.preview-zone {
  min-height: 0;
}
.paper {
  background: #fff;
  border: 1px dashed #bbb;
  max-height: 100%;
  overflow: hidden;
}
.preview-img {
  display: block;
  max-width: 100%;
  max-height: 50vh;
}
.print-btn {
  border-radius: 8px;
}
</style>
