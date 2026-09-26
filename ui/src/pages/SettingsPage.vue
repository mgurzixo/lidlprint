<template>
  <q-page class="column settings-page">
    <div class="text-h6 q-pa-md">Printer</div>
    <div class="text-body2 text-grey-7 q-px-md">
      The printer must be paired first (it shows as “Mini Pocket Printer”).
      Tap the button below to open Android Bluetooth settings, pair it there,
      then come back and pick it from the list.
    </div>
    <div class="q-px-md q-pt-sm">
      <q-btn
        no-caps
        unelevated
        color="primary"
        icon="bluetooth"
        label="Open Bluetooth settings"
        @click="() => openBtSettings()"
      />
    </div>

    <q-list class="q-mt-md">
      <q-item
        v-for="d in devices"
        :key="d.address"
        clickable
        v-ripple
        @click="choose(d)"
      >
        <q-item-section>
          <q-item-label>{{ d.name }}</q-item-label>
          <q-item-label caption>{{ d.address }}</q-item-label>
        </q-item-section>
        <q-item-section side v-if="saved?.address === d.address">
          <q-icon name="check_circle" color="positive" />
        </q-item-section>
      </q-item>
    </q-list>

    <div v-if="devices.length === 0 && !loading" class="text-grey-6 text-center q-pa-lg">
      {{ error || 'No bonded Bluetooth devices found.' }}
      <div>
        <q-btn flat no-caps color="primary" label="Retry" @click="refresh" />
      </div>
    </div>

    <q-inner-loading :showing="loading" />

    <div class="q-pa-md q-mt-auto">
      <q-btn
        flat no-caps color="primary"
        label="← Back"
        @click="router.back()"
      />
    </div>
  </q-page>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { useBt, type BondedDevice } from '@/services/bt';

const router = useRouter();
const bt = useBt();
const devices = ref<BondedDevice[]>([]);
const saved = ref<BondedDevice | null>(bt.device);
const loading = ref(false);
const error = ref('');

async function refresh() {
  loading.value = true;
  error.value = '';
  try {
    devices.value = await bt.listBonded();
    if (devices.value.length === 0) {
      error.value = 'Bluetooth adapter returned no devices. Is Bluetooth on?';
    }
  } catch (e) {
    error.value = String(e);
    bt.say(`Bluetooth: ${String(e)}`, true);
  } finally {
    loading.value = false;
  }
}

async function openBtSettings() {
  await bt.openPairingSettings();
}

function choose(d: BondedDevice) {
  bt.selectPrinter(d);
  saved.value = d;
  // auto-connect right after picking (one mental model: banner owns connection)
  void bt.connect().then(() => router.back());
}

onMounted(() => void refresh());
</script>

<style scoped>
.settings-page {
  background: #fafafa;
}
</style>
