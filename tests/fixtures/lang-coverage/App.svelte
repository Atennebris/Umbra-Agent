<script lang="ts">
import { onMount } from 'svelte';
import { writable } from 'svelte/store';

export const title = 'Umbra CLI';
export const host = '127.0.0.1';

const sessions = writable([]);
const status = 'stopped';

async function fetchSessions() {
  const res = await fetch('/api/sessions');
  const data = await res.json();
  sessions.set(data);
}

export function selectSession(id: string) {
  console.log('Selected:', id);
}

export const defaultConfig = {
  host: '127.0.0.1',
  port: 9876,
};

onMount(fetchSessions);
</script>

<main>
  <h1>{title}</h1>
  <p>Status: {status}</p>
</main>

<style>
  main {
    font-family: monospace;
  }
</style>
