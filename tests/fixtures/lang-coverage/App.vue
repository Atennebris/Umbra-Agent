<template>
  <div class="app">
    <header>
      <h1>{{ title }}</h1>
    </header>
    <main>
      <DaemonStatus :status="status" />
      <SessionList :sessions="sessions" @select="selectSession" />
    </main>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import DaemonStatus from './DaemonStatus.vue'
import SessionList from './SessionList.vue'

interface Session {
  id: string
  title: string
  startedAt: Date
}

const title = ref('Umbra CLI')
const status = ref<'running' | 'stopped'>('stopped')
const sessions = ref<Session[]>([])

const activeSessions = computed(() =>
  sessions.value.filter(s => s.startedAt > new Date(Date.now() - 3600_000))
)

async function fetchSessions() {
  const res = await fetch('/api/sessions')
  sessions.value = await res.json()
}

function selectSession(id: string) {
  console.log('Selected session:', id)
}

onMounted(fetchSessions)
</script>

<style scoped>
.app {
  font-family: monospace;
  padding: 1rem;
}
</style>
